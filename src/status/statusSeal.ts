/**
 * CLU-E Status — the State Seal.
 *
 * Spec: `CLUE_Status_Contract_v9.md`
 *   §15    the seal binds the canonicalized snapshot body and records its provenance;
 *          "the same durable inputs and declared timestamp must reproduce the same body
 *          and seal. A mismatch is a projector defect."
 *   §17    `clue status validate` — an exported body must be verifiable on its own
 *   §18    an invalid seal blocks automation and production-health claims
 *   §20    gate 3 (one and only one State Seal), gate 4 (UI, CLI and API return the same
 *          body/hash), gate 9 (exports survive restart and validate independently)
 * Supplement: `supplementation_v9.md` §9.6 — the Golden identities the seal additionally
 *          binds once a Golden backend exists.
 * Directory: `CLUE_Project_Directory_v9.md` §19.2 — the seal binds schema, mission,
 *          project snapshot, cycle, benchmark, Git, catalogue, and source-event identities.
 *
 * Backlog: DEV-P1-11 — Status had no seal because it had no schema; the only State Seal in
 *          the build was the console view-model's, one layer downstream of where §19.2
 *          places it.
 *
 * ## Three properties this module exists to hold
 *
 * **The hash cannot cover itself.** The seal is a member of the snapshot it seals, so the
 * digest is taken over the body with the `seal` member removed — the same construction as
 * the Navigator stream's prefix hash. {@link sealBodyDigest} is that operation and nothing
 * else, so a reader can see exactly what is and is not covered. Everything except the seal
 * is covered, which is what makes a swapped seal detectable: a valid seal lifted from
 * another snapshot fails immediately, because the digest recomputed from *this* body does
 * not match the hash the foreign seal carries.
 *
 * **It never reads a clock.** §15's determinism rule says the same durable inputs *and
 * declared timestamp* reproduce the same seal. A module that called `Date.now()` could not
 * satisfy that, and worse, its non-determinism would be invisible — two seals over
 * identical state would differ and there would be no way to tell that from a real change.
 * The timestamp is therefore a parameter. This module is pure: no I/O, no clock, no
 * randomness.
 *
 * **Consistency is evaluated, not asserted.** §15 records "consistency result" and the
 * contract's own §14 requires branches to agree with one another. A `consistent: true` the
 * projector simply declared would be worth nothing. {@link evaluateConsistency} performs
 * the cross-branch checks the body actually supports and returns what failed, so the flag
 * is a finding rather than a claim. Checks whose branches are unavailable are skipped and
 * counted as skipped — not silently passed, which would let an empty snapshot look
 * maximally consistent.
 */

import {
  BACKED_BRANCHES,
  UNSUPPORTED_BRANCHES,
  isBranchUnavailable,
  type StatusSeal,
  type StatusSnapshot,
} from './statusContractV5.js';
import { hashCanonicalJson, type Sha256 } from '../shared/ids.js';

/* ------------------------------------------------------------------------- */
/* Digest                                                                     */
/* ------------------------------------------------------------------------- */

/** The snapshot body without its seal — everything the status hash covers. */
export type SealedBody = Omit<StatusSnapshot, 'seal'>;

/**
 * The digest over the canonicalized body.
 *
 * `hashCanonicalJson` sorts object keys, so two bodies that differ only in property order
 * hash identically — which is required by gate 4: the UI, CLI and API each serialise the
 * same body through different paths and must arrive at the same hash.
 */
export function sealBodyDigest(body: SealedBody): Sha256 {
  return hashCanonicalJson(body);
}

/**
 * Strips the seal from a full snapshot. Used on the verification path, where the input is
 * a complete sealed snapshot rather than a body under construction.
 */
export function bodyOf(snapshot: StatusSnapshot): SealedBody {
  const { seal: _seal, ...body } = snapshot;
  void _seal;
  return body;
}

/* ------------------------------------------------------------------------- */
/* Consistency                                                                */
/* ------------------------------------------------------------------------- */

/** One cross-branch agreement check and how it came out. */
export interface ConsistencyCheck {
  readonly id: string;
  readonly outcome: 'pass' | 'fail' | 'skipped';
  /** Why it failed, or which branch was unavailable so it could not run. */
  readonly detail: string;
}

export interface ConsistencyResult {
  readonly consistent: boolean;
  readonly checks: readonly ConsistencyCheck[];
  /** Failure details only, in the shape {@link StatusSeal.inconsistencies} carries. */
  readonly inconsistencies: readonly string[];
  /** Checks that could not run. §18: absence stays visible rather than reading as a pass. */
  readonly skipped: number;
}

const pass = (id: string, detail = 'agrees'): ConsistencyCheck => ({ id, outcome: 'pass', detail });
const fail = (id: string, detail: string): ConsistencyCheck => ({ id, outcome: 'fail', detail });
const skip = (id: string, detail: string): ConsistencyCheck => ({ id, outcome: 'skipped', detail });

/**
 * Cross-branch agreement, evaluated from the body alone.
 *
 * Each check corresponds to a stated contract requirement, named in its comment. A check
 * whose branches are unavailable is *skipped*, never passed: a snapshot with nothing in it
 * must not be able to report perfect internal consistency, which is precisely the failure
 * an unconditional `consistent: true` produces.
 */
export function evaluateConsistency(body: SealedBody): ConsistencyResult {
  const checks: ConsistencyCheck[] = [];

  // §2: `scanned ≠ recognized`. Recognition and the inventory it recognised must name the
  // same capture, or the snapshot describes two different trees as one.
  if (isBranchUnavailable(body.recognition) || isBranchUnavailable(body.repositoryInventory)) {
    checks.push(skip('snapshot-identity', 'recognition or repositoryInventory is unavailable'));
  } else if (body.recognition.snapshotId !== body.repositoryInventory.snapshotId) {
    checks.push(
      fail(
        'snapshot-identity',
        `recognition names snapshot ${body.recognition.snapshotId} but the inventory names ` +
          `${body.repositoryInventory.snapshotId}`,
      ),
    );
  } else {
    checks.push(pass('snapshot-identity'));
  }

  // DEV-P1-06's parity anchor, surfaced as a status invariant: the Q1 stream may only
  // claim the graph whose result hash it actually carries.
  if (isBranchUnavailable(body.q1) || isBranchUnavailable(body.recognition)) {
    checks.push(skip('q1-graph-parity', 'q1 or recognition is unavailable'));
  } else if (body.q1.resultHash === null) {
    checks.push(skip('q1-graph-parity', 'the Q1 pointer names no committed result'));
  } else if (body.q1.resultHash !== body.recognition.resultHash) {
    checks.push(
      fail(
        'q1-graph-parity',
        `the Q1 pointer claims result ${body.q1.resultHash} but recognition committed ` +
          `${body.recognition.resultHash}`,
      ),
    );
  } else {
    checks.push(pass('q1-graph-parity'));
  }

  // §20 gate 38: Repository Inventory file count reconciles with Q1 ALL exactly once per
  // physical file. The projector computes it; the seal refuses to certify a stated failure.
  if (isBranchUnavailable(body.q1)) {
    checks.push(skip('inventory-reconciliation', 'q1 is unavailable'));
  } else if (body.q1.inventoryReconciles === null) {
    checks.push(skip('inventory-reconciliation', 'reconciliation was not evaluated'));
  } else if (!body.q1.inventoryReconciles) {
    checks.push(fail('inventory-reconciliation', 'gate 38: inventory and Q1 ALL disagree'));
  } else {
    checks.push(pass('inventory-reconciliation'));
  }

  // §18: a partial target scan cannot emit committed-complete status.
  if (isBranchUnavailable(body.recognition)) {
    checks.push(skip('recognition-completeness', 'recognition is unavailable'));
  } else if (body.recognition.filesRecognised > body.recognition.filesInProgram) {
    checks.push(
      fail(
        'recognition-completeness',
        `${body.recognition.filesRecognised} files recognised exceeds ` +
          `${body.recognition.filesInProgram} in the program`,
      ),
    );
  } else if (
    body.recognition.complete &&
    body.recognition.filesRecognised < body.recognition.filesInProgram
  ) {
    checks.push(
      fail(
        'recognition-completeness',
        'recognition claims complete while files in the program were not recognised',
      ),
    );
  } else {
    checks.push(pass('recognition-completeness'));
  }

  // ADR-0014 / DEV-P2-04: target publication is a recorded identity/absence only.
  // It must never smuggle Git lifecycle or publication authority into Status.
  if (isBranchUnavailable(body.target)) {
    checks.push(skip('target-publication', 'target is unavailable'));
  } else {
    const publication = body.target.publication;
    const coherent =
      publication.gitLifecycleImplemented === false &&
      publication.publicationPermitted === false &&
      (publication.decision === 'UNRECORDED'
        ? publication.decisionId === null &&
          publication.recordedAt === null &&
          publication.recordedBy === null &&
          publication.remote === null &&
          publication.credentialEnv === null &&
          publication.localOnly
        : publication.decision === 'NO_REMOTE_YET'
          ? publication.decisionId !== null &&
            publication.recordedAt !== null &&
            publication.recordedBy === 'creator' &&
            publication.remote === null &&
            publication.credentialEnv === null &&
            publication.localOnly
          : publication.decisionId !== null &&
            publication.recordedAt !== null &&
            publication.recordedBy === 'creator' &&
            publication.remote !== null &&
            !publication.localOnly);
    checks.push(
      coherent
        ? pass('target-publication', `${publication.decision}; publication authority remains denied`)
        : fail('target-publication', 'target publication decision fields contradict one another'),
    );
  }

  // PP-28 / Status 5.8.0: active project identity and readiness must be one coherent
  // generation across the target, Project Profile and Model Gateway branches.
  if (isBranchUnavailable(body.projectProfile)) {
    checks.push(skip('project-profile-identity', 'projectProfile is unavailable (legacy runtime or unreadable binding)'));
  } else {
    const profile = body.projectProfile;
    const requiredCapabilities = Object.values(profile.capabilities).filter((capability) => capability.required);
    const readinessCoherent =
      (!profile.readyForRequestedOperations || requiredCapabilities.every((capability) => capability.ready)) &&
      (!profile.readyForLocalWork || profile.capabilities.recognition.ready) &&
      (profile.assessmentAvailable || profile.overallReadiness === 'INCOMPLETE') &&
      (!['READY', 'READY_LOCAL_ONLY'].includes(profile.overallReadiness) || profile.readyForRequestedOperations) &&
      (profile.authorityState === 'CURRENT' || !['READY', 'READY_LOCAL_ONLY'].includes(profile.overallReadiness)) &&
      (profile.authorityConflictState === 'CLEAR' || !['READY', 'READY_LOCAL_ONLY'].includes(profile.overallReadiness));
    const targetCoherent =
      isBranchUnavailable(body.target) || body.target.targetId === profile.projectIdentity.projectId;
    const gatewayCoherent =
      isBranchUnavailable(body.aiOrchestration) ||
      body.aiOrchestration.projectIdentity === null ||
      (body.aiOrchestration.projectIdentity.projectId === profile.projectIdentity.projectId &&
        body.aiOrchestration.projectIdentity.targetRootIdentity === profile.projectIdentity.targetRootIdentity &&
        body.aiOrchestration.projectIdentity.projectProfileHash === profile.projectIdentity.projectProfileHash &&
        body.aiOrchestration.profileGeneration === profile.profileGeneration);
    if (!targetCoherent) {
      checks.push(fail('project-profile-identity', 'target and Project Profile name different active Project IDs'));
    } else if (!gatewayCoherent) {
      checks.push(fail('project-profile-identity', 'Model Gateway belongs to another Project Profile generation'));
    } else if (!readinessCoherent) {
      checks.push(fail('project-profile-identity', 'Project Profile readiness fields contradict capability or authority state'));
    } else {
      checks.push(pass('project-profile-identity'));
    }
  }

  // §14 and §20 gate 16: the catalogue identity must be one identity everywhere it appears.
  const catalogueHashes: { readonly branch: string; readonly hash: string | null }[] = [];
  if (!isBranchUnavailable(body.target)) {
    catalogueHashes.push({ branch: 'target', hash: body.target.catalogueHash });
  }
  if (!isBranchUnavailable(body.measurementCatalogue)) {
    catalogueHashes.push({ branch: 'measurementCatalogue', hash: body.measurementCatalogue.hash });
  }
  if (!isBranchUnavailable(body.improvementField)) {
    catalogueHashes.push({ branch: 'improvementField', hash: body.improvementField.catalogueHash });
  }
  const namedHashes = catalogueHashes.filter((entry) => entry.hash !== null);
  if (namedHashes.length < 2) {
    checks.push(skip('catalogue-agreement', 'fewer than two branches name a catalogue hash'));
  } else if (new Set(namedHashes.map((entry) => entry.hash)).size > 1) {
    checks.push(
      fail(
        'catalogue-agreement',
        `branches disagree on the catalogue in force: ${namedHashes
          .map((entry) => `${entry.branch}=${String(entry.hash).slice(0, 12)}`)
          .join(', ')}`,
      ),
    );
  } else {
    checks.push(pass('catalogue-agreement'));
  }

  // DEV-P2-12: the Great Book summary and the rendered 10×10 read model must be
  // two projections of the same immutable entries, not parallel stories. An explicit
  // ACCEPT-without-entry gap is itself an integrity failure: recursive memory is part of
  // the accepted verdict's mandatory consequence.
  if (isBranchUnavailable(body.greatBook) || isBranchUnavailable(body.improvementField)) {
    checks.push(skip('great-book-agreement', 'greatBook or improvementField is unavailable'));
  } else {
    const renderedContributions = body.improvementField.cells.reduce(
      (sum, cell) => sum + cell.segments.length,
      0,
    );
    const identityCoherent =
      (body.greatBook.entryCount === 0) === (body.greatBook.latestEntryId === null) &&
      (body.greatBook.entryCount === 0) === (body.greatBook.latestCycleId === null);
    const normalizationCoherent =
      body.improvementField.normalizationVersion === body.greatBook.normalizationVersion &&
      body.improvementField.normalizationHash === body.greatBook.normalizationHash;
    if (body.greatBook.recordingGapCount > 0) {
      checks.push(
        fail(
          'great-book-agreement',
          `${body.greatBook.recordingGapCount} accepted proof verdict(s) lack a Great Book entry`,
        ),
      );
    } else if (renderedContributions !== body.greatBook.contributionCount) {
      checks.push(
        fail(
          'great-book-agreement',
          `Great Book reports ${body.greatBook.contributionCount} contribution(s), ` +
            `Improvement Field renders ${renderedContributions}`,
        ),
      );
    } else if (!identityCoherent) {
      checks.push(fail('great-book-agreement', 'Great Book entry count and latest-entry identity disagree'));
    } else if (!normalizationCoherent) {
      checks.push(fail('great-book-agreement', 'Great Book and Improvement Field normalization identities disagree'));
    } else {
      checks.push(pass('great-book-agreement'));
    }
  }

  // DEV-P2-09: Model Gateway accounting is event-derived. Refusals are attempts that
  // never became submissions; every submitted call must be exactly terminal or pending.
  // Readiness is a conjunction of explicit policy, credential presence and non-zero caps,
  // never a boolean a projector may assert independently.
  if (isBranchUnavailable(body.aiOrchestration)) {
    checks.push(skip('ai-orchestration-accounting', 'aiOrchestration is unavailable'));
  } else {
    const calls = body.aiOrchestration.calls;
    const spend = body.aiOrchestration.spendUsd;
    const terminalOrPending = calls.completed + calls.failed + calls.pending;
    const observedCalls = calls.submitted + calls.refused;
    const latestCoherent = (observedCalls === 0) === (body.aiOrchestration.latest === null);
    const usage = body.aiOrchestration.usage;
    const usageCoherent =
      usage.cachedInputTokens <= usage.inputTokens &&
      usage.totalTokens === usage.inputTokens + usage.outputTokens;
    const pauseCoherent =
      body.aiOrchestration.providerPaused === body.aiOrchestration.providerBudgetExhausted &&
      (body.aiOrchestration.providerPaused
        ? body.aiOrchestration.providerState === 'paused_budget' && body.aiOrchestration.providerPauseReason !== null
        : body.aiOrchestration.providerState !== 'paused_budget');
    const authorityCoherent =
      body.aiOrchestration.budgetAuthority === 'openai_platform'
        ? !body.aiOrchestration.localBudgetEnforced &&
          !body.aiOrchestration.localPricingAuthoritative &&
          spend.dailyHard === 0 &&
          spend.monthlyHard === 0
        : body.aiOrchestration.localBudgetEnforced;
    const modelCoherent =
      !body.aiOrchestration.fallbackUsed &&
      (!body.aiOrchestration.operationallyReady ||
        (body.aiOrchestration.requestedModel !== null &&
          body.aiOrchestration.effectiveModel === body.aiOrchestration.requestedModel &&
          body.aiOrchestration.model === body.aiOrchestration.requestedModel));
    const readinessCoherent =
      !body.aiOrchestration.operationallyReady ||
      (body.aiOrchestration.enabled &&
        body.aiOrchestration.apiKeyPresent &&
        body.aiOrchestration.enabledRouteCount > 0 &&
        body.aiOrchestration.policyProblems.length === 0 &&
        !body.aiOrchestration.providerPaused &&
        modelCoherent &&
        (body.aiOrchestration.budgetAuthority === 'openai_platform' ||
          (spend.dailyHard > 0 && spend.monthlyHard > 0)));
    if (calls.submitted !== terminalOrPending) {
      checks.push(
        fail(
          'ai-orchestration-accounting',
          `gateway reports ${calls.submitted} submitted call(s) but ` +
            `${terminalOrPending} are completed, failed, or pending`,
        ),
      );
    } else if (!usageCoherent) {
      checks.push(fail('ai-orchestration-accounting', 'gateway token usage totals are contradictory'));
    } else if (!pauseCoherent) {
      checks.push(fail('ai-orchestration-accounting', 'provider budget pause fields are contradictory'));
    } else if (!authorityCoherent) {
      checks.push(
        fail(
          'ai-orchestration-accounting',
          'provider/local budget and pricing authority fields are contradictory',
        ),
      );
    } else if (!readinessCoherent) {
      checks.push(
        fail(
          'ai-orchestration-accounting',
          'gateway claims operational readiness without enabled policy, credential, route, provider authority and a clear provider state',
        ),
      );
    } else if (!latestCoherent) {
      checks.push(
        fail(
          'ai-orchestration-accounting',
          'gateway latest-call identity disagrees with its submitted/refused call count',
        ),
      );
    } else if (spend.reserved !== null && calls.pending === 0 && spend.reserved > 1e-12) {
      checks.push(
        fail(
          'ai-orchestration-accounting',
          `gateway reserves $${spend.reserved} while reporting no pending call`,
        ),
      );
    } else if (spend.todayActual !== null && spend.monthActual !== null && spend.todayActual > spend.monthActual + 1e-12) {
      checks.push(
        fail(
          'ai-orchestration-accounting',
          `today's gateway spend $${spend.todayActual} exceeds month-to-date $${spend.monthActual}`,
        ),
      );
    } else {
      checks.push(pass('ai-orchestration-accounting'));
    }
  }

  // §20 gate 11: a catalogue that cannot govern a run must not silently govern one.
  if (isBranchUnavailable(body.measurementCatalogue)) {
    checks.push(skip('catalogue-governance', 'measurementCatalogue is unavailable'));
  } else if (!body.measurementCatalogue.coordinatesUnique) {
    checks.push(fail('catalogue-governance', 'gate 11: catalogue coordinates are not unique'));
  } else if (!body.measurementCatalogue.productionReady) {
    checks.push(
      fail('catalogue-governance', 'the catalogue in force failed the production-readiness gate'),
    );
  } else {
    checks.push(pass('catalogue-governance'));
  }

  // §20 gate 14: exactly four gauge projections exist.
  if (isBranchUnavailable(body.gauges)) {
    checks.push(skip('gauge-count', 'gauges is unavailable'));
  } else if (body.gauges.gauges.length !== 4) {
    checks.push(fail('gauge-count', `gate 14: ${body.gauges.gauges.length} gauges, expected 4`));
  } else {
    checks.push(pass('gauge-count'));
  }

  // Supplement §9.8: exactly four unique Golden IDs, always — including when unavailable.
  const goldenIds = new Set(body.goldenMetrics.items.map((item) => item.id));
  if (body.goldenMetrics.items.length !== 4 || goldenIds.size !== 4) {
    checks.push(
      fail('golden-item-count', 'the Golden branch must carry exactly four unique stable IDs'),
    );
  } else {
    checks.push(pass('golden-item-count'));
  }

  // Supplement §9.8 clause 8: a missing Golden value never becomes zero or a healthy state.
  const inventedGolden = body.goldenMetrics.items.filter(
    (item) =>
      (item.state === 'UNAVAILABLE' || item.state === 'UNKNOWN') &&
      (item.normalizedValue !== null || item.normalizedDelta !== null),
  );
  if (inventedGolden.length > 0) {
    checks.push(
      fail(
        'golden-no-invented-values',
        `${inventedGolden.map((item) => item.id).join(', ')} report a value while stating no result`,
      ),
    );
  } else {
    checks.push(pass('golden-no-invented-values'));
  }

  // §1 and §20 gate 26: the snapshot's account of itself must match the snapshot. A body
  // that declares a branch backed while emitting an unavailability is describing a
  // different build than the one that produced it.
  const declaredBacked = new Set(body.capability.backedBranches);
  const misdeclared: string[] = [];
  for (const name of BACKED_BRANCHES) {
    const branch = body[name] as unknown;
    const populated = !isBranchUnavailable(branch as never);
    if (declaredBacked.has(name) && !populated) {
      misdeclared.push(`${name} is declared backed but carries no data`);
    }
  }
  for (const name of UNSUPPORTED_BRANCHES) {
    const branch = body[name] as unknown;
    if (!isBranchUnavailable(branch as never)) {
      misdeclared.push(`${name} carries data while the contract types it unsupported`);
    }
  }
  if (misdeclared.length > 0) {
    checks.push(fail('capability-declaration', misdeclared.join('; ')));
  } else {
    checks.push(pass('capability-declaration'));
  }

  const failures = checks.filter((check) => check.outcome === 'fail');
  return {
    consistent: failures.length === 0,
    checks,
    inconsistencies: failures.map((check) => `${check.id}: ${check.detail}`),
    skipped: checks.filter((check) => check.outcome === 'skipped').length,
  };
}

/* ------------------------------------------------------------------------- */
/* Sealing                                                                    */
/* ------------------------------------------------------------------------- */

/** Provenance the seal binds beyond what the body already states (§15, supplement §9.6). */
export interface SealProvenance {
  /** The declared capture time. §15: an input, never a clock read. */
  readonly generatedAt: string;
  readonly eventLogFrom: number | null;
  readonly eventLogTo: number | null;
  readonly projectionVersion: string | null;
  /** Supplement §9.6. Null while no Golden definition set exists. */
  readonly goldenDefinitionHash: Sha256 | null;
}

/**
 * Seals a body: evaluates consistency, digests the canonicalized body, and returns the one
 * seal (§20 gate 3).
 *
 * The identities the seal restates — target snapshot, mission hash, catalogue hash — are
 * read *from the body*, never passed in beside it. A caller able to supply them
 * independently could seal a body with provenance that contradicts it, which is the one
 * thing a seal must make impossible.
 */
export function sealStatus(body: SealedBody, provenance: SealProvenance): StatusSeal {
  const consistency = evaluateConsistency(body);
  return {
    statusHash: sealBodyDigest(body),
    generatedAt: provenance.generatedAt,
    eventLogFrom: provenance.eventLogFrom,
    eventLogTo: provenance.eventLogTo,
    projectionVersion: provenance.projectionVersion,
    targetSnapshotId: isBranchUnavailable(body.repositoryInventory)
      ? null
      : body.repositoryInventory.snapshotId,
    missionHash: isBranchUnavailable(body.target) ? null : body.target.missionBasisHash,
    catalogueHash: isBranchUnavailable(body.measurementCatalogue)
      ? null
      : body.measurementCatalogue.hash,
    goldenDefinitionHash: provenance.goldenDefinitionHash,
    consistent: consistency.consistent,
    inconsistencies: consistency.inconsistencies,
  };
}

/** Attaches a seal to its body, producing the complete snapshot. */
export function sealSnapshot(body: SealedBody, provenance: SealProvenance): StatusSnapshot {
  return { ...body, seal: sealStatus(body, provenance) };
}

/* ------------------------------------------------------------------------- */
/* Verification — §17 `clue status validate`                                  */
/* ------------------------------------------------------------------------- */

/** Why a seal did not verify. Distinct codes because §18 treats them differently. */
export type SealFailureCode =
  /** The body was altered after sealing, or the seal came from another snapshot. */
  | 'HASH_MISMATCH'
  /** The seal restates an identity the body contradicts. */
  | 'PROVENANCE_MISMATCH'
  /** The seal claims consistency the body does not currently satisfy. */
  | 'CONSISTENCY_MISMATCH';

export interface SealVerification {
  readonly valid: boolean;
  readonly failures: readonly { readonly code: SealFailureCode; readonly detail: string }[];
  /** The digest recomputed from the body, whether or not it matched. */
  readonly recomputedHash: Sha256;
  /** Consistency as it stands now, re-evaluated rather than taken from the seal. */
  readonly consistency: ConsistencyResult;
}

/**
 * Verifies an exported snapshot on its own (§17, §20 gate 9).
 *
 * Three independent checks, because they fail for different reasons and §18 says an
 * invalid seal blocks automation — so the operator needs to know *which* invalidity.
 *
 *   - the digest recomputed from the body must equal the hash the seal carries. This alone
 *     catches every mutation of the body and every foreign seal;
 *   - the identities the seal restates must still match the body it is attached to, which
 *     catches a seal edited in place to keep its hash plausible;
 *   - consistency is re-evaluated from scratch. A seal asserting `consistent: true` over a
 *     body whose branches now disagree is exactly the "projector defect" §15 names, and
 *     accepting the seal's own word for it would defeat the check entirely.
 */
export function verifySeal(snapshot: StatusSnapshot): SealVerification {
  const body = bodyOf(snapshot);
  const recomputedHash = sealBodyDigest(body);
  const consistency = evaluateConsistency(body);
  const failures: { code: SealFailureCode; detail: string }[] = [];

  if (recomputedHash !== snapshot.seal.statusHash) {
    failures.push({
      code: 'HASH_MISMATCH',
      detail:
        `the body hashes to ${recomputedHash} but the seal states ` +
        `${snapshot.seal.statusHash}; the body was altered or the seal is not its own`,
    });
  }

  const expectedTarget = isBranchUnavailable(body.repositoryInventory)
    ? null
    : body.repositoryInventory.snapshotId;
  if (snapshot.seal.targetSnapshotId !== expectedTarget) {
    failures.push({
      code: 'PROVENANCE_MISMATCH',
      detail: `the seal names target snapshot ${String(snapshot.seal.targetSnapshotId)} but the body carries ${String(expectedTarget)}`,
    });
  }

  const expectedCatalogue = isBranchUnavailable(body.measurementCatalogue)
    ? null
    : body.measurementCatalogue.hash;
  if (snapshot.seal.catalogueHash !== expectedCatalogue) {
    failures.push({
      code: 'PROVENANCE_MISMATCH',
      detail: `the seal names catalogue ${String(snapshot.seal.catalogueHash)} but the body carries ${String(expectedCatalogue)}`,
    });
  }

  if (snapshot.seal.consistent !== consistency.consistent) {
    failures.push({
      code: 'CONSISTENCY_MISMATCH',
      detail:
        `the seal states consistent=${snapshot.seal.consistent} but re-evaluation finds ` +
        `${consistency.consistent}: ${consistency.inconsistencies.join('; ') || 'no failures'}`,
    });
  }

  return { valid: failures.length === 0, failures, recomputedHash, consistency };
}
