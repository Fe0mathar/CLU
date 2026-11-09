/**
 * CLUE projection store.
 *
 * Spec: CLUE_Architecture_v8.md (SQLite projections; single-writer daemon).
 * Execution: CLUE_Execution_Model_v8.md (projection rebuild / recovery path).
 * Backlog: DEV-P0-01 — full projection rebuild via a projection registry.
 *
 * SQLite holds no truth. Every row here is derived from the event log (or, for a few
 * index tables, from another durable file authority) and can be deleted at any moment
 * without losing anything — that is the property the Stage A / DEV-P0-01 acceptance gate
 * tests, and it is what makes the database safe to drop when a schema changes, an index
 * is wrong, or a projection turns out to have been computed badly.
 *
 * Two paths keep the projections aligned with the log:
 *
 *   catchUp()  the normal path — apply events the projections have not yet seen.
 *   rebuild()  the recovery path — clear *every* projection table and replay from zero.
 *
 * `rebuild()` does not trust a hardcoded table list. It discovers every projection table
 * from the live schema — the kernel's own tables plus every table any registered module
 * created — clears them all, resets AUTOINCREMENT counters so a deterministic replay
 * reproduces identical durable ids, and refuses to proceed if the clear phase left a row
 * behind. Modules may also register a `rehydrate` hook for bulk projections that are
 * rebuilt from the content-addressed artifact store rather than row-by-row from events.
 *
 * Both paths run inside a single transaction. A crash mid-apply therefore leaves the
 * projections exactly where they were, never half-advanced, and the recorded head always
 * describes a state that actually exists on disk.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { canonicalJson, hashCanonicalJson, nowIso, requireSha256, type Sha256 } from '../shared/ids.js';
import {
  PROJECT_PROFILE_VERSION,
  WORKSPACE_PROJECT_IDENTITY_VERSION,
  artifactRefSchema,
  missionVersionSchema,
  parseOrThrow,
  projectIdSchema,
  projectProfileHashSchema,
  targetRootIdentitySchema,
  workspaceProjectIdentitySchema,
  type EventRecord,
  type WorkspaceProjectIdentity,
} from '../shared/schemas.js';
import { EventLog, type LogHead } from './eventLog.js';

type Db = Database.Database;

/* ------------------------------------------------------------------------- */
/* Schema                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Bumped whenever the projection schema changes. Because projections are derived,
 * a version mismatch is resolved by rebuilding, never by writing a migration —
 * migrations exist for data that cannot be recomputed, and none of this qualifies.
 */
/**
 * The projection schema this build understands.
 *
 * Bump it whenever a projection table's shape or registered table set changes. A new
 * event-derived table still requires a bump: otherwise an existing workspace can retain a
 * current projection head and never replay the older events that populate the new module.
 *
 * Version 2 (DEV-P1-32): claims and metrics projection shapes changed.
 * Version 3 (DEV-P1-21): console sighting identity gained scenario identity.
 * Version 4 (DEV-P1-21): console sighting identity gained checkpoint identity.
 * Version 5 (ADR-0007): cycle closure gained criteria and unmet-count fields.
 * Version 6 (DEV-P2-12): the Great Book adds `great_book_entries` and
 * `great_book_recording_gaps`. Clearing the derived head forces a complete event replay, so
 * Status cannot claim a backed but historically empty Great Book after upgrading.
 * Version 7 (DEV-P2-09): the Model Gateway adds `gateway_calls`.
 * Version 8 (P2 B6 / ADR-0015): the Proof Board adds durable benchmark/proof history tables.
 * Version 9: projection modules and existing P2 schema consolidated.
 * Version 10 (PP-26): Model Gateway call/provider projections bind Project Profile identity
 * and durable profile generation. Rebuild is required so pre-profile rows cannot masquerade
 * as project-bound evidence merely because additive columns exist at runtime.
 *
 * PP-09 adds non-projection workspace ownership metadata without changing this version. The
 * singleton is not derived from the event log, so adding it must not invalidate or rebuild the
 * projection surface of an existing workspace.
 */
export const PROJECTION_SCHEMA_VERSION = 10;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- PP-09. This singleton is workspace ownership metadata, not an event projection. It is
-- deliberately excluded from rebuild/clear/digest operations and survives profile updates.
CREATE TABLE IF NOT EXISTS workspace_project_identity (
  singleton                   INTEGER PRIMARY KEY CHECK (singleton = 1),
  identity_version            TEXT NOT NULL,
  project_id                  TEXT NOT NULL,
  target_root_identity        TEXT NOT NULL,
  profile_version             TEXT NOT NULL,
  initial_profile_hash        TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  origin                      TEXT NOT NULL CHECK (origin IN ('new-workspace', 'legacy-adoption')),
  legacy_projection_head_hash TEXT,
  legacy_indexed_events       INTEGER NOT NULL CHECK (legacy_indexed_events >= 0)
);

-- Queryable index over the append-only log. The log remains the source of truth;
-- this exists so the daemon and CLI can answer questions without scanning NDJSON.
CREATE TABLE IF NOT EXISTS events_index (
  sequence        INTEGER PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE,
  timestamp       TEXT NOT NULL,
  type            TEXT NOT NULL,
  actor           TEXT NOT NULL,
  subject_id      TEXT,
  mission_version TEXT NOT NULL,
  hash            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_index_type    ON events_index(type);
CREATE INDEX IF NOT EXISTS events_index_subject ON events_index(subject_id);

CREATE TABLE IF NOT EXISTS artifacts (
  hash       TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_versions (
  id                TEXT PRIMARY KEY,
  version           INTEGER NOT NULL UNIQUE,
  created_at        TEXT NOT NULL,
  constitution_hash TEXT NOT NULL,
  documents_json    TEXT NOT NULL,
  amendments_json   TEXT NOT NULL,
  superseded_by     TEXT
);

-- Index over logs/audit.ndjson (spec §100). The NDJSON file remains authoritative;
-- AuditLog.reindex() rebuilds this table from that file. It is cleared by a full
-- rebuild like any other projection and repopulated from its own durable authority.
CREATE TABLE IF NOT EXISTS audit_entries (
  id               TEXT PRIMARY KEY,
  timestamp        TEXT NOT NULL,
  actor            TEXT NOT NULL,
  command          TEXT NOT NULL,
  capability       TEXT NOT NULL,
  target           TEXT,
  arguments_digest TEXT NOT NULL,
  decision         TEXT NOT NULL,
  reason           TEXT,
  mission_version  TEXT NOT NULL,
  duration_ms      REAL
);
CREATE INDEX IF NOT EXISTS audit_entries_decision ON audit_entries(decision);
CREATE INDEX IF NOT EXISTS audit_entries_time     ON audit_entries(timestamp);
`;

/**
 * Tables the kernel itself creates. Listed for documentation only: a full rebuild does
 * NOT use this list — it discovers and clears *every* projection table from the live
 * schema (kernel plus every registered module). Keeping the two decoupled is the whole
 * point of DEV-P0-01: a new subsystem table can never be silently missed by rebuild.
 */
const KERNEL_TABLES = ['events_index', 'artifacts', 'mission_versions', 'audit_entries'] as const;

/** Tables that carry store metadata rather than event-derived projection rows. */
const STATE_TABLE = 'projection_state';
const WORKSPACE_IDENTITY_TABLE = 'workspace_project_identity';

const STATE_LAST_SEQUENCE = 'last_sequence';
const STATE_HEAD_HASH = 'head_hash';
const STATE_SCHEMA_VERSION = 'schema_version';

/* ------------------------------------------------------------------------- */
/* Event types owned by the kernel                                            */
/* ------------------------------------------------------------------------- */

export const KERNEL_EVENT_TYPES = {
  missionRegistered: 'mission.registered',
  missionSuperseded: 'mission.superseded',
  artifactStored: 'artifact.stored',
} as const;

/**
 * A projector turns one event into projection rows. Later stages register their own
 * without touching this file; unknown event types are indexed and otherwise ignored,
 * so an old database can always consume a newer log.
 */
export type Projector = (db: Db, record: EventRecord) => void;

/**
 * A projection module is how a subsystem declares the projection surface it owns so the
 * store can install it, project into it, and — critically — clear and rebuild it. It
 * replaces the old arrangement where subsystems created tables directly on the db and
 * the store had no way to know they existed (the root cause of DEV-P0-01 / P0-01).
 *
 * `install`   creates the module's tables/indexes (idempotent `CREATE ... IF NOT EXISTS`).
 * `projectors` map event types this module owns to their projectors.
 * `tables`    the tables this module owns. Advisory: rebuild discovers tables from the
 *             live schema regardless, but declaring them lets the store fail loudly at
 *             construction if `install` did not create what the module claims.
 * `rehydrate` optional hook to repopulate bulk projections that are rebuilt from the
 *             artifact store rather than row-by-row from the event log (e.g. the graph
 *             and metric bodies). Runs after event replay, inside the rebuild txn.
 */
export interface ProjectionModule {
  readonly name: string;
  install(db: Db): void;
  readonly projectors?: Readonly<Record<string, Projector>>;
  readonly tables?: readonly string[];
  rehydrate?(db: Db): void;
}

/** Raised when a rebuild cannot guarantee a clean, fully-cleared projection surface. */
export class ProjectionRebuildError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProjectionRebuildError';
  }
}

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

export interface ProjectionStatus {
  readonly schemaVersion: number;
  readonly lastSequence: number | null;
  readonly headHash: Sha256 | null;
  readonly indexedEvents: number;
}

export interface SyncResult {
  readonly applied: number;
  readonly rebuilt: boolean;
  readonly lastSequence: number | null;
}

export interface WorkspaceProjectIdentityInput {
  readonly projectId: string;
  readonly targetRootIdentity: string;
  readonly profileVersion: typeof PROJECT_PROFILE_VERSION;
  /** Hash at first binding. It remains historical and is not rewritten on later profile updates. */
  readonly initialProfileHash: string;
}

export type WorkspaceIdentityMissingPolicy = 'reject' | 'initialize-new' | 'adopt-legacy';

export interface WorkspaceProjectIdentityBinding {
  readonly expected: WorkspaceProjectIdentityInput;
  /** Missing ownership is never claimed implicitly. The caller states exactly why it is safe. */
  readonly onMissing: WorkspaceIdentityMissingPolicy;
}

export type WorkspaceProjectIdentityErrorCode =
  | 'WORKSPACE_IDENTITY_UNINITIALIZED'
  | 'WORKSPACE_IDENTITY_ADOPTION_REQUIRED'
  | 'WORKSPACE_IDENTITY_INITIALIZATION_REFUSED'
  | 'WORKSPACE_IDENTITY_DATABASE_MISSING'
  | 'WORKSPACE_IDENTITY_MALFORMED'
  | 'WORKSPACE_IDENTITY_MISMATCH';

export class WorkspaceProjectIdentityError extends Error {
  public readonly code: WorkspaceProjectIdentityErrorCode;
  public readonly expected: WorkspaceProjectIdentityInput | null;
  public readonly actual: WorkspaceProjectIdentity | null;

  public constructor(
    code: WorkspaceProjectIdentityErrorCode,
    message: string,
    expected: WorkspaceProjectIdentityInput | null = null,
    actual: WorkspaceProjectIdentity | null = null,
  ) {
    super(message);
    this.name = 'WorkspaceProjectIdentityError';
    this.code = code;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ProjectionStoreOptions {
  /** Additional projectors keyed by event type, registered alongside kernel and module consumers. */
  readonly projectors?: Readonly<Record<string, Projector>>;
  /**
   * Projection modules to install and register. Each contributes schema, projectors,
   * and optional rehydration, and — unlike bare `projectors` — its tables are known to
   * the store and therefore cleared by a full rebuild.
   */
  readonly modules?: readonly ProjectionModule[];
  /**
   * Rehydration for kernel-owned tables that are not projected row-by-row from events and are not
   * owned by a module — `audit_entries`, whose durable authority is the append-only audit file.
   * `rebuild()` calls this after replay and after every module's rehydrate, inside the same
   * transaction, so a kernel table cleared by the rebuild is restored from its own authority rather
   * than left empty (DEV-P0-01). Late-bound, like the module rehydrators, because the audit log is
   * built after the store.
   */
  readonly rehydrateKernel?: (db: Db) => void;
  /**
   * WAL durability. 'normal' (default) is correct for derived data: a lost
   * transaction after a power cut costs a rebuild, not a fact. 'full' is available
   * for hosts where even that rebuild is unwelcome.
   */
  readonly synchronous?: 'normal' | 'full';
  /**
   * Open the database read-only. A read-only store creates no directory, writes no schema,
   * and issues no pragma that touches the file, so attaching to a workspace performs no DB
   * write at all. The workspace must already be initialised; a write method called on a
   * read-only store fails loud rather than silently doing nothing.
   */
  readonly readOnly?: boolean;
  /**
   * Governed ownership expected for this workspace. Missing ownership is handled only according to
   * the explicit policy: brand-new initialization, legacy adoption, or refusal.
   */
  readonly workspaceIdentity?: WorkspaceProjectIdentityBinding;
  /** Deterministic test/migration clock for the ownership receipt. */
  readonly workspaceIdentityNow?: () => string;
}

/* ------------------------------------------------------------------------- */
/* Projection store                                                           */
/* ------------------------------------------------------------------------- */

export class ProjectionStore {
  private readonly database: Db;
  private readonly projectors: Map<string, readonly Projector[]>;
  private readonly modules: readonly ProjectionModule[];
  private readonly rehydrateKernel: ((db: Db) => void) | undefined;
  private readonly readOnly: boolean;

  public constructor(databasePath: string, options: ProjectionStoreOptions = {}) {
    this.readOnly = options.readOnly ?? false;
    this.rehydrateKernel = options.rehydrateKernel;
    const databaseExistedAtOpen = existsSync(databasePath);
    const workspaceBinding = options.workspaceIdentity;
    if (!databaseExistedAtOpen && workspaceBinding !== undefined && workspaceBinding.onMissing !== 'initialize-new') {
      throw new WorkspaceProjectIdentityError(
        'WORKSPACE_IDENTITY_DATABASE_MISSING',
        `workspace projection database does not exist: ${databasePath}`,
        parseWorkspaceIdentityInput(workspaceBinding.expected),
        null,
      );
    }

    if (this.readOnly) {
      // A read-only store never writes: no directory, no schema, no file-touching pragma. The
      // workspace must already be initialised — the kernel-table check below verifies it.
      this.database = new Database(databasePath, { readonly: true, fileMustExist: true });
    } else {
      mkdirSync(dirname(databasePath), { recursive: true });
      this.database = new Database(databasePath, { fileMustExist: databaseExistedAtOpen });
    }

    // DEV-P1-47: from here to the end of the constructor, every throw used to escape with the
    // connection still open.
    //
    // Construction refuses a workspace on five paths — a missing kernel table, a module table
    // `install()` did not create, a read-only attach against an older schema, and the two
    // newer-schema refusals in `reconcileSchemaVersion` and `assertSchemaVersionReadable`. All
    // five run after `new Database(...)` and none closed it. A constructor that throws leaves
    // the caller nothing to close either: in `new ProjectionStore(p).close()`, `.close()` is
    // never reached.
    //
    // On POSIX the leak is invisible, which is how a green suite carried it: `unlink` succeeds
    // on an open file, so the cleanup after a refusal works and the descriptors are reclaimed
    // at process exit. On Windows the same unlink returns `EBUSY`. A build that says "Upgrade
    // CLUE rather than downgrading data" then holds the database it just refused, so the
    // workspace cannot be deleted, moved, or reopened until the process ends — and the refusal
    // is precisely the moment the operator needs to act on those files. Measured before this
    // fix, one refusal left three descriptors open: `clue.db`, `clue.db-wal`, `clue.db-shm`.
    //
    // Refusing to open is a decision to leave the workspace untouched. Continuing to hold it
    // contradicts that decision, so the close belongs here and not in each caller — none of
    // which can reach it anyway.
    //
    // The body stays inline rather than moving to an `initialise()` helper because `modules`
    // and `projectors` are `readonly`, and TypeScript permits assigning those only in the
    // constructor itself. A helper would have to drop the modifier to compile, trading a real
    // immutability guarantee for a cosmetic one.
    try {
      // A foreign or unbound database must be refused before WAL or schema changes.
      const workspaceToBind = workspaceBinding === undefined
        ? null
        : this.workspaceIdentityToBind(workspaceBinding, databaseExistedAtOpen);
      if (!this.readOnly) {
        this.database.pragma('journal_mode = WAL');
        this.database.pragma(
          `synchronous = ${options.synchronous === 'full' ? 'FULL' : 'NORMAL'}`,
        );
        this.database.pragma('foreign_keys = ON');
        this.database.exec(SCHEMA_SQL);
      }

      // The kernel schema must have created its own tables; if it did not, nothing
      // downstream can be trusted, so fail before a single event is projected. In read-only
      // mode this instead proves the workspace was initialised before it was attached to.
      for (const table of KERNEL_TABLES) {
        if (!this.tableExists(table)) {
          throw new Error(`Kernel schema did not create required table "${table}".`);
        }
      }

      this.modules = options.modules ?? [];

      // DEV-P1-32: the stale-schema check must precede the schema install, not follow it.
      //
      // Module DDL is `CREATE TABLE IF NOT EXISTS`, which is a no-op against a table that
      // already exists — so a table created by an earlier build keeps its old columns, and the
      // `CREATE INDEX` statements that follow fail on columns that were never added. That is a
      // throw during install, which is *before* `reconcileSchemaVersion` ever ran. The migration
      // mechanism was correct and simply unreachable: the failure happened one step upstream of
      // the code meant to prevent it.
      //
      // Dropping the projection tables is safe precisely because they are projections. Directory
      // §9: SQLite contains no independent truth, and deleting it and rebuilding from events plus
      // artifacts must reproduce the same canonical projections. A drop costs a rebuild; keeping
      // a half-migrated table costs correctness.
      if (!this.readOnly) {
        this.dropProjectionsIfSchemaStale();
      }

      // Install module schema up front so their tables are part of the live schema before
      // any rebuild. Idempotent `CREATE ... IF NOT EXISTS` means callers that still install
      // some schemas directly on the db (legacy wiring) remain compatible. A read-only store
      // installs nothing; the tables must already exist and are checked below.
      if (!this.readOnly) {
        for (const module of this.modules) {
          module.install(this.database);
        }
      }

      this.projectors = new Map<string, readonly Projector[]>();
      const registerProjector = (type: string, projector: Projector): void => {
        const existing = this.projectors.get(type) ?? [];
        this.projectors.set(type, [...existing, projector]);
      };
      registerProjector(KERNEL_EVENT_TYPES.missionRegistered, projectMissionRegistered);
      registerProjector(KERNEL_EVENT_TYPES.missionSuperseded, projectMissionSuperseded);
      registerProjector(KERNEL_EVENT_TYPES.artifactStored, projectArtifactStored);
      for (const module of this.modules) {
        for (const [type, projector] of Object.entries(module.projectors ?? {})) {
          registerProjector(type, projector);
        }
      }
      for (const [type, projector] of Object.entries(options.projectors ?? {})) {
        registerProjector(type, projector);
      }

      // Registry teeth: a module that declares a table it never created is a wiring bug.
      // Finding it here is far cheaper than discovering an uncleared table during a rebuild.
      for (const module of this.modules) {
        for (const table of module.tables ?? []) {
          if (!this.tableExists(table)) {
            if (this.readOnly) {
              // A read-only attach installs nothing (see above): a missing table means the workspace
              // database was created by an EARLIER schema and is missing a projection this version
              // declares. A read-only connection cannot migrate it. Say so, and name the one-command fix,
              // rather than blaming install() — which never ran on this path.
              throw new Error(
                `The workspace database is missing projection table "${table}" (declared by module ` +
                  `"${module.name}"). It was created by an earlier schema, and a read-only attach — the ` +
                  'console/dashboard opens read-only so it never locks out a concurrent writer — cannot ' +
                  'migrate it. Run a writer once to migrate the schema, e.g. `clue init` (idempotent and ' +
                  'safe on an existing workspace), then start the dashboard again.',
              );
            }
            throw new Error(
              `Projection module "${module.name}" declares table "${table}", ` +
                'but install() did not create it.',
            );
          }
        }
      }

      if (this.readOnly) {
        this.assertSchemaVersionReadable();
      } else {
        this.reconcileSchemaVersion();
      }

      if (workspaceToBind !== null) {
        this.bindWorkspaceIdentity(
          workspaceToBind,
          workspaceBinding?.onMissing === 'adopt-legacy',
          options.workspaceIdentityNow ?? nowIso,
        );
      }
    } catch (error) {
      // Best-effort. A connection that will not close is already unusable, and the refusal is
      // the fact the caller needs — masking it with an incidental cleanup failure would replace
      // a precise diagnosis with a vague one.
      try {
        this.database.close();
      } catch {
        /* nothing further can be salvaged from this connection */
      }
      throw error;
    }
  }

  /** Whether this store was opened read-only. */
  public get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** Direct handle for later stages. Writers must go through the daemon (spec §16). */
  public get db(): Db {
    return this.database;
  }

  /** Current durable workspace ownership, or null for a legacy workspace not yet bound. */
  public workspaceIdentity(): WorkspaceProjectIdentity | null {
    if (!this.tableExists(WORKSPACE_IDENTITY_TABLE)) return null;
    const row = this.database
      .prepare(
        `SELECT identity_version, project_id, target_root_identity, profile_version,
                initial_profile_hash, created_at, origin, legacy_projection_head_hash,
                legacy_indexed_events
           FROM ${WORKSPACE_IDENTITY_TABLE}
          WHERE singleton = 1`,
      )
      .get();
    if (row === undefined) return null;
    return parseWorkspaceIdentityRow(row);
  }

  /** Fails closed when the workspace is unbound or belongs to another governed project. */
  public assertWorkspaceIdentity(expectedInput: WorkspaceProjectIdentityInput): WorkspaceProjectIdentity {
    const expected = parseWorkspaceIdentityInput(expectedInput);
    const actual = this.workspaceIdentity();
    if (actual === null) {
      throw new WorkspaceProjectIdentityError(
        'WORKSPACE_IDENTITY_UNINITIALIZED',
        `workspace has no durable project identity; open it once with a writable profile runtime before read-only use`,
        expected,
        null,
      );
    }
    assertWorkspaceIdentityMatches(expected, actual);
    return actual;
  }

  /* ----------------------------- status ------------------------------- */

  public status(): ProjectionStatus {
    const lastSequenceRaw = this.readState(STATE_LAST_SEQUENCE);
    const headHashRaw = this.readState(STATE_HEAD_HASH);
    const countRow = this.database.prepare('SELECT COUNT(*) AS n FROM events_index').get();

    return {
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      lastSequence: lastSequenceRaw === null ? null : Number.parseInt(lastSequenceRaw, 10),
      headHash: headHashRaw === null ? null : requireSha256(headHashRaw, 'projection head hash'),
      indexedEvents: readCount(countRow),
    };
  }

  /**
   * True when the projections do not describe the current log head — either behind it
   * or, worse, describing a head the log no longer contains.
   */
  public isStale(log: EventLog): boolean {
    return this.isStaleAgainst(log.getHead());
  }

  /**
   * Whether the projections lag or diverge from a given log head (DEV-P0-10).
   *
   * Split out from {@link isStale} so a read-only attach — which holds no writer log — can prove
   * staleness against a head read without the lock (`EventLog.readHead`). Divergence (a matching
   * sequence with a different hash) counts as stale, since it means history was rewritten.
   */
  public isStaleAgainst(head: LogHead | null): boolean {
    const status = this.status();
    if (head === null) return status.lastSequence !== null;
    if (status.lastSequence === null) return true;
    return status.lastSequence !== head.sequence || status.headHash !== head.hash;
  }

  /* --------------------------- synchronisation ------------------------ */

  /**
   * Brings projections up to the log head, rebuilding from zero when they have
   * diverged rather than merely fallen behind.
   *
   * Divergence means the recorded head hash is not the log's hash at that sequence,
   * which can only happen if history was rewritten. Catching up from a rewritten log
   * would silently blend two incompatible histories, so the only safe response is to
   * discard the projections and recompute.
   */
  public sync(log: EventLog): SyncResult {
    if (this.readOnly) {
      throw new Error('This projection store is read-only; sync() would write and is refused.');
    }
    const status = this.status();
    const head = log.getHead();

    if (head === null) {
      if (status.lastSequence === null) {
        return { applied: 0, rebuilt: false, lastSequence: null };
      }
      return { ...this.rebuild(log), rebuilt: true };
    }

    if (status.lastSequence === null) {
      return { ...this.rebuild(log), rebuilt: true };
    }

    if (status.lastSequence > head.sequence) {
      return { ...this.rebuild(log), rebuilt: true };
    }

    if (status.lastSequence === head.sequence) {
      if (status.headHash === head.hash) {
        return { applied: 0, rebuilt: false, lastSequence: status.lastSequence };
      }
      return { ...this.rebuild(log), rebuilt: true };
    }

    return { ...this.catchUp(log, status.lastSequence, status.headHash), rebuilt: false };
  }

  /**
   * Clears every projection table and replays the whole log.
   *
   * This is the operation the DEV-P0-01 gate exercises: deleting the database file and
   * running it — or poisoning rows and rebuilding — must reproduce byte-identical
   * projections. The clear phase discovers every table from the live schema, so a table
   * added by any subsystem is included automatically; the post-clear guard turns any
   * table the clear could not reach into a loud failure rather than silent stale state.
   */
  public rebuild(log: Pick<EventLog, 'replay'>): SyncResult {
    return this.inTransaction(() => {
      this.clearAllProjections();

      let applied = 0;
      let lastSequence: number | null = null;
      let headHash: Sha256 | null = null;

      for (const record of log.replay()) {
        this.applyRecord(record);
        applied += 1;
        lastSequence = record.sequence;
        headHash = requireSha256(record.hash, 'event hash');
      }

      // Bulk projections rebuilt from the artifact store (not from per-row events) are
      // repopulated here by their owning module, inside the same transaction.
      for (const module of this.modules) {
        module.rehydrate?.(this.database);
      }

      // Kernel-owned tables restored from their own durable authority (e.g. audit_entries from the
      // audit file), inside the same transaction, after the modules.
      this.rehydrateKernel?.(this.database);

      this.writeState(STATE_LAST_SEQUENCE, lastSequence === null ? null : String(lastSequence));
      this.writeState(STATE_HEAD_HASH, headHash);
      return { applied, rebuilt: true, lastSequence };
    });
  }

  /* ------------------------------ internals --------------------------- */

  /**
   * Applies events after `fromSequence`.
   *
   * Stage A reads the log from the beginning and skips what is already applied. That
   * re-verifies the entire hash chain on every start, which is the right trade while
   * logs are small; a seek index is a later optimisation, and it is recorded here
   * rather than left as a surprise.
   */
  private catchUp(
    log: EventLog,
    fromSequence: number,
    expectedHashAtFrom: Sha256 | null,
  ): SyncResult {
    return this.inTransaction(() => {
      let applied = 0;
      let lastSequence = fromSequence;
      let headHash = expectedHashAtFrom;
      let confirmedAnchor = expectedHashAtFrom === null;

      for (const record of log.replay()) {
        if (record.sequence === fromSequence && expectedHashAtFrom !== null) {
          if (record.hash !== expectedHashAtFrom) {
            throw new Error(
              `Projections claim event ${fromSequence} hashes to ${expectedHashAtFrom}, ` +
                `but the log has ${record.hash}. History was rewritten; rebuild required.`,
            );
          }
          confirmedAnchor = true;
          continue;
        }
        if (record.sequence <= fromSequence) continue;

        this.applyRecord(record);
        applied += 1;
        lastSequence = record.sequence;
        headHash = requireSha256(record.hash, 'event hash');
      }

      if (!confirmedAnchor) {
        throw new Error(
          `Projections reference event ${fromSequence}, which is absent from the log.`,
        );
      }

      this.writeState(STATE_LAST_SEQUENCE, String(lastSequence));
      this.writeState(STATE_HEAD_HASH, headHash);
      return { applied, rebuilt: false, lastSequence };
    });
  }

  /**
   * Empties every projection table and resets sequence counters, leaving only
   * `projection_state`'s own metadata. Must run inside a transaction.
   *
   * Foreign-key enforcement is deferred to COMMIT so no dependency ordering is needed:
   * during a rebuild every table ends empty, and after replay/rehydrate every table is
   * consistently repopulated, so the single check at COMMIT always passes.
   */
  private clearAllProjections(): void {
    this.database.pragma('defer_foreign_keys = ON');

    const tables = this.projectionTableNames();
    for (const table of tables) {
      this.database.prepare(`DELETE FROM "${table}"`).run();
    }

    // Reset AUTOINCREMENT counters so a deterministic replay reproduces identical durable
    // integer ids; without this, rebuilt rows could carry different ids than a clean build.
    if (this.tableExists('sqlite_sequence')) {
      this.database.prepare('DELETE FROM sqlite_sequence').run();
    }

    this.writeState(STATE_LAST_SEQUENCE, null);
    this.writeState(STATE_HEAD_HASH, null);

    // Poison-survival guard: after the clear phase, nothing may remain. A still-populated
    // table is one the clear could not reach — precisely the failure this method exists
    // to make impossible — so it is a hard error rather than silent stale truth.
    const survivors = tables.filter((table) => this.rowCount(table) > 0);
    if (survivors.length > 0) {
      throw new ProjectionRebuildError(
        `Rebuild left rows in projection table(s): ${survivors.join(', ')}. ` +
          'Every projection table must be empty before replay.',
      );
    }
  }

  /**
   * A canonical, order-independent digest of the entire projection surface plus the
   * recorded head. This is the comparison instrument for the DEV-P0-01 acceptance gate:
   * a rebuild (or a poison-then-rebuild) must produce the same digest as a clean build
   * over the same log and artifacts. Rows are canonicalised and sorted per table, so the
   * digest is insensitive to physical row order.
   */
  public canonicalExportDigest(): Sha256 {
    const tables = this.projectionTableNames().sort(compareStrings);
    const contents: Record<string, string[]> = {};
    for (const table of tables) {
      const rows = this.database.prepare(`SELECT * FROM "${table}"`).all();
      contents[table] = rows.map((row) => canonicalJson(normaliseRow(row))).sort(compareStrings);
    }
    const state = {
      last_sequence: this.readState(STATE_LAST_SEQUENCE),
      head_hash: this.readState(STATE_HEAD_HASH),
      schema_version: this.readState(STATE_SCHEMA_VERSION),
    };
    return hashCanonicalJson({ state, tables: contents });
  }

  /** Every derived table currently in the schema, excluding SQLite internals and state. */
  private projectionTableNames(): string[] {
    const rows = this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const names: string[] = [];
    for (const row of rows) {
      const name = readName(row);
      if (name === null) continue;
      if (name.startsWith('sqlite_')) continue;
      if (name === STATE_TABLE || name === WORKSPACE_IDENTITY_TABLE) continue;
      names.push(name);
    }
    return names;
  }

  private tableExists(name: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return row !== undefined;
  }

  private rowCount(table: string): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
    return readCount(row);
  }

  /** Indexes the event, then runs its projector if one is registered. */
  private applyRecord(record: EventRecord): void {
    this.database
      .prepare(
        `INSERT INTO events_index
           (sequence, id, timestamp, type, actor, subject_id, mission_version, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sequence,
        record.id,
        record.timestamp,
        record.type,
        record.actor,
        record.subject_id,
        record.mission_version,
        record.hash,
      );

    const projectors = this.projectors.get(record.type) ?? [];
    for (const projector of projectors) projector(this.database, record);
  }

  /**
   * A projection schema older than the code cannot be trusted, and a projection schema
   * newer than the code means an older CLUE is running against a newer workspace.
   * The first is fixed by clearing; the second must stop, because a downgrade that
   * silently drops columns would destroy work the newer version recorded.
   */
  /**
   * Drops every module projection table when the recorded schema predates this build.
   *
   * Runs before the module DDL, because `CREATE TABLE IF NOT EXISTS` cannot widen a table
   * that already exists: an old table survives the create and then its new indexes fail on
   * columns nobody added. Dropping lets the DDL rebuild each table at its current shape, and
   * the cleared head makes the next `sync()` replay the log into it.
   *
   * Only module-declared tables are dropped. Kernel tables and `clue_state` are not: the
   * state row is what records the version being reconciled, and dropping the kernel schema
   * would discard the event index this store rebuilds *from*.
   *
   * A newer recorded version is refused here rather than migrated. A downgrade that silently
   * dropped columns would destroy work a later build recorded, and the drop this method
   * performs is exactly that destruction if it runs in the wrong direction.
   */
  private dropProjectionsIfSchemaStale(): void {
    if (!this.tableExists(STATE_TABLE)) return;
    const recorded = this.readState(STATE_SCHEMA_VERSION);
    if (recorded === null) return;

    const version = Number.parseInt(recorded, 10);
    if (!Number.isFinite(version) || version === PROJECTION_SCHEMA_VERSION) return;

    if (version > PROJECTION_SCHEMA_VERSION) {
      throw new Error(
        `Workspace projections are at schema version ${version}, but this CLUE build ` +
          `understands ${PROJECTION_SCHEMA_VERSION}. Upgrade CLUE rather than downgrading data.`,
      );
    }

    this.database.pragma('defer_foreign_keys = ON');
    this.inTransaction(() => {
      for (const module of this.modules) {
        for (const table of module.tables ?? []) {
          this.database.exec(`DROP TABLE IF EXISTS "${table}"`);
        }
      }
      // The head must go with the tables: a retained head would tell the next sync() that
      // the now-empty projections were already current.
      this.writeState(STATE_LAST_SEQUENCE, null);
      this.writeState(STATE_HEAD_HASH, null);
      return null;
    });
  }

  private reconcileSchemaVersion(): void {
    const recorded = this.readState(STATE_SCHEMA_VERSION);
    if (recorded === null) {
      this.writeState(STATE_SCHEMA_VERSION, String(PROJECTION_SCHEMA_VERSION));
      return;
    }

    const version = Number.parseInt(recorded, 10);
    if (version === PROJECTION_SCHEMA_VERSION) return;

    if (version > PROJECTION_SCHEMA_VERSION) {
      throw new Error(
        `Workspace projections are at schema version ${version}, but this CLUE build ` +
          `understands ${PROJECTION_SCHEMA_VERSION}. Upgrade CLUE rather than downgrading data.`,
      );
    }

    // An older schema is invalidated by clearing everything; the next sync() sees a null
    // head and rebuilds from the log. Clearing goes through the same discovery path as a
    // full rebuild, so a schema bump can never leave a stale later-stage table behind.
    this.inTransaction(() => {
      this.clearAllProjections();
      this.writeState(STATE_SCHEMA_VERSION, String(PROJECTION_SCHEMA_VERSION));
      return null;
    });
  }

  /**
   * Read-only schema-version check: verifies the recorded version is understood, without
   * writing. A newer version is refused (this build cannot read it); an older or absent
   * version is left untouched, since correcting it is a write a read-only store must not make.
   */
  private assertSchemaVersionReadable(): void {
    const recorded = this.readState(STATE_SCHEMA_VERSION);
    if (recorded === null) return;
    const version = Number.parseInt(recorded, 10);
    if (version > PROJECTION_SCHEMA_VERSION) {
      throw new Error(
        `Workspace projections are at schema version ${version}, but this CLUE build ` +
          `understands ${PROJECTION_SCHEMA_VERSION}. Upgrade CLUE rather than downgrading data.`,
      );
    }
  }

  private workspaceIdentityToBind(
    binding: WorkspaceProjectIdentityBinding,
    databaseExistedAtOpen: boolean,
  ): WorkspaceProjectIdentityInput | null {
    const expected = parseWorkspaceIdentityInput(binding.expected);
    const actual = this.workspaceIdentity();
    if (actual !== null) {
      assertWorkspaceIdentityMatches(expected, actual);
      return null;
    }

    if (this.readOnly || binding.onMissing === 'reject') {
      throw new WorkspaceProjectIdentityError(
        'WORKSPACE_IDENTITY_ADOPTION_REQUIRED',
        'workspace has no durable project identity; activation is blocked until a new workspace is explicitly initialized or an existing workspace is explicitly adopted',
        expected,
        null,
      );
    }

    if (binding.onMissing === 'initialize-new' && databaseExistedAtOpen) {
      throw new WorkspaceProjectIdentityError(
        'WORKSPACE_IDENTITY_INITIALIZATION_REFUSED',
        'initialize-new was requested for a database that already existed; use explicit legacy adoption after validating its history',
        expected,
        null,
      );
    }
    return expected;
  }

  private bindWorkspaceIdentity(
    expected: WorkspaceProjectIdentityInput,
    adoptLegacy: boolean,
    clock: () => string,
  ): void {
    if (!this.tableExists(WORKSPACE_IDENTITY_TABLE)) {
      throw new WorkspaceProjectIdentityError(
        'WORKSPACE_IDENTITY_UNINITIALIZED',
        'workspace identity schema was not installed',
        expected,
        null,
      );
    }

    const status = this.status();
    const identity = workspaceProjectIdentitySchema.parse({
      identityVersion: WORKSPACE_PROJECT_IDENTITY_VERSION,
      ...expected,
      createdAt: clock(),
      origin: adoptLegacy ? 'legacy-adoption' : 'new-workspace',
      legacyProjectionHeadHash: adoptLegacy ? status.headHash : null,
      legacyIndexedEvents: adoptLegacy ? status.indexedEvents : 0,
    });

    this.database
      .prepare(
        `INSERT INTO ${WORKSPACE_IDENTITY_TABLE}
           (singleton, identity_version, project_id, target_root_identity, profile_version,
            initial_profile_hash, created_at, origin, legacy_projection_head_hash,
            legacy_indexed_events)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.identityVersion,
        identity.projectId,
        identity.targetRootIdentity,
        identity.profileVersion,
        identity.initialProfileHash,
        identity.createdAt,
        identity.origin,
        identity.legacyProjectionHeadHash,
        identity.legacyIndexedEvents,
      );

    const initialized = this.workspaceIdentity();
    if (initialized === null) {
      throw new WorkspaceProjectIdentityError(
        'WORKSPACE_IDENTITY_MALFORMED',
        'workspace identity insert completed without a readable singleton row',
        expected,
        null,
      );
    }
    assertWorkspaceIdentityMatches(expected, initialized);
  }

  private inTransaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private readState(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM projection_state WHERE key = ?').get(key);
    return readValue(row);
  }

  private writeState(key: string, value: string | null): void {
    if (value === null) {
      this.database.prepare('DELETE FROM projection_state WHERE key = ?').run(key);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO projection_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Flushes the WAL into the main database file, e.g. before backing the workspace up. */
  public checkpoint(): void {
    this.database.pragma('wal_checkpoint(TRUNCATE)');
  }

  public close(): void {
    this.database.close();
  }
}

function parseWorkspaceIdentityInput(
  input: WorkspaceProjectIdentityInput,
): WorkspaceProjectIdentityInput {
  return {
    projectId: projectIdSchema.parse(input.projectId),
    targetRootIdentity: targetRootIdentitySchema.parse(input.targetRootIdentity),
    profileVersion: input.profileVersion === PROJECT_PROFILE_VERSION
      ? input.profileVersion
      : (() => { throw new WorkspaceProjectIdentityError(
          'WORKSPACE_IDENTITY_MALFORMED',
          `unsupported Project Profile version ${String(input.profileVersion)}`,
        ); })(),
    initialProfileHash: projectProfileHashSchema.parse(input.initialProfileHash),
  };
}

function parseWorkspaceIdentityRow(row: unknown): WorkspaceProjectIdentity {
  if (typeof row !== 'object' || row === null) {
    throw new WorkspaceProjectIdentityError(
      'WORKSPACE_IDENTITY_MALFORMED',
      'workspace identity row is not an object',
    );
  }
  const value = row as Record<string, unknown>;
  try {
    return workspaceProjectIdentitySchema.parse({
      identityVersion: value['identity_version'],
      projectId: value['project_id'],
      targetRootIdentity: value['target_root_identity'],
      profileVersion: value['profile_version'],
      initialProfileHash: value['initial_profile_hash'],
      createdAt: value['created_at'],
      origin: value['origin'],
      legacyProjectionHeadHash: value['legacy_projection_head_hash'] ?? null,
      legacyIndexedEvents: value['legacy_indexed_events'],
    });
  } catch (error) {
    throw new WorkspaceProjectIdentityError(
      'WORKSPACE_IDENTITY_MALFORMED',
      `invalid durable workspace identity: ${errorMessage(error)}`,
    );
  }
}

function assertWorkspaceIdentityMatches(
  expected: WorkspaceProjectIdentityInput,
  actual: WorkspaceProjectIdentity,
): void {
  const mismatches: string[] = [];
  if (expected.projectId !== actual.projectId) mismatches.push('projectId');
  if (expected.targetRootIdentity !== actual.targetRootIdentity) mismatches.push('targetRootIdentity');
  if (expected.profileVersion !== actual.profileVersion) mismatches.push('profileVersion');

  if (mismatches.length > 0) {
    throw new WorkspaceProjectIdentityError(
      'WORKSPACE_IDENTITY_MISMATCH',
      `ROOT/WORKSPACE IDENTITY MISMATCH: workspace belongs to ${actual.projectId} ` +
        `(${actual.targetRootIdentity}); requested ${expected.projectId} ` +
        `(${expected.targetRootIdentity}); differing fields: ${mismatches.join(', ')}`,
      expected,
      actual,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Explicitly claims an existing legacy projection database for one Project Profile.
 *
 * The operation records the pre-adoption projection head/count and never changes event or
 * projection rows. Re-running it is idempotent when ownership matches and fails closed otherwise.
 */
export function adoptLegacyWorkspaceProjectIdentity(
  databasePath: string,
  expected: WorkspaceProjectIdentityInput,
  options: { readonly now?: () => string } = {},
): WorkspaceProjectIdentity {
  const parsedExpected = parseWorkspaceIdentityInput(expected);
  if (!existsSync(databasePath)) {
    throw new WorkspaceProjectIdentityError(
      'WORKSPACE_IDENTITY_DATABASE_MISSING',
      `legacy workspace projection database does not exist: ${databasePath}`,
      parsedExpected,
      null,
    );
  }

  // Idempotent re-runs are observational: if the marker already exists and matches, no writable
  // connection, WAL pragma, or filesystem metadata change is necessary.
  try {
    const reader = new ProjectionStore(databasePath, {
      readOnly: true,
      workspaceIdentity: { expected: parsedExpected, onMissing: 'reject' },
    });
    try {
      return reader.assertWorkspaceIdentity(parsedExpected);
    } finally {
      reader.close();
    }
  } catch (error) {
    if (
      !(error instanceof WorkspaceProjectIdentityError) ||
      ![
        'WORKSPACE_IDENTITY_UNINITIALIZED',
        'WORKSPACE_IDENTITY_ADOPTION_REQUIRED',
      ].includes(error.code)
    ) {
      throw error;
    }
  }

  const store = new ProjectionStore(databasePath, {
    workspaceIdentity: { expected: parsedExpected, onMissing: 'adopt-legacy' },
    ...(options.now === undefined ? {} : { workspaceIdentityNow: options.now }),
  });
  try {
    return store.assertWorkspaceIdentity(parsedExpected);
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------------- */
/* Kernel projectors                                                          */
/* ------------------------------------------------------------------------- */

function projectMissionRegistered(db: Db, record: EventRecord): void {
  const mission = parseOrThrow(
    missionVersionSchema,
    record.payload,
    `mission.registered payload of event ${record.id}`,
  );

  db.prepare(
    `INSERT INTO mission_versions
       (id, version, created_at, constitution_hash, documents_json, amendments_json, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version           = excluded.version,
       created_at        = excluded.created_at,
       constitution_hash = excluded.constitution_hash,
       documents_json    = excluded.documents_json,
       amendments_json   = excluded.amendments_json,
       superseded_by     = excluded.superseded_by`,
  ).run(
    mission.id,
    mission.version,
    mission.created_at,
    mission.constitution_hash,
    canonicalJson(mission.documents),
    canonicalJson(mission.amendments),
    mission.superseded_by,
  );
}

function projectMissionSuperseded(db: Db, record: EventRecord): void {
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`mission.superseded payload of event ${record.id} is not an object`);
  }

  const supersededId = readStringField(payload, 'superseded_id');
  const successorId = readStringField(payload, 'successor_id');
  db.prepare('UPDATE mission_versions SET superseded_by = ? WHERE id = ?').run(
    successorId,
    supersededId,
  );
}

function projectArtifactStored(db: Db, record: EventRecord): void {
  const artifact = parseOrThrow(
    artifactRefSchema,
    record.payload,
    `artifact.stored payload of event ${record.id}`,
  );

  db.prepare(
    `INSERT INTO artifacts (hash, bytes, media_type, label, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO NOTHING`,
  ).run(artifact.hash, artifact.bytes, artifact.media_type, artifact.label, artifact.created_at);
}

/* ------------------------------------------------------------------------- */
/* Row readers                                                                */
/* ------------------------------------------------------------------------- */
/* better-sqlite3 returns `unknown`; these are the only places CLUE narrows driver
 * output, and each checks the shape it depends on rather than asserting it. */

function readValue(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

function readCount(row: unknown): number {
  if (typeof row !== 'object' || row === null) return 0;
  const value = (row as { n?: unknown }).n;
  return typeof value === 'number' ? value : 0;
}

function readName(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const name = (row as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function readStringField(payload: object, field: string): string {
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected string field "${field}" in event payload`);
  }
  return value;
}

/** Deterministic string order for canonical exports (locale-independent). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Normalises one driver row into a JSON-safe, canonicalisable object. BLOB columns arrive
 * as Buffer/Uint8Array; hex-encoding them keeps the canonical export deterministic and
 * serialisable. All other SQLite column types (TEXT/INTEGER/REAL/NULL) pass through.
 */
function normaliseRow(row: unknown): Record<string, unknown> {
  if (typeof row !== 'object' || row === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value;
  }
  return out;
}
