/** Evidence and eligibility checks for an explicitly approved local Custodian landing. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { decodeSourceByteRange, sourceTextLayout } from '../../analysis/source/sourceEncoding.js';
import type { SourceUnit } from '../../analysis/source/recognizer.js';
import { readCurrentFindings } from '../../control/cycleFindings.js';
import { isBenchmarkProfileContract } from '../../control/projectProfiles/benchmarkProfileInputs.js';
import { resolveProjectRecognition } from '../../control/projectProfiles/projectRecognition.js';
import { makeProtectedMatcher, readProtectedPolicy, type Runtime } from '../../control/runtime.js';
import { CYCLE_EVENT_TYPES } from '../../cycle/cycleRegistry.js';
import { PROOF_EVENT_TYPES, proofContractHash, type ProofContract } from '../../proof/proofContract.js';
import { canonicalJson, hashBytes, hashText, requireSha256 } from '../../shared/ids.js';
import { containsPath } from '../../shared/pathIdentity.js';
import {
  cycleStageAdvancedSchema, entityIdSchema, projectIdSchema, sha256Schema,
  type CycleInputLock, type EventRecord,
} from '../../shared/schemas.js';

const enabledGate = z.object({ enabled: z.literal(true) });
const ruleList = z.array(z.string().min(1).max(1_024)).max(100).default([]);
const protectionRule = z.object({
  id: z.string().min(1),
  match: z.object({ identifiers: ruleList, path_globs: ruleList, file_contains: ruleList }).strict(),
}).passthrough().refine(({ match }) => Object.values(match).some((markers) => markers.length > 0));
const positiveInteger = z.number().int().positive().safe();
const patchingPolicy = z.object({
  version: z.literal(1),
  gates: z.object({
    g1_verdict: enabledGate.extend({ require_accepted: z.literal(true), require_frozen_contract_hash_match: z.literal(true) }).strict(),
    g2_guardrails: enabledGate.extend({ require_all_green: z.literal(true), require_at_least_one: z.literal(true) }).strict(),
    g3_build: enabledGate.extend({ commands: z.tuple([z.literal('typecheck'), z.literal('build')]) }).strict(),
    g4_clean_tree: enabledGate.extend({ require_clean_working_tree: z.literal(true), require_expected_branch: z.literal(true) }).strict(),
    g5_merge: enabledGate.extend({ strategy: z.literal('fast_forward_only'), allow_trivial_three_way: z.literal(false) }).strict(),
    g6_protected_surfaces: enabledGate.extend({ action_on_match: z.literal('NOTIFY') }).strict(),
    g7_blast_radius: enabledGate.extend({
      allowed_classes: z.array(z.enum(['monodependency', 'local'])).min(1),
      max_impact_size: positiveInteger,
      max_impact_modules: positiveInteger,
      max_impact_subsystems: positiveInteger,
      min_classification_confidence: z.number().min(0).max(1),
      reject_truncated_impact: z.literal(true),
    }).strict(),
    g8_reverse_patch: enabledGate.extend({ require_stored: z.literal(true), require_verified_applicable: z.literal(true) }).strict(),
    g9_quota: enabledGate.strict(),
    g10_mission: enabledGate.extend({ require_unchanged_mission_version: z.literal(true), require_unchanged_patching_policy: z.literal(true) }).strict(),
  }).strict(),
  protected_surfaces: z.array(protectionRule).min(1).max(100),
  quotas: z.object({
    max_landings_per_day: positiveInteger,
    max_landings_per_hour: positiveInteger,
    max_unacknowledged_landings: positiveInteger,
  }).strict(),
  landing: z.object({ branch_prefix: z.string().min(1), sign_commits: z.literal(false) }).passthrough(),
  post_land_verification: z.object({
    commands: z.tuple([z.literal('typecheck'), z.literal('regression_suite')]),
    timeout_seconds: positiveInteger.max(3_600),
    auto_revert_on_failure: z.literal(true),
    revert_strategy: z.literal('git_revert'),
  }).strict(),
}).passthrough();

const landingEvent = z.object({
  scope: z.object({ projectId: projectIdSchema, proofEventId: entityIdSchema }).passthrough(),
}).passthrough();
const recognitionCheckpoint = z.object({
  stage: z.literal('RECOGNIZED'), cycle_id: entityIdSchema, snapshot_id: sha256Schema,
  result_hash: sha256Schema, run_key: sha256Schema,
});
const selectedEvidence = z.object({
  findingId: entityIdSchema, unitId: z.string().min(1), unitVersion: sha256Schema,
  path: z.string().min(1), line: positiveInteger, endLine: positiveInteger,
  kind: z.literal('patch'), proofReadiness: z.literal('measurable'),
});
const findingEvidence = z.object({
  recognitionEventId: entityIdSchema,
  recognitionSha256: sha256Schema,
  findings: z.array(z.object({ findingId: entityIdSchema }).passthrough()).max(25),
});

type PatchingPolicy = z.infer<typeof patchingPolicy>;

export interface LocalLandingPolicy {
  readonly approvedFindingId: string;
  readonly verifyCommands: readonly [string, string];
  readonly verifyTimeoutSeconds: number;
}

function requireCondition(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

function readPolicyBytes(path: string): Buffer {
  const info = lstatSync(path);
  requireCondition(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 128 * 1024 &&
    relative(path, realpathSync.native(path)) === '', 'P43 requires an ordinary, unlinked patching policy file.');
  return readFileSync(path);
}

function verifyQuota(events: readonly EventRecord[], projectId: string, quotas: PatchingPolicy['quotas'],
  recoveringProofEventId: string | undefined): void {
  const attempts = new Map<string, { initiatedAt: number; applied: boolean; rolledBack: boolean }>();
  for (const event of events) {
    if (event.type !== 'landing.local_prepared' && event.type !== 'landing.local_applied' &&
        event.type !== 'landing.local_rolled_back') continue;
    requireCondition(event.actor === 'custodian', 'P43 quota evidence has an unexpected actor.');
    const { scope } = landingEvent.parse(event.payload);
    if (scope.projectId !== projectId) continue;
    const proofId = scope.proofEventId;
    const previous = attempts.get(proofId);
    if (event.type === 'landing.local_prepared') {
      requireCondition(previous === undefined, 'P43 quota evidence repeats an already prepared proof.');
      attempts.set(proofId, { initiatedAt: Date.parse(event.timestamp), applied: false, rolledBack: false });
      continue;
    }
    requireCondition(previous !== undefined, 'P43 quota evidence has no matching prepared proof.');
    if (event.type === 'landing.local_applied') {
      requireCondition(!previous.applied && !previous.rolledBack, 'P43 quota evidence repeats an applied proof.');
      previous.applied = true;
      continue;
    }
    requireCondition(!previous.rolledBack, 'P43 quota evidence repeats a rolled-back proof.');
    previous.rolledBack = true;
  }
  const now = Date.now();
  const hour = 60 * 60 * 1_000;
  const day = 24 * hour;
  const records = [...attempts.values()];
  requireCondition(records.every(({ initiatedAt }) => Number.isFinite(initiatedAt) && initiatedAt <= now),
    'P43 quota evidence is newer than the system clock.');
  // A durable intent already accounts for this exact operation, including recovery after ref update.
  if (recoveringProofEventId !== undefined && attempts.has(recoveringProofEventId)) return;
  requireCondition(records.filter(({ initiatedAt }) => now - initiatedAt < hour).length < quotas.max_landings_per_hour &&
    records.filter(({ initiatedAt }) => now - initiatedAt < day).length < quotas.max_landings_per_day &&
    records.filter(({ rolledBack }) => !rolledBack).length < quotas.max_unacknowledged_landings,
  'P43 local landing quota has been reached.');
}

function readVerificationCommands(runtime: Runtime, lock: CycleInputLock): readonly [string, string] {
  const scripts = runtime.config.runtime.scripts;
  // SCN-006 fixes the suite that can run wholly inside the Windows network boundary.
  const regressionSuite = 'node dist/selftest/benchmark-offline-suite-v1.js';
  const registeredSuite = lock.master_benchmark !== null && isBenchmarkProfileContract(lock.master_benchmark.sha256);
  requireCondition(scripts['typecheck'] === 'npm run typecheck' && scripts['build'] === 'npm run build' &&
    registeredSuite && (scripts['regression_suite'] === undefined || scripts['regression_suite'] === regressionSuite),
  'P43 requires the fixed typecheck, build and regression-suite routes.');
  return ['npm run typecheck', regressionSuite];
}

type BlockFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function findFunctionBody(file: ts.SourceFile, start: number, end: number): ts.Block | null {
  let body: ts.Block | null = null;
  const visit = (node: ts.Node): void => {
    if (node.pos > start || node.end < end) return;
    if (node.getStart(file) === start && node.end === end) {
      let declaration: BlockFunction | null = null;
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) declaration = node;
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) declaration = node.initializer;
      if (declaration?.body !== undefined && ts.isBlock(declaration.body)) body = declaration.body;
    }
    if (body === null) ts.forEachChild(node, visit);
  };
  visit(file);
  return body;
}

function verifySelectedBodyEdit(path: string, unit: SourceUnit, before: Buffer, after: Buffer): readonly [string, string] {
  const beforeLayout = sourceTextLayout(before);
  const afterLayout = sourceTextLayout(after);
  requireCondition(beforeLayout.encoding === 'utf8' && afterLayout.encoding === 'utf8',
    'P43 currently verifies UTF-8 source edits.');
  const beforeText = decodeSourceByteRange(before, beforeLayout);
  const afterText = decodeSourceByteRange(after, afterLayout);
  const { startByte, endByte } = unit.anchor;
  requireCondition(startByte >= beforeLayout.bomBytes && endByte > startByte && endByte <= before.length,
    'P43 selected declaration has an invalid byte anchor.');
  const start = decodeSourceByteRange(before, beforeLayout, beforeLayout.bomBytes, startByte).length;
  const originalDeclaration = decodeSourceByteRange(before, beforeLayout, startByte, endByte);
  const end = start + originalDeclaration.length;
  requireCondition(hashText(originalDeclaration) === unit.versionHash,
    'P43 selected declaration bytes differ from the recognized version.');
  const afterEnd = end + afterText.length - beforeText.length;
  const originalFile = ts.createSourceFile(path, beforeText, ts.ScriptTarget.Latest, true);
  const candidateFile = ts.createSourceFile(path, afterText, ts.ScriptTarget.Latest, true);
  const beforeBody = findFunctionBody(originalFile, start, end);
  const afterBody = findFunctionBody(candidateFile, start, afterEnd);
  requireCondition(beforeBody !== null && afterBody !== null,
    'P43 requires the selected declaration to retain its block-bodied function or method shape.');
  const prefixBytes = beforeLayout.bomBytes + Buffer.byteLength(beforeText.slice(0, beforeBody.getStart(originalFile) + 1));
  const afterPrefixBytes = afterLayout.bomBytes + Buffer.byteLength(afterText.slice(0, afterBody.getStart(candidateFile) + 1));
  const suffixOffset = beforeLayout.bomBytes + Buffer.byteLength(beforeText.slice(0, beforeBody.end - 1));
  const afterSuffixOffset = afterLayout.bomBytes + Buffer.byteLength(afterText.slice(0, afterBody.end - 1));
  requireCondition(prefixBytes === afterPrefixBytes && suffixOffset >= prefixBytes && afterSuffixOffset >= afterPrefixBytes &&
    before.subarray(0, prefixBytes).equals(after.subarray(0, afterPrefixBytes)) &&
    before.subarray(suffixOffset).equals(after.subarray(afterSuffixOffset)) && !before.equals(after),
  'P43 patch bytes must differ only inside the selected declaration body.');
  return [
    decodeSourceByteRange(before, beforeLayout, prefixBytes, suffixOffset),
    decodeSourceByteRange(after, afterLayout, afterPrefixBytes, afterSuffixOffset),
  ];
}

/** Read the locked policy and the exact screened finding before issuing landing authority. */
export function readLocalLandingPolicy(runtime: Runtime, lock: CycleInputLock, events: readonly EventRecord[],
  screenedSnapshotId: string, contract: ProofContract, path: string, before: Uint8Array, after: Uint8Array,
  recoveringProofEventId?: string): LocalLandingPolicy {
  const { config, projectProfile } = runtime;
  const identity = runtime.projectIdentity;
  requireCondition(projectProfile !== null && identity !== null && config.patching.mode === 'NOTIFY' &&
    config.patching.merge_strategy === 'fast_forward_only' && config.security.canonical_source_writes === 'custodian_only' &&
    projectProfile.profile.integrations.git.publicationMode !== 'NO_REMOTE_YET',
  'P43 requires an active profile with explicit Custodian landing in NOTIFY mode.');
  requireCondition(lock.grade === 'proof-authoritative' && lock.project_basis !== undefined &&
    contract.mission_version === runtime.requireMission().requireCurrentBasis().id &&
    canonicalJson(lock.project_basis) === canonicalJson(contract.project_basis) &&
    canonicalJson(lock.project_basis.operationIdentity) === canonicalJson(identity) &&
    lock.project_basis.profileGeneration === projectProfile.generation && contract.snapshot_id === screenedSnapshotId,
  'P43 requires the exact current mission, project profile and screened proof lock.');

  const policyPath = resolve(runtime.repoRoot, config.patching.policy_file);
  const lockPolicy = lock.policy_files.filter(({ path: lockedPath }) => lockedPath === config.patching.policy_file);
  const projectPolicy = projectProfile.profile.integrations.git.protectedLandingPolicy;
  requireCondition(lockPolicy.length === 1 && !isAbsolute(config.patching.policy_file) &&
    containsPath(runtime.repoRoot, policyPath) &&
    (projectPolicy === null || relative(policyPath, projectPolicy) === ''),
  'P43 patching policy or profile landing policy differs from the locked project policy.');
  const bytes = readPolicyBytes(policyPath);
  requireCondition(lockPolicy[0]?.sha256 === hashBytes(bytes), 'P43 patching policy bytes differ from the cycle lock.');
  const policy = patchingPolicy.parse(parseYaml(bytes.toString('utf8')));
  requireCondition(policy.landing.branch_prefix === config.patching.landing_branch_prefix &&
    canonicalJson(policy.post_land_verification.commands) === canonicalJson(config.patching.post_land_verify),
  'P43 branch or verification policy differs from the active configuration.');
  const protect = readProtectedPolicy(runtime.repoRoot, config);
  requireCondition(protect.present && !protect.malformed && bytes.equals(readPolicyBytes(policyPath)),
    'P43 could not reproduce the locked protected-surface rules.');
  const protectedSurface = makeProtectedMatcher(protect.rules);

  const findings = readCurrentFindings(runtime);
  const selection = findings?.selected;
  const findingEvent = events.find((event) => event.id === findings?.eventId && event.hash === findings.eventSha256);
  const freeze = events.findLast((event) => event.type === PROOF_EVENT_TYPES.contractFrozen &&
    event.subject_id === contract.cycle_id && event.mission_version === contract.mission_version &&
    (event.payload as { contract_hash?: unknown } | undefined)?.contract_hash === proofContractHash(contract));
  requireCondition(findings?.outcome === 'SELECTED' && selection !== null && selection !== undefined &&
    findings.cycleId === contract.cycle_id && findings.missionId === contract.mission_version &&
    findings.lockDigest === lock.digest && findings.snapshotId === screenedSnapshotId &&
    findingEvent !== undefined && freeze !== undefined && findingEvent.sequence < freeze.sequence &&
    selection.path === path && contract.hypothesis.target_units.length === 1 &&
    contract.hypothesis.target_units[0] === selection.unitId && contract.thresholds.success.measure_id === selection.signalId,
  'P43 requires the exact selected finding, logical unit and benchmark signal for this proof.');

  const assessment = findingEvidence.parse(runtime.artifacts.getJson(requireSha256(findings.evidenceSha256, 'findings artifact')));
  const recognition = resolveProjectRecognition(runtime).projectRecognitionIdentity;
  const graph = runtime.requireGraph();
  const checkpoint = events.find((event) => event.id === assessment.recognitionEventId);
  const run = graph.recognition(screenedSnapshotId);
  requireCondition(recognition !== null && checkpoint?.type === CYCLE_EVENT_TYPES.stageAdvanced &&
    checkpoint.actor === 'daemon' && checkpoint.sequence < findingEvent.sequence &&
    checkpoint.subject_id === contract.cycle_id && checkpoint.mission_version === contract.mission_version &&
    run?.complete === true && run.result_hash === assessment.recognitionSha256,
  'P43 could not reproduce the selected finding recognition graph.');
  const checkpointPayload = cycleStageAdvancedSchema.parse(checkpoint.payload);
  requireCondition(checkpointPayload.to === 'RECOGNIZED' && checkpointPayload.evidence !== null,
    'P43 requires the durable recognition checkpoint artifact.');
  const recognitionBytes = runtime.artifacts.getBytes(requireSha256(checkpointPayload.evidence.hash, 'recognition checkpoint'));
  requireCondition(recognitionBytes.length === checkpointPayload.evidence.bytes, 'P43 recognition checkpoint size differs.');
  const recordedRun = recognitionCheckpoint.parse(JSON.parse(recognitionBytes.toString('utf8')));
  requireCondition(recordedRun.cycle_id === contract.cycle_id && recordedRun.snapshot_id === screenedSnapshotId &&
    recordedRun.result_hash === run.result_hash && recordedRun.run_key === run.run_key,
    'P43 current graph differs from the recognition checkpoint.');
  const source = graph.resultOf(screenedSnapshotId, recognition);
  const units = source?.units.filter(({ modulePath }) => modulePath === path);
  const unit = units?.find(({ logicalId }) => logicalId === selection.unitId);
  const findingsForUnit = assessment.findings.filter(({ findingId }) => findingId === selection.findingId);
  const recorded = selectedEvidence.parse(findingsForUnit[0]);
  requireCondition(unit !== undefined && (unit.kind === 'function' || unit.kind === 'method') &&
    unit.anchor.path === path && unit.anchor.startLine === selection.line && findingsForUnit.length === 1 &&
    recorded.unitId === unit.logicalId && recorded.unitVersion === unit.versionHash && recorded.path === path &&
    recorded.line === unit.anchor.startLine && recorded.endLine === unit.anchor.endLine,
  'P43 selected source unit differs from its durable finding or byte anchor.');
  const limits = policy.gates.g7_blast_radius;
  const classification = graph.classificationOf(screenedSnapshotId, selection.unitId);
  requireCondition(classification?.blastRadius === 'local' && classification.fileSpan === 'monofile' &&
    classification.protectedReason === null &&
    (classification.unitClass === 'local' || classification.unitClass === 'monodependency') &&
    limits.allowed_classes.includes(classification.unitClass) && !classification.truncated &&
    classification.confidence >= limits.min_classification_confidence && classification.impactSize <= limits.max_impact_size &&
    classification.impactModules <= limits.max_impact_modules && classification.impactSubsystems <= limits.max_impact_subsystems &&
    graph.closureOf(screenedSnapshotId, selection.unitId)?.truncated === false,
  'P43 selected declaration is outside the locked blast-radius policy.');

  const original = Buffer.from(before);
  const candidate = Buffer.from(after);
  const modifiedBodies = verifySelectedBodyEdit(path, unit, original, candidate).map((body) => body.toLowerCase());
  const texts = [original, candidate].map((sourceBytes) => decodeSourceByteRange(sourceBytes, sourceTextLayout(sourceBytes)).toLowerCase());
  requireCondition(units?.every((fileUnit) => protectedSurface(fileUnit) === null) === true &&
    policy.protected_surfaces.every(({ match }) =>
      match.file_contains.every((marker) => texts.every((body) => !body.includes(marker.toLowerCase()))) &&
      match.identifiers.every((marker) => modifiedBodies.every((body) => !body.includes(marker.toLowerCase())))),
  'P43 patch touches a protected source file, declaration or raw-text marker.');

  verifyQuota(events, identity.projectId, policy.quotas, recoveringProofEventId);
  return { approvedFindingId: selection.findingId, verifyCommands: readVerificationCommands(runtime, lock),
    verifyTimeoutSeconds: policy.post_land_verification.timeout_seconds };
}
