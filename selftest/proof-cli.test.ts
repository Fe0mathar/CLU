/**
 * `clue proof` command authority and integration (DEV-P2-11, Stage H slice 1).
 *
 * This suite protects the boundary the core proof tests do not own: strict portable input
 * manifests, no arbitrary capability claim, closed command authority, one registered CLI
 * leaf, and a real command invocation that leaves the complete durable proof chain
 * while the canonical target remains untouched.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { nativeProofSkipReason } from './proof-isolation-fixture.js';
import assert from 'node:assert/strict';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { authorityFor } from '../src/cli/commandAuthority.js';
import { buildProgram } from '../src/cli/index.js';
import {
  assertProofInstrumentSafe,
  commandProof,
  loadProofPatchManifest,
  normalizeProofTargetPath,
} from '../src/cli/commands/proofCommands.js';
import { prepareSelfTargetExecution } from '../src/experiment/proof/executionCoordinator.js';
import { performBenchmarkRun, recordBenchmarkRun } from '../src/control/benchmarkRun.js';
import { loadConfig, withRuntime } from '../src/control/runtime.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { PROOF_EVENT_TYPES } from '../src/proof/proofContract.js';
import type { Sha256 } from '../src/shared/ids.js';
import { readGreatBookEntries, readGreatBookFacts } from '../src/greatBook/greatBookProjection.js';
import { projectStatusFromRuntime } from '../src/status/statusFromRuntime.js';
import { isBranchUnavailable } from '../src/status/statusContractV5.js';
import { proofContract, writeCliFixture, writeJson } from './proof-cli-fixture.js';

test('DEV-P2-11 CLI: target paths are portable, normalized and held below the tree', () => {
  assert.equal(normalizeProofTargetPath('src\\x\\file.ts'), 'src/x/file.ts');
  assert.equal(normalizeProofTargetPath('./src//file.ts'), 'src/file.ts');
  assert.throws(() => normalizeProofTargetPath('../file.ts'), /traverses above/);
  assert.throws(() => normalizeProofTargetPath('/etc/passwd'), /must be relative/);
  assert.throws(() => normalizeProofTargetPath('C:\\outside.ts'), /must be relative/);
  assert.throws(() => normalizeProofTargetPath('.'), /tree root/);
});

test('DEV-P2-11 CLI: manifest expands inline/source/delete operations exactly', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-cli-manifest-'));
  try {
    mkdirSync(join(root, 'payload'), { recursive: true });
    writeFileSync(join(root, 'payload', 'from-source.ts'), 'export const source = 1;\n', 'utf8');
    const manifest = join(root, 'patch.json');
    writeJson(manifest, {
      version: 1,
      operations: [
        { op: 'write', path: 'src/inline.ts', content: 'export const inline = 1;\n' },
        { op: 'write', path: 'src/from-source.ts', source: 'payload/from-source.ts' },
        { op: 'delete', path: 'src/old.ts' },
      ],
    });
    assert.deepEqual(loadProofPatchManifest(manifest), [
      { op: 'write', path: 'src/inline.ts', content: 'export const inline = 1;\n' },
      { op: 'write', path: 'src/from-source.ts', content: 'export const source = 1;\n' },
      { op: 'delete', path: 'src/old.ts' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P2-11 CLI: manifest refuses ambiguity, extras and Windows-equivalent duplicates', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-cli-refusal-'));
  try {
    const manifest = join(root, 'patch.json');
    writeJson(manifest, {
      version: 1,
      operations: [
        { op: 'write', path: 'src/X.ts', content: 'x' },
        { op: 'delete', path: 'src/x.ts' },
      ],
    });
    assert.throws(() => loadProofPatchManifest(manifest), /Windows-equivalent/);

    writeJson(manifest, {
      version: 1,
      operations: [{ op: 'write', path: 'src/x.ts', content: 'x', source: 'x.ts' }],
    });
    assert.throws(() => loadProofPatchManifest(manifest), /manifest is invalid/);

    writeJson(manifest, {
      version: 1,
      operations: [{ op: 'delete', path: 'src/x.ts', invented: true }],
    });
    assert.throws(() => loadProofPatchManifest(manifest), /manifest is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P2-11 CLI: source files cannot escape the manifest directory physically or lexically', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-cli-source-'));
  try {
    const input = join(root, 'input');
    mkdirSync(input, { recursive: true });
    writeFileSync(join(root, 'secret.txt'), 'secret', 'utf8');
    const manifest = join(input, 'patch.json');
    writeJson(manifest, {
      version: 1,
      operations: [{ op: 'write', path: 'src/x.ts', source: '../secret.txt' }],
    });
    assert.throws(() => loadProofPatchManifest(manifest), /must stay inside/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P2-CLOSURE-01: CLU self-target is admitted only through shadow relocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-cli-self-target-'));
  try {
    assert.doesNotThrow(() => assertProofInstrumentSafe(root, root, 'clu-master'));
    assert.doesNotThrow(() => assertProofInstrumentSafe(root, join(root, 'target'), 'clu-master'));
    assert.doesNotThrow(() => assertProofInstrumentSafe(root, root, 'tree-relative-stick'));

    const shadow = join(root, 'lease');
    mkdirSync(join(shadow, 'config'), { recursive: true });
    mkdirSync(join(shadow, 'targets', 'clu'), { recursive: true });
    const canonicalConfig = stringifyYaml({
      version: 2,
      project: { active_target: 'clu' },
      workspace: { root: join(root, 'workspace') },
      shadow: { root: join(root, 'shadow') },
    });
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'clue.config.yaml'), canonicalConfig);
    writeFileSync(join(shadow, 'config', 'clue.config.yaml'), canonicalConfig);
    const canonicalProfile = stringifyYaml({
      id: 'clu', root, source_roots: ['src'], document_roots: ['.'],
    });
    mkdirSync(join(root, 'targets', 'clu'), { recursive: true });
    writeFileSync(join(root, 'targets', 'clu', 'profile.yaml'), canonicalProfile);
    writeFileSync(join(shadow, 'targets', 'clu', 'profile.yaml'), canonicalProfile);

    const relocated = prepareSelfTargetExecution({
      canonical_repo_root: root,
      canonical_project_root: root,
      shadow_dir: shadow,
      patch_paths: [],
    });
    assert.equal(relocated.self_target, true);
    assert.equal(relocated.runner_repo_root, shadow);
    assert.equal(relocated.instrumentation.length, 2);
    const repeated = prepareSelfTargetExecution({
      canonical_repo_root: root,
      canonical_project_root: root,
      shadow_dir: shadow,
      patch_paths: [],
    });
    assert.deepEqual(
      repeated.instrumentation,
      relocated.instrumentation,
      'persistent lease relocation is reset to canonical bytes and has stable identities',
    );
    const shadowConfig = parseYaml(readFileSync(join(shadow, 'config', 'clue.config.yaml'), 'utf8')) as {
      workspace: { root: string };
      shadow: { root: string };
    };
    const shadowProfile = parseYaml(readFileSync(join(shadow, 'targets', 'clu', 'profile.yaml'), 'utf8')) as {
      root: string;
    };
    assert.equal(shadowProfile.root.replace(/\\/g, '/'), shadow.replace(/\\/g, '/'));
    assert.notEqual(shadowConfig.workspace.root, join(root, 'workspace'));
    assert.notEqual(shadowConfig.shadow.root, join(root, 'shadow'));
    assert.equal(readFileSync(join(root, 'config', 'clue.config.yaml'), 'utf8'), canonicalConfig);

    assert.throws(
      () =>
        prepareSelfTargetExecution({
          canonical_repo_root: root,
          canonical_project_root: root,
          shadow_dir: shadow,
          patch_paths: ['targets/clu/profile.yaml'],
        }),
      /cannot modify relocation authority/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P2-11 CLI: `proof` is one declared mutating, mission-governed command', () => {
  const command = buildProgram().commands.find((entry) => entry.name() === 'proof');
  assert.ok(command !== undefined);
  assert.deepEqual(command.options.map((option) => option.long).sort(), ['--contract', '--patch']);
  assert.deepEqual(authorityFor('proof'), {
    command: 'proof',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      'DEV-P2-11 Stage H: freezes the contract, binds the reusable baseline, executes one ' +
      'isolated candidate and records either the durable refusal or deterministic verdict. ' +
      'The writer lock is held for the complete proof arm. Tree-relative instruments run ' +
      'normally; a CLU-E self-target is measured through shadow-only config/workspace ' +
      'relocation so child clue processes use a distinct writer authority',
  });
});

test('DEV-P2-11 CLI: real command records ACCEPT, derives capabilities, and never edits canonical source', { skip: nativeProofSkipReason() }, async () => {
  const root = writeCliFixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      return 0;
    });

    let snapshot = '' as Sha256;
    let cycleId = '';
    let mission = '';
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const driven = new CycleOrchestrator(runtime).drive();
      cycleId = driven.cycle.id;
      mission = runtime.currentMissionId();
      const recognized = driven.performed.find((step) => step.to === 'RECOGNIZED');
      assert.ok(recognized !== undefined && recognized.evidence !== null);
      snapshot = (runtime.artifacts.getJson(recognized.evidence.hash as never) as { snapshot_id: Sha256 }).snapshot_id;
      return 0;
    });

    const input = join(root, 'proof-input');
    mkdirSync(join(input, 'files'), { recursive: true });
    writeFileSync(join(input, 'files', 'cost.txt'), '80', 'utf8');
    writeJson(join(input, 'contract.json'), proofContract(snapshot, cycleId, mission));
    writeJson(join(input, 'patch.json'), {
      version: 1,
      operations: [{ op: 'write', path: 'src/cost.txt', source: 'files/cost.txt' }],
    });

    const registered = { path: join(root, 'target', 'benchmark', 'stick.md'), registered: true };
    const performed = await performBenchmarkRun({ repoRoot: root, config: loadConfig(root), contract: registered });
    assert.ok(performed.outcome.ok, performed.outcome.ok ? '' : performed.outcome.reason);
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      recordBenchmarkRun(runtime, performed);
      return 0;
    });

    const result = await commandProof(
      { contract: join(input, 'contract.json'), patch: join(input, 'patch.json') },
      root,
      root,
    );
    const refusal = result === 0 ? '' : withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const recorded = runtime.log === null ? undefined : [...runtime.log.replay()]
        .findLast((event) => event.type === PROOF_EVENT_TYPES.executionRefused);
      return recorded === undefined ? '' : JSON.stringify(recorded.payload);
    });
    assert.equal(result, 0, refusal);
    assert.equal(readFileSync(join(root, 'target', 'src', 'cost.txt'), 'utf8'), '100');

    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const log = runtime.log;
      assert.ok(log !== null);
      const proofTail = [...log.replay()].slice(-3);
      assert.deepEqual(proofTail.map((event) => event.type), [
        PROOF_EVENT_TYPES.contractFrozen,
        PROOF_EVENT_TYPES.baselineBound,
        PROOF_EVENT_TYPES.verdictRecorded,
      ]);
      const verdictPayload = proofTail.at(-1)?.payload as {
        great_book?: { state?: string; entry?: { entry_id?: string } };
      };
      assert.equal(verdictPayload.great_book?.state, 'recorded');
      const entries = readGreatBookEntries(runtime.projections, runtime.config.project.id);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.entry_id, verdictPayload.great_book?.entry?.entry_id);
      const facts = readGreatBookFacts(runtime.projections, runtime.config.project.id);
      assert.equal(facts.entryCount, 1);
      assert.equal(facts.contributionCount, 3);
      assert.equal(facts.recordingGapCount, 0);

      const status = projectStatusFromRuntime(runtime, {
        capturedAt: '2026-08-13T20:00:00.000Z',
      }).snapshot;
      assert.equal(status.schemaVersion, '5.8.0');
      assert.equal(status.seal.consistent, true, status.seal.inconsistencies.join('; '));
      assert.equal(isBranchUnavailable(status.greatBook), false);
      assert.equal(isBranchUnavailable(status.improvementField), false);
      if (isBranchUnavailable(status.greatBook) || isBranchUnavailable(status.improvementField)) {
        return 0;
      }
      assert.equal(status.greatBook.entryCount, 1);
      assert.equal(status.greatBook.contributionCount, 3);
      assert.equal(status.greatBook.recordingGapCount, 0);
      const renderedSegments = status.improvementField.cells.reduce(
        (sum, cell) => sum + cell.segments.length,
        0,
      );
      assert.equal(renderedSegments, 3);
      assert.ok(status.capability.backedBranches.includes('greatBook'));
      assert.equal(status.capability.unsupportedBranches.includes('greatBook' as never), false);
      return 0;
    });

    // Capability honesty: there is no CLI flag that can promote an unavailable instrument.
    writeJson(join(input, 'contract-unavailable.json'), {
      ...proofContract(snapshot, cycleId, mission),
      required_instruments: ['gateway:nonexistent'],
    });
    const beforeRefusal = withRuntime(
      { withLog: true, repoRoot: root },
      (runtime) => runtime.log === null ? -1 : [...runtime.log.replay()].length,
    );
    const refused = await commandProof(
      { contract: join(input, 'contract-unavailable.json'), patch: join(input, 'patch.json') },
      root,
      root,
    );
    assert.equal(refused, 1);
    const afterRefusal = withRuntime(
      { withLog: true, repoRoot: root },
      (runtime) => runtime.log === null ? -1 : [...runtime.log.replay()].length,
    );
    assert.equal(afterRefusal, beforeRefusal, 'freeze refusal records no event because no frozen authority exists');
  } finally {
    rmSync(dirname(root), { recursive: true, force: true, maxRetries: 3 });
  }
});
