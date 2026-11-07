/** Project-scoped practical runtime for the distinguished Master Benchmark. */

import { badge, fieldShell, lineText, textarea, textInput } from './viewPrimitives.js';

export function renderBenchmarkRuntimeEditor(snapshot) {
  const runtime = snapshot.draft?.benchmarkRuntime;
  if (!runtime) return '';
  const validation = snapshot.validation?.benchmarkRuntime;
  const state = validation?.state ?? 'UNVALIDATED';
  return `<section class="cfg-card" data-section="benchmark-runtime">
    <header class="cfg-card-head"><div><span class="cfg-kicker">BENCHMARK RUNTIME</span><h3>Repeatable measurement execution</h3></div>${badge(state)}</header>
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'Working Directory', wide: true, control: `<input value="${String(runtime.workingDirectory ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" readonly />`, note: 'Bound to Target Root.' })}
      ${fieldShell({ label: 'Benchmark Command', wide: true, control: textInput('benchmarkRuntime.command', runtime.command ?? '', { placeholder: 'npm run benchmark:recognizer' }) })}
      ${fieldShell({ label: 'Scenario', control: textInput('benchmarkRuntime.scenario', runtime.scenario ?? '', { placeholder: 'recognizer-hotspot-v1' }) })}
      ${fieldShell({ label: 'Warm-up Runs', control: textInput('benchmarkRuntime.warmupRuns', runtime.warmupRuns ?? 1, { type: 'number', min: 0 }) })}
      ${fieldShell({ label: 'Repetitions', control: textInput('benchmarkRuntime.repetitions', runtime.repetitions ?? 3, { type: 'number', min: 1 }) })}
      ${fieldShell({ label: 'Timeout Seconds', control: textInput('benchmarkRuntime.timeoutSeconds', runtime.timeoutSeconds ?? 600, { type: 'number', min: 1 }) })}
      ${fieldShell({ label: 'Target URL', control: textInput('benchmarkRuntime.targetUrl', runtime.targetUrl ?? '', { placeholder: 'optional browser benchmark URL' }) })}
      ${fieldShell({ label: 'Browser Profile', control: textInput('benchmarkRuntime.browserProfile', runtime.browserProfile ?? '', { placeholder: 'optional absolute profile path' }) })}
      ${fieldShell({ label: 'Resolution Width', control: textInput('benchmarkRuntime.resolution.width', runtime.resolution?.width ?? '', { type: 'number', min: 1 }) })}
      ${fieldShell({ label: 'Resolution Height', control: textInput('benchmarkRuntime.resolution.height', runtime.resolution?.height ?? '', { type: 'number', min: 1 }) })}
      ${fieldShell({ label: 'Additional Runtime Args', wide: true, control: textarea('benchmarkRuntime.additionalRuntimeArgs', lineText(runtime.additionalRuntimeArgs), { kind: 'lines', rows: 4, placeholder: '--flag\n--another=value' }) })}
    </div>
    <p class="cfg-note">Where the Master Benchmark defines the runtime, duplicated values must remain consistent. Browser readiness becomes required only when this scenario actually needs it.</p>
  </section>`;
}
