/**
 * In-panel dialogs for the Configuration surface.
 *
 * These replace `window.prompt` and `window.confirm`: a native prompt cannot explain a consequence,
 * cannot validate as you type, and blocks the whole page. A dialog is rendered from `ui.dialog` and
 * the current snapshot on every render, so it always shows live state (a running validation, a
 * refusal) rather than a copy taken when it opened.
 *
 * No dialog holds authority. Each one ends in an action the panel routes exactly like a button on
 * the page, with the same guards.
 */

import { sectionById } from './sectionRegistry.js';
import { escapeHtml, isBusy } from './viewPrimitives.js';

export function exactDeletePhrase(record) {
  return `DELETE PROFILE ${record.profile.projectId} ${record.generation} ${record.projectProfileHash.slice(0, 12)}`;
}

function shell(kind, title, body, actions, options = {}) {
  return `<div class="cfg-overlay" data-cfg-dialog="${kind}">
    <div class="cfg-backdrop" data-cfg-action="dialog-cancel"></div>
    <div class="cfg-dialog${options.wide ? ' is-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="cfgDialogTitle" tabindex="-1">
      <header class="cfg-dialog-head"><h3 id="cfgDialogTitle">${escapeHtml(title)}</h3><button type="button" class="cfg-dialog-close" data-cfg-action="dialog-cancel" aria-label="Close">×</button></header>
      <div class="cfg-dialog-body">${body}</div>
      <footer class="cfg-dialog-actions">${actions}</footer>
    </div>
  </div>`;
}

function nameOf(snapshot) {
  const profile = snapshot.draft ?? snapshot.selectedRecord?.profile ?? null;
  return profile?.displayName || profile?.projectId || 'this profile';
}

function changeRows(changes, limit = Infinity) {
  return changes.slice(0, limit).map((change) => `<li><strong>${escapeHtml(change.label)}</strong><span>${escapeHtml(sectionById(change.section)?.label ?? change.section)}</span></li>`).join('');
}

function discardDialog(dialog, snapshot) {
  const changes = Array.isArray(snapshot.changes) ? snapshot.changes : [];
  const errors = (Array.isArray(snapshot.issues) ? snapshot.issues : []).filter((issue) => issue.severity === 'error').length;
  const creating = snapshot.draftMode === 'create' || snapshot.draftMode === 'prepare';
  const canSave = !creating && snapshot.dirty && errors === 0 && !isBusy(snapshot) && dialog.allowSave !== false;
  const body = creating
    ? `<p>The new profile has not been saved. If you ${escapeHtml(dialog.label)}, what you entered is lost.</p>`
    : `<p>You have ${changes.length || 'unsaved'} unsaved change${changes.length === 1 ? '' : 's'} to <strong>${escapeHtml(nameOf(snapshot))}</strong>. If you ${escapeHtml(dialog.label)}, they are lost.</p>
       ${changes.length ? `<ul class="cfg-change-brief">${changeRows(changes, 6)}${changes.length > 6 ? `<li><span>and ${changes.length - 6} more</span></li>` : ''}</ul>` : ''}`;
  return shell('discard', 'Discard unsaved changes?', body,
    `<button type="button" data-cfg-action="dialog-cancel">KEEP EDITING</button>
     <button type="button" class="is-danger" data-cfg-action="dialog-discard">DISCARD CHANGES</button>
     ${canSave ? '<button type="button" class="is-primary" data-cfg-action="dialog-save-continue">SAVE &amp; CONTINUE</button>' : ''}`);
}

function deleteDialog(dialog, snapshot) {
  const record = snapshot.selectedRecord;
  if (!record) return '';
  const phrase = exactDeletePhrase(record);
  const body = `<p>This removes CLU-E’s registration of <strong>${escapeHtml(nameOf(snapshot))}</strong>.</p>
    <ul class="cfg-consequences">
      <li class="is-kept">Kept: the target repository at <code>${escapeHtml(record.profile.targetRoot)}</code></li>
      <li class="is-kept">Kept: the workspace and shadow folders, with their events and evidence</li>
      <li class="is-removed">Removed: the profile record and its saved connections</li>
    </ul>
    <label class="cfg-field" for="cfgDialogConfirmInput"><span class="cfg-field-label">Type this phrase exactly to confirm</span>
      <code class="cfg-phrase">${escapeHtml(phrase)}</code>
      <input id="cfgDialogConfirmInput" data-cfg-transient data-confirm-phrase="${escapeHtml(phrase)}" autocomplete="off" spellcheck="false" aria-describedby="cfgDialogError" />
    </label>
    <p id="cfgDialogError" class="cfg-field-error" role="alert"${dialog.error ? '' : ' hidden'}>${escapeHtml(dialog.error ?? '')}</p>
    <p class="cfg-note">The phrase names the exact saved generation, so a profile that changed since you opened this dialog cannot be deleted by mistake.</p>`;
  return shell('delete', `Delete profile ${record.profile.projectId}?`, body,
    `<button type="button" data-cfg-action="dialog-cancel">CANCEL</button>
     <button type="button" class="is-danger" data-cfg-action="confirm-delete-profile" data-cfg-dialog-primary${isBusy(snapshot) ? ' disabled' : ''}>DELETE PROFILE</button>`);
}

function activateDialog(dialog, snapshot) {
  const record = snapshot.selectedRecord;
  if (!record) return '';
  const active = snapshot.active ?? null;
  const validation = snapshot.validation ?? null;
  const phase = snapshot.phase;
  const validating = phase === 'validating-project';
  const activating = phase === 'activating-project';
  const valid = validation?.valid === true;
  const problems = Array.isArray(validation?.problems) ? validation.problems : [];
  const name = escapeHtml(nameOf(snapshot));
  const failure = snapshot.error ? `<p class="cfg-connection-detail is-bad" role="alert">${escapeHtml(snapshot.error.code)} · ${escapeHtml(snapshot.error.message)}</p>` : '';

  const stepOne = validating
    ? `<p class="cfg-connection-detail" role="status">Validating the saved profile…</p>`
    : valid
      ? `<p class="cfg-inline-ok">Validated: the saved generation matches the files on disk.</p>`
      : validation
        ? `<div class="cfg-blockers" role="alert"><strong>VALIDATION ${escapeHtml(validation.state ?? 'FAILED')}</strong><ul>${(problems.length ? problems : ['The backend reported the profile as not valid.']).map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul></div><p class="cfg-note">Fix what it names, save, and validate again.</p>`
        : `<p class="cfg-note"><span class="cfg-code">PROJECT_VALIDATION_REQUIRED</span> The saved profile has not been validated in this session. Validation is read-only.</p>`;

  const body = `<p>${active
    ? `CLU-E will stop working with <strong>${escapeHtml(active.projectId)}</strong> and start working with <strong>${name}</strong> (generation ${escapeHtml(record.generation)}).`
    : `CLU-E will start working with <strong>${name}</strong> (generation ${escapeHtml(record.generation)}).`}
      The four dashboard quadrants are cleared and reload from this profile’s own evidence. Nothing in either target repository is changed.</p>
    <ol class="cfg-steps">
      <li class="cfg-step${valid ? ' is-done' : ''}"><span class="cfg-step-index" aria-hidden="true">${valid ? '✓' : '1'}</span><div class="cfg-step-body"><strong>Validate the saved profile</strong>${stepOne}
        <div class="cfg-action-row is-start"><button type="button" data-cfg-action="validate-profile"${validating || activating ? ' disabled' : ''}>${validation ? 'VALIDATE AGAIN' : 'VALIDATE NOW'}</button></div></div></li>
      <li class="cfg-step"><span class="cfg-step-index" aria-hidden="true">2</span><div class="cfg-step-body"><strong>Activate</strong><p>${activating ? 'Switching the running target…' : valid ? 'Ready to switch.' : 'Available once validation passes.'}</p></div></li>
    </ol>
    ${failure}`;
  return shell('activate', `Activate ${nameOf(snapshot)}?`, body,
    `<button type="button" data-cfg-action="dialog-cancel"${activating ? ' disabled' : ''}>CANCEL</button>
     <button type="button" class="is-primary" data-cfg-action="confirm-activate-project" data-cfg-dialog-primary${valid && !validating && !activating ? '' : ' disabled'}>ACTIVATE</button>`);
}

function credentialDialog(dialog, snapshot) {
  const current = snapshot.draft?.integrations?.gpt?.credential;
  const value = current?.source === 'project-override' ? String(current.value ?? '') : 'env:OPENAI_API_KEY';
  const store = value.startsWith('credential-store:');
  const name = value.slice(value.indexOf(':') + 1);
  const body = `<p>A profile stores where its key lives, never the key itself. Choose the kind of reference and enter its name.</p>
    <div class="cfg-form-grid">
      <label class="cfg-field" for="cfgDialogCredentialKind"><span class="cfg-field-label">Kind</span>
        <select id="cfgDialogCredentialKind" data-cfg-transient>
          <option value="env"${store ? '' : ' selected'}>Environment variable</option>
          <option value="credential-store"${store ? ' selected' : ''}>Windows credential store</option>
        </select>
      </label>
      <label class="cfg-field" for="cfgDialogCredentialName"><span class="cfg-field-label">Name</span>
        <input id="cfgDialogCredentialName" data-cfg-transient="volatile" value="${escapeHtml(name)}" placeholder="OPENAI_API_KEY" autocomplete="off" spellcheck="false" aria-describedby="cfgDialogError" />
        <small>Environment variable: capitals, digits and underscore, e.g. OPENAI_API_KEY. Credential store: its ID, e.g. CLU-E/OpenAI/murugan.</small>
      </label>
    </div>
    <p id="cfgDialogError" class="cfg-field-error" role="alert"${dialog.error ? '' : ' hidden'}>${escapeHtml(dialog.error ?? '')}</p>
    <p class="cfg-note">Do not paste an API key here. Anything shaped like a key is cleared immediately and is never stored or sent. To enter the key itself, use SET / REPLACE API KEY, which opens a masked Windows prompt.</p>`;
  return shell('credential', 'Credential reference', body,
    `<button type="button" data-cfg-action="dialog-cancel">CANCEL</button>
     <button type="button" class="is-primary" data-cfg-action="confirm-credential-reference" data-cfg-dialog-primary>USE THIS REFERENCE</button>`);
}

function changesDialog(dialog, snapshot) {
  const changes = Array.isArray(snapshot.changes) ? snapshot.changes : [];
  const errors = (Array.isArray(snapshot.issues) ? snapshot.issues : []).filter((issue) => issue.severity === 'error').length;
  const busy = isBusy(snapshot);
  const rows = changes.map((change) => `<tr>
      <th scope="row"><strong>${escapeHtml(change.label)}</strong><button type="button" class="cfg-link" data-cfg-action="go-issue" data-section-target="${escapeHtml(change.section)}" data-issue-path="${escapeHtml(change.path)}">${escapeHtml(sectionById(change.section)?.label ?? change.section)}</button></th>
      <td class="cfg-diff-before">${escapeHtml(change.beforeText)}</td>
      <td class="cfg-diff-after">${escapeHtml(change.afterText)}</td>
      <td><button type="button" data-cfg-action="revert-change" data-change-path="${escapeHtml(change.path)}" title="Put the saved value back">UNDO</button></td>
    </tr>`).join('');
  const body = changes.length === 0
    ? '<p class="cfg-empty-copy">The draft is identical to the saved generation.</p>'
    : `<p>These settings differ from the saved generation. Saving writes all of them as one new generation.</p>
       <div class="cfg-table-wrap"><table class="cfg-table cfg-diff"><thead><tr><th scope="col">Setting</th><th scope="col">Saved</th><th scope="col">Your draft</th><th scope="col"><span class="cfg-sr-only">Undo</span></th></tr></thead><tbody>${rows}</tbody></table></div>
       ${errors > 0 ? `<p class="cfg-field-error">${errors} problem${errors === 1 ? '' : 's'} must be fixed before this can be saved.</p>` : ''}`;
  return shell('changes', `Unsaved changes${changes.length ? ` (${changes.length})` : ''}`, body,
    `<button type="button" data-cfg-action="dialog-cancel">CLOSE</button>
     ${changes.length ? `<button type="button" class="is-danger" data-cfg-action="reset-profile"${busy ? ' disabled' : ''}>DISCARD ALL</button>
     <button type="button" class="is-primary" data-cfg-action="save-profile" data-cfg-dialog-primary${errors > 0 || busy ? ' disabled' : ''}>SAVE CHANGES</button>` : ''}`,
    { wide: true });
}

/** Renders the open dialog, or nothing. `snapshot.ui.dialog` is `{ kind, … }` or null. */
export function renderDialog(snapshot) {
  const dialog = snapshot.ui?.dialog ?? null;
  if (!dialog) return '';
  switch (dialog.kind) {
    case 'discard': return discardDialog(dialog, snapshot);
    case 'delete': return deleteDialog(dialog, snapshot);
    case 'activate': return activateDialog(dialog, snapshot);
    case 'credential': return credentialDialog(dialog, snapshot);
    case 'changes': return changesDialog(dialog, snapshot);
    default: return '';
  }
}
