import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse, stringify } from 'yaml';

import { PACK_MANIFEST_FILE, PACK_SEAL_FILE } from '../src/control/mission.js';
import { withRuntime, withRuntimeAsync } from '../src/control/runtime.js';
import { readCurrentCycleAuthority } from '../src/cycle/cycleAuthority.js';
import { computeInputLock } from '../src/cycle/cycleInputLock.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { CycleRegistry } from '../src/cycle/cycleRegistry.js';
import { hashBytes, hashText } from '../src/shared/ids.js';
import { writeProfileRuntimeInstallation, writeRecognitionTarget } from './project-recognition-fixture.js';

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-current-cycle-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  writeProfileRuntimeInstallation(root);
  const target = join(root, 'legacy-target');
  writeRecognitionTarget(target, 'fixture');
  writeFileSync(join(target, 'target.md'), '# Target\n');
  writeFileSync(join(target, 'benchmark.md'), '# Benchmark\n');
  const configPath = join(root, 'config', 'clue.config.yaml');
  const config = parse(readFileSync(configPath, 'utf8'));
  config.project.inputs = { description: 'target.md', benchmark: 'benchmark.md' };
  config.gateway.enabled = true;
  writeFileSync(configPath, stringify(config));
  for (const path of [
    'config/measurements/catalogue.yaml', 'config/policies/equilibrium.yaml', 'config/policies/patching.yaml',
    'config/policies/budget.yaml', 'config/policies/routing.yaml', 'config/policies/p2-closure.yaml',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(process.cwd(), path), join(root, path));
  }
  const manifest = '{"permanentFiles":[]}\n';
  writeFileSync(join(root, PACK_MANIFEST_FILE), manifest);
  writeFileSync(join(root, PACK_SEAL_FILE),
    `${hashBytes(readFileSync(join(root, 'CLUE.md')))}  CLUE.md\n${hashText(manifest)}  ${PACK_MANIFEST_FILE}\n`);
  writeFileSync(join(root, 'package.json'), '{"files":["src"]}\n');
  return root;
}

test('a successor manifest mission needs its own ratification and epoch before a cycle can lock authority', (t) => {
  const repoRoot = fixture(t);
  withRuntime({ repoRoot, withLog: true }, (runtime) => {
    const registry = runtime.mission;
    assert.ok(registry);
    const log = runtime.requireLog();
    const original = registry.bootstrap().mission;
    const priorRatification = registry.ratifyInstalledAuthority({ statement: 'RATIFY INITIAL' });
    const priorEpoch = registry.sealEpoch({ epochName: 'initial', statement: 'SEAL INITIAL' });
    assert.deepEqual(readCurrentCycleAuthority(log.replay(), original.id), { ratification: priorRatification, epoch: priorEpoch });

    writeFileSync(join(repoRoot, 'package.json'), '{"files":["LICENSE","src"]}\n');
    const current = registry.bootstrap().mission;
    assert.notEqual(current.id, original.id);
    assert.deepEqual(readCurrentCycleAuthority(log.replay(), current.id), { ratification: null, epoch: null });
    const driven = new CycleOrchestrator(runtime).drive();
    assert.equal(driven.cycle.stage, 'SCREENED');
    assert.equal(driven.cycle.grade, 'diagnostic');
    assert.deepEqual(driven.lock?.absent, ['epoch (clue epoch seal)', 'ratification (clue docs ratify)']);

    const nextRatification = registry.ratifyInstalledAuthority({ statement: 'RATIFY SUCCESSOR' });
    assert.deepEqual(readCurrentCycleAuthority(log.replay(), current.id), { ratification: nextRatification, epoch: null });
    const nextEpoch = registry.sealEpoch({ epochName: 'successor', statement: 'SEAL SUCCESSOR' });
    assert.deepEqual(readCurrentCycleAuthority(log.replay(), current.id), { ratification: nextRatification, epoch: nextEpoch });
    assert.deepEqual(registry.epoch(priorEpoch.epoch_name), priorEpoch);
  });
});

test('the candidate arm refuses a historical proof grade carried by another mission’s authority', async (t) => {
  const repoRoot = fixture(t);
  await withRuntimeAsync({ repoRoot, withLog: true }, async (runtime) => {
    const registry = runtime.mission;
    assert.ok(registry);
    const log = runtime.requireLog();
    registry.bootstrap();
    registry.ratifyInstalledAuthority({ statement: 'RATIFY OLD' });
    registry.sealEpoch({ epochName: 'old', statement: 'SEAL OLD' });
    writeFileSync(join(repoRoot, 'package.json'), '{"files":["LICENSE","src"]}\n');
    const mission = registry.bootstrap().mission;
    const legacyLock = computeInputLock({ repoRoot, config: runtime.config, mission,
      ratification: registry.ratification(), epoch: registry.latestEpoch() });
    assert.equal(legacyLock.grade, 'proof-authoritative');
    const cycles = new CycleRegistry({ log, projections: runtime.projections, missionVersion: () => mission.id });
    const { id: cycleId } = cycles.open();
    cycles.lockInputs(cycleId, legacyLock);
    cycles.advance(cycleId, 'OPENING_EVIDENCE', null);
    cycles.advance(cycleId, 'RECOGNIZED', null);
    cycles.advance(cycleId, 'SCREENED', null);
    const before = log.verify().head;

    const candidate = await new CycleOrchestrator(runtime).candidate({ contract: {}, capabilities: [], patch: [] });
    assert.ok(!candidate.ok && candidate.stage === 'freeze');
    assert.match(candidate.reasons[0] ?? '', /current mission ratification and evidence epoch/u);
    assert.deepEqual(log.verify().head, before);
  });
});
