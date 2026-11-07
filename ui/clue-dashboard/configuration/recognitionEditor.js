/** Project-scoped recognition configuration. */

import { badge, checkbox, fieldShell, lineText, textarea, textInput } from './viewPrimitives.js';

export function renderRecognitionEditor(snapshot) {
  const recognition = snapshot.draft?.recognition;
  if (!recognition) return '';
  const validation = snapshot.validation?.recognition ?? null;
  const state = snapshot.validation?.recognitionError ? 'INVALID' : validation ? 'VALID' : 'UNVALIDATED';
  return `<section class="cfg-card" data-section="recognition">
    <header class="cfg-card-head"><div><span class="cfg-kicker">RECOGNITION</span><h3>Project-owned physical and semantic discovery</h3></div>${badge(state)}</header>
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'Source Roots', control: textarea('recognition.sourceRoots', lineText(recognition.sourceRoots), { kind: 'lines', rows: 5, placeholder: 'src\nui' }), note: 'One target-relative path per line.' })}
      ${fieldShell({ label: 'Excluded Paths', control: textarea('recognition.excludedPaths', lineText(recognition.excludedPaths), { kind: 'lines', rows: 5, placeholder: 'node_modules\ndist\nworkspace' }) })}
      ${fieldShell({ label: 'Build / Compiler Config', control: textInput('recognition.buildConfig', recognition.buildConfig ?? '', { placeholder: 'tsconfig.json' }), note: 'Target-relative; blank means none.' })}
      ${fieldShell({ label: 'Adapters', control: textarea('recognition.adapters', lineText(recognition.adapters), { kind: 'lines', rows: 5, placeholder: 'typescript\njavascript\nwgsl' }), note: 'Canonical adapter IDs, one per line.' })}
    </div>
    <div class="cfg-check-row">${checkbox('recognition.policy.fullScanOnActivation', recognition.policy?.fullScanOnActivation, 'Full scan on activation')}${checkbox('recognition.policy.reuseUnchangedSnapshot', recognition.policy?.reuseUnchangedSnapshot, 'Reuse unchanged durable snapshot')}${checkbox('recognition.policy.followSymlinks', recognition.policy?.followSymlinks, 'Follow symlinks')}</div>
    <p class="cfg-note">Switching back to an unchanged project reuses its own durable inventory; another project’s cache can never be reused.</p>
  </section>`;
}
