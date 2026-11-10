/** Project-scoped recognition configuration. */

import { badge, checkbox, escapeHtml, fieldGroup, fieldMeta, fieldShell, lineText, sectionHeader, textarea, textInput } from './viewPrimitives.js';

export function renderRecognitionEditor(snapshot) {
  const recognition = snapshot.draft?.recognition;
  if (!recognition) {
    return `<section class="cfg-card" data-section="recognition">${sectionHeader({ kicker: 'CODE RECOGNITION', title: 'What CLU-E scans' })}<p class="cfg-empty-copy">Create or select a Project Profile to choose which folders CLU-E scans and how it reads them.</p></section>`;
  }
  const validation = snapshot.validation?.recognition ?? null;
  const failure = snapshot.validation?.recognitionError ?? null;
  const state = failure ? 'INVALID' : validation ? 'VALID' : 'UNVALIDATED';
  const field = (path, spec) => fieldShell({ ...spec, ...fieldMeta(snapshot, path) });
  return `<section class="cfg-card" data-section="recognition">
    ${sectionHeader({
      kicker: 'CODE RECOGNITION',
      title: 'What CLU-E scans and how it reads it',
      description: 'Recognition turns the target into units and a dependency graph. These settings decide which files are in scope. All paths are relative to the Target Root.',
      badges: badge(state),
    })}
    ${failure ? `<p class="cfg-connection-detail is-bad" role="alert">${escapeHtml(failure.code ?? 'RECOGNITION_INVALID')} · ${escapeHtml(failure.detail ?? '')}</p>` : ''}
    ${fieldGroup({
      title: 'Scope',
      description: 'One entry per line.',
      body: `<div class="cfg-form-grid">
        ${field('recognition.sourceRoots', { label: 'Source Roots', required: true, control: textarea('recognition.sourceRoots', lineText(recognition.sourceRoots), { kind: 'lines', rows: 5, placeholder: 'src\nui' }), note: 'Folders to scan. They should match what the compiler config covers, or recognition refuses on parity.' })}
        ${field('recognition.excludedPaths', { label: 'Excluded Paths', control: textarea('recognition.excludedPaths', lineText(recognition.excludedPaths), { kind: 'lines', rows: 5, placeholder: 'node_modules\ndist\nworkspace' }), note: 'Folders to skip inside the source roots, such as build output.' })}
      </div>`,
    })}
    ${fieldGroup({
      title: 'Language',
      body: `<div class="cfg-form-grid">
        ${field('recognition.buildConfig', { label: 'Build / Compiler Config', control: textInput('recognition.buildConfig', recognition.buildConfig ?? '', { placeholder: 'tsconfig.json' }), note: 'Target-relative. Leave empty if the target has none.' })}
        ${field('recognition.adapters', { label: 'Adapters', control: textarea('recognition.adapters', lineText(recognition.adapters), { kind: 'lines', rows: 4, placeholder: 'typescript\njavascript\nwgsl' }), note: 'Which language readers to use. One adapter ID per line.' })}
      </div>`,
    })}
    ${fieldGroup({
      title: 'Scan policy',
      body: `<div class="cfg-check-list">
        <div>${checkbox('recognition.policy.fullScanOnActivation', recognition.policy?.fullScanOnActivation, 'Full scan on activation')}<small>Rescan everything each time this profile is activated. Slower; off reuses what is still valid.</small></div>
        <div>${checkbox('recognition.policy.reuseUnchangedSnapshot', recognition.policy?.reuseUnchangedSnapshot, 'Reuse unchanged durable snapshot')}<small>Skip work for files that have not changed since this profile’s last scan.</small></div>
        <div>${checkbox('recognition.policy.followSymlinks', recognition.policy?.followSymlinks, 'Follow symlinks')}<small>Scan through symbolic links. Leave off unless the target relies on them.</small></div>
      </div>`,
    })}
    <p class="cfg-note">Switching back to an unchanged project reuses its own durable inventory; another project’s cache can never be reused.</p>
  </section>`;
}
