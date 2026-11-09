/**
 * `DEV-P1-17` — the shell markup.
 *
 * `tabShell.js` is tested against fake elements, which proves the behaviour but says nothing about
 * whether the real page gives it anything to act on. This reads `index.html` and `app.js` as text
 * and holds the parts of the obligation that are structural: exactly two tabs, a tablist, the
 * landmarks, and the wiring actually being present.
 *
 * What this cannot show is whether it looks right, or whether the panels lay out correctly. That
 * needs a browser and stays the Creator's acceptance. The point of the file is that everything
 * *except* the looking is checked before the looking starts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
const proofBoard = readFileSync(join(ROOT, 'workspaces', 'proofBoard.js'), 'utf8');

test('DEV-P1-17: there is one tablist, and it holds exactly two tabs', () => {
  assert.equal((html.match(/role="tablist"/g) ?? []).length, 1);

  const tablist = html.slice(html.indexOf('<nav id="toplevelTabs"'), html.indexOf('</nav>'));
  const buttons = tablist.match(/<button/g) ?? [];
  // "Exactly two top-level tabs" is the obligation, and the markup is where a third would appear.
  assert.equal(buttons.length, 2);
  assert.match(tablist, /id="tabDashboard" aria-label="Dashboard"/);
  assert.match(tablist, /id="tabConfiguration" aria-label="Configuration"/);
  assert.equal((tablist.match(/<svg /g) ?? []).length, 2);
  assert.match(tablist, /aria-label="Top level views"/);
});

test('DEV-P1-17: the page has landmarks, where it previously had none', () => {
  // Measured before this change: zero `role=` and zero `aria-` attributes in the whole file.
  assert.match(html, /<header id="rail" role="banner">/);
  assert.match(html, /<main id="shell">/);
  assert.equal((html.match(/<main/g) ?? []).length, 1, 'one main, or none of them is the main');
  assert.equal((html.match(/<\/main>/g) ?? []).length, 1);
});

test('DEV-P1-17: both panels live inside the main landmark', () => {
  const main = html.slice(html.indexOf('<main id="shell">'), html.indexOf('</main>'));
  assert.match(main, /<div id="grid">/);
  assert.match(main, /<section id="cfg"(?:\s|>)/);
});

test('DEV-P1-17: Configuration is a panel, not a drawer', () => {
  // The drawer was an <aside> revealed by a class, reachable only by clicking one button.
  assert.doesNotMatch(html, /<aside id="cfg"/);
  assert.doesNotMatch(html, /#cfg\.open/);
  assert.doesNotMatch(html, /id="cfgBtn"/);
  assert.equal(app.includes('cfgBtn'), false, 'no code still looks for the removed button');
});

test('DEV-P1-17: visibility follows the accessibility state, not a parallel class', () => {
  // `[hidden]` is what the tab shell writes. A panel hidden from sight but not from a screen
  // reader is the usual way this goes wrong, and a separate class is how it happens.
  assert.match(html, /\[hidden\] \{ display: none !important; \}/);
});

test('DEV-P1-17: the landmark changes semantics, and nothing about the layout', () => {
  // The first attempt at this wrapped both panels in a <main> that participated in layout and
  // moved the grid's own height onto it. The quadrants collapsed into each other. The landmark
  // was the objective; changing the arrangement was not, and the two are separable.
  assert.match(html, /#shell \{ display: contents; \}/);
  assert.match(
    html,
    /#grid \{\s*height: calc\(100% - 52px\); display: grid; gap: 10px; padding: 10px;\s*grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;/,
    'the quadrant grid keeps its original sizing',
  );
});

test('DEV-P1-17: focus stays visible, because the keyboard is the intended way in', () => {
  assert.match(html, /#toplevelTabs button:focus-visible/);
  assert.match(html, /outline: 2px solid var\(--accent\)/);
});

test('DEV-P1-17: the shell is wired to the tested module, not reimplemented inline', () => {
  assert.match(app, /import \{ createTabShell \} from '\.\/components\/tabShell\.js';/);
  assert.match(app, /createTabShell\(\{/);
  // Both panels, by the ids the markup declares.
  assert.match(app, /id: 'dashboard', tab: dashboardTab, panel: dashboardPanel/);
  assert.match(app, /id: 'configuration', tab: configurationTab, panel: configurationPanel/);
  assert.match(app, /shell\.handleKey\(event\)/, 'the tablist keys are bound');
});

test('DEV-P1-17: Configuration is mounted through the tested control-plane module, not assembled inline', () => {
  assert.match(app, /from '\.\/configuration\/configurationPanel\.js'/);
  assert.match(app, /mountConfigurationPanel\(\{/);
  assert.doesNotMatch(app, /renderConfigurationRows\(configurationRows\(config\)\)/);
  // The old inline readiness template and its duplicated escaping decisions remain absent.
  assert.doesNotMatch(app, /const mark = \(ok\) => ok \? '<span class="ok">OK<\/span>'/);
});

test('DEV-P1-16: the dashboard wires the quadrant Status presentation', () => {
  assert.match(app, /from '\.\/state\/statusStore\.js'/);
  assert.match(app, /from '\.\/state\/selectionBus\.js'/);
  assert.match(app, /from '\.\/quadrants\/statusPresentation\.js'/);
  assert.match(app, /mountQuadrantStatus\(\{ findPanel: \$, store: clueStatus, bus: clueSelection \}\)/);
});

test('DEV-P1-16: all four quadrant kernels are wired, and none is reimplemented inline', () => {
  for (const module of ['q1Navigator', 'q2Field', 'q3Gauges', 'q4Console']) {
    assert.match(app, new RegExp(`from '\\./quadrants/${module}\\.js'`), module);
  }
  // The inline copies are gone: the regex ladder, the row table, and the feed slicing.
  assert.doesNotMatch(app, /function semanticEventState\(/);
  assert.doesNotMatch(app, /\{ key: 'WHAT', value: contract\.what/);
  assert.doesNotMatch(app, /events\.slice\(-120\)\.reverse\(\)/);
  // Q2's decision ladder is gone. Q3's canvas still *reads* 'AWAITING PROOF' from telemetry the
  // kernel produced — a consumer, not a reimplementation — so the guard is the ladder's shape,
  // not the string.
  assert.doesNotMatch(app, /excludedCount \? 'warning' : 'idle'/);
});

test('the ribbon omits density and the grid and configuration share its height', () => {
  assert.doesNotMatch(html, /id="densityBtn"/);
  assert.doesNotMatch(html, /\[data-density="compact"\]/);
  assert.match(html, /#grid \{ height: calc\(100% - var\(--rail-h\)\); gap: var\(--grid-gap\); padding: var\(--grid-pad\); \}/);
  assert.match(html, /#cfg \{ top: var\(--rail-h\); \}/);
});

test('DEV-P1-16: fullscreen is delegated to the contract, and the private mirror is gone', () => {
  assert.match(app, /from '\.\/fullscreen\/fullscreenContract\.js'/);
  assert.match(app, /fullscreenContract\.register\(id, panel\)/);
  assert.match(app, /await fullscreenContract\.toggle\(id\)/);
  assert.match(app, /fullscreenContract\.handleKey\(event\)/);
  // The variable that mirrored the browser's state, and the two functions that maintained it.
  assert.doesNotMatch(app, /let softFullscreen/);
  assert.doesNotMatch(app, /function setSoftFullscreen/);
  assert.doesNotMatch(app, /function exitSoftFullscreen/);
});

test('DEV-P1-16: actions go through the declared registry, never raw fetch', () => {
  assert.match(app, /from '\.\/configuration\/actionContracts\.js'/);
  assert.match(app, /actionClient\.invoke\('start', undefined, \{ signal \}\)/);
  assert.match(app, /actionClient\.invoke\('publishCatalogue'/);
  assert.doesNotMatch(app, /fetch\('\/api\/control\/start'/);
  assert.doesNotMatch(app, /fetch\('\/api\/catalogues', \{ method: 'POST'/);
});

test('DEV-P1-16: exactly one stream is opened, not two', () => {
  // The store can follow the sealed frame stream itself. Letting it would open a second
  // EventSource beside the one ConsoleFrameBus already holds: two connections, two sets of
  // frames, one workspace.
  assert.match(app, /void clueStatus\.refresh\(\);/);
  assert.doesNotMatch(app, /clueStatus\.connect\(\)/);
  assert.equal((app.match(/new EventSource\(/g) ?? []).length, 1);
});

test('DEV-P1-17: Configuration loads on first arrival, however the operator got there', () => {
  // The drawer loaded its body as a side effect of a click toggle, so an operator arriving by
  // keyboard never loaded it, and the loader ran on odd clicks only.
  assert.match(app, /function loadConfiguration\(\)/);
  assert.match(app, /if \(configurationLoad !== null\) return configurationLoad/);
  assert.match(app, /if \(id === 'configuration'\) void loadConfiguration\(\);/);
  assert.doesNotMatch(app, /cfg\.classList\.toggle\('open'\)/);
});


test('P2-B6: the Proof Board is mounted through the shared overlay seam', () => {
  assert.match(app, /import \{ mountProofBoard \} from '\.\/workspaces\/proofBoard\.js';/);
  assert.match(app, /mountProofBoard\(\{ overlayUi: CLUE_UI, fetchJson, interfaceApi: ClueInterface \}\)/);
  assert.match(app, /ULTIMATE-2026\.08-Q1-V9-REPOSITORY-OBSERVATORY-R1/);
  assert.match(proofBoard, /panelButton\('q4', 'proofBoardBtn'/);
  assert.match(proofBoard, /makeOverlay\(\s*'proofBoardOverlay'/);
});

test('P2-B6: the browser consumes the durable projection and contains no verdict authority', () => {
  assert.match(proofBoard, /fetchJson\('\/api\/proof-board'/);
  assert.match(proofBoard, /verdicts are displayed, never calculated in this browser/);
  assert.doesNotMatch(proofBoard, /function\s+decide\s*\(/);
  assert.doesNotMatch(proofBoard, /const\s+decide\s*=/);
  assert.doesNotMatch(proofBoard, /delta_pct\s*[><=]/);
});
