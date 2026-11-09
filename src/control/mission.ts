/**
 * CLUE mission registry.
 *
 * Architecture: CLUE_Architecture_v8.md (mission versions bind the rules a run was produced under).
 * Constitution: CLUE_Constitution_v8.md (constitution hash is the binding identity).
 * Backlog: DEV-P0-07 — recoverable registration with a final commit; a basis over all governed inputs.
 *          DEV-P1-28 (phase 1) — the mission basis is the root of the evidence spine: `spineLink`
 *          and `spineSeal` expose it, and `verifyMissionLink` checks a presented root against the
 *          mission in force. Later stages (snapshot, recognition, …) bind to `spineSeal`.
 *
 * The mission is what CLUE is currently trying to do, expressed as an exact set of
 * hashes over its governed inputs. It exists so that every finding, contract, verdict,
 * and landing can name the version of the rules it was produced under — and so that
 * changing those rules is an event with a record, not an edit nobody noticed.
 *
 * The mission basis binds, and a change to any of them creates a new version: the
 * constitution and the other tracked documents, the derived amendments (by full content,
 * not just their codes), the configuration and policy files, the measurement catalogue,
 * coordinate map, and record-schema authority (each by content hash, not a version label),
 * and the toolchain and recognizer versions. Registration is a two-step, recoverable
 * sequence: the document blobs are stored first, stamped with a mission that is already
 * committed, and only then does a single `mission.registered` event commit the new
 * version. No event ever references a version that has not been committed.
 *
 * Two severities of change, both producing a new version:
 *
 *   constitutional  CLUE.md changed, or the set/content of active amendments changed.
 *                   The boundaries themselves moved. Frozen proof contracts issued
 *                   under the previous version must not be landed against this one.
 *   architectural   A supporting input changed. Method moved, boundaries did not.
 *
 * Amendments are DERIVED FROM CONFIGURATION, never parsed from prose. Amendment A2
 * exists exactly when `security.canonical_source_writes` is `custodian_only`. Setting
 * that key back to `denied` withdraws the amendment and creates a new constitutional
 * version automatically. The record therefore cannot drift from the authority that is
 * actually in force, which is the failure a prose-declared amendment invites.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

import {
  canonicalJson,
  hashBytes,
  hashCanonicalJson,
  makeEntityId,
  nowIso,
  requireSha256,
  type Sha256,
} from '../shared/ids.js';
import {
  CONFIG_SCHEMA_VERSION,
  absolutePathForm,
  missionVersionSchema,
  epochSealSchema,
  packRatificationSchema,
  parseOrThrow,
  type Amendment,
  type ClueConfig,
  type EpochSeal,
  type MissionVersion,
  type PackRatification,
  type TrackedDocument,
} from '../shared/schemas.js';
import { RECOGNIZER_VERSION } from '../analysis/source/recognizer.js';
import type { ArtifactStore } from '../memory/artifactStore.js';
import type { EventLog } from '../memory/eventLog.js';
import { KERNEL_EVENT_TYPES, type ProjectionStore } from '../memory/db.js';
import {
  resolveDocumentationPack,
  type ResolvedDocumentationPack,
} from './documentationPack.js';
import type { ResolvedProjectRuntimeBinding } from './projectProfiles/projectRuntimeBinding.js';
import {
  requireCurrentProjectAuthority,
  type ActiveAuthorityDocument,
} from './projectProfiles/projectAuthority.js';
import { resolveProjectBenchmarkRuntime } from './projectProfiles/benchmarkRuntime.js';
import { projectGovernanceBasisFromBinding } from './projectProfiles/projectGovernanceBasis.js';
import {
  projectGovernanceBasisHash as hashProjectGovernanceBasis,
  projectGovernanceBasisSchema,
  type ProjectGovernanceBasis,
} from '../shared/projectGovernanceBasis.js';

import {
  EvidenceChainError,
  asSpineHash,
  sealLink,
  type BindingHash,
  type MissionLink,
} from '../shared/evidenceIdentity.js';

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

export type MissionChangeKind = 'initial' | 'constitutional' | 'architectural' | 'unchanged';

export interface BootstrapResult {
  readonly mission: MissionVersion;
  readonly change: MissionChangeKind;
  /** Tracked documents whose content differs from the previous version. */
  readonly changedDocuments: readonly string[];
  /** Amendment codes added or withdrawn relative to the previous version. */
  readonly amendmentDelta: readonly string[];
}

export interface MissionRegistryDeps {
  /** Absolute path of the CLU repository root, where tracked documents live. */
  readonly repoRoot: string;
  readonly config: ClueConfig;
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  /** Exact durable Project Profile generation; absent only for the legacy v2 runtime. */
  readonly projectBinding?: ResolvedProjectRuntimeBinding;
  /**
   * Versions of the code that governs measurement. Bound into the mission basis so a change
   * to any of them registers a new version. Optional so a caller that has not yet wired the
   * real versions still gets a stable basis; the runtime supplies the running values.
   */
  readonly toolchain?: MissionToolchain;
}

/** Governing code versions bound into the mission basis. */
export interface MissionToolchain {
  readonly schemaVersion: string;
  readonly recognizerVersion: string;
  readonly catalogueVersion: string;
}

/** The full set of inputs a mission version is bound to, and the single hash over them. */
interface ProjectGovernancePayload {
  readonly basis: ProjectGovernanceBasis;
  readonly authorityManifest: ReturnType<typeof requireCurrentProjectAuthority>;
  readonly benchmarkRuntime: ReturnType<typeof resolveProjectBenchmarkRuntime>;
}

export interface MissionBasis {
  readonly constitutionHash: Sha256;
  readonly documents: readonly TrackedDocument[];
  readonly amendmentsContentHash: Sha256;
  readonly configSchemaVersion: number;
  readonly toolchain: MissionToolchain;
  readonly projectGovernanceBasisHash: Sha256 | null;
  readonly basisHash: Sha256;
}

/** Conventional location of the configuration file, mirroring `loadConfig` in runtime.ts. */
const CONFIG_FILE_PATH = 'config/clue.config.yaml';

/**
 * The measurement and record-schema authorities bound into the mission basis by CONTENT HASH
 * (DEV-P0-07). The catalogue defines WHAT is measured; the coordinate map, HOW each measure places on
 * the field — embedded in the module, so the `.ts` is the authority while the exported `.json` is
 * derived; and schemas.ts, the SHAPE of every record CLUE persists. All three govern behaviour, so
 * editing any is a governed change that must register a successor mission. A version string such as
 * `clue-catalogue/6` cannot bind the bytes in force — these paths can, which is the gap this closes.
 */
const MEASUREMENT_CATALOGUE_PATH = 'config/measurements/catalogue.yaml';
const MEASUREMENT_COORDINATE_PATH = 'src/shared/measurementCoordinates.ts';
const RECORD_SCHEMA_AUTHORITY_PATH = 'src/shared/schemas.ts';

/** Synthetic bound-input path recording the toolchain versions (not a file on disk). */
const TOOLCHAIN_BASIS_PATH = 'clue-basis://toolchain';
const PROJECT_GOVERNANCE_BASIS_PATH = 'clue-basis://project-governance';

/** Defaults for governing versions when the caller does not supply the running values. The recognizer
 * version is imported from the recognizer itself (DEV-P0-07), not duplicated — a hardcoded string here
 * silently claimed clue-recognizer/2 while the recognizer ran /3, binding missions to a version that
 * was never executed. */
const DEFAULT_TOOLCHAIN: MissionToolchain = {
  schemaVersion: `config/${CONFIG_SCHEMA_VERSION}`,
  recognizerVersion: RECOGNIZER_VERSION,
  catalogueVersion: 'clue-catalogue/6',
};

/* ------------------------------------------------------------------------- */
/* Amendment derivation                                                       */
/* ------------------------------------------------------------------------- */

/**
 * The amendments in force for a given installation.
 *
 * A1 (OpenAI-only worker supply) is deliberately absent: the founding documents are
 * vendor-neutral, so choosing a provider changes no boundary and is installation
 * policy rather than an amendment. A2 is present, because it moves an absolute one.
 */
export function deriveAmendments(config: ClueConfig, recordedAt: string): Amendment[] {
  const amendments: Amendment[] = [];

  if (config.security.canonical_source_writes === 'custodian_only') {
    amendments.push({
      code: 'A2',
      directive:
        'CLUE may apply proven patches to the canonical tree through the Custodian, ' +
        'under landing gates G1-G10, using Git operations only, with an armed reverse patch.',
      affects: [
        'CLUE.md §2.1 canonical source read-only',
        'CLUE_implementation.md §2.1 absolute boundaries',
        'CLUE_implementation.md §20.2 patch state machine',
      ],
      recorded_at: recordedAt,
    });
  }

  return amendments;
}

/* ------------------------------------------------------------------------- */
/* Mission registry                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Raised when the governed inputs on disk no longer match the mission in force (DEV-P0-07). It names
 * the mission that drifted and the kind of change, so a caller can require a successor be registered
 * before any further evidence is produced.
 */
/* ------------------------------------------------------------------------- */
/* Installed-authority ratification (DEV-P2-01 / DEV-P2-05, Gate 7)           */
/* ------------------------------------------------------------------------- */

/**
 * Event type for the Creator's ratification act. Domain-owned per `db.ts`'s registry note
 * ("later stages register their own without touching this file"); the mission service owns it
 * because ratification is authority registered before authoritative work (Directory §8).
 */
export const AUTHORITY_EVENT_TYPES = {
  packRatified: 'authority.pack_ratified',
  epochSealed: 'authority.epoch_sealed',
} as const;

/** Legacy defaults retained for fixtures and installations predating the explicit selector. */
export const PACK_SEAL_FILE = 'SHA256SUMS_v9.txt';
export const PACK_MANIFEST_FILE = 'DOCUMENTATION_MANIFEST_v9.json';

/** A ratification as read back from the log: the payload plus its event envelope identity. */
export interface RatificationRecord extends PackRatification {
  readonly event_id: string;
  readonly sequence: number;
}

/** An epoch seal as read back from the log: the payload plus its event envelope identity. */
export interface EpochRecord extends EpochSeal {
  readonly event_id: string;
  readonly sequence: number;
}

/**
 * Parses a pack seal — `<64 hex><two spaces><path>` per line — into declared path → hash.
 *
 * Pure and exported deliberately: the installer (`tools/install-v9-pack.mjs`) and `doctor`
 * each grew their own copy of this grammar, and DEV-P1-41's lesson is that two parsers of one
 * grammar diverge. This is the consolidation point; `doctor` imports it when its
 * installed-authority block is upgraded to consume the ratification record.
 */
export function parsePackSeal(
  text: string,
): { readonly declared: Map<string, string> } | { readonly error: string } {
  const declared = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return { error: `unparseable seal line: ${JSON.stringify(line.slice(0, 60))}` };
    }
    if (declared.has(match[2])) return { error: `duplicate declared path: ${match[2]}` };
    declared.set(match[2], match[1]);
  }
  if (declared.size === 0) return { error: 'the seal declares no files' };
  return { declared };
}

export class MissionDriftError extends Error {
  public constructor(
    public readonly missionId: string,
    public readonly change: MissionChangeKind,
    detail: string,
  ) {
    super(`Governed inputs have drifted from mission ${missionId} (${change}): ${detail}. Register a successor before producing evidence.`);
    this.name = 'MissionDriftError';
  }
}

export class MissionRegistry {
  private readonly repoRoot: string;
  private readonly config: ClueConfig;
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly artifacts: ArtifactStore;
  private readonly projectBinding: ResolvedProjectRuntimeBinding | null;
  private readonly toolchain: MissionToolchain;

  public constructor(deps: MissionRegistryDeps) {
    this.repoRoot = deps.repoRoot;
    this.config = deps.config;
    this.log = deps.log;
    this.projections = deps.projections;
    this.artifacts = deps.artifacts;
    this.projectBinding = deps.projectBinding ?? null;
    this.toolchain = deps.toolchain ?? DEFAULT_TOOLCHAIN;
  }

  /**
   * Reads the governed inputs from disk and registers a new mission version if the basis has
   * moved.
   *
   * Idempotent: running it twice against an unchanged installation registers nothing and
   * reports `unchanged`, so the daemon may call it on every start. Recoverable: a previous
   * attempt that stored document blobs but did not reach the commit leaves no mission row, so
   * this simply stores them again (content-addressed, so a no-op) and commits.
   */
  public bootstrap(): BootstrapResult {
    // Heal a split head first: a prior attempt that committed a version but crashed before
    // superseding its predecessor could leave two current rows. Point every stale one at the
    // successor so the state machine has a single head before anything is compared.
    this.healSupersededChain();

    const timestamp = nowIso();
    const documents = this.readBoundDocuments();
    const constitutionHash = this.constitutionHashOf(documents);
    const amendments = deriveAmendments(this.config, timestamp);
    const amendmentsHash = amendmentsContentHash(amendments);

    const previous = this.current();
    const change = classifyChange(previous, documents, constitutionHash, amendmentsHash);

    if (previous !== null && change === 'unchanged') {
      return { mission: previous, change, changedDocuments: [], amendmentDelta: [] };
    }

    const version = previous === null ? 1 : previous.version + 1;
    const missionId = makeEntityId('mission', version);

    const mission = parseOrThrow(
      missionVersionSchema,
      {
        id: missionId,
        version,
        created_at: timestamp,
        constitution_hash: constitutionHash,
        documents,
        amendments,
        superseded_by: null,
      },
      `mission version ${version}`,
    );

    // Store the exact input bytes before the version is committed, and stamp those artifact
    // events with a mission that is ALREADY committed — the predecessor, or the bootstrap
    // sentinel for the first version. Nothing references the new id until it is committed, so
    // a crash here leaves no event pointing at an uncommitted version.
    const committedStamp = previous?.id ?? BOOTSTRAP_MISSION_ID;
    this.storeDocumentContents(documents, committedStamp);

    // The single commit. Until this event is projected there is no mission_versions row for
    // the new id, so `current`, `get`, and every consumer treat the version as not yet in force.
    this.log.append({
      type: KERNEL_EVENT_TYPES.missionRegistered,
      actor: 'daemon',
      missionVersion: missionId,
      subjectId: missionId,
      payload: mission,
    });

    if (previous !== null) {
      this.log.append({
        type: KERNEL_EVENT_TYPES.missionSuperseded,
        actor: 'daemon',
        missionVersion: missionId,
        subjectId: previous.id,
        payload: { superseded_id: previous.id, successor_id: missionId },
      });
    }

    this.projections.sync(this.log);

    return {
      mission,
      change,
      changedDocuments: diffDocuments(previous?.documents ?? [], documents),
      amendmentDelta: diffAmendments(previous?.amendments ?? [], amendments),
    };
  }

  /* ------------------------------ queries ----------------------------- */

  /** The mission version currently in force, or null before first bootstrap. */
  public current(): MissionVersion | null {
    const row = this.projections.db
      .prepare(
        `SELECT id, version, created_at, constitution_hash, documents_json,
                amendments_json, superseded_by
           FROM mission_versions
          WHERE superseded_by IS NULL
          ORDER BY version DESC
          LIMIT 1`,
      )
      .get();
    return row === undefined ? null : readMissionRow(row);
  }

  /** Identifier to stamp on events. Falls back to the bootstrap sentinel. */
  public currentId(): string {
    return this.current()?.id ?? BOOTSTRAP_MISSION_ID;
  }

  /** Whether a committed mission is in force. */
  public isRegistered(): boolean {
    return this.current() !== null;
  }

  /**
   * The latest ratification of the installed authority, or null if none has been performed.
   *
   * Read by replaying the log rather than through a projection — a deliberate exception to the
   * usual read path. Ratifications are rare (one per pack state, a handful over the system's
   * life), the scan is O(history) over small JSONL records, and a projection would cost a table,
   * a projector, and a registration for a record read a few times per doctor run. If cardinality
   * ever grows, promote it; the event is the truth either way.
   *
   * A record of this type whose payload does not satisfy `packRatificationSchema` is corruption
   * of a governance record and throws loudly — the chain hash already proved the bytes are what
   * was written, so a bad shape means the writer was wrong, and continuing past it would let a
   * malformed act stand as authority.
   */
  public ratification(): RatificationRecord | null {
    return this.readLatestRatification()?.record ?? null;
  }

  private readLatestRatification(): {
    readonly record: RatificationRecord;
    readonly missionVersion: string | null;
  } | null {
    let latest: { readonly record: RatificationRecord; readonly missionVersion: string | null } | null = null;
    for (const record of this.log.replay()) {
      if (record.type !== AUTHORITY_EVENT_TYPES.packRatified) continue;
      const parsed = packRatificationSchema.safeParse(record.payload);
      if (!parsed.success) {
        throw new Error(
          `event ${record.id} carries type ${AUTHORITY_EVENT_TYPES.packRatified} with a payload ` +
            `that does not satisfy packRatificationSchema — a governance record is corrupt`,
        );
      }
      latest = {
        record: { ...parsed.data, event_id: record.id, sequence: record.sequence },
        missionVersion: record.mission_version,
      };
    }
    return latest;
  }

  /**
   * Performs the Creator's ratification of the installed documentation pack (DEV-P2-01).
   *
   * The act binds the pack state at this exact moment, so the whole pack must verify first:
   * every file the seal declares must exist and hash to its declared value. Ratifying a
   * drifted pack is refused — the Creator would be signing a statement the disk contradicts.
   * The same seal state cannot be ratified twice in the current mission. A successor mission
   * needs its own Creator act even when only an external governed input changed and the
   * installed documentation pack kept the same seal.
   *
   * The caller supplies only the confirmation statement; everything bound is read from disk
   * and from the configuration. The CLI owns making the act deliberate (interactive
   * confirmation, Creator-only framing); this service owns making it true.
   */
  public ratifyInstalledAuthority(input: { readonly statement: string }): RatificationRecord {
    const mission = this.current();
    if (mission === null) {
      throw new Error('No mission registered — run `clue init` before ratifying.');
    }
    const statement = input.statement.trim();
    if (statement === '') {
      throw new Error('Ratification requires the confirmation statement that was typed.');
    }

    const { pack, sealSha, declared } = this.verifyPackAgainstSeal('ratify');

    const manifestHash = declared.get(pack.manifestFile);
    if (manifestHash === undefined) {
      throw new Error(`${pack.sealFile} does not declare ${pack.manifestFile}.`);
    }
    const constitutionPath = this.config.constitution.file;
    const constitutionHash = declared.get(constitutionPath);
    if (constitutionHash === undefined) {
      throw new Error(
        `The registered constitution (${constitutionPath}) is not declared by ${pack.sealFile} — ` +
          'the configuration registers authority the installation does not govern.',
      );
    }

    const existing = this.readLatestRatification();
    if (
      existing !== null &&
      existing.missionVersion === mission.id &&
      existing.record.seal_sha256 === sealSha &&
      existing.record.seal_path === pack.sealFile &&
      existing.record.manifest_path === pack.manifestFile
    ) {
      throw new Error(
        `This pack state is already ratified (event ${existing.record.event_id}, ${existing.record.ratified_at}).`,
      );
    }

    const payload = parseOrThrow(
      packRatificationSchema,
      {
        pack_release: pack.releaseName,
        release_version: pack.releaseVersion,
        seal_path: pack.sealFile,
        seal_sha256: sealSha,
        manifest_path: pack.manifestFile,
        manifest_sha256: manifestHash,
        constitution_path: constitutionPath,
        constitution_sha256: constitutionHash,
        declared_file_count: declared.size,
        ratified_by: 'creator',
        statement,
        ratified_at: nowIso(),
      },
      'pack ratification',
    );

    const event = this.log.append({
      type: AUTHORITY_EVENT_TYPES.packRatified,
      actor: 'creator',
      missionVersion: mission.id,
      subjectId: mission.id,
      payload,
    });
    this.projections.sync(this.log);

    return { ...payload, event_id: event.id, sequence: event.sequence };
  }

  /**
   * Verifies the installed pack against its seal and returns the seal identity.
   *
   * Shared by ratification and the epoch seal: both acts sign a statement about the pack,
   * and neither may sign one the disk contradicts. `act` names the refusal so the operator
   * knows which act was refused.
   */
  private verifyPackAgainstSeal(act: string): {
    readonly pack: ResolvedDocumentationPack;
    readonly sealSha: string;
    readonly declared: Map<string, string>;
  } {
    const pack = resolveDocumentationPack(this.repoRoot);
    const sealPath = join(this.repoRoot, ...pack.sealFile.split('/'));
    if (!existsSync(sealPath)) {
      throw new Error(`${pack.sealFile} absent at the repository root — ${pack.installHint} first.`);
    }
    const sealBytes = readFileSync(sealPath);
    const parsedSeal = parsePackSeal(sealBytes.toString('utf8'));
    if ('error' in parsedSeal) {
      throw new Error(`${pack.sealFile}: ${parsedSeal.error}`);
    }
    const { declared } = parsedSeal;

    const drifted: string[] = [];
    for (const [relativePath, expected] of declared) {
      const absolute = join(this.repoRoot, ...relativePath.split('/'));
      if (!existsSync(absolute)) {
        drifted.push(`${relativePath} (absent)`);
        continue;
      }
      if (hashBytes(readFileSync(absolute)) !== expected) drifted.push(relativePath);
    }
    if (drifted.length > 0) {
      throw new Error(
        `Refusing to ${act}: ${drifted.length}/${declared.size} pack files disagree with ` +
          `${pack.sealFile} (${drifted.slice(0, 3).join(', ')}${drifted.length > 3 ? ', …' : ''}).`,
      );
    }
    return { pack, sealSha: hashBytes(sealBytes), declared };
  }

  /** One replay scan: the latest epoch per name, and the latest overall. */
  private scanEpochs(): { byName: Map<string, EpochRecord>; latest: EpochRecord | null } {
    const byName = new Map<string, EpochRecord>();
    let latest: EpochRecord | null = null;
    for (const record of this.log.replay()) {
      if (record.type !== AUTHORITY_EVENT_TYPES.epochSealed) continue;
      const parsed = epochSealSchema.safeParse(record.payload);
      if (!parsed.success) {
        throw new Error(
          `event ${record.id} carries type ${AUTHORITY_EVENT_TYPES.epochSealed} with a payload ` +
            `that does not satisfy epochSealSchema — a governance record is corrupt`,
        );
      }
      const epoch: EpochRecord = { ...parsed.data, event_id: record.id, sequence: record.sequence };
      byName.set(epoch.epoch_name, epoch);
      latest = epoch;
    }
    return { byName, latest };
  }

  /** The latest seal for a named epoch, or null. */
  public epoch(name: string): EpochRecord | null {
    return this.scanEpochs().byName.get(name) ?? null;
  }

  /** The latest epoch seal of any name, or null — the boundary doctor reports. */
  public latestEpoch(): EpochRecord | null {
    return this.scanEpochs().latest;
  }

  /**
   * Seals an evidence epoch (ADR-0006, accepted 2026-08-10).
   *
   * The act declares: everything at or before this verified head is legacy; everything
   * after was produced under the ratified authority. So the guards are exactly the claims:
   * a mission must be in force, a ratification must exist *and be current* — an epoch over
   * an unratified or moved-on pack would sign "under the ratified authority" while the disk
   * disagrees — the whole chain must verify before the head is bound, the blob manifest
   * must verify before it is pinned, and a name seals once. Nothing is deleted or rotated;
   * the boundary is a fact about history, recorded into it.
   */
  public sealEpoch(input: { readonly epochName: string; readonly statement: string }): EpochRecord {
    const mission = this.current();
    if (mission === null) {
      throw new Error('No mission registered — run `clue init` before sealing an epoch.');
    }
    const epochName = input.epochName.trim();
    if (epochName === '') {
      throw new Error('An epoch needs a name.');
    }
    const statement = input.statement.trim();
    if (statement === '') {
      throw new Error('Sealing requires the confirmation statement that was typed.');
    }

    const ratification = this.readLatestRatification();
    if (ratification === null) {
      throw new Error(
        'No ratification is in force — the Creator ratifies with `clue docs ratify` before an ' +
          'epoch can be sealed.',
      );
    }
    if (ratification.missionVersion !== mission.id) {
      throw new Error(
        `Ratification ${ratification.record.event_id} does not cover current mission ${mission.id}. ` +
          'Run `clue docs ratify` before sealing its epoch.',
      );
    }
    const ratified = ratification.record;
    const { pack, sealSha } = this.verifyPackAgainstSeal('seal the epoch');
    if (
      ratified.seal_sha256 !== sealSha ||
      ratified.seal_path !== pack.sealFile ||
      ratified.manifest_path !== pack.manifestFile
    ) {
      throw new Error(
        `The ratification (${ratified.event_id}) covers seal ${ratified.seal_sha256.slice(0, 12)}…, ` +
          `but the live seal is ${sealSha.slice(0, 12)}… — the pack has moved on; re-ratify with ` +
          '`clue docs ratify` before sealing.',
      );
    }

    const existing = this.epoch(epochName);
    if (existing !== null) {
      throw new Error(
        `Epoch ${epochName} is already sealed (event ${existing.event_id}, ${existing.sealed_at}).`,
      );
    }

    const verified = this.log.verify();
    if (verified.head === null) {
      throw new Error('An empty log cannot host an epoch boundary.');
    }

    const entries = this.artifacts.manifest();
    const canonical = JSON.stringify(entries);
    const payload = parseOrThrow(
      epochSealSchema,
      {
        epoch_name: epochName,
        legacy_head_sequence: verified.head.sequence,
        legacy_head_hash: verified.head.hash,
        blob_manifest_sha256: hashBytes(Buffer.from(canonical, 'utf8')),
        blob_count: entries.length,
        ratification_event_id: ratified.event_id,
        ratified_seal_sha256: ratified.seal_sha256,
        sealed_by: 'creator',
        statement,
        sealed_at: nowIso(),
      },
      'epoch seal',
    );

    const event = this.log.append({
      type: AUTHORITY_EVENT_TYPES.epochSealed,
      actor: 'creator',
      missionVersion: mission.id,
      subjectId: mission.id,
      payload,
    });
    this.projections.sync(this.log);

    return { ...payload, event_id: event.id, sequence: event.sequence };
  }

  /**
   * The committed mission in force, or an error if none is registered.
   *
   * Analysis and orchestration must not run before a mission is committed: work produced
   * against no rules cannot be attributed to any version. Only bootstrap may proceed without
   * one. Callers that gate non-bootstrap commands use this so a failed registration stops the
   * run rather than silently producing unattributable evidence.
   */
  public requireCurrent(): MissionVersion {
    const mission = this.current();
    if (mission === null) {
      throw new Error('No mission is registered; bootstrap must succeed before analysis can run.');
    }
    return mission;
  }

  /**
   * Requires a current mission AND that the governed inputs on disk still match the one it committed
   * to (DEV-P0-07). `requireCurrent` proves a mission exists; this proves it is still the mission in
   * force — re-reading the tracked documents, constitution, and amendments and refusing if any has
   * drifted from the committed basis. A writable runtime uses this so evidence is never produced under
   * a mission whose founding inputs have silently changed; the fix for drift is to register a
   * successor (bootstrap) before proceeding.
   */
  public requireCurrentBasis(): MissionVersion {
    const mission = this.requireCurrent();
    const documents = this.readBoundDocuments();
    const constitutionHash = this.constitutionHashOf(documents);
    const amendmentsHash = amendmentsContentHash(deriveAmendments(this.config, nowIso()));
    const change = classifyChange(mission, documents, constitutionHash, amendmentsHash);
    if (change !== 'unchanged') {
      const detail =
        change === 'constitutional'
          ? 'the constitution or the amendments in force changed'
          : `tracked documents changed: ${diffDocuments(mission.documents, documents).join(', ')}`;
      throw new MissionDriftError(mission.id, change, detail);
    }
    return mission;
  }

  /** The full basis the current (or prospective) mission binds, and the single hash over it. */
  public basis(): MissionBasis {
    const projectGovernance =
      this.projectBinding === null ? null : this.projectGovernancePayload();
    const documents = this.readBoundDocuments(projectGovernance);
    const constitutionHash = this.constitutionHashOf(documents);
    const amendmentsHash = amendmentsContentHash(deriveAmendments(this.config, nowIso()));
    const projectGovernanceBasisHash =
      projectGovernance === null ? null : hashProjectGovernanceBasis(projectGovernance.basis);
    return {
      constitutionHash,
      documents,
      amendmentsContentHash: amendmentsHash,
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      toolchain: this.toolchain,
      projectGovernanceBasisHash,
      basisHash: hashCanonicalJson({
        constitution: constitutionHash,
        documents: documents.map((document) => ({ path: document.path, hash: document.hash })),
        amendments: amendmentsHash,
        config_schema: CONFIG_SCHEMA_VERSION,
        toolchain: this.toolchain,
        project_governance_basis: projectGovernanceBasisHash,
      }),
    };
  }

  /**
   * The mission link at the root of the evidence spine (DEV-P1-28).
   *
   * Derived from the current basis, so it needs nothing persisted beyond the governed inputs the
   * mission already binds by content hash: change any of them and the basis hash — and therefore this
   * link and its seal — change. The basis hash is timestamp-independent, so the link is deterministic.
   */
  public spineLink(): MissionLink {
    return {
      stage: 'mission',
      boundTo: null,
      missionBasisHash: asSpineHash(this.basis().basisHash, 'MissionBasisHash'),
    };
  }

  /** The sealed binding hash of the mission root — the value the next spine stage binds to. */
  public spineSeal(): BindingHash {
    return sealLink(this.spineLink());
  }

  /**
   * Verifies a presented mission link against the mission actually in force (DEV-P1-28).
   *
   * Registry-aware verification: a chain reconstructed from a stored packet is only trustworthy if its
   * root still matches this registry's current basis. A link whose basis hash differs was produced
   * under a different mission and must not be accepted. This is the root-stage form of the check every
   * spine registry performs against its own authority.
   */
  public verifyMissionLink(link: MissionLink): void {
    const expected = this.spineLink().missionBasisHash;
    if (link.missionBasisHash !== expected) {
      throw new EvidenceChainError(
        `mission link basis ${link.missionBasisHash} does not match the mission in force ${expected}`,
      );
    }
  }

  /** Every mission version, oldest first. */
  public history(): MissionVersion[] {
    const rows = this.projections.db
      .prepare(
        `SELECT id, version, created_at, constitution_hash, documents_json,
                amendments_json, superseded_by
           FROM mission_versions
          ORDER BY version ASC`,
      )
      .all();
    return rows.map(readMissionRow);
  }

  public get(missionId: string): MissionVersion | null {
    const row = this.projections.db
      .prepare(
        `SELECT id, version, created_at, constitution_hash, documents_json,
                amendments_json, superseded_by
           FROM mission_versions
          WHERE id = ?`,
      )
      .get(missionId);
    return row === undefined ? null : readMissionRow(row);
  }

  /**
   * Whether a mission version is still the one in force.
   *
   * Landing gate G10 depends on this: a proof contract frozen under one set of rules
   * must not be cashed in under another.
   */
  public isCurrent(missionId: string): boolean {
    return this.current()?.id === missionId;
  }

  /** Whether the boundaries have moved since `missionId`, as opposed to the method. */
  public constitutionChangedSince(missionId: string): boolean {
    const past = this.get(missionId);
    const now = this.current();
    if (past === null || now === null) return true;
    return (
      past.constitution_hash !== now.constitution_hash ||
      amendmentsContentHash(past.amendments) !== amendmentsContentHash(now.amendments)
    );
  }

  /** Retrieves the exact text of a tracked document as it was at a mission version. */
  public documentText(missionId: string, documentPath: string): string {
    const mission = this.get(missionId);
    if (mission === null) throw new Error(`Unknown mission version ${missionId}`);

    const document = mission.documents.find((entry) => entry.path === documentPath);
    if (document === undefined) {
      throw new Error(`Mission ${missionId} does not track document ${documentPath}`);
    }
    return this.artifacts.getText(requireSha256(document.hash, 'document hash'));
  }

  /* ----------------------------- internals ---------------------------- */

  /**
   * Every input the mission binds: the tracked documents, the configuration and policy files,
   * and a synthetic record of the toolchain versions. A change to any of them is a changed
   * basis and therefore a new version.
   */
  private readBoundDocuments(
    projectGovernance: ProjectGovernancePayload | null =
      this.projectBinding === null ? null : this.projectGovernancePayload(),
  ): TrackedDocument[] {
    const documents = this.readTrackedDocuments();
    documents.push(...this.readGovernedFiles());
    if (this.projectBinding === null) {
      documents.push(...this.readTargetInputs());
    } else {
      if (projectGovernance === null) {
        throw new Error('Project Profile runtime has no Project Governance payload.');
      }
      documents.push(...this.readProjectAuthorityInputs(projectGovernance));
      documents.push(this.projectGovernanceBasisDocument(projectGovernance));
    }
    documents.push(this.toolchainBasisDocument());
    const unique = new Map<string, TrackedDocument>();
    for (const document of documents) {
      const previous = unique.get(document.path);
      if (previous !== undefined && previous.hash !== document.hash) {
        throw new Error(`Mission input ${document.path} is bound twice with different hashes.`);
      }
      unique.set(document.path, document);
    }
    return [...unique.values()];
  }

  /** Exact active Project Authority inputs from one already-validated payload generation. */
  private readProjectAuthorityInputs(payload: ProjectGovernancePayload): TrackedDocument[] {
    return payload.authorityManifest.documents.map((document) => ({
      path: document.canonicalPath,
      hash: document.sha256,
      bytes: document.bytes,
    }));
  }

  private projectGovernancePayload(): ProjectGovernancePayload {
    if (this.projectBinding === null) {
      throw new Error('Legacy runtime has no Project Governance basis.');
    }
    const authorityManifest = requireCurrentProjectAuthority(this.projectBinding.record);
    const benchmarkRuntime = resolveProjectBenchmarkRuntime(
      this.projectBinding.record,
      authorityManifest,
    );
    const rebound: ResolvedProjectRuntimeBinding = {
      ...this.projectBinding,
      authority: {
        ...this.projectBinding.authority,
        state: 'CURRENT',
        proofReady: true,
        issues: [],
        manifest: authorityManifest,
      },
      benchmarkRuntime,
    };
    const basis = projectGovernanceBasisFromBinding(rebound);
    if (basis === null) throw new Error('Current Project Authority did not produce a governance basis.');
    return { basis, authorityManifest, benchmarkRuntime };
  }

  private projectGovernanceBasisDocument(payload: ProjectGovernancePayload): TrackedDocument {
    const json = canonicalJson(payload);
    return {
      path: PROJECT_GOVERNANCE_BASIS_PATH,
      hash: hashCanonicalJson(payload),
      bytes: Buffer.byteLength(json, 'utf8'),
    };
  }

  /** Historical, exact Project Authority context for a task's committed mission. */
  public projectAuthorityContext(missionId: string): {
    readonly basis: ProjectGovernanceBasis;
    readonly documents: readonly { readonly binding: ActiveAuthorityDocument; readonly text: string }[];
  } | null {
    const mission = this.get(missionId);
    if (mission === null) throw new Error(`Unknown mission version ${missionId}`);
    const synthetic = mission.documents.find((document) => document.path === PROJECT_GOVERNANCE_BASIS_PATH);
    if (synthetic === undefined) return null;
    const parsed = JSON.parse(
      this.artifacts.getText(requireSha256(synthetic.hash, 'project governance document hash')),
    ) as {
      basis?: unknown;
      authorityManifest?: { documents?: unknown };
    };
    const basis = projectGovernanceBasisSchema.parse(parsed.basis);
    if (!Array.isArray(parsed.authorityManifest?.documents)) {
      throw new Error(`Mission ${missionId} Project Governance artifact has no authority document manifest.`);
    }
    const bindings = parsed.authorityManifest.documents as ActiveAuthorityDocument[];
    return {
      basis,
      documents: bindings.map((binding) => ({
        binding,
        text: this.documentText(missionId, binding.canonicalPath),
      })),
    };
  }

  /**
   * Reads the two governed target inputs into the mission basis (`DEV-P1-49`).
   *
   * `readGovernedFiles` cannot carry these, and the reason is the resolution base rather than
   * an oversight: everything there is repo-relative, while `project.inputs.*` are relative to
   * **`project.root`** — a different tree whenever the target is not CLU-E itself — and may be
   * absolute. Resolving them against `repoRoot` would hash the wrong file, or nothing.
   *
   * Why they belong in the basis at all: `config/clue.config.yaml` is already bound, so editing
   * the config *names* a new intent and registers a successor. Editing the description itself did
   * not — measured, not assumed: appending a line to `target description.md` and re-running `init`
   * reported `unchanged`, while a one-line config edit reported `architectural`. The declared
   * intent of the project could be rewritten without the mission noticing, which is the exact
   * confusion Constitution §3.4 draws a line under: the description is authoritative for declared
   * intent, so a verdict reached under one declaration must not silently inherit another.
   * Invariant §4.2.4 — no verdict depends on an unversioned input — makes it structural rather
   * than a preference.
   *
   * A configured-but-absent input is fatal here, unlike a policy file in `readGovernedFiles`.
   * The asymmetry is deliberate: a policy that is simply not defined is a legitimate installation
   * shape, whereas an input the operator named and did not provide is a broken declaration, and
   * `clue doctor` already reports it as a failure. An unconfigured input (`null`) is skipped
   * entirely and binds nothing — that is the honest state of an installation with no declared
   * intent, not an error.
   *
   * This binds the input *bytes*. The cycle-lock comparison Status §4.1 specifies —
   * `CONTINUE_LOCKED` / `RESTART_WITH_NEW_INPUTS` / `FORK_NEW_MISSION` — is a separate mechanism
   * belonging with `src/cycle/`, which does not exist. Binding is what makes that comparison
   * possible later; it is not the comparison.
   */
  private readTargetInputs(): TrackedDocument[] {
    const documents: TrackedDocument[] = [];
    const inputs = this.config.project.inputs;

    for (const key of ['description', 'benchmark'] as const) {
      const configured = inputs[key];
      if (configured === null) continue;

      const absolute =
        absolutePathForm(configured) === null
          ? join(this.config.project.root, configured)
          : configured;

      let bytes: Buffer;
      try {
        bytes = readFileSync(absolute);
      } catch (error) {
        throw new Error(
          `Governed target input project.inputs.${key} could not be read at ${absolute}: ` +
            `${(error as Error).message}`,
        );
      }
      // Recorded repo-relative when the input is inside the repository, absolute when it is not.
      //
      // Not the configured spelling, which was the first thing tried and is wrong: `project.inputs`
      // is relative to `project.root`, while every other path in the basis — and the artifact
      // capture that re-reads it — is relative to `repoRoot`. Recording the configured string made
      // `storeDocumentContents` stat a file that does not exist. Keeping it repo-relative where
      // possible also keeps the mission identical between two machines assessing the same target,
      // since an absolute form would embed the host's root.
      const recorded = absolutePathForm(configured) === null && absolute.startsWith(this.repoRoot)
        ? relative(this.repoRoot, absolute).split('\\').join('/')
        : absolute;
      documents.push({ path: recorded, hash: hashBytes(bytes), bytes: bytes.byteLength });
    }

    return documents;
  }

  /**
   * Reads every tracked document as raw bytes.
   *
   * Bytes, not text: the hash must describe the file exactly as stored, so that CLUE's
   * hashes agree with Git's view and with whatever a reader opens. A missing document
   * is fatal — a mission whose rules are not on disk is not a mission.
   */
  private readTrackedDocuments(): TrackedDocument[] {
    return this.config.constitution.tracked_documents.map((relativePath) => {
      const absolute = join(this.repoRoot, relativePath);
      let bytes: Buffer;
      try {
        bytes = readFileSync(absolute);
      } catch (error) {
        throw new Error(
          `Tracked document ${relativePath} could not be read at ${absolute}: ` +
            `${(error as Error).message}`,
        );
      }
      return { path: relativePath, hash: hashBytes(bytes), bytes: bytes.byteLength };
    });
  }

  /**
   * Reads the configuration and policy files the mission binds beyond the tracked documents.
   *
   * These are governed inputs — the active target profile, amendment derivation, equilibrium,
   * patching, and gateway policies — so a change to one must register a new version. A file that is not
   * present is skipped rather than fatal: an installation need not define every policy, and a
   * policy that appears later is itself a change the next bootstrap will bind. Files already
   * listed as tracked documents are left to that path to avoid binding them twice.
   */
  private readGovernedFiles(): TrackedDocument[] {
    const tracked = new Set(this.config.constitution.tracked_documents);
    const activeTargetProfile =
      this.config.project.active_target === null
        ? null
        : `targets/${this.config.project.active_target}/profile.yaml`;

    const candidates = new Set<string>([
      CONFIG_FILE_PATH,
      // D1 / DEV-P1-27: when project.active_target is used, the profile is the authoritative
      // source of the whole project block. Binding only clue.config.yaml would let root, source
      // scope, remote, credentials-by-name, or target inputs change without moving the mission.
      // Null is omitted for the legacy self-contained configuration form.
      ...(activeTargetProfile === null ? [] : [activeTargetProfile]),
      this.config.equilibrium.policy_file,
      this.config.patching.policy_file,
      this.config.gateway.budget_policy_file,
      this.config.gateway.routing_file,
      // P2 closure policy is a Creator decision, not a dashboard preference. Binding it
      // makes SAFE_DISABLED_DEFERRED/OPERATIONAL changes register a successor mission.
      'config/policies/p2-closure.yaml',
      // DEV-P0-07: bind the actual toolchain and compiler identity by content hash, not a version
      // string. package.json is the manifest and package-lock pins every resolved dependency (the
      // TypeScript compiler included); tsconfig — and every base it extends — pins the compiler
      // options. A change to any of them registers a successor mission automatically.
      'package.json',
      'package-lock.json',
      ...this.tsconfigChain('tsconfig.json'),
      // DEV-P0-07: the measurement and record-schema authorities, bound by content hash so a change to
      // the catalogue, the coordinate map, or the persisted-record schema registers a successor — the
      // bytes in force are the binding, not the 'clue-catalogue/6' label recorded in the toolchain doc.
      MEASUREMENT_CATALOGUE_PATH,
      MEASUREMENT_COORDINATE_PATH,
      RECORD_SCHEMA_AUTHORITY_PATH,
    ]);

    const documents: TrackedDocument[] = [];
    for (const relativePath of [...candidates].sort()) {
      if (tracked.has(relativePath)) continue;
      const absolute = join(this.repoRoot, relativePath);
      if (!existsSync(absolute)) continue;
      const bytes = readFileSync(absolute);
      documents.push({ path: relativePath, hash: hashBytes(bytes), bytes: bytes.byteLength });
    }
    return documents;
  }

  /**
   * The full tsconfig extends chain from a root, as repo-relative paths (DEV-P0-07). A tsconfig that
   * extends a local base inherits that base's compiler options, so the base is part of the mission's
   * compiler identity and must be bound too. Package-name extends (resolved from node_modules) are
   * already pinned by the lockfile, so only local (./ or ../) bases are followed here.
   */
  private tsconfigChain(rootRelative: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | null = rootRelative;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      const absolute = join(this.repoRoot, current);
      if (!existsSync(absolute)) break;
      let extendsField: unknown;
      try {
        extendsField = (JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>)['extends'];
      } catch {
        break;
      }
      const bases = typeof extendsField === 'string' ? [extendsField] : Array.isArray(extendsField) ? extendsField : [];
      const local = bases.find((base): base is string => typeof base === 'string' && (base.startsWith('./') || base.startsWith('../')));
      current = local === undefined ? null : relative(this.repoRoot, join(dirname(absolute), local));
    }
    return chain;
  }

  /** The toolchain versions, in the exact object hashed into the basis and stored as a blob. */
  private toolchainVersions(): Record<string, unknown> {
    return {
      schema: this.toolchain.schemaVersion,
      recognizer: this.toolchain.recognizerVersion,
      catalogue: this.toolchain.catalogueVersion,
      config_schema: CONFIG_SCHEMA_VERSION,
    };
  }

  /**
   * A synthetic bound-input document recording the toolchain versions.
   *
   * The versions are code constants with no file of their own, but a change to any of them
   * must still register a new mission. Recording them as a document — a stable synthetic path
   * with a content hash over the versions — binds them through the same change-detection path
   * as every other input, with no schema change. Its blob is the versions as canonical JSON,
   * so `putJson` reproduces exactly this hash.
   */
  private toolchainBasisDocument(): TrackedDocument {
    const json = canonicalJson(this.toolchainVersions());
    return {
      path: TOOLCHAIN_BASIS_PATH,
      hash: hashCanonicalJson(this.toolchainVersions()),
      bytes: Buffer.byteLength(json, 'utf8'),
    };
  }

  private constitutionHashOf(documents: readonly TrackedDocument[]): Sha256 {
    const constitution = documents.find(
      (document) => document.path === this.config.constitution.file,
    );
    if (constitution === undefined) {
      throw new Error(`Constitution ${this.config.constitution.file} is not among tracked documents`);
    }
    return requireSha256(constitution.hash, 'constitution hash');
  }

  /**
   * Points every stale current row at the successor.
   *
   * Registration commits the new version and then supersedes its predecessor as a second
   * event. A crash between the two can leave more than one row with `superseded_by = NULL`.
   * The one truly in force is the highest version; superseding every other one restores a
   * single head so `current` is unambiguous. A clean installation has at most one such row and
   * this does nothing.
   */
  private healSupersededChain(): void {
    const rows = this.projections.db
      .prepare('SELECT id FROM mission_versions WHERE superseded_by IS NULL ORDER BY version ASC')
      .all();
    if (rows.length <= 1) return;

    const ids = rows.map(missionRowId);
    const headId = ids[ids.length - 1];
    if (headId === undefined) return;

    let healed = false;
    for (const staleId of ids.slice(0, -1)) {
      this.log.append({
        type: KERNEL_EVENT_TYPES.missionSuperseded,
        actor: 'daemon',
        missionVersion: headId,
        subjectId: staleId,
        payload: { superseded_id: staleId, successor_id: headId },
      });
      healed = true;
    }
    if (healed) this.projections.sync(this.log);
  }

  /**
   * Stores the exact bytes of every bound input, stamping each artifact event with a mission
   * that is ALREADY committed. The new version is not referenced until its own commit event,
   * so a crash here never leaves an event pointing at an uncommitted version. The synthetic
   * toolchain record is stored as its canonical-JSON blob; every other input is a file.
   */
  /**
   * Resolves a bound document's recorded path back to a file on disk.
   *
   * Every path in the basis was repo-relative until `DEV-P1-49` bound the two target inputs, which
   * belong to `project.root` and may sit outside the repository entirely. Joining an absolute path
   * onto `repoRoot` produces a path that exists nowhere — silently on POSIX, visibly nonsense on
   * Windows — so the resolution rule is stated once here and used by every consumer rather than
   * assumed at each call site.
   */
  private resolveBoundDocument(recordedPath: string): string {
    return absolutePathForm(recordedPath) === null
      ? join(this.repoRoot, recordedPath)
      : recordedPath;
  }

  private storeDocumentContents(
    documents: readonly TrackedDocument[],
    committedStamp: string,
  ): void {
    for (const document of documents) {
      const ref =
        document.path === TOOLCHAIN_BASIS_PATH
          ? this.artifacts.putJson(this.toolchainVersions(), { label: document.path })
          : document.path === PROJECT_GOVERNANCE_BASIS_PATH
            ? this.artifacts.putJson(this.projectGovernancePayload(), { label: document.path })
            : this.artifacts.putFile(this.resolveBoundDocument(document.path), {
                mediaType: 'text/markdown; charset=utf-8',
                label: document.path,
              });

      if (ref.hash !== document.hash) {
        throw new Error(
          `Bound input ${document.path} changed while the mission was being registered ` +
            `(${document.hash} then ${ref.hash}). Retry once it is stable.`,
        );
      }

      this.log.append({
        type: KERNEL_EVENT_TYPES.artifactStored,
        actor: 'daemon',
        missionVersion: committedStamp,
        subjectId: null,
        payload: ref,
      });
    }
  }
}

/** Stamped on the very first events, before any mission version exists. */
export const BOOTSTRAP_MISSION_ID = 'MISSION-BOOTSTRAP';

/* ------------------------------------------------------------------------- */
/* Change classification                                                      */
/* ------------------------------------------------------------------------- */

function classifyChange(
  previous: MissionVersion | null,
  documents: readonly TrackedDocument[],
  constitutionHash: Sha256,
  amendmentsHash: Sha256,
): MissionChangeKind {
  if (previous === null) return 'initial';

  const constitutionMoved = previous.constitution_hash !== constitutionHash;
  const amendmentsMoved = amendmentsContentHash(previous.amendments) !== amendmentsHash;
  if (constitutionMoved || amendmentsMoved) return 'constitutional';

  const documentsMoved = diffDocuments(previous.documents, documents).length > 0;
  return documentsMoved ? 'architectural' : 'unchanged';
}

/** Paths whose hash differs, plus any document added or removed. */
function diffDocuments(
  previous: readonly TrackedDocument[],
  next: readonly TrackedDocument[],
): string[] {
  const before = new Map(previous.map((document) => [document.path, document.hash]));
  const after = new Map(next.map((document) => [document.path, document.hash]));
  const changed = new Set<string>();

  for (const [path, hash] of after) {
    if (before.get(path) !== hash) changed.add(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

function diffAmendments(previous: readonly Amendment[], next: readonly Amendment[]): string[] {
  const before = new Set(previous.map((amendment) => amendment.code));
  const after = new Set(next.map((amendment) => amendment.code));
  const delta = new Set<string>();

  for (const code of after) if (!before.has(code)) delta.add(`+${code}`);
  for (const code of before) if (!after.has(code)) delta.add(`-${code}`);
  return [...delta].sort();
}

/**
 * Hashes the full content of the amendments in force, excluding the volatile timestamp.
 *
 * Comparing codes alone would miss a change to an amendment's directive or the boundaries it
 * affects — a real change to the rules. Comparing whole objects, including `recorded_at`, would
 * declare a change on every bootstrap and make the signal worthless. Hashing `{code, directive,
 * affects}` sorted by code captures every change to what an amendment says, and none to when it
 * was recorded, and is recomputable from the amendments stored on any past version.
 */
function amendmentsContentHash(amendments: readonly Amendment[]): Sha256 {
  const canonical = [...amendments]
    .map((amendment) => ({
      code: amendment.code,
      directive: amendment.directive,
      affects: [...amendment.affects],
    }))
    .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  return hashCanonicalJson(canonical);
}

/** Extracts the id from a `mission_versions` row read for supersession healing. */
function missionRowId(row: unknown): string {
  if (typeof row !== 'object' || row === null) {
    throw new Error('mission_versions row is not an object');
  }
  const id = (row as Record<string, unknown>)['id'];
  if (typeof id !== 'string') {
    throw new Error('mission_versions row is missing a string id');
  }
  return id;
}

/* ------------------------------------------------------------------------- */
/* Row reading                                                                */
/* ------------------------------------------------------------------------- */

function readMissionRow(row: unknown): MissionVersion {
  if (typeof row !== 'object' || row === null) {
    throw new Error('mission_versions row is not an object');
  }
  const record = row as Record<string, unknown>;

  return parseOrThrow(
    missionVersionSchema,
    {
      id: record['id'],
      version: record['version'],
      created_at: record['created_at'],
      constitution_hash: record['constitution_hash'],
      documents: parseJsonField(record['documents_json'], 'documents_json'),
      amendments: parseJsonField(record['amendments_json'], 'amendments_json'),
      superseded_by: record['superseded_by'] ?? null,
    },
    'mission_versions row',
  );
}

function parseJsonField(value: unknown, field: string): unknown {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${field} to be stored as JSON text`);
  }
  return JSON.parse(value) as unknown;
}
