/** Project-scoped practical runtime for the distinguished Master Benchmark. */

import { badge, escapeHtml, fieldGroup, fieldMeta, fieldShell, lineText, sectionHeader, stateLine, textarea, textInput } from './viewPrimitives.js';

export function renderBenchmarkRuntimeEditor(snapshot) {
  const runtime = snapshot.draft?.benchmarkRuntime;
  if (!runtime) {
    return `<section class="cfg-card" data-section="benchmark-runtime">${sectionHeader({ kicker: 'BENCHMARK RUNTIME', title: 'How the benchmark is run' })}<p class="cfg-empty-copy">Create or select a Project Profile to set how its Master Benchmark is executed.</p></section>`;
  }
  const validation = snapshot.validation?.benchmarkRuntime;
  const state = validation?.state ?? 'UNVALIDATED';
  const field = (path, spec) => fieldShell({ ...spec, ...fieldMeta(snapshot, path) });
  return `<section class="cfg-card" data-section="benchmark-runtime">
    ${sectionHeader({
      kicker: 'BENCHMARK RUNTIME',
      title: 'How the Master Benchmark is run',
      description: 'The practical side of measurement: which command runs, how many times, and for how long. Where the Master Benchmark document already defines one of these, the values must agree.',
      badges: badge(state),
    })}
    ${stateLine(validation?.state)}
    ${fieldGroup({
      title: 'Command',
      body: `<div class="cfg-form-grid">
        ${fieldShell({ label: 'Working Directory', wide: true, control: `<input value="${escapeHtml(runtime.workingDirectory ?? '')}" readonly />`, note: 'Bound to Target Root.' })}
        ${field('benchmarkRuntime.command', { label: 'Benchmark Command', wide: true, control: textInput('benchmarkRuntime.command', runtime.command ?? '', { placeholder: 'npm run benchmark:recognizer' }), note: 'Leave empty when the Master Benchmark’s own harness runs everything.' })}
        ${field('benchmarkRuntime.scenario', { label: 'Scenario', control: textInput('benchmarkRuntime.scenario', runtime.scenario ?? '', { placeholder: 'recognizer-hotspot-v1' }), note: 'Optional scenario name passed to the command.' })}
        ${field('benchmarkRuntime.additionalRuntimeArgs', { label: 'Additional Runtime Args', control: textarea('benchmarkRuntime.additionalRuntimeArgs', lineText(runtime.additionalRuntimeArgs), { kind: 'lines', rows: 3, placeholder: '--flag\n--another=value' }), note: 'One argument per line.' })}
      </div>`,
    })}
    ${fieldGroup({
      title: 'Repetition',
      description: 'More repetitions give steadier numbers and take longer.',
      body: `<div class="cfg-form-grid is-three">
        ${field('benchmarkRuntime.warmupRuns', { label: 'Warm-up Runs', control: textInput('benchmarkRuntime.warmupRuns', runtime.warmupRuns ?? 1, { type: 'number', min: 0 }), note: 'Runs discarded before measuring. 0 or more.' })}
        ${field('benchmarkRuntime.repetitions', { label: 'Repetitions', control: textInput('benchmarkRuntime.repetitions', runtime.repetitions ?? 3, { type: 'number', min: 1 }), note: 'Measured runs. At least 1.' })}
        ${field('benchmarkRuntime.timeoutSeconds', { label: 'Timeout Seconds', control: textInput('benchmarkRuntime.timeoutSeconds', runtime.timeoutSeconds ?? 600, { type: 'number', min: 1 }), note: 'A run that exceeds this is stopped and counted as failed.' })}
      </div>`,
    })}
    ${fieldGroup({
      title: 'Browser benchmark',
      description: 'Only needed when the benchmark measures a page in the test browser. Leave empty otherwise.',
      body: `<div class="cfg-form-grid">
        ${field('benchmarkRuntime.targetUrl', { label: 'Target URL', control: textInput('benchmarkRuntime.targetUrl', runtime.targetUrl ?? '', { placeholder: 'optional browser benchmark URL' }) })}
        ${field('benchmarkRuntime.browserProfile', { label: 'Browser Profile', control: textInput('benchmarkRuntime.browserProfile', runtime.browserProfile ?? '', { placeholder: 'optional absolute profile path' }) })}
        ${fieldShell({ label: 'Resolution Width', control: textInput('benchmarkRuntime.resolution.width', runtime.resolution?.width ?? '', { type: 'number', min: 1 }), ...fieldMeta(snapshot, 'benchmarkRuntime.resolution'), path: 'benchmarkRuntime.resolution.width' })}
        ${fieldShell({ label: 'Resolution Height', control: textInput('benchmarkRuntime.resolution.height', runtime.resolution?.height ?? '', { type: 'number', min: 1 }), modified: fieldMeta(snapshot, 'benchmarkRuntime.resolution').modified, path: 'benchmarkRuntime.resolution.height', note: 'Set both width and height, or neither.' })}
      </div>`,
    })}
    <p class="cfg-note">Where the Master Benchmark defines the runtime, duplicated values must remain consistent. Browser readiness becomes required only when this scenario actually needs it.</p>
  </section>`;
}
