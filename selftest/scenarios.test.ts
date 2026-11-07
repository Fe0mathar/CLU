/**
 * Scenario engine acceptance (DEV-P2-10, Stage G2; Execution Model §7–§8).
 *
 * The pins, in the order they matter:
 *
 * **The capture grammar is the live corpus.** Every stderr shape asserted here was first
 * captured from a real Node 22 child during the build (2026-08-11) — the folded
 * multi-frame TypeError, the `(node:pid) DeprecationWarning` with its trace-hint
 * continuation, both frame forms, Windows drive paths split from the right, the
 * `Promise.all (index 1)` location-less frame, `file://` URLs, orphan frame blocks that
 * synthesize their missing head rather than dropping evidence, and CRLF tolerance.
 *
 * **The source-map hop is proven against a real compiler, not a fixture of one.** The
 * suite runs the repository's own `tsc --sourceMap` over a tiny source, then attributes a
 * frame into the *generated* line and asserts the *original* unit — zero-based both ways,
 * exactly as `node:module`'s `SourceMap` was measured to speak. A `.js` frame with no
 * readable map stays unattributed with that stated; a blind `dist/→src/` rewrite does
 * not exist to be tested.
 *
 * **One authority, three states.** `observedSummaries()` is the family's supply contract:
 * `null` before any session (never exercised — a stated absence), `[]` after a quiet
 * session (exercised and silent — evidence of the opposite kind), a list once something
 * was seen. The two consumers are pinned through the cycle's own screening evidence.
 *
 * **The G1→G2 arc is the finding, closed.** Cycle 1 screens static-only and *says so*
 * ("Stage G1 static", `observedDefect` among the unavailable families); scenarios run —
 * a failing script still ingests, dedup makes the second sighting a property, the Node
 * attributor lands the signature on the recognized unit and classification promotes it
 * to actionable; cycle 2's screening then records `observed_evidence: true` with the
 * family available and the ranking's `observedEvidenceAvailable` flipped — the "zero
 * patch candidates honestly, because screening was static-only" state now has its
 * remedy on the standard path, and this file keeps it there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

import {
  captureProcessOutput,
  captureStream,
  classifyLevel,
  parseFrameLocation,
  parseStackFrameLine,
} from '../src/analysis/scenarios/nodeConsoleCapture.js';
import {
  frameUrlToPath,
  makeNodeAttributor,
  relativeUnder,
  unitAt,
} from '../src/analysis/scenarios/nodeAttributor.js';
import {
  parseScriptCommand,
  runScenarios,
  scenariosFromConfig,
} from '../src/analysis/scenarios/scenarioRunner.js';
import {
  loadConfig as loadRuntimeConfig,
  withRuntime,
  withRuntimeAsync,
} from '../src/control/runtime.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { computeAllMetrics } from '../src/analysis/metrics/families.js';
import { NO_ATTRIBUTION } from '../src/experiment/console/consoleLedger.js';
import type { SourceUnit } from '../src/analysis/source/graph.js';
import type { ClueConfig } from '../src/shared/schemas.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/* ========================================================================= */
/* Fixture helpers                                                            */
/* ========================================================================= */

function unit(
  logicalId: string,
  kind: SourceUnit['kind'],
  path: string,
  startLine: number,
  endLine: number,
  byteLength: number,
): SourceUnit {
  return {
    logicalId,
    versionHash: 'v'.repeat(64) as SourceUnit['versionHash'],
    kind,
    name: logicalId,
    qualifiedName: logicalId,
    modulePath: path,
    exported: true,
    anchor: { path, startLine, endLine, startByte: startLine * 10, endByte: endLine * 10 },
    parentLogicalId: null,
    lineCount: endLine - startLine + 1,
    byteLength,
    isAsync: false,
    parameterCount: null,
  };
}

const REAL_STACK = [
  'TypeError: bad',
  '    at boom ([eval]:2:24)',
  '    at [eval]:3:7',
  '    at runScriptInThisContext (node:internal/vm:209:10)',
].join('\n');

/** The full installation fixture the runner and wiring tests drive. */
function writeG2Fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-g2-'));
  writeFileSync(join(root, 'CLUE.md'), '# CLUE\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'g2-fixture', private: true }));
  mkdirSync(join(root, 'murugan', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'murugan', 'src', 'hello.ts'),
    'export function hello(name: string): string {\n  return name;\n}\n',
  );
  writeFileSync(
    join(root, 'murugan', 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }),
  );
  writeFileSync(join(root, 'murugan', 'target description.md'), '# intent\n');
  // The probe: a real child whose stderr frames land inside the recognized unit's anchor.
  writeFileSync(
    join(root, 'murugan', 'probe.js'),
    [
      'console.error(`TypeError: greeting exploded',
      '    at hello (src/hello.ts:2:10)',
      '    at main (probe.js:1:1)`);process.exit(1);',
    ].join('\n'),
  );
  mkdirSync(join(root, 'config', 'policies'), { recursive: true });
  writeFileSync(join(root, 'config', 'policies', 'patching.yaml'), 'mode: NOTIFY\n');
  const config = {
    version: 2,
    project: {
      id: 'murugan',
      root: join(root, 'murugan'),
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
      inputs: { description: 'target description.md', benchmark: null },
    },
    workspace: { root: join(root, 'workspace') },
    shadow: {
      root: join(root, 'shadow'),
      clone_mode: 'local',
      persistent: true,
      install_on_lockfile_change: true,
      install_command: 'npm ci',
    },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md'] },
    runtime: {
      package_manager: 'npm',
      scripts: {
        typecheck: 'npm run typecheck',
        build: 'npm run build',
        quoted: 'echo "needs a shell"',
      },
    },
    browser: {
      executable: join(root, 'chrome.exe'),
      remote_debugging_port: 9222,
      profile_dir: join(root, 'chrome-profile'),
      allowed_origins: ['http://localhost:*'],
      require_webgpu: true,
    },
    powershell: { executable: 'pwsh.exe', autonomous_profile: 'restricted' },
    analysis: {
      max_context_tokens: 120000,
      reserve_output_tokens: 20000,
      dynamic_edge_confidence_threshold: 0.75,
      monodependency_percentile: 0.35,
    },
    proof: {
      require_frozen_contract: true,
      inconclusive_counts_as_improvement: false,
      require_baseline: true,
      require_guardrails: true,
    },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: {
      mode: 'NOTIFY',
      policy_file: 'config/policies/patching.yaml',
      landing_branch_prefix: 'clue/accepted/',
      merge_strategy: 'fast_forward_only',
      post_land_verify: ['typecheck'],
      auto_revert_on_post_land_failure: true,
    },
    notifications: { status_document: true, windows_toast: false, webhook_url_env: null },
    gateway: {
      enabled: false,
      provider: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_mode: 'batch',
      batch_poll_interval_seconds: 300,
      prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] },
      budget_policy_file: 'config/policies/budget.yaml',
      routing_file: 'config/policies/routing.yaml',
    },
    backup: { remote: 'origin', push_on_verdict: true, push_on_landing: true, max_remote_staleness_hours: 24 },
    security: { canonical_source_writes: 'denied', real_settlement: 'denied', redact_environment: true },
    logging: { level: 'info' },
  };
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'clue.config.yaml'), stringifyYaml(config));
  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(root, 'workspace', directory), { recursive: true });
  }
  return root;
}

/* ========================================================================= */
/* Capture grammar — the live corpus, codified                                */
/* ========================================================================= */

test('G2 capture: a real multi-frame error folds into one entry with its frames', () => {
  const entries = captureStream({ stream: 'stderr', text: REAL_STACK }, { timestamp: 't' });
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.level, 'error');
  assert.equal(entry.frames.length, 3);
  assert.deepEqual(entry.frames[0], { url: '[eval]', line: 2, column: 24, functionName: 'boom' });
  assert.deepEqual(entry.frames[1], { url: '[eval]', line: 3, column: 7, functionName: null });
});

test('G2 capture: warning heads, the trace-hint continuation, and stream defaults', () => {
  const text = [
    '(node:5052) DeprecationWarning: legacy API used',
    '(Use `node --trace-deprecation ...` to show where the warning was created)',
    'plain stderr line',
  ].join('\n');
  const entries = captureStream({ stream: 'stderr', text }, { timestamp: 't' });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.level, 'warning');
  assert.ok(entries[0]?.text.includes('--trace-deprecation'), 'the hint folds into its warning');
  assert.equal(entries[1]?.level, 'info', 'bare stderr carries no level; claiming one would be invention');
  assert.equal(captureStream({ stream: 'stdout', text: 'x' }, { timestamp: 't' })[0]?.level, 'log');
  assert.equal(classifyLevel('AssertionError: nope', 'stdout'), 'error');
});

test('G2 capture: frame grammar — windows drive, promise index, file URL, bare form', () => {
  assert.deepEqual(parseStackFrameLine('    at go (C:\\x\\y.js:3:5)'), {
    url: 'C:\\x\\y.js',
    line: 3,
    column: 5,
    functionName: 'go',
  });
  assert.deepEqual(parseStackFrameLine('    at Promise.all (index 1)'), {
    url: 'index 1',
    line: 0,
    column: 0,
    functionName: 'Promise.all',
  });
  assert.deepEqual(parseStackFrameLine('    at file:///a/b.js:10:2'), {
    url: 'file:///a/b.js',
    line: 10,
    column: 2,
    functionName: null,
  });
  assert.equal(parseFrameLocation('no-location-here'), null);
});

test('G2 capture: an orphan frame block synthesizes its head — evidence is never dropped', () => {
  const entries = captureStream(
    { stream: 'stderr', text: '    at lost (src/x.ts:4:1)\r\n    at src/x.ts:9:2\r\n' },
    { timestamp: 't', scenarioId: 'SCN' },
  );
  assert.equal(entries.length, 1);
  assert.match(entries[0]?.text ?? '', /stack continuation/);
  assert.equal(entries[0]?.frames.length, 2, 'CRLF-tolerant, both frames kept');
  assert.equal(entries[0]?.scenarioId, 'SCN');
});

test('G2 capture: streams are captured in declared order, not an invented interleaving', () => {
  const entries = captureProcessOutput(
    [
      { stream: 'stdout', text: 'out line' },
      { stream: 'stderr', text: 'err line' },
    ],
    { timestamp: 't' },
  );
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['out line', 'err line'],
  );
});

/* ========================================================================= */
/* Attribution                                                                */
/* ========================================================================= */

test('G2 attribution: the source-map hop, against tsc itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-hop-'));
  try {
    writeFileSync(
      join(dir, 'thing.ts'),
      'export function alpha(x: number): number {\n  const y = x + 1;\n  return y * 2;\n}\n',
    );
    const compiled = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--sourceMap', '--outDir', join(dir, 'dist'), join(dir, 'thing.ts')],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);

    const units = [unit('thing#module', 'module', 'thing.ts', 1, 4, 400), unit('thing#alpha', 'function', 'thing.ts', 1, 4, 120)];
    const attributor = makeNodeAttributor({ projectRoot: dir, units });
    // Generated line 5 is `var y = x + 1;` (measured); the original is thing.ts line 2.
    const verdict = attributor({
      level: 'error',
      text: 'x',
      frames: [{ url: join(dir, 'dist', 'thing.js'), line: 5, column: 9, functionName: 'alpha' }],
      timestamp: 't',
    });
    assert.equal(verdict.outcome, 'attributed');
    assert.equal(verdict.logicalId, 'thing#alpha');
    assert.equal(verdict.path, 'thing.ts');
    assert.equal(verdict.line, 2);
    assert.match(verdict.detail, /source map: dist\/thing\.js:5 → thing\.ts:2/);

    // The same generated file, its map removed: unattributed with the absence stated —
    // there is no blind dist→src rewrite to fall back on.
    rmSync(join(dir, 'dist', 'thing.js.map'));
    const noMap = makeNodeAttributor({ projectRoot: dir, units })({
      level: 'error',
      text: 'x',
      frames: [{ url: join(dir, 'dist', 'thing.js'), line: 5, column: 9, functionName: 'alpha' }],
      timestamp: 't',
    });
    assert.equal(noMap.outcome, 'unattributable');
    assert.match(noMap.detail, /no readable source map/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('G2 attribution: sourceMappingURL file references resolve through the injected reader', () => {
  const files = new Map<string, string>([
    [
      '/r/out/a.js',
      'code();\ncode();\n//# sourceMappingURL=maps/a.map\n',
    ],
    [
      '/r/out/maps/a.map',
      JSON.stringify({ version: 3, sources: ['../../src/a.ts'], names: [], mappings: 'AAAA;AACA' }),
    ],
  ]);
  const attributor = makeNodeAttributor({
    projectRoot: '/r',
    units: [unit('a#module', 'module', 'src/a.ts', 1, 10, 100)],
    readTextFile: (path) => files.get(path.replace(/\\/g, '/')) ?? null,
  });
  const verdict = attributor({
    level: 'error',
    text: 'x',
    frames: [{ url: '/r/out/a.js', line: 2, column: 1, functionName: null }],
    timestamp: 't',
  });
  assert.equal(verdict.outcome, 'attributed');
  assert.equal(verdict.logicalId, 'a#module');
  assert.match(verdict.detail, /source map: out\/a\.js:2 → src\/a\.ts:2/);
});

test('G2 attribution: innermost span wins; between declarations, the module unit is named', () => {
  const byPath = new Map([
    [
      'src/o.ts',
      [
        unit('o#module', 'module', 'src/o.ts', 1, 50, 500),
        unit('o#outer', 'class', 'src/o.ts', 10, 40, 400),
        unit('o#outer.inner', 'method', 'src/o.ts', 20, 30, 100),
      ],
    ],
  ]);
  assert.equal(unitAt(byPath, 'src/o.ts', 25)?.unit.logicalId, 'o#outer.inner');
  assert.equal(unitAt(byPath, 'src/o.ts', 45)?.unit.logicalId, 'o#module');
  assert.equal(unitAt(byPath, 'src/o.ts', 45)?.containment, 'enclosing', 'the module unit spans the file');

  // The genuine fallback: a module unit that does not span the line.
  const partial = new Map([['src/m.ts', [unit('m#module', 'module', 'src/m.ts', 1, 10, 100), unit('m#fn', 'function', 'src/m.ts', 3, 6, 30)]]]);
  const fallback = unitAt(partial, 'src/m.ts', 15);
  assert.equal(fallback?.unit.logicalId, 'm#module');
  assert.equal(fallback?.containment, 'module-fallback');
});

test('G2 attribution: external, internals-only, no-frames, and the two gap wordings', () => {
  const attributor = makeNodeAttributor({
    projectRoot: '/r',
    units: [unit('lone#fn', 'function', 'src/lone.ts', 10, 20, 50)],
  });
  const entry = (frames: readonly { url: string; line: number; column: number; functionName: string | null }[]) => ({
    level: 'error' as const,
    text: 'x',
    frames,
    timestamp: 't',
  });

  const external = attributor(entry([{ url: '/r/node_modules/zod/lib/index.js', line: 5, column: 1, functionName: null }]));
  assert.equal(external.outcome, 'external');
  assert.equal(external.path, 'node_modules/zod/lib/index.js');

  const outside = attributor(entry([{ url: '/elsewhere/x.js', line: 3, column: 1, functionName: null }]));
  assert.equal(outside.outcome, 'external');

  const internals = attributor(
    entry([
      { url: 'node:internal/process', line: 1, column: 1, functionName: null },
      { url: '[eval]', line: 3, column: 4, functionName: null },
    ]),
  );
  assert.equal(internals.outcome, 'unattributable');
  assert.match(internals.detail, /internal or location-less/);

  assert.equal(attributor(entry([])).detail, 'the entry carries no stack frames');

  const gap = attributor(entry([{ url: '/r/src/lone.ts', line: 5, column: 1, functionName: null }]));
  assert.match(gap.detail, /sits in no declared span and the file has no module unit/);
  const unknown = attributor(entry([{ url: '/r/src/never.ts', line: 5, column: 1, functionName: null }]));
  assert.match(unknown.detail, /no unit anchors this path/);
});

test('G2 attribution: windows roots and file URLs normalise textually', () => {
  assert.equal(relativeUnder('F:/CLU/CLU', 'F:\\CLU\\CLU\\dist\\src\\a.js'), 'dist/src/a.js');
  assert.equal(relativeUnder('/r', '/elsewhere/x'), null);
  assert.equal(frameUrlToPath('file:///C:/x/y.js'), 'C:/x/y.js');
  assert.equal(frameUrlToPath('node:internal/vm'), null);
  assert.equal(frameUrlToPath('index 1'), null);
});

/* ========================================================================= */
/* The governed scenario source                                               */
/* ========================================================================= */

test('G2 scenarios: runtime.scripts is the governed set; shell syntax refuses by name', () => {
  const config = {
    runtime: {
      scripts: { zeta: 'node z.js', alpha: 'node a.js one two', quoted: 'echo "x"', piped: 'a | b' },
    },
  } as unknown as ClueConfig;
  const { scenarios, skipped } = scenariosFromConfig(config);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    ['alpha', 'zeta'],
    'name-sorted for a stable run order',
  );
  assert.deepEqual(scenarios[0]?.argv, ['node', 'a.js', 'one', 'two']);
  assert.deepEqual(skipped.map((entry) => entry.id).sort(), ['piped', 'quoted']);
  assert.match(skipped[0]?.reason ?? '', /shell syntax/);
});

test('P2-ZIP-03 scenarios: direct CLU-E child shapes are refused before execution', () => {
  const refused = [
    'clue proof --contract c.json --patch p.json',
    'clue.cmd status report',
    'node dist/src/cli/index.js status report',
    'node F:/CLU/CLU/dist/src/cli/index.js cycle drive',
    'npm run clue -- status report',
    'npm run-script clue',
    'npm exec clue status report',
    'npx clue status report',
    'pnpm exec clue status report',
    'yarn clue status report',
    'bunx clue status report',
  ];

  for (const [index, command] of refused.entries()) {
    const parsed = parseScriptCommand(`blocked-${index}`, command);
    assert.ok('reason' in parsed, `expected direct CLU-E shape to be refused: ${command}`);
    assert.match(parsed.reason, /invokes clue directly.*writer lock.*deadlock/);
  }

  const selftest = parseScriptCommand('selftest', 'npm run selftest');
  assert.ok(!('reason' in selftest));
  assert.deepEqual(selftest.argv, ['npm', 'run', 'selftest']);
});

test('P2-ZIP-03 scenarios: shipped governed set is finite build/selftest/typecheck', () => {
  const config = loadRuntimeConfig(REPO_ROOT);
  const { scenarios, skipped } = scenariosFromConfig(config);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    ['build', 'selftest', 'typecheck'],
  );
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.argv),
    [
      ['npm', 'run', 'build'],
      ['npm', 'run', 'selftest'],
      ['npm', 'run', 'typecheck'],
    ],
  );
  assert.ok(
    !scenarios.some((scenario) => scenario.id === 'dev'),
    'the long-lived development server is not governed evidence',
  );
});

/* ========================================================================= */
/* The three-state supply contract, without a drive                           */
/* ========================================================================= */

test('G2 supply: observedSummaries — null before any session, [] after a quiet one', () => {
  const root = writeG2Fixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      const before = runtime.requireConsole().observedSummaries();
      assert.equal(before, null, 'never exercised is a stated absence, not an empty list');

      const ledger = runtime.makeConsoleLedger(NO_ATTRIBUTION);
      const session = ledger.beginSession({ scenarioId: 'quiet', origin: 'shadow' });
      ledger.ingest(session.id, []);
      assert.deepEqual(
        runtime.requireConsole().observedSummaries(),
        [],
        'exercised and silent is evidence of the opposite kind',
      );
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* ========================================================================= */
/* The runner and the G1→G2 arc — one full fixture, driven twice              */
/* ========================================================================= */

test('G2 arc: static screening stated, scenarios ingested, observed screening real', async () => {
  const root = writeG2Fixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      return 0;
    });

    // Cycle 1: Stage G1, and the record says so.
    let snapshotId = '';
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      const driven = orchestrator.drive();
      const screened = driven.performed.find((step) => step.to === 'SCREENED');
      assert.ok(screened !== undefined && screened.evidence !== null);
      const body = runtime.artifacts.getJson(screened.evidence.hash as never) as {
        observed_evidence: boolean;
        observed_signatures: number;
        families_unavailable: readonly string[];
      };
      assert.equal(body.observed_evidence, false);
      assert.equal(body.observed_signatures, 0);
      assert.ok(body.families_unavailable.includes('observedDefect'));
      assert.match(screened.summary, /Stage G1 static/);

      const recognized = driven.performed.find((step) => step.to === 'RECOGNIZED');
      assert.ok(recognized !== undefined && recognized.evidence !== null);
      snapshotId = (runtime.artifacts.getJson(recognized.evidence.hash as never) as { snapshot_id: string }).snapshot_id;
      orchestrator.close(null);
      return 0;
    });

    // The runner refuses a snapshot with no committed recognition, by name.
    await withRuntimeAsync({ withLog: true, repoRoot: root }, async (runtime) => {
      await assert.rejects(
        runScenarios({ runtime, snapshotId: 'f'.repeat(64), scenarios: [] }),
        /run `clue recognize` before scenarios/,
      );
      return 0;
    });

    // Scenarios: a failing script still ingests; the second sighting is a property.
    await withRuntimeAsync({ withLog: true, repoRoot: root }, async (runtime) => {
      const result = await runScenarios({
        runtime,
        snapshotId,
        defaultTimeoutSeconds: 60,
        scenarios: [
          { id: 'probe-a', argv: ['node', 'probe.js'] },
          { id: 'probe-b', argv: ['node', 'probe.js'] },
        ],
      });
      assert.equal(result.receipts.length, 2);
      const [first, second] = result.receipts;
      assert.equal(first?.exit_code, 1, 'a failing script is evidence, not an abort');
      assert.equal(first?.entries_ingested, 1, 'head plus frames folded into one entry');
      assert.equal(first?.new_signatures, 1);
      assert.equal(second?.new_signatures, 0, 'deduplicated across sessions');
      assert.deepEqual(result.skipped, [], 'an explicit scenario set carries no config-derived skips (those are pinned on scenariosFromConfig)');

      const summaries = runtime.requireConsole().observedSummaries();
      assert.ok(summaries !== null);
      const signature = summaries.find((entry) => entry.attributedTo !== null);
      assert.ok(signature !== undefined, 'the Node attributor landed it on a recognized unit');
      assert.equal(signature.attributedTo, 'src/hello.ts#hello');
      assert.equal(signature.level, 'error');
      assert.equal(signature.scenarioCount, 2, 'reproduced in several scenarios is a property');
      assert.equal(signature.classification, 'actionable');

      // The family itself, fed by the same supply: observed and non-zero.
      const stored = runtime.requireGraph().resultOf(snapshotId);
      assert.ok(stored !== null);
      const set = computeAllMetrics({
        snapshotId,
        units: stored.units,
        edges: stored.edges,
        classifications: runtime.requireGraph().classify(snapshotId, { only: [] }),
        coverage: runtime.requireGraph().coverage(snapshotId),
        consoleSignatures: summaries,
      });
      const value = set.byUnit.get('src/hello.ts#hello')?.get('observedDefect');
      assert.ok(value !== undefined && value.available && value.raw > 0);
      assert.equal(value.evidence, 'observed');
      return 0;
    });

    // Cycle 2: the standard screening path now carries the observed evidence.
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const driven = new CycleOrchestrator(runtime).drive();
      const screened = driven.performed.find((step) => step.to === 'SCREENED');
      assert.ok(screened !== undefined && screened.evidence !== null);
      const body = runtime.artifacts.getJson(screened.evidence.hash as never) as {
        observed_evidence: boolean;
        observed_signatures: number;
        families_unavailable: readonly string[];
      };
      assert.equal(body.observed_evidence, true);
      assert.equal(body.observed_signatures, 1);
      assert.deepEqual(body.families_unavailable, []);
      assert.match(screened.summary, /1 observed signature\(s\) \(Stage G2\)/);
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
