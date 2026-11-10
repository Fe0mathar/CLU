/**
 * CLU-E unified dashboard client · ULTIMATE interface edition.
 *
 * One visual operating system, four specialist workspaces and no invented telemetry:
 *   - /api/navigator-events   → Q1: the real System Navigator recognition stream.
 *   - /api/console-events     → one shared sealed-frame bus feeding the mission rail,
 *     Q2, Q3 and Q4. Subscribers are isolated and all receive the same authoritative frame.
 *   - /api/improvement-field  → Q2 dual Great Book projection: switchable 10×10 grid and
 *     spherical field. Both remain neutral until proven contributions exist; native
 *     evidence remains available through the same cinematic inspector.
 *   - /api/frame              → Q3 initial sealed telemetry before live frames arrive.
 *   - /api/catalogue          → status overlay for the canonical 100-measure registry (v6).
 *   - /api/config, /api/run, /api/control/start → configuration and run control.
 *   - /api/status/current → provider-owned OpenAI usage/funding state for Q3; CLU-E does
 *     not invent or administer the provider budget.
 *   - syncGit dashboard action → explicit, operator-only Git synchronisation. No automatic
 *     sync is coupled to Start, cycle execution, proof acceptance or closure.
 *
 * The shared shell standardises material, typography, status language, keyboard behaviour,
 * fullscreen and switchable fixed/dynamic window composition for Q1–Q4. Dynamic composition
 * supports multi-monitor browser canvases, free movement, edge/corner resizing and temporary
 * quadrant dismissal without changing the authoritative visual or telemetry state.
 * Great Book and Measurement Catalogue workspaces retain their focused overlay behaviour.
 * Quadrant internals remain specialised and evidence-faithful.
 * Bring-up is isolated: no local failure may take the rail or another quadrant down.
 */

import '/navigator-src/index.js';
import { SseNavigatorAdapter } from '/navigator-src/adapters/SseNavigatorAdapter.js';

import { createTabShell } from './components/tabShell.js';
import { mountConfigurationPanel } from './configuration/configurationPanel.js';
import { createStatusStore } from './state/statusStore.js';
import { createSelectionBus } from './state/selectionBus.js';
import { describeDashboardRun, describeStartReceipt } from './state/runPresentation.js';
import { mountQuadrantStatus } from './quadrants/statusPresentation.js';
import { deriveTelemetry, formatObservedUsd, normalizeAiProviderStatus, projectAiGauge } from './quadrants/q3Gauges.js';
import { q2PanelDecision } from './quadrants/q2Field.js';
import {
  feedEntries,
  semanticEventState,
  workContractRows,
} from './quadrants/q4Console.js';
import {
  createQ1ProjectGenerationGuard,
  q1PanelDecision,
} from './quadrants/q1Navigator.js';
import { mountRibbon } from './components/ribbon.js';
import { mountQ4Terminal } from './quadrants/q4Terminal.js';
import { mountAgentsPanel } from './configuration/agentsPanel.js';
import { createFullscreenContract } from './fullscreen/fullscreenContract.js';
import { createActionClient } from './configuration/actionContracts.js';
import { mountProofBoard } from './workspaces/proofBoard.js';

const $ = (id) => document.getElementById(id);
let projectTransition = false;
const ribbon = mountRibbon({
  openConfiguration: openRibbonConfiguration,
  async checkCapability(capability, { signal } = {}) {
    if (projectTransition) return { state: 'pending', summary: 'Project activation is in progress.', checks: [] };
    const invoked = await actionClient.invoke('checkCapability', { capability }, { signal });
    if (!invoked.ok && typeof invoked.serverDetails?.summary === 'string') return invoked.serverDetails;
    return requireAction(invoked);
  },
});
const dashboardStreams = { navigator: false, sealed: false };
function updateRibbonStream(channel, connected) {
  dashboardStreams[channel] = connected;
  ribbon.updateStream(dashboardStreams.navigator && dashboardStreams.sealed);
}

const CLUE_UI_VERSION = 'ULTIMATE-2026.08-Q1-V9-REPOSITORY-OBSERVATORY-R1';

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';
  let body = null;
  try {
    body = contentType.includes('application/json') ? await response.json() : await response.text();
  } catch { body = null; }
  if (!response.ok) {
    const detail = body && typeof body === 'object' ? (body.error ?? body) : null;
    const message = detail?.message ?? detail?.reason ?? detail?.detail ?? (typeof body === 'string' && body.trim() !== '' ? body.trim() : response.statusText || 'request failed');
    const error = new Error(`${response.status} ${message} · ${url}`);
    error.code = detail?.code ?? `HTTP_${response.status}`;
    error.status = response.status;
    error.details = detail;
    throw error;
  }
  return body;
}

/* ======================== CLU-E VISUAL OPERATING SYSTEM ====================
 * One material language, one interaction language, four specialist workspaces.
 * The shell owns panel chrome and fullscreen; quadrant internals own only their
 * truthful data visualisation. Every quadrant therefore behaves like a complete
 * application, not a decorative dashboard tile.
 * ======================================================================== */
const ClueInterface = (() => {
  const PANELS = Object.freeze({
    q1: { index: 'Q1', title: 'SYSTEM NAVIGATOR',      accent: '#00a3e0' },
    q2: { index: 'Q2', title: 'GREAT BOOK FIELD',      accent: '#f4af2d' },
    q3: { index: 'Q3', title: 'MISSION INSTRUMENTS',   accent: '#39ff88' },
    q4: { index: 'Q4', title: 'OPERATIONAL CONSOLE',   accent: '#8f7cff' },
  });
  const registry = new Map();
  const pendingState = new Map();
  const pulseTimers = new WeakMap();
  /* DEV-P1-16: the fullscreen *state machine* is fullscreen/fullscreenContract.js — which
   * window, native or soft, one at a time, Escape releasing soft. What stays here is what was
   * always this file's job: the classes and relayouts that make the state visible
   * (clue-soft-fullscreen, clue-fullscreen-lock, notifyLayout, the button chrome). The old
   * `softFullscreen` variable was a private mirror; the contract is derived from the document,
   * which is why Escape cannot desynchronise it. */
  const fullscreenContract = createFullscreenContract();
  fullscreenContract.subscribe((next, previous) => {
    if (previous.id !== null && previous.id !== next.id) {
      const prevRecord = registry.get(previous.id);
      if (prevRecord && previous.mode === 'soft') prevRecord.panel.classList.remove('clue-soft-fullscreen');
      if (prevRecord) notifyLayout(prevRecord.panel);
    }
    const record = next.id === null ? null : registry.get(next.id);
    if (record && next.mode === 'soft') record.panel.classList.add('clue-soft-fullscreen');
    document.body.classList.toggle('clue-fullscreen-lock', next.mode === 'soft');
    updateFullscreenUi();
    if (record) notifyLayout(record.panel);
  });
  let installed = false;
  const layout = {
    mode: 'fixed',
    switchEl: null,
    fixedButton: null,
    dynamicButton: null,
    help: null,
    surface: null,
    surfaceTop: 0,
    pointer: null,
    zCounter: 40,
    notifyRaf: null,
    resizeRaf: null,
  };
  const DYNAMIC_MIN_WIDTH = 300;
  const DYNAMIC_MIN_HEIGHT = 220;


  const fullscreenSvg = (expanded) => expanded
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v2H6v3H4V4h5Zm11 5h-2V6h-3V4h5v5ZM4 15h2v3h3v2H4v-5Zm16 5h-5v-2h3v-3h2v5Z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"/></svg>';

  const closeSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.35 5 5.65 5.65L17.65 5 19 6.35 13.35 12 19 17.65 17.65 19 12 13.35 6.35 19 5 17.65 10.65 12 5 6.35 6.35 5Z"/></svg>';

  function injectStyles() {
    if (document.getElementById('clue-os-style')) return;
    const style = document.createElement('style');
    style.id = 'clue-os-style';
    style.textContent = `
:root{
  --clue-void:#02050a;--clue-ink:#07111c;--clue-glass:rgba(5,15,26,.82);
  --clue-line:rgba(112,190,232,.20);--clue-line-strong:rgba(126,218,255,.42);
  --clue-text:#e8f5ff;--clue-text-2:#a8c4d8;--clue-muted:#5d7b91;
  --clue-cyan:#00a3e0;--clue-amber:#f4af2d;--clue-green:#39ff88;
  --clue-orange:#ff5500;--clue-red:#ff4d5e;--clue-violet:#8f7cff;
  --clue-radius:16px;--clue-header-h:42px;
  color-scheme:dark;
}
html{background:var(--clue-void)}
body.clue-os{
  background:
    radial-gradient(circle at 16% -12%,rgba(0,163,224,.13),transparent 34rem),
    radial-gradient(circle at 92% 10%,rgba(143,124,255,.08),transparent 32rem),
    linear-gradient(180deg,#040914 0%,#02050a 58%,#010307 100%);
  color:var(--clue-text);
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  min-height:100vh;
}
body.clue-os::before{
  content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;opacity:.22;
  background-image:linear-gradient(rgba(65,150,198,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(65,150,198,.05) 1px,transparent 1px);
  background-size:48px 48px;mask-image:linear-gradient(to bottom,black,transparent 88%);
}
body.clue-fullscreen-lock{overflow:hidden!important}
#q1,#q2,#q3,#q4,.clue-panel{
  --panel-accent:var(--clue-cyan);
  position:relative;isolation:isolate;min-width:0;min-height:0;overflow:hidden;
  border:1px solid rgba(108,190,232,.22);border-radius:var(--clue-radius);
  background:
    linear-gradient(135deg,rgba(255,255,255,.036),transparent 24%),
    linear-gradient(180deg,rgba(8,21,35,.91),rgba(2,8,15,.94));
  box-shadow:0 18px 48px rgba(0,0,0,.33),inset 0 1px rgba(255,255,255,.055),inset 0 -1px rgba(0,0,0,.55);
  transform:translateZ(0);transition:border-color .24s ease,box-shadow .24s ease,transform .24s ease;
}
.clue-panel:hover{border-color:rgba(122,214,255,.38);box-shadow:0 22px 62px rgba(0,0,0,.42),0 0 28px rgba(0,163,224,.055),inset 0 1px rgba(255,255,255,.07)}
.clue-panel::before{
  content:"";position:absolute;inset:0;z-index:20;pointer-events:none;border-radius:inherit;
  background:
    linear-gradient(90deg,var(--panel-accent),transparent 70%) left top/26% 1px no-repeat,
    linear-gradient(180deg,var(--panel-accent),transparent 70%) left top/1px 24% no-repeat,
    linear-gradient(270deg,var(--panel-accent),transparent 70%) right bottom/22% 1px no-repeat,
    linear-gradient(0deg,var(--panel-accent),transparent 70%) right bottom/1px 22% no-repeat;
  opacity:.56;
}
.clue-panel::after{
  content:"";position:absolute;inset:0;z-index:1;pointer-events:none;border-radius:inherit;
  background:linear-gradient(112deg,transparent 0 43%,rgba(255,255,255,.025) 49%,transparent 55% 100%);
  transform:translateX(-60%);opacity:0;
}
.clue-panel.clue-pulse::after{animation:clue-panel-pulse .72s ease-out}
@keyframes clue-panel-pulse{0%{opacity:0;transform:translateX(-65%)}25%{opacity:1}100%{opacity:0;transform:translateX(65%)}}
.clue-panel-header{
  position:relative;z-index:31;display:flex!important;align-items:center;gap:9px;box-sizing:border-box;
  min-height:var(--clue-header-h);padding:7px 8px 7px 10px!important;
  color:var(--clue-text-2);font:600 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;
  letter-spacing:.075em;text-transform:uppercase;
  background:linear-gradient(180deg,rgba(10,25,40,.88),rgba(5,14,24,.74));
  border-bottom:1px solid rgba(105,188,229,.16);backdrop-filter:blur(14px) saturate(125%);
}
.clue-panel-identity{display:flex;align-items:center;gap:9px;min-width:0;white-space:nowrap}
.clue-panel-code{
  display:inline-grid;place-items:center;min-width:27px;height:21px;padding:0 5px;box-sizing:border-box;
  color:var(--panel-accent);font-weight:800;letter-spacing:.08em;border:1px solid color-mix(in srgb,var(--panel-accent) 46%,transparent);
  border-radius:5px;background:color-mix(in srgb,var(--panel-accent) 9%,transparent);box-shadow:inset 0 0 12px color-mix(in srgb,var(--panel-accent) 8%,transparent);
}
.clue-panel-name{color:#dff5ff;font-weight:720;letter-spacing:.09em;overflow:hidden;text-overflow:ellipsis}
.clue-panel-header > .clue-panel-identity + *{min-width:0}
.clue-panel-tools{display:flex;align-items:center;gap:6px;margin-left:auto;flex:0 0 auto}
.clue-panel-state{
  display:flex;align-items:center;gap:6px;max-width:150px;height:25px;padding:0 8px;border-radius:999px;
  color:var(--clue-muted);border:1px solid rgba(106,179,218,.16);background:rgba(1,7,13,.42);
  font-size:8.5px;letter-spacing:.085em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.clue-panel-state::before{content:"";width:5px;height:5px;flex:0 0 auto;border-radius:50%;background:#557083;box-shadow:0 0 0 3px rgba(85,112,131,.10)}
.clue-panel[data-ui-state="live"] .clue-panel-state{color:#9cf6c0;border-color:rgba(57,255,136,.22)}
.clue-panel[data-ui-state="live"] .clue-panel-state::before{background:var(--clue-green);box-shadow:0 0 9px rgba(57,255,136,.95),0 0 0 3px rgba(57,255,136,.10)}
.clue-panel[data-ui-state="working"] .clue-panel-state,.clue-panel[data-ui-state="connecting"] .clue-panel-state{color:#8fe9ff;border-color:rgba(0,163,224,.26)}
.clue-panel[data-ui-state="working"] .clue-panel-state::before,.clue-panel[data-ui-state="connecting"] .clue-panel-state::before{background:var(--clue-cyan);box-shadow:0 0 9px rgba(0,163,224,.92),0 0 0 3px rgba(0,163,224,.11);animation:clue-state-beat 1.25s ease-in-out infinite}
.clue-panel[data-ui-state="warning"] .clue-panel-state{color:#ffd47c;border-color:rgba(244,175,45,.28)}
.clue-panel[data-ui-state="warning"] .clue-panel-state::before{background:var(--clue-amber);box-shadow:0 0 9px rgba(244,175,45,.85)}
.clue-panel[data-ui-state="critical"] .clue-panel-state,.clue-panel[data-ui-state="unavailable"] .clue-panel-state{color:#ff9aa5;border-color:rgba(255,77,94,.30)}
.clue-panel[data-ui-state="critical"] .clue-panel-state::before,.clue-panel[data-ui-state="unavailable"] .clue-panel-state::before{background:var(--clue-red);box-shadow:0 0 10px rgba(255,77,94,.9)}
@keyframes clue-state-beat{50%{opacity:.38;transform:scale(.72)}}
.clue-tool{
  display:grid;place-items:center;width:27px;height:27px;padding:0;border:1px solid rgba(112,197,235,.22);border-radius:7px;
  color:#8fdcf8;background:linear-gradient(180deg,rgba(13,31,48,.82),rgba(3,10,17,.86));cursor:pointer;
  box-shadow:inset 0 1px rgba(255,255,255,.045);transition:color .16s ease,border-color .16s ease,background .16s ease,transform .16s ease,box-shadow .16s ease;
}
.clue-tool svg{width:15px;height:15px;fill:currentColor}
.clue-tool:hover{color:#effcff;border-color:color-mix(in srgb,var(--panel-accent) 58%,transparent);background:color-mix(in srgb,var(--panel-accent) 12%,#06101a);box-shadow:0 0 18px color-mix(in srgb,var(--panel-accent) 18%,transparent);transform:translateY(-1px)}
.clue-tool:focus-visible{outline:2px solid #dff8ff;outline-offset:2px}
.clue-panel > .body,.clue-panel .body{position:relative;z-index:3;min-width:0;min-height:0}
.clue-panel canvas:focus-visible{outline:1px solid rgba(191,241,255,.72);outline-offset:-3px}
#mission{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cce8f7}
.clue-panel > .foot,.clue-panel > .footer,.clue-panel .foot,.clue-panel .footer{
  position:relative;z-index:30;box-sizing:border-box;min-height:24px;padding:5px 10px!important;
  color:var(--clue-muted);font:500 9.5px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.035em;
  background:linear-gradient(180deg,rgba(3,10,17,.45),rgba(2,7,12,.88));border-top:1px solid rgba(103,182,222,.12);
}
.clue-panel:fullscreen,.clue-panel.clue-soft-fullscreen{
  width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;
  border:0!important;border-radius:0!important;display:grid!important;grid-template-rows:auto minmax(0,1fr) auto!important;
  background:#020711!important;box-shadow:none!important;
}
.clue-panel.clue-soft-fullscreen{position:fixed!important;inset:0!important;z-index:2147483000!important}
.clue-panel:fullscreen > .body,.clue-panel.clue-soft-fullscreen > .body{height:auto!important;min-height:0!important;overflow:hidden}
.clue-panel:fullscreen .clue-panel-header,.clue-panel.clue-soft-fullscreen .clue-panel-header{min-height:50px;padding-inline:15px!important}
.clue-panel:fullscreen .clue-panel-state,.clue-panel.clue-soft-fullscreen .clue-panel-state{max-width:280px}
.clue-panel:fullscreen .clue-panel-name,.clue-panel.clue-soft-fullscreen .clue-panel-name{font-size:12px}
#q1 .body,#q2 .body,#q3 .body{padding:0!important;overflow:hidden}
#q1 #nav{display:block;width:100%;height:100%;min-width:0;min-height:0}
#q4 .body{display:grid!important;grid-template-rows:auto minmax(0,1fr);gap:8px;min-height:0;overflow:hidden;padding:8px!important}
#q4 #work{display:grid;grid-template-columns:minmax(84px,.25fr) minmax(0,1fr);gap:0;border:1px solid rgba(106,185,225,.14);border-radius:11px;overflow:hidden;background:rgba(1,8,14,.34)}
#q4 #work .clue-work-field{display:contents}
#q4 #work .clue-work-key,#q4 #work .clue-work-value{padding:8px 10px;border-bottom:1px solid rgba(105,182,220,.10)}
#q4 #work .clue-work-key{color:#6688a1;font:700 8.5px/1.4 ui-monospace,Consolas,monospace;letter-spacing:.11em;background:rgba(6,18,29,.42)}
#q4 #work .clue-work-value{color:#cce7f7;font:500 10.5px/1.5 ui-monospace,Consolas,monospace;word-break:break-word}
#q4 #work .clue-work-field.is-current .clue-work-key,#q4 #work .clue-work-field.is-current .clue-work-value{background:rgba(0,163,224,.075)}
#q4 #work .clue-work-field.is-current .clue-work-key{color:#74dcff}
#q4 #work .clue-work-field.is-proof .clue-work-key{color:#ffd273}
#q4 #work .clue-work-field.is-next .clue-work-key{color:#8bf1b0}
#q4 #feed{display:flex;flex-direction:column;gap:5px;min-height:0;overflow:auto;padding-right:3px;scrollbar-width:thin;scrollbar-color:rgba(83,159,198,.35) transparent}
#q4 #feed::-webkit-scrollbar{width:7px}#q4 #feed::-webkit-scrollbar-thumb{background:rgba(83,159,198,.28);border-radius:8px}
#q4 .clue-event{display:grid;grid-template-columns:auto minmax(48px,72px) 58px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:31px;padding:5px 8px;border:1px solid rgba(102,178,218,.11);border-radius:7px;background:linear-gradient(90deg,rgba(7,20,32,.58),rgba(3,10,18,.42));font:500 9.5px/1.35 ui-monospace,Consolas,monospace}
#q4 .clue-event::before{content:"";width:3px;height:17px;border-radius:99px;background:#48687d;box-shadow:0 0 8px rgba(72,104,125,.35)}
#q4 .clue-event[data-state="active"]::before{background:var(--clue-cyan);box-shadow:0 0 10px rgba(0,163,224,.75)}
#q4 .clue-event[data-state="success"]::before{background:var(--clue-green);box-shadow:0 0 10px rgba(57,255,136,.58)}
#q4 .clue-event[data-state="warning"]::before{background:var(--clue-amber);box-shadow:0 0 10px rgba(244,175,45,.58)}
#q4 .clue-event[data-state="critical"]::before{background:var(--clue-red);box-shadow:0 0 10px rgba(255,77,94,.65)}
#q4 .clue-event-channel{color:#79cdea;font-size:8px;letter-spacing:.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#q4 .clue-event-time{color:#58778e;font-variant-numeric:tabular-nums}
#q4 .clue-event-title{color:#c8deec;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#q4 .clue-event-state{color:#6e8da3;font-size:8px;letter-spacing:.07em;text-transform:uppercase}
#q4 .empty{display:grid;place-items:center;min-height:70px;padding:18px;color:#54748b!important;text-align:center;border:1px dashed rgba(93,166,204,.18);border-radius:9px;background:rgba(2,10,17,.34);font:500 10px/1.5 ui-monospace,Consolas,monospace}
#q4:fullscreen #work,#q4.clue-soft-fullscreen #work{grid-template-columns:150px minmax(0,1fr)}
#q4:fullscreen .clue-event,#q4.clue-soft-fullscreen .clue-event{grid-template-columns:auto 150px 72px minmax(0,1fr) 100px;font-size:11px;min-height:38px}
#cfg{background:rgba(3,10,18,.96)!important;border-color:rgba(95,181,224,.25)!important;backdrop-filter:blur(18px)}
#cfg .row{border-bottom:1px solid rgba(88,161,199,.10)}
.pill{border-radius:999px!important;border:1px solid rgba(103,179,218,.18)!important;background:rgba(1,8,14,.52)!important;letter-spacing:.075em!important}
.pill.on{color:#8df6b5!important;border-color:rgba(57,255,136,.25)!important}.pill.run{color:#8fe6ff!important;border-color:rgba(0,163,224,.30)!important}.pill.bad{color:#ff9da8!important;border-color:rgba(255,77,94,.30)!important}
/* Fixed / dynamic dashboard composition ---------------------------------- */
.clue-layout-switch{
  position:relative;z-index:2147481800;display:flex;align-items:center;gap:8px;box-sizing:border-box;
  min-height:34px;padding:4px 6px 4px 9px;border:1px solid rgba(104,192,232,.24);border-radius:9px;
  color:#87a8bc;background:linear-gradient(180deg,rgba(11,29,45,.94),rgba(2,9,16,.96));
  box-shadow:0 9px 28px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.05);backdrop-filter:blur(14px) saturate(125%);
  font:700 8.5px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.085em;white-space:nowrap;
}
#cfg .clue-layout-switch{margin:14px clamp(12px,3vw,30px) 0;width:fit-content;max-width:calc(100% - 24px);flex-wrap:wrap;z-index:1}
.clue-layout-switch-label{color:#6f91a7;letter-spacing:.12em}
.clue-layout-switch-segments{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid rgba(112,197,235,.18);border-radius:6px;background:rgba(1,7,13,.58)}
.clue-layout-mode{
  min-width:62px;height:24px;padding:0 9px;border:0;border-radius:4px;color:#67869a;background:transparent;
  font:800 8px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.09em;cursor:pointer;
  transition:color .16s ease,background .16s ease,box-shadow .16s ease,transform .16s ease;
}
.clue-layout-mode:hover{color:#e8f9ff;background:rgba(0,163,224,.08)}
.clue-layout-mode.is-active{color:#e9fbff;background:rgba(0,163,224,.16);box-shadow:inset 0 0 0 1px rgba(0,163,224,.38),0 0 14px rgba(0,163,224,.10)}
.clue-layout-mode[data-mode="dynamic"].is-active{color:#ffe2a0;background:rgba(244,175,45,.14);box-shadow:inset 0 0 0 1px rgba(244,175,45,.40),0 0 16px rgba(244,175,45,.10)}
.clue-layout-mode:focus-visible{outline:2px solid #dff8ff;outline-offset:2px}
.clue-layout-switch-help{max-width:0;overflow:hidden;opacity:0;color:#6c899e;font-size:7.4px;letter-spacing:.075em;transition:max-width .24s ease,opacity .18s ease}
body.clue-layout-dynamic .clue-layout-switch-help{max-width:255px;opacity:1}
body.clue-layout-dynamic{overflow:hidden!important}
body.clue-layout-dynamic #cfg{z-index:2147481900!important}
.clue-dynamic-surface{
  --clue-dynamic-top:52px;position:fixed;left:0;right:0;bottom:0;top:var(--clue-dynamic-top);z-index:2147481200;
  display:none;overflow:hidden;pointer-events:none;isolation:isolate;
  background:radial-gradient(circle at 50% -18%,rgba(0,163,224,.075),transparent 42rem),linear-gradient(180deg,rgba(1,6,11,.20),rgba(1,4,8,.36));
}
body.clue-layout-dynamic .clue-dynamic-surface{display:block}
.clue-dynamic-surface::before{
  content:"";position:absolute;inset:0;z-index:0;pointer-events:none;opacity:.32;
  background-image:linear-gradient(rgba(72,159,203,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(72,159,203,.055) 1px,transparent 1px);
  background-size:40px 40px;mask-image:linear-gradient(to bottom,black,rgba(0,0,0,.58) 72%,transparent);
}
.clue-dynamic-surface::after{
  content:"DYNAMIC COMPOSITION SPACE";position:absolute;right:13px;bottom:9px;z-index:0;color:rgba(91,136,163,.28);
  font:750 7.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.18em;pointer-events:none;
}
body.clue-layout-dynamic .clue-dynamic-surface>.clue-panel{
  position:absolute!important;display:grid!important;grid-template-rows:auto minmax(0,1fr) auto!important;
  box-sizing:border-box!important;max-width:none!important;max-height:none!important;margin:0!important;
  pointer-events:auto;will-change:left,top,width,height;contain:layout paint;
}
body.clue-layout-dynamic .clue-dynamic-surface>.clue-panel.clue-panel-dismissed{display:none!important}
body.clue-layout-dynamic .clue-dynamic-surface>.clue-panel.is-layout-interacting{
  transition:none!important;border-color:color-mix(in srgb,var(--panel-accent) 70%,#ffffff)!important;
  box-shadow:0 30px 86px rgba(0,0,0,.64),0 0 34px color-mix(in srgb,var(--panel-accent) 18%,transparent),inset 0 1px rgba(255,255,255,.08)!important;
}
body.clue-layout-dynamic .clue-dynamic-surface>.clue-panel>.clue-panel-header{cursor:move;user-select:none;touch-action:none}
body.clue-layout-dynamic .clue-dynamic-surface>.clue-panel>.clue-panel-header .clue-panel-tools,
body.clue-layout-dynamic .clue-dynamic-surface>.clue-panel>.clue-panel-header button{cursor:pointer}
.clue-tool-close{display:none;color:#ff7785;border-color:rgba(255,77,94,.34);background:linear-gradient(180deg,rgba(48,10,17,.84),rgba(18,4,8,.90))}
body.clue-layout-dynamic .clue-tool-close{display:grid}
.clue-tool-close:hover{color:#fff0f2!important;border-color:rgba(255,77,94,.82)!important;background:rgba(88,12,25,.82)!important;box-shadow:0 0 20px rgba(255,77,94,.22)!important}
.clue-resize-handle{position:absolute;z-index:52;display:none;touch-action:none}
body.clue-layout-dynamic .clue-dynamic-surface>.clue-panel>.clue-resize-handle{display:block}
.clue-resize-handle[data-dir="n"]{left:12px;right:12px;top:-4px;height:9px;cursor:ns-resize}
.clue-resize-handle[data-dir="s"]{left:12px;right:12px;bottom:-4px;height:9px;cursor:ns-resize}
.clue-resize-handle[data-dir="e"]{top:12px;right:-4px;bottom:12px;width:9px;cursor:ew-resize}
.clue-resize-handle[data-dir="w"]{top:12px;left:-4px;bottom:12px;width:9px;cursor:ew-resize}
.clue-resize-handle[data-dir="ne"]{top:-5px;right:-5px;width:15px;height:15px;cursor:nesw-resize}
.clue-resize-handle[data-dir="nw"]{top:-5px;left:-5px;width:15px;height:15px;cursor:nwse-resize}
.clue-resize-handle[data-dir="se"]{right:-5px;bottom:-5px;width:15px;height:15px;cursor:nwse-resize}
.clue-resize-handle[data-dir="sw"]{left:-5px;bottom:-5px;width:15px;height:15px;cursor:nesw-resize}
.clue-resize-handle[data-dir="se"]::after{
  content:"";position:absolute;right:4px;bottom:4px;width:8px;height:8px;opacity:.58;
  border-right:1px solid var(--panel-accent);border-bottom:1px solid var(--panel-accent);box-shadow:3px 3px 9px color-mix(in srgb,var(--panel-accent) 30%,transparent);
}
.clue-dynamic-placeholder{visibility:hidden!important;opacity:0!important;pointer-events:none!important;min-width:0!important;min-height:0!important}
@media (max-width:900px){.clue-panel-state{max-width:28px;padding-inline:7px}.clue-panel-state span{display:none}.clue-panel-name{display:none}#q4 .clue-event{grid-template-columns:auto 46px minmax(0,1fr)}#q4 .clue-event-channel,#q4 .clue-event-state{display:none}}
@media (prefers-reduced-motion:reduce){.clue-panel,.clue-tool,.clue-layout-mode,.clue-layout-switch-help{transition:none!important}.clue-panel.clue-pulse::after,.clue-panel-state::before{animation:none!important}}
`;
    document.head.appendChild(style);
  }

  function directHeader(panel) {
    return Array.from(panel.children).find((node) => node.matches?.('.head,.header,header')) || null;
  }

  function ensurePanel(id, meta) {
    const panel = $(id);
    if (!panel || registry.has(id)) return panel;
    panel.classList.add('clue-panel');
    panel.dataset.cluePanel = id;
    panel.dataset.uiState = 'idle';
    panel.style.setProperty('--panel-accent', meta.accent);
    panel.setAttribute('aria-label', `${meta.index} ${meta.title}`);

    let header = directHeader(panel);
    if (!header) {
      header = document.createElement('div');
      header.className = 'head';
      panel.insertBefore(header, panel.firstChild);
    }
    header.classList.add('clue-panel-header');

    const identity = document.createElement('div');
    identity.className = 'clue-panel-identity';
    identity.innerHTML = `<span class="clue-panel-code">${meta.index}</span><span class="clue-panel-name">${meta.title}</span>`;
    header.replaceChildren(identity);

    const tools = document.createElement('div');
    tools.className = 'clue-panel-tools';
    const state = document.createElement('div');
    state.className = 'clue-panel-state';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    state.innerHTML = '<span>AWAITING DATA</span>';
    state.title = 'Quadrant runtime state';
    const fs = document.createElement('button');
    fs.type = 'button';
    fs.className = 'clue-tool clue-tool-fullscreen';
    fs.setAttribute('aria-label', `Open ${meta.title} full screen`);
    fs.title = `Full screen ${meta.index} · Esc exits · Alt+${meta.index.slice(1)} shortcut`;
    fs.innerHTML = fullscreenSvg(false);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'clue-tool clue-tool-close';
    close.setAttribute('aria-label', `Hide ${meta.title} from dynamic composition`);
    close.title = `Hide ${meta.index} · return to FIXED composition to restore all quadrants`;
    close.innerHTML = closeSvg;
    tools.append(state, fs, close);
    header.appendChild(tools);

    const resizeHandles = [];
    for (const direction of ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = document.createElement('div');
      handle.className = 'clue-resize-handle';
      handle.dataset.dir = direction;
      handle.setAttribute('aria-hidden', 'true');
      panel.appendChild(handle);
      resizeHandles.push(handle);
    }

    const record = {
      panel, header, state, fs, close, resizeHandles, meta,
      placeholder: null,
      originalStyle: null,
      originalAriaHidden: null,
      dynamicGeometry: null,
      dismissed: false,
      zIndex: 0,
    };
    registry.set(id, record);
    // Every meaningful window is a fullscreen window (§20.1); the contract needs to know it
    // exists before its button can enter it.
    fullscreenContract.register(id, panel);
    fs.addEventListener('click', () => toggleFullscreen(id));
    panel.addEventListener('pointerdown', () => {
      if (layout.mode === 'dynamic' && !record.dismissed) bringToFront(record);
    }, { capture: true });
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void dismissPanel(id);
    });
    header.addEventListener('pointerdown', (event) => beginLayoutPointer(event, id, 'move'));
    for (const handle of resizeHandles) {
      handle.addEventListener('pointerdown', (event) => beginLayoutPointer(event, id, handle.dataset.dir || 'se'));
    }
    const queued = pendingState.get(id);
    if (queued) {
      pendingState.delete(id);
      setPanelState(id, queued.state, queued.label);
    }
    return panel;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function createDynamicSurface() {
    if (layout.surface?.isConnected) return layout.surface;
    const surface = document.createElement('div');
    surface.id = 'clue-dynamic-surface';
    surface.className = 'clue-dynamic-surface';
    surface.setAttribute('aria-label', 'CLU-E dynamic dashboard composition space');
    document.body.appendChild(surface);
    layout.surface = surface;
    return surface;
  }

  function measureDynamicTop() {
    let bottom = 0;
    const rail = $('rail');
    const candidates = [rail].filter(Boolean);
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < Math.min(window.innerHeight, 180)) {
        bottom = Math.max(bottom, rect.bottom);
      }
    }
    return clamp(Math.ceil(bottom + 8), 0, Math.max(0, window.innerHeight - 180));
  }

  function updateDynamicSurfaceBounds() {
    const surface = createDynamicSurface();
    const previousTop = layout.surfaceTop;
    const nextTop = measureDynamicTop();
    layout.surfaceTop = nextTop;
    surface.style.setProperty('--clue-dynamic-top', `${nextTop}px`);
    if (layout.mode === 'dynamic' && previousTop !== nextTop) {
      for (const record of registry.values()) {
        if (!record.panel.parentElement || record.panel.parentElement !== surface || record.dismissed) continue;
        applyPanelGeometry(record, readPanelGeometry(record));
      }
    }
  }

  function createLayoutSwitch() {
    if (layout.switchEl?.isConnected) return layout.switchEl;
    const root = document.createElement('div');
    root.id = 'clue-layout-switch';
    root.className = 'clue-layout-switch';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Dashboard window composition');
    root.innerHTML = '<span class="clue-layout-switch-label">WINDOW COMPOSITION</span>' +
      '<span class="clue-layout-switch-segments" role="group" aria-label="Window composition mode">' +
      '<button type="button" class="clue-layout-mode" data-mode="fixed">FIXED</button>' +
      '<button type="button" class="clue-layout-mode" data-mode="dynamic">DYNAMIC</button>' +
      '</span><span class="clue-layout-switch-help">DRAG HEADERS · RESIZE EDGES · RED X HIDES</span>';
    $('cfg')?.prepend(root);
    layout.switchEl = root;
    layout.fixedButton = root.querySelector('[data-mode="fixed"]');
    layout.dynamicButton = root.querySelector('[data-mode="dynamic"]');
    layout.help = root.querySelector('.clue-layout-switch-help');
    layout.fixedButton?.addEventListener('click', () => void setCompositionMode('fixed'));
    layout.dynamicButton?.addEventListener('click', () => void setCompositionMode('dynamic'));
    root.title = 'Fixed preserves the authored dashboard. Dynamic lets you move and resize Q1–Q4 across the full browser canvas.';
    updateCompositionUi();
    return root;
  }

  function updateCompositionUi() {
    const dynamic = layout.mode === 'dynamic';
    document.body.dataset.clueComposition = layout.mode;
    layout.fixedButton?.classList.toggle('is-active', !dynamic);
    layout.dynamicButton?.classList.toggle('is-active', dynamic);
    layout.fixedButton?.setAttribute('aria-pressed', String(!dynamic));
    layout.dynamicButton?.setAttribute('aria-pressed', String(dynamic));
    if (layout.help) layout.help.textContent = dynamic ? 'DRAG HEADERS · RESIZE EDGES · RED X HIDES' : '';
  }

  function createPlaceholder(record, rect) {
    const panel = record.panel;
    const computed = getComputedStyle(panel);
    const placeholder = document.createElement('div');
    placeholder.className = 'clue-dynamic-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.style.width = `${Math.max(1, rect.width)}px`;
    placeholder.style.height = `${Math.max(1, rect.height)}px`;
    placeholder.style.boxSizing = 'border-box';
    placeholder.style.margin = computed.margin;
    placeholder.style.flex = computed.flex;
    placeholder.style.order = computed.order;
    placeholder.style.alignSelf = computed.alignSelf;
    placeholder.style.justifySelf = computed.justifySelf;
    placeholder.style.gridArea = computed.gridArea;
    placeholder.style.gridColumn = computed.gridColumn;
    placeholder.style.gridRow = computed.gridRow;
    panel.parentNode?.insertBefore(placeholder, panel);
    return placeholder;
  }

  function defaultDynamicGeometry(id, rect, bounds) {
    const gap = 12;
    const fallbackWidth = Math.max(DYNAMIC_MIN_WIDTH, (bounds.width - gap * 3) / 2);
    const fallbackHeight = Math.max(DYNAMIC_MIN_HEIGHT, (bounds.height - gap * 3) / 2);
    const index = Math.max(0, Number(id.slice(1)) - 1);
    const fallback = {
      x: gap + (index % 2) * (fallbackWidth + gap),
      y: gap + Math.floor(index / 2) * (fallbackHeight + gap),
      w: fallbackWidth,
      h: fallbackHeight,
    };
    const candidate = {
      x: rect.left - bounds.left,
      y: rect.top - bounds.top,
      w: rect.width,
      h: rect.height,
    };
    const usable = candidate.w >= 180 && candidate.h >= 120 &&
      candidate.x < bounds.width - 40 && candidate.y < bounds.height - 30 &&
      candidate.x + candidate.w > 40 && candidate.y + candidate.h > 30;
    return usable ? candidate : fallback;
  }

  function readPanelGeometry(record) {
    const surface = layout.surface;
    const panel = record.panel;
    if (!surface || panel.parentElement !== surface) return record.dynamicGeometry || { x: 0, y: 0, w: DYNAMIC_MIN_WIDTH, h: DYNAMIC_MIN_HEIGHT };
    const surfaceRect = surface.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      x: panelRect.left - surfaceRect.left,
      y: panelRect.top - surfaceRect.top,
      w: panelRect.width,
      h: panelRect.height,
    };
  }

  function constrainGeometry(geometry) {
    const surface = layout.surface;
    const width = Math.max(1, surface?.clientWidth || window.innerWidth || 1);
    const height = Math.max(1, surface?.clientHeight || (window.innerHeight - layout.surfaceTop) || 1);
    const minWidth = Math.min(DYNAMIC_MIN_WIDTH, width);
    const minHeight = Math.min(DYNAMIC_MIN_HEIGHT, height);
    const w = clamp(Number(geometry.w) || minWidth, minWidth, width);
    const h = clamp(Number(geometry.h) || minHeight, minHeight, height);
    const x = clamp(Number(geometry.x) || 0, 0, Math.max(0, width - w));
    const y = clamp(Number(geometry.y) || 0, 0, Math.max(0, height - h));
    return { x, y, w, h };
  }

  function applyPanelGeometry(record, geometry, { remember = true } = {}) {
    const next = constrainGeometry(geometry);
    const panel = record.panel;
    panel.style.left = `${Math.round(next.x)}px`;
    panel.style.top = `${Math.round(next.y)}px`;
    panel.style.width = `${Math.round(next.w)}px`;
    panel.style.height = `${Math.round(next.h)}px`;
    panel.style.zIndex = String(record.zIndex || 1);
    if (remember) record.dynamicGeometry = next;
    return next;
  }

  function bringToFront(record) {
    layout.zCounter += 1;
    record.zIndex = layout.zCounter;
    if (record.panel.parentElement === layout.surface) record.panel.style.zIndex = String(record.zIndex);
  }

  function scheduleLayoutNotify(panel) {
    if (layout.notifyRaf) cancelAnimationFrame(layout.notifyRaf);
    layout.notifyRaf = requestAnimationFrame(() => {
      layout.notifyRaf = null;
      panel?.dispatchEvent(new CustomEvent('clue:layoutchange', { bubbles: true }));
    });
  }

  function beginLayoutPointer(event, id, action) {
    if (layout.mode !== 'dynamic' || event.button !== 0) return;
    const record = registry.get(id);
    if (!record || record.dismissed || record.panel.parentElement !== layout.surface) return;
    if (fullscreenContract.current().id === id) return;
    if (action === 'move' && event.target.closest?.('.clue-panel-tools,button,input,select,textarea,a,[contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    bringToFront(record);
    const start = readPanelGeometry(record);
    layout.pointer = {
      id,
      action,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start,
      captureTarget: event.currentTarget,
    };
    record.panel.classList.add('is-layout-interacting');
    document.documentElement.style.userSelect = 'none';
    document.documentElement.style.cursor = action === 'move' ? 'move' : getComputedStyle(event.currentTarget).cursor;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* global listeners remain authoritative */ }
  }

  function snapToSurfaceEdges(geometry, action) {
    const surface = layout.surface;
    if (!surface) return geometry;
    const threshold = 9;
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    const next = { ...geometry };
    if (action === 'move') {
      if (Math.abs(next.x) <= threshold) next.x = 0;
      if (Math.abs((next.x + next.w) - width) <= threshold) next.x = width - next.w;
      if (Math.abs(next.y) <= threshold) next.y = 0;
      if (Math.abs((next.y + next.h) - height) <= threshold) next.y = height - next.h;
    } else {
      if (action.includes('e') && Math.abs((next.x + next.w) - width) <= threshold) next.w = width - next.x;
      if (action.includes('s') && Math.abs((next.y + next.h) - height) <= threshold) next.h = height - next.y;
      if (action.includes('w') && Math.abs(next.x) <= threshold) { next.w += next.x; next.x = 0; }
      if (action.includes('n') && Math.abs(next.y) <= threshold) { next.h += next.y; next.y = 0; }
    }
    return next;
  }

  function onLayoutPointerMove(event) {
    const active = layout.pointer;
    if (!active || event.pointerId !== active.pointerId) return;
    const record = registry.get(active.id);
    if (!record) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    const start = active.start;
    let next = { ...start };
    if (active.action === 'move') {
      next.x = start.x + dx;
      next.y = start.y + dy;
    } else {
      let left = start.x;
      let top = start.y;
      let right = start.x + start.w;
      let bottom = start.y + start.h;
      if (active.action.includes('e')) right += dx;
      if (active.action.includes('w')) left += dx;
      if (active.action.includes('s')) bottom += dy;
      if (active.action.includes('n')) top += dy;
      const surfaceWidth = layout.surface?.clientWidth || window.innerWidth;
      const surfaceHeight = layout.surface?.clientHeight || Math.max(1, window.innerHeight - layout.surfaceTop);
      const minWidth = Math.min(DYNAMIC_MIN_WIDTH, surfaceWidth);
      const minHeight = Math.min(DYNAMIC_MIN_HEIGHT, surfaceHeight);
      if (right - left < minWidth) {
        if (active.action.includes('w')) left = right - minWidth;
        else right = left + minWidth;
      }
      if (bottom - top < minHeight) {
        if (active.action.includes('n')) top = bottom - minHeight;
        else bottom = top + minHeight;
      }
      left = clamp(left, 0, Math.max(0, surfaceWidth - minWidth));
      top = clamp(top, 0, Math.max(0, surfaceHeight - minHeight));
      right = clamp(right, left + minWidth, surfaceWidth);
      bottom = clamp(bottom, top + minHeight, surfaceHeight);
      next = { x: left, y: top, w: right - left, h: bottom - top };
    }
    if (!event.altKey) next = snapToSurfaceEdges(next, active.action);
    applyPanelGeometry(record, next);
    scheduleLayoutNotify(record.panel);
    event.preventDefault();
  }

  function finishLayoutPointer(event) {
    const active = layout.pointer;
    if (!active || (event && event.pointerId !== active.pointerId)) return;
    const record = registry.get(active.id);
    try { active.captureTarget?.releasePointerCapture?.(active.pointerId); } catch { /* already released */ }
    if (record) {
      record.panel.classList.remove('is-layout-interacting');
      record.dynamicGeometry = readPanelGeometry(record);
      notifyLayout(record.panel);
    }
    layout.pointer = null;
    document.documentElement.style.removeProperty('user-select');
    document.documentElement.style.removeProperty('cursor');
  }

  async function dismissPanel(id) {
    if (layout.mode !== 'dynamic') return false;
    const record = registry.get(id);
    if (!record || record.dismissed) return false;
    if (fullscreenContract.current().id === id) await fullscreenContract.leave();
    record.dynamicGeometry = readPanelGeometry(record);
    record.dismissed = true;
    record.panel.classList.add('clue-panel-dismissed');
    record.panel.setAttribute('aria-hidden', 'true');
    record.close.setAttribute('aria-pressed', 'true');
    notifyLayout(record.panel);
    return true;
  }

  async function leaveAnyFullscreen() {
    // The contract only exits fullscreen it owns: a non-panel element fullscreened by something
    // else is not this shell's to leave, which is the registryHasPanel behaviour it replaces.
    await fullscreenContract.leave();
  }

  async function setCompositionMode(mode) {
    const nextMode = mode === 'dynamic' ? 'dynamic' : 'fixed';
    if (nextMode === layout.mode) return layout.mode;
    finishLayoutPointer();
    await leaveAnyFullscreen();
    createLayoutSwitch();
    const surface = createDynamicSurface();

    if (nextMode === 'dynamic') {
      updateDynamicSurfaceBounds();
      const fixedRects = new Map();
      for (const [id, record] of registry.entries()) fixedRects.set(id, record.panel.getBoundingClientRect());
      layout.mode = 'dynamic';
      document.body.classList.add('clue-layout-dynamic');
      updateCompositionUi();
      updateDynamicSurfaceBounds();
      const bounds = surface.getBoundingClientRect();
      let order = 0;
      for (const [id, record] of registry.entries()) {
        const panel = record.panel;
        const rect = fixedRects.get(id);
        record.originalStyle = panel.getAttribute('style');
        record.originalAriaHidden = panel.getAttribute('aria-hidden');
        record.placeholder = createPlaceholder(record, rect);
        record.dismissed = false;
        record.close.setAttribute('aria-pressed', 'false');
        panel.classList.remove('clue-panel-dismissed');
        panel.removeAttribute('aria-hidden');
        surface.appendChild(panel);
        order += 1;
        if (!record.zIndex) record.zIndex = order + 10;
        layout.zCounter = Math.max(layout.zCounter, record.zIndex);
        const geometry = record.dynamicGeometry || defaultDynamicGeometry(id, rect, bounds);
        applyPanelGeometry(record, geometry);
      }
      requestAnimationFrame(() => {
        for (const record of registry.values()) notifyLayout(record.panel);
      });
    } else {
      layout.mode = 'fixed';
      for (const record of registry.values()) {
        if (!record.dismissed) record.dynamicGeometry = readPanelGeometry(record);
        record.dismissed = false;
        record.panel.classList.remove('clue-panel-dismissed', 'is-layout-interacting');
        record.close.setAttribute('aria-pressed', 'false');
        if (record.placeholder?.isConnected) record.placeholder.replaceWith(record.panel);
        if (record.originalStyle == null) record.panel.removeAttribute('style');
        else record.panel.setAttribute('style', record.originalStyle);
        if (record.originalAriaHidden == null) record.panel.removeAttribute('aria-hidden');
        else record.panel.setAttribute('aria-hidden', record.originalAriaHidden);
        record.placeholder = null;
        record.originalStyle = null;
        record.originalAriaHidden = null;
      }
      document.body.classList.remove('clue-layout-dynamic');
      updateCompositionUi();
      requestAnimationFrame(() => {
        for (const record of registry.values()) notifyLayout(record.panel);
      });
    }
    return layout.mode;
  }

  function onDynamicViewportResize() {
    if (layout.mode !== 'dynamic') return;
    if (layout.resizeRaf) cancelAnimationFrame(layout.resizeRaf);
    layout.resizeRaf = requestAnimationFrame(() => {
      layout.resizeRaf = null;
      updateDynamicSurfaceBounds();
      for (const record of registry.values()) {
        if (record.dismissed || record.panel.parentElement !== layout.surface) continue;
        applyPanelGeometry(record, readPanelGeometry(record));
      }
      window.dispatchEvent(new Event('clue:dynamicviewportresize'));
    });
  }

  function notifyLayout(panel) {
    panel?.dispatchEvent(new CustomEvent('clue:layoutchange', { bubbles: true }));
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  }

  async function toggleFullscreen(id) {
    const record = registry.get(id);
    if (!record) return;
    if (layout.mode === 'dynamic' && record.dismissed) return;
    await fullscreenContract.toggle(id);
  }

  function updateFullscreenUi() {
    const current = fullscreenContract.current();
    for (const [id, { panel, fs, meta }] of registry.entries()) {
      const expanded = current.id === id;
      fs.innerHTML = fullscreenSvg(expanded);
      fs.setAttribute('aria-pressed', String(expanded));
      fs.setAttribute('aria-label', expanded ? `Exit ${meta.title} full screen` : `Open ${meta.title} full screen`);
      panel.classList.toggle('is-fullscreen-workspace', expanded);
    }
  }

  function setPanelState(id, state = 'idle', label = '') {
    const record = registry.get(id);
    if (!record) {
      pendingState.set(id, { state, label });
      return;
    }
    record.panel.dataset.uiState = state;
    const text = label || state.toUpperCase();
    const span = record.state.querySelector('span');
    if (span) span.textContent = text;
    record.state.title = text;
  }

  function pulse(id) {
    const panel = registry.get(id)?.panel;
    if (!panel || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    panel.classList.remove('clue-pulse');
    void panel.offsetWidth;
    panel.classList.add('clue-pulse');
    const old = pulseTimers.get(panel);
    if (old) clearTimeout(old);
    pulseTimers.set(panel, setTimeout(() => panel.classList.remove('clue-pulse'), 800));
  }

  function install() {
    if (installed) return;
    installed = true;
    injectStyles();
    document.body.classList.add('clue-os');
    for (const [id, meta] of Object.entries(PANELS)) ensurePanel(id, meta);
    createDynamicSurface();
    createLayoutSwitch();
    window.addEventListener('pointermove', onLayoutPointerMove, { passive: false });
    window.addEventListener('pointerup', finishLayoutPointer);
    window.addEventListener('pointercancel', finishLayoutPointer);
    window.addEventListener('resize', onDynamicViewportResize);
    window.visualViewport?.addEventListener('resize', onDynamicViewportResize);
    document.addEventListener('fullscreenchange', () => {
      updateFullscreenUi();
      notifyLayout(document.fullscreenElement || null);
    });
    document.addEventListener('keydown', (event) => {
      if (fullscreenContract.handleKey(event)) {
        // Soft fullscreen released; native Escape stays the browser's, observed via
        // fullscreenchange rather than mirrored.
        event.preventDefault();
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        void toggleFullscreen(`q${event.key}`);
        return;
      }
    });
    updateFullscreenUi();
    updateCompositionUi();
  }

  return {
    install,
    setPanelState,
    pulse,
    toggleFullscreen,
    setCompositionMode,
    getCompositionMode: () => layout.mode,
    restoreFixedComposition: () => setCompositionMode('fixed'),
    version: CLUE_UI_VERSION,
  };
})();

ClueInterface.install();
window.__clueInterface = ClueInterface;

/* --------------------------- shared sealed-frame bus ----------------------
 * One SSE connection fans out an identical sealed frame to Q2, Q3 and Q4.
 * Every subscriber is isolated; one renderer can fail without poisoning peers.
 * ------------------------------------------------------------------------- */
const ConsoleFrameBus = (() => {
  const listeners = new Set();
  let lastFrame = null;
  let source = null;
  let requiredProjectIdentity = null;
  let transitionPreviousIdentity = null;
  let suspendedForTransition = false;

  function canonicalIdentity(input) {
    if (!input || typeof input !== 'object') return null;
    const operation = input.operationIdentity && typeof input.operationIdentity === 'object'
      ? input.operationIdentity
      : input;
    const profileGeneration = input.profileGeneration ?? operation.profileGeneration;
    if (
      typeof operation.projectId !== 'string' ||
      typeof operation.targetRootIdentity !== 'string' ||
      typeof operation.projectProfileHash !== 'string' ||
      !Number.isSafeInteger(profileGeneration) || profileGeneration < 1
    ) return null;
    return Object.freeze({
      projectId: operation.projectId,
      targetRootIdentity: operation.targetRootIdentity,
      projectProfileHash: operation.projectProfileHash,
      profileGeneration,
    });
  }

  function frameIdentity(frame) {
    const active = frame?.snapshot?.configuration?.project?.activeProject ?? null;
    return canonicalIdentity({
      ...(active?.operationIdentity ?? {}),
      profileGeneration: active?.profileGeneration,
    });
  }

  function sameIdentity(left, right) {
    return Boolean(left && right &&
      left.projectId === right.projectId &&
      left.targetRootIdentity === right.targetRootIdentity &&
      left.projectProfileHash === right.projectProfileHash &&
      left.profileGeneration === right.profileGeneration);
  }

  function publish(frame) {
    if (suspendedForTransition) return false;
    const identity = frameIdentity(frame);
    if (requiredProjectIdentity && !sameIdentity(requiredProjectIdentity, identity)) {
      console.warn('[sealed-frame bus] rejected stale/cross-project frame', {
        expected: requiredProjectIdentity,
        received: identity,
      });
      return false;
    }
    if (!requiredProjectIdentity && identity) requiredProjectIdentity = identity;
    lastFrame = frame;
    for (const listener of [...listeners]) {
      try { listener(frame); } catch (error) { console.error('sealed-frame subscriber failed (peers continue):', error); }
    }
    return true;
  }

  function connect() {
    try {
      source = new EventSource('/api/console-events');
      source.addEventListener('open', () => {
        updateRibbonStream('sealed', true);
        ClueInterface.setPanelState('q4', 'connecting', 'SEALED STREAM LIVE');
      });
      source.addEventListener('error', () => {
        updateRibbonStream('sealed', false);
        ClueInterface.setPanelState('q4', 'warning', 'SEALED STREAM RECONNECTING');
      });
      source.addEventListener('message', (event) => {
        try { publish(JSON.parse(event.data)); }
        catch { /* malformed frame ignored; the next sealed frame remains authoritative */ }
      });
    } catch (error) {
      ClueInterface.setPanelState('q4', 'unavailable', 'SEALED STREAM UNAVAILABLE');
      console.error('console frame bus bring-up failed (dashboard continues):', error);
    }
  }

  function subscribe(listener, { replay = true } = {}) {
    listeners.add(listener);
    if (replay && lastFrame) queueMicrotask(() => {
      if (listeners.has(listener) && lastFrame) {
        try { listener(lastFrame); } catch (error) { console.error('sealed-frame replay subscriber failed:', error); }
      }
    });
    return () => listeners.delete(listener);
  }

  function parkForProjectTransition(input) {
    const next = canonicalIdentity(input);
    if (!next) return false;
    transitionPreviousIdentity = requiredProjectIdentity ?? frameIdentity(lastFrame);
    requiredProjectIdentity = next;
    suspendedForTransition = true;
    lastFrame = null;
    return true;
  }

  function activateProjectIdentity(input) {
    const next = canonicalIdentity(input);
    if (!next) return false;
    requiredProjectIdentity = next;
    transitionPreviousIdentity = null;
    suspendedForTransition = false;
    lastFrame = null;
    return true;
  }

  function cancelProjectTransition() {
    requiredProjectIdentity = transitionPreviousIdentity;
    transitionPreviousIdentity = null;
    suspendedForTransition = false;
    lastFrame = null;
  }

  connect();
  return {
    subscribe,
    acceptFetchedFrame: (frame) => {
      if (!frame?.snapshot || (lastFrame && frame.revision <= lastFrame.revision)) return false;
      return publish(frame);
    },
    getLastFrame: () => lastFrame,
    projectIdentity: () => requiredProjectIdentity,
    parkForProjectTransition,
    activateProjectIdentity,
    cancelProjectTransition,
    close: () => source?.close(),
  };
})();

/* ----------------------------- Q1 NAVIGATOR ------------------------------ */
(function initQ1Navigator() {
  const nav = $('nav');
  const q1status = $('q1status');
  try {
    if (!nav) throw new Error('navigator host #nav not found');
    const adapter = new SseNavigatorAdapter(nav, '/api/navigator-events');
    window.__q1Navigator = { nav, adapter };
    adapter.addEventListener('status', (event) => {
      const connected = Boolean(event.detail?.connected);
      const q1decision = q1PanelDecision(connected ? 'connected' : 'reconnecting');
      if (q1status) q1status.textContent = q1decision.streamText;
      updateRibbonStream('navigator', connected);
      ClueInterface.setPanelState('q1', q1decision.state, q1decision.label);
      if (connected) ClueInterface.pulse('q1');
    });
    (async () => {
      try {
        await nav.ready;
        adapter.connect();
        if (typeof nav.updateProgress === 'function') await nav.updateProgress({ status: 'AWAITING RECOGNITION STREAM' });
        { const d = q1PanelDecision('awaiting'); ClueInterface.setPanelState('q1', d.state, d.label); }
      } catch (error) {
        { const d = q1PanelDecision('unavailable'); if (q1status) q1status.textContent = d.streamText; ClueInterface.setPanelState('q1', d.state, d.label); }
        console.error('Q1 navigator bring-up failed (dashboard continues):', error);
      }
    })();
  } catch (error) {
    { const d = q1PanelDecision('unavailable'); if (q1status) q1status.textContent = d.streamText; ClueInterface.setPanelState('q1', d.state, d.label); }
    console.error('Q1 navigator construction failed (dashboard continues):', error);
  }
})();

/* ---------------------- Q1 CINEMATIC POWER FLOW -------------------------
 * Lives inside the System Navigator's open shadow root and follows the exact
 * node projections and exact connection instances submitted to its WebGPU
 * scene. It never changes graph truth, node state, metrics, or telemetry.
 * ------------------------------------------------------------------------- */
(function initQ1PowerFlow() {
  const q1 = $('q1');
  const nav = $('nav');
  if (!q1 || !nav) return;

  try { window.__q1EnergyFlow?.remove?.(); } catch { /* previous hot-reload instance is optional */ }
  void mount();

  async function mount() {
    let navigatorInstance;
    try {
      navigatorInstance = await nav.ready;
    } catch (error) {
      console.warn('[Q1 flow] Navigator did not become ready:', error);
      return;
    }

    const shadow = nav.shadowRoot;
    const root = shadow?.querySelector?.('.navigator-root');
    if (!shadow || !root || !navigatorInstance) {
      console.warn('[Q1 flow] Navigator shadow renderer is unavailable.');
      return;
    }

    const oldCanvas = shadow.querySelector('.q1-powerflow-canvas');
    const oldBadge = shadow.querySelector('.q1-powerflow-badge');
    const oldStyle = shadow.querySelector('style[data-q1-powerflow-style]');
    oldCanvas?.remove();
    oldBadge?.remove();
    oldStyle?.remove();

    const style = document.createElement('style');
    style.dataset.q1PowerflowStyle = 'true';
    style.textContent = `
.q1-powerflow-canvas{position:absolute;inset:0;z-index:7;width:100%;height:100%;pointer-events:none;mix-blend-mode:screen;opacity:1}
.q1-powerflow-badge{--q1-flow-color:#00d9ff;position:absolute;z-index:9;left:50%;top:55px;display:flex;align-items:center;gap:8px;min-height:26px;padding:0 10px;pointer-events:none;opacity:0;transform:translate(-50%,-8px) scale(.96);color:#eafcff;background:linear-gradient(180deg,rgba(4,19,31,.92),rgba(0,7,13,.92));border:1px solid color-mix(in srgb,var(--q1-flow-color) 56%,transparent);clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);box-shadow:0 12px 32px rgba(0,0,0,.52),0 0 24px color-mix(in srgb,var(--q1-flow-color) 20%,transparent),inset 0 1px rgba(255,255,255,.06);font:750 8.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.13em;text-transform:uppercase;transition:opacity .20s ease,transform .30s cubic-bezier(.22,1,.36,1);backdrop-filter:blur(12px)}
.q1-powerflow-badge::before{content:"";width:7px;height:7px;border-radius:50%;background:#efffff;box-shadow:0 0 8px #fff,0 0 18px var(--q1-flow-color),0 0 0 4px color-mix(in srgb,var(--q1-flow-color) 14%,transparent)}
.q1-powerflow-badge.is-visible{opacity:1;transform:translate(-50%,0) scale(1)}
.q1-powerflow-badge.is-active::before{animation:q1-flow-badge-beat .38s ease-in-out infinite alternate}
@keyframes q1-flow-badge-beat{from{transform:scale(.72);opacity:.62}to{transform:scale(1.28);opacity:1}}
@media(prefers-reduced-motion:reduce){.q1-powerflow-badge{transition:none}.q1-powerflow-badge.is-active::before{animation:none}}
`;
    shadow.appendChild(style);

    const canvas = document.createElement('canvas');
    canvas.className = 'q1-powerflow-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('div');
    badge.className = 'q1-powerflow-badge';
    badge.textContent = 'ENERGY FLOW ONLINE';
    root.append(canvas, badge);

    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) {
      canvas.remove();
      badge.remove();
      style.remove();
      return;
    }

    const reduceMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const DPR_LIMIT = 2;
    const CASCADE = Object.freeze({ main: [0, 217, 255], secondary: [244, 175, 45], hot: [236, 255, 255] });
    const ASCENT = Object.freeze({ main: [244, 175, 45], secondary: [0, 217, 255], hot: [255, 251, 229] });
    const MAX_CASCADE_EDGES = reduceMotion ? 14 : 28;
    const MAX_CASCADE_DEPTH = reduceMotion ? 3 : 5;

    let cssWidth = 1;
    let cssHeight = 1;
    let dpr = 1;
    let raf = 0;
    let destroyed = false;
    let active = null;
    let sequence = 0;
    let nextAutomaticAt = Infinity;
    let automaticTracePending = false;
    let nextProbeAt = 0;
    let lastGraph = null;
    let lastTopologySignature = '';
    let lastManualType = 'ascent';
    let badgeHideTimer = 0;
    let capturedFrame = null;
    let restoreSceneRender = null;

    const scene = navigatorInstance.scene;
    if (scene && typeof scene.render === 'function') {
      try {
        const originalRender = scene.render;
        const wrappedRender = function q1PowerFlowCapture(frame) {
          capturedFrame = frame;
          return originalRender.call(this, frame);
        };
        scene.render = wrappedRender;
        restoreSceneRender = () => {
          if (scene.render === wrappedRender) scene.render = originalRender;
        };
      } catch (error) {
        console.warn('[Q1 flow] Could not attach the render observer; using Navigator state fallback.', error);
      }
    }

    const triggerButton = createTriggerButton();
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => resize())
      : null;
    resizeObserver?.observe(root);
    if (!resizeObserver) window.addEventListener('resize', resize);

    const scheduleSoon = () => {
      automaticTracePending = true;
      if (!active) {
        nextAutomaticAt = Math.min(
          nextAutomaticAt,
          performance.now() + 700,
        );
      }
    };
    nav.addEventListener('node-added', scheduleSoon);
    nav.addEventListener('semantic-depth', scheduleSoon);
    nav.addEventListener('discovery-complete', scheduleSoon);
    nav.addEventListener('graph-committed', scheduleSoon);

    resize();
    showBadge('ENERGY FLOW ONLINE', CASCADE.main, 1450, false);
    raf = requestAnimationFrame(tick);

    function createTriggerButton() {
      const tools = q1.querySelector('.clue-panel-tools');
      if (!tools) return null;
      q1.querySelector('.q1-flow-trigger')?.remove();
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'clue-tool q1-flow-trigger';
      button.setAttribute('aria-label', 'Trigger Q1 cinematic energy flow');
      button.title = 'Trigger Q1 energy flow now';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 5 13h6l-1 9 9-12h-6.2L13.5 2Z"/></svg>';
      button.style.color = '#f4cf72';
      const fullscreen = tools.querySelector('.clue-tool-fullscreen');
      tools.insertBefore(button, fullscreen || null);
      button.addEventListener('click', () => {
        const kind = lastManualType === 'cascade' ? 'ascent' : 'cascade';
        lastManualType = kind;
        trigger(kind, true);
      });
      return button;
    }

    function resize() {
      const rect = root.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(rect.width));
      const nextHeight = Math.max(1, Math.round(rect.height));
      const nextDpr = Math.min(DPR_LIMIT, Math.max(1, window.devicePixelRatio || 1));
      const pixelWidth = Math.max(1, Math.round(nextWidth * nextDpr));
      const pixelHeight = Math.max(1, Math.round(nextHeight * nextDpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.style.width = `${nextWidth}px`;
        canvas.style.height = `${nextHeight}px`;
      }
      cssWidth = nextWidth;
      cssHeight = nextHeight;
      dpr = nextDpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }

    function rgba(rgb, alpha) {
      return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, alpha))})`;
    }

    function clamp(value, low, high) {
      return value < low ? low : value > high ? high : value;
    }

    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    function smoothstep(t) {
      const p = clamp(t, 0, 1);
      return p * p * (3 - 2 * p);
    }

    function easeOutCubic(t) {
      const p = 1 - clamp(t, 0, 1);
      return 1 - p * p * p;
    }

    function hash01(value) {
      const x = Math.sin(value * 91.733 + 17.17) * 43758.5453123;
      return x - Math.floor(x);
    }

    function distance(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function pointFor(id) {
      const entry = navigatorInstance.lastNodeScreen?.get?.(id);
      if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return null;
      return {
        id,
        x: entry.x,
        y: entry.y,
        r: clamp(Number(entry.radiusPx) || 10, 7, 54),
        depth: Number(entry.depth) || 0,
        node: entry.node || navigatorInstance.model?.nodes?.get?.(id) || null,
      };
    }

    function graphSnapshot() {
      const screen = navigatorInstance.lastNodeScreen;
      if (!(screen instanceof Map) || screen.size < 2) return emptyGraph();

      const frameNodes = Array.isArray(capturedFrame?.nodes) && capturedFrame.nodes.length
        ? capturedFrame.nodes
        : Array.isArray(navigatorInstance.lastRenderNodes)
          ? navigatorInstance.lastRenderNodes
          : [];
      const nodes = [];
      const byId = new Map();
      for (const renderNode of frameNodes) {
        const id = renderNode?.id;
        if (!id || byId.has(id)) continue;
        const point = pointFor(id);
        if (!point) continue;
        const sourceNode = renderNode.sourceNode || point.node || navigatorInstance.model?.nodes?.get?.(id) || null;
        const node = {
          ...point,
          level: Number.isFinite(renderNode.level) ? renderNode.level : Number(sourceNode?.level) || 0,
          degree: 0,
          weight: 0,
          sourceNode,
        };
        byId.set(id, node);
        nodes.push(node);
      }

      if (nodes.length < 2) return emptyGraph();

      const edges = [];
      const seen = new Set();
      const exactEdges = Array.isArray(capturedFrame?.edges) ? capturedFrame.edges : [];
      for (const raw of exactEdges) {
        const fromNode = frameNodes[Number(raw?.fromIndex)];
        const toNode = frameNodes[Number(raw?.toIndex)];
        const from = fromNode?.id;
        const to = toNode?.id;
        if (!from || !to || from === to || !byId.has(from) || !byId.has(to)) continue;
        const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          id: key,
          a: from,
          b: to,
          directedFrom: from,
          directedTo: to,
          weight: Math.max(1, Number(raw?.weight) || 1),
        });
      }

      if (!edges.length && navigatorInstance.model?.aggregatedEdgesFor) {
        const visibleNodes = Array.isArray(navigatorInstance.lastVisibleNodes)
          ? navigatorInstance.lastVisibleNodes.filter((node) => byId.has(node?.id))
          : nodes.map((node) => node.sourceNode).filter(Boolean);
        try {
          const aggregates = navigatorInstance.model.aggregatedEdgesFor(visibleNodes);
          for (const raw of aggregates || []) {
            const from = raw?.from;
            const to = raw?.to;
            if (!from || !to || from === to || !byId.has(from) || !byId.has(to)) continue;
            const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
              id: key,
              a: from,
              b: to,
              directedFrom: raw.directedFrom || from,
              directedTo: raw.directedTo || to,
              weight: Math.max(1, Number(raw.weight) || 1),
            });
          }
        } catch (error) {
          if (!window.__q1FlowGraphWarning) {
            window.__q1FlowGraphWarning = true;
            console.warn('[Q1 flow] Exact connection projection could not be read:', error);
          }
        }
      }

      const adjacency = new Map(nodes.map((node) => [node.id, []]));
      for (const edge of edges) {
        const a = byId.get(edge.a);
        const b = byId.get(edge.b);
        if (!a || !b) continue;
        const length = distance(a, b);
        const enriched = { ...edge, length };
        adjacency.get(a.id).push({ to: b.id, edge: enriched });
        adjacency.get(b.id).push({ to: a.id, edge: enriched });
        a.degree += 1;
        b.degree += 1;
        a.weight += edge.weight;
        b.weight += edge.weight;
      }

      const connectedNodes = nodes.filter((node) => node.degree > 0);
      const signature = `${nodes.length}|${edges.length}|${edges.slice(0, 24).map((edge) => edge.id).join('|')}`;
      return { nodes, connectedNodes, byId, edges, adjacency, signature };
    }

    function emptyGraph() {
      return { nodes: [], connectedNodes: [], byId: new Map(), edges: [], adjacency: new Map(), signature: '0|0' };
    }

    function chooseFromTop(items, count, seed) {
      if (!items.length) return null;
      const limit = Math.min(items.length, Math.max(1, count));
      return items[Math.floor(hash01(seed) * limit)] || items[0];
    }

    function buildCascade(graph, now) {
      if (graph.connectedNodes.length < 2 || !graph.edges.length) return null;
      const ranked = [...graph.connectedNodes].sort((left, right) => {
        const leftDesc = Math.log2(1 + Number(left.sourceNode?.metrics?.totalDescendants || 0));
        const rightDesc = Math.log2(1 + Number(right.sourceNode?.metrics?.totalDescendants || 0));
        const leftScore = left.degree * 2.8 + Math.log2(1 + left.weight) + leftDesc * 0.55 + (1 - left.y / Math.max(1, cssHeight)) * 4.8 + (7 - left.level) * 0.18;
        const rightScore = right.degree * 2.8 + Math.log2(1 + right.weight) + rightDesc * 0.55 + (1 - right.y / Math.max(1, cssHeight)) * 4.8 + (7 - right.level) * 0.18;
        return rightScore - leftScore;
      });
      const source = chooseFromTop(ranked, Math.min(6, ranked.length), sequence * 3.17 + 2.4);
      if (!source) return null;

      const visited = new Set([source.id]);
      const queue = [{ id: source.id, depth: 0, availableAt: now + 170 }];
      const pulses = [];
      while (queue.length && pulses.length < MAX_CASCADE_EDGES) {
        const current = queue.shift();
        const from = graph.byId.get(current.id);
        if (!from || current.depth >= MAX_CASCADE_DEPTH) continue;
        const allNeighbors = (graph.adjacency.get(current.id) || [])
          .filter((entry) => !visited.has(entry.to))
          .map((entry) => ({ ...entry, node: graph.byId.get(entry.to) }))
          .filter((entry) => entry.node);
        if (!allNeighbors.length) continue;

        let candidates = allNeighbors.filter((entry) => entry.node.y >= from.y - Math.max(18, cssHeight * 0.035));
        if (!candidates.length) candidates = allNeighbors;
        candidates.sort((left, right) => {
          const leftVertical = (left.node.y - from.y) / Math.max(1, cssHeight);
          const rightVertical = (right.node.y - from.y) / Math.max(1, cssHeight);
          const leftScore = leftVertical * 3.2 + Math.log2(1 + left.edge.weight) * 0.7 + hash01(sequence + left.node.x * 0.017) * 0.32;
          const rightScore = rightVertical * 3.2 + Math.log2(1 + right.edge.weight) * 0.7 + hash01(sequence + right.node.x * 0.017) * 0.32;
          return rightScore - leftScore;
        });

        const branchLimit = current.depth === 0 ? 4 : current.depth === 1 ? 3 : 2;
        for (let branch = 0; branch < Math.min(branchLimit, candidates.length); branch += 1) {
          if (pulses.length >= MAX_CASCADE_EDGES) break;
          const choice = candidates[branch];
          if (visited.has(choice.to)) continue;
          visited.add(choice.to);
          const to = choice.node;
          const travel = clamp((430 + distance(from, to) * 1.38) * (reduceMotion ? 0.72 : 1), 430, 1120);
          const t0 = current.availableAt + branch * 92;
          const t1 = t0 + travel;
          pulses.push({
            from: from.id,
            to: to.id,
            t0,
            t1,
            depth: current.depth,
            branch,
            amplitude: clamp(1.24 - current.depth * 0.10, 0.66, 1.24),
          });
          queue.push({ id: to.id, depth: current.depth + 1, availableAt: t1 + 65 });
        }
      }

      if (!pulses.length) return null;
      const end = Math.max(...pulses.map((pulse) => pulse.t1)) + 1050;
      return {
        type: 'cascade',
        label: 'TOP-DOWN POWER CASCADE',
        palette: CASCADE,
        start: now,
        end,
        sourceId: source.id,
        terminalId: pulses[pulses.length - 1].to,
        pulses,
      };
    }

    function findAscentPath(graph, origin, topThreshold, strict) {
      const queue = [origin.id];
      const previous = new Map([[origin.id, null]]);
      const depthById = new Map([[origin.id, 0]]);
      const maximumSteps = reduceMotion ? 8 : 13;
      let best = origin.id;
      let bestY = origin.y;
      let cursor = 0;
      while (cursor < queue.length && previous.size < 1600) {
        const currentId = queue[cursor++];
        const current = graph.byId.get(currentId);
        if (!current) continue;
        const currentDepth = depthById.get(currentId) || 0;
        if (current.y < bestY) {
          bestY = current.y;
          best = current.id;
        }
        if (current.id !== origin.id && current.y <= topThreshold) {
          best = current.id;
          break;
        }
        if (currentDepth >= maximumSteps) continue;
        const neighbors = (graph.adjacency.get(current.id) || [])
          .map((entry) => ({ ...entry, node: graph.byId.get(entry.to) }))
          .filter((entry) => entry.node && !previous.has(entry.to))
          .filter((entry) => !strict || entry.node.y <= current.y + Math.max(34, cssHeight * 0.055))
          .sort((left, right) => {
            const leftScore = left.node.y - Math.log2(1 + left.edge.weight) * 8;
            const rightScore = right.node.y - Math.log2(1 + right.edge.weight) * 8;
            return leftScore - rightScore;
          });
        for (const entry of neighbors) {
          previous.set(entry.to, current.id);
          depthById.set(entry.to, currentDepth + 1);
          queue.push(entry.to);
        }
      }
      if (best === origin.id) return [];
      const path = [];
      let id = best;
      while (id) {
        path.push(id);
        id = previous.get(id) || null;
      }
      return path.reverse();
    }

    function buildAscent(graph, now) {
      if (graph.connectedNodes.length < 2 || !graph.edges.length) return null;
      const ordered = [...graph.connectedNodes].sort((a, b) => b.y - a.y);
      const bottomPool = ordered.slice(0, Math.max(2, Math.ceil(ordered.length * 0.28)));
      const origin = chooseFromTop(bottomPool, Math.min(7, bottomPool.length), sequence * 4.31 + 1.7);
      if (!origin) return null;
      const topThreshold = [...graph.connectedNodes].sort((a, b) => a.y - b.y)[Math.max(0, Math.floor(graph.connectedNodes.length * 0.22) - 1)]?.y ?? cssHeight * 0.25;
      let path = findAscentPath(graph, origin, topThreshold, true);
      if (path.length < 2) path = findAscentPath(graph, origin, topThreshold, false);

      if (path.length < 2) {
        const vertical = [...graph.edges]
          .map((edge) => ({ edge, a: graph.byId.get(edge.a), b: graph.byId.get(edge.b) }))
          .filter((entry) => entry.a && entry.b)
          .sort((left, right) => Math.abs(right.a.y - right.b.y) - Math.abs(left.a.y - left.b.y))[0];
        if (!vertical) return null;
        path = vertical.a.y >= vertical.b.y ? [vertical.a.id, vertical.b.id] : [vertical.b.id, vertical.a.id];
      }

      const pulses = [];
      let cursor = now + 170;
      for (let index = 0; index < path.length - 1; index += 1) {
        const from = graph.byId.get(path[index]);
        const to = graph.byId.get(path[index + 1]);
        if (!from || !to) continue;
        const travel = clamp((470 + distance(from, to) * 1.52) * (reduceMotion ? 0.74 : 1), 500, 1220);
        pulses.push({
          from: from.id,
          to: to.id,
          t0: cursor,
          t1: cursor + travel,
          depth: index,
          branch: 0,
          amplitude: 1.16,
        });
        cursor += travel + 105;
      }
      if (!pulses.length) return null;
      return {
        type: 'ascent',
        label: 'BOTTOM-UP ASCENT LINK',
        palette: ASCENT,
        start: now,
        end: pulses[pulses.length - 1].t1 + 1150,
        sourceId: pulses[0].from,
        terminalId: pulses[pulses.length - 1].to,
        pulses,
      };
    }

    function startEvent(kind, graph, now, manual = false) {
      sequence += 1;
      const next = kind === 'ascent' ? buildAscent(graph, now) : buildCascade(graph, now);
      if (!next) {
        if (manual) showBadge('NO CONNECTED LEVEL VISIBLE', [255, 85, 0], 1850, false);
        nextAutomaticAt = now + 1600;
        return false;
      }
      active = next;
      triggerButton?.classList.add('is-active');
      if (triggerButton) {
        triggerButton.style.color = next.type === 'cascade' ? '#aaf5ff' : '#ffe29a';
        triggerButton.style.boxShadow = `0 0 20px ${rgba(next.palette.main, 0.45)}`;
      }
      showBadge(next.label, next.palette.main, Math.max(1300, next.end - now - 300), true);
      ClueInterface.pulse('q1');
      return true;
    }

    function trigger(kind = 'auto', manual = false) {
      const graph = graphSnapshot();
      lastGraph = graph;
      const resolved = kind === 'auto' ? (sequence % 2 === 0 ? 'cascade' : 'ascent') : kind;
      active = null;
      return startEvent(resolved, graph, performance.now(), manual);
    }

    function showBadge(text, color, duration = 1200, isActive = false) {
      clearTimeout(badgeHideTimer);
      badge.textContent = text;
      badge.style.setProperty('--q1-flow-color', `rgb(${color[0]},${color[1]},${color[2]})`);
      badge.classList.toggle('is-active', isActive);
      badge.classList.add('is-visible');
      badgeHideTimer = window.setTimeout(() => {
        badge.classList.remove('is-visible', 'is-active');
      }, Math.max(500, duration));
    }

    function drawLine(a, b, color, width, blur = 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.shadowBlur = blur;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    function drawRoute(event, now) {
      const reveal = smoothstep((now - event.start) / 520);
      const fade = clamp((event.end - now) / 850, 0, 1);
      if (reveal <= 0 || fade <= 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = rgba(event.palette.main, 0.65);
      for (const pulse of event.pulses) {
        const a = pointFor(pulse.from);
        const b = pointFor(pulse.to);
        if (!a || !b) continue;
        const localReady = smoothstep((now - pulse.t0 + 360) / 600);
        const alpha = reveal * fade * localReady;
        drawLine(a, b, rgba(event.palette.main, 0.045 * alpha), 7.5, 8);
        drawLine(a, b, rgba(event.palette.secondary, 0.11 * alpha), 1.15, 4);
      }
      ctx.restore();
    }

    function pulseEnvelope(value) {
      const x = clamp(value, 0, 1);
      return Math.sin(Math.PI * x);
    }

    function drawMovingPulse(pulse, event, now, nodeEnergy) {
      const a = pointFor(pulse.from);
      const b = pointFor(pulse.to);
      if (!a || !b) return;
      const duration = Math.max(1, pulse.t1 - pulse.t0);
      const local = (now - pulse.t0) / duration;
      const after = clamp(1 - (now - pulse.t1) / 720, 0, 1);
      const amplitude = pulse.amplitude || 1;

      if (local >= 1 && after > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = rgba(event.palette.main, 0.9);
        drawLine(a, b, rgba(event.palette.main, 0.10 * after * amplitude), 7 + amplitude * 2, 12);
        drawLine(a, b, rgba(event.palette.hot, 0.20 * after * amplitude), 1.2 + amplitude * 0.5, 5);
        ctx.restore();
      }

      if (local <= 0 || local >= 1) {
        const sourceBurst = pulseEnvelope((now - pulse.t0 + 180) / 520) * amplitude;
        const targetBurst = pulseEnvelope((now - pulse.t1 + 140) / 760) * amplitude;
        if (sourceBurst > 0) nodeEnergy.set(pulse.from, Math.max(nodeEnergy.get(pulse.from) || 0, sourceBurst * 0.72));
        if (targetBurst > 0) nodeEnergy.set(pulse.to, Math.max(nodeEnergy.get(pulse.to) || 0, targetBurst));
        return;
      }

      const headT = easeOutCubic(local);
      const trailT = Math.max(0, headT - (event.type === 'cascade' ? 0.30 : 0.22));
      const tail = { x: lerp(a.x, b.x, trailT), y: lerp(a.y, b.y, trailT) };
      const head = { x: lerp(a.x, b.x, headT), y: lerp(a.y, b.y, headT) };
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / length;
      const ny = dx / length;
      const intensity = pulseEnvelope(local) * amplitude;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = rgba(event.palette.main, 0.98);
      drawLine(tail, head, rgba(event.palette.main, 0.19 + intensity * 0.16), 13 + intensity * 6, 18 + intensity * 14);
      drawLine(tail, head, rgba(event.palette.main, 0.54 + intensity * 0.30), 4.0 + intensity * 2.4, 9 + intensity * 10);
      drawLine(tail, head, rgba(event.palette.hot, 0.88), 1.15 + intensity * 0.95, 4 + intensity * 5);

      for (let index = 1; index <= 4; index += 1) {
        const packetT = headT - index * 0.052;
        if (packetT <= trailT) continue;
        const packetX = lerp(a.x, b.x, packetT) + nx * Math.sin(now * 0.012 + index * 2.1 + pulse.depth) * (1.5 + index * 0.45);
        const packetY = lerp(a.y, b.y, packetT) + ny * Math.sin(now * 0.012 + index * 2.1 + pulse.depth) * (1.5 + index * 0.45);
        ctx.fillStyle = rgba(index % 2 ? event.palette.secondary : event.palette.hot, 0.86 - index * 0.12);
        ctx.shadowColor = rgba(event.palette.main, 0.95);
        ctx.shadowBlur = 7 + intensity * 9;
        ctx.beginPath();
        ctx.arc(packetX, packetY, Math.max(1.0, 2.5 - index * 0.32) * amplitude, 0, Math.PI * 2);
        ctx.fill();
      }

      const headRadius = 6.5 + intensity * 7.5;
      const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, headRadius * 2.5);
      glow.addColorStop(0, rgba(event.palette.hot, 1));
      glow.addColorStop(0.18, rgba(event.palette.secondary, 0.92));
      glow.addColorStop(0.48, rgba(event.palette.main, 0.50));
      glow.addColorStop(1, rgba(event.palette.main, 0));
      ctx.fillStyle = glow;
      ctx.shadowColor = rgba(event.palette.main, 1);
      ctx.shadowBlur = 16 + intensity * 18;
      ctx.beginPath();
      ctx.arc(head.x, head.y, headRadius * 2.5, 0, Math.PI * 2);
      ctx.fill();

      const arrowSize = 5.5 + intensity * 3.5;
      const tx = dx / length;
      const ty = dy / length;
      ctx.fillStyle = rgba(event.palette.hot, 0.95);
      ctx.beginPath();
      ctx.moveTo(head.x + tx * arrowSize, head.y + ty * arrowSize);
      ctx.lineTo(head.x - tx * arrowSize * 0.72 + nx * arrowSize * 0.65, head.y - ty * arrowSize * 0.72 + ny * arrowSize * 0.65);
      ctx.lineTo(head.x - tx * arrowSize * 0.72 - nx * arrowSize * 0.65, head.y - ty * arrowSize * 0.72 - ny * arrowSize * 0.65);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      nodeEnergy.set(pulse.from, Math.max(nodeEnergy.get(pulse.from) || 0, (1 - local) * 0.55 * amplitude));
      nodeEnergy.set(pulse.to, Math.max(nodeEnergy.get(pulse.to) || 0, local * 0.78 * amplitude));
    }

    function drawNodePower(node, energy, palette, now, terminal = false) {
      if (!node || energy <= 0.012) return;
      const intensity = clamp(energy, 0, 1.35);
      const beat = reduceMotion ? 1 : 0.91 + Math.sin(now * 0.010 + node.x * 0.013 + node.y * 0.009) * 0.09;
      const e = intensity * beat;
      const base = clamp(node.r * 0.82, 8, 42);
      const outer = base + 10 + e * 18;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const radial = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, outer * 1.55);
      radial.addColorStop(0, rgba(palette.hot, 0.45 + e * 0.30));
      radial.addColorStop(0.22, rgba(palette.secondary, 0.24 + e * 0.28));
      radial.addColorStop(0.58, rgba(palette.main, 0.13 + e * 0.20));
      radial.addColorStop(1, rgba(palette.main, 0));
      ctx.fillStyle = radial;
      ctx.beginPath();
      ctx.arc(node.x, node.y, outer * 1.55, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowColor = rgba(palette.main, 0.98);
      ctx.shadowBlur = 12 + e * 24;
      ctx.strokeStyle = rgba(palette.hot, 0.36 + e * 0.52);
      ctx.lineWidth = 1.2 + e * 1.8;
      ctx.beginPath();
      ctx.arc(node.x, node.y, base + e * 4, 0, Math.PI * 2);
      ctx.stroke();

      const phase = ((now * 0.00048 + node.x * 0.0017) % 1 + 1) % 1;
      for (let ring = 0; ring < (terminal ? 3 : 2); ring += 1) {
        const progress = (phase + ring / (terminal ? 3 : 2)) % 1;
        const radius = base + 5 + progress * (18 + e * 10);
        ctx.strokeStyle = rgba(ring % 2 ? palette.secondary : palette.main, (1 - progress) * (0.30 + e * 0.35));
        ctx.lineWidth = 0.8 + e * 0.8;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      for (let spark = 0; spark < 4; spark += 1) {
        const angle = now * 0.0024 * (spark % 2 ? -1 : 1) + spark * Math.PI * 0.5 + node.x * 0.002;
        const radius = base + 7 + e * 7;
        ctx.fillStyle = rgba(spark % 2 ? palette.secondary : palette.hot, 0.55 + e * 0.30);
        ctx.shadowBlur = 8 + e * 10;
        ctx.beginPath();
        ctx.arc(node.x + Math.cos(angle) * radius, node.y + Math.sin(angle) * radius, 1.3 + e * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function drawEvent(event, now) {
      drawRoute(event, now);
      const nodeEnergy = new Map();
      for (const pulse of event.pulses) drawMovingPulse(pulse, event, now, nodeEnergy);

      const sourceAge = now - event.start;
      const sourceEnergy = clamp(1 - sourceAge / 1050, 0, 1) * 1.25;
      if (sourceEnergy > 0) nodeEnergy.set(event.sourceId, Math.max(nodeEnergy.get(event.sourceId) || 0, sourceEnergy));
      const terminalArrival = event.pulses[event.pulses.length - 1]?.t1 ?? event.end - 1000;
      const terminalEnergy = pulseEnvelope((now - terminalArrival + 170) / 1250) * 1.30;
      if (terminalEnergy > 0) nodeEnergy.set(event.terminalId, Math.max(nodeEnergy.get(event.terminalId) || 0, terminalEnergy));

      for (const [id, energy] of nodeEnergy) {
        drawNodePower(pointFor(id), energy, event.palette, now, id === event.terminalId);
      }
    }

    function finishEvent(now) {
      if (!active) return;
      active = null;
      triggerButton?.classList.remove('is-active');
      if (triggerButton) {
        triggerButton.style.color = '#f4cf72';
        triggerButton.style.boxShadow = '';
      }
      nextAutomaticAt = Infinity;
    }

    function tick(now) {
      if (destroyed) return;
      raf = requestAnimationFrame(tick);
      resize();
      if (
        canvas.style.visibility === 'hidden' ||
        document.hidden ||
        cssWidth < 40 ||
        cssHeight < 40
      ) return;
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      if (!active && now >= nextProbeAt) {
        nextProbeAt = now + 520;
        const graph = graphSnapshot();
        lastGraph = graph;
        if (graph.signature !== lastTopologySignature) {
          lastTopologySignature = graph.signature;
          if (graph.edges.length) {
            automaticTracePending = true;
            nextAutomaticAt = Math.min(nextAutomaticAt, now + 700);
          }
        }
      }

      if (!active && automaticTracePending && now >= nextAutomaticAt) {
        const graph = graphSnapshot();
        lastGraph = graph;
        const kind = sequence % 2 === 0 ? 'cascade' : 'ascent';
        automaticTracePending = false;
        nextAutomaticAt = Infinity;
        if (!startEvent(kind, graph, now, false)) {
          nextAutomaticAt = Infinity;
        }
      }

      if (active) {
        drawEvent(active, now);
        if (now >= active.end) finishEvent(now);
      }
    }

    function getState() {
      const graph = lastGraph || graphSnapshot();
      return {
        mounted: !destroyed,
        active: active?.type || null,
        sequence,
        visibleNodes: graph.nodes.length,
        visibleConnections: graph.edges.length,
        nextAutomaticAt: Number.isFinite(nextAutomaticAt)
          ? nextAutomaticAt : null,
        automaticTracePending,
        exactWebGpuFrameObserved: Boolean(capturedFrame),
      };
    }

    function remove() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      clearTimeout(badgeHideTimer);
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', resize);
      nav.removeEventListener('node-added', scheduleSoon);
      nav.removeEventListener('semantic-depth', scheduleSoon);
      nav.removeEventListener('discovery-complete', scheduleSoon);
      nav.removeEventListener('graph-committed', scheduleSoon);
      restoreSceneRender?.();
      triggerButton?.remove();
      canvas.remove();
      badge.remove();
      style.remove();
      if (window.__q1EnergyFlow === api) delete window.__q1EnergyFlow;
    }

    const api = {
      trigger: (kind = 'auto') => trigger(kind, true),
      triggerCascade: () => trigger('cascade', true),
      triggerAscent: () => trigger('ascent', true),
      getState,
      remove,
    };
    window.__q1EnergyFlow = api;
    try {
      window.__q1Navigator = { ...(window.__q1Navigator || {}), energyFlow: api };
    } catch { /* diagnostics are optional */ }
  }
})();


/* ---------------- Q1 SURF / DIVE REPOSITORY NAVIGATOR --------------------
 * SURF is the independent deterministic physical repository projection:
 * Project -> Artifact Family -> Environment -> File.
 * DIVE combines the imported Navigator's former semantic ALL overview and
 * semantic DIVE detail: entering DIVE opens the former ALL view, selecting a
 * semantic element drills into the former DIVE view, and a SURF file handoff
 * opens the matching semantic detail directly. Physical inventory truth is
 * never manufactured from semantic units in the browser.
 * ------------------------------------------------------------------------- */
(function initQ1V9RepositoryObservatory() {
  const q1 = $('q1');
  const nav = $('nav');
  if (!q1 || !nav) return;

  try { window.__q1V9?.remove?.(); } catch { /* optional hot-reload cleanup */ }
  void mount();

  async function mount() {
    let navigatorInstance;
    try {
      navigatorInstance = await nav.ready;
    } catch (error) {
      console.warn('[Q1 v9] Navigator did not become ready:', error);
      return;
    }

    const shadow = nav.shadowRoot;
    const root = shadow?.querySelector?.('.navigator-root');
    if (!shadow || !root || !navigatorInstance) {
      console.warn('[Q1 v9] Open Navigator shadow renderer is unavailable.');
      return;
    }

    shadow.querySelector('.q1v9-layer')?.remove();
    shadow.querySelector('style[data-q1v9-style]')?.remove();

    const adapter = window.__q1Navigator?.adapter || null;
    const reduceMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const TAU = Math.PI * 2;
    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
    const MAX_DPR = 2;
    const FAMILY_COLUMNS = 4;
    const FAMILY_CELL_W = 790;
    const FAMILY_CELL_H = 690;
    const FAMILY_ORIGIN_Y = -260;
    const FAMILY_WINDOW_W = 680;
    const FAMILY_WINDOW_H = 510;
    const FAMILY_WINDOW_MIN_W = 360;
    const FAMILY_WINDOW_MIN_H = 290;
    const FAMILY_HEADER_WORLD_H = 44;
    const PROJECT_Y = -930;
    const FILE_PURGE_MS = reduceMotion ? 1 : 1450;
    const SEMANTIC_WARNING_MS = 10_000;
    const DISCOVERY_PULSE_MS = reduceMotion ? 1 : 2200;
    const MODEL_RESCAN_MS = 1300;
    const DRAW_IDLE_MS = 1000;

    const FAMILY_PRESENTATION = Object.freeze({
      ecmascript: { label: 'ECMASCRIPT / WEB RUNTIME', accent: '#6677CC', pattern: 'double', shape: 'hex', glyph: 'JS', order: 0 },
      python: { label: 'PYTHON ECOSYSTEM', accent: '#8BA6C9', pattern: 'dotted', shape: 'diamond', glyph: 'PY', order: 1 },
      jvm: { label: 'JVM ECOSYSTEM', accent: '#B66A61', pattern: 'ticks', shape: 'triangle', glyph: 'JVM', order: 2 },
      dotnet: { label: '.NET ECOSYSTEM', accent: '#8F70C9', pattern: 'cross', shape: 'square', glyph: '.N', order: 3 },
      'native-systems': { label: 'NATIVE SYSTEMS', accent: '#9AA5B1', pattern: 'solid', shape: 'octagon', glyph: 'C', order: 4 },
      'modern-systems': { label: 'MODERN SYSTEMS', accent: '#56AFA6', pattern: 'chevron', shape: 'chevron', glyph: 'SYS', order: 5 },
      'gpu-shader': { label: 'GPU / SHADER', accent: '#B56BD1', pattern: 'wave', shape: 'star', glyph: 'GPU', order: 6 },
      'shell-automation': { label: 'SHELL / AUTOMATION', accent: '#71A97C', pattern: 'dashed', shape: 'terminal', glyph: '>_', order: 7 },
      'data-query-bi': { label: 'DATA / QUERY / BI', accent: '#4BA6A0', pattern: 'segmented', shape: 'cylinder', glyph: 'DB', order: 8 },
      'web-presentation': { label: 'WEB PRESENTATION', accent: '#C98265', pattern: 'angle', shape: 'angle', glyph: '</>', order: 9 },
      configuration: { label: 'CONFIGURATION / SERIALIZATION', accent: '#B8A15C', pattern: 'braces', shape: 'braces', glyph: '{}', order: 10 },
      'build-delivery-cloud': { label: 'BUILD / DELIVERY / CLOUD', accent: '#4F8F9E', pattern: 'chain', shape: 'cube', glyph: 'CI', order: 11 },
      documentation: { label: 'DOCUMENTATION / KNOWLEDGE', accent: '#9A87B5', pattern: 'ruled', shape: 'page', glyph: 'MD', order: 12 },
      'binary-assets': { label: 'BINARY / MEDIA / MODELS', accent: '#737E8F', pattern: 'square', shape: 'diamond', glyph: 'BIN', order: 13 },
      unknown: { label: 'UNKNOWN / UNSUPPORTED', accent: '#B95E70', pattern: 'broken', shape: 'broken', glyph: '?', order: 14 },
    });

    const state = {
      destroyed: false,
      mode: 'surf',
      semanticMode: 'all',
      visible: true,
      streamConnected: null,
      inventoryPhase: 'AWAITING INVENTORY',
      inventoryExpectedCount: null,
      taxonomyVersion: null,
      taxonomyHash: null,
      repositoryId: null,
      projectName: null,
      activeProjectId: null,
      projectProfileHash: null,
      profileGeneration: null,
      recognitionConfigHash: null,
      projectGenerationGuard: createQ1ProjectGenerationGuard(),
      snapshotId: null,
      inventoryHash: null,
      recognitionRunId: null,
      durableResultHash: null,
      files: new Map(),
      families: new Map(),
      environments: new Map(),
      edges: new Map(),
      projectionErrors: [],
      filePositions: new Map(),
      fileSlots: new Map(),
      usedSlotsByEnvironment: new Map(),
      environmentSlots: new Map(),
      familySlots: new Map(),
      familyWindows: new Map(),
      familyBounds: new Map(),
      environmentBounds: new Map(),
      semanticAvailabilityCache: new Map(),
      semanticModelVersion: null,
      screenEntities: [],
      spatialBuckets: new Map(),
      selected: null,
      hovered: null,
      diveContext: null,
      lens: 'off',
      searchQuery: '',
      searchMatches: [],
      userMovedCamera: false,
      hasFitInitialInventory: false,
      dirty: true,
      lastDrawAt: 0,
      lastModelScanAt: 0,
      frame: null,
      restoreSceneRender: null,
      raf: 0,
      cssWidth: 1,
      cssHeight: 1,
      dpr: 1,
      pointer: null,
      camera: { x: 0, y: -40, zoom: 0.42 },
      cameraAnimation: null,
      surfModeButton: null,
      topDiveModeButton: null,
      semanticAllButton: null,
      semanticDiveButton: null,
      nativeModeControl: null,
      nativeModeRestore: [],
      modeObserver: null,
      semanticDrillTimer: 0,
      semanticFocus: null,
      eventDisposers: [],
      resizeObserver: null,
      purgeTimer: 0,
      toastTimer: 0,
      semanticWarningTimer: 0,
      projectIconSource: null,
    };

    const style = document.createElement('style');
    style.dataset.q1v9Style = 'true';
    style.textContent = `
.navigator-root{isolation:isolate}
.q1v9-layer{position:absolute;inset:0;z-index:8;overflow:hidden;pointer-events:none;color:#dff7ff;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.q1v9-layer[data-hidden="true"]{display:none}.q1v9-layer[data-mode="dive"] .q1v9-surf-canvas{display:none}.q1v9-layer[data-mode="dive"] .q1v9-project-icon,.q1v9-layer[data-mode="dive"] .q1v9-semantic-warning{display:none}
.q1v9-surf-canvas{position:absolute;inset:0;z-index:0;width:100%;height:100%;display:block;pointer-events:auto;touch-action:none;cursor:grab;outline:none;background:#01050a}.q1v9-surf-canvas.is-dragging{cursor:grabbing}
.q1v9-project-icon{position:absolute;z-index:4;left:0;top:0;width:128px;height:128px;display:block;transform:translate(-50%,-50%) scale(.94);opacity:0;pointer-events:none;user-select:none;filter:drop-shadow(0 0 10px rgba(0,234,255,.56)) drop-shadow(0 0 24px rgba(0,168,107,.28));transition:opacity .24s ease,transform .24s ease,filter .24s ease}.q1v9-project-icon.is-visible{opacity:.96;transform:translate(-50%,-50%) scale(1)}.q1v9-project-icon.is-selected{filter:drop-shadow(0 0 12px rgba(255,240,174,.92)) drop-shadow(0 0 30px rgba(244,175,45,.54))}.q1v9-project-icon.is-hovered{filter:drop-shadow(0 0 12px rgba(223,251,255,.90)) drop-shadow(0 0 28px rgba(0,234,255,.48))}
.q1v9-command{position:absolute;z-index:13;left:10px;top:9px;width:min(470px,calc(100% - 190px));display:flex;flex-direction:column;gap:6px;pointer-events:auto}
.q1v9-command-main{min-height:37px;padding:6px 7px 6px 10px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center;border:1px solid rgba(100,200,241,.25);background:linear-gradient(145deg,rgba(7,23,37,.94),rgba(1,8,14,.93));clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);box-shadow:0 14px 34px rgba(0,0,0,.48),0 0 25px rgba(0,163,224,.06),inset 0 1px rgba(255,255,255,.05);backdrop-filter:blur(14px)}
.q1v9-identity{min-width:0}.q1v9-kicker{display:flex;align-items:center;gap:7px;color:#77dafd;font:800 8px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.14em}.q1v9-kicker:before{content:"";width:6px;height:6px;border-radius:50%;background:#00a3e0;box-shadow:0 0 11px rgba(0,163,224,.95),0 0 0 3px rgba(0,163,224,.10)}
.q1v9-title{margin-top:4px;color:#e9f9ff;font:750 10.5px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.055em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.q1v9-title b{color:#f4c865}
.q1v9-parity{height:23px;max-width:160px;padding:0 8px;display:flex;align-items:center;gap:5px;border:1px solid rgba(92,171,211,.22);border-radius:999px;color:#7897aa;background:rgba(1,7,13,.58);font:750 7.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.08em;white-space:nowrap}.q1v9-parity:before{content:"";width:5px;height:5px;border-radius:50%;background:#60798a}.q1v9-parity[data-state="ok"]{color:#9cf6c0;border-color:rgba(57,255,136,.30)}.q1v9-parity[data-state="ok"]:before{background:#39ff88;box-shadow:0 0 8px rgba(57,255,136,.84)}.q1v9-parity[data-state="warn"]{color:#ffd47c;border-color:rgba(244,175,45,.30)}.q1v9-parity[data-state="warn"]:before{background:#f4af2d}.q1v9-parity[data-state="bad"]{color:#ff9aa5;border-color:rgba(255,77,94,.34)}.q1v9-parity[data-state="bad"]:before{background:#ff4d5e}
.q1v9-breadcrumb{min-height:20px;padding:5px 9px;border:1px solid rgba(89,171,211,.15);color:#7798ad;background:rgba(1,8,14,.72);font:650 8px/1.25 ui-monospace,Consolas,monospace;letter-spacing:.055em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.q1v9-breadcrumb b{color:#d5f1ff}.q1v9-breadcrumb .family{color:var(--crumb-family,#9fc7dc)}
.q1v9-tools{display:flex;gap:5px;align-items:center}.q1v9-search-wrap{position:relative;flex:1;min-width:0}.q1v9-search{box-sizing:border-box;width:100%;height:29px;padding:0 29px 0 9px;border:1px solid rgba(95,181,224,.23);border-radius:3px;color:#dff7ff;background:rgba(1,8,14,.92);font:650 8.5px/1 ui-monospace,Consolas,monospace;outline:none}.q1v9-search:focus{border-color:rgba(0,163,224,.72);box-shadow:0 0 18px rgba(0,163,224,.13)}.q1v9-search-count{position:absolute;right:7px;top:50%;transform:translateY(-50%);color:#6e93aa;font:750 7px/1 ui-monospace,Consolas,monospace;pointer-events:none}
.q1v9-select,.q1v9-button{height:29px;border:1px solid rgba(96,184,224,.23);border-radius:3px;color:#8cc7df;background:linear-gradient(180deg,rgba(9,28,43,.90),rgba(2,9,16,.94));font:750 7.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.065em;cursor:pointer}.q1v9-select{max-width:150px;padding:0 7px}.q1v9-button{min-width:31px;padding:0 8px}.q1v9-select:hover,.q1v9-button:hover{color:#effcff;border-color:rgba(0,163,224,.62)}
.q1v9-mode{position:absolute;z-index:15;right:10px;top:9px;display:flex;gap:2px;padding:3px;border:1px solid rgba(101,190,231,.26);background:rgba(1,8,14,.95);box-shadow:0 12px 28px rgba(0,0,0,.46);pointer-events:auto}.q1v9-mode button{height:25px;min-width:58px;padding:0 10px;border:0;border-radius:2px;color:#648399;background:transparent;font:800 8px/1 ui-monospace,Consolas,monospace;letter-spacing:.10em;cursor:pointer}.q1v9-mode button.is-active{color:#eafaff;background:rgba(0,163,224,.15);box-shadow:inset 0 0 0 1px rgba(0,163,224,.36)}.q1v9-mode button[data-mode="dive"].is-active{color:#ffe3a1;background:rgba(244,175,45,.13);box-shadow:inset 0 0 0 1px rgba(244,175,45,.38)}
.q1v9-mode.q1v9-mode-header{position:relative;right:auto;top:auto;z-index:auto;flex:0 0 auto;margin:0 2px 0 0;padding:2px;height:27px;box-sizing:border-box;background:rgba(1,8,14,.72);box-shadow:inset 0 1px rgba(255,255,255,.035)}.q1v9-mode.q1v9-mode-header button{height:21px;min-width:52px;padding:0 8px;font-size:7.8px}
.q1v9-stats{position:absolute;z-index:12;left:10px;bottom:10px;display:grid;grid-template-columns:repeat(5,auto);border:1px solid rgba(92,180,222,.18);background:rgba(1,8,14,.78);box-shadow:0 12px 30px rgba(0,0,0,.44);pointer-events:none}.q1v9-stat{min-width:58px;padding:7px 9px;border-right:1px solid rgba(93,174,214,.12)}.q1v9-stat:last-child{border-right:0}.q1v9-stat span{display:block;color:#55778d;font:700 6.8px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.10em}.q1v9-stat b{display:block;margin-top:3px;color:#d9f3ff;font:800 10px/1 ui-monospace,Consolas,monospace}
.q1v9-legend{position:absolute;z-index:13;left:10px;bottom:62px;width:min(322px,calc(100% - 20px));max-height:min(48%,420px);overflow:auto;padding:10px;box-sizing:border-box;border:1px solid rgba(99,187,228,.22);background:rgba(2,10,17,.96);box-shadow:0 18px 42px rgba(0,0,0,.52);pointer-events:auto;visibility:hidden;opacity:0;transform:translateY(8px);transition:.24s}.q1v9-legend.is-open{visibility:visible;opacity:1;transform:none}.q1v9-legend-head{display:flex;justify-content:space-between;margin-bottom:8px;color:#dff7ff;font:800 8px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em}.q1v9-legend-close{border:0;color:#7896a9;background:transparent;cursor:pointer}.q1v9-legend-section{margin-top:8px;padding-top:8px;border-top:1px solid rgba(94,174,214,.13)}.q1v9-legend-label{margin-bottom:6px;color:#5f8197;font:750 7px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em}.q1v9-legend-row{min-height:22px;display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:7px;align-items:center;color:#a9c6d8;font:650 8px/1.25 ui-monospace,Consolas,monospace}.q1v9-legend-swatch{width:18px;height:15px;display:grid;place-items:center;border:1px solid var(--swatch,#00a3e0);border-radius:2px;color:color-mix(in srgb,var(--swatch,#00a3e0) 74%,#fff);background:color-mix(in srgb,var(--swatch,#00a3e0) 10%,rgba(1,8,14,.92));box-shadow:0 0 9px color-mix(in srgb,var(--swatch,#00a3e0) 56%,transparent);font:850 5.5px/1 ui-monospace,Consolas,monospace;overflow:hidden}.q1v9-legend-count{color:#6e91a7}.q1v9-legend-title{margin:10px 0 6px;padding-top:8px;border-top:1px solid rgba(94,174,214,.13);color:#66879c;font:800 7px/1 ui-monospace,Consolas,monospace;letter-spacing:.13em}.q1v9-legend-note{margin-top:8px;color:#69889d;font:600 7.4px/1.45 ui-monospace,Consolas,monospace}.q1v9-legend-row b{color:#6f93a9;font-size:6.8px}.q1v9-legend-core{width:10px;height:10px;border-radius:50%;box-shadow:0 0 9px currentColor}.q1v9-legend-core.stable{color:#00a3e0;background:#00a3e0}.q1v9-legend-core.selected{color:#f4af2d;background:#f4af2d}.q1v9-legend-core.changed{color:#ff5500;background:#ff5500}.q1v9-legend-core.patching{color:#39ff88;background:#39ff88}
.q1v9-inspector{--insp-accent:#00a3e0;position:absolute;z-index:16;right:10px;top:54px;bottom:10px;width:clamp(310px,34%,430px);box-sizing:border-box;padding:14px;overflow:auto;color:#d7edf9;background:rgba(2,10,17,.975);border:1px solid color-mix(in srgb,var(--insp-accent) 43%,rgba(96,184,226,.24));box-shadow:0 26px 68px rgba(0,0,0,.66),0 0 34px color-mix(in srgb,var(--insp-accent) 10%,transparent);pointer-events:auto;visibility:hidden;opacity:0;transform:translateX(24px);transition:.28s}.q1v9-inspector.is-open{visibility:visible;opacity:1;transform:none}.q1v9-insp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.q1v9-insp-kind{color:var(--insp-accent);font:800 7.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.13em}.q1v9-insp-title{margin-top:5px;color:#effbff;font:780 14px/1.25 ui-monospace,Consolas,monospace;word-break:break-word}.q1v9-insp-close{width:25px;height:25px;border:1px solid rgba(112,190,228,.20);color:#7896a9;background:rgba(1,8,14,.48);cursor:pointer}.q1v9-insp-path{margin:7px 0 12px;padding:8px 9px;color:#9fc5d9;background:rgba(0,163,224,.055);border-left:2px solid var(--insp-accent);font:600 8.5px/1.5 ui-monospace,Consolas,monospace;word-break:break-all}.q1v9-insp-section{margin-top:11px;padding-top:9px;border-top:1px solid rgba(94,174,214,.15)}.q1v9-insp-section h4{margin:0 0 7px;color:#64879d;font:800 7.3px/1 ui-monospace,Consolas,monospace;letter-spacing:.13em}.q1v9-insp-grid{display:grid;grid-template-columns:minmax(98px,.42fr) minmax(0,1fr);gap:5px 9px;font:600 8.5px/1.38 ui-monospace,Consolas,monospace}.q1v9-insp-grid dt{color:#607f94}.q1v9-insp-grid dd{margin:0;color:#cde6f4;word-break:break-word}.q1v9-insp-grid .unknown{color:#d8a463}.q1v9-insp-badges,.q1v9-insp-actions{display:flex;flex-wrap:wrap;gap:5px}.q1v9-insp-badge{padding:4px 6px;border:1px solid rgba(101,182,221,.20);color:#8fb7cc;background:rgba(1,8,14,.48);font:750 7px/1 ui-monospace,Consolas,monospace}.q1v9-insp-actions{margin-top:13px}.q1v9-insp-action{min-height:28px;padding:0 9px;border:1px solid rgba(101,190,231,.26);color:#9adcf3;background:rgba(2,9,16,.94);font:800 7.4px/1 ui-monospace,Consolas,monospace;cursor:pointer}.q1v9-insp-action.primary{color:#ffe1a0;border-color:rgba(244,175,45,.4);background:rgba(54,34,7,.54)}
.q1v9-dive-context[hidden]{display:none!important}.q1v9-dive-context{--ctx-accent:#f4af2d;position:absolute;z-index:13;left:10px;top:9px;max-width:min(620px,calc(100% - 180px));padding:9px 11px;border:1px solid color-mix(in srgb,var(--ctx-accent) 46%,rgba(96,184,226,.18));background:rgba(2,9,16,.94);box-shadow:0 14px 34px rgba(0,0,0,.5);pointer-events:none;display:none}.q1v9-layer[data-mode="dive"] .q1v9-dive-context{display:block}.q1v9-dive-context .k{color:#d2aa57;font:800 7px/1 ui-monospace,Consolas,monospace;letter-spacing:.13em}.q1v9-dive-context .p{margin-top:5px;color:#edf9ff;font:750 10px/1.35 ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.q1v9-dive-context .m{margin-top:4px;color:#7898ab;font:600 7.5px/1.3 ui-monospace,Consolas,monospace}
.q1v9-dive-unavailable{position:absolute;z-index:14;left:50%;top:50%;width:min(520px,calc(100% - 40px));padding:20px 22px;box-sizing:border-box;transform:translate(-50%,-50%);border:1px solid rgba(255,85,0,.44);background:rgba(20,8,4,.96);box-shadow:0 28px 74px rgba(0,0,0,.7);pointer-events:none;display:none}.q1v9-dive-unavailable.is-visible{display:block}.q1v9-dive-unavailable h3{margin:0 0 10px;color:#ff9a66;font:800 11px/1 ui-monospace,Consolas,monospace}.q1v9-dive-unavailable p{margin:5px 0;color:#a9c5d5;font:600 9px/1.55 ui-monospace,Consolas,monospace}
.q1v9-semantic-warning{position:absolute;z-index:24;left:50%;top:82px;width:min(560px,calc(100% - 34px));box-sizing:border-box;transform:translate(-50%,-10px);opacity:0;visibility:hidden;pointer-events:none;border:1px solid rgba(255,74,74,.72);background:linear-gradient(145deg,rgba(38,5,8,.97),rgba(14,3,5,.96));box-shadow:0 20px 58px rgba(0,0,0,.72),0 0 26px rgba(255,42,55,.18),inset 0 0 0 1px rgba(255,255,255,.025);clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);transition:opacity .2s ease,transform .2s ease,visibility .2s}.q1v9-semantic-warning.is-visible{opacity:1;visibility:visible;pointer-events:auto;transform:translate(-50%,0)}.q1v9-semantic-warning-head{height:31px;padding:0 8px 0 11px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,82,82,.25);color:#ff8f96;font:900 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em}.q1v9-semantic-warning-close{width:24px;height:22px;border:1px solid rgba(255,107,107,.38);border-radius:2px;color:#ffb0b5;background:rgba(70,8,12,.74);font:800 10px/1 ui-monospace,Consolas,monospace;cursor:pointer}.q1v9-semantic-warning-close:hover{color:#fff;border-color:rgba(255,157,157,.72);background:rgba(112,10,16,.88)}.q1v9-semantic-warning-body{padding:10px 12px 12px}.q1v9-semantic-warning-title{color:#fff0f1;font:850 10px/1.35 ui-monospace,Consolas,monospace}.q1v9-semantic-warning-detail{margin-top:6px;color:#d69aa0;font:650 8px/1.5 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.q1v9-semantic-warning-path{margin-top:7px;padding:6px 7px;border-left:2px solid rgba(255,72,72,.72);color:#ffbec2;background:rgba(76,8,13,.42);font:650 7.5px/1.45 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
.q1v9-empty{position:absolute;z-index:11;left:50%;top:50%;width:min(560px,calc(100% - 42px));padding:22px 24px;box-sizing:border-box;transform:translate(-50%,-50%);text-align:center;border:1px solid rgba(244,175,45,.27);background:rgba(1,8,14,.94);box-shadow:0 24px 62px rgba(0,0,0,.62);pointer-events:none}.q1v9-empty h3{margin:0 0 8px;color:#ffd47c;font:800 10px/1 ui-monospace,Consolas,monospace}.q1v9-empty p{margin:0;color:#7898ab;font:600 8.5px/1.55 ui-monospace,Consolas,monospace}.q1v9-empty code{color:#bfeeff}.q1v9-empty[hidden]{display:none}
.q1v9-toast{position:absolute;z-index:20;left:50%;bottom:16px;padding:8px 11px;transform:translate(-50%,9px);opacity:0;pointer-events:none;color:#dff8ff;background:rgba(2,10,17,.94);border:1px solid rgba(99,187,228,.34);font:750 8px/1.4 ui-monospace,Consolas,monospace;transition:.2s}.q1v9-toast.is-visible{opacity:1;transform:translate(-50%,0)}
@media(max-width:820px){.q1v9-command{width:calc(100% - 112px)}.q1v9-parity{display:none}.q1v9-tools{flex-wrap:wrap}.q1v9-search-wrap{flex-basis:100%}.q1v9-inspector{left:10px;right:10px;top:116px;width:auto}.q1v9-stat:nth-child(n+4){display:none}}
@media(prefers-reduced-motion:reduce){.q1v9-legend,.q1v9-inspector,.q1v9-toast,.q1v9-project-icon,.q1v9-semantic-warning{transition:none!important}}
`;
    shadow.appendChild(style);

    const layer = document.createElement('div');
    layer.className = 'q1v9-layer';
    layer.dataset.mode = 'surf';
    layer.dataset.hidden = 'false';

    const canvas = document.createElement('canvas');
    canvas.className = 'q1v9-surf-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Q1 SURF physical repository projection. Drag empty space to pan; drag section headers to move; drag section edges or corners to resize; wheel to zoom; click to inspect; double-click a file to open its mapped semantic location in DIVE; and press Home to frame the complete repository.');

    const projectIcon = document.createElement('img');
    projectIcon.className = 'q1v9-project-icon';
    projectIcon.alt = '';
    projectIcon.draggable = false;
    projectIcon.decoding = 'async';
    projectIcon.setAttribute('aria-hidden', 'true');

    const command = document.createElement('div');
    command.className = 'q1v9-command';
    command.innerHTML = `
      <div class="q1v9-command-main">
        <div class="q1v9-identity"><div class="q1v9-kicker">PHYSICAL REPOSITORY · SURF</div><div class="q1v9-title">REGISTERED PROJECT · <b>AWAITING INVENTORY</b></div></div>
        <div class="q1v9-parity" data-state="warn">PARITY UNBOUND</div>
      </div>
      <div class="q1v9-breadcrumb"><b>PROJECT</b></div>
      <div class="q1v9-tools">
        <div class="q1v9-search-wrap"><input class="q1v9-search" type="search" spellcheck="false" autocomplete="off" placeholder="SEARCH FILE / PATH / FAMILY / ENVIRONMENT"><span class="q1v9-search-count">0</span></div>
        <select class="q1v9-select" aria-label="Relationship lens"><option value="off">RELATIONS OFF</option><option value="direct">DIRECT · 1 HOP</option><option value="neighborhood">NEIGHBORHOOD · 2 HOPS</option><option value="environment">ENVIRONMENT AGGREGATE</option><option value="cross">CROSS-ENVIRONMENT</option></select>
        <button class="q1v9-button" type="button" data-action="legend">TECH</button>
        <button class="q1v9-button" type="button" data-action="frame">⌂</button>
      </div>`;

    const breadcrumb = command.querySelector('.q1v9-breadcrumb');
    const identityTitle = command.querySelector('.q1v9-title');
    const parity = command.querySelector('.q1v9-parity');
    const searchInput = command.querySelector('.q1v9-search');
    const searchCount = command.querySelector('.q1v9-search-count');
    const lensSelect = command.querySelector('.q1v9-select');

    const stats = document.createElement('div');
    stats.className = 'q1v9-stats';
    stats.innerHTML = '<div class="q1v9-stat"><span>FILES</span><b data-stat="files">0</b></div><div class="q1v9-stat"><span>FAMILIES</span><b data-stat="families">0</b></div><div class="q1v9-stat"><span>ENVIRONMENTS</span><b data-stat="environments">0</b></div><div class="q1v9-stat"><span>UNSUPPORTED</span><b data-stat="unsupported">0</b></div><div class="q1v9-stat"><span>CHANGED</span><b data-stat="changed">0</b></div>';

    const legend = document.createElement('div');
    legend.className = 'q1v9-legend';
    legend.innerHTML = '<div class="q1v9-legend-head"><span>Q1 VISUAL CHANNELS</span><button class="q1v9-legend-close" type="button">✕</button></div><div data-legend-content></div>';

    const inspector = document.createElement('aside');
    inspector.className = 'q1v9-inspector';
    inspector.setAttribute('aria-hidden', 'true');

    const diveContext = document.createElement('div');
    diveContext.className = 'q1v9-dive-context';
    diveContext.innerHTML = '<div class="k">DIVE · SURF FILE HANDOFF</div><div class="p">NO FILE CONTEXT</div><div class="m">A SURF file handoff opens the matching semantic detail.</div>';
    diveContext.hidden = true;

    const diveUnavailable = document.createElement('div');
    diveUnavailable.className = 'q1v9-dive-unavailable';

    const semanticWarning = document.createElement('section');
    semanticWarning.className = 'q1v9-semantic-warning';
    semanticWarning.setAttribute('role', 'alert');
    semanticWarning.setAttribute('aria-live', 'assertive');
    semanticWarning.setAttribute('aria-atomic', 'true');
    semanticWarning.innerHTML = '<div class="q1v9-semantic-warning-head"><span>SEMANTIC CONTENT UNAVAILABLE</span><button class="q1v9-semantic-warning-close" type="button" aria-label="Close semantic content warning">✕</button></div><div class="q1v9-semantic-warning-body"><div class="q1v9-semantic-warning-title">This physical file has no valid semantic DIVE destination.</div><div class="q1v9-semantic-warning-detail">SURF remains active. No semantic location was invented.</div><div class="q1v9-semantic-warning-path"></div></div>';

    const empty = document.createElement('div');
    empty.className = 'q1v9-empty';
    empty.innerHTML = '<h3>SURF PHYSICAL INVENTORY AWAITING DATA</h3><p>SURF does not derive physical repository membership from the semantic DIVE graph. Publish explicit <code>inventory.taxonomy</code> and <code>files.upserted</code> records, or expose the backend-owned RepositoryInventoryModel.</p>';

    const toast = document.createElement('div');
    toast.className = 'q1v9-toast';
    layer.append(canvas, projectIcon, command, stats, legend, inspector, diveContext, diveUnavailable, semanticWarning, empty, toast);
    root.appendChild(layer);

    const semanticWarningClose = semanticWarning.querySelector('.q1v9-semantic-warning-close');
    const closeSemanticWarning = () => dismissSemanticUnavailable();
    semanticWarningClose?.addEventListener('click', closeSemanticWarning);
    state.eventDisposers.push(() =>
      semanticWarningClose?.removeEventListener('click', closeSemanticWarning));

    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) {
      layer.remove();
      style.remove();
      console.warn('[Q1 v9] Canvas fallback context unavailable.');
      return;
    }

    const fallbackMode = document.createElement('div');
    fallbackMode.className = 'q1v9-mode';
    fallbackMode.setAttribute('role', 'group');
    fallbackMode.setAttribute('aria-label', 'Q1 top-level mode');
    fallbackMode.innerHTML = '<button type="button" data-mode="surf">SURF</button><button type="button" data-mode="dive">DIVE</button>';

    installModeControl();
    installSemanticDrillBridge();
    installSceneObserver();
    installInput();
    installEventBridge();

    state.resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    state.resizeObserver?.observe(root);
    if (!state.resizeObserver) window.addEventListener('resize', resize);

    resize();
    ingestAvailableRuntimeState();
    updateAllDerivedState();
    setMode('surf', { requestCore: true, initial: true });
    state.raf = requestAnimationFrame(tick);

    const api = {
      version: 'Q1-SURF-DIVE-REPOSITORY-NAVIGATOR-R2-PERF01',
      renderer: 'canvas2d-contract-bridge',
      setMode: (mode) => setMode(mode, { requestCore: true }),
      getMode: () => state.mode,
      setRelationshipLens: setLens,
      focusFile,
      ingestEvent: ingestNavigatorEvent,
      /**
       * Starts the fail-closed UI half of an atomic Project Profile activation. The runtime/API
       * must call this with the exact successor operation + recognition identity before publishing
       * that project's Navigator stream. Project A is cleared immediately; only the authorised
       * Project B reset/start boundary can then populate the projection.
       */
      activateProjectGeneration: (input) => {
        const identity = state.projectGenerationGuard.authorizeNext(input);
        if (!identity) return false;
        resetProjectProjection(identity, 'PROJECT ACTIVATION PENDING');
        return true;
      },
      cancelProjectGenerationActivation: () => {
        const identity = state.projectGenerationGuard.cancelPending();
        if (!identity) return false;
        resetProjectProjection(identity, 'PROJECT ACTIVATION CANCELLED · REPLAY REQUIRED');
        return true;
      },
      exportInventory: () => ({
        repositoryId: state.repositoryId,
        activeProjectId: state.activeProjectId,
        projectProfileHash: state.projectProfileHash,
        profileGeneration: state.profileGeneration,
        recognitionConfigHash: state.recognitionConfigHash,
        snapshotId: state.snapshotId,
        taxonomyVersion: state.taxonomyVersion,
        expectedFileCount: state.inventoryExpectedCount,
        files: [...state.files.values()].map(serializableFile),
        families: [...state.families.values()].map((item) => ({ ...item })),
        environments: [...state.environments.values()].map((item) => ({ ...item })),
      }),
      verify: verifyProjection,
      getState: () => ({
        mounted: !state.destroyed,
        renderer: 'canvas2d-contract-bridge',
        mode: state.mode,
        semanticMode: state.semanticMode,
        visible: state.visible,
        repositoryId: state.repositoryId,
        activeProjectId: state.activeProjectId,
        projectProfileHash: state.projectProfileHash,
        profileGeneration: state.profileGeneration,
        recognitionConfigHash: state.recognitionConfigHash,
        snapshotId: state.snapshotId,
        runId: state.recognitionRunId,
        files: activeFiles().length,
        families: state.familyBounds.size,
        environments: state.environmentBounds.size,
        edges: state.edges.size,
        selected: state.selected ? { ...state.selected } : null,
        diveContext: state.diveContext ? { ...state.diveContext } : null,
        lens: state.lens,
        verification: verifyProjection(),
      }),
      remove,
    };
    window.__q1V9 = api;
    try { window.__q1Navigator = { ...(window.__q1Navigator || {}), v9: api }; } catch { /* optional diagnostics */ }


    function normalizeToken(value) {
      return String(value == null ? '' : value).trim().toLowerCase()
        .replace(/[\s_/]+/g, '-').replace(/[^a-z0-9+.#-]+/g, '-')
        .replace(/-+/g, '-').replace(/^-|-$/g, '');
    }

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[character]));
    }

    function finite(value, fallback = null) {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function clamp(value, minimum, maximum) {
      return Math.max(minimum, Math.min(maximum, value));
    }

    function getPath(object, path) {
      if (!object || typeof object !== 'object') return undefined;
      const parts = Array.isArray(path) ? path : String(path).split('.');
      let cursor = object;
      for (const part of parts) {
        if (cursor == null || typeof cursor !== 'object' || !(part in cursor)) return undefined;
        cursor = cursor[part];
      }
      return cursor;
    }

    function firstValue(objects, paths, predicate = (value) => value != null) {
      for (const object of objects) {
        for (const path of paths) {
          const value = getPath(object, path);
          if (predicate(value)) return value;
        }
      }
      return undefined;
    }

    function firstText(objects, paths) {
      const value = firstValue(objects, paths, (candidate) => candidate != null && String(candidate).trim() !== '');
      return value == null ? null : String(value).trim();
    }

    function firstArray(objects, paths) {
      const value = firstValue(objects, paths, Array.isArray);
      return Array.isArray(value) ? value : [];
    }

    function asValues(value) {
      if (!value) return [];
      if (value instanceof Map || value instanceof Set) return [...value.values()];
      if (Array.isArray(value)) return value;
      if (typeof value === 'object') return Object.values(value);
      return [];
    }

    function objectCandidates(raw) {
      const candidates = [
        raw, raw?.sourceNode, raw?.record, raw?.file, raw?.repositoryFile,
        raw?.artifact, raw?.metadata, raw?.data, raw?.payload, raw?.detail,
      ];
      return candidates.filter((candidate, index) =>
        candidate && typeof candidate === 'object' && candidates.indexOf(candidate) === index);
    }

    function basename(path) {
      const normalized = String(path || '').replace(/\\/g, '/');
      return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized || 'UNNAMED FILE';
    }

    function stableHash(value) {
      const text = String(value || '');
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    function hash01(value, salt = '') {
      return stableHash(`${salt}\u0000${value}`) / 4294967295;
    }

    function normalizeEntityKind(raw) {
      const objects = objectCandidates(raw);
      const explicit = normalizeToken(firstText(objects, [
        'entityKind', 'nodeKind', 'kind', 'granularity', 'semanticKind', 'levelName', 'type',
      ]) || '');
      if (['file', 'physical-file', 'repository-file', 'artifact-file', 'source-file'].includes(explicit)) return 'file';
      if (['artifact-family', 'family', 'technology-family'].includes(explicit)) return 'family';
      if (['environment', 'artifact-environment', 'runtime-environment', 'language-environment'].includes(explicit)) return 'environment';
      if (['project', 'repository', 'project-root', 'repository-root', 'root'].includes(explicit)) return 'project';
      if (['domain', 'subsystem', 'module', 'class', 'interface', 'type', 'function', 'method', 'capability', 'responsibility'].includes(explicit)) return explicit;
      const locationId = firstText(objects, ['fileLocationId', 'identity.fileLocationId', 'fileIdentity.fileLocationId']);
      const versionId = firstText(objects, ['fileVersionId', 'identity.fileVersionId', 'fileIdentity.fileVersionId']);
      if (locationId || versionId) return 'file';
      return explicit || 'unknown';
    }

    function extractFileRecord(raw, nodeId = null) {
      const objects = objectCandidates(raw);
      if (normalizeEntityKind(raw) !== 'file') return null;

      const path = firstText(objects, [
        'path', 'relativePath', 'repositoryPath', 'filePath',
        'source.path', 'sourceAnchor.path', 'identity.path',
      ]);
      const fileLocationId = firstText(objects, [
        'fileLocationId', 'identity.fileLocationId', 'fileIdentity.fileLocationId', 'locationId',
      ]);
      const fileVersionId = firstText(objects, [
        'fileVersionId', 'identity.fileVersionId', 'fileIdentity.fileVersionId', 'versionId',
      ]);
      if (!path && !fileLocationId) return null;

      const repositoryId = firstText(objects, ['repositoryId', 'identity.repositoryId', 'repository.id']) || state.repositoryId;
      const explicitNodeId = nodeId || firstText(objects, ['nodeId', 'id']);
      if (!fileLocationId && !explicitNodeId) {
        recordProjectionError(
          'FILE_LOCATION_ID_MISSING',
          path || 'file record without a stable physical identity',
        );
        return null;
      }
      const key = fileLocationId || `explicit-file-node:${explicitNodeId}`;
      const familyRaw = firstText(objects, [
        'familyId', 'artifactFamilyId', 'classification.familyId', 'technology.familyId', 'family.id',
      ]);
      const environmentRaw = firstText(objects, [
        'environmentId', 'artifactEnvironmentId', 'classification.environmentId',
        'technology.environmentId', 'environment.id',
      ]);
      const timestamp = performance.now();
      const semanticSummary = firstValue(objects, [
        'semanticSummary', 'recognition.semanticSummary', 'semantic.summary',
      ], (value) => value && typeof value === 'object') || null;

      return {
        key,
        kind: 'file',
        nodeId: explicitNodeId,
        fileLocationId,
        fileVersionId,
        identityComplete: Boolean(fileLocationId && fileVersionId),
        repositoryId,
        snapshotId: firstText(objects, ['snapshotId', 'identity.snapshotId', 'snapshot.id']) || state.snapshotId,
        path: path || null,
        name: firstText(objects, ['name', 'fileName']) || basename(path),
        extension: firstText(objects, ['extension', 'physical.extension']),
        bytes: finite(firstValue(objects, ['bytes', 'size', 'byteLength', 'physical.bytes']), null),
        contentHash: firstText(objects, ['contentHash', 'hash', 'identity.contentHash']),
        physicalFormat: firstText(objects, ['physicalFormat', 'format', 'mediaType', 'physical.format']),
        familyId: normalizeToken(familyRaw || 'unknown') || 'unknown',
        environmentId: normalizeToken(environmentRaw || 'unknown') || 'unknown',
        languageId: firstText(objects, ['languageId', 'classification.languageId', 'technology.languageId']),
        glyphId: firstText(objects, ['glyphId', 'classification.glyphId', 'technology.glyphId']),
        facets: [...new Set(firstArray(objects, [
          'facets', 'classification.facets', 'technology.facets',
        ]).map(String))],
        classificationSource: firstText(objects, ['classification.source', 'classificationSource']),
        classificationConfidence: finite(firstValue(objects, [
          'classification.confidence', 'classificationConfidence',
        ]), null),
        classificationReason: firstText(objects, ['classification.reason', 'classificationReason']),
        classifierVersion: firstText(objects, ['classification.classifierVersion', 'classifierVersion']),
        inventoryState: normalizeToken(firstText(objects, [
          'inventoryState', 'repositoryState', 'changeState', 'lifecycle.inventory',
        ]) || 'committed'),
        recognitionState: normalizeToken(firstText(objects, [
          'recognitionState', 'recognition.state', 'semantic.state', 'adapterState',
        ]) || 'unknown'),
        adapterId: firstText(objects, ['adapterId', 'recognition.adapterId', 'adapter.id']),
        adapterVersion: firstText(objects, ['adapterVersion', 'recognition.adapterVersion', 'adapter.version']),
        semanticDepth: firstText(objects, ['semanticDepth', 'recognition.semanticDepth']),
        semanticSummary,
        semanticMembershipIds: firstArray(objects, [
          'semanticMembershipIds', 'semantic.membershipIds', 'semanticSummary.membershipIds',
        ]).map(String),
        preferredSemanticRootId: firstText(objects, ['preferredSemanticRootId', 'semantic.preferredRootId']),
        semanticDestinationId: firstText(objects, [
          'semanticDestinationId', 'semantic.destinationId',
          'recognition.semanticDestinationId', 'diveDestinationId',
        ]),
        tracked: firstValue(objects, ['tracked', 'repository.tracked'], (value) => typeof value === 'boolean'),
        generated: firstValue(objects, ['generated', 'repository.generated'], (value) => typeof value === 'boolean'),
        excluded: firstValue(objects, ['excluded', 'repository.excluded'], (value) => typeof value === 'boolean'),
        exclusionReason: firstText(objects, ['exclusionReason', 'repository.exclusionReason']),
        dependencies: firstArray(objects, [
          'dependencies', 'fileDependencies', 'outboundDependencies', 'relations.outbound',
        ]),
        inboundDependencies: firstArray(objects, ['inboundDependencies', 'relations.inbound']),
        raw,
        transitionAt: timestamp,
        lastSeenAt: timestamp,
        removedAt: null,
      };
    }

    function presentationForFamily(id) {
      const normalized = normalizeToken(id || 'unknown');
      return FAMILY_PRESENTATION[normalized] || FAMILY_PRESENTATION.unknown;
    }

    function labelFromToken(value) {
      const text = String(value || 'unknown').replace(/[-_]+/g, ' ').trim();
      return (text || 'unknown').toUpperCase();
    }

    function familyDefinition(id) {
      const normalized = normalizeToken(id || 'unknown') || 'unknown';
      const supplied = state.families.get(normalized);
      const fallback = presentationForFamily(normalized);
      return {
        id: normalized,
        label: supplied?.label || fallback.label || labelFromToken(normalized),
        order: finite(supplied?.order, fallback.order),
        accent: supplied?.accentToken || fallback.accent,
        pattern: supplied?.patternToken || fallback.pattern,
        shape: supplied?.shapeToken || fallback.shape || 'circle',
        glyph: supplied?.glyphId || fallback.glyph || '?',
        supplied: Boolean(supplied?.supplied),
      };
    }

    function environmentDefinition(id, familyId = 'unknown') {
      const normalized = normalizeToken(id || 'unknown') || 'unknown';
      const supplied = state.environments.get(normalized);
      return {
        id: normalized,
        familyId: normalizeToken(supplied?.familyId || familyId || 'unknown') || 'unknown',
        label: supplied?.label || labelFromToken(normalized),
        shortLabel: supplied?.shortLabel || null,
        glyphId: supplied?.glyphId || null,
        order: finite(supplied?.order, null),
        adapterId: supplied?.adapterId || null,
        supplied: Boolean(supplied?.supplied),
      };
    }

    function extractTaxonomy(payload) {
      const objects = objectCandidates(payload);
      const familySources = [
        ...firstArray(objects, ['families', 'taxonomy.families', 'artifactFamilies', 'familyDefinitions']),
        ...asValues(firstValue(objects, ['familiesById', 'taxonomy.familiesById'],
          (value) => value && typeof value === 'object')),
      ];
      const environmentSources = [
        ...firstArray(objects, ['environments', 'taxonomy.environments', 'artifactEnvironments', 'environmentDefinitions']),
        ...asValues(firstValue(objects, ['environmentsById', 'taxonomy.environmentsById'],
          (value) => value && typeof value === 'object')),
      ];

      for (const rawFamily of familySources) {
        const objectsForFamily = objectCandidates(rawFamily);
        const id = normalizeToken(firstText(objectsForFamily, ['id', 'familyId']));
        if (!id) continue;
        const fallback = presentationForFamily(id);
        state.families.set(id, {
          id,
          label: firstText(objectsForFamily, ['label', 'name']) || fallback.label,
          order: finite(firstValue(objectsForFamily, ['order', 'index']), fallback.order),
          accentToken: firstText(objectsForFamily, ['accentToken', 'accent', 'color']) || fallback.accent,
          patternToken: firstText(objectsForFamily, ['patternToken', 'pattern']) || fallback.pattern,
          shapeToken: firstText(objectsForFamily, ['shapeToken', 'shape']) || fallback.shape,
          glyphId: firstText(objectsForFamily, ['glyphId', 'familyGlyphId', 'icon']) || fallback.glyph,
          description: firstText(objectsForFamily, ['description']),
          supplied: true,
        });
      }

      for (const rawEnvironment of environmentSources) {
        const objectsForEnvironment = objectCandidates(rawEnvironment);
        const id = normalizeToken(firstText(objectsForEnvironment, ['id', 'environmentId']));
        if (!id) continue;
        state.environments.set(id, {
          id,
          familyId: normalizeToken(firstText(objectsForEnvironment, ['familyId', 'family.id']) || 'unknown') || 'unknown',
          label: firstText(objectsForEnvironment, ['label', 'name']) || labelFromToken(id),
          shortLabel: firstText(objectsForEnvironment, ['shortLabel', 'shortName']),
          glyphId: firstText(objectsForEnvironment, ['glyphId']),
          order: finite(firstValue(objectsForEnvironment, ['order', 'index']), null),
          adapterId: firstText(objectsForEnvironment, ['adapterId']),
          supplied: true,
        });
      }
      state.taxonomyVersion = firstText(objects, ['taxonomyVersion', 'taxonomy.version', 'version']) || state.taxonomyVersion;
      state.taxonomyHash = firstText(objects, ['taxonomyHash', 'taxonomy.hash', 'hash']) || state.taxonomyHash;
      markDirty();
    }

    function classificationAuthority(record) {
      if (!record || typeof record !== 'object') return 0;
      const family = normalizeToken(record.familyId || 'unknown') || 'unknown';
      const environment = normalizeToken(record.environmentId || 'unknown') || 'unknown';
      const source = normalizeToken(record.classificationSource || '');
      const hasKnownClassification = family !== 'unknown' || environment !== 'unknown';
      if (source === 'backend-artifact-taxonomy' || record.classifierVersion) return 3;
      if (hasKnownClassification && source) return 2;
      if (hasKnownClassification) return 1;
      return 0;
    }

    function preserveAuthoritativeClassification(previous, incoming) {
      if (!previous || !incoming) return incoming;
      const previousAuthority = classificationAuthority(previous);
      const incomingAuthority = classificationAuthority(incoming);
      if (incomingAuthority >= previousAuthority || previousAuthority === 0) return incoming;

      // Semantic/recognition upserts are allowed to enrich lifecycle and semantic state,
      // but a weaker or absent classification must never erase the governed physical taxonomy.
      return {
        ...incoming,
        familyId: previous.familyId,
        environmentId: previous.environmentId,
        languageId: previous.languageId,
        glyphId: previous.glyphId,
        facets: Array.isArray(previous.facets) ? previous.facets.slice() : previous.facets,
        classificationSource: previous.classificationSource,
        classificationConfidence: previous.classificationConfidence,
        classificationReason: previous.classificationReason,
        classifierVersion: previous.classifierVersion,
      };
    }

    function upsertFile(raw, nodeId = null, source = 'runtime') {
      let record = raw?.kind === 'file' && raw?.key ? raw : extractFileRecord(raw, nodeId);
      if (!record) return false;
      const previous = state.files.get(record.key);
      if (previous) {
        record = preserveAuthoritativeClassification(previous, record);
        const versionChanged = Boolean(record.fileVersionId && previous.fileVersionId &&
          record.fileVersionId !== previous.fileVersionId);
        const groupChanged = previous.familyId !== record.familyId ||
          previous.environmentId !== record.environmentId;
        const lifecycleChanged = Boolean(
          record.inventoryState &&
          record.inventoryState !== previous.inventoryState
        ) || Boolean(
          record.recognitionState &&
          record.recognitionState !== previous.recognitionState
        );
        const materialChanged = versionChanged || groupChanged ||
          lifecycleChanged ||
          previous.path !== record.path ||
          previous.name !== record.name ||
          previous.bytes !== record.bytes ||
          previous.contentHash !== record.contentHash ||
          previous.snapshotId !== record.snapshotId ||
          previous.classificationConfidence !==
            record.classificationConfidence ||
          previous.classificationReason !== record.classificationReason ||
          previous.adapterId !== record.adapterId ||
          previous.adapterVersion !== record.adapterVersion ||
          previous.semanticDepth !== record.semanticDepth ||
          JSON.stringify(previous.facets || []) !==
            JSON.stringify(record.facets || []) ||
          JSON.stringify(previous.semanticSummary || null) !==
            JSON.stringify(record.semanticSummary || null) ||
          JSON.stringify(previous.semanticMembershipIds || []) !==
            JSON.stringify(record.semanticMembershipIds || []) ||
          previous.preferredSemanticRootId !== record.preferredSemanticRootId ||
          previous.semanticDestinationId !== record.semanticDestinationId;
        if (!materialChanged) {
          previous.lastSeenAt = performance.now();
          previous.raw = record.raw || previous.raw;
          return false;
        }
        state.files.set(record.key, {
          ...previous,
          ...record,
          raw: record.raw || previous.raw,
          transitionAt: versionChanged || groupChanged || lifecycleChanged
            ? performance.now() : previous.transitionAt,
          lastSeenAt: performance.now(),
          removedAt: record.inventoryState === 'removed'
            ? (previous.removedAt || performance.now()) : null,
        });
        if (groupChanged) {
          state.filePositions.delete(record.key);
          releaseFileSlot(previous);
        }
      } else {
        state.files.set(record.key, {
          ...record, source, transitionAt: performance.now(), lastSeenAt: performance.now(),
        });
      }
      const current = state.files.get(record.key);
      state.semanticAvailabilityCache.delete(record.key);
      state.repositoryId = current.repositoryId || state.repositoryId;
      ingestFileDependencies(current);
      ensureFilePosition(current);
      scheduleRemovedPurge();
      markDirty();
      return true;
    }

    function removeFile(identity, detail = null) {
      const candidates = objectCandidates(identity);
      const locationId = typeof identity === 'string' ? identity :
        firstText(candidates, ['fileLocationId', 'identity.fileLocationId', 'id']);
      const path = typeof identity === 'object' ?
        firstText(candidates, ['path', 'relativePath', 'filePath']) : null;
      const record = locationId ? state.files.get(locationId) :
        [...state.files.values()].find((file) => path && file.path === path);
      if (!record) return false;
      state.files.set(record.key, {
        ...record,
        inventoryState: 'removed',
        removedAt: performance.now(),
        transitionAt: performance.now(),
        removalReason: firstText(objectCandidates(detail), ['reason', 'removalReason']),
      });
      scheduleRemovedPurge();
      markDirty();
      return true;
    }

    function scheduleRemovedPurge() {
      clearTimeout(state.purgeTimer);
      const removed = [...state.files.values()].filter((file) => file.removedAt);
      if (!removed.length) return;
      const nextAt = Math.min(...removed.map((file) => file.removedAt + FILE_PURGE_MS));
      state.purgeTimer = window.setTimeout(() => {
        const now = performance.now();
        let changed = false;
        for (const file of [...state.files.values()]) {
          if (!file.removedAt || now - file.removedAt < FILE_PURGE_MS) continue;
          state.files.delete(file.key);
          state.filePositions.delete(file.key);
          releaseFileSlot(file);
          changed = true;
          if (state.selected?.kind === 'file' && state.selected.id === file.key) setSelection(null);
        }
        if (changed) updateAllDerivedState();
        scheduleRemovedPurge();
      }, Math.max(1, nextAt - performance.now() + 16));
    }

    function serializableFile(file) {
      const copy = { ...file };
      delete copy.raw;
      delete copy.dependencies;
      delete copy.inboundDependencies;
      return copy;
    }

    function resolveFileKey(identity) {
      if (!identity) return null;
      if (state.files.has(identity)) return identity;
      const text = String(identity);
      return [...state.files.values()].find((file) =>
        file.fileLocationId === text || file.fileVersionId === text ||
        file.nodeId === text || file.path === text)?.key || null;
    }

    function addFileEdge(fromIdentity, toIdentity, raw = null) {
      const from = resolveFileKey(fromIdentity);
      const to = resolveFileKey(toIdentity);
      if (!from || !to || from === to) return false;
      const objects = objectCandidates(raw);
      const kind = firstText(objects, ['kind', 'relation', 'type']) || 'dependency';
      const directed = firstValue(objects, ['directed'], (value) => typeof value === 'boolean');
      const weight = Math.max(1, finite(firstValue(objects, ['weight', 'count']), 1));
      const id = `${from}\u0000${to}\u0000${normalizeToken(kind) || 'dependency'}`;
      const previous = state.edges.get(id);
      const nextWeight = Math.max(weight, previous?.weight || 0);
      const nextDirected = directed !== false;
      if (
        previous &&
        previous.weight === nextWeight &&
        previous.directed === nextDirected &&
        previous.kind === kind
      ) return false;
      state.edges.set(id, {
        id, from, to, kind, directed: nextDirected,
        weight: nextWeight, raw,
      });
      return true;
    }

    function ingestFileDependencies(file) {
      if (!file) return;
      const ingest = (rawEdge, direction) => {
        const objects = objectCandidates(rawEdge);
        const direct = typeof rawEdge === 'string' ? rawEdge : null;
        const from = direction === 'out' ? file.key :
          firstText(objects, ['fromFileLocationId', 'from', 'sourceFileLocationId', 'source.id']) || direct;
        const to = direction === 'out' ?
          firstText(objects, ['toFileLocationId', 'to', 'targetFileLocationId', 'target.id', 'fileLocationId']) || direct :
          file.key;
        addFileEdge(from, to, rawEdge);
      };
      for (const edge of file.dependencies || []) ingest(edge, 'out');
      for (const edge of file.inboundDependencies || []) ingest(edge, 'in');
    }

    function ingestEdge(raw) {
      const objects = objectCandidates(raw);
      const from = firstText(objects, [
        'fromFileLocationId', 'sourceFileLocationId', 'from.fileLocationId', 'source.fileLocationId',
      ]);
      const to = firstText(objects, [
        'toFileLocationId', 'targetFileLocationId', 'to.fileLocationId', 'target.fileLocationId',
      ]);
      return from && to ? addFileEdge(from, to, raw) : false;
    }


    function eventPayload(event) {
      if (!event) return null;
      if (event.detail?.payload != null) return event.detail.payload;
      if (event.detail != null) return event.detail;
      if (event.payload != null) return event.payload;
      if (event.data != null) {
        if (typeof event.data === 'string') {
          try { return JSON.parse(event.data); } catch { return event.data; }
        }
        return event.data;
      }
      return event;
    }

    function eventType(event, payload) {
      const rawDomType = event?.type || '';
      const normalizedDomType = normalizeToken(rawDomType);
      const genericDomType = [
        'message', 'event', 'navigator-event',
      ].includes(normalizedDomType);
      const payloadType = payload && typeof payload === 'object'
        ? (payload.eventType || payload.event || payload.type)
        : null;
      const payloadKind = payload && typeof payload === 'object'
        ? payload.kind : null;
      return normalizeToken(
        genericDomType
          ? (payloadType || payloadKind || rawDomType)
          : (rawDomType || payloadType || payloadKind),
      ).replace(/\./g, '-');
    }

    function resetProjectProjection(identity, phase = 'PROJECT GENERATION RESET') {
      state.files.clear();
      state.families.clear();
      state.environments.clear();
      state.edges.clear();
      state.filePositions.clear();
      state.fileSlots.clear();
      state.usedSlotsByEnvironment.clear();
      state.environmentSlots.clear();
      state.familySlots.clear();
      state.familyBounds.clear();
      state.environmentBounds.clear();
      state.semanticAvailabilityCache.clear();
      state.screenEntities = [];
      state.spatialBuckets.clear();
      state.repositoryId = identity?.projectId ?? null;
      state.projectName = identity?.projectId ?? null;
      state.activeProjectId = identity?.projectId ?? null;
      state.projectProfileHash = identity?.projectProfileHash ?? null;
      state.profileGeneration = identity?.profileGeneration ?? null;
      state.recognitionConfigHash = identity?.recognitionConfigHash ?? null;
      state.snapshotId = null;
      state.inventoryHash = null;
      state.recognitionRunId = identity?.runId ?? null;
      state.durableResultHash = null;
      state.inventoryExpectedCount = null;
      state.inventoryPhase = phase;
      state.hasFitInitialInventory = false;
      state.userMovedCamera = false;
      state.diveContext = null;
      setSelection(null);
      updateAllDerivedState();
    }

    function ingestNavigatorEvent(event) {
      const received = eventPayload(event);
      if (!received) return false;
      const type = eventType(event, received);
      const envelope = received.v === 1 ? received
        : event.detail?.v === 1 ? event.detail
        : event.v === 1 ? event : null;
      const payload = envelope?.payload ?? received;
      const generationDecision = state.projectGenerationGuard.decide({ event, envelope, payload }, type);
      if (!generationDecision.accept) {
        recordProjectionError(
          generationDecision.reason,
          `ignored ${type || 'navigator event'} outside active Project Profile generation`,
        );
        return false;
      }
      if (generationDecision.requiresReset) {
        resetProjectProjection(
          generationDecision.identity,
          generationDecision.switched ? 'PROJECT GENERATION SWITCH' : 'NAVIGATOR STREAM RESET',
        );
      }
      const objects = objectCandidates(payload);
      const committedInventorySnapshotId = type === 'graph-committed'
        ? firstText(objects, ['inventorySnapshotId']) : null;
      let structuralChanged = false;
      let uiChanged = false;

      if (['navigator-reset', 'inventory-reset', 'reset'].includes(type)) {
        state.inventoryPhase = 'INVENTORY RESET';
        updateAllDerivedState();
        return true;
      }

      if (type.includes('taxonomy')) {
        extractTaxonomy(payload);
        structuralChanged = true;
      }

      const setPhase = (value) => {
        if (state.inventoryPhase !== value) {
          state.inventoryPhase = value;
          uiChanged = true;
        }
      };
      if (['inventory-started', 'inventory-start'].includes(type)) {
        setPhase('INVENTORY STREAMING');
      }
      if (['inventory-completed', 'inventory-complete'].includes(type)) {
        setPhase('INVENTORY COMMITTED');
      }
      if (['recognition-started', 'scan-started'].includes(type)) {
        setPhase('RECOGNITION ENRICHING');
      }
      if ((state.snapshotId || committedInventorySnapshotId) && [
        'graph-committed', 'scan-completed',
        'recognition-completed',
      ].includes(type)) {
        setPhase('SEALED PROJECTION LIVE');
      }

      const assign = (key, value) => {
        if (
          value != null &&
          value !== '' &&
          state[key] !== value
        ) {
          state[key] = value;
          uiChanged = true;
        }
      };
      assign(
        'repositoryId',
        firstText(objects, ['repositoryId', 'repository.id']),
      );
      assign(
        'projectName',
        firstText(objects, [
          'projectName', 'repository.name', 'project.name',
        ]),
      );
      // The stream envelope's snapshot identifies the semantic graph. SURF only
      // takes its physical snapshot from an inventory boundary or a commit binding.
      if (type === 'graph-committed') {
        assign('snapshotId', committedInventorySnapshotId);
      } else if (['inventory-started', 'inventory-start', 'inventory-completed', 'inventory-complete'].includes(type)) {
        assign('snapshotId', firstText(objects, ['snapshotId', 'snapshot.id', 'seal.snapshotId']));
      }
      assign(
        'inventoryHash',
        firstText(objects, [
          'inventoryHash', 'repositoryInventoryHash',
          'seal.inventoryHash',
        ]),
      );
      assign(
        'recognitionRunId',
        firstText(objects, [
          'recognitionRunId', 'runId', 'scanId',
        ]) ?? envelope?.runId,
      );
      assign(
        'durableResultHash',
        firstText(objects, [
          'durableResultHash', 'resultHash',
          'seal.resultHash',
        ]),
      );
      assign(
        'taxonomyVersion',
        firstText(objects, [
          'taxonomyVersion', 'taxonomy.version',
        ]),
      );
      assign(
        'taxonomyHash',
        firstText(objects, [
          'taxonomyHash', 'taxonomy.hash',
        ]),
      );
      const expected = finite(firstValue(objects, [
        'fileCount', 'inventoryFileCount', 'counts.files',
        'inventory.counts.files', 'seal.inventoryFileCount',
      ]), null);
      if (
        expected != null &&
        state.inventoryExpectedCount !== expected
      ) {
        state.inventoryExpectedCount = expected;
        uiChanged = true;
      }

      const files = [
        ...firstArray(objects, [
          'files', 'records', 'fileRecords', 'upserts',
        ]),
        ...asValues(firstValue(objects, [
          'filesById', 'recordsById',
        ], (value) => value && typeof value === 'object')),
      ];
      const singular = firstValue(objects, ['file', 'record'],
        (value) => value && typeof value === 'object');
      if (singular) files.push(singular);
      if (normalizeEntityKind(payload) === 'file') files.push(payload);
      if (
        type.includes('file-upsert') ||
        type.includes('files-upsert') ||
        type.includes('file-observed') ||
        type.includes('file-identified') ||
        files.length
      ) {
        for (const file of files) {
          structuralChanged =
            upsertFile(file, null, type || 'event') ||
            structuralChanged;
        }
      }

      const removed = [...firstArray(objects, [
        'removedFiles', 'removed', 'fileLocationIds',
      ])];
      const removedOne = firstValue(objects, [
        'removedFile', 'fileLocationId',
      ], (value) => value != null);
      if (
        removedOne != null &&
        (type.includes('removed') || type.includes('delete'))
      ) {
        removed.push(removedOne);
      }
      if (
        type.includes('file-removed') ||
        type.includes('files-removed') ||
        type.includes('file-deleted')
      ) {
        if (!removed.length && singular) removed.push(singular);
        for (const identity of removed) {
          structuralChanged =
            removeFile(identity, payload) ||
            structuralChanged;
        }
      }

      const edges = [...firstArray(objects, [
        'fileEdges', 'dependencyEdges', 'relations',
      ])];
      if (
        (type.includes('edge') || type.includes('dependency')) &&
        !edges.length
      ) {
        edges.push(payload);
      }
      for (const edge of edges) {
        uiChanged = ingestEdge(edge) || uiChanged;
      }

      if (type.includes('semantic-summary')) {
        const locationId = firstText(objects, [
          'fileLocationId', 'file.fileLocationId',
        ]);
        const record = locationId
          ? state.files.get(locationId)
          : null;
        if (record) {
          structuralChanged = upsertFile({
            ...record,
            semanticSummary: firstValue(objects, [
              'semanticSummary', 'summary',
            ], (value) => value && typeof value === 'object'),
            recognitionState: firstText(objects, [
              'recognitionState', 'state',
            ]) || record.recognitionState,
          }, record.nodeId, type) || structuralChanged;
        }
      }

      if (structuralChanged) {
        updateAllDerivedState();
      } else if (uiChanged) {
        updateHud();
        renderInspector();
        updateDiveContextUi();
        markDirty();
      }
      if (
        structuralChanged &&
        ['inventory-completed', 'inventory-complete'].includes(type) &&
        !state.userMovedCamera
      ) frameAll(false);
      return structuralChanged || uiChanged;
    }

    function ingestAvailableRuntimeState() {
      try {
        const candidates = [
          navigatorInstance.repositoryInventoryModel,
          navigatorInstance.inventoryModel,
          navigatorInstance.repositoryModel,
          navigatorInstance.model?.repositoryInventory,
          navigatorInstance.model?.inventory,
          navigatorInstance.model,
          adapter?.repositoryInventoryModel,
          adapter?.inventory,
        ].filter(Boolean);

        for (const candidate of candidates) {
          extractTaxonomy(candidate);
          for (const collection of [
            candidate.files, candidate.fileRecords, candidate.repositoryFiles,
            candidate.records, candidate.filesById,
          ]) {
            for (const raw of asValues(collection)) {
              upsertFile(raw, raw?.id || null, 'model');
            }
          }
          for (const collection of [
            candidate.fileEdges, candidate.dependencyEdges, candidate.edges,
          ]) {
            for (const raw of asValues(collection)) ingestEdge(raw);
          }
          const objects = objectCandidates(candidate);
          state.repositoryId = firstText(objects, ['repositoryId', 'repository.id']) || state.repositoryId;
          state.projectName = firstText(objects, ['projectName', 'repository.name', 'project.name']) || state.projectName;
          if (candidate !== navigatorInstance.model && candidate.inventoryStarted !== false) {
            state.snapshotId = firstText(objects, ['snapshotId', 'snapshot.id']) || state.snapshotId;
          }
          state.inventoryExpectedCount = finite(firstValue(objects, [
            'fileCount', 'counts.files', 'inventoryFileCount',
          ]), state.inventoryExpectedCount);
        }
        state.recognitionRunId = adapter?.repositoryInventoryModel?.runId ?? state.recognitionRunId;

        const modelNodes = navigatorInstance.model?.nodes;
        if (modelNodes instanceof Map) {
          for (const [id, raw] of modelNodes.entries()) {
            upsertFile(raw, id, 'explicit-file-node');
          }
        } else {
          for (const raw of asValues(modelNodes)) {
            upsertFile(raw, raw?.id || null, 'explicit-file-node');
          }
        }

        const frameNodes = Array.isArray(state.frame?.nodes) ? state.frame.nodes :
          Array.isArray(navigatorInstance.lastRenderNodes) ?
            navigatorInstance.lastRenderNodes : [];
        for (const raw of frameNodes) {
          upsertFile(raw?.sourceNode || raw, raw?.id || null, 'render-frame-explicit-file');
        }
        if (
          state.files.size > 0 &&
          state.inventoryPhase.includes('AWAITING')
        ) {
          state.inventoryPhase = 'MODEL INVENTORY LIVE';
        }
        updateAllDerivedState();
      } catch (error) {
        recordProjectionError('RUNTIME_STATE_SCAN_FAILED', error?.message || String(error));
      }
    }

    function recordProjectionError(code, detail) {
      const signature = `${code}:${detail}`;
      if (state.projectionErrors.some((item) => item.signature === signature)) return;
      state.projectionErrors.push({
        signature, code, detail, at: new Date().toISOString(),
      });
      if (state.projectionErrors.length > 50) state.projectionErrors.shift();
      markDirty();
    }

    function installEventBridge() {
      // Native Navigator notifications have their own UI listeners.
      // This bridge only ingests recognition stream events.
      const names = [
        'navigator.reset', 'navigator-reset',
        'inventory.started', 'inventory-started',
        'inventory.taxonomy', 'inventory-taxonomy',
        'files.upserted', 'files-upserted',
        'file.upserted', 'file-upserted', 'file.upsert', 'file-upsert',
        'file.observed', 'file-observed',
        'files.removed', 'files-removed',
        'file.removed', 'file-removed', 'file.deleted', 'file-deleted',
        'inventory.completed', 'inventory-completed',
        'recognition.started', 'recognition-started',
        'scan.started', 'scan-started',
        'file.semantic-summary', 'file-semantic-summary',
        'edge.discovered', 'edge-discovered',
        'dependency.discovered', 'dependency-discovered',
        'scan.completed', 'scan-completed',
        'graph.committed', 'graph-committed',
        'message', 'navigator-event', 'event',
      ];
      const attached = new Set();

      const attachTarget = (target) => {
        if (!target?.addEventListener || attached.has(target)) return;
        attached.add(target);
        for (const name of names) {
          const listener = (event) => {
            try {
              ingestNavigatorEvent(event);
            } catch (error) {
              recordProjectionError(
                'EVENT_INGEST_FAILED',
                `${name}: ${error?.message || error}`,
              );
            }
          };
          target.addEventListener(name, listener);
          state.eventDisposers.push(() =>
            target.removeEventListener(name, listener));
        }
      };

      const attachKnownTargets = () => {
        for (const target of [
          adapter,
          nav,
          adapter?.source,
          adapter?.eventSource,
          adapter?._source,
          adapter?.connection,
        ]) attachTarget(target);
      };

      attachKnownTargets();
      const sourceProbeTimer = window.setTimeout(
        attachKnownTargets,
        500,
      );
      state.eventDisposers.push(() =>
        clearTimeout(sourceProbeTimer));

      if (adapter?.addEventListener) {
        const statusListener = (event) => {
          state.streamConnected = Boolean(event.detail?.connected);
          if (
            state.streamConnected &&
            state.inventoryPhase === 'AWAITING INVENTORY'
          ) {
            state.inventoryPhase =
              'STREAM LIVE · AWAITING INVENTORY';
          }
          attachKnownTargets();
          markDirty();
        };
        adapter.addEventListener('status', statusListener);
        state.eventDisposers.push(() =>
          adapter.removeEventListener('status', statusListener));
      }
    }

    function installSceneObserver() {
      const scene = navigatorInstance.scene;
      if (!scene || typeof scene.render !== 'function') return;
      try {
        const previousRender = scene.render;
        const wrapped = function q1V9ObserveFrame(frame) {
          state.frame = frame;
          const modelVersion = finite(navigatorInstance.model?.version, null);
          if (modelVersion !== state.semanticModelVersion) {
            state.semanticModelVersion = modelVersion;
            state.semanticAvailabilityCache.clear();
            state.dirty = true;
          }
          if (state.files.size === 0) state.dirty = true;
          return previousRender.call(this, frame);
        };
        scene.render = wrapped;
        state.restoreSceneRender = () => {
          if (scene.render === wrapped) scene.render = previousRender;
        };
      } catch (error) {
        recordProjectionError(
          'SCENE_OBSERVER_UNAVAILABLE',
          error?.message || String(error),
        );
      }
    }

    function installModeControl() {
      /* SURF/DIVE is the only operator-facing Q1 mode control.
       * Keep it OUTSIDE the Navigator Shadow DOM so a Navigator toolbar rerender
       * cannot replace or cover it.  The imported Navigator's ALL/DIVE buttons
       * remain an invisible semantic bridge used by requestSemanticMode().
       *
       * Important: observe CHILD INSERTION only.  The native Navigator changes
       * class/aria/style state during interaction and animation; observing those
       * attributes creates a high-frequency feedback path and can freeze Q1. */
      let concealRaf = 0;
      const bindAndConcealNativeModeControl = () => {
        concealRaf = 0;

        /* The Navigator has shipped the legacy selector in more than one markup form
         * (button text, span inside button, or data-mode/data-view wrappers).  Detect
         * the ALL/DIVE pair by semantic token rather than by one assumed element type. */
        const tokenOf = (element) => normalizeToken(
          element?.dataset?.mode ||
          element?.getAttribute?.('data-view') ||
          element?.getAttribute?.('data-mode') ||
          element?.textContent,
        );
        const interactiveFor = (element) => {
          if (!element) return null;
          if (element.matches?.('button,[role="button"],[data-mode],[data-view]')) return element;
          return element.closest?.('button,[role="button"],[data-mode],[data-view]') || element;
        };
        const pool = [...shadow.querySelectorAll(
          'button,[role="button"],[data-mode],[data-view],span,div',
        )].filter((element) => !element.closest?.('.q1v9-layer,.q1v9-mode'));

        const allMatches = pool.filter((element) => tokenOf(element) === 'all');
        const diveMatches = pool.filter((element) => tokenOf(element) === 'dive');
        let semanticAllButton = null;
        let semanticDiveButton = null;
        let legacyContainer = null;

        pairSearch:
        for (const allNode of allMatches) {
          const allTarget = interactiveFor(allNode);
          for (const diveNode of diveMatches) {
            const diveTarget = interactiveFor(diveNode);
            if (!allTarget || !diveTarget || allTarget === diveTarget) continue;
            const sameParent = allTarget.parentElement && allTarget.parentElement === diveTarget.parentElement;
            const sameGrandParent = allTarget.parentElement?.parentElement &&
              allTarget.parentElement.parentElement === diveTarget.parentElement?.parentElement;
            if (!sameParent && !sameGrandParent) continue;
            semanticAllButton = allTarget;
            semanticDiveButton = diveTarget;
            legacyContainer = sameParent ? allTarget.parentElement : allTarget.parentElement?.parentElement;
            break pairSearch;
          }
        }

        if (!semanticAllButton || !semanticDiveButton) return false;
        state.semanticAllButton = semanticAllButton;
        state.semanticDiveButton = semanticDiveButton;
        state.nativeModeControl = legacyContainer;

        /* Remove only the legacy selector surface.  Never hide a wider toolbar merely
         * because the selector is nested in it. */
        let concealTargets = [semanticAllButton, semanticDiveButton];
        if (legacyContainer) {
          const interactive = [...legacyContainer.querySelectorAll(
            'button,[role="button"],[data-mode],[data-view]',
          )];
          const meaningful = interactive.filter((item) => {
            const token = tokenOf(item);
            return token || item.offsetParent !== null;
          });
          if (meaningful.length <= 2 && meaningful.every((item) =>
            item === semanticAllButton || item === semanticDiveButton)) {
            concealTargets = [legacyContainer];
          }
        }

        for (const element of concealTargets) {
          if (!element) continue;
          /* Reassert without observing attributes: native rendering code may replace
           * inline styles while keeping the same node. */
          if (element.dataset?.q1v9LegacyModeHidden !== 'true') {
            element.dataset.q1v9LegacyModeHidden = 'true';
            concealLegacyModeElement(element);
          } else {
            element.style.setProperty('display', 'none', 'important');
            element.setAttribute('aria-hidden', 'true');
          }
        }
        syncSemanticModeFromNativeControl();
        return true;
      };
      const scheduleConceal = () => {
        if (concealRaf) return;
        concealRaf = requestAnimationFrame(bindAndConcealNativeModeControl);
      };

      bindAndConcealNativeModeControl();
      state.modeObserver = new MutationObserver(scheduleConceal);
      state.modeObserver.observe(shadow, {
        subtree: true,
        childList: true,
      });
      /* Low-frequency safety pass catches native toolbar code that mutates/reuses an
       * existing selector node without inserting children.  This is intentionally
       * not an attribute MutationObserver and therefore cannot create the previous
       * feedback/freeze loop. */
      const legacyModeSafetyTimer = window.setInterval(() => {
        if (!layer.isConnected) return;
        bindAndConcealNativeModeControl();
      }, 1500);
      state.eventDisposers.push(() => {
        window.clearInterval(legacyModeSafetyTimer);
        if (concealRaf) cancelAnimationFrame(concealRaf);
        concealRaf = 0;
      });

      const panelTools = q1.querySelector('.clue-panel-tools');
      fallbackMode.classList.add('q1v9-mode-header');
      if (panelTools) {
        panelTools.querySelector('.q1v9-mode-header')?.remove();
        panelTools.insertBefore(fallbackMode, panelTools.firstChild);
      } else {
        /* Defensive fallback only; normally Q1 is already normalized by ClueInterface. */
        layer.appendChild(fallbackMode);
        fallbackMode.classList.remove('q1v9-mode-header');
      }

      state.surfModeButton = fallbackMode.querySelector('[data-mode="surf"]');
      state.topDiveModeButton = fallbackMode.querySelector('[data-mode="dive"]');
      const listener = (event) => {
        const button = event.target.closest?.('[data-mode]');
        if (!button) return;
        if (button.dataset.mode === 'surf') {
          setMode('surf', { requestCore: false, fromControl: true });
          return;
        }
        const resetSemanticOverview = state.mode === 'dive';
        setMode('dive', {
          requestCore: true,
          fromControl: true,
          semanticTarget: 'all',
          clearDiveContext: true,
          forceSemantic: resetSemanticOverview,
        });
      };
      fallbackMode.addEventListener('click', listener);
      state.eventDisposers.push(() =>
        fallbackMode.removeEventListener('click', listener));
      updateModeUi();
    }

    function concealLegacyModeElement(element) {
      if (!element) return;
      state.nativeModeRestore.push({
        element,
        style: element.getAttribute('style'),
        ariaHidden: element.getAttribute('aria-hidden'),
      });
      element.style.setProperty('display', 'none', 'important');
      element.setAttribute('aria-hidden', 'true');
    }

    function restoreLegacyModeControl() {
      for (const record of state.nativeModeRestore.splice(0)) {
        const { element, style, ariaHidden } = record;
        if (!element) continue;
        if (style == null) element.removeAttribute('style');
        else element.setAttribute('style', style);
        if (ariaHidden == null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
    }

    function nativeButtonActive(button) {
      if (!button) return false;
      return button.getAttribute('aria-pressed') === 'true' ||
        button.dataset.active === 'true' ||
        button.classList.contains('active') ||
        button.classList.contains('is-active') ||
        button.classList.contains('selected');
    }

    function syncSemanticModeFromNativeControl() {
      const next = nativeButtonActive(state.semanticDiveButton) ? 'dive' :
        nativeButtonActive(state.semanticAllButton) ? 'all' : null;
      if (next) state.semanticMode = next;
      updateModeUi();
    }

    function requestSemanticMode(next, context = null) {
      const semanticTarget = normalizeToken(next) === 'dive' ? 'dive' : 'all';
      if (semanticTarget === 'dive' && context) {
        for (const target of [navigatorInstance, nav]) {
          for (const method of [
            'enterDiveForFile', 'enterDive', 'openFileDive',
            'openDiveContext', 'setDiveContext',
          ]) {
            if (typeof target?.[method] !== 'function') continue;
            try {
              const accepted = target[method](context);
              if (accepted === false) continue;
              state.semanticMode = 'dive';
              updateModeUi();
              queueMicrotask(syncSemanticModeFromNativeControl);
              return true;
            } catch (error) {
              recordProjectionError(
                'DIVE_ENTRY_API_FAILED',
                `${method}: ${error?.message || error}`,
              );
            }
          }
        }
      }

      const expectedButton = semanticTarget === 'all'
        ? state.semanticAllButton : state.semanticDiveButton;
      if (expectedButton) {
        if (!nativeButtonActive(expectedButton)) expectedButton.click();
        state.semanticMode = semanticTarget;
        updateModeUi();
        queueMicrotask(syncSemanticModeFromNativeControl);
        return true;
      }

      for (const target of [navigatorInstance, nav, navigatorInstance.modeState]) {
        for (const method of ['setMode', 'setViewMode', 'switchMode']) {
          if (typeof target?.[method] !== 'function') continue;
          try {
            target[method](semanticTarget);
            state.semanticMode = semanticTarget;
            updateModeUi();
            return true;
          } catch (error) {
            recordProjectionError(
              'MODE_API_FAILED',
              `${method}: ${error?.message || error}`,
            );
          }
        }
      }

      try {
        nav.dispatchEvent(new CustomEvent('q1-semantic-mode-request', {
          detail: { mode: semanticTarget, context },
          bubbles: true,
          composed: true,
        }));
      } catch { /* optional semantic mode bridge */ }
      state.semanticMode = semanticTarget;
      updateModeUi();
      return false;
    }

    function setMode(mode, {
      requestCore = false,
      fromControl = false,
      initial = false,
      semanticTarget = 'all',
      clearDiveContext = false,
      context = null,
      forceSemantic = false,
    } = {}) {
      const next = normalizeToken(mode) === 'dive' ? 'dive' : 'surf';
      const unchanged = next === state.mode;
      if (next === 'dive') {
        if (context) state.diveContext = context;
        else if (clearDiveContext) state.diveContext = null;
      }
      if (unchanged && !initial && !forceSemantic) {
        updateModeUi();
        return state.mode;
      }

      state.mode = next;
      layer.dataset.mode = next;
      const surfVisible = next === 'surf';
      const powerFlow = shadow.querySelector('.q1-powerflow-canvas');
      if (powerFlow) powerFlow.style.visibility = surfVisible ? 'hidden' : '';
      command.style.display = surfVisible ? '' : 'none';
      stats.style.display = surfVisible ? '' : 'none';
      empty.hidden = !surfVisible || activeFiles().filter((file) => !file.excluded).length > 0;

      if (next === 'dive') {
        dismissSemanticUnavailable();
        inspector.classList.remove('is-open');
        inspector.setAttribute('aria-hidden', 'true');
        legend.classList.remove('is-open');
        updateDiveContextUi();
      } else {
        diveContext.hidden = true;
        diveUnavailable.classList.remove('is-visible');
        if (state.selected) renderInspector();
        if (state.diveContext) {
          const originating = [...state.files.values()].find((file) =>
            file.fileLocationId === state.diveContext.fileLocationId ||
            file.key === state.diveContext.fileLocationId);
          if (originating) {
            setSelection({ kind: 'file', id: originating.key });
            frameFile(originating.key, true);
          }
        }
      }
      updateModeUi();
      markDirty();

      if (requestCore) {
        if (next === 'dive') {
          requestSemanticMode(
            semanticTarget,
            semanticTarget === 'dive' ? state.diveContext : null,
          );
        } else if (initial) {
          // Keep the hidden semantic renderer ready on its former ALL overview.
          requestSemanticMode('all');
        }
      }
      try {
        nav.dispatchEvent(new CustomEvent('q1-mode-change', {
          detail: {
            mode: next,
            semanticMode: state.semanticMode,
            source: 'q1-surf-dive-navigator',
            fromControl: Boolean(fromControl),
          },
        }));
      } catch { /* optional projection event */ }
      return state.mode;
    }

    function updateModeUi() {
      state.surfModeButton?.classList.toggle('is-active', state.mode === 'surf');
      state.topDiveModeButton?.classList.toggle('is-active', state.mode === 'dive');
      state.surfModeButton?.setAttribute('aria-pressed', String(state.mode === 'surf'));
      state.topDiveModeButton?.setAttribute('aria-pressed', String(state.mode === 'dive'));
      if (state.surfModeButton) {
        state.surfModeButton.title = 'SURF · physical repository families, environments, directories and files';
      }
      if (state.topDiveModeButton) {
        const detail = state.mode === 'dive' && state.semanticMode === 'dive';
        state.topDiveModeButton.title = detail
          ? 'DIVE detail active · click DIVE again to return to the semantic overview'
          : 'DIVE · semantic overview; select a diagram element to drill into detail';
        state.topDiveModeButton.dataset.semanticState = state.semanticMode;
      }
    }

    function installSemanticDrillBridge() {
      const onSemanticClick = (event) => {
        if (state.mode !== 'dive' || state.semanticMode !== 'all') return;
        const path = typeof event.composedPath === 'function'
          ? event.composedPath() : [];
        if (path.includes(layer)) return;
        if (event.target.closest?.('button,input,select,textarea,a,[role="button"],[contenteditable="true"]')) return;
        const hit = semanticNodeAt(event.clientX, event.clientY);
        if (!hit) return;
        state.semanticFocus = hit;
        clearTimeout(state.semanticDrillTimer);
        state.semanticDrillTimer = window.setTimeout(() => {
          if (state.mode !== 'dive' || state.semanticMode !== 'all') return;
          requestSemanticMode('dive');
          try {
            nav.dispatchEvent(new CustomEvent('q1-semantic-drill-request', {
              detail: {
                nodeId: hit.id,
                node: hit.node || null,
                from: 'legacy-all-overview',
                to: 'legacy-dive-detail',
              },
              bubbles: true,
              composed: true,
            }));
          } catch { /* optional semantic drill event */ }
        }, 0);
      };
      root.addEventListener('click', onSemanticClick);
      state.eventDisposers.push(() =>
        root.removeEventListener('click', onSemanticClick));
    }

    function semanticNodeAt(clientX, clientY) {
      const screen = navigatorInstance.lastNodeScreen;
      if (!(screen instanceof Map) || !screen.size) return null;
      const rect = root.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      let winner = null;
      let bestDistance = Infinity;
      for (const [id, entry] of screen) {
        if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
        const radius = clamp((Number(entry.radiusPx) || 9) * 1.45 + 3, 9, 70);
        const distance = Math.hypot(x - entry.x, y - entry.y);
        if (distance > radius || distance >= bestDistance) continue;
        winner = {
          id,
          node: entry.node || navigatorInstance.model?.nodes?.get?.(id) || null,
          x: entry.x,
          y: entry.y,
          radius,
        };
        bestDistance = distance;
      }
      return winner;
    }

    function familyHitSelection(hit) {
      if (!hit) return null;
      if (hit.kind === 'family-drag' || hit.kind === 'family-resize') {
        return { kind: 'family', id: hit.familyId || hit.id };
      }
      return { kind: hit.kind, id: hit.id };
    }

    function cursorForHit(hit) {
      if (!hit) return 'grab';
      if (hit.kind === 'family-drag') return 'move';
      if (hit.kind === 'family-resize') {
        if (hit.direction === 'n' || hit.direction === 's') return 'ns-resize';
        if (hit.direction === 'e' || hit.direction === 'w') return 'ew-resize';
        if (hit.direction === 'nw' || hit.direction === 'se') return 'nwse-resize';
        return 'nesw-resize';
      }
      return 'pointer';
    }

    function updateFamilyWindowInteraction(pointer, point) {
      const windowState = state.familyWindows.get(pointer.familyId);
      if (!windowState || !pointer.startWindow || !pointer.startWorld) return false;
      const currentWorld = screenToWorld(point.x, point.y);
      const dx = currentWorld.x - pointer.startWorld.x;
      const dy = currentWorld.y - pointer.startWorld.y;
      const start = pointer.startWindow;

      if (pointer.mode === 'family-drag') {
        windowState.x = start.x + dx;
        windowState.y = start.y + dy;
        windowState.userMoved = true;
      } else if (pointer.mode === 'family-resize') {
        const direction = pointer.direction || 'se';
        let minX = start.x - start.width / 2;
        let maxX = start.x + start.width / 2;
        let minY = start.y - start.height / 2;
        let maxY = start.y + start.height / 2;

        if (direction.includes('w')) {
          minX = Math.min(maxX - FAMILY_WINDOW_MIN_W, minX + dx);
        }
        if (direction.includes('e')) {
          maxX = Math.max(minX + FAMILY_WINDOW_MIN_W, maxX + dx);
        }
        if (direction.includes('n')) {
          minY = Math.min(maxY - FAMILY_WINDOW_MIN_H, minY + dy);
        }
        if (direction.includes('s')) {
          maxY = Math.max(minY + FAMILY_WINDOW_MIN_H, maxY + dy);
        }

        windowState.x = (minX + maxX) / 2;
        windowState.y = (minY + maxY) / 2;
        windowState.width = Math.max(FAMILY_WINDOW_MIN_W, maxX - minX);
        windowState.height = Math.max(FAMILY_WINDOW_MIN_H, maxY - minY);
        windowState.userResized = true;
      } else {
        return false;
      }

      // One revision per gesture is sufficient to trigger deterministic reflow.
      windowState.revision = Math.max(1, finite(start.revision, 1) + 1);
      computeGroupBounds();
      state.userMovedCamera = true;
      state.cameraAnimation = null;
      markDirty();
      return true;
    }

    function installInput() {
      const onPointerDown = (event) => {
        if (state.mode !== 'surf' || event.button !== 0) return;
        const point = canvasPoint(event);
        const hit = hitTest(point.x, point.y);
        const familyControl = hit?.kind === 'family-drag' ||
          hit?.kind === 'family-resize';
        const mode = familyControl ? hit.kind : 'camera';
        const familyId = familyControl ? hit.familyId : null;
        const windowState = familyId ? familyWindow(familyId) : null;
        state.pointer = {
          pointerId: event.pointerId,
          mode,
          familyId,
          direction: hit?.direction || null,
          startX: point.x,
          startY: point.y,
          lastX: point.x,
          lastY: point.y,
          startWorld: screenToWorld(point.x, point.y),
          startWindow: windowState ? { ...windowState } : null,
          moved: false,
        };
        if (familyId) setSelection({ kind: 'family', id: familyId });
        canvas.classList.add('is-dragging');
        canvas.style.cursor = cursorForHit(hit);
        try { canvas.setPointerCapture(event.pointerId); } catch { /* optional */ }
        event.preventDefault();
      };

      const onPointerMove = (event) => {
        if (state.mode !== 'surf') return;
        const point = canvasPoint(event);
        if (state.pointer && state.pointer.pointerId === event.pointerId) {
          const dx = point.x - state.pointer.lastX;
          const dy = point.y - state.pointer.lastY;
          if (Math.hypot(
            point.x - state.pointer.startX,
            point.y - state.pointer.startY,
          ) > 3) state.pointer.moved = true;
          if (state.pointer.moved) {
            if (
              state.pointer.mode === 'family-drag' ||
              state.pointer.mode === 'family-resize'
            ) {
              updateFamilyWindowInteraction(state.pointer, point);
            } else {
              state.camera.x -= dx / state.camera.zoom;
              state.camera.y -= dy / state.camera.zoom;
              state.userMovedCamera = true;
              state.cameraAnimation = null;
              markDirty();
            }
          }
          state.pointer.lastX = point.x;
          state.pointer.lastY = point.y;
          event.preventDefault();
          return;
        }

        const hit = hitTest(point.x, point.y);
        const hoverSelection = familyHitSelection(hit);
        const next = hoverSelection ?
          `${hoverSelection.kind}:${hoverSelection.id}` : null;
        const previous = state.hovered ?
          `${state.hovered.kind}:${state.hovered.id}` : null;
        const cursor = cursorForHit(hit);
        if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
        if (next !== previous) {
          state.hovered = hoverSelection;
          updateBreadcrumb();
          markDirty();
        }
      };

      const onPointerUp = (event) => {
        if (!state.pointer || state.pointer.pointerId !== event.pointerId) return;
        const point = canvasPoint(event);
        const pointer = state.pointer;
        state.pointer = null;
        canvas.classList.remove('is-dragging');
        try { canvas.releasePointerCapture(event.pointerId); } catch { /* optional */ }
        const hit = hitTest(point.x, point.y);
        canvas.style.cursor = cursorForHit(hit);
        if (!pointer.moved) {
          setSelection(familyHitSelection(hit));
        } else if (pointer.familyId) {
          setSelection({ kind: 'family', id: pointer.familyId });
        }
        markDirty();
      };

      const onPointerCancel = () => {
        state.pointer = null;
        canvas.classList.remove('is-dragging');
        canvas.style.cursor = 'grab';
      };

      const onPointerLeave = () => {
        if (!state.pointer) {
          state.hovered = null;
          canvas.style.cursor = 'grab';
          updateBreadcrumb();
          markDirty();
        }
      };

      const onDoubleClick = (event) => {
        if (state.mode !== 'surf') return;
        const point = canvasPoint(event);
        const hit = familyHitSelection(hitTest(point.x, point.y));
        if (!hit) frameAll(true);
        else if (hit.kind === 'file') enterDiveFromFile(hit.id);
        else if (hit.kind === 'environment') frameEnvironment(hit.id, true);
        else if (hit.kind === 'family') frameFamily(hit.id, true);
        else frameAll(true);
        event.preventDefault();
      };

      const onWheel = (event) => {
        if (state.mode !== 'surf') return;
        const point = canvasPoint(event);
        const before = screenToWorld(point.x, point.y);
        state.camera.zoom = clamp(
          state.camera.zoom * Math.exp(-event.deltaY * 0.0011),
          0.10,
          4.8,
        );
        const after = screenToWorld(point.x, point.y);
        state.camera.x += before.x - after.x;
        state.camera.y += before.y - after.y;
        state.userMovedCamera = true;
        state.cameraAnimation = null;
        markDirty();
        event.preventDefault();
      };

      const onKeyDown = (event) => {
        if (state.mode !== 'surf') return;
        if (event.key === 'Home' || event.key === '0') {
          frameAll(true);
          event.preventDefault();
        } else if (event.key === 'Escape') {
          if (semanticWarning.classList.contains('is-visible')) {
            dismissSemanticUnavailable();
          } else {
            setSelection(null);
          }
          event.preventDefault();
        } else if (event.key === 'Enter' && state.hovered?.kind === 'file') {
          enterDiveFromFile(state.hovered.id);
          event.preventDefault();
        } else if (event.key === '/' && document.activeElement !== searchInput) {
          searchInput.focus();
          event.preventDefault();
        }
      };

      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerCancel);
      canvas.addEventListener('pointerleave', onPointerLeave);
      canvas.addEventListener('dblclick', onDoubleClick);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('keydown', onKeyDown);
      state.eventDisposers.push(
        () => canvas.removeEventListener('pointerdown', onPointerDown),
        () => canvas.removeEventListener('pointermove', onPointerMove),
        () => canvas.removeEventListener('pointerup', onPointerUp),
        () => canvas.removeEventListener('pointercancel', onPointerCancel),
        () => canvas.removeEventListener('pointerleave', onPointerLeave),
        () => canvas.removeEventListener('dblclick', onDoubleClick),
        () => canvas.removeEventListener('wheel', onWheel),
        () => canvas.removeEventListener('keydown', onKeyDown),
      );

      searchInput.addEventListener('input', () => {
        state.searchQuery = searchInput.value.trim().toLowerCase();
        updateSearchMatches();
      });
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && state.searchMatches.length) {
          focusFile(state.searchMatches[0]);
          event.preventDefault();
        } else if (event.key === 'Escape') {
          searchInput.value = '';
          state.searchQuery = '';
          updateSearchMatches();
          canvas.focus();
        }
      });
      lensSelect.addEventListener('change', () => setLens(lensSelect.value));
      command.querySelector('[data-action="legend"]')?.addEventListener(
        'click',
        () => {
          legend.classList.toggle('is-open');
          renderLegend();
        },
      );
      command.querySelector('[data-action="frame"]')?.addEventListener(
        'click',
        () => frameAll(true),
      );
      legend.querySelector('.q1v9-legend-close')?.addEventListener(
        'click',
        () => legend.classList.remove('is-open'),
      );
      inspector.addEventListener('click', (event) => {
        const action = event.target.closest?.('[data-action]')?.dataset.action;
        if (!action) return;
        if (action === 'close') setSelection(null);
        else if (action === 'dive' && state.selected?.kind === 'file') {
          enterDiveFromFile(state.selected.id);
        } else if (action === 'direct' && state.selected?.kind === 'file') {
          setLens('direct');
        } else if (action === 'copy' && state.selected?.kind === 'file') {
          copyPath(state.selected.id);
        } else if (action === 'frame') frameSelection(true);
      });
    }

    function canvasPoint(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function setLens(value) {
      const allowed = new Set([
        'off', 'direct', 'neighborhood', 'environment', 'cross',
      ]);
      state.lens = allowed.has(value) ? value : 'off';
      lensSelect.value = state.lens;
      markDirty();
      return state.lens;
    }

    function activeFiles() {
      return [...state.files.values()].filter((file) =>
        !file.removedAt ||
        performance.now() - file.removedAt < FILE_PURGE_MS);
    }

    function updateAllDerivedState() {
      for (const file of state.files.values()) ensureFilePosition(file);
      computeGroupBounds();
      updateSearchMatches();
      updateHud();
      renderLegend();
      renderInspector();
      updateDiveContextUi();
      empty.hidden = state.mode !== 'surf' || activeFiles().length > 0;
      if (activeFiles().length && !state.hasFitInitialInventory &&
          !state.userMovedCamera) {
        state.hasFitInitialInventory = true;
        frameAll(false);
      }
      markDirty();
    }

    function isWebRuntimeFamily(familyId) {
      const id = normalizeToken(familyId || 'unknown') || 'unknown';
      const label = familyDefinition(id).label.toUpperCase();
      return id === 'ecmascript' || label.includes('WEB RUNTIME');
    }

    function familySlot(familyId) {
      const id = normalizeToken(familyId || 'unknown') || 'unknown';
      if (state.familySlots.has(id)) return state.familySlots.get(id);
      const definition = familyDefinition(id);
      let slot = Math.max(
        0,
        Math.round(finite(
          definition.order,
          FAMILY_PRESENTATION.unknown.order,
        )),
      );
      const occupied = new Set(
        [...state.familySlots.values()].map((value) => value.slot),
      );
      while (occupied.has(slot)) slot += 1;
      const column = slot % FAMILY_COLUMNS;
      const row = Math.floor(slot / FAMILY_COLUMNS);
      const value = {
        slot,
        x: (column - (FAMILY_COLUMNS - 1) / 2) * FAMILY_CELL_W,
        y: FAMILY_ORIGIN_Y + row * FAMILY_CELL_H,
      };
      state.familySlots.set(id, value);
      return value;
    }

    function familyWindow(familyId) {
      const id = normalizeToken(familyId || 'unknown') || 'unknown';
      const existing = state.familyWindows.get(id);
      if (existing) return existing;
      const slot = familySlot(id);
      const webRuntime = isWebRuntimeFamily(id);
      const value = {
        familyId: id,
        x: slot.x,
        y: slot.y + 78,
        width: webRuntime ? 760 : FAMILY_WINDOW_W,
        height: webRuntime ? 550 : FAMILY_WINDOW_H,
        revision: 1,
        userMoved: false,
        userResized: false,
      };
      state.familyWindows.set(id, value);
      return value;
    }

    function familyWindowBounds(familyId) {
      const windowState = familyWindow(familyId);
      const halfWidth = windowState.width / 2;
      const halfHeight = windowState.height / 2;
      return {
        minX: windowState.x - halfWidth,
        minY: windowState.y - halfHeight,
        maxX: windowState.x + halfWidth,
        maxY: windowState.y + halfHeight,
        width: windowState.width,
        height: windowState.height,
      };
    }

    function ensureEnvironmentOrdinal(familyId, environmentId) {
      const key = `${familyId}\u0000${environmentId}`;
      const existing = state.environmentSlots.get(key);
      if (existing) return existing.slot;
      const definition = environmentDefinition(environmentId, familyId);
      const occupied = new Set(
        [...state.environmentSlots.entries()]
          .filter(([candidate]) => candidate.startsWith(`${familyId}\u0000`))
          .map(([, value]) => value.slot),
      );
      let slot = definition.order != null
        ? Math.max(0, Math.round(definition.order))
        : stableHash(environmentId) % 128;
      while (occupied.has(slot)) slot += 1;
      state.environmentSlots.set(key, { slot });
      return slot;
    }

    function environmentIdsForFamily(familyId) {
      const ids = [...new Set(activeFiles()
        .filter((file) => !file.excluded && file.familyId === familyId)
        .map((file) => file.environmentId))];
      for (const id of ids) ensureEnvironmentOrdinal(familyId, id);
      return ids.sort((left, right) => {
        const leftSlot = ensureEnvironmentOrdinal(familyId, left);
        const rightSlot = ensureEnvironmentOrdinal(familyId, right);
        return leftSlot - rightSlot || left.localeCompare(right);
      });
    }

    function environmentSlot(familyId, environmentId) {
      const windowState = familyWindow(familyId);
      const ids = environmentIdsForFamily(familyId);
      if (!ids.includes(environmentId)) ids.push(environmentId);
      ids.sort((left, right) =>
        ensureEnvironmentOrdinal(familyId, left) -
          ensureEnvironmentOrdinal(familyId, right) ||
        left.localeCompare(right));

      const count = Math.max(1, ids.length);
      const index = Math.max(0, ids.indexOf(environmentId));
      const aspect = windowState.width / Math.max(1, windowState.height);
      let columns;
      if (count <= 2) columns = count;
      else if (count === 3 && aspect >= 1.12) columns = 3;
      else columns = Math.ceil(Math.sqrt(count * Math.max(0.82, aspect)));
      columns = Math.max(1, Math.min(count, Math.min(4, columns)));
      const rows = Math.max(1, Math.ceil(count / columns));

      const horizontalPadding = Math.max(34, Math.min(68, windowState.width * 0.075));
      const topPadding = FAMILY_HEADER_WORLD_H + 35;
      const bottomPadding = 34;
      const innerWidth = Math.max(100, windowState.width - horizontalPadding * 2);
      const innerHeight = Math.max(90, windowState.height - topPadding - bottomPadding);
      const cellWidth = innerWidth / columns;
      const cellHeight = innerHeight / rows;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const left = windowState.x - windowState.width / 2 + horizontalPadding + column * cellWidth;
      const top = windowState.y - windowState.height / 2 + topPadding + row * cellHeight;
      const insetX = Math.min(18, cellWidth * 0.08);
      const insetY = Math.min(15, cellHeight * 0.08);
      const cellBounds = {
        minX: left + insetX,
        minY: top + insetY,
        maxX: left + cellWidth - insetX,
        maxY: top + cellHeight - insetY,
      };
      cellBounds.width = Math.max(1, cellBounds.maxX - cellBounds.minX);
      cellBounds.height = Math.max(1, cellBounds.maxY - cellBounds.minY);

      return {
        slot: ensureEnvironmentOrdinal(familyId, environmentId),
        index,
        count,
        columns,
        rows,
        x: (cellBounds.minX + cellBounds.maxX) / 2,
        y: (cellBounds.minY + cellBounds.maxY) / 2 - Math.min(9, cellBounds.height * 0.04),
        cellWidth: cellBounds.width,
        cellHeight: cellBounds.height,
        cellBounds,
        layoutSignature: `${windowState.revision}:${ids.join('|')}:${columns}x${rows}`,
      };
    }

    function releaseFileSlot(file) {
      if (!file) return;
      const groupKey = `${file.familyId}\u0000${file.environmentId}`;
      const slot = state.fileSlots.get(file.key);
      if (slot != null) {
        state.usedSlotsByEnvironment.get(groupKey)?.delete(slot);
      }
      state.fileSlots.delete(file.key);
    }

    function ensureFilePosition(file) {
      if (!file) return null;
      const environment = environmentSlot(
        file.familyId,
        file.environmentId,
      );
      const existing = state.filePositions.get(file.key);
      if (
        existing &&
        existing.familyId === file.familyId &&
        existing.environmentId === file.environmentId &&
        existing.layoutSignature === environment.layoutSignature
      ) {
        return existing;
      }

      const groupKey = `${file.familyId}\u0000${file.environmentId}`;
      if (!state.usedSlotsByEnvironment.has(groupKey)) {
        state.usedSlotsByEnvironment.set(groupKey, new Set());
      }
      const used = state.usedSlotsByEnvironment.get(groupKey);
      const identity = file.fileLocationId || file.key;
      const slot = state.fileSlots.get(file.key) ?? stableHash(identity);
      used.add(slot);
      state.fileSlots.set(file.key, slot);

      const angle = hash01(identity, 'constellation-angle') * TAU +
        (slot % 29) * GOLDEN_ANGLE * 0.11;
      const radial = 0.22 + 0.76 * Math.sqrt(hash01(identity, 'constellation-radius'));
      const maxX = Math.max(34, environment.cellWidth * 0.40 - 13);
      const maxY = Math.max(29, environment.cellHeight * 0.34 - 12);
      const position = {
        familyId: file.familyId,
        environmentId: file.environmentId,
        x: environment.x + Math.cos(angle) * maxX * radial,
        y: environment.y + 14 + Math.sin(angle) * maxY * radial,
        slot,
        layoutSignature: environment.layoutSignature,
      };
      state.filePositions.set(file.key, position);
      return position;
    }

    function computeGroupBounds() {
      state.familyBounds.clear();
      state.environmentBounds.clear();
      const groups = new Map();

      for (const file of activeFiles()) {
        if (file.excluded) continue;
        const position = ensureFilePosition(file);
        const key = `${file.familyId}\u0000${file.environmentId}`;
        if (!groups.has(key)) {
          groups.set(key, {
            familyId: file.familyId,
            environmentId: file.environmentId,
            files: [],
            position: environmentSlot(file.familyId, file.environmentId),
          });
        }
        groups.get(key).files.push({ file, position });
      }

      for (const group of groups.values()) {
        const contentBounds = boundsForPoints(
          group.files.map((item) => item.position).concat(group.position),
          28,
        );
        const cell = group.position.cellBounds;
        const bounds = boundsForPoints([
          { x: contentBounds.minX, y: contentBounds.minY },
          { x: contentBounds.maxX, y: contentBounds.maxY },
          { x: cell.minX, y: cell.minY },
          { x: cell.maxX, y: cell.maxY },
        ], 4);
        const value = {
          ...group,
          bounds,
          cellBounds: { ...cell },
          statuses: countStatuses(
            group.files.map((item) => item.file),
          ),
        };
        const key = `${group.familyId}\u0000${group.environmentId}`;
        state.environmentBounds.set(key, value);
        if (!state.familyBounds.has(group.familyId)) {
          state.familyBounds.set(group.familyId, {
            familyId: group.familyId,
            environments: [],
            files: [],
            bounds: null,
            statuses: null,
            window: familyWindow(group.familyId),
          });
        }
        const family = state.familyBounds.get(group.familyId);
        family.environments.push(value);
        family.files.push(...group.files.map((item) => item.file));
      }

      for (const family of state.familyBounds.values()) {
        family.bounds = familyWindowBounds(family.familyId);
        family.window = familyWindow(family.familyId);
        family.statuses = countStatuses(family.files);
      }
    }

    function boundsForPoints(points, padding = 0) {
      if (!points.length) {
        return {
          minX: -1, minY: -1, maxX: 1, maxY: 1,
          width: 2, height: 2,
        };
      }
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const minX = Math.min(...xs) - padding;
      const minY = Math.min(...ys) - padding;
      const maxX = Math.max(...xs) + padding;
      const maxY = Math.max(...ys) + padding;
      return {
        minX, minY, maxX, maxY,
        width: maxX - minX,
        height: maxY - minY,
      };
    }

    function countStatuses(files) {
      const output = {
        total: files.length,
        recognized: 0,
        partial: 0,
        unsupported: 0,
        failed: 0,
        changed: 0,
        unknown: 0,
      };
      for (const file of files) {
        const recognition = normalizeToken(file.recognitionState);
        if (['recognized', 'verified', 'committed'].includes(recognition)) {
          output.recognized += 1;
        } else if (['partial', 'pending'].includes(recognition)) {
          output.partial += 1;
        } else if (recognition === 'unsupported') {
          output.unsupported += 1;
        } else if (recognition === 'failed') {
          output.failed += 1;
        } else {
          output.unknown += 1;
        }
        if (['added', 'modified', 'removed', 'observed'].includes(
          normalizeToken(file.inventoryState),
        )) output.changed += 1;
      }
      return output;
    }

    function repositoryBounds() {
      const points = [{ x: 0, y: PROJECT_Y }];
      for (const family of state.familyBounds.values()) {
        points.push(
          { x: family.bounds.minX, y: family.bounds.minY },
          { x: family.bounds.maxX, y: family.bounds.maxY },
        );
      }
      if (points.length === 1) {
        points.push({ x: -420, y: -420 }, { x: 420, y: 320 });
      }
      return boundsForPoints(points, 115);
    }

    function worldToScreen(x, y) {
      return {
        x: (x - state.camera.x) * state.camera.zoom + state.cssWidth / 2,
        y: (y - state.camera.y) * state.camera.zoom + state.cssHeight / 2,
      };
    }

    function screenToWorld(x, y) {
      return {
        x: (x - state.cssWidth / 2) / state.camera.zoom + state.camera.x,
        y: (y - state.cssHeight / 2) / state.camera.zoom + state.camera.y,
      };
    }

    function animateCamera(target, animate = true) {
      const next = {
        x: target.x,
        y: target.y,
        zoom: clamp(target.zoom, 0.10, 4.8),
      };
      if (!animate || reduceMotion) {
        state.camera = next;
        state.cameraAnimation = null;
      } else {
        state.cameraAnimation = {
          from: { ...state.camera },
          to: next,
          start: performance.now(),
          duration: 620,
        };
      }
      state.userMovedCamera = true;
      markDirty();
    }

    function fitBounds(bounds, animate = true, reserveInspector = false) {
      if (!bounds) return;
      const padding = 72;
      const reserve = reserveInspector &&
        inspector.classList.contains('is-open') &&
        state.cssWidth > 760 ?
        Math.min(420, state.cssWidth * 0.34) : 0;
      const width = Math.max(1, state.cssWidth - padding * 2 - reserve);
      const height = Math.max(1, state.cssHeight - padding * 2);
      const zoom = clamp(Math.min(
        width / Math.max(1, bounds.width),
        height / Math.max(1, bounds.height),
      ), 0.10, 4.8);
      animateCamera({
        x: (bounds.minX + bounds.maxX) / 2 +
          (reserve > 0 ? reserve / (2 * zoom) : 0),
        y: (bounds.minY + bounds.maxY) / 2,
        zoom,
      }, animate);
    }

    function frameAll(animate = true) {
      fitBounds(repositoryBounds(), animate, false);
    }

    function frameFamily(familyId, animate = true) {
      const family = state.familyBounds.get(familyId);
      if (family) fitBounds(family.bounds, animate, true);
    }

    function frameEnvironment(id, animate = true) {
      const environment = state.environmentBounds.get(id);
      if (environment) fitBounds(environment.bounds, animate, true);
    }

    function frameFile(fileKey, animate = true) {
      const position = state.filePositions.get(fileKey);
      if (!position) return;
      animateCamera({
        x: position.x,
        y: position.y,
        zoom: Math.max(state.camera.zoom, 2.15),
      }, animate);
    }

    function frameSelection(animate = true) {
      if (!state.selected) frameAll(animate);
      else if (state.selected.kind === 'file') {
        frameFile(state.selected.id, animate);
      } else if (state.selected.kind === 'environment') {
        frameEnvironment(state.selected.id, animate);
      } else if (state.selected.kind === 'family') {
        frameFamily(state.selected.id, animate);
      } else frameAll(animate);
    }

    function focusFile(identity) {
      const key = resolveFileKey(identity);
      if (!key) return false;
      setSelection({ kind: 'file', id: key });
      frameFile(key, true);
      return true;
    }

    function setSelection(selection) {
      state.selected = selection;
      renderInspector();
      updateBreadcrumb();
      markDirty();
      try {
        nav.dispatchEvent(new CustomEvent('q1-selection-change', {
          detail: selection ? { ...selection } : null,
        }));
      } catch { /* optional projection event */ }
    }

    function normalizeRepositoryPath(value) {
      return String(value ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+/g, '/');
    }

    function semanticModelNode(id) {
      if (!id) return null;
      const model = navigatorInstance.model;
      if (!model) return null;
      return model.getNode?.(id) ||
        model.nodes?.get?.(id) ||
        model.getNode?.(model.sourceToDisplay?.get?.(id)) ||
        model.nodes?.get?.(model.sourceToDisplay?.get?.(id)) ||
        null;
    }

    function semanticFileAncestor(node) {
      const model = navigatorInstance.model;
      let current = node;
      while (current && current.granularity !== 'file' && current.parentId) {
        current = model?.getNode?.(current.parentId) ||
          model?.nodes?.get?.(current.parentId) || null;
      }
      return current?.granularity === 'file' ? current : null;
    }

    function semanticNodeBelongsToPath(node, expectedPath) {
      const model = navigatorInstance.model;
      if (!model || !node || !expectedPath) return false;
      for (const logicalId of node.sourceLogicalIds || []) {
        const unit = model.rawUnits?.get?.(logicalId);
        const unitPath = normalizeRepositoryPath(
          unit?.modulePath || unit?.anchor?.path || '',
        );
        if (unitPath && unitPath === expectedPath) return true;
      }
      return false;
    }

    function semanticAvailabilityForFile(file, { refresh = false } = {}) {
      if (!file) {
        return { available: false, nodeId: null, source: null, reason: 'Physical file record is unavailable.' };
      }
      const model = navigatorInstance.model;
      const modelVersion = finite(model?.version, 0);
      const explicitIds = [
        file.preferredSemanticRootId,
        file.semanticDestinationId,
        ...(Array.isArray(file.semanticMembershipIds)
          ? file.semanticMembershipIds : []),
      ].filter((value, index, list) =>
        typeof value === 'string' && value.trim() !== '' &&
        list.indexOf(value) === index);
      const path = normalizeRepositoryPath(file.path || '');
      const cacheTag = [
        modelVersion,
        file.fileVersionId || '',
        path,
        explicitIds.join('|'),
      ].join('::');
      const cached = state.semanticAvailabilityCache.get(file.key);
      if (!refresh && cached?.tag === cacheTag) return cached.value;

      const finish = (value) => {
        state.semanticAvailabilityCache.set(file.key, { tag: cacheTag, value });
        return value;
      };
      if (!file.fileLocationId || !file.fileVersionId || !path) {
        return finish({
          available: false,
          nodeId: null,
          source: null,
          reason: 'A valid DIVE handoff requires fileLocationId, fileVersionId, and repository-relative path.',
        });
      }

      if (!model?.nodes) {
        return finish(explicitIds.length
          ? {
            available: true,
            nodeId: explicitIds[0],
            source: 'backend-explicit-id',
            reason: null,
          }
          : {
            available: false,
            nodeId: null,
            source: null,
            reason: 'No explicit semantic mapping was supplied and the semantic model is unavailable.',
          });
      }

      for (const id of explicitIds) {
        const fileNode = semanticFileAncestor(semanticModelNode(id));
        if (fileNode && semanticNodeBelongsToPath(fileNode, path)) {
          return finish({
            available: true,
            nodeId: fileNode.id,
            source: 'backend-explicit-id',
            reason: null,
          });
        }
      }

      const matchingUnits = [...(model.rawUnits?.values?.() || [])]
        .filter((unit) => normalizeRepositoryPath(
          unit?.modulePath || unit?.anchor?.path || '',
        ) === path)
        .sort((left, right) => {
          const leftModule = left?.kind === 'module' ? 0 : 1;
          const rightModule = right?.kind === 'module' ? 0 : 1;
          return leftModule - rightModule ||
            String(left?.logicalId || '').localeCompare(String(right?.logicalId || ''));
        });
      const logicalId = matchingUnits[0]?.logicalId;
      const fileNode = semanticFileAncestor(
        semanticModelNode(model.sourceToDisplay?.get?.(logicalId) || logicalId),
      );
      if (fileNode && semanticNodeBelongsToPath(fileNode, path)) {
        return finish({
          available: true,
          nodeId: fileNode.id,
          source: 'semantic-source-anchor',
          reason: null,
        });
      }

      return finish({
        available: false,
        nodeId: null,
        source: null,
        reason: `No semantic source anchor or explicit semantic membership resolves to ${path}.`,
      });
    }

    function dismissSemanticUnavailable() {
      clearTimeout(state.semanticWarningTimer);
      state.semanticWarningTimer = 0;
      semanticWarning.classList.remove('is-visible');
    }

    function showSemanticUnavailable(file, reason) {
      const detailNode = semanticWarning.querySelector('.q1v9-semantic-warning-detail');
      const pathNode = semanticWarning.querySelector('.q1v9-semantic-warning-path');
      if (detailNode) {
        detailNode.textContent = reason ||
          'No explicit semantic mapping or semantic source anchor was found. SURF remains active.';
      }
      if (pathNode) {
        pathNode.textContent = file?.path || file?.name || 'PHYSICAL FILE PATH UNKNOWN';
      }
      semanticWarning.classList.add('is-visible');
      clearTimeout(state.semanticWarningTimer);
      state.semanticWarningTimer = window.setTimeout(
        dismissSemanticUnavailable,
        SEMANTIC_WARNING_MS,
      );
      try { canvas.focus({ preventScroll: true }); } catch { canvas.focus(); }
    }

    function enterDiveFromFile(fileKey) {
      const file = state.files.get(fileKey);
      if (!file) return false;
      setSelection({ kind: 'file', id: file.key });
      const availability = semanticAvailabilityForFile(file, { refresh: true });
      if (!availability.available) {
        showSemanticUnavailable(file, availability.reason);
        return false;
      }

      const semanticMembershipIds = [
        ...(Array.isArray(file.semanticMembershipIds)
          ? file.semanticMembershipIds : []),
        file.semanticDestinationId,
      ].filter((value, index, list) =>
        typeof value === 'string' && value.length > 0 &&
        list.indexOf(value) === index);
      const handoff = {
        repositoryId: file.repositoryId || state.repositoryId,
        snapshotId: file.snapshotId || state.snapshotId,
        fileLocationId: file.fileLocationId,
        fileVersionId: file.fileVersionId,
        path: file.path,
        familyId: file.familyId,
        environmentId: file.environmentId,
        semanticMembershipIds,
        preferredSemanticRootId: file.preferredSemanticRootId ||
          availability.nodeId || null,
        semanticDestinationId: file.semanticDestinationId ||
          availability.nodeId || null,
      };

      let entered = false;
      let rejectionReason = null;
      if (typeof navigatorInstance.enterDiveForFile === 'function') {
        try {
          entered = navigatorInstance.enterDiveForFile(handoff) === true;
          if (!entered) rejectionReason =
            'The semantic Navigator rejected the handoff because no matching semantic file scope was found.';
        } catch (error) {
          rejectionReason = error?.message || String(error);
          recordProjectionError('DIVE_ENTRY_API_FAILED', rejectionReason);
        }
      } else if (availability.nodeId && typeof navigatorInstance.frameScope === 'function') {
        try {
          entered = navigatorInstance.frameScope(availability.nodeId, { cinematic: true }) === true;
        } catch (error) {
          rejectionReason = error?.message || String(error);
          recordProjectionError('DIVE_FRAME_SCOPE_FAILED', rejectionReason);
        }
      } else {
        entered = requestSemanticMode('dive', handoff) === true;
        if (!entered) rejectionReason = 'No context-aware semantic DIVE entry API is available.';
      }

      if (!entered) {
        showSemanticUnavailable(file, rejectionReason || availability.reason);
        return false;
      }

      dismissSemanticUnavailable();
      state.diveContext = {
        ...handoff,
        semanticNodeId: availability.nodeId || null,
        semanticMappingSource: availability.source || null,
      };
      state.semanticMode = 'dive';
      try {
        nav.dispatchEvent(new CustomEvent('q1-dive-entry-request', {
          detail: state.diveContext,
          bubbles: true,
          composed: true,
        }));
      } catch { /* optional handoff event */ }
      try {
        window.__q1Navigator = {
          ...(window.__q1Navigator || {}),
          diveContext: state.diveContext,
        };
      } catch { /* optional diagnostics */ }
      setMode('dive', {
        requestCore: false,
        semanticTarget: 'dive',
        context: state.diveContext,
        forceSemantic: true,
      });
      updateDiveContextUi();
      return true;
    }



    function shortId(value, length = 12) {
      const text = value == null || value === '' ? null : String(value);
      if (!text) return 'UNKNOWN';
      return text.length > length ? `${text.slice(0, length)}…` : text;
    }

    function updateDiveContextUi() {
      const context = state.diveContext;
      const pathNode = diveContext.querySelector('.p');
      const metaNode = diveContext.querySelector('.m');
      const hasFileHandoff = Boolean(context && state.mode === 'dive');
      diveContext.hidden = !hasFileHandoff;
      if (!hasFileHandoff) {
        diveUnavailable.classList.remove('is-visible');
        return;
      }

      const file = state.files.get(
        resolveFileKey(context.fileLocationId) || '',
      ) || [...state.files.values()].find((candidate) =>
        candidate.fileLocationId === context.fileLocationId ||
        candidate.path === context.path);

      const family = familyDefinition(
        context.familyId || file?.familyId || 'unknown',
      );
      const environment = environmentDefinition(
        context.environmentId || file?.environmentId || 'unknown',
        family.id,
      );
      diveContext.style.setProperty('--ctx-accent', family.accent);
      if (pathNode) {
        pathNode.textContent =
          context.path || file?.path || 'PHYSICAL ARTIFACT PATH UNKNOWN';
      }
      if (metaNode) {
        metaNode.textContent =
          `SNAPSHOT ${shortId(context.snapshotId || file?.snapshotId)} · ` +
          `${environment.label} · ${family.label}`;
      }

      const unavailableReason = context?.semanticUnavailableReason || null;
      const unavailable = state.mode === 'dive' && Boolean(unavailableReason);
      diveUnavailable.classList.toggle('is-visible', unavailable);
      if (unavailable) {
        diveUnavailable.innerHTML =
          '<h3>SEMANTIC CONTENT UNAVAILABLE</h3>' +
          `<p><b>Environment:</b> ${esc(environment.label)}</p>` +
          `<p><b>Physical artifact:</b> ${file ? 'available' : 'unavailable in current SURF inventory'}</p>` +
          `<p><b>Reason:</b> ${esc(unavailableReason)}</p>`;
      }
    }

    function updateSearchMatches() {
      const query = state.searchQuery.trim().toLowerCase();
      if (!query) {
        state.searchMatches = [];
        searchCount.textContent = '0';
        markDirty();
        return;
      }
      const words = query.split(/\s+/).filter(Boolean);
      const matches = [];
      for (const file of activeFiles()) {
        const semantic = file.semanticSummary || {};
        const searchable = [
          file.name,
          file.path,
          file.extension,
          file.physicalFormat,
          file.familyId,
          familyDefinition(file.familyId).label,
          file.environmentId,
          environmentDefinition(
            file.environmentId,
            file.familyId,
          ).label,
          file.languageId,
          file.adapterId,
          file.recognitionState,
          file.inventoryState,
          ...(file.facets || []),
          ...(semantic.domainIds || []),
          ...(semantic.subsystemIds || []),
          ...(semantic.moduleIds || []),
          ...(file.semanticMembershipIds || []),
        ].filter(Boolean).join(' ').toLowerCase();
        if (words.every((word) => searchable.includes(word))) {
          matches.push(file.key);
        }
      }
      matches.sort((left, right) => {
        const a = state.files.get(left)?.path || '';
        const b = state.files.get(right)?.path || '';
        return a.localeCompare(b);
      });
      state.searchMatches = matches;
      searchCount.textContent = String(matches.length);
      markDirty();
    }

    function updateHud() {
      const files = activeFiles().filter((file) => !file.excluded);
      const status = countStatuses(files);
      stats.querySelector('[data-stat="files"]').textContent =
        String(files.length);
      stats.querySelector('[data-stat="families"]').textContent =
        String(state.familyBounds.size);
      stats.querySelector('[data-stat="environments"]').textContent =
        String(state.environmentBounds.size);
      stats.querySelector('[data-stat="unsupported"]').textContent =
        String(status.unsupported + status.failed + status.unknown);
      stats.querySelector('[data-stat="changed"]').textContent =
        String(status.changed);

      const project = state.projectName || state.repositoryId ||
        'REGISTERED PROJECT';
      identityTitle.innerHTML =
        `${esc(project)} · <b>${esc(state.inventoryPhase || 'AWAITING INVENTORY')}</b>`;

      const verification = verifyProjection();
      parity.dataset.state = verification.state;
      parity.textContent = verification.label;
      parity.title = verification.details.join('\n');
      empty.hidden = state.mode !== 'surf' || files.length > 0;
    }

    function entityDetails(selection) {
      if (!selection) return null;
      if (selection.kind === 'file') {
        const file = state.files.get(selection.id);
        return file ? { kind: 'file', id: selection.id, value: file } : null;
      }
      if (selection.kind === 'environment') {
        const environment = state.environmentBounds.get(selection.id);
        return environment ?
          { kind: 'environment', id: selection.id, value: environment } :
          null;
      }
      if (selection.kind === 'family') {
        const family = state.familyBounds.get(selection.id);
        return family ?
          { kind: 'family', id: selection.id, value: family } : null;
      }
      if (selection.kind === 'project') {
        return {
          kind: 'project',
          id: 'project',
          value: {
            repositoryId: state.repositoryId,
            projectName: state.projectName,
            snapshotId: state.snapshotId,
          },
        };
      }
      return null;
    }

    function updateBreadcrumb() {
      const details = entityDetails(state.hovered || state.selected);
      const project = esc(state.projectName || state.repositoryId || 'PROJECT');
      if (!details) {
        breadcrumb.innerHTML = `<b>${project}</b>`;
        breadcrumb.style.removeProperty('--crumb-family');
        return;
      }

      if (details.kind === 'file') {
        const file = details.value;
        const family = familyDefinition(file.familyId);
        const environment = environmentDefinition(
          file.environmentId,
          file.familyId,
        );
        breadcrumb.style.setProperty('--crumb-family', family.accent);
        breadcrumb.innerHTML =
          `<b>${project}</b> / <span class="family">${esc(family.label)}</span>` +
          ` / ${esc(environment.label)} / ${esc(file.name || file.path || 'FILE')}`;
      } else if (details.kind === 'environment') {
        const environment = details.value;
        const family = familyDefinition(environment.familyId);
        const definition = environmentDefinition(
          environment.environmentId,
          environment.familyId,
        );
        breadcrumb.style.setProperty('--crumb-family', family.accent);
        breadcrumb.innerHTML =
          `<b>${project}</b> / <span class="family">${esc(family.label)}</span>` +
          ` / ${esc(definition.label)}`;
      } else if (details.kind === 'family') {
        const family = familyDefinition(details.value.familyId);
        breadcrumb.style.setProperty('--crumb-family', family.accent);
        breadcrumb.innerHTML =
          `<b>${project}</b> / <span class="family">${esc(family.label)}</span>`;
      } else {
        breadcrumb.innerHTML = `<b>${project}</b>`;
      }
    }

    function valueOrUnknown(value, transform = null) {
      if (value == null || value === '') {
        return '<span class="unknown">UNKNOWN</span>';
      }
      const output = transform ? transform(value) : value;
      return esc(output);
    }

    function rowMarkup(label, value, transform = null) {
      return `<dt>${esc(label)}</dt><dd>${valueOrUnknown(value, transform)}</dd>`;
    }

    function sectionMarkup(title, rows) {
      return `<section class="q1v9-insp-section"><h4>${esc(title)}</h4>` +
        `<dl class="q1v9-insp-grid">${rows.join('')}</dl></section>`;
    }

    function semanticCount(summary, key) {
      if (!summary) return null;
      const value = summary[key];
      if (Array.isArray(value)) return value.length;
      return finite(value, null);
    }

    function dependencyStats(fileKey) {
      let inbound = 0;
      let outbound = 0;
      let crossEnvironment = 0;
      let unresolved = 0;
      const file = state.files.get(fileKey);
      for (const edge of state.edges.values()) {
        if (edge.from === fileKey) outbound += edge.weight || 1;
        if (edge.to === fileKey) inbound += edge.weight || 1;
        if (edge.from !== fileKey && edge.to !== fileKey) continue;
        const otherKey = edge.from === fileKey ? edge.to : edge.from;
        const other = state.files.get(otherKey);
        if (!other) {
          unresolved += 1;
        } else if (
          file &&
          (other.environmentId !== file.environmentId ||
            other.familyId !== file.familyId)
        ) {
          crossEnvironment += 1;
        }
      }
      return { inbound, outbound, crossEnvironment, unresolved };
    }

    function renderInspector() {
      const details = entityDetails(state.selected);
      if (!details || state.mode !== 'surf') {
        inspector.classList.remove('is-open');
        inspector.setAttribute('aria-hidden', 'true');
        return;
      }

      let html = '';
      let accent = '#00a3e0';
      if (details.kind === 'file') {
        const file = details.value;
        const family = familyDefinition(file.familyId);
        const environment = environmentDefinition(
          file.environmentId,
          file.familyId,
        );
        const dependencies = dependencyStats(file.key);
        const summary = file.semanticSummary || null;
        accent = family.accent;
        html =
          '<div class="q1v9-insp-head">' +
          `<div><div class="q1v9-insp-kind">PHYSICAL FILE · ${esc(file.recognitionState || 'UNKNOWN')}</div>` +
          `<h3>${esc(file.name || file.path || 'UNNAMED FILE')}</h3></div>` +
          '<button class="q1v9-insp-close" type="button" data-action="close" aria-label="Close inspector">✕</button></div>' +
          `<div class="q1v9-insp-path">${esc(file.path || 'PATH UNKNOWN')}</div>` +
          sectionMarkup('IDENTITY', [
            rowMarkup('Location ID', file.fileLocationId),
            rowMarkup('Version ID', file.fileVersionId),
            rowMarkup('Content hash', file.contentHash),
            rowMarkup('Snapshot', file.snapshotId || state.snapshotId),
            rowMarkup('Bytes', file.bytes, (value) => Number(value).toLocaleString()),
            rowMarkup('Physical format', file.physicalFormat),
          ]) +
          sectionMarkup('TECHNOLOGY CLASSIFICATION', [
            rowMarkup('Family', family.label),
            rowMarkup('Environment', environment.label),
            rowMarkup('Language', file.languageId),
            rowMarkup('Glyph', file.glyphId || environment.glyphId),
            rowMarkup('Source', file.classificationSource),
            rowMarkup('Confidence', file.classificationConfidence),
            rowMarkup('Classifier', file.classifierVersion),
            rowMarkup('Reason', file.classificationReason),
          ]) +
          `<section class="q1v9-insp-section"><h4>FACETS</h4><div class="q1v9-insp-badges">${
            (file.facets?.length ? file.facets : ['NONE SUPPLIED'])
              .map((facet) => `<span class="q1v9-insp-badge">${esc(facet)}</span>`)
              .join('')
          }</div></section>` +
          sectionMarkup('REPOSITORY STATE', [
            rowMarkup('Inventory state', file.inventoryState),
            rowMarkup('Tracked', typeof file.tracked === 'boolean' ? String(file.tracked) : null),
            rowMarkup('Generated', typeof file.generated === 'boolean' ? String(file.generated) : null),
            rowMarkup('Excluded', typeof file.excluded === 'boolean' ? String(file.excluded) : null),
            rowMarkup('Exclusion reason', file.exclusionReason),
          ]) +
          sectionMarkup('RECOGNITION STATE', [
            rowMarkup('State', file.recognitionState),
            rowMarkup('Adapter', file.adapterId || environment.adapterId),
            rowMarkup('Adapter version', file.adapterVersion),
            rowMarkup('Semantic depth', file.semanticDepth),
            rowMarkup('Domains', semanticCount(summary, 'domainIds')),
            rowMarkup('Subsystems', semanticCount(summary, 'subsystemIds')),
            rowMarkup('Modules', semanticCount(summary, 'moduleIds')),
            rowMarkup('Classes / types', semanticCount(summary, 'classCount')),
            rowMarkup('Functions / methods', semanticCount(summary, 'functionCount')),
            rowMarkup('Unresolved', semanticCount(summary, 'unresolvedCount')),
          ]) +
          sectionMarkup('DEPENDENCIES', [
            rowMarkup('Inbound', dependencies.inbound),
            rowMarkup('Outbound', dependencies.outbound),
            rowMarkup('Cross-environment', dependencies.crossEnvironment),
            rowMarkup('Unresolved', dependencies.unresolved),
          ]) +
          '<div class="q1v9-insp-actions">' +
          '<button class="q1v9-insp-action primary" type="button" data-action="dive">DIVE INTO FILE</button>' +
          '<button class="q1v9-insp-action" type="button" data-action="direct">FOCUS DIRECT DEPENDENCIES</button>' +
          '<button class="q1v9-insp-action" type="button" data-action="copy">COPY PATH</button>' +
          '<button class="q1v9-insp-action" type="button" data-action="frame">FRAME</button>' +
          '</div>';
      } else if (details.kind === 'environment') {
        const aggregate = details.value;
        const family = familyDefinition(aggregate.familyId);
        const environment = environmentDefinition(
          aggregate.environmentId,
          aggregate.familyId,
        );
        accent = family.accent;
        const totalBytes = aggregate.files.reduce(
          (sum, item) => sum + (finite(item.file.bytes, 0) || 0),
          0,
        );
        html = aggregateInspectorMarkup(
          'ENVIRONMENT',
          environment.label,
          family.label,
          aggregate.statuses,
          [
            rowMarkup('File count', aggregate.files.length),
            rowMarkup('Total bytes', totalBytes, (value) => Number(value).toLocaleString()),
            rowMarkup('Adapter', environment.adapterId),
            rowMarkup('Family', family.label),
          ],
        );
      } else if (details.kind === 'family') {
        const aggregate = details.value;
        const family = familyDefinition(aggregate.familyId);
        accent = family.accent;
        html = aggregateInspectorMarkup(
          'ARTIFACT FAMILY',
          family.label,
          `${aggregate.environments.length} ENVIRONMENTS`,
          aggregate.statuses,
          [
            rowMarkup('Environment count', aggregate.environments.length),
            rowMarkup('File count', aggregate.files.length),
            rowMarkup('Accent token', family.accent),
            rowMarkup('Pattern token', family.pattern),
            rowMarkup('Shape token', family.shape),
            rowMarkup('Family glyph', family.glyph),
          ],
        );
      } else {
        const files = activeFiles();
        const statuses = countStatuses(files);
        html = aggregateInspectorMarkup(
          'PROJECT INVENTORY',
          state.projectName || state.repositoryId || 'REGISTERED PROJECT',
          `SNAPSHOT ${shortId(state.snapshotId)}`,
          statuses,
          [
            rowMarkup('Repository ID', state.repositoryId),
            rowMarkup('Snapshot ID', state.snapshotId),
            rowMarkup('Inventory hash', state.inventoryHash),
            rowMarkup('Taxonomy version', state.taxonomyVersion),
            rowMarkup('Taxonomy hash', state.taxonomyHash),
            rowMarkup('Families', state.familyBounds.size),
            rowMarkup('Environments', state.environmentBounds.size),
            rowMarkup('Files', files.length),
          ],
        );
      }

      inspector.style.setProperty('--insp-accent', accent);
      inspector.innerHTML = html;
      inspector.classList.add('is-open');
      inspector.setAttribute('aria-hidden', 'false');
    }

    function aggregateInspectorMarkup(kind, title, subtitle, statuses, rows) {
      return '<div class="q1v9-insp-head">' +
        `<div><div class="q1v9-insp-kind">${esc(kind)}</div><h3>${esc(title)}</h3></div>` +
        '<button class="q1v9-insp-close" type="button" data-action="close" aria-label="Close inspector">✕</button></div>' +
        `<div class="q1v9-insp-path">${esc(subtitle || '')}</div>` +
        sectionMarkup('SUMMARY', rows) +
        sectionMarkup('COVERAGE', [
          rowMarkup('Recognized', statuses.recognized),
          rowMarkup('Partial / pending', statuses.partial),
          rowMarkup('Unsupported', statuses.unsupported),
          rowMarkup('Failed', statuses.failed),
          rowMarkup('Unknown', statuses.unknown),
          rowMarkup('Changed', statuses.changed),
        ]) +
        '<div class="q1v9-insp-actions">' +
        '<button class="q1v9-insp-action" type="button" data-action="frame">FRAME</button>' +
        '</div>';
    }

    async function copyPath(fileKey) {
      const path = state.files.get(fileKey)?.path;
      if (!path) {
        showToast('PATH UNKNOWN');
        return false;
      }
      try {
        await navigator.clipboard?.writeText(path);
        showToast('PATH COPIED');
        return true;
      } catch {
        showToast(path);
        return false;
      }
    }

    function showToast(message) {
      clearTimeout(state.toastTimer);
      toast.textContent = String(message);
      toast.classList.add('is-visible');
      state.toastTimer = window.setTimeout(
        () => toast.classList.remove('is-visible'),
        1700,
      );
    }

    function renderLegend() {
      if (!legend.classList.contains('is-open')) return;
      const families = [...state.familyBounds.values()]
        .sort((left, right) =>
          familyDefinition(left.familyId).order -
          familyDefinition(right.familyId).order);
      const familyRows = families.length
        ? families.map((aggregate) => {
          const definition = familyDefinition(aggregate.familyId);
          return '<div class="q1v9-legend-row">' +
            `<span class="q1v9-legend-swatch" style="--swatch:${esc(definition.accent)}">${esc(definition.glyph)}</span>` +
            `<span>${esc(definition.label)} · ${esc(definition.shape)}</span><b>${aggregate.files.length}</b></div>`;
        }).join('')
        : '<div class="q1v9-legend-note">No backend taxonomy-bound families are present.</div>';
      legend.querySelector('[data-legend-content]').innerHTML =
        '<div class="q1v9-legend-title">LIFECYCLE CORE</div>' +
        '<div class="q1v9-legend-row"><span class="q1v9-legend-core stable"></span><span>Stable / recognized</span><b>BLUE</b></div>' +
        '<div class="q1v9-legend-row"><span class="q1v9-legend-core selected"></span><span>Selected / Creator focus</span><b>GOLD</b></div>' +
        '<div class="q1v9-legend-row"><span class="q1v9-legend-core changed"></span><span>Observed / added / modified / blocked</span><b>ORANGE</b></div>' +
        '<div class="q1v9-legend-row"><span class="q1v9-legend-core patching"></span><span>Candidate-worktree patching only</span><b>GREEN</b></div>' +
        '<div class="q1v9-legend-title">TECHNOLOGY OUTER CHANNEL</div>' +
        familyRows +
        '<div class="q1v9-legend-note">Family accent never replaces lifecycle core state. Unknown classifications remain explicit.</div>';
    }

    function verifyProjection() {
      const files = activeFiles().filter((file) => !file.excluded);
      const uniqueKeys = new Set(files.map((file) => file.key));
      const duplicateCount = files.length - uniqueKeys.size;
      const missingLocation = files.filter(
        (file) => !file.fileLocationId,
      ).length;
      const missingVersion = files.filter(
        (file) => !file.fileVersionId,
      ).length;
      const unclassified = files.filter(
        (file) => file.familyId === 'unknown' ||
          file.environmentId === 'unknown',
      ).length;
      const danglingEdges = [...state.edges.values()].filter(
        (edge) => !state.files.has(edge.from) || !state.files.has(edge.to),
      ).length;
      const expected = finite(state.inventoryExpectedCount, null);
      const parityMatches = expected == null || expected === files.length;
      const details = [
        `active physical files: ${files.length}`,
        `expected inventory files: ${expected == null ? 'unbound' : expected}`,
        `duplicate location keys: ${duplicateCount}`,
        `missing location identity: ${missingLocation}`,
        `missing version identity: ${missingVersion}`,
        `explicit unknown family/environment: ${unclassified}`,
        `dangling file relations: ${danglingEdges}`,
        `projection errors: ${state.projectionErrors.length}`,
      ];
      let verificationState = 'ok';
      if (
        duplicateCount ||
        !parityMatches ||
        danglingEdges ||
        state.projectionErrors.length
      ) {
        verificationState = 'bad';
      } else if (
        expected == null ||
        missingLocation ||
        missingVersion ||
        unclassified
      ) {
        verificationState = 'warn';
      }
      const label = expected == null
        ? `FILES ${files.length} · PARITY UNBOUND`
        : parityMatches
          ? `PARITY ${files.length}/${expected}`
          : `PARITY FAULT ${files.length}/${expected}`;
      return {
        state: verificationState,
        label,
        details,
        activeFileCount: files.length,
        expectedFileCount: expected,
        duplicateCount,
        missingLocation,
        missingVersion,
        unclassified,
        danglingEdges,
        projectionErrors: state.projectionErrors.length,
      };
    }


    function resize() {
      if (state.destroyed || !root.isConnected) return;
      const rect = root.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(
        MAX_DPR,
        Math.max(1, window.devicePixelRatio || 1),
      );
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      state.cssWidth = width;
      state.cssHeight = height;
      state.dpr = dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      markDirty();
    }

    function markDirty() {
      state.dirty = true;
    }

    function updateCameraAnimation(now) {
      const animation = state.cameraAnimation;
      if (!animation) return false;
      const progress = clamp(
        (now - animation.start) / animation.duration,
        0,
        1,
      );
      const eased = 1 - Math.pow(1 - progress, 3);
      state.camera = {
        x: animation.from.x +
          (animation.to.x - animation.from.x) * eased,
        y: animation.from.y +
          (animation.to.y - animation.from.y) * eased,
        zoom: animation.from.zoom +
          (animation.to.zoom - animation.from.zoom) * eased,
      };
      if (progress >= 1) state.cameraAnimation = null;
      state.dirty = true;
      return true;
    }

    function hasTransientAnimation(now) {
      if (state.cameraAnimation) return true;
      for (const file of state.files.values()) {
        if (
          now - (file.transitionAt || 0) < DISCOVERY_PULSE_MS ||
          (file.removedAt &&
            now - file.removedAt < FILE_PURGE_MS)
        ) return true;
      }
      return false;
    }

    function tick(now) {
      if (state.destroyed) return;
      state.raf = requestAnimationFrame(tick);
      if (
        state.files.size === 0 &&
        now - state.lastModelScanAt >= MODEL_RESCAN_MS
      ) {
        state.lastModelScanAt = now;
        ingestAvailableRuntimeState();
      }
      const animating = updateCameraAnimation(now) ||
        hasTransientAnimation(now);
      if (
        state.mode !== 'surf' ||
        !state.visible ||
        document.hidden ||
        state.cssWidth < 40 ||
        state.cssHeight < 40
      ) return;
      if (
        !state.dirty &&
        !animating &&
        now - state.lastDrawAt < DRAW_IDLE_MS
      ) return;
      draw(now);
    }

    function draw(now) {
      state.lastDrawAt = now;
      state.dirty = false;
      state.screenEntities = [];
      state.spatialBuckets.clear();
      projectIcon.classList.remove('is-visible', 'is-selected', 'is-hovered');
      ctx.clearRect(0, 0, state.cssWidth, state.cssHeight);
      drawBackdrop(now);

      if (!activeFiles().length) {
        drawAwaitingSeal();
        return;
      }

      drawAggregateRelations(now, true);
      drawContainmentGuides();
      drawFamilyDistricts(now);
      drawEnvironmentAnchors(now);
      drawFocusedRelationships(now);
      drawFileNodes(now);
      drawProjectRoot(now);
      buildSpatialBuckets();
    }

    function rgbaHex(hex, alpha) {
      const normalized = String(hex || '#00a3e0')
        .replace('#', '').padEnd(6, '0').slice(0, 6);
      const value = Number.parseInt(normalized, 16);
      const r = Number.isFinite(value) ? (value >> 16) & 255 : 0;
      const g = Number.isFinite(value) ? (value >> 8) & 255 : 163;
      const b = Number.isFinite(value) ? value & 255 : 224;
      return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
    }

    function drawBackdrop(now) {
      const gradient = ctx.createRadialGradient(
        state.cssWidth * 0.50,
        state.cssHeight * 0.32,
        10,
        state.cssWidth * 0.50,
        state.cssHeight * 0.45,
        Math.max(state.cssWidth, state.cssHeight) * 0.86,
      );
      gradient.addColorStop(0, '#071725');
      gradient.addColorStop(0.42, '#030d17');
      gradient.addColorStop(1, '#010408');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, state.cssWidth, state.cssHeight);

      const grid = clamp(52 * state.camera.zoom, 27, 82);
      const offsetX = (
        state.cssWidth / 2 -
        state.camera.x * state.camera.zoom
      ) % grid;
      const offsetY = (
        state.cssHeight / 2 -
        state.camera.y * state.camera.zoom
      ) % grid;
      ctx.save();
      ctx.strokeStyle = 'rgba(60,146,190,.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = offsetX; x < state.cssWidth; x += grid) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, state.cssHeight);
      }
      for (let y = offsetY; y < state.cssHeight; y += grid) {
        ctx.moveTo(0, y);
        ctx.lineTo(state.cssWidth, y);
      }
      ctx.stroke();

      const scan = reduceMotion
        ? -1
        : (now * 0.012) % (state.cssHeight + 180) - 90;
      if (scan >= 0) {
        const sweep = ctx.createLinearGradient(
          0,
          scan - 38,
          0,
          scan + 38,
        );
        sweep.addColorStop(0, 'rgba(0,163,224,0)');
        sweep.addColorStop(0.5, 'rgba(0,163,224,.034)');
        sweep.addColorStop(1, 'rgba(0,163,224,0)');
        ctx.fillStyle = sweep;
        ctx.fillRect(0, scan - 38, state.cssWidth, 76);
      }
      ctx.restore();
    }

    function drawAwaitingSeal() {
      const centerX = state.cssWidth / 2;
      const centerY = state.cssHeight / 2;
      ctx.save();
      ctx.strokeStyle = 'rgba(244,175,45,.24)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 8]);
      ctx.beginPath();
      ctx.arc(centerX, centerY, 54, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(244,175,45,.74)';
      ctx.font = '800 9px ui-monospace,Consolas,monospace';
      ctx.textAlign = 'center';
      ctx.fillText('AWAITING EXPLICIT INVENTORY', centerX, centerY + 4);
      ctx.restore();
    }

    function drawContainmentGuides() {
      const project = worldToScreen(0, PROJECT_Y);
      const traceProjectPath = (target) => {
        ctx.beginPath();
        ctx.moveTo(project.x, project.y + 34);
        const bendY = project.y + (target.y - project.y) * 0.49;
        ctx.bezierCurveTo(
          project.x,
          bendY,
          target.x,
          bendY,
          target.x,
          target.y,
        );
      };

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const family of state.familyBounds.values()) {
        const definition = familyDefinition(family.familyId);
        const target = worldToScreen(
          (family.bounds.minX + family.bounds.maxX) / 2,
          family.bounds.minY + 5,
        );

        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,255,255,.075)';
        ctx.lineWidth = 7.2;
        ctx.shadowColor = 'rgba(198,243,255,.40)';
        ctx.shadowBlur = 24;
        traceProjectPath(target);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(238,252,255,.58)';
        ctx.lineWidth = 1.45;
        ctx.shadowBlur = 0;
        traceProjectPath(target);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255,255,255,.96)';
        ctx.lineWidth = 0.48;
        ctx.shadowBlur = 0;
        traceProjectPath(target);
        ctx.stroke();

        ctx.setLineDash([2.4, 10]);
        ctx.strokeStyle = rgbaHex(definition.accent, 0.34);
        ctx.lineWidth = 0.82;
        ctx.shadowBlur = 0;
        traceProjectPath(target);
        ctx.stroke();
        ctx.setLineDash([]);

        const familyAnchor = worldToScreen(
          (family.bounds.minX + family.bounds.maxX) / 2,
          family.bounds.minY + FAMILY_HEADER_WORLD_H,
        );
        for (const environment of family.environments) {
          const env = worldToScreen(
            environment.position.x,
            environment.position.y,
          );
          const traceEnvironmentPath = () => {
            ctx.beginPath();
            ctx.moveTo(familyAnchor.x, familyAnchor.y);
            const controlY = familyAnchor.y + (env.y - familyAnchor.y) * 0.45;
            ctx.bezierCurveTo(
              familyAnchor.x,
              controlY,
              env.x,
              controlY,
              env.x,
              env.y - 19,
            );
          };
          ctx.strokeStyle = 'rgba(255,255,255,.055)';
          ctx.lineWidth = 4.2;
          ctx.shadowBlur = 0;
          traceEnvironmentPath();
          ctx.stroke();
          ctx.strokeStyle = 'rgba(236,251,255,.42)';
          ctx.lineWidth = 0.78;
          traceEnvironmentPath();
          ctx.stroke();
          ctx.strokeStyle = rgbaHex(definition.accent, 0.44);
          ctx.lineWidth = 0.38;
          traceEnvironmentPath();
          ctx.stroke();
        }
      }
      ctx.restore();
    }


    function roundedPath(x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, width, height, r);
        return;
      }
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(
        x + width,
        y + height,
        x + width - r,
        y + height,
      );
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function familySemanticAvailability(aggregate) {
      let available = 0;
      for (const file of aggregate.files) {
        if (semanticAvailabilityForFile(file).available) available += 1;
      }
      return {
        available,
        total: aggregate.files.length,
        capable: available > 0,
      };
    }

    function drawFamilyDistricts(now) {
      const families = [...state.familyBounds.values()]
        .sort((left, right) =>
          familyDefinition(left.familyId).order -
          familyDefinition(right.familyId).order);
      for (const aggregate of families) {
        const definition = familyDefinition(aggregate.familyId);
        const topLeft = worldToScreen(
          aggregate.bounds.minX,
          aggregate.bounds.minY,
        );
        const bottomRight = worldToScreen(
          aggregate.bounds.maxX,
          aggregate.bounds.maxY,
        );
        const x = topLeft.x;
        const y = topLeft.y;
        const width = bottomRight.x - topLeft.x;
        const height = bottomRight.y - topLeft.y;
        if (
          x > state.cssWidth + 120 ||
          x + width < -120 ||
          y > state.cssHeight + 120 ||
          y + height < -120
        ) continue;

        const selected = state.selected?.kind === 'family' &&
          state.selected.id === aggregate.familyId;
        const hovered = state.hovered?.kind === 'family' &&
          state.hovered.id === aggregate.familyId;
        const webRuntime = isWebRuntimeFamily(aggregate.familyId);
        const semantic = familySemanticAvailability(aggregate);
        const pulse = reduceMotion ? 0.45 :
          0.45 + ((Math.sin(now * 0.0024 + stableHash(aggregate.familyId)) + 1) / 2) * 0.55;
        const headerHeight = clamp(
          FAMILY_HEADER_WORLD_H * state.camera.zoom,
          24,
          38,
        );

        ctx.save();
        if (webRuntime) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.shadowColor = rgbaHex(definition.accent, 0.72);
          ctx.shadowBlur = 26 + pulse * 12;
          roundedPath(x - 5, y - 5, width + 10, height + 10, 20);
          ctx.strokeStyle = rgbaHex(definition.accent, 0.12 + pulse * 0.09);
          ctx.lineWidth = 7;
          ctx.stroke();
          ctx.globalCompositeOperation = 'source-over';
        }

        const fill = ctx.createLinearGradient(
          x,
          y,
          x + width,
          y + height,
        );
        fill.addColorStop(0, rgbaHex(
          definition.accent,
          selected ? 0.125 : webRuntime ? 0.082 : 0.048,
        ));
        fill.addColorStop(0.54, webRuntime
          ? 'rgba(7,15,29,.15)'
          : 'rgba(3,11,19,.08)');
        fill.addColorStop(1, 'rgba(1,7,12,.035)');
        roundedPath(x, y, width, height, 16);
        ctx.fillStyle = fill;
        ctx.fill();

        ctx.save();
        roundedPath(x, y, width, Math.min(headerHeight, height), 16);
        const headerFill = ctx.createLinearGradient(x, y, x + width, y);
        headerFill.addColorStop(0, rgbaHex(definition.accent, webRuntime ? 0.24 : 0.14));
        headerFill.addColorStop(0.62, 'rgba(6,18,29,.90)');
        headerFill.addColorStop(1, 'rgba(2,9,16,.88)');
        ctx.fillStyle = headerFill;
        ctx.fill();
        ctx.restore();

        const starCount = webRuntime ? 28 : 15;
        for (let index = 0; index < starCount; index += 1) {
          const sx = x + 18 + hash01(aggregate.familyId, `star-x-${index}`) * Math.max(1, width - 36);
          const sy = y + headerHeight + 12 + hash01(aggregate.familyId, `star-y-${index}`) * Math.max(1, height - headerHeight - 28);
          const starRadius = hash01(aggregate.familyId, `star-r-${index}`) > 0.84 ? 1.15 : 0.55;
          ctx.beginPath();
          ctx.arc(sx, sy, starRadius, 0, TAU);
          ctx.fillStyle = rgbaHex(
            definition.accent,
            (webRuntime ? 0.17 : 0.09) + hash01(aggregate.familyId, `star-a-${index}`) * 0.13,
          );
          ctx.fill();
        }

        roundedPath(x, y, width, height, 16);
        ctx.strokeStyle = rgbaHex(
          definition.accent,
          selected ? 0.88 : hovered ? 0.58 : webRuntime ? 0.44 + pulse * 0.12 : 0.25,
        );
        ctx.lineWidth = selected ? 1.75 : webRuntime ? 1.18 : 0.82;
        ctx.setLineDash(
          definition.pattern === 'dashed' ||
          definition.pattern === 'broken'
            ? [8, 7]
            : [],
        );
        ctx.shadowColor = rgbaHex(definition.accent, 0.76);
        ctx.shadowBlur = selected ? 20 : hovered ? 12 : webRuntime ? 8 + pulse * 7 : 0;
        ctx.stroke();
        ctx.setLineDash([]);

        if (webRuntime) {
          roundedPath(x + 5, y + 5, Math.max(1, width - 10), Math.max(1, height - 10), 13);
          ctx.strokeStyle = semantic.capable
            ? `rgba(244,175,45,${0.26 + pulse * 0.22})`
            : `rgba(103,178,210,${0.16 + pulse * 0.08})`;
          ctx.lineWidth = 0.72;
          ctx.setLineDash([12, 7, 2, 7]);
          ctx.shadowColor = semantic.capable
            ? 'rgba(244,175,45,.60)'
            : 'rgba(0,163,224,.42)';
          ctx.shadowBlur = 10;
          ctx.stroke();
          ctx.setLineDash([]);
        }

        const labelY = y + Math.min(headerHeight * 0.42, 16);
        ctx.fillStyle = rgbaHex(definition.accent, 0.95);
        ctx.font = '800 8px ui-monospace,Consolas,monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          `${definition.glyph} · ${definition.label} · ${aggregate.files.length} FILES`,
          x + 13,
          labelY,
          Math.max(90, width - 182),
        );
        ctx.fillStyle = 'rgba(139,176,197,.76)';
        ctx.font = '650 6.8px ui-monospace,Consolas,monospace';
        ctx.fillText(
          `${aggregate.statuses.recognized} RECOGNIZED · ` +
          `${aggregate.statuses.partial} PARTIAL · ` +
          `${aggregate.statuses.unsupported + aggregate.statuses.failed} UNSUPPORTED/FAILED`,
          x + 13,
          labelY + 12,
          Math.max(90, width - 178),
        );

        const capabilityLabel = webRuntime
          ? `${semantic.capable ? 'DIVE LINK' : 'PHYSICAL ONLY'} · CHROME / TEST / BENCHMARK`
          : semantic.capable
            ? `DIVE ${semantic.available}/${semantic.total}`
            : 'PHYSICAL ONLY';
        ctx.font = webRuntime
          ? '800 6.6px ui-monospace,Consolas,monospace'
          : '750 6.2px ui-monospace,Consolas,monospace';
        const capabilityWidth = Math.min(
          Math.max(66, ctx.measureText(capabilityLabel).width + 12),
          Math.max(66, width * 0.46),
        );
        const capabilityX = x + width - capabilityWidth - 12;
        const capabilityY = y + 8;
        roundedPath(capabilityX, capabilityY, capabilityWidth, 18, 8);
        ctx.fillStyle = semantic.capable
          ? 'rgba(42,30,5,.82)'
          : 'rgba(4,15,24,.82)';
        ctx.fill();
        ctx.strokeStyle = semantic.capable
          ? 'rgba(244,175,45,.50)'
          : 'rgba(100,158,187,.28)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
        ctx.fillStyle = semantic.capable ? '#ffe0a0' : '#8ca8b9';
        ctx.textAlign = 'center';
        ctx.fillText(
          capabilityLabel,
          capabilityX + capabilityWidth / 2,
          capabilityY + 9,
          capabilityWidth - 10,
        );

        drawFamilyPattern(
          x + width - 20,
          y + Math.min(headerHeight - 8, 20),
          8,
          definition,
          now,
        );

        const gripSize = clamp(9 * Math.sqrt(state.camera.zoom), 7, 12);
        const gripAlpha = selected || hovered || webRuntime ? 0.78 : 0.38;
        ctx.strokeStyle = `rgba(220,248,255,${gripAlpha})`;
        ctx.lineWidth = 0.75;
        ctx.shadowColor = rgbaHex(definition.accent, 0.52);
        ctx.shadowBlur = 4;
        for (let step = 0; step < 3; step += 1) {
          ctx.beginPath();
          ctx.moveTo(
            x + width - 3 - step * 4,
            y + height - 2,
          );
          ctx.lineTo(
            x + width - 2,
            y + height - 3 - step * 4,
          );
          ctx.stroke();
        }
        ctx.restore();

        state.screenEntities.push({
          kind: 'family',
          id: aggregate.familyId,
          familyId: aggregate.familyId,
          x: x + width / 2,
          y: y + height / 2,
          radius: Math.max(width, height) / 2,
          rect: { x, y, width, height },
          priority: 1,
        });
        state.screenEntities.push({
          kind: 'family-drag',
          id: aggregate.familyId,
          familyId: aggregate.familyId,
          x: x + width / 2,
          y: y + Math.min(headerHeight, height) / 2,
          radius: Math.max(8, width / 2),
          rect: { x, y, width, height: Math.min(headerHeight, height) },
          priority: 8,
        });

        const edge = Math.max(8, Math.min(13, gripSize + 2));
        const resizeRects = [
          ['nw', { x: x - edge / 2, y: y - edge / 2, width: edge, height: edge }],
          ['ne', { x: x + width - edge / 2, y: y - edge / 2, width: edge, height: edge }],
          ['sw', { x: x - edge / 2, y: y + height - edge / 2, width: edge, height: edge }],
          ['se', { x: x + width - edge / 2, y: y + height - edge / 2, width: edge, height: edge }],
          ['n', { x: x + edge, y: y - edge / 2, width: Math.max(1, width - edge * 2), height: edge }],
          ['s', { x: x + edge, y: y + height - edge / 2, width: Math.max(1, width - edge * 2), height: edge }],
          ['w', { x: x - edge / 2, y: y + edge, width: edge, height: Math.max(1, height - edge * 2) }],
          ['e', { x: x + width - edge / 2, y: y + edge, width: edge, height: Math.max(1, height - edge * 2) }],
        ];
        for (const [direction, rect] of resizeRects) {
          state.screenEntities.push({
            kind: 'family-resize',
            id: `${aggregate.familyId}:${direction}`,
            familyId: aggregate.familyId,
            direction,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            radius: Math.max(rect.width, rect.height) / 2,
            rect,
            priority: 9,
          });
        }
      }
    }


    function drawFamilyPattern(x, y, radius, definition, now) {
      ctx.save();
      ctx.translate(x, y);
      ctx.strokeStyle = rgbaHex(definition.accent, 0.92);
      ctx.fillStyle = rgbaHex(definition.accent, 0.72);
      ctx.lineWidth = 1;
      const pattern = definition.pattern;
      if (pattern === 'double') {
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, TAU);
        ctx.arc(0, 0, radius - 3, 0, TAU);
        ctx.stroke();
      } else if (pattern === 'dotted') {
        for (let index = 0; index < 8; index += 1) {
          const angle = index * TAU / 8;
          ctx.beginPath();
          ctx.arc(
            Math.cos(angle) * radius,
            Math.sin(angle) * radius,
            1,
            0,
            TAU,
          );
          ctx.fill();
        }
      } else if (pattern === 'ticks' || pattern === 'segmented') {
        for (let index = 0; index < 8; index += 1) {
          const angle = index * TAU / 8;
          ctx.beginPath();
          ctx.moveTo(
            Math.cos(angle) * (radius - 2),
            Math.sin(angle) * (radius - 2),
          );
          ctx.lineTo(
            Math.cos(angle) * (radius + 2),
            Math.sin(angle) * (radius + 2),
          );
          ctx.stroke();
        }
      } else if (pattern === 'cross') {
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, TAU);
        ctx.moveTo(-radius - 2, 0);
        ctx.lineTo(radius + 2, 0);
        ctx.moveTo(0, -radius - 2);
        ctx.lineTo(0, radius + 2);
        ctx.stroke();
      } else if (pattern === 'wave') {
        ctx.beginPath();
        for (let index = 0; index <= 16; index += 1) {
          const px = -radius + index / 16 * radius * 2;
          const py = Math.sin(
            index / 16 * TAU * 1.5 +
            (reduceMotion ? 0 : now * 0.003),
          ) * 2.2;
          if (index === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      } else if (
        pattern === 'square' ||
        pattern === 'braces' ||
        pattern === 'angle'
      ) {
        ctx.strokeRect(-radius, -radius, radius * 2, radius * 2);
      } else {
        ctx.setLineDash(pattern === 'broken' ? [4, 4] : []);
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }

    function polygonShapePath(x, y, radius, sides, rotation = -Math.PI / 2) {
      ctx.beginPath();
      for (let index = 0; index < sides; index += 1) {
        const angle = rotation + index * TAU / sides;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }

    function familyShapePath(x, y, radius, shape = 'circle') {
      const token = normalizeToken(shape || 'circle');
      if (token === 'hex' || token === 'cube') {
        polygonShapePath(x, y, radius, 6);
      } else if (token === 'diamond' || token === 'angle') {
        polygonShapePath(x, y, radius, 4, 0);
      } else if (token === 'triangle') {
        polygonShapePath(x, y, radius * 1.08, 3);
      } else if (token === 'square' || token === 'braces') {
        ctx.beginPath();
        ctx.rect(x - radius * 0.82, y - radius * 0.82, radius * 1.64, radius * 1.64);
      } else if (token === 'octagon') {
        polygonShapePath(x, y, radius, 8, Math.PI / 8);
      } else if (token === 'chevron') {
        ctx.beginPath();
        ctx.moveTo(x - radius, y - radius * 0.62);
        ctx.lineTo(x, y - radius);
        ctx.lineTo(x + radius, y - radius * 0.62);
        ctx.lineTo(x + radius * 0.48, y);
        ctx.lineTo(x + radius, y + radius * 0.62);
        ctx.lineTo(x, y + radius);
        ctx.lineTo(x - radius, y + radius * 0.62);
        ctx.lineTo(x - radius * 0.48, y);
        ctx.closePath();
      } else if (token === 'star') {
        ctx.beginPath();
        for (let index = 0; index < 10; index += 1) {
          const angle = -Math.PI / 2 + index * TAU / 10;
          const rr = index % 2 ? radius * 0.46 : radius;
          const px = x + Math.cos(angle) * rr;
          const py = y + Math.sin(angle) * rr;
          if (index === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else if (token === 'terminal') {
        roundedPath(
          x - radius * 1.08,
          y - radius * 0.72,
          radius * 2.16,
          radius * 1.44,
          Math.max(1.5, radius * 0.22),
        );
      } else if (token === 'cylinder') {
        ctx.beginPath();
        ctx.ellipse(x, y, radius * 0.90, radius * 0.68, 0, 0, TAU);
      } else if (token === 'page') {
        const left = x - radius * 0.78;
        const top = y - radius;
        const right = x + radius * 0.78;
        const bottom = y + radius;
        const fold = radius * 0.48;
        ctx.beginPath();
        ctx.moveTo(left, top);
        ctx.lineTo(right - fold, top);
        ctx.lineTo(right, top + fold);
        ctx.lineTo(right, bottom);
        ctx.lineTo(left, bottom);
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, TAU);
      }
    }

    function technologyIconSpec(environment, fallbackId) {
      const id = normalizeToken(environment?.id || fallbackId || 'unknown');
      const glyph = normalizeToken(environment?.glyphId || '');
      const label = normalizeToken(environment?.label || '');
      const token = `${id} ${glyph} ${label}`;
      const explicitLabel = String(environment?.glyphId || '')
        .replace(/[^A-Za-z0-9+#._>-]/g, '')
        .slice(0, 6)
        .toUpperCase();

      if (token.includes('typescript') || id === 'ts') return { kind: 'typescript', label: 'TS' };
      if ((token.includes('javascript') || id === 'js') && !token.includes('json')) return { kind: 'javascript', label: 'JS' };
      if (token.includes('python') || id === 'py') return { kind: 'python', label: 'PY' };
      if (token.includes('powershell') || id === 'pwsh') return { kind: 'powershell', label: '>_' };
      if (token.includes('java') && !token.includes('javascript')) return { kind: 'java', label: 'JAVA' };
      if (token.includes('kotlin')) return { kind: 'kotlin', label: 'KT' };
      if (token.includes('html')) return { kind: 'html', label: '5' };
      if (token.includes('css')) return { kind: 'css', label: '3' };
      if (token.includes('json')) return { kind: 'json', label: '{}' };
      if (token.includes('yaml') || token.includes('yml')) return { kind: 'yaml', label: 'YML' };
      if (token.includes('markdown') || id === 'md') return { kind: 'markdown', label: 'MD' };
      if (
        token.includes('wgsl') || token.includes('glsl') ||
        token.includes('hlsl') || token.includes('shader') ||
        token.includes('gpu')
      ) return { kind: 'shader', label: id.includes('wgsl') ? 'WGSL' : 'GPU' };
      if (token.includes('node')) return { kind: 'node', label: 'NODE' };
      if (token.includes('docker') || token.includes('container')) return { kind: 'docker', label: 'BOX' };
      if (token.includes('sql') || token.includes('database') || token.includes('query')) return { kind: 'database', label: 'SQL' };
      if (token.includes('bash') || token.includes('zsh') || token.includes('shell') || token.includes('terminal')) return { kind: 'shell', label: '$' };
      if (token.includes('csharp') || token.includes('c-sharp') || id === 'cs') return { kind: 'csharp', label: 'C#' };
      if (token.includes('cpp') || token.includes('c-plus') || id === 'c++') return { kind: 'cpp', label: 'C++' };
      if (id === 'c' || token.includes('language-c')) return { kind: 'c', label: 'C' };
      if (token.includes('rust')) return { kind: 'rust', label: 'R' };
      if (id === 'go' || token.includes('golang')) return { kind: 'go', label: 'GO' };
      if (token.includes('swift')) return { kind: 'swift', label: 'SW' };
      if (token.includes('ruby')) return { kind: 'ruby', label: 'RB' };
      if (token.includes('php')) return { kind: 'php', label: 'PHP' };
      if (token.includes('xml')) return { kind: 'xml', label: '<>' };
      if (token.includes('toml') || token.includes('config')) return { kind: 'configuration', label: 'CFG' };
      if (token.includes('binary') || token.includes('asset') || token.includes('media')) return { kind: 'binary', label: '01' };
      return {
        kind: 'generic',
        label: explicitLabel ||
          id.replace(/[^A-Za-z0-9+#]/g, '').slice(0, 4).toUpperCase() ||
          '?',
      };
    }

    function environmentGlyph(environment, fallbackId) {
      return technologyIconSpec(environment, fallbackId).label;
    }

    function drawTechnologyIcon(x, y, radius, spec, accent) {
      const size = Math.max(7, radius * 0.76);
      const line = clamp(radius * 0.10, 1.15, 2.6);
      const drawText = (value, scale = 0.62, weight = 900) => {
        ctx.fillStyle = '#f2fcff';
        ctx.font = `${weight} ${clamp(size * scale, 6, 18)}px ui-monospace,Consolas,monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(value, 0, 0.5, size * 1.65);
      };
      const shield = () => {
        ctx.beginPath();
        ctx.moveTo(-size * 0.65, -size * 0.73);
        ctx.lineTo(size * 0.65, -size * 0.73);
        ctx.lineTo(size * 0.52, size * 0.54);
        ctx.lineTo(0, size * 0.82);
        ctx.lineTo(-size * 0.52, size * 0.54);
        ctx.closePath();
      };

      ctx.save();
      ctx.translate(x, y);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#eafaff';
      ctx.fillStyle = rgbaHex(accent, 0.34);
      ctx.lineWidth = line;
      ctx.shadowColor = rgbaHex(accent, 0.76);
      ctx.shadowBlur = 5;

      if (spec.kind === 'typescript' || spec.kind === 'javascript') {
        roundedPath(-size * 0.75, -size * 0.75, size * 1.5, size * 1.5, size * 0.13);
        ctx.fillStyle = rgbaHex(accent, spec.kind === 'typescript' ? 0.54 : 0.38);
        ctx.fill();
        ctx.stroke();
        drawText(spec.label, 0.68);
      } else if (spec.kind === 'python') {
        ctx.lineWidth = line * 1.6;
        ctx.beginPath();
        ctx.moveTo(-size * 0.58, -size * 0.12);
        ctx.bezierCurveTo(-size * 0.62, -size * 0.62, -size * 0.18, -size * 0.72, size * 0.12, -size * 0.60);
        ctx.bezierCurveTo(size * 0.42, -size * 0.48, size * 0.48, -size * 0.22, size * 0.28, -size * 0.02);
        ctx.lineTo(-size * 0.10, -size * 0.02);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(size * 0.58, size * 0.12);
        ctx.bezierCurveTo(size * 0.62, size * 0.62, size * 0.18, size * 0.72, -size * 0.12, size * 0.60);
        ctx.bezierCurveTo(-size * 0.42, size * 0.48, -size * 0.48, size * 0.22, -size * 0.28, size * 0.02);
        ctx.lineTo(size * 0.10, size * 0.02);
        ctx.stroke();
        ctx.fillStyle = '#eafaff';
        ctx.beginPath();
        ctx.arc(size * 0.08, -size * 0.48, line * 0.72, 0, TAU);
        ctx.arc(-size * 0.08, size * 0.48, line * 0.72, 0, TAU);
        ctx.fill();
      } else if (spec.kind === 'java') {
        ctx.beginPath();
        ctx.moveTo(-size * 0.46, size * 0.03);
        ctx.lineTo(-size * 0.35, size * 0.48);
        ctx.quadraticCurveTo(0, size * 0.67, size * 0.35, size * 0.48);
        ctx.lineTo(size * 0.46, size * 0.03);
        ctx.closePath();
        ctx.fillStyle = rgbaHex(accent, 0.25);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(size * 0.47, size * 0.25, size * 0.23, -Math.PI / 2, Math.PI / 2);
        ctx.stroke();
        for (let index = -1; index <= 1; index += 1) {
          const offset = index * size * 0.22;
          ctx.beginPath();
          ctx.moveTo(offset - size * 0.09, -size * 0.02);
          ctx.bezierCurveTo(offset + size * 0.15, -size * 0.24, offset - size * 0.10, -size * 0.45, offset + size * 0.08, -size * 0.70);
          ctx.stroke();
        }
      } else if (spec.kind === 'powershell' || spec.kind === 'shell') {
        roundedPath(-size * 0.82, -size * 0.58, size * 1.64, size * 1.16, size * 0.16);
        ctx.fillStyle = rgbaHex(accent, 0.24);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-size * 0.48, -size * 0.22);
        ctx.lineTo(-size * 0.14, 0);
        ctx.lineTo(-size * 0.48, size * 0.22);
        ctx.moveTo(-size * 0.02, size * 0.24);
        ctx.lineTo(size * 0.42, size * 0.24);
        ctx.stroke();
      } else if (spec.kind === 'html' || spec.kind === 'css') {
        shield();
        ctx.fillStyle = rgbaHex(accent, 0.32);
        ctx.fill();
        ctx.stroke();
        drawText(spec.label, 0.78);
      } else if (spec.kind === 'json') {
        drawText('{ }', 0.72);
      } else if (spec.kind === 'yaml') {
        ctx.beginPath();
        ctx.moveTo(0, size * 0.62);
        ctx.lineTo(0, -size * 0.05);
        ctx.lineTo(-size * 0.48, -size * 0.52);
        ctx.moveTo(0, -size * 0.05);
        ctx.lineTo(size * 0.48, -size * 0.52);
        ctx.stroke();
        for (const [px, py] of [[0, size * 0.62], [-size * 0.48, -size * 0.52], [size * 0.48, -size * 0.52]]) {
          ctx.beginPath();
          ctx.arc(px, py, size * 0.14, 0, TAU);
          ctx.fillStyle = rgbaHex(accent, 0.55);
          ctx.fill();
          ctx.stroke();
        }
      } else if (spec.kind === 'shader') {
        roundedPath(-size * 0.56, -size * 0.50, size * 1.12, size, size * 0.10);
        ctx.fillStyle = rgbaHex(accent, 0.25);
        ctx.fill();
        ctx.stroke();
        for (let index = -1; index <= 1; index += 1) {
          const offset = index * size * 0.30;
          ctx.beginPath();
          ctx.moveTo(offset, -size * 0.70);
          ctx.lineTo(offset, -size * 0.50);
          ctx.moveTo(offset, size * 0.50);
          ctx.lineTo(offset, size * 0.70);
          ctx.stroke();
        }
        ctx.beginPath();
        for (let index = 0; index <= 10; index += 1) {
          const px = -size * 0.38 + index / 10 * size * 0.76;
          const py = Math.sin(index / 10 * TAU) * size * 0.18;
          if (index === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      } else if (spec.kind === 'markdown') {
        roundedPath(-size * 0.78, -size * 0.52, size * 1.56, size * 1.04, size * 0.10);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-size * 0.52, size * 0.23);
        ctx.lineTo(-size * 0.52, -size * 0.24);
        ctx.lineTo(-size * 0.27, 0);
        ctx.lineTo(-size * 0.02, -size * 0.24);
        ctx.lineTo(-size * 0.02, size * 0.23);
        ctx.moveTo(size * 0.35, -size * 0.26);
        ctx.lineTo(size * 0.35, size * 0.20);
        ctx.moveTo(size * 0.15, size * 0.02);
        ctx.lineTo(size * 0.35, size * 0.24);
        ctx.lineTo(size * 0.55, size * 0.02);
        ctx.stroke();
      } else if (spec.kind === 'node') {
        polygonShapePath(0, 0, size * 0.78, 6);
        ctx.fillStyle = rgbaHex(accent, 0.30);
        ctx.fill();
        ctx.stroke();
        drawText('N', 0.82);
      } else if (spec.kind === 'database') {
        ctx.beginPath();
        ctx.ellipse(0, -size * 0.45, size * 0.60, size * 0.24, 0, 0, TAU);
        ctx.moveTo(-size * 0.60, -size * 0.45);
        ctx.lineTo(-size * 0.60, size * 0.43);
        ctx.moveTo(size * 0.60, -size * 0.45);
        ctx.lineTo(size * 0.60, size * 0.43);
        ctx.ellipse(0, size * 0.43, size * 0.60, size * 0.24, 0, 0, Math.PI);
        ctx.stroke();
      } else if (spec.kind === 'docker') {
        const box = size * 0.25;
        for (let row = 0; row < 2; row += 1) {
          for (let column = 0; column < (row === 0 ? 2 : 3); column += 1) {
            ctx.strokeRect(
              -size * 0.48 + column * (box + size * 0.06),
              -size * 0.52 + row * (box + size * 0.06),
              box,
              box,
            );
          }
        }
        ctx.beginPath();
        ctx.moveTo(-size * 0.68, size * 0.28);
        ctx.quadraticCurveTo(-size * 0.05, size * 0.68, size * 0.68, size * 0.28);
        ctx.stroke();
      } else if (['c', 'cpp', 'csharp'].includes(spec.kind)) {
        polygonShapePath(0, 0, size * 0.80, 6);
        ctx.fillStyle = rgbaHex(accent, 0.26);
        ctx.fill();
        ctx.stroke();
        drawText(spec.label, spec.label.length > 2 ? 0.53 : 0.72);
      } else if (spec.kind === 'rust') {
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.55, 0, TAU);
        ctx.stroke();
        for (let index = 0; index < 10; index += 1) {
          const angle = index * TAU / 10;
          ctx.beginPath();
          ctx.moveTo(Math.cos(angle) * size * 0.57, Math.sin(angle) * size * 0.57);
          ctx.lineTo(Math.cos(angle) * size * 0.76, Math.sin(angle) * size * 0.76);
          ctx.stroke();
        }
        drawText('R', 0.72);
      } else if (spec.kind === 'go') {
        drawText('GO', 0.72);
        ctx.beginPath();
        ctx.moveTo(-size * 0.80, -size * 0.32);
        ctx.lineTo(-size * 0.48, -size * 0.32);
        ctx.moveTo(-size * 0.88, 0);
        ctx.lineTo(-size * 0.52, 0);
        ctx.moveTo(-size * 0.76, size * 0.32);
        ctx.lineTo(-size * 0.46, size * 0.32);
        ctx.stroke();
      } else if (spec.kind === 'xml') {
        drawText('< >', 0.65);
      } else if (spec.kind === 'configuration') {
        for (let index = -1; index <= 1; index += 1) {
          const py = index * size * 0.36;
          const knob = index === -1 ? -0.30 : index === 0 ? 0.25 : -0.05;
          ctx.beginPath();
          ctx.moveTo(-size * 0.68, py);
          ctx.lineTo(size * 0.68, py);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(knob * size, py, size * 0.12, 0, TAU);
          ctx.fillStyle = rgbaHex(accent, 0.58);
          ctx.fill();
          ctx.stroke();
        }
      } else if (spec.kind === 'binary') {
        drawText('01', 0.72);
      } else if (['kotlin', 'swift', 'ruby', 'php'].includes(spec.kind)) {
        polygonShapePath(0, 0, size * 0.78, spec.kind === 'ruby' ? 4 : 6, spec.kind === 'ruby' ? Math.PI / 4 : -Math.PI / 2);
        ctx.fillStyle = rgbaHex(accent, 0.26);
        ctx.fill();
        ctx.stroke();
        drawText(spec.label, spec.label.length > 2 ? 0.50 : 0.68);
      } else {
        // Deliberate generic environment symbol: a small constellation compass,
        // never an icon borrowed from another technology.
        ctx.beginPath();
        ctx.moveTo(0, -size * 0.72);
        ctx.lineTo(size * 0.16, -size * 0.16);
        ctx.lineTo(size * 0.72, 0);
        ctx.lineTo(size * 0.16, size * 0.16);
        ctx.lineTo(0, size * 0.72);
        ctx.lineTo(-size * 0.16, size * 0.16);
        ctx.lineTo(-size * 0.72, 0);
        ctx.lineTo(-size * 0.16, -size * 0.16);
        ctx.closePath();
        ctx.fillStyle = rgbaHex(accent, 0.24);
        ctx.fill();
        ctx.stroke();
        drawText(spec.label, spec.label.length > 2 ? 0.42 : 0.56, 800);
      }
      ctx.restore();
    }

    function drawEnvironmentAnchors(now) {
      for (const [key, aggregate] of state.environmentBounds) {
        const definition = environmentDefinition(
          aggregate.environmentId,
          aggregate.familyId,
        );
        const family = familyDefinition(aggregate.familyId);
        const point = worldToScreen(
          aggregate.position.x,
          aggregate.position.y,
        );
        const radius = clamp(
          (18 + Math.sqrt(aggregate.files.length) * 2.6) *
            Math.sqrt(state.camera.zoom),
          13,
          35,
        );
        const cellTopLeft = worldToScreen(
          aggregate.cellBounds.minX,
          aggregate.cellBounds.minY,
        );
        const cellBottomRight = worldToScreen(
          aggregate.cellBounds.maxX,
          aggregate.cellBounds.maxY,
        );
        const cellX = cellTopLeft.x;
        const cellY = cellTopLeft.y;
        const cellWidth = cellBottomRight.x - cellTopLeft.x;
        const cellHeight = cellBottomRight.y - cellTopLeft.y;
        if (
          cellX > state.cssWidth + 80 ||
          cellX + cellWidth < -80 ||
          cellY > state.cssHeight + 80 ||
          cellY + cellHeight < -80
        ) continue;

        const selected = state.selected?.kind === 'environment' &&
          state.selected.id === key;
        const hovered = state.hovered?.kind === 'environment' &&
          state.hovered.id === key;
        const semanticCount = aggregate.files.reduce((count, item) =>
          count + Number(semanticAvailabilityForFile(item.file).available), 0);
        const diveCapable = semanticCount > 0;
        const pulse = reduceMotion ? 0.5 :
          (Math.sin(now * 0.0028 + stableHash(key)) + 1) / 2;

        ctx.save();
        roundedPath(
          cellX,
          cellY,
          Math.max(1, cellWidth),
          Math.max(1, cellHeight),
          clamp(12 * Math.sqrt(state.camera.zoom), 6, 15),
        );
        const cellFill = ctx.createRadialGradient(
          point.x,
          point.y,
          0,
          point.x,
          point.y,
          Math.max(30, Math.min(cellWidth, cellHeight) * 0.62),
        );
        cellFill.addColorStop(0, rgbaHex(family.accent, diveCapable ? 0.050 : 0.026));
        cellFill.addColorStop(1, rgbaHex(family.accent, 0));
        ctx.fillStyle = cellFill;
        ctx.fill();
        ctx.strokeStyle = diveCapable
          ? rgbaHex(family.accent, selected ? 0.56 : 0.20)
          : 'rgba(112,139,156,.17)';
        ctx.lineWidth = selected ? 1.25 : 0.66;
        // Q1-SURF-PERF-01: dashes are tessellated per segment; keep them for the focused anchor only, static.
        ctx.setLineDash(selected || hovered ? (diveCapable ? [4, 9] : [6, 7]) : []);
        ctx.stroke();
        ctx.setLineDash([]);

        const orbitWidth = Math.max(radius * 2.2, Math.min(cellWidth * 0.34, 82));
        const orbitHeight = Math.max(radius * 1.6, Math.min(cellHeight * 0.24, 54));
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = rgbaHex(
          family.accent,
          diveCapable ? 0.18 + pulse * 0.08 : 0.09,
        );
        ctx.lineWidth = 0.72;
        ctx.shadowColor = rgbaHex(family.accent, 0.44);
        ctx.shadowBlur = selected || hovered ? 7 : 0;
        ctx.beginPath();
        ctx.ellipse(point.x, point.y, orbitWidth, orbitHeight, -0.12, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(point.x, point.y, orbitWidth * 0.72, orbitHeight * 1.20, 0.54, 0, TAU);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const aura = ctx.createRadialGradient(
          point.x,
          point.y,
          0,
          point.x,
          point.y,
          radius * (diveCapable ? 2.9 : 2.25),
        );
        aura.addColorStop(
          0,
          rgbaHex(family.accent, selected ? 0.44 : diveCapable ? 0.24 : 0.13),
        );
        aura.addColorStop(0.58, rgbaHex(family.accent, diveCapable ? 0.07 : 0.035));
        aura.addColorStop(1, rgbaHex(family.accent, 0));
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius * (diveCapable ? 2.9 : 2.25), 0, TAU);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.fillStyle = 'rgba(2,11,18,.96)';
        ctx.strokeStyle = diveCapable
          ? rgbaHex(family.accent, selected ? 1 : hovered ? 0.88 : 0.70)
          : 'rgba(120,151,168,.52)';
        ctx.lineWidth = selected ? 2.15 : 1.25;
        ctx.shadowColor = diveCapable
          ? rgbaHex(family.accent, 0.92)
          : 'rgba(86,120,139,.42)';
        ctx.shadowBlur = selected ? 18 : hovered ? 12 : 0;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, TAU);
        ctx.fill();
        ctx.stroke();

        ctx.setLineDash(diveCapable ? [] : [3, 4]);
        ctx.strokeStyle = diveCapable
          ? `rgba(244,175,45,${0.35 + pulse * 0.20})`
          : 'rgba(123,151,167,.34)';
        ctx.lineWidth = diveCapable ? 1.0 : 0.72;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 5.5, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);

        const spec = technologyIconSpec(definition, aggregate.environmentId);
        drawTechnologyIcon(point.x, point.y, radius, spec, family.accent);

        const markerAngle = -Math.PI / 4;
        const markerX = point.x + Math.cos(markerAngle) * (radius + 5.5);
        const markerY = point.y + Math.sin(markerAngle) * (radius + 5.5);
        ctx.beginPath();
        ctx.arc(markerX, markerY, diveCapable ? 3.4 : 2.6, 0, TAU);
        ctx.fillStyle = diveCapable ? '#f4af2d' : '#6e8796';
        ctx.shadowColor = diveCapable
          ? 'rgba(244,175,45,.95)'
          : 'rgba(100,137,156,.54)';
        ctx.shadowBlur = diveCapable ? 8 : 2;
        ctx.fill();

        const showLabel = state.camera.zoom >= 0.20 || selected || hovered;
        if (showLabel) {
          const capability = diveCapable
            ? `DIVE ${semanticCount}/${aggregate.files.length}`
            : 'PHYSICAL ONLY';
          const label = `${definition.label} · ${aggregate.files.length} · ${capability}`;
          ctx.font = '750 7.5px ui-monospace,Consolas,monospace';
          const width = Math.min(
            Math.max(86, ctx.measureText(label).width + 12),
            Math.max(86, cellWidth - 12),
          );
          roundedPath(
            point.x - width / 2,
            point.y + radius + 8,
            width,
            18,
            3,
          );
          ctx.fillStyle = 'rgba(1,8,14,.92)';
          ctx.fill();
          ctx.strokeStyle = diveCapable
            ? rgbaHex(family.accent, 0.42)
            : 'rgba(105,137,154,.25)';
          ctx.lineWidth = 0.75;
          ctx.stroke();
          ctx.fillStyle = diveCapable ? '#d9f2fb' : '#91a9b6';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowBlur = 0;
          ctx.fillText(
            label,
            point.x,
            point.y + radius + 17,
            width - 10,
          );
        }
        ctx.restore();

        state.screenEntities.push({
          kind: 'environment',
          id: key,
          x: point.x,
          y: point.y,
          radius: radius + 9,
          priority: 2,
        });
      }
    }

    function hexagon(x, y, radius) {
      ctx.beginPath();
      for (let index = 0; index < 6; index += 1) {
        const angle = -Math.PI / 2 + index * TAU / 6;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }


    function environmentKeyForFile(file) {
      return `${file.familyId}\u0000${file.environmentId}`;
    }

    function aggregateEnvironmentEdges() {
      const aggregates = new Map();
      for (const edge of state.edges.values()) {
        const fromFile = state.files.get(edge.from);
        const toFile = state.files.get(edge.to);
        if (!fromFile || !toFile || fromFile.excluded || toFile.excluded) {
          continue;
        }
        const from = environmentKeyForFile(fromFile);
        const to = environmentKeyForFile(toFile);
        if (from === to) continue;
        const id = `${from}\u0001${to}`;
        const previous = aggregates.get(id);
        aggregates.set(id, {
          id,
          from,
          to,
          weight: (previous?.weight || 0) + (edge.weight || 1),
          count: (previous?.count || 0) + 1,
        });
      }
      return [...aggregates.values()];
    }

    function drawAggregateRelations(now, basePass = false) {
      if (!state.edges.size) return;
      const aggregates = aggregateEnvironmentEdges();
      const strong = state.lens === 'environment' ||
        state.lens === 'cross';
      if (!basePass && !strong) return;
      if (basePass && strong) return;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const aggregate of aggregates) {
        const from = state.environmentBounds.get(aggregate.from);
        const to = state.environmentBounds.get(aggregate.to);
        if (!from || !to) continue;
        const a = worldToScreen(from.position.x, from.position.y);
        const b = worldToScreen(to.position.x, to.position.y);
        const fromFamily = familyDefinition(from.familyId);
        const crossFamily = from.familyId !== to.familyId;
        const alpha = basePass
          ? (crossFamily ? 0.105 : 0.055)
          : (state.lens === 'cross' && !crossFamily ? 0.11 : 0.30);
        if (
          state.lens === 'cross' &&
          !basePass &&
          !crossFamily
        ) continue;

        const midpoint = {
          x: (a.x + b.x) / 2,
          y: Math.min(a.y, b.y) -
            Math.min(58, Math.abs(a.x - b.x) * 0.08),
        };
        ctx.strokeStyle = rgbaHex(fromFamily.accent, alpha);
        ctx.lineWidth = clamp(
          (basePass ? 0.55 : 1.0) +
            Math.log2(1 + aggregate.weight) * (basePass ? 0.16 : 0.36),
          0.45,
          basePass ? 1.6 : 4.0,
        );
        ctx.shadowColor = rgbaHex(fromFamily.accent, 0.6);
        ctx.shadowBlur = basePass ? 0 : 8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(midpoint.x, midpoint.y, b.x, b.y);
        ctx.stroke();

        if (!basePass && !reduceMotion) {
          const phase = (
            now * 0.00012 +
            hash01(aggregate.id, 'relation')
          ) % 1;
          const oneMinus = 1 - phase;
          const px = oneMinus * oneMinus * a.x +
            2 * oneMinus * phase * midpoint.x +
            phase * phase * b.x;
          const py = oneMinus * oneMinus * a.y +
            2 * oneMinus * phase * midpoint.y +
            phase * phase * b.y;
          ctx.fillStyle = 'rgba(224,251,255,.82)';
          ctx.shadowColor = rgbaHex(fromFamily.accent, 0.95);
          ctx.shadowBlur = 9;
          ctx.beginPath();
          ctx.arc(px, py, 1.7, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    function selectedNeighborhood(depth) {
      const selected = state.selected?.kind === 'file'
        ? state.selected.id
        : state.hovered?.kind === 'file'
          ? state.hovered.id
          : null;
      if (!selected) return { nodes: new Set(), edges: [] };
      const nodes = new Set([selected]);
      const edges = [];
      let frontier = new Set([selected]);
      for (let level = 0; level < depth; level += 1) {
        const next = new Set();
        for (const edge of state.edges.values()) {
          if (
            !frontier.has(edge.from) &&
            !frontier.has(edge.to)
          ) continue;
          edges.push(edge);
          const neighbor = frontier.has(edge.from)
            ? edge.to
            : edge.from;
          if (!nodes.has(neighbor)) next.add(neighbor);
          nodes.add(neighbor);
        }
        frontier = next;
        if (!frontier.size) break;
      }
      return { nodes, edges };
    }

    function drawFocusedRelationships(now) {
      drawAggregateRelations(now, false);
      if (
        !['direct', 'neighborhood'].includes(state.lens) &&
        !(state.hovered?.kind === 'file')
      ) {
        drawCloseRangeSpokes();
        return;
      }
      const depth = state.lens === 'neighborhood' ? 2 : 1;
      const neighborhood = selectedNeighborhood(depth);
      if (!neighborhood.edges.length) {
        drawCloseRangeSpokes();
        return;
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const edge of neighborhood.edges) {
        const fromPosition = state.filePositions.get(edge.from);
        const toPosition = state.filePositions.get(edge.to);
        if (!fromPosition || !toPosition) continue;
        const a = worldToScreen(fromPosition.x, fromPosition.y);
        const b = worldToScreen(toPosition.x, toPosition.y);
        const fromFile = state.files.get(edge.from);
        const toFile = state.files.get(edge.to);
        const cross = fromFile && toFile &&
          (fromFile.environmentId !== toFile.environmentId ||
            fromFile.familyId !== toFile.familyId);
        const color = cross ? '#f4af2d' : '#00a3e0';
        ctx.strokeStyle = rgbaHex(color, cross ? 0.66 : 0.48);
        ctx.lineWidth = clamp(
          0.85 + Math.log2(1 + (edge.weight || 1)) * 0.35,
          0.85,
          3.1,
        );
        ctx.shadowColor = rgbaHex(color, 0.84);
        ctx.shadowBlur = 7;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        if (edge.directed !== false) {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.max(1, Math.hypot(dx, dy));
          const t = 0.66;
          const x = a.x + dx * t;
          const y = a.y + dy * t;
          const tx = dx / length;
          const ty = dy / length;
          const nx = -ty;
          const ny = tx;
          const size = 3.5;
          ctx.fillStyle = rgbaHex(color, 0.82);
          ctx.beginPath();
          ctx.moveTo(x + tx * size, y + ty * size);
          ctx.lineTo(
            x - tx * size + nx * size * 0.65,
            y - ty * size + ny * size * 0.65,
          );
          ctx.lineTo(
            x - tx * size - nx * size * 0.65,
            y - ty * size - ny * size * 0.65,
          );
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
      drawCloseRangeSpokes();
    }

    function drawCloseRangeSpokes() {
      if (state.camera.zoom < 1.25) return;
      const selectedEnvironment = state.selected?.kind === 'environment'
        ? state.selected.id
        : state.selected?.kind === 'file'
          ? environmentKeyForFile(state.files.get(state.selected.id) || {})
          : null;
      if (!selectedEnvironment) return;
      const aggregate = state.environmentBounds.get(selectedEnvironment);
      if (!aggregate || aggregate.files.length > 180) return;
      const anchor = worldToScreen(
        aggregate.position.x,
        aggregate.position.y,
      );
      const family = familyDefinition(aggregate.familyId);
      ctx.save();
      ctx.strokeStyle = rgbaHex(family.accent, 0.10);
      ctx.lineWidth = 0.55;
      for (const item of aggregate.files) {
        if (item.file.excluded) continue;
        const point = worldToScreen(item.position.x, item.position.y);
        ctx.beginPath();
        ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function lifecycleVisual(file, selected) {
      if (selected) {
        return {
          core: '#f4af2d',
          label: 'SELECTED',
          motion: 'focus',
        };
      }
      const inventory = normalizeToken(file.inventoryState);
      const recognition = normalizeToken(file.recognitionState);
      if (
        inventory === 'removed' ||
        recognition === 'failed'
      ) {
        return {
          core: '#ff5500',
          label: inventory === 'removed' ? 'REMOVED' : 'FAILED',
          motion: 'fault',
        };
      }
      if (
        ['added', 'modified', 'observed'].includes(inventory) ||
        ['pending', 'partial', 'blocked', 'diagnosing', 'testing']
          .includes(recognition)
      ) {
        return {
          core: '#ff5500',
          label: inventory || recognition || 'DISCOVERED',
          motion: 'pulse',
        };
      }
      if (
        ['patching', 'candidate-patching', 'applying-patch']
          .includes(recognition)
      ) {
        return {
          core: '#39ff88',
          label: 'PATCHING',
          motion: 'contour',
        };
      }
      if (
        ['recognized', 'verified', 'committed', 'stable']
          .includes(recognition) ||
        inventory === 'committed'
      ) {
        return {
          core: '#00a3e0',
          label: recognition || 'COMMITTED',
          motion: 'stable',
        };
      }
      return {
        core: '#6b8799',
        label: recognition || 'UNKNOWN',
        motion: 'unknown',
      };
    }

    function fileRadius(file) {
      if (file.bytes == null) return 3.2;
      const scale = clamp(
        0.82 + Math.log2(Math.max(1, file.bytes) + 1) * 0.025,
        0.82,
        1.38,
      );
      return 3.2 * scale;
    }

    function drawFileNodes(now) {
      const selectedNeighborhoodState = selectedNeighborhood(
        state.lens === 'neighborhood' ? 2 : 1,
      );
      const focusedNodes = selectedNeighborhoodState.nodes;
      const dimForFocus = focusedNodes.size > 1;
      const searchSet = new Set(state.searchMatches);
      let labelBudget = state.camera.zoom >= 1.8
        ? 220
        : state.camera.zoom >= 1.0
          ? 100
          : 24;

      const files = activeFiles()
        .filter((file) => !file.excluded)
        .sort((left, right) => {
          const leftSelected = state.selected?.kind === 'file' &&
            state.selected.id === left.key;
          const rightSelected = state.selected?.kind === 'file' &&
            state.selected.id === right.key;
          return Number(leftSelected) - Number(rightSelected);
        });

      for (const file of files) {
        const position = state.filePositions.get(file.key) ||
          ensureFilePosition(file);
        if (!position) continue;
        const point = worldToScreen(position.x, position.y);
        if (
          point.x < -55 ||
          point.x > state.cssWidth + 55 ||
          point.y < -55 ||
          point.y > state.cssHeight + 55
        ) continue;
        const selected = state.selected?.kind === 'file' &&
          state.selected.id === file.key;
        const hovered = state.hovered?.kind === 'file' &&
          state.hovered.id === file.key;
        const searched = searchSet.has(file.key);
        const related = focusedNodes.has(file.key);
        const visual = lifecycleVisual(file, selected);
        const family = familyDefinition(file.familyId);
        const environment = environmentDefinition(
          file.environmentId,
          file.familyId,
        );
        const semantic = semanticAvailabilityForFile(file);
        const baseRadius = fileRadius(file);
        const radius = clamp(
          baseRadius * Math.sqrt(state.camera.zoom),
          2.0,
          10.5,
        );
        const removedProgress = file.removedAt
          ? clamp((now - file.removedAt) / FILE_PURGE_MS, 0, 1)
          : 0;
        const focusAlpha = dimForFocus && !related &&
          !selected && !hovered ? 0.16 : 1;
        const alpha = (1 - removedProgress) * focusAlpha;

        ctx.save();
        ctx.globalAlpha = alpha;
        if (
          now - (file.transitionAt || 0) <
            DISCOVERY_PULSE_MS &&
          visual.motion !== 'stable'
        ) {
          const progress = clamp(
            (now - file.transitionAt) / DISCOVERY_PULSE_MS,
            0,
            1,
          );
          const ring = radius + 5 + progress * 13;
          ctx.strokeStyle = rgbaHex(
            visual.core,
            (1 - progress) * 0.58,
          );
          ctx.lineWidth = 1.1;
          ctx.shadowColor = rgbaHex(visual.core, 0.88);
          ctx.shadowBlur = 10;
          familyShapePath(point.x, point.y, ring, family.shape);
          ctx.stroke();
        }

        ctx.strokeStyle = rgbaHex(
          family.accent,
          selected ? 1 : hovered || searched ? 0.88 : 0.58,
        );
        ctx.lineWidth = selected ? 2.0 : 1.05;
        ctx.shadowColor = rgbaHex(
          selected ? '#f4af2d' : family.accent,
          selected ? 0.92 : 0.62,
        );
        ctx.shadowBlur = selected ? 14 : hovered || searched ? 9 : 0;
        familyShapePath(point.x, point.y, radius + 2.6, family.shape);
        ctx.stroke();

        drawMicroPattern(
          point.x,
          point.y,
          radius + 4.1,
          family,
          file.key,
        );

        if (!selected && !hovered) {
          // Q1-SURF-PERF-01: one wider low-alpha fill reads as a glow without a per-node blur layer.
          ctx.shadowBlur = 0;
          ctx.fillStyle = rgbaHex(visual.core, 0.22);
          familyShapePath(point.x, point.y, radius + 2.2, family.shape);
          ctx.fill();
        }
        ctx.fillStyle = visual.core;
        ctx.shadowColor = rgbaHex(visual.core, 0.94);
        ctx.shadowBlur = selected || hovered ? 13 : 0;
        familyShapePath(point.x, point.y, radius, family.shape);
        ctx.fill();

        if (
          state.camera.zoom >= 1.6 ||
          selected ||
          hovered
        ) {
          const glyph = environmentGlyph(environment, file.environmentId);
          const compact = glyph.length > 3
            ? glyph.slice(0, 2)
            : glyph;
          ctx.fillStyle = '#effcff';
          ctx.font = `850 ${clamp(radius * 0.86, 5.2, 8.4)}px ui-monospace,Consolas,monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0,0,0,.9)';
          ctx.shadowBlur = selected || hovered ? 2 : 0;
          ctx.fillText(compact, point.x, point.y + 0.2);
        }

        if (state.camera.zoom >= 0.34 || selected || hovered || searched) {
          const markerAngle = -Math.PI / 4;
          const markerOrbit = radius + 3.4;
          const markerX = point.x + Math.cos(markerAngle) * markerOrbit;
          const markerY = point.y + Math.sin(markerAngle) * markerOrbit;
          if (semantic.available) {
            ctx.strokeStyle = 'rgba(244,175,45,.72)';
            ctx.lineWidth = selected ? 1.25 : 0.85;
            ctx.shadowColor = 'rgba(244,175,45,.92)';
            ctx.shadowBlur = selected || hovered ? 8 : 0;
            ctx.beginPath();
            ctx.arc(
              point.x,
              point.y,
              radius + 3.6,
              markerAngle - 0.34,
              markerAngle + 0.34,
            );
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(markerX, markerY, selected ? 2.3 : 1.75, 0, TAU);
            ctx.fillStyle = '#f4af2d';
            ctx.fill();
          } else {
            ctx.setLineDash([1.6, 2.3]);
            ctx.strokeStyle = 'rgba(126,151,165,.42)';
            ctx.lineWidth = 0.68;
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.arc(
              point.x,
              point.y,
              radius + 3.3,
              markerAngle - 0.29,
              markerAngle + 0.29,
            );
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(markerX, markerY, 1.4, 0, TAU);
            ctx.fillStyle = 'rgba(115,141,156,.64)';
            ctx.fill();
          }
        }

        if (file.removedAt) {
          ctx.strokeStyle = 'rgba(255,255,255,.56)';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(point.x - radius, point.y - radius);
          ctx.lineTo(point.x + radius, point.y + radius);
          ctx.stroke();
        }

        const forceLabel = selected || hovered || searched;
        const showNearLabel = state.camera.zoom >= 1.05 &&
          labelBudget > 0;
        if (forceLabel || showNearLabel) {
          if (!forceLabel) labelBudget -= 1;
          drawFileLabel(
            file,
            point,
            radius,
            family,
            visual,
            {
              selected,
              hovered,
              searched,
              force: forceLabel,
            },
          );
        }
        ctx.restore();

        state.screenEntities.push({
          kind: 'file',
          id: file.key,
          x: point.x,
          y: point.y,
          radius: Math.max(7, radius + 5),
          priority: 4,
        });
      }
    }

    function drawMicroPattern(x, y, radius, family, seed) {
      ctx.save();
      ctx.translate(x, y);
      // Q1-SURF-PERF-01: the caller leaves shadowBlur set; every tick became its own blur layer.
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = rgbaHex(family.accent, 0.82);
      ctx.lineWidth = 0.7;
      const phase = hash01(seed, 'pattern') * TAU;
      const segments = family.pattern === 'dotted'
        ? 6
        : family.pattern === 'broken'
          ? 4
          : 8;
      for (let index = 0; index < segments; index += 1) {
        if (
          family.pattern === 'broken' &&
          index % 2
        ) continue;
        const angle = phase + index * TAU / segments;
        const length = family.pattern === 'double' ? 2.8 : 2.1;
        ctx.beginPath();
        ctx.moveTo(
          Math.cos(angle) * (radius - length),
          Math.sin(angle) * (radius - length),
        );
        ctx.lineTo(
          Math.cos(angle) * (radius + length),
          Math.sin(angle) * (radius + length),
        );
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawFileLabel(file, point, radius, family, visual, flags) {
      const label = file.name || file.path || 'UNNAMED FILE';
      ctx.save();
      ctx.font = `${flags.selected ? 800 : 700} ${
        flags.selected ? 9 : 7.4
      }px ui-monospace,Consolas,monospace`;
      const width = Math.min(
        250,
        ctx.measureText(label).width + 14,
      );
      const x = point.x + radius + 7;
      const y = point.y - 9;
      roundedPath(x, y, width, 19, 3);
      ctx.fillStyle = flags.selected
        ? 'rgba(24,17,3,.96)'
        : 'rgba(1,8,14,.92)';
      ctx.fill();
      ctx.strokeStyle = flags.selected
        ? 'rgba(244,175,45,.82)'
        : flags.searched
          ? 'rgba(221,248,255,.72)'
          : rgbaHex(family.accent, 0.46);
      ctx.lineWidth = flags.selected ? 1.15 : 0.7;
      ctx.shadowColor = flags.selected
        ? 'rgba(244,175,45,.72)'
        : rgbaHex(family.accent, 0.65);
      ctx.shadowBlur = flags.selected || flags.hovered ? 8 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#e5f6ff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        label,
        x + 7,
        y + 9.5,
        width - 14,
      );

      if (flags.selected || flags.hovered) {
        const status = String(visual.label || 'UNKNOWN').toUpperCase();
        ctx.font = '750 6px ui-monospace,Consolas,monospace';
        const statusWidth = ctx.measureText(status).width + 10;
        roundedPath(
          x,
          y + 21,
          statusWidth,
          14,
          2,
        );
        ctx.fillStyle = 'rgba(1,8,14,.92)';
        ctx.fill();
        ctx.strokeStyle = rgbaHex(visual.core, 0.50);
        ctx.stroke();
        ctx.fillStyle = rgbaHex(visual.core, 0.95);
        ctx.fillText(status, x + 5, y + 28);
      }
      ctx.restore();
    }

    function syncProjectIdentityIcon() {
      if (state.projectIconSource && projectIcon.src) return true;
      const canonicalSvg = shadow.querySelector(
        '.dragon-overlay svg[data-component="CLU_E_PROJECT_DRAGON_ICON"], .dragon-overlay svg',
      );
      if (!canonicalSvg) return false;
      try {
        const serialized = new XMLSerializer().serializeToString(canonicalSvg);
        projectIcon.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
        state.projectIconSource = 'canonical-dive-project-dragon';
        projectIcon.addEventListener('load', markDirty, { once: true });
        return true;
      } catch (error) {
        recordProjectionError(
          'PROJECT_ICON_PARITY_FAILED',
          error?.message || String(error),
        );
        return false;
      }
    }

    function drawProjectRoot(now) {
      const point = worldToScreen(0, PROJECT_Y);
      const radius = clamp(
        34 * Math.sqrt(state.camera.zoom),
        22,
        52,
      );
      const iconSize = clamp(
        146 * Math.sqrt(state.camera.zoom),
        86,
        224,
      );
      const files = activeFiles().filter((file) => !file.excluded);
      const selected = state.selected?.kind === 'project';
      const hovered = state.hovered?.kind === 'project';
      const iconReady = syncProjectIdentityIcon();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const aura = ctx.createRadialGradient(
        point.x,
        point.y,
        0,
        point.x,
        point.y,
        iconSize * 0.72,
      );
      aura.addColorStop(0, 'rgba(0,234,255,.20)');
      aura.addColorStop(0.42, 'rgba(0,168,107,.10)');
      aura.addColorStop(0.72, 'rgba(244,175,45,.055)');
      aura.addColorStop(1, 'rgba(0,163,224,0)');
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(point.x, point.y, iconSize * 0.72, 0, TAU);
      ctx.fill();

      const pulse = reduceMotion ? 0 : (Math.sin(now * 0.0022) + 1) / 2;
      ctx.strokeStyle = selected
        ? `rgba(244,175,45,${0.72 + pulse * 0.20})`
        : hovered
          ? 'rgba(226,253,255,.78)'
          : `rgba(0,234,255,${0.25 + pulse * 0.13})`;
      ctx.lineWidth = selected ? 1.8 : 0.9;
      ctx.shadowColor = selected
        ? 'rgba(244,175,45,.88)'
        : 'rgba(0,234,255,.72)';
      ctx.shadowBlur = selected ? 24 : 15;
      ctx.beginPath();
      ctx.arc(point.x, point.y, iconSize * 0.39, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([3, 8]);
      ctx.lineDashOffset = reduceMotion ? 0 : -now * 0.018;
      ctx.strokeStyle = selected
        ? 'rgba(255,240,174,.56)'
        : 'rgba(143,255,224,.38)';
      ctx.beginPath();
      ctx.arc(point.x, point.y, iconSize * 0.47, 0, TAU);
      ctx.stroke();
      ctx.restore();

      if (iconReady) {
        projectIcon.style.left = `${point.x}px`;
        projectIcon.style.top = `${point.y}px`;
        projectIcon.style.width = `${iconSize}px`;
        projectIcon.style.height = `${iconSize}px`;
        projectIcon.classList.add('is-visible');
        projectIcon.classList.toggle('is-selected', selected);
        projectIcon.classList.toggle('is-hovered', hovered && !selected);
      } else {
        ctx.save();
        ctx.fillStyle = 'rgba(3,18,28,.96)';
        ctx.strokeStyle = selected
          ? 'rgba(244,175,45,.96)'
          : 'rgba(55,210,255,.76)';
        ctx.lineWidth = selected ? 2 : 1.2;
        ctx.shadowColor = selected
          ? 'rgba(244,175,45,.92)'
          : 'rgba(0,163,224,.88)';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#e9fbff';
        ctx.font = `900 ${clamp(radius * 0.32, 8, 13)}px ui-monospace,Consolas,monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('CLU-E', point.x, point.y);
        ctx.restore();
      }

      const label = state.projectName || state.repositoryId ||
        'REGISTERED PROJECT';
      const labelY = point.y + iconSize * 0.40 + 8;
      ctx.save();
      ctx.font = '850 9px ui-monospace,Consolas,monospace';
      const labelWidth = Math.min(
        330,
        ctx.measureText(label).width + 18,
      );
      roundedPath(
        point.x - labelWidth / 2,
        labelY,
        labelWidth,
        22,
        4,
      );
      ctx.fillStyle = 'rgba(1,8,14,.94)';
      ctx.fill();
      ctx.strokeStyle = selected
        ? 'rgba(244,175,45,.65)'
        : 'rgba(0,234,255,.42)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.fillStyle = '#ddf5ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        label,
        point.x,
        labelY + 11,
        labelWidth - 14,
      );

      ctx.font = '650 6.8px ui-monospace,Consolas,monospace';
      ctx.fillStyle = 'rgba(119,154,176,.80)';
      ctx.fillText(
        `${files.length} FILES · ${state.familyBounds.size} FAMILIES · ` +
        `${state.environmentBounds.size} ENVIRONMENTS · SNAPSHOT ${shortId(state.snapshotId, 9)}`,
        point.x,
        labelY + 36,
      );
      ctx.restore();

      state.screenEntities.push({
        kind: 'project',
        id: 'project',
        x: point.x,
        y: point.y,
        radius: Math.max(radius + 12, iconSize * 0.38),
        priority: 3,
      });
    }


    function pointInsideRect(x, y, rect) {
      return Boolean(rect) &&
        x >= rect.x && x <= rect.x + rect.width &&
        y >= rect.y && y <= rect.y + rect.height;
    }

    function hitResult(entity) {
      return {
        kind: entity.kind,
        id: entity.id,
        familyId: entity.familyId || null,
        direction: entity.direction || null,
      };
    }

    function buildSpatialBuckets() {
      const bucketSize = 64;
      for (const entity of state.screenEntities) {
        // Rectangular family controls are tested directly so a wide header does
        // not flood every spatial bucket in the viewport.
        if (entity.rect) continue;
        const radius = Math.max(8, entity.radius || 8);
        const minX = Math.floor((entity.x - radius) / bucketSize);
        const maxX = Math.floor((entity.x + radius) / bucketSize);
        const minY = Math.floor((entity.y - radius) / bucketSize);
        const maxY = Math.floor((entity.y + radius) / bucketSize);
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) {
            const key = `${x}:${y}`;
            if (!state.spatialBuckets.has(key)) {
              state.spatialBuckets.set(key, []);
            }
            state.spatialBuckets.get(key).push(entity);
          }
        }
      }
    }

    function hitTest(x, y) {
      const controls = state.screenEntities
        .filter((entity) => entity.rect && (
          entity.kind === 'family-resize' ||
          entity.kind === 'family-drag'
        ))
        .sort((left, right) =>
          (right.priority || 0) - (left.priority || 0));
      for (const entity of controls) {
        if (pointInsideRect(x, y, entity.rect)) return hitResult(entity);
      }

      const bucketSize = 64;
      const bucketX = Math.floor(x / bucketSize);
      const bucketY = Math.floor(y / bucketSize);
      const candidates = [];
      const seen = new Set();
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const bucket = state.spatialBuckets.get(
            `${bucketX + dx}:${bucketY + dy}`,
          ) || [];
          for (const entity of bucket) {
            const signature = `${entity.kind}:${entity.id}`;
            if (seen.has(signature)) continue;
            seen.add(signature);
            candidates.push(entity);
          }
        }
      }
      candidates.sort((left, right) =>
        (right.priority || 0) - (left.priority || 0));
      for (const entity of candidates) {
        if (
          Math.hypot(x - entity.x, y - entity.y) <=
          (entity.radius || 8)
        ) {
          return hitResult(entity);
        }
      }

      const families = state.screenEntities
        .filter((entity) => entity.kind === 'family' && entity.rect)
        .reverse();
      for (const entity of families) {
        if (pointInsideRect(x, y, entity.rect)) return hitResult(entity);
      }
      return null;
    }

    function remove() {
      if (state.destroyed) return;
      state.destroyed = true;
      cancelAnimationFrame(state.raf);
      clearTimeout(state.purgeTimer);
      clearTimeout(state.toastTimer);
      clearTimeout(state.semanticWarningTimer);
      clearTimeout(state.semanticDrillTimer);
      state.resizeObserver?.disconnect();
      if (!state.resizeObserver) {
        window.removeEventListener('resize', resize);
      }
      state.modeObserver?.disconnect();
      restoreLegacyModeControl();
      for (const dispose of state.eventDisposers.splice(0)) {
        try { dispose(); } catch { /* best-effort cleanup */ }
      }
      state.restoreSceneRender?.();
      layer.remove();
      style.remove();
      if (window.__q1V9 === api) delete window.__q1V9;
      if (window.__q1Navigator?.v9 === api) {
        try {
          const next = { ...window.__q1Navigator };
          delete next.v9;
          window.__q1Navigator = next;
        } catch { /* optional diagnostics */ }
      }
    }
  }
})();

/* --------------------------- sealed frames (Q4) --------------------------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

// DEV-P1-16: semanticEventState moved to quadrants/q4Console.js — its ordering (failure before
// warning before success, so "retry succeeded" reads as a warning) is now asserted rather than
// implied by the regex order.

function renderFrame(frame) {
  const snapshot = frame?.snapshot;
  if (!snapshot) return;

  ribbon.updateFrame(frame);
  updateRibbonStream('sealed', dashboardStreams.sealed);

  const q4 = snapshot.dashboard?.operationalConsole;
  renderWork(q4?.currentWorkContract ?? null);
  renderFeed(q4?.events ?? []);
  ClueInterface.setPanelState('q4', q4 ? 'live' : 'idle', q4 ? 'SEALED CONSOLE LIVE' : 'AWAITING CONSOLE');
  ClueInterface.pulse('q4');
}

function renderWork(contract) {
  const work = $('work');
  if (!work) return;
  if (!contract) {
    work.innerHTML = '<div class="empty" style="grid-column:1/-1">No current work contract. CLU-E is preserving an honest idle state.</div>';
    return;
  }
  // DEV-P1-16: the rows and their §9.1 order are decided in quadrants/q4Console.js.
  work.innerHTML = workContractRows(contract).map(({ key, value, className }) =>
    `<div class="clue-work-field ${className}"><div class="clue-work-key">${key}</div><div class="clue-work-value">${escapeHtml(value ?? '—')}</div></div>`,
  ).join('');
}

function renderFeed(events) {
  const feed = $('feed');
  if (!feed) return;
  feed.setAttribute('aria-live', 'polite');
  if (!Array.isArray(events) || !events.length) {
    feed.innerHTML = '<div class="empty">No operational traffic has been recorded. Enter /start in the command console to begin a cycle.</div>';
    return;
  }
  // DEV-P1-16: which events, in what order, classified how — decided in quadrants/q4Console.js.
  feed.innerHTML = feedEntries(events).map((entry) =>
    `<article class="clue-event" data-state="${entry.state}">
      <span class="clue-event-channel">${escapeHtml(entry.channel)}</span>
      <time class="clue-event-time" datetime="${escapeHtml(entry.occurredAt)}">${escapeHtml(entry.at)}</time>
      <span class="clue-event-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</span>
      <span class="clue-event-state">${escapeHtml(entry.statusText)}</span>
    </article>`,
  ).join('');
}

ConsoleFrameBus.subscribe(renderFrame);

/* ======================== Q2 DUAL FIELD (inline) ==========================
 * One authoritative Great Book model with two interchangeable projections:
 * a cinematic holographic sphere and the original analytical 10×10 grid.
 * Switching projection never duplicates or changes evidence, metric values,
 * exclusions, selection, catalogue metadata, Q3 totals or sealed-frame truth.
 *
 * Both views preserve one-metric inspection, animated family-colour selection,
 * adaptive metric identifiers, and the infrequent visual-only power-wave effect.
 * The wave may temporarily raise or recess zero-value cells, but it never mutates
 * a contribution, proof, Great Book record, metric state or acceptance result.
 * ======================================================================== */
(function initQ2Field() {
  const M = [
   ["MA01","Q01","Purpose alignment"],["MA02","Q02","Utility and value realization"],
   ["MA03","Q03","Capability preservation and evolution"],["MA04","Q04","Workload integrity"],
   ["MA05","Q05","Stakeholder and user outcome"],["MA06","Q06","Economy and total cost of ownership"],
   ["MB01","Q07","Functional completeness"],["MB02","Q08","Functional correctness"],
   ["MB03","Q09","Contract and API conformance"],["MB04","Q10","State and data integrity"],
   ["MB05","Q11","Temporal and concurrency correctness"],["MB06","Q12","Determinism and controlled variability"],
   ["MB07","Q13","Numerical and precision integrity"],["MC01","Q14","Complexity proportionality"],
   ["MC02","Q15","Architectural coherence"],["MC03","Q16","Cohesion"],
   ["MC04","Q17","Coupling and dependency surface"],["MC05","Q18","Modularity and replaceability"],
   ["MC06","Q19","Boundary and interface quality"],["MC07","Q20","Responsibility concentration"],
   ["MC08","Q21","Redundancy"],["MC09","Q22","Dead code"],
   ["MC10","Q23","Obsolescence"],["MC11","Q24","Technical debt"],
   ["MC12","Q25","Architectural entropy and evolvability"],["MC13","Q26","Analyzability and understandability"],
   ["MC14","Q27","Testability"],["MC15","Q28","Observability"],
   ["MD01","Q29","Intrinsic efficiency"],["MD02","Q30","Cost amplification"],
   ["MD03","Q31","Critical-path influence"],["MD04","Q32","Throughput and latency"],
   ["MD05","Q33","Tail behavior and cost predictability"],["MD06","Q34","Memory and resource lifecycle"],
   ["MD07","Q35","I/O, network, and storage efficiency"],["MD08","Q36","Scalability"],
   ["MD09","Q37","Degradation shape and resource adaptability"],["MD10","Q38","Energy and carbon efficiency"],
   ["ME01","Q39","Reliability and availability"],["ME02","Q40","Fragility and blast radius"],
   ["ME03","Q41","Fault isolation and containment"],["ME04","Q42","Resilience and recovery"],
   ["ME05","Q43","Graceful degradation and fallback quality"],["ME06","Q44","Reversibility and rollback"],
   ["ME07","Q45","Safety and fail-safe behavior"],["MF01","Q46","Security"],
   ["MF02","Q47","Privacy and data minimization"],["MF03","Q48","Supply-chain and provenance integrity"],
   ["MF04","Q49","Abuse and misuse resistance"],["MF05","Q50","Autonomy appropriateness and human control"],
   ["MF06","Q51","Auditability, accountability, and policy conformance"],["MG01","Q52","Compatibility and interoperability"],
   ["MG02","Q53","Backward and forward compatibility"],["MG03","Q54","Portability"],
   ["MG04","Q55","Adaptability and plasticity"],["MG05","Q56","Deployability and operability"],
   ["MG06","Q57","Accessibility, inclusivity, and usability"],["MG07","Q58","Reusability and generalization"],
   ["MH01","Q59","Explainability and transparency"],["MH02","Q60","Quality balance and Pareto integrity"],
   ["MI01","A01","Purpose-context sufficiency"],["MI02","A02","Measurement validity"],
   ["MI03","A03","Benchmark representativeness"],["MI04","A04","Coverage completeness"],
   ["MI05","A05","Causal attribution"],["MI06","A06","Confidence and uncertainty calibration"],
   ["MI07","A07","Knowledge freshness"],["MI08","A08","Instrument self-validity and observer effect"],
   ["MI09","A09","Reproducibility and replicability"],["MI10","A10","Regression sensitivity"],
   ["MI11","A11","Scope-of-claim integrity and residual unknowns"],["MJ01","G01","Purpose Preservation"],
   ["MJ02","G02","Capability Preservation"],["MJ03","G03","Workload Integrity"],
   ["MJ04","G04","Correctness and Contract Integrity"],["MJ05","G05","Evidence Admissibility"],
   ["MJ06","G06","Global Regression Guardrail"],["MJ07","G07","Reversibility and Recovery"],
   ["MK01","S01","Cost per proven improvement"],["MK02","S02","Time to terminal disposition"],
   ["MK03","S03","Finding precision"],["MK04","S04","Regression escape rate"],
   ["MK05","S05","Repeated-work rate"],["MK06","S06","Coverage and uncertainty reduction"],
   ["MK07","S07","Forecast calibration"],["MK08","S08","Instrument validity rate"],
   ["MK09","S09","Test-catalogue efficiency"],["MK10","S10","Mission continuity"],
   ["MK11","S11","Custody safety"],["MK12","S12","Equilibrium credibility"],
   ["MK13","S13","Measure-session token efficiency"],["MK14","S14","Model-routing value"],
   ["MK15","S15","Catalogue maintainability"],["MK16","S16","Catalogue-review effectiveness"],
   ["MK17","S17","Conversation-orchestration integrity"],["MK18","S18","Status fidelity"],
   // DEV-P1-16: catalogue v6 activated the four cells v3 reserved. While these read
   // RESERVED-97..100, `modelFromView` looked each server cell up by measurement id in this
   // list, found no MH03/MG08/MI12/MK19, and silently dropped all four — so four active
   // measures rendered as "held for future expansion" and their evidence never reached the
   // display. `selftest/dashboard-catalogue-parity.test.ts` now fails if this list and the
   // canonical coordinate map ever diverge again.
   ["MH03",null,"Method adequacy and applicable-frontier position"],
   ["MG08",null,"Cross-environment contract integrity and impedance"],
   ["MI12",null,"Evidence-plan and benchmark-synthesis validity"],
   ["MK19",null,"RPI value yield and horizon realization"]
  ];
  const DEF={
    MA01:"Does the unit and the complete program still serve the reason they exist?",
    MA02:"Does the unit deliver real value to users, the system, the Creator, or a protected recovery/safety path?",
    MA03:"Are required capabilities preserved, and are newly claimed capabilities real and verifiable?",
    MA04:"Did the improved result come from doing the same required work, rather than skipping, reducing, caching incorrectly, or hiding it?",
    MA05:"Does the change improve or preserve outcomes experienced by the people and systems the target exists to serve?",
    MA06:"Is the delivered outcome proportional to total cost over the lifecycle?",
    MB01:"Does the system implement all required functions in the assessed scope?",
    MB02:"Does the system produce the correct output and state for valid inputs and expected conditions?",
    MB03:"Are public and internal contracts respected, versioned, and used as intended?",
    MB04:"Is authoritative state correct, consistent, durable where required, and free from contradictory sources of truth?",
    MB05:"Are ordering, timing, synchronization, races, cancellation, and exactly-once/at-most-once guarantees correct?",
    MB06:"For the same controlled input, is the result repeatable where required, and is intentional variability explainable and bounded?",
    MB07:"Are calculations stable, sufficiently precise, correctly bounded, and resistant to overflow, underflow, drift, and accumulated error?",
    MC01:"Is implementation and cognitive complexity proportional to the responsibility and value delivered?",
    MC02:"Does the unit follow the current architecture, authority model, lifecycle, and common system patterns?",
    MC03:"Do the responsibilities grouped inside a unit belong together and change for related reasons?",
    MC04:"How strongly and in how many ways does the unit depend on or influence other units?",
    MC05:"Can the unit be isolated, disabled, tested, versioned, replaced, or independently evolved through a stable boundary?",
    MC06:"Are boundaries small, explicit, stable, validated, and free of implementation leakage?",
    MC07:"Has too much authority, state, or coordination accumulated in one function, class, file, or module?",
    MC08:"Does active behavior, data, state, infrastructure, or authority unnecessarily duplicate another implementation?",
    MC09:"Is the unit proven unused in the declared evidence envelope?",
    MC10:"Does the unit still fit current architecture, dependencies, platforms, and supported workflows?",
    MC11:"What deliberate or accidental compromise exists, why, at what cost, and under what removal condition?",
    MC12:"Is the architecture becoming more ordered and easier to extend, or accumulating exceptions and unpredictable change propagation?",
    MC13:"Can a competent human or AI reconstruct what the unit does, why it exists, and what will be affected by change?",
    MC14:"Can behavior be isolated, controlled, observed, reproduced, and falsified at reasonable cost?",
    MC15:"Does the unit reveal enough state, timing, errors, degradation, and causal context to diagnose and prove behavior?",
    MD01:"Does the unit perform required work with minimal inherent waste, even when current hardware hides the cost?",
    MD02:"How does a small unit cost multiply through frequency, scale, duration, concurrency, or fan-out?",
    MD03:"Does the unit determine or materially affect completion time of a critical workflow?",
    MD04:"How much useful work is completed per unit time, and how long does a required operation take?",
    MD05:"Are p95/p99/worst-case latency, jitter, stutter, spikes, and resource bursts controlled and predictable?",
    MD06:"Are memory, GPU resources, handles, listeners, workers, timers, buffers, and caches owned, reused, bounded, and released correctly?",
    MD07:"Are reads, writes, requests, serialization, storage, retries, and transfers necessary, batched, cached, and bounded?",
    MD08:"How does cost and quality change as load, users, entities, worlds, modules, data, or time increase?",
    MD09:"When resources decline or load rises, does the system degrade gradually, transparently, and according to policy?",
    MD10:"Is the required outcome achieved with justified energy use and, where relevant, reduced software carbon intensity?",
    ME01:"Does the system perform correctly and remain available over the required operating period?",
    ME02:"How much damage can a small defect, failed dependency, or local change cause?",
    ME03:"Are faults contained within clear boundaries without corrupting unrelated state or workflows?",
    ME04:"Can the system detect failure, preserve truth, recover, resume, and reconstruct state correctly?",
    ME05:"When a preferred capability is unavailable, does the fallback remain explicit, safe, useful, and purpose-consistent?",
    ME06:"Can the change or operation be undone completely, safely, and with verified restoration?",
    ME07:"Does the system identify hazards, prevent unsafe states, warn appropriately, and fail in the safest available mode?",
    MF01:"Does the system preserve confidentiality, integrity, availability, authenticity, and resistance to exploitation?",
    MF02:"Are only necessary data collected, processed, exposed, and retained with appropriate purpose, access, and lifecycle controls?",
    MF03:"Can source, dependencies, builds, artifacts, models, and deployment inputs be traced and protected from tampering?",
    MF04:"Can legitimate features be exploited to cause harm, bypass policy, manipulate evidence, or gain unintended authority?",
    MF05:"Is autonomous authority proportional, bounded, interruptible, reviewable, and subordinate to the Creator's mission?",
    MF06:"Can decisions, commands, changes, evidence, and responsible actors be reconstructed and checked against policy?",
    MG01:"Does the unit coexist and exchange information correctly with required systems, data, protocols, and environments?",
    MG02:"Are supported saves, APIs, data formats, scripts, worlds, clients, and migrations preserved across versions?",
    MG03:"What effort and risk are required to run the system on another compatible OS, browser, GPU, device, or infrastructure profile?",
    MG04:"Can the system adapt quality, capacity, configuration, and behavior to different resources and contexts without architectural fracture?",
    MG05:"Can the system be installed, configured, started, monitored, upgraded, rolled back, and operated reliably?",
    MG06:"Can intended users understand, perceive, operate, and recover from errors in the interface, including users with disabilities?",
    MG07:"Can a component or method be reused in another valid context without hidden assumptions or disproportionate adaptation?",
    MH01:"Can CLU-E and relevant stakeholders explain what the system did, why, on what evidence, with what uncertainty, and what would change the conclusion?",
    MH02:"Does the change improve the overall quality vector without hiding an unacceptable trade-off?",
    MI01:"Is the local, parent, subsystem, and program purpose understood well enough to judge the candidate?",
    MI02:"Does the chosen indicator actually measure the claimed property, with correct units, collection, and interpretation?",
    MI03:"Does the benchmark exercise meaningful, purpose-relevant workloads rather than a convenient but unrepresentative path?",
    MI04:"How much of the declared source, dependency, runtime, scenario, platform, purpose, and capability surface was actually assessed?",
    MI05:"Is the observed change attributable to the patch rather than noise, unrelated changes, caching, environment drift, or measurement interference?",
    MI06:"Does stated confidence match historical accuracy, evidence strength, ambiguity, and residual uncertainty?",
    MI07:"Are source, documents, dependencies, benchmark, graph, environment, and prior conclusions current for this assessment?",
    MI08:"Has the parser, probe, benchmark, fixture, browser bridge, or analyzer proven that it works and does not materially distort what it measures?",
    MI09:"Can the result be repeated in the same environment, and where required reproduced in another compatible environment?",
    MI10:"Would the active tests and measures detect meaningful degradation, interaction effects, and cumulative drift?",
    MI11:"Is the conclusion limited to the evidence envelope, with unknowns, exclusions, and deferred surfaces explicitly preserved?",
    MJ01:"The program and modified unit still serve their declared purpose.",
    MJ02:"All required capabilities are preserved or improved; none is silently removed, narrowed, or materially degraded.",
    MJ03:"The patched benchmark and scenario perform the same required work as the baseline.",
    MJ04:"Required outputs, state, ordering, APIs, persistence, and safety contracts remain valid.",
    MJ05:"The proof contract was frozen, instruments were healthy, preconditions were met, environment and source identities were correct, and the result is statistically or logically decisive under the registered policy.",
    MJ06:"The Central Benchmark and protective measures show no unacceptable system-wide regression. Target-specific gray areas are reported, never converted into improvement.",
    MJ07:"The patch has a verified rollback or restoration path appropriate to its risk and is safe to land under the active custody policy.",
    MK01:"Total analysis, AI, benchmark, and human cost divided by accepted proven improvements.",
    MK02:"Elapsed time from finding creation to accepted, rejected, omitted, deferred, inconclusive, or invalid terminal state.",
    MK03:"Proportion of investigated findings that survive refutation and become confirmed defects or justified improvements.",
    MK04:"Meaningful regressions not detected by the active catalogue and protective suite before landing.",
    MK05:"Previously resolved or rejected hypotheses repeated without new evidence.",
    MK06:"Growth of recognized, purpose-understood, dependency-resolved, runtime-enriched, and test-covered scope.",
    MK07:"Accuracy of P50/P80 estimates for calls, sessions, patches, experiments, and cycle completion.",
    MK08:"Proportion of planned experiments that produce admissible evidence rather than INVALID_TEST or avoidable SKIP.",
    MK09:"Unique defects protected per unit of test execution cost, adjusted for flakiness and overlap.",
    MK10:"Ability to restart, replay, recover, and resume without unique state existing only in a lost session.",
    MK11:"Landing-gate correctness, exact-diff receipt success, post-land verification, and automatic-revert reliability.",
    MK12:"Whether later stronger assessments confirm or expose blind spots in earlier equilibrium certificates.",
    MK13:"Tokens and calls per terminal measure-session result, segmented by role, model, target and outcome quality.",
    MK14:"Improvement in precision, proof quality or risk detection achieved by frontier-model escalation relative to its additional cost.",
    MK15:"Time and error rate required to add, revise, validate, document and activate a measure without duplicated changes across the system.",
    MK16:"Defects, blind spots, duplicate measures, gaming cases and escaped regressions discovered through AI catalogue review, compared with review cost.",
    MK17:"Proportion of logical measure sessions whose task identity, context hash, model-selection rationale, checkpoints, refutation links, token/call telemetry, validated artifacts and terminal outcome are fully reconstructible without a user manually carrying context between GPT sessions.",
    MK18:"Agreement between durable assessment/runtime state and exported clue-status.json, including replay equivalence, unit and capability coverage, freshness, contradiction rate, State Seal validity and separation of historical assessment from current runtime health."
  };
  const FAM = { TARGET_QUALITY:{color:"#00a3e0"}, EVIDENCE_ASSURANCE:{color:"#f4af2d"}, ACCEPTANCE_GATES:{color:"#ff5500"}, CLUE_SELF:{color:"#39ff88"}, RESERVED:{color:"#0b1a28"} };
  // Families are contiguous for cells 1-96 only. The four v6 activations are not — MH03 and
  // MG08 are TARGET_QUALITY, MI12 is EVIDENCE_ASSURANCE, MK19 is CLUE_SELF — so a pure range
  // function cannot express the grid in force and the exceptions are named explicitly.
  // Classification is backend-owned (Q1 §14.3); this mapping exists only so an unfetched
  // grid renders in the right colours, and the parity test keeps it honest.
  const FAMILY_97_100 = { 97: "TARGET_QUALITY", 98: "TARGET_QUALITY", 99: "EVIDENCE_ASSURANCE", 100: "CLUE_SELF" };
  const familyOf = (i) => i<=60?"TARGET_QUALITY":i<=71?"EVIDENCE_ASSURANCE":i<=78?"ACCEPTANCE_GATES":i<=96?"CLUE_SELF":(FAMILY_97_100[i] ?? "RESERVED");
  const MDETAIL={
    MA01:{ev:["Purpose Records, mission documents, user-visible outcomes, contracts, scenarios, Creator declarations"],fp:["metric improvement by narrowing or redefining purpose","local convenience overriding the program mission"],vi:"Failure triggers REJECTED_PURPOSE_VIOLATION",pt:"signed_score",st:"ACTIVE"},
    MA02:{ev:["use frequency, dependent capabilities, user impact, strategic value, recovery role, cost of absence"],fp:["elegant but unused features","legacy functions with no current value","expensive mechanisms with negligible outcome"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MA03:{ev:["Capability Inventory, approved scenarios, public contracts, integration tests, runtime facts"],fp:["higher FPS through disabling a feature","API simplification that removes supported cases","silent capability degradation"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MA04:{ev:["completed-work counters, entity counts, simulation steps, visual outputs, scenario checkpoints, workload hashes"],fp:["rendering fewer objects","reducing simulation frequency","bypassing expensive validation","changing the benchmark workload"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MA05:{ev:["task success, error rates, interaction outcomes, expert evaluation, user-visible latency, accessibility, safety impact"],fp:["internal optimization that worsens user experience or operator burden"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MA06:{ev:["CPU/GPU time, memory, energy, network, storage, AI calls, maintenance effort, operational burden, licensing, test cost"],fp:["moving cost to another layer","reducing runtime cost while greatly increasing maintenance or infrastructure cost"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MB01:{ev:["capability inventory, requirements traceability, scenario coverage, missing-path analysis"],fp:["optimization that silently removes edge cases or partial functionality"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MB02:{ev:["unit, contract, integration, scenario, property-based, and reference tests"],fp:["faster execution with incorrect results","success indicated before the authoritative fact exists"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MB03:{ev:["type contracts, schemas, protocol tests, payload validation, consumer/provider compatibility"],fp:["request treated as fact","payload drift","undocumented breaking change","internal detail leaked as public API"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MB04:{ev:["authority maps, persistence tests, transaction tests, replay, hash comparison, invariants"],fp:["writing a derived copy","lost updates","duplicated authority","stale cache presented as truth"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MB05:{ev:["deterministic schedules, race probes, event ordering, lease tests, queue histories, terminal-outcome checks"],fp:["state advanced on request rather than confirmation","double completion","race-dependent behavior"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MB06:{ev:["seeded replays, distribution comparison, event-sequence hashes, environment declarations"],fp:["load-order dependence","uncontrolled randomness","hardware-dependent divergence without an envelope"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MB07:{ev:["reference calculations, tolerance tests, long-run drift, extreme-value tests, deterministic numeric fixtures"],fp:["faster approximation outside fidelity policy","unstable geometry","precision loss that appears only at scale"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC01:{ev:["state count, branches, exception paths, dependencies, hidden assumptions, change effort, cognitive complexity"],fp:["large framework for a small task","accidental state machine","complexity reduced by hiding behavior rather than simplifying it"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC02:{ev:["architecture claims, pattern conformance, domain rules, source-of-truth boundaries, lifecycle tests"],fp:["a new local standard","foreign-body subsystem","bypass of shared infrastructure"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC03:{ev:["responsibility map, change history, call and data clusters, purpose records"],fp:["unrelated behavior packed into one manager","file serving several independent domains"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC04:{ev:["directed graph, weighted edge types, reverse impact, shared state, dynamic edges, authority crossings"],fp:["hidden temporal coupling","broad fan-in/fan-out","string dispatch","shared mutable state"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC05:{ev:["interface tests, dependency inversion, feature toggles, independent fixtures, replacement experiments"],fp:["logic permanently embedded in the runtime","no seam for testing or replacement"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC06:{ev:["API size, schema precision, error contracts, versioning, adapter boundaries, boundary tests"],fp:["wide interfaces","ambiguous errors","implicit global state","duplicated boundary models"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC07:{ev:["centrality, responsibility count, touched domains, owned state, change frequency, blast radius"],fp:["god objects","universal managers","one module controlling unrelated systems"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC08:{ev:["semantic similarity, parallel code paths, duplicate caches, duplicated schemas, dual authorities"],fp:["two active render paths","repeated normalization","separate local standards"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC09:{ev:["static reachability, registrations, reflection/string search, runtime traces, configuration, public consumers, recovery roles"],fp:["declaring code dead because no direct caller is visible","deleting dormant recovery or feature-gated paths"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC10:{ev:["current patterns, deprecation records, replacement paths, compatibility matrix, usage and maintenance history"],fp:["code retained only because removal is difficult","new code written against an already superseded approach"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC11:{ev:["debt records, owner, age, interest cost, blocked changes, defect association, exit condition"],fp:["TODO without owner","permanent temporary adapter","debt hidden as ordinary architecture"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC12:{ev:["exception count, naming divergence, boundary erosion, graph growth, change amplification, local standards"],fp:["every feature requires another special case","responsibilities become less clear after each patch"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC13:{ev:["purpose confidence, source clarity, graph completeness, documentation, naming, traceability, onboarding effort"],fp:["behavior discoverable only through tribal knowledge","misleading names","purpose inferred from one weak clue"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC14:{ev:["deterministic fixtures, test seams, scenario controls, stable outputs, coverage, test cost and flakiness"],fp:["only end-to-end manual verification","no authoritative observable output","hidden clock or global state"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MC15:{ev:["logs, metrics, traces, health reports, state snapshots, attribution, last-activity and fallback declarations"],fp:["silent fallback","warning without source","black-box subsystem","telemetry removed to make the system look clean"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD01:{ev:["operation counts, allocations, copies, transfers, redundant work, cache hit/miss behavior"],fp:["per-frame allocations","avoidable data copies","repeated parsing","polling while idle"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD02:{ev:["unit cost x invocation rate x object/user count x duration x concurrency"],fp:["tiny cost dismissed although executed millions of times"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD03:{ev:["traces, barriers, synchronous chains, CPU/GPU dependencies, queue waits, scheduler ordering"],fp:["optimizing off-path work while ignoring a blocking stage","local speedup hidden behind a slower barrier"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD04:{ev:["FPS, requests/sec, tasks/sec, input latency, startup/load time, median duration"],fp:["throughput increased by reducing work","average latency hides tail behavior"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD05:{ev:["distributions, long-frame count, worst case, variance, memory spikes, queue depth"],fp:["good average FPS with severe stutter","rare but catastrophic pauses"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD06:{ev:["baseline/peak/retained memory, growth slope, create-use-destroy balance, high-water marks, leak probes"],fp:["resource churn","unreleased listeners","cache without eviction","device-loss recreation gaps"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD07:{ev:["bytes transferred, request counts, retry rates, file reads, serialization cost, cache performance"],fp:["repeated full-file reads","chatty APIs","redundant uploads","unbounded retry loops"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD08:{ev:["load curves, complexity class, saturation points, queue growth, horizontal/vertical scaling"],fp:["demo-scale success with quadratic collapse","hidden global lock"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD09:{ev:["quality profiles, throttling behavior, fallback path, minimum/standard/high/extreme environments"],fp:["sudden cliff","silent quality collapse","hard dependence on one hardware tier"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MD10:{ev:["energy proxy, runtime duration, hardware utilization, SCI-compatible functional-unit measurement, AI token/inference cost"],fp:["faster wall-clock result requiring disproportionate energy","idle GPU work","unnecessary model calls"],vi:"",pt:"signed_score",st:"ACTIVE"},
    ME01:{ev:["failure rate, uptime/SLO, error budget, long-run tests, success ratio, mean time between failures"],fp:["passes short tests but decays over time","intermittent unavailable state"],vi:"",pt:"signed_score",st:"ACTIVE"},
    ME02:{ev:["reverse impact, failure injection, affected units, data loss scope, cascading effects"],fp:["one NPC stops the runtime","one config error blocks unrelated features"],vi:"",pt:"signed_score",st:"ACTIVE"},
    ME03:{ev:["sandboxing, process boundaries, error propagation, circuit breakers, transaction isolation"],fp:["one worker crash poisons shared state","malformed plugin crashes the core"],vi:"",pt:"signed_score",st:"ACTIVE"},
    ME04:{ev:["restart tests, event replay, device-loss recovery, lease expiry, backup restore, recovery time"],fp:["recovery requires hidden memory","restart loses mission state","corrupted projections cannot rebuild"],vi:"",pt:"signed_score",st:"ACTIVE"},
    ME05:{ev:["fallback scenarios, quality delta, user/operator notification, bounded feature loss"],fp:["silent demotion","fallback produces misleading result","failure turns into total shutdown unnecessarily"],vi:"",pt:"signed_score",st:"ACTIVE"},
    ME06:{ev:["reverse patch, rollback test, pre/post hash, transactional boundary, state migration path"],fp:["irreversible migration without threshold","rollback exists only on paper"],vi:"",pt:"signed_score",st:"ACTIVE"},
    ME07:{ev:["hazard analysis, protected surfaces, fail-safe tests, operational limits, safety warnings"],fp:["optimization bypasses a guard","failure defaults to an unsafe action"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MF01:{ev:["threat model, attack-surface analysis, vulnerability tests, authorization tests, secure configuration, incident history"],fp:["new feature expands attack surface without controls","client trusts unvalidated input"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MF02:{ev:["data inventory, retention, access logs, anonymization, local-processing options, deletion tests"],fp:["telemetry retained indefinitely","secrets or personal data enter model context unnecessarily"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MF03:{ev:["lockfiles, SBOM/provenance, signed or hash-bound artifacts, reproducible builds, dependency policy, SLSA-style attestations"],fp:["unpinned dependency","build cannot be traced to source","artifact substituted after verification"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MF04:{ev:["misuse cases, prompt-injection tests, rate limits, content boundaries, adversarial scenarios"],fp:["source comments authorize tool calls","benchmark is gamed","public endpoint enables destructive action"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MF05:{ev:["capability tokens, approval gates, stop controls, mode policy, override tests, authority map"],fp:["agent can broaden its own permissions","no reliable stop","recommendation silently becomes execution"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MF06:{ev:["append-only audit, receipts, hashes, decision provenance, policy version, actor identity"],fp:["no record of who omitted a finding","landing cannot be reconstructed","policy changed mid-experiment"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MG01:{ev:["protocol tests, coexistence tests, schema compatibility, integration matrices"],fp:["valid locally but incompatible with another module or platform"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MG02:{ev:["versioned fixtures, migration tests, old-client/new-server tests, serialization round trips"],fp:["optimization invalidates saves","old content loads silently wrong"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MG03:{ev:["shared-code ratio, platform adapters, compatibility tests, setup effort, environment exceptions"],fp:["core logic bound to one platform","hidden driver assumption"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MG04:{ev:["configuration profiles, feature detection, adaptive quality, fallback behavior, adapter boundaries"],fp:["every new environment adds another special case","quality cannot scale down safely"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MG05:{ev:["clean install, startup, readiness, health, deployment time, rollback, operator runbook, DORA-style delivery indicators where applicable"],fp:["works only on the author's machine","ambiguous readiness","command started but success is unknown"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MG06:{ev:["WCAG-aligned tests where applicable, keyboard access, contrast, reduced motion, error prevention, task success, human evaluation"],fp:["essential state encoded only by color","controls inaccessible without pointer","cinematic effects make the tool unusable"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MG07:{ev:["adapter tests, parameterization, dependency isolation, reuse history, contract clarity"],fp:["copied code because original cannot be reused","generic layer that actually encodes one target"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MH01:{ev:["source-grounded responsibility, decision traces, causal narrative, counter-evidence, confidence, limitations"],fp:["opaque score","unexplained AI verdict","purpose inferred without provenance"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MH02:{ev:["before/after measure vector, mandatory gates, Pareto comparison, Creator trade-off policy, Central Benchmark"],fp:["faster but less correct","simpler but less secure","lower memory but severe tail latency","local gain with global loss"],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI01:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI02:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI03:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI04:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI05:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI06:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI07:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI08:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI09:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI10:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MI11:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MJ01:{ev:[],fp:[],vi:"",pt:"gate_state",st:"ACTIVE"},
    MJ02:{ev:[],fp:[],vi:"",pt:"gate_state",st:"ACTIVE"},
    MJ03:{ev:[],fp:[],vi:"",pt:"gate_state",st:"ACTIVE"},
    MJ04:{ev:[],fp:[],vi:"",pt:"gate_state",st:"ACTIVE"},
    MJ05:{ev:[],fp:[],vi:"",pt:"gate_state",st:"ACTIVE"},
    MJ06:{ev:[],fp:[],vi:"",pt:"gate_state",st:"ACTIVE"},
    MJ07:{ev:[],fp:[],vi:"",pt:"gate_state",st:"ACTIVE"},
    MK01:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK02:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK03:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK04:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK05:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK06:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK07:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK08:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK09:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK10:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK11:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK12:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK13:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK14:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK15:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK16:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK17:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"},
    MK18:{ev:[],fp:[],vi:"",pt:"signed_score",st:"ACTIVE"}
  };
  /* Publish the ONE canonical metric registry (all agreed metrics + full intention) so
   * every surface — Q2, the Book, the Metrics catalogue viewer, and the future import —
   * uses the same set. The import feature replaces window.__clueMetrics per project. */
  try {
    const reg = [];
    M.forEach((r, i) => { if (String(r[0]).startsWith('RESERVED')) return; const gi = i + 1, fam = familyOf(gi), dt = MDETAIL[r[0]] || {};
      reg.push({ id: r[0], legacyId: r[1], name: r[2], family: fam, familyColor: FAM[fam].color, grid: { index: gi, x: ((gi - 1) % 10) + 1, y: Math.floor((gi - 1) / 10) + 1 }, definition: DEF[r[0]] || null, evidenceSources: dt.ev || [], failurePatterns: dt.fp || [], verdictImpact: dt.vi || '', projectionType: dt.pt || 'signed_score', status: dt.st || 'ACTIVE' }); });
    window.__clueMetrics = reg;
    window.__clueMetricsMeta = { source: 'canonical', count: reg.length };
  } catch (e) {}
  const esc = (s) => String(s==null?"":s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const fin = (v) => Number.isFinite(v);
  const finP = (p) => !!p && fin(p.x) && fin(p.y);

  function emptyModel() {
    return M.map((row,idx)=>{
      const gridIndex=idx+1, x=(idx%10)+1, y=Math.floor(idx/10)+1, family=familyOf(gridIndex);
      return {gridIndex,x,y,measurementId:row[0],legacyId:row[1],name:row[2],family,familyColor:FAM[family].color,
        state: family==="RESERVED"?"reserved":"unknown",
        positiveHeight:null,negativeDepth:null,netContribution:null,confidence:null,coverage:null,freshness:null,contributionCount:0,segments:[]};
    });
  }
  function modelFromView(view) {
    const base = emptyModel();
    if(!view || !Array.isArray(view.cells)) return base;
    const byId = new Map(base.map(c=>[c.measurementId,c]));
    for(const vc of view.cells){
      const c = byId.get(vc.measurementId); if(!c) continue;
      c.state = vc.state ?? c.state; c.familyColor = vc.familyColor ?? c.familyColor;
      c.positiveHeight = vc.positiveHeight ?? null; c.negativeDepth = vc.negativeDepth ?? null; c.netContribution = vc.netContribution ?? null;
      c.confidence = vc.confidence ?? null; c.coverage = vc.coverage ?? null; c.freshness = vc.freshness ?? null;
      c.contributionCount = vc.contributionCount ?? (vc.segments ? vc.segments.length : 0);
      c.segments = Array.isArray(vc.segments) ? vc.segments : [];
    }
    return base;
  }
  function injectStyle() {
    if (document.getElementById("gbf-insp-style")) return;
    const st = document.createElement("style"); st.id = "gbf-insp-style";
    st.textContent = `
.gbf-field-host{position:relative;isolation:isolate;overflow:hidden;background:#01050a}
.gbf-field-canvas{position:absolute;inset:0;display:block;width:100%;height:100%;cursor:grab;touch-action:none;outline:none;transform-origin:50% 50%}
.gbf-field-canvas.is-dragging{cursor:grabbing}
.gbf-tip{position:absolute;z-index:14;pointer-events:none;display:none;max-width:min(360px,76vw);padding:8px 11px;font:10.5px/1.48 ui-monospace,Consolas,monospace;color:#e7f8ff;background:linear-gradient(145deg,rgba(8,22,36,.975),rgba(1,7,13,.975));border:1px solid rgba(103,196,237,.42);border-radius:4px;white-space:nowrap;transform:translate(-50%,-128%);box-shadow:0 15px 36px rgba(0,0,0,.64),0 0 22px rgba(0,163,224,.11),inset 0 1px rgba(255,255,255,.05);backdrop-filter:blur(14px) saturate(130%);clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px)}
.gbf-tip .mi{color:#ffd166;font-weight:800}.gbf-tip .fam{font-size:8px;letter-spacing:.08em;text-transform:uppercase}.gbf-tip .muted{color:#69879c}.gbf-tip .up{color:#39ff88}.gbf-tip .dn{color:#ff7a3d}
.gbf-insp{--gbf-accent:#f4af2d;position:absolute;top:10px;right:10px;bottom:10px;width:clamp(300px,34%,420px);z-index:16;box-sizing:border-box;padding:16px 15px 15px;overflow-y:auto;overflow-x:hidden;color:#d8edfa;font:11px/1.52 ui-monospace,Consolas,monospace;background:linear-gradient(145deg,rgba(8,24,39,.975),rgba(2,9,16,.965));border:1px solid color-mix(in srgb,var(--gbf-accent) 42%,rgba(111,202,241,.26));clip-path:polygon(17px 0,100% 0,100% calc(100% - 17px),calc(100% - 17px) 100%,0 100%,0 17px);box-shadow:0 28px 72px rgba(0,0,0,.66),0 0 38px color-mix(in srgb,var(--gbf-accent) 10%,transparent),inset 0 1px rgba(255,255,255,.065),inset 0 0 42px color-mix(in srgb,var(--gbf-accent) 3%,transparent);backdrop-filter:blur(18px) saturate(134%);visibility:hidden;opacity:0;pointer-events:none;transform:translate3d(34px,0,0) scale(.962);transform-origin:100% 50%;filter:blur(8px) saturate(.72);transition:opacity .34s cubic-bezier(.22,1,.36,1),transform .58s cubic-bezier(.22,1,.36,1),filter .46s cubic-bezier(.22,1,.36,1),visibility 0s linear .58s;will-change:transform,opacity;backface-visibility:hidden;contain:layout paint}
.gbf-insp.is-open{visibility:visible;opacity:1;pointer-events:auto;transform:translate3d(0,0,0) scale(1);filter:none;transition-delay:0s}
.gbf-insp::before{content:"";position:sticky;display:block;z-index:4;top:-16px;height:2px;margin:-2px -15px 13px;background:linear-gradient(90deg,var(--gbf-accent),color-mix(in srgb,var(--gbf-accent) 32%,#8eeeff),transparent 78%);box-shadow:0 0 14px color-mix(in srgb,var(--gbf-accent) 54%,transparent)}
.gbf-insp::after{content:"";position:absolute;z-index:5;left:-35%;top:0;width:30%;height:100%;pointer-events:none;opacity:0;background:linear-gradient(90deg,transparent,rgba(224,250,255,.08),transparent);transform:skewX(-14deg)}
.gbf-insp.is-open::after{animation:gbf-insp-scan .82s .08s cubic-bezier(.22,1,.36,1)}
@keyframes gbf-insp-scan{0%{left:-38%;opacity:0}24%{opacity:1}100%{left:118%;opacity:0}}
.gbf-insp.is-switching{animation:gbf-insp-switch .34s cubic-bezier(.22,1,.36,1)}
@keyframes gbf-insp-switch{0%{transform:translate3d(9px,0,0) scale(.992);filter:saturate(.86)}58%{transform:translate3d(-2px,0,0) scale(1.002);filter:saturate(1.08)}100%{transform:translate3d(0,0,0) scale(1);filter:none}}
.gbf-insp::-webkit-scrollbar{width:7px}.gbf-insp::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--gbf-accent) 32%,rgba(94,181,225,.30));border-radius:8px}
.gbf-insp .ih{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.gbf-insp .id{font-size:20px;color:color-mix(in srgb,var(--gbf-accent) 74%,#fff);letter-spacing:.035em;text-shadow:0 0 16px color-mix(in srgb,var(--gbf-accent) 36%,transparent)}
.gbf-insp .x{cursor:pointer;color:#7d9bb0;border:1px solid rgba(106,190,231,.24);border-radius:3px;padding:0 8px;font-size:12px;line-height:21px;background:rgba(2,9,16,.55);clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)}.gbf-insp .x:hover{color:#ff9aa5;border-color:rgba(255,77,94,.55);box-shadow:0 0 14px rgba(255,77,94,.12)}
.gbf-insp .co{color:#607f96;font-size:8.5px;margin:-2px 0 7px;letter-spacing:.07em}.gbf-insp .nm{color:#eff9ff;margin:0 0 11px;font-size:12.8px;font-weight:680}
.gbf-insp .def{font-size:10.5px;color:#a8c3d6;line-height:1.58;margin:0 0 12px;padding:10px 11px;background:linear-gradient(90deg,color-mix(in srgb,var(--gbf-accent) 6%,rgba(0,20,34,.40)),rgba(0,20,34,.30));border:1px solid rgba(99,181,220,.12);border-left:2px solid var(--gbf-accent);clip-path:polygon(0 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%)}
.gbf-insp .def .dl{display:block;font-size:8px;letter-spacing:.13em;color:#6e8ca2;margin-bottom:4px}.gbf-insp .bg{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:11px}.gbf-insp .b{font-size:8px;letter-spacing:.07em;text-transform:uppercase;border:1px solid;border-radius:2px;padding:3px 7px;background:rgba(2,8,14,.42)}
.gbf-insp .g2{display:grid;grid-template-columns:1fr 1fr;gap:8px 11px;margin-bottom:11px}.gbf-insp .g2 .k{color:#627f94;font-size:8px;letter-spacing:.065em;text-transform:uppercase}.gbf-insp .g2 .v{font-variant-numeric:tabular-nums;color:#dbeef9;margin-top:1px}
.gbf-insp .st{font-size:8px;letter-spacing:.12em;color:#6c899e;border-top:1px solid rgba(102,181,220,.16);padding-top:9px;margin-bottom:8px}.gbf-insp .seg{border:1px solid rgba(101,183,222,.15);border-left-width:3px;border-radius:2px;padding:8px 9px;margin-bottom:7px;background:linear-gradient(135deg,rgba(5,20,32,.64),rgba(2,10,17,.48));clip-path:polygon(0 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%)}
.gbf-insp .nat{color:#c7efff;font-variant-numeric:tabular-nums}.gbf-insp .nat .ar{color:#607d92;margin:0 4px}.gbf-insp .l2{color:#658198;font-size:8.8px;margin-top:4px}.gbf-insp .vd{font-size:9.3px;margin-top:4px}.gbf-insp .ids{color:#4e6b80;font-size:8.2px;margin-top:4px;word-break:break-all}.gbf-insp .note{color:#718ea3;font-size:10.3px;line-height:1.55}.gbf-insp .up{color:#55f09b}.gbf-insp .dn{color:#ff8750}
.gbf-hud{position:absolute;left:10px;top:10px;z-index:11;min-width:172px;max-width:240px;padding:10px 11px;border:1px solid rgba(98,187,229,.22);border-radius:4px;background:linear-gradient(145deg,rgba(8,22,36,.88),rgba(2,9,16,.84));clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);box-shadow:0 14px 36px rgba(0,0,0,.38),inset 0 1px rgba(255,255,255,.04);backdrop-filter:blur(12px) saturate(125%);pointer-events:none}
.gbf-hud .ht{display:flex;align-items:center;gap:7px;color:#e4f6ff;font:800 9px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.12em}.gbf-hud .orb{width:8px;height:8px;border-radius:50%;background:#f4af2d;box-shadow:0 0 13px rgba(244,175,45,.9),0 0 0 3px rgba(244,175,45,.10)}
.gbf-hud.is-surge{border-color:rgba(126,230,255,.46);box-shadow:0 14px 36px rgba(0,0,0,.38),0 0 30px rgba(0,163,224,.16),inset 0 1px rgba(255,255,255,.06)}
.gbf-hud.is-surge .orb{background:#e9fdff;box-shadow:0 0 16px rgba(233,253,255,1),0 0 30px rgba(0,163,224,.86),0 0 0 4px rgba(0,163,224,.14);animation:gbf-power-beat .46s ease-in-out infinite alternate}
.gbf-hud.is-surge .ht::after{content:"POWER WAVE";margin-left:auto;color:#8feaff;font-size:7px;letter-spacing:.10em;text-shadow:0 0 10px rgba(0,163,224,.8)}
@keyframes gbf-power-beat{from{transform:scale(.78);opacity:.62}to{transform:scale(1.28);opacity:1}}
.gbf-hud .hs{margin-top:6px;display:grid;grid-template-columns:1fr auto;gap:4px 12px;color:#6d8ba0;font:500 8.5px/1.35 ui-monospace,Consolas,monospace;letter-spacing:.035em}.gbf-hud .hs b{color:#ccecff;font-weight:700;font-variant-numeric:tabular-nums}.gbf-hud .hs b.hot{color:#ffd166}.gbf-hud .hs b.up{color:#39ff88}.gbf-hud .hs b.dn{color:#ff7a3d}
.gbf-legend{position:absolute;left:10px;bottom:10px;z-index:11;display:flex;flex-direction:column;gap:5px;padding:9px 10px;background:linear-gradient(145deg,rgba(8,22,36,.90),rgba(2,9,16,.86));border:1px solid rgba(102,187,229,.22);border-radius:4px;clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);font:9.5px/1.35 ui-monospace,Consolas,monospace;color:#cfe8ff;box-shadow:0 13px 34px rgba(0,0,0,.35);backdrop-filter:blur(12px);pointer-events:none}
.gbf-legend .lt{font-size:7.8px;letter-spacing:.13em;color:#648198;margin-bottom:1px}.gbf-legend .lr{display:grid;grid-template-columns:10px minmax(96px,1fr) auto;gap:7px;align-items:center}.gbf-legend .sw{width:9px;height:9px;border-radius:2px;box-shadow:0 0 9px currentColor}.gbf-legend .ln{color:#bcd7e8}.gbf-legend .lv{font-variant-numeric:tabular-nums;color:#9fe9ff}
.gbf-controls{position:absolute;left:50%;bottom:10px;z-index:13;display:flex;gap:6px;transform:translateX(-50%);padding:5px;border:1px solid rgba(96,181,223,.17);border-radius:4px;background:rgba(1,8,14,.66);clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px);box-shadow:0 12px 30px rgba(0,0,0,.38);backdrop-filter:blur(12px)}
.gbf-ctrl{height:25px;padding:0 9px;border:1px solid rgba(104,190,230,.22);border-radius:2px;background:linear-gradient(180deg,rgba(11,29,45,.82),rgba(2,9,16,.88));color:#7fa6bd;font:700 8px/1 ui-monospace,Consolas,monospace;letter-spacing:.08em;cursor:pointer;transition:.16s ease}.gbf-ctrl:hover{color:#e8f9ff;border-color:rgba(0,163,224,.58);box-shadow:0 0 16px rgba(0,163,224,.13)}.gbf-ctrl.is-on{color:#ffe2a0;border-color:rgba(244,175,45,.45);background:rgba(45,28,5,.64);box-shadow:0 0 15px rgba(244,175,45,.10)}.gbf-ctrl:focus-visible{outline:2px solid #dff8ff;outline-offset:2px}
.gbf-field-host[data-gbf-mode="grid"] .gbf-auto-toggle{display:none}
.gbf-hint{display:none!important}
.gbf-view-switch{display:flex;align-items:center;gap:2px;height:27px;padding:2px;border:1px solid rgba(112,197,235,.22);border-radius:4px;background:linear-gradient(180deg,rgba(10,28,44,.88),rgba(2,9,16,.90));box-shadow:inset 0 1px rgba(255,255,255,.045);clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)}
.gbf-view-btn{display:flex;align-items:center;gap:5px;height:21px;padding:0 7px;border:0;border-radius:2px;background:transparent;color:#66879c;font:750 7.8px/1 ui-monospace,Consolas,monospace;letter-spacing:.08em;cursor:pointer;transition:color .18s ease,background .18s ease,box-shadow .18s ease}.gbf-view-btn svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.5}.gbf-view-btn:hover{color:#dff8ff;background:rgba(0,163,224,.08)}.gbf-view-btn.is-active{color:#ffe1a0;background:rgba(244,175,45,.12);box-shadow:inset 0 0 0 1px rgba(244,175,45,.28),0 0 13px rgba(244,175,45,.08)}.gbf-view-btn:focus-visible{outline:2px solid #dff8ff;outline-offset:2px}
.gbf-mode-flash{position:absolute;inset:0;z-index:15;pointer-events:none;opacity:0;background:radial-gradient(circle at 50% 50%,rgba(151,235,255,.13),transparent 46%),linear-gradient(100deg,transparent 0 42%,rgba(230,252,255,.12) 49%,transparent 56% 100%)}
.gbf-mode-flash.is-active{animation:gbf-mode-flash .58s cubic-bezier(.22,1,.36,1)}
@keyframes gbf-mode-flash{0%{opacity:0;transform:translateX(-12%)}30%{opacity:1}100%{opacity:0;transform:translateX(12%)}}
#q2:fullscreen .gbf-insp,#q2.clue-soft-fullscreen .gbf-insp{width:clamp(360px,27%,490px);top:16px;right:16px;bottom:16px;padding:18px 17px}
#q2:fullscreen .gbf-hud,#q2.clue-soft-fullscreen .gbf-hud{left:16px;top:16px;padding:12px 13px;min-width:205px}
#q2:fullscreen .gbf-legend,#q2.clue-soft-fullscreen .gbf-legend{left:16px;bottom:16px;padding:11px 13px}
#q2:fullscreen .gbf-controls,#q2.clue-soft-fullscreen .gbf-controls{bottom:16px}
@media(max-width:760px){.gbf-insp{width:calc(100% - 20px);left:10px;right:10px;top:46px}.gbf-hint{display:none}.gbf-hud{min-width:145px;max-width:185px}.gbf-hud .hs{grid-template-columns:1fr auto}.gbf-legend{max-width:170px}.gbf-legend .ln{display:none}.gbf-controls{right:10px;left:auto;transform:none}.gbf-ctrl span{display:none}.gbf-view-btn span{display:none}.gbf-view-btn{padding:0 6px}}
@media(prefers-reduced-motion:reduce){.gbf-ctrl,.gbf-view-btn,.gbf-insp{transition:none!important}.gbf-insp.is-open::after,.gbf-mode-flash.is-active{animation:none!important}}
`;
    document.head.appendChild(st);
  }

  function mountField(container) {
    const reduceMotion = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) || false;
    const now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const canvas = document.createElement("canvas");
    canvas.className = "gbf-field-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "Great Book improvement field with switchable grid and sphere projections. Drag to orbit, Shift-drag to pan, scroll to zoom, click a metric to inspect it, press V to switch projection, and zero to reset the active view.");
    container.classList.add("gbf-field-host");
    container.appendChild(canvas);

    const tip = document.createElement("div"); tip.className = "gbf-tip"; container.appendChild(tip);
    const insp = document.createElement("div"); insp.className = "gbf-insp"; insp.setAttribute("aria-hidden", "true"); container.appendChild(insp);
    const hud = document.createElement("div"); hud.className = "gbf-hud"; container.appendChild(hud);
    const legend = document.createElement("div"); legend.className = "gbf-legend"; container.appendChild(legend);
    const controls = document.createElement("div"); controls.className = "gbf-controls";
    const autoButton = document.createElement("button"); autoButton.type = "button"; autoButton.className = "gbf-ctrl gbf-auto-toggle"; autoButton.title = "Toggle slow automatic sphere rotation (Space)";
    const resetButton = document.createElement("button"); resetButton.type = "button"; resetButton.className = "gbf-ctrl"; resetButton.title = "Reset sphere view (0 or Home)"; resetButton.innerHTML = "RESET";
    controls.append(autoButton, resetButton); container.appendChild(controls);
    const hint = document.createElement("div"); hint.className = "gbf-hint"; container.appendChild(hint);
    const modeFlash = document.createElement("div"); modeFlash.className = "gbf-mode-flash"; container.appendChild(modeFlash);

    const panelTools = document.querySelector("#q2 .clue-panel-tools");
    document.getElementById("gbf-view-switch")?.remove();
    const modeSwitch = document.createElement("div"); modeSwitch.id = "gbf-view-switch"; modeSwitch.className = "gbf-view-switch"; modeSwitch.setAttribute("role", "group"); modeSwitch.setAttribute("aria-label", "Q2 projection");
    const gridModeButton = document.createElement("button"); gridModeButton.type = "button"; gridModeButton.className = "gbf-view-btn"; gridModeButton.dataset.mode = "grid"; gridModeButton.title = "Show the 10×10 analytical grid"; gridModeButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11"/></svg><span>GRID</span>';
    const sphereModeButton = document.createElement("button"); sphereModeButton.type = "button"; sphereModeButton.className = "gbf-view-btn"; sphereModeButton.dataset.mode = "sphere"; sphereModeButton.title = "Show the rotating spherical projection"; sphereModeButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2.1 2 8.9 0 11M8 2.5c-2 2.1-2 8.9 0 11"/></svg><span>SPHERE</span>';
    modeSwitch.append(gridModeButton, sphereModeButton);
    if (panelTools) panelTools.insertBefore(modeSwitch, panelTools.firstChild); else { modeSwitch.style.position = "absolute"; modeSwitch.style.right = "10px"; modeSwitch.style.top = "10px"; modeSwitch.style.zIndex = "18"; container.appendChild(modeSwitch); }

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Q2 Canvas 2D context unavailable");

    let DPR = Math.min(window.devicePixelRatio || 1, 2);
    const TAU = Math.PI * 2;
    const LAT_MAX = Math.PI * 0.46;
    const DEF_YAW = -0.48;
    const DEF_PITCH = -0.14;
    const GRID_DEF_YAW = Math.PI / 4;
    const GRID_DEF_PITCH = 0.50;
    const GRID_CELL = 45.25;
    const GRID_CENTER = 4.5;
    const GRID_MAX_BAR = 132;
    const GRID_MAX_PIT = 80;
    const AUTO_SPEED = 0.000055;
    const CAMERA_DISTANCE = 4.35;
    const TSUNAMI_TRAVEL_MS = 5200;
    const TSUNAMI_LOCAL_MIN_MS = 980;
    const TSUNAMI_LOCAL_MAX_MS = 1580;
    const TSUNAMI_FIRST_MIN_MS = 12000;
    const TSUNAMI_FIRST_MAX_MS = 20000;
    const TSUNAMI_GAP_MIN_MS = 42000;
    const TSUNAMI_GAP_MAX_MS = 72000;
    const view = { yaw: DEF_YAW, pitch: DEF_PITCH, userZoom: 1, panX: 0, panY: 0, autoRotate: !reduceMotion };
    const gridView = { yaw: GRID_DEF_YAW, pitch: GRID_DEF_PITCH, fitZoom: 1, userZoom: 1, panX: 0, panY: 0 };
    const layout = { cx: 0, cy: 0, radius: 1, cssWidth: 1, cssHeight: 1 };
    const gridLayout = { cx: 0, cy: 0, usableWidth: 1 };
    let viewMode = "sphere";
    try { const savedMode = window.localStorage?.getItem("clue.q2.projection"); if (savedMode === "grid" || savedMode === "sphere") viewMode = savedMode; } catch (e) {}
    container.dataset.gbfMode = viewMode;
    let MODEL = emptyModel();
    let aggMode = "";
    let EXCLUDED = new Set();
    try { EXCLUDED = new Set(JSON.parse((window.localStorage && window.localStorage.getItem("clue.excluded")) || "[]")); } catch (e) {}
    const applyExcluded = () => { for (const c of MODEL) c.excluded = EXCLUDED.has(c.measurementId); };
    let hoverCell = null;
    let selectedCell = null;
    let inspectorMetricId = null;
    let inspectorSignature = "";
    let inspectorSwitchTimer = null;
    let inspectorOpenRaf = null;
    let pickList = [];
    let rafId = null;
    let dragging = null;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;
    let activePointerId = null;
    let lastFrameAt = now();
    let lastInteractionAt = now();
    let resizeObserver = null;
    let selectionStartedAt = 0;
    let selectedAnchor = null;
    let labelList = [];
    let tsunamiSequence = 0;
    let tsunami = null;
    let nextTsunamiAt = Infinity;

    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const num = (v, plus) => v == null ? "—" : (plus && v >= 0 ? "+" : "") + v;
    const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
    const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const hex2rgb = (h) => { const n = parseInt(String(h || "#00a3e0").slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
    const rgba = (h, a) => { const [r, g, b] = hex2rgb(h); return `rgba(${r},${g},${b},${a})`; };
    const shade = (h, f) => { let [r, g, b] = hex2rgb(h); if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; } return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("")}`; };
    const hash01 = (n) => { const x = Math.sin(n * 91.733 + 17.17) * 43758.5453123; return x - Math.floor(x); };
    const stars = Array.from({ length: 190 }, (_, i) => ({ x: hash01(i * 3.1), y: hash01(i * 5.7 + 2), r: 0.35 + hash01(i * 7.9 + 4) * 1.2, a: 0.08 + hash01(i * 11.3 + 9) * 0.42, p: hash01(i * 13.7 + 11) * TAU }));
    const modulo = (value, base) => ((value % base) + base) % base;
    const wrapAngle = (angle) => modulo(angle + Math.PI, TAU) - Math.PI;
    function gridWaveCoordinate(cell, angle) {
      const nx = (cell.x - 5.5) / 5;
      const ny = (cell.y - 5.5) / 5;
      const dot = nx * Math.cos(angle) + ny * Math.sin(angle);
      return clamp((dot + Math.SQRT2) / (Math.SQRT2 * 2), 0, 1);
    }

    function scheduleNextTsunami(t, initial = false) {
      if (reduceMotion) { nextTsunamiAt = Infinity; return; }
      const minimum = initial ? TSUNAMI_FIRST_MIN_MS : TSUNAMI_GAP_MIN_MS;
      const maximum = initial ? TSUNAMI_FIRST_MAX_MS : TSUNAMI_GAP_MAX_MS;
      const jitter = hash01((tsunamiSequence + 1) * 37.71 + (initial ? 3.17 : 19.43));
      nextTsunamiAt = t + minimum + (maximum - minimum) * jitter;
    }

    function beginTsunami(t = now()) {
      if (reduceMotion || tsunami) return false;
      const eligible = MODEL.filter((cell) => cell.state !== "reserved" && !cell.excluded);
      if (!eligible.length) { scheduleNextTsunami(t, false); return false; }
      const sequence = ++tsunamiSequence;
      const seed = sequence * 113.71;
      const originLon = -Math.PI + hash01(seed * 0.71) * TAU;
      const direction = hash01(seed * 1.37) < 0.5 ? -1 : 1;
      const gridAngle = hash01(seed * 1.91) * TAU;
      const gridDirection = hash01(seed * 2.03) < 0.5 ? -1 : 1;
      const desiredCount = Math.min(eligible.length, 22 + Math.floor(hash01(seed * 2.11) * 13));
      const chosen = eligible
        .map((cell) => ({ cell, rank: hash01(seed + cell.gridIndex * 17.91) }))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, desiredCount);
      const effects = new Map();
      let positiveCount = 0;
      let negativeCount = 0;
      for (const item of chosen) {
        const cell = item.cell;
        const bounds = cellAngularBounds(cell);
        const travelAngle = modulo(direction * (bounds.lonCenter - originLon), TAU);
        const gridCoordinate = gridWaveCoordinate(cell, gridAngle);
        const gridTravel = gridDirection > 0 ? gridCoordinate : 1 - gridCoordinate;
        let sign = hash01(seed * 3.19 + cell.gridIndex * 29.17) < 0.37 ? -1 : 1;
        if (sign > 0) positiveCount += 1; else negativeCount += 1;
        const baseAmplitude = 0.065 + hash01(seed * 5.23 + cell.gridIndex * 11.83) * 0.125;
        effects.set(cell.measurementId, {
          sign,
          amplitude: sign > 0 ? baseAmplitude : baseAmplitude * 0.72,
          arrivalSphere: travelAngle / TAU * TSUNAMI_TRAVEL_MS,
          arrivalGrid: gridTravel * TSUNAMI_TRAVEL_MS,
          duration: TSUNAMI_LOCAL_MIN_MS + hash01(seed * 7.13 + cell.gridIndex * 13.51) * (TSUNAMI_LOCAL_MAX_MS - TSUNAMI_LOCAL_MIN_MS),
          phase: hash01(seed * 9.29 + cell.gridIndex * 31.07) * TAU,
        });
      }
      if (!negativeCount && chosen.length) {
        const effect = effects.get(chosen[0].cell.measurementId); effect.sign = -1; effect.amplitude *= 0.72;
      }
      if (!positiveCount && chosen.length > 1) {
        const effect = effects.get(chosen[chosen.length - 1].cell.measurementId); effect.sign = 1; effect.amplitude /= 0.72;
      }
      const frontCandidates = viewMode === "sphere" ? chosen.filter(({ cell }) => {
        const bounds = cellAngularBounds(cell);
        return rotatePoint(spherePoint(bounds.latCenter, bounds.lonCenter, 1)).z > 0.08;
      }) : chosen;
      const heroPool = frontCandidates.length ? frontCandidates : chosen;
      const hero = heroPool.slice().sort((a, b) => hash01(seed * 17.7 + b.cell.gridIndex * 5.9) - hash01(seed * 17.7 + a.cell.gridIndex * 5.9))[0];
      tsunami = {
        sequence,
        start: t,
        originLon,
        direction,
        gridAngle,
        gridDirection,
        effects,
        heroId: hero ? hero.cell.measurementId : null,
        duration: TSUNAMI_TRAVEL_MS + TSUNAMI_LOCAL_MAX_MS + 520,
      };
      hud.classList.add("is-surge");
      return true;
    }

    function updateTsunami(t) {
      if (reduceMotion) return;
      if (tsunami && t - tsunami.start >= tsunami.duration) {
        tsunami = null;
        hud.classList.remove("is-surge");
        scheduleNextTsunami(t, false);
      }
      if (!tsunami && t >= nextTsunamiAt) {
        if (dragging || (typeof document !== "undefined" && document.hidden)) nextTsunamiAt = t + 2600;
        else beginTsunami(t);
      }
    }

    function tsunamiEnvelope(t) {
      if (!tsunami) return 0;
      const p = clamp((t - tsunami.start) / tsunami.duration, 0, 1);
      const enter = clamp(p / 0.10, 0, 1);
      const leave = clamp((1 - p) / 0.18, 0, 1);
      return Math.sin(Math.PI * Math.min(enter, leave) * 0.5);
    }

    function tsunamiVisual(cell, t) {
      const idle = { offset: 0, intensity: 0, wave: 0, hero: false, blink: 0 };
      if (!tsunami || cell.state === "reserved" || cell.excluded) return idle;
      const elapsed = t - tsunami.start;
      const travel = clamp(elapsed / TSUNAMI_TRAVEL_MS, 0, 1);
      let distance;
      if (viewMode === "grid") {
        const coordinate = gridWaveCoordinate(cell, tsunami.gridAngle);
        const waveCoordinate = tsunami.gridDirection > 0 ? travel : 1 - travel;
        distance = Math.abs(coordinate - waveCoordinate);
      } else {
        const bounds = cellAngularBounds(cell);
        const waveLon = tsunami.originLon + tsunami.direction * travel * TAU;
        distance = Math.abs(wrapAngle(bounds.lonCenter - waveLon)) / TAU;
      }
      const waveWidth = viewMode === "grid" ? 0.082 : 0.31 / TAU;
      const wave = elapsed <= TSUNAMI_TRAVEL_MS + 260 ? Math.exp(-Math.pow(distance / waveWidth, 2)) * tsunamiEnvelope(t) : 0;
      const effect = tsunami.effects.get(cell.measurementId);
      if (!effect) return { ...idle, wave };
      const arrival = viewMode === "grid" ? effect.arrivalGrid : effect.arrivalSphere;
      const local = (elapsed - arrival) / effect.duration;
      if (local < 0 || local > 1) return { ...idle, wave };
      const pulse = Math.pow(Math.max(0, Math.sin(Math.PI * local)), 1.42);
      const oscillation = 0.92 + Math.sin(local * TAU * 2.3 + effect.phase) * 0.08;
      const intensity = pulse * oscillation;
      const hero = cell.measurementId === tsunami.heroId;
      const blink = hero ? intensity * (0.58 + 0.42 * (0.5 + 0.5 * Math.sin(local * TAU * 7.0))) : 0;
      return { offset: effect.sign * effect.amplitude * intensity, intensity, wave, hero, blink };
    }

    function updateControlUi() {
      autoButton.classList.toggle("is-on", view.autoRotate);
      autoButton.innerHTML = `${view.autoRotate ? "AUTO ON" : "AUTO OFF"}`;
      autoButton.setAttribute("aria-pressed", String(view.autoRotate));
      autoButton.disabled = viewMode !== "sphere";
      resetButton.title = viewMode === "sphere" ? "Reset sphere view (0 or Home)" : "Reset grid view (0 or Home)";
      gridModeButton.classList.toggle("is-active", viewMode === "grid");
      sphereModeButton.classList.toggle("is-active", viewMode === "sphere");
      gridModeButton.setAttribute("aria-pressed", String(viewMode === "grid"));
      sphereModeButton.setAttribute("aria-pressed", String(viewMode === "sphere"));
      hint.textContent = '';
    }

    function animateModeTransition() {
      modeFlash.classList.remove("is-active");
      void modeFlash.offsetWidth;
      modeFlash.classList.add("is-active");
      if (!reduceMotion && typeof canvas.animate === "function") {
        canvas.animate([
          { opacity: 0.38, transform: "scale(.985)", filter: "blur(9px) saturate(.7)" },
          { opacity: 1, transform: "scale(1)", filter: "blur(0) saturate(1)" },
        ], { duration: 560, easing: "cubic-bezier(.22,1,.36,1)" });
      }
    }

    function setViewMode(nextMode, animate = true) {
      const normalized = nextMode === "grid" ? "grid" : "sphere";
      if (normalized === viewMode) { updateControlUi(); return viewMode; }
      viewMode = normalized;
      container.dataset.gbfMode = viewMode;
      hoverCell = null;
      tip.style.display = "none";
      lastInteractionAt = now();
      try { window.localStorage?.setItem("clue.q2.projection", viewMode); } catch (e) {}
      updateControlUi();
      renderLegend();
      renderHud();
      if (selectedCell) renderInspector(selectedCell, true);
      updateLayout();
      if (animate) animateModeTransition();
      try { container.dispatchEvent(new CustomEvent("gbf-view-mode-change", { detail: viewMode })); } catch (e) {}
      if (reduceMotion) draw(now());
      return viewMode;
    }

    function spherePoint(lat, lon, radius = 1) {
      const cl = Math.cos(lat);
      return { x: cl * Math.sin(lon) * radius, y: Math.sin(lat) * radius, z: cl * Math.cos(lon) * radius };
    }

    function rotatePoint(p) {
      const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
      const x1 = p.x * cy + p.z * sy;
      const z1 = -p.x * sy + p.z * cy;
      const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
      return { x: x1, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
    }

    function projectPoint(p) {
      const r = rotatePoint(p);
      const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - r.z);
      return { x: layout.cx + r.x * layout.radius * perspective, y: layout.cy - r.y * layout.radius * perspective, depth: r.z, scale: perspective };
    }

    function updateSphereLayout() {
      const selectedReserve = selectedCell && insp.classList.contains("is-open") && layout.cssWidth > 850 ? Math.min(layout.cssWidth * 0.30, 490) : 0;
      const usableWidth = Math.max(250, layout.cssWidth - selectedReserve);
      const baseRadius = Math.max(70, Math.min(usableWidth * 0.335, layout.cssHeight * 0.355));
      layout.cx = (usableWidth * 0.51 + view.panX) * DPR;
      layout.cy = (layout.cssHeight * 0.49 + view.panY) * DPR;
      layout.radius = baseRadius * view.userZoom * DPR;
    }

    function gridZoom() { return gridView.fitZoom * gridView.userZoom * DPR; }
    function gridProject(gx, gy, elevation) {
      const cx = gx - GRID_CENTER, cy = gy - GRID_CENTER;
      const cs = Math.cos(gridView.yaw), sn = Math.sin(gridView.yaw);
      const xr = cx * cs - cy * sn, yr = cx * sn + cy * cs;
      const zoom = gridZoom();
      return { x: gridLayout.cx + xr * GRID_CELL * zoom, y: gridLayout.cy + yr * GRID_CELL * gridView.pitch * zoom - elevation * zoom, depth: yr, scale: zoom };
    }

    function updateGridLayout() {
      const selectedReserve = selectedCell && insp.classList.contains("is-open") && layout.cssWidth > 850 ? Math.min(layout.cssWidth * 0.30, 490) : 0;
      const usableWidthCss = Math.max(250, layout.cssWidth - selectedReserve);
      const radius = Math.SQRT2 * GRID_CENTER;
      const groundW = 2 * radius * GRID_CELL;
      const groundH = 2 * radius * GRID_CELL * gridView.pitch;
      const zx = (usableWidthCss * 0.84) / groundW;
      const zy = (layout.cssHeight * 0.72) / (groundH + GRID_MAX_BAR);
      gridView.fitZoom = Math.max(0.22, Math.min(zx, zy));
      gridLayout.usableWidth = usableWidthCss * DPR;
      gridLayout.cx = (usableWidthCss * 0.50 + gridView.panX) * DPR;
      gridLayout.cy = (layout.cssHeight * 0.56 + gridView.panY) * DPR;
    }

    function updateLayout() {
      if (viewMode === "grid") updateGridLayout(); else updateSphereLayout();
    }

    function resize() {
      if (!container.isConnected) return;
      const rect = container.getBoundingClientRect();
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      layout.cssWidth = Math.max(200, rect.width);
      layout.cssHeight = Math.max(160, rect.height);
      canvas.width = Math.max(200, Math.floor(layout.cssWidth * DPR));
      canvas.height = Math.max(160, Math.floor(layout.cssHeight * DPR));
      updateLayout();
      if (reduceMotion) draw(now());
    }

    function polygon(points, fill, stroke, lineWidth = 1, close = true) {
      if (!points || !points.length || !points.every(finP)) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
      if (close) ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth * DPR; ctx.stroke(); }
    }

    function roundedRect(x, y, w, h, radius) {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
      else {
        const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2);
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
      }
    }

    function drawLine(a, b, color, width = 1, dash = null) {
      if (!finP(a) || !finP(b)) return;
      ctx.save();
      if (dash) ctx.setLineDash(dash.map((v) => v * DPR));
      ctx.strokeStyle = color;
      ctx.lineWidth = width * DPR;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }

    function pointSize(cell, projected) {
      const base = clamp(layout.radius / (245 * DPR), 0.72, 1.5);
      return clamp(2.2 * base * projected.scale, 1.6, 4.6) * DPR;
    }

    function cellAngularBounds(c) {
      const latStep = (LAT_MAX * 2) / 10;
      const lonStep = TAU / 10;
      const latNorth = LAT_MAX - (c.y - 1) * latStep;
      const latSouth = LAT_MAX - c.y * latStep;
      const lonWest = -Math.PI + (c.x - 1) * lonStep;
      const lonEast = -Math.PI + c.x * lonStep;
      const latPad = latStep * 0.10;
      const lonPad = lonStep * 0.08;
      return { latNorth: latNorth - latPad, latSouth: latSouth + latPad, lonWest: lonWest + lonPad, lonEast: lonEast - lonPad, latCenter: (latNorth + latSouth) / 2, lonCenter: (lonWest + lonEast) / 2 };
    }

    function measured(cell) {
      return (cell.state === "available" || cell.state === "stale") && cell.netContribution != null && Array.isArray(cell.segments) && cell.segments.length > 0 && !cell.excluded;
    }

    function targetExtrusion(cell) {
      if (!measured(cell)) return 0;
      const value = clamp(Number(cell.netContribution) || 0, -100, 100);
      if (value < 0) return -(0.035 + Math.abs(value) / 100 * 0.145);
      return 0.035 + Math.max(0, value) / 100 * 0.31;
    }

    function currentExtrusion(cell, t) {
      if (!fin(cell.aFrom) || !fin(cell.aTo)) return targetExtrusion(cell);
      const p = clamp((t - cell.aStart - cell.aDelay) / Math.max(1, cell.aDuration), 0, 1);
      const eased = cell.aEase === "back" ? easeOutBack(p) : easeInOutCubic(p);
      return cell.aFrom + (cell.aTo - cell.aFrom) * eased;
    }

    function captureExtrusions(t) {
      const map = new Map();
      for (const c of MODEL) map.set(c.measurementId, currentExtrusion(c, t));
      return map;
    }

    function retarget(easing = "smooth", previous = null) {
      const t = now();
      for (const c of MODEL) {
        const target = targetExtrusion(c);
        c.aFrom = reduceMotion ? target : (previous && previous.has(c.measurementId) ? previous.get(c.measurementId) : 0);
        c.aTo = target;
        c.aStart = t;
        c.aDelay = reduceMotion ? 0 : easing === "back" ? ((c.x - 1) + (c.y - 1)) * 20 + hash01(c.gridIndex * 4.7) * 180 : hash01(c.gridIndex * 7.1) * 70;
        c.aDuration = reduceMotion ? 1 : easing === "back" ? 920 + hash01(c.gridIndex * 9.3) * 720 : 540 + hash01(c.gridIndex * 5.1) * 260;
        c.aEase = easing === "back" ? "back" : "smooth";
      }
    }

    function geometryForCell(c, extrusion) {
      const b = cellAngularBounds(c);
      const baseRadius = 1.006;
      const topRadius = Math.max(0.75, 1 + extrusion);
      const worldBase = [
        spherePoint(b.latNorth, b.lonWest, baseRadius),
        spherePoint(b.latNorth, b.lonEast, baseRadius),
        spherePoint(b.latSouth, b.lonEast, baseRadius),
        spherePoint(b.latSouth, b.lonWest, baseRadius),
      ];
      const worldTop = [
        spherePoint(b.latNorth, b.lonWest, topRadius),
        spherePoint(b.latNorth, b.lonEast, topRadius),
        spherePoint(b.latSouth, b.lonEast, topRadius),
        spherePoint(b.latSouth, b.lonWest, topRadius),
      ];
      const base = worldBase.map(projectPoint);
      const top = worldTop.map(projectPoint);
      const centerBase = projectPoint(spherePoint(b.latCenter, b.lonCenter, baseRadius));
      const centerTop = projectPoint(spherePoint(b.latCenter, b.lonCenter, topRadius));
      return { base, top, centerBase, centerTop, depth: centerBase.depth, extrusion };
    }

    function drawBackdrop(t) {
      const w = canvas.width, h = canvas.height;
      const bg = ctx.createRadialGradient(layout.cx, layout.cy, Math.max(15, layout.radius * 0.08), layout.cx, layout.cy, Math.max(w, h) * 0.78);
      bg.addColorStop(0, "#071b2a"); bg.addColorStop(0.36, "#04111c"); bg.addColorStop(0.72, "#020811"); bg.addColorStop(1, "#010307");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

      ctx.save();
      for (const s of stars) {
        const twinkle = reduceMotion ? 1 : 0.72 + Math.sin(t * 0.0012 + s.p) * 0.28;
        const x = ((s.x + view.yaw * 0.018) % 1 + 1) % 1 * w;
        const y = s.y * h;
        ctx.fillStyle = `rgba(104,207,255,${s.a * twinkle})`;
        ctx.fillRect(x, y, Math.max(0.7, s.r * DPR), Math.max(0.7, s.r * DPR));
      }
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.10;
      ctx.strokeStyle = "#1b526f";
      ctx.lineWidth = 0.55 * DPR;
      const step = 38 * DPR;
      for (let x = (w % step) / 2; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = (h % step) / 2; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.restore();

      const horizon = ctx.createLinearGradient(0, 0, w, 0);
      horizon.addColorStop(0, "rgba(0,163,224,0)"); horizon.addColorStop(0.5, "rgba(0,163,224,.14)"); horizon.addColorStop(1, "rgba(0,163,224,0)");
      ctx.fillStyle = horizon; ctx.fillRect(0, layout.cy + layout.radius * 0.92, w, Math.max(1, DPR));
    }

    function drawPlatform(t) {
      const cx = layout.cx;
      const baseY = layout.cy + layout.radius * 1.13;
      const rx = layout.radius * 1.10;
      const ry = Math.max(12 * DPR, layout.radius * 0.17);
      const surge = tsunamiEnvelope(t);
      ctx.save();
      const beam = ctx.createLinearGradient(0, layout.cy + layout.radius * 0.62, 0, baseY);
      beam.addColorStop(0, "rgba(0,163,224,0)"); beam.addColorStop(1, `rgba(0,163,224,${0.12 + surge * 0.14})`);
      ctx.fillStyle = beam;
      ctx.beginPath(); ctx.moveTo(cx - layout.radius * 0.34, layout.cy + layout.radius * 0.64); ctx.lineTo(cx + layout.radius * 0.34, layout.cy + layout.radius * 0.64); ctx.lineTo(cx + rx * 0.54, baseY); ctx.lineTo(cx - rx * 0.54, baseY); ctx.closePath(); ctx.fill();

      for (let i = 0; i < 5; i += 1) {
        const phase = reduceMotion ? 0 : (t * 0.00012 + i * 0.17) % 1;
        const scale = 0.48 + i * 0.13 + phase * 0.035;
        const color = i % 2 ? "#f4af2d" : "#00a3e0";
        ctx.strokeStyle = rgba(color, 0.16 + (4 - i) * 0.035 + surge * (i === 0 ? 0.18 : 0.055));
        ctx.lineWidth = (i === 0 ? 1.4 : 0.8) * DPR;
        ctx.beginPath(); ctx.ellipse(cx, baseY, rx * scale, ry * scale, 0, 0, TAU); ctx.stroke();
      }
      ctx.shadowColor = "rgba(0,163,224,.9)"; ctx.shadowBlur = 16 * DPR;
      ctx.strokeStyle = "rgba(87,218,255,.72)"; ctx.lineWidth = 1.1 * DPR;
      ctx.beginPath(); ctx.ellipse(cx, baseY, rx * 0.52, ry * 0.52, 0, 0, TAU); ctx.stroke();
      if (surge > 0.001) {
        const pulse = 0.56 + surge * 0.20;
        ctx.strokeStyle = rgba("#e9fdff", 0.20 + surge * 0.62);
        ctx.lineWidth = (1.1 + surge * 1.4) * DPR;
        ctx.shadowColor = rgba("#00a3e0", 0.95); ctx.shadowBlur = (9 + surge * 19) * DPR;
        ctx.beginPath(); ctx.ellipse(cx, baseY, rx * pulse, ry * pulse, 0, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }

    const ORBITS = [
      { radius: 1.23, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0.28, z: 0.96 }, color: "#00a3e0", speed: 0.00042, phase: 0.1 },
      { radius: 1.31, u: { x: 0.88, y: 0.42, z: -0.21 }, v: { x: -0.31, y: 0.10, z: -0.95 }, color: "#f4af2d", speed: -0.00031, phase: 1.7 },
      { radius: 1.17, u: { x: 0.66, y: -0.61, z: 0.44 }, v: { x: -0.34, y: 0.32, z: 0.88 }, color: "#00a3e0", speed: 0.00025, phase: 3.2 },
    ];

    function orbitPoint(orbit, angle) {
      return { x: (orbit.u.x * Math.cos(angle) + orbit.v.x * Math.sin(angle)) * orbit.radius, y: (orbit.u.y * Math.cos(angle) + orbit.v.y * Math.sin(angle)) * orbit.radius, z: (orbit.u.z * Math.cos(angle) + orbit.v.z * Math.sin(angle)) * orbit.radius };
    }

    function drawOrbitPass(t, front) {
      for (const orbit of ORBITS) {
        const steps = 128;
        ctx.save();
        ctx.lineWidth = 0.9 * DPR;
        for (let i = 0; i < steps; i += 1) {
          const a0 = i / steps * TAU;
          const a1 = (i + 1) / steps * TAU;
          const p0 = projectPoint(orbitPoint(orbit, a0));
          const p1 = projectPoint(orbitPoint(orbit, a1));
          const isFront = (p0.depth + p1.depth) / 2 >= 0;
          if (isFront !== front) continue;
          const alpha = front ? 0.24 + clamp((p0.depth + p1.depth) * 0.09, 0, 0.18) : 0.08;
          ctx.strokeStyle = rgba(orbit.color, alpha);
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
        if (front) {
          const phase = reduceMotion ? orbit.phase : orbit.phase + t * orbit.speed;
          for (let trail = 6; trail >= 0; trail -= 1) {
            const a = phase - trail * 0.035 * Math.sign(orbit.speed || 1);
            const p = projectPoint(orbitPoint(orbit, a));
            if (p.depth < -0.05) continue;
            const alpha = (1 - trail / 7) * 0.84;
            const radius = (1.2 + (6 - trail) * 0.25) * DPR;
            ctx.fillStyle = rgba(orbit.color, alpha);
            ctx.shadowColor = rgba(orbit.color, 0.95); ctx.shadowBlur = (5 + (6 - trail)) * DPR;
            ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, TAU); ctx.fill();
          }
          ctx.shadowBlur = 0;
        }
        ctx.restore();
      }
    }

    function drawSphereBody(t) {
      const r = layout.radius;
      const surge = tsunamiEnvelope(t);
      ctx.save();
      const aura = ctx.createRadialGradient(layout.cx, layout.cy, r * 0.72, layout.cx, layout.cy, r * 1.22);
      aura.addColorStop(0, "rgba(0,163,224,0)"); aura.addColorStop(0.72, `rgba(0,163,224,${0.035 + surge * 0.045})`); aura.addColorStop(0.92, `rgba(0,163,224,${0.13 + surge * 0.22})`); aura.addColorStop(1, "rgba(0,163,224,0)");
      ctx.fillStyle = aura; ctx.beginPath(); ctx.arc(layout.cx, layout.cy, r * 1.24, 0, TAU); ctx.fill();

      const body = ctx.createRadialGradient(layout.cx - r * 0.28, layout.cy - r * 0.34, r * 0.08, layout.cx, layout.cy, r);
      body.addColorStop(0, "rgba(15,62,91,.54)"); body.addColorStop(0.36, "rgba(5,31,49,.78)"); body.addColorStop(0.76, "rgba(2,14,25,.91)"); body.addColorStop(1, "rgba(0,5,11,.99)");
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(layout.cx, layout.cy, r, 0, TAU); ctx.fill();
      if (surge > 0.001) {
        const energy = ctx.createRadialGradient(layout.cx - r * 0.18, layout.cy - r * 0.24, r * 0.06, layout.cx, layout.cy, r * 1.02);
        energy.addColorStop(0, rgba("#e9fdff", 0.07 + surge * 0.09));
        energy.addColorStop(0.48, rgba("#00a3e0", surge * 0.075));
        energy.addColorStop(0.86, rgba("#f4af2d", surge * 0.045));
        energy.addColorStop(1, "rgba(0,163,224,0)");
        ctx.fillStyle = energy; ctx.beginPath(); ctx.arc(layout.cx, layout.cy, r * 0.995, 0, TAU); ctx.fill();
      }

      const glass = ctx.createLinearGradient(layout.cx - r, layout.cy - r, layout.cx + r * 0.7, layout.cy + r);
      glass.addColorStop(0, "rgba(116,228,255,.12)"); glass.addColorStop(0.25, "rgba(255,255,255,.025)"); glass.addColorStop(0.44, "rgba(0,0,0,0)"); glass.addColorStop(1, "rgba(0,0,0,.28)");
      ctx.fillStyle = glass; ctx.beginPath(); ctx.arc(layout.cx, layout.cy, r * 0.985, 0, TAU); ctx.fill();

      ctx.lineWidth = (1.4 + surge * 0.8) * DPR; ctx.strokeStyle = rgba("#5cdcff", 0.66 + surge * 0.24); ctx.shadowColor = "rgba(0,163,224,.95)"; ctx.shadowBlur = (13 + surge * 16) * DPR;
      ctx.beginPath(); ctx.arc(layout.cx, layout.cy, r, 0, TAU); ctx.stroke();
      ctx.shadowBlur = 0; ctx.lineWidth = 0.75 * DPR; ctx.strokeStyle = "rgba(201,246,255,.20)";
      ctx.beginPath(); ctx.arc(layout.cx, layout.cy, r * 0.976, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    function drawGridPass(front, dense = false) {
      const lonCount = dense ? 30 : 10;
      const latCount = dense ? 22 : 10;
      const segments = dense ? 48 : 64;
      const color = dense ? "#0b6c94" : "#00a3e0";
      const baseAlpha = dense ? 0.06 : 0.16;
      ctx.save();
      ctx.lineWidth = (dense ? 0.45 : 0.72) * DPR;
      if (dense) ctx.setLineDash([1 * DPR, 4 * DPR]);
      const strokeSegment = (a, b) => {
        const isFront = (a.depth + b.depth) / 2 >= 0;
        if (isFront !== front) return;
        const depth = clamp((a.depth + b.depth + 2) / 4, 0, 1);
        ctx.strokeStyle = rgba(color, baseAlpha * (front ? 0.62 + depth * 1.15 : 0.42));
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      };
      for (let i = 0; i < lonCount; i += 1) {
        const lon = -Math.PI + i / lonCount * TAU;
        let previous = projectPoint(spherePoint(-LAT_MAX, lon, 1.003));
        for (let s = 1; s <= segments; s += 1) {
          const lat = -LAT_MAX + s / segments * LAT_MAX * 2;
          const current = projectPoint(spherePoint(lat, lon, 1.003));
          strokeSegment(previous, current); previous = current;
        }
      }
      for (let i = 0; i <= latCount; i += 1) {
        const lat = -LAT_MAX + i / latCount * LAT_MAX * 2;
        let previous = projectPoint(spherePoint(lat, -Math.PI, 1.003));
        for (let s = 1; s <= segments; s += 1) {
          const lon = -Math.PI + s / segments * TAU;
          const current = projectPoint(spherePoint(lat, lon, 1.003));
          strokeSegment(previous, current); previous = current;
        }
      }
      ctx.restore();
    }

    function drawAxis() {
      const north = projectPoint({ x: 0, y: 1.09, z: 0 });
      const south = projectPoint({ x: 0, y: -1.09, z: 0 });
      ctx.save();
      ctx.strokeStyle = "rgba(0,163,224,.34)"; ctx.lineWidth = 0.9 * DPR; ctx.setLineDash([4 * DPR, 5 * DPR]);
      ctx.beginPath(); ctx.moveTo(north.x, north.y); ctx.lineTo(south.x, south.y); ctx.stroke(); ctx.setLineDash([]);
      for (const [p, color] of [[north, "#00a3e0"], [south, "#f4af2d"]]) {
        ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10 * DPR; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2 * DPR, 0, TAU); ctx.fill();
      }
      ctx.shadowBlur = 0;
      if (layout.cssWidth > 760) {
        ctx.font = `700 ${8 * DPR}px ui-monospace,Consolas,monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(103,211,255,.64)"; ctx.fillText("NORTH NODE", north.x, north.y - 11 * DPR);
        ctx.fillStyle = "rgba(244,175,45,.68)"; ctx.fillText("SOUTH NODE", south.x, south.y + 12 * DPR);
      }
      ctx.restore();
    }

    function drawTsunamiPass(t, front) {
      if (!tsunami) return;
      const elapsed = t - tsunami.start;
      if (elapsed < 0 || elapsed > TSUNAMI_TRAVEL_MS + 420) return;
      const progress = clamp(elapsed / TSUNAMI_TRAVEL_MS, 0, 1);
      const envelope = tsunamiEnvelope(t) * (elapsed > TSUNAMI_TRAVEL_MS ? 1 - (elapsed - TSUNAMI_TRAVEL_MS) / 420 : 1);
      const longitude = tsunami.originLon + tsunami.direction * progress * TAU;
      const lanes = [-0.15, -0.075, 0, 0.075, 0.15];
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
        const lane = lanes[laneIndex];
        const centrality = 1 - Math.abs(lane) / 0.18;
        const radius = 1.011 + centrality * 0.012;
        let previous = projectPoint(spherePoint(-Math.PI / 2 + 0.018, longitude + lane, radius));
        for (let i = 1; i <= 112; i += 1) {
          const latitude = -Math.PI / 2 + 0.018 + i / 112 * (Math.PI - 0.036);
          const current = projectPoint(spherePoint(latitude, longitude + lane, radius));
          const isFront = (previous.depth + current.depth) / 2 >= 0;
          if (isFront === front) {
            const depth = clamp((previous.depth + current.depth + 2) / 4, 0, 1);
            const alpha = envelope * centrality * (front ? 0.18 + depth * 0.62 : 0.055);
            ctx.strokeStyle = laneIndex === 2 ? rgba("#e9fdff", alpha) : rgba(laneIndex % 2 ? "#f4af2d" : "#00a3e0", alpha * 0.72);
            ctx.lineWidth = (laneIndex === 2 ? 2.1 : 0.8) * DPR;
            ctx.shadowColor = laneIndex === 2 ? "rgba(233,253,255,.95)" : "rgba(0,163,224,.85)";
            ctx.shadowBlur = (laneIndex === 2 ? 15 : 7) * DPR;
            ctx.beginPath(); ctx.moveTo(previous.x, previous.y); ctx.lineTo(current.x, current.y); ctx.stroke();
          }
          previous = current;
        }
      }
      if (front && envelope > 0.02) {
        const head = projectPoint(spherePoint(0, longitude, 1.035));
        if (head.depth >= -0.04) {
          const radius = (3.2 + envelope * 4.2) * DPR;
          ctx.fillStyle = rgba("#e9fdff", 0.64 + envelope * 0.34);
          ctx.shadowColor = "rgba(0,163,224,.98)"; ctx.shadowBlur = (14 + envelope * 18) * DPR;
          ctx.beginPath(); ctx.arc(head.x, head.y, radius, 0, TAU); ctx.fill();
          for (let i = 0; i < 4; i += 1) {
            const angle = t * 0.003 + i * TAU / 4;
            ctx.fillStyle = rgba(i % 2 ? "#f4af2d" : "#00a3e0", 0.72 * envelope);
            ctx.beginPath(); ctx.arc(head.x + Math.cos(angle) * radius * 2.3, head.y + Math.sin(angle) * radius * 2.3, Math.max(1, radius * 0.22), 0, TAU); ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    function fieldStats() {
      const activeCells = MODEL.filter((c) => measured(c));
      const net = activeCells.reduce((sum, c) => sum + (Number(c.netContribution) || 0), 0);
      const excluded = MODEL.filter((c) => c.excluded && c.state !== "reserved").length;
      return { active: activeCells.length, net, excluded, known: MODEL.filter((c) => c.state !== "unknown" && c.state !== "reserved").length };
    }


    function drawBackCell(c, geom, surge) {
      const color = c.familyColor || "#00a3e0";
      const transient = Math.max(surge?.wave || 0, surge?.intensity || 0);
      const alpha = clamp((geom.depth + 1) * 0.035, 0.018, 0.075) + transient * 0.032;
      polygon(geom.base, rgba(color, alpha), rgba(color, alpha * 1.8), 0.55);
      const p = Math.abs(geom.extrusion) > 0.001 ? geom.centerTop : geom.centerBase;
      ctx.save();
      ctx.fillStyle = rgba(color, alpha * 2.2 + transient * 0.12);
      ctx.shadowColor = rgba(color, transient * 0.72); ctx.shadowBlur = transient * 8 * DPR;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.7, pointSize(c, p) * (0.52 + transient * 0.34)), 0, TAU); ctx.fill();
      ctx.restore();
    }

    function drawFrontCell(c, geom, t, surge, baseExtrusion) {
      const familyColor = c.familyColor || "#00a3e0";
      const frontness = clamp((geom.depth + 0.10) / 1.10, 0.08, 1);
      const isActive = measured(c);
      const isSelected = c === selectedCell;
      const isHover = c === hoverCell;
      const hasExtrusion = Math.abs(geom.extrusion) > 0.001;
      const isPositive = geom.extrusion > 0.001;
      const isNegative = geom.extrusion < -0.001;
      const truthNegative = baseExtrusion < -0.001;
      const stale = c.state === "stale";
      const grey = "#5f7d99";
      const transient = surge?.intensity || 0;
      const wave = surge?.wave || 0;
      const heroBlink = surge?.blink || 0;
      const extrusionColor = c.excluded ? grey : truthNegative ? "#ff5500" : familyColor;
      const nodeColor = c.excluded ? grey : truthNegative ? "#ff5500" : familyColor;
      const baseFill = c.state === "reserved"
        ? "rgba(5,16,25,.30)"
        : c.excluded
          ? "rgba(48,62,73,.20)"
          : rgba(familyColor, (isActive ? 0.13 : 0.052) * frontness + wave * 0.10 + transient * 0.12);
      const baseStroke = c.state === "reserved"
        ? "rgba(20,45,62,.24)"
        : rgba(c.excluded ? grey : familyColor, ((isActive ? 0.38 : 0.21) + wave * 0.48 + transient * 0.55) * frontness);

      polygon(geom.base, baseFill, null);
      ctx.save();
      if (stale) ctx.setLineDash([3 * DPR, 2 * DPR]);
      ctx.shadowColor = rgba(familyColor, wave * 0.72 + transient * 0.58);
      ctx.shadowBlur = (wave * 8 + transient * 12) * DPR;
      polygon(geom.base, null, baseStroke, isActive ? 0.85 : 0.62);
      ctx.restore();

      if (isPositive) {
        const sides = [];
        for (let i = 0; i < 4; i += 1) {
          const j = (i + 1) % 4;
          sides.push({ points: [geom.base[i], geom.base[j], geom.top[j], geom.top[i]], depth: (geom.base[i].depth + geom.base[j].depth + geom.top[j].depth + geom.top[i].depth) / 4 });
        }
        sides.sort((a, b) => a.depth - b.depth);
        for (const side of sides) {
          const g = ctx.createLinearGradient(side.points[0].x, side.points[0].y, side.points[2].x, side.points[2].y);
          g.addColorStop(0, rgba(shade(extrusionColor, -0.58), (0.44 + transient * 0.20) * frontness));
          g.addColorStop(1, rgba(shade(extrusionColor, 0.22), (0.62 + transient * 0.25) * frontness));
          polygon(side.points, g, rgba(extrusionColor, (0.26 + transient * 0.32) * frontness), 0.55 + transient * 0.45);
        }
        ctx.save();
        ctx.shadowColor = rgba(extrusionColor, 0.92); ctx.shadowBlur = (8 + Math.max(0, geom.extrusion) * 24 + transient * 17) * DPR;
        const cap = ctx.createLinearGradient(geom.top[0].x, geom.top[0].y, geom.top[2].x, geom.top[2].y);
        cap.addColorStop(0, rgba(shade(extrusionColor, 0.65), Math.min(1, (0.92 + transient * 0.20) * frontness)));
        cap.addColorStop(0.36, rgba(shade(extrusionColor, 0.22), Math.min(1, (0.78 + transient * 0.18) * frontness)));
        cap.addColorStop(1, rgba(shade(extrusionColor, -0.18), Math.min(1, (0.62 + transient * 0.18) * frontness)));
        polygon(geom.top, cap, rgba(shade(extrusionColor, 0.58), Math.min(1, (0.92 + transient * 0.28) * frontness)), 1.05 + transient * 0.75);
        ctx.restore();
      } else if (isNegative) {
        const pitColor = truthNegative ? "#ff5500" : familyColor;
        ctx.save();
        ctx.shadowColor = rgba(pitColor, 0.72 + transient * 0.24); ctx.shadowBlur = (9 + transient * 13) * DPR;
        polygon(geom.base, rgba(shade(pitColor, -0.72), 0.52), rgba(shade(pitColor, 0.38), 0.86), 1.2 + transient * 0.7);
        ctx.restore();
        for (let i = 0; i < 4; i += 1) {
          const j = (i + 1) % 4;
          const side = [geom.base[i], geom.base[j], geom.top[j], geom.top[i]];
          const g = ctx.createLinearGradient(side[0].x, side[0].y, side[2].x, side[2].y);
          g.addColorStop(0, rgba(pitColor, 0.36 + transient * 0.24));
          g.addColorStop(1, rgba(shade(pitColor, -0.84), 0.78));
          polygon(side, g, rgba(pitColor, 0.30 + transient * 0.28), 0.55);
        }
        polygon(geom.top, rgba(shade(pitColor, -0.90), 0.92), rgba(shade(pitColor, 0.30), 0.52 + transient * 0.28), 0.75 + transient * 0.55);
      }

      const center = hasExtrusion ? geom.centerTop : geom.centerBase;
      const nodeRadius = pointSize(c, center) * ((isActive || hasExtrusion) ? 1.08 : 0.82) * (1 + transient * 0.32);
      ctx.save();
      ctx.fillStyle = c.excluded ? "rgba(95,125,153,.40)" : rgba(nodeColor, Math.min(1, (isActive ? 0.94 : 0.56) * frontness + transient * 0.42 + wave * 0.18));
      ctx.shadowColor = rgba(nodeColor, Math.min(1, (isActive ? 0.92 : 0.52) + transient * 0.42));
      ctx.shadowBlur = ((isActive ? 8 : 4) + transient * 14 + wave * 5) * DPR;
      ctx.beginPath(); ctx.arc(center.x, center.y, nodeRadius, 0, TAU); ctx.fill();
      ctx.restore();

      if (c.excluded) {
        const rr = Math.max(3.2 * DPR, nodeRadius * 1.65);
        drawLine({ x: center.x - rr, y: center.y - rr }, { x: center.x + rr, y: center.y + rr }, "rgba(123,153,174,.52)", 0.8);
        drawLine({ x: center.x + rr, y: center.y - rr }, { x: center.x - rr, y: center.y + rr }, "rgba(123,153,174,.52)", 0.8);
      }

      if (wave > 0.015 || transient > 0.015) {
        const face = hasExtrusion ? geom.top : geom.base;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.shadowColor = rgba(familyColor, 0.95); ctx.shadowBlur = (8 + transient * 20 + wave * 10) * DPR;
        polygon(face, rgba(familyColor, wave * 0.055 + transient * 0.12), rgba(shade(familyColor, 0.60), wave * 0.68 + transient * 0.82), 0.75 + transient * 1.15);
        ctx.restore();
      }

      if (surge?.hero && heroBlink > 0.02) {
        const face = hasExtrusion ? geom.top : geom.base;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.shadowColor = rgba(familyColor, 1); ctx.shadowBlur = (18 + heroBlink * 28) * DPR;
        polygon(face, rgba("#ffffff", heroBlink * 0.10), rgba(shade(familyColor, 0.76), 0.58 + heroBlink * 0.42), 1.45 + heroBlink * 1.25);
        for (let ring = 0; ring < 2; ring += 1) {
          const rr = Math.max(8 * DPR, nodeRadius * (3.0 + ring * 1.35)) * (0.84 + heroBlink * 0.42);
          ctx.strokeStyle = ring ? rgba(familyColor, 0.24 + heroBlink * 0.56) : rgba("#ffffff", 0.22 + heroBlink * 0.62);
          ctx.lineWidth = (1.0 + heroBlink * 0.9) * DPR;
          ctx.beginPath(); ctx.arc(center.x, center.y, rr, 0, TAU); ctx.stroke();
        }
        ctx.restore();
      }

      if (isSelected) {
        const age = Math.max(0, t - selectionStartedAt);
        const breath = reduceMotion ? 1 : 0.74 + (0.5 + 0.5 * Math.sin(age * 0.0068)) * 0.26;
        const arrivalBurst = reduceMotion ? 0 : Math.exp(-age / 720) * (0.55 + 0.45 * Math.sin(age * 0.024) ** 2);
        const face = hasExtrusion ? geom.top : geom.base;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.shadowColor = rgba(familyColor, 0.98); ctx.shadowBlur = (14 + breath * 10 + arrivalBurst * 18) * DPR;
        polygon(face, rgba(familyColor, 0.075 + breath * 0.055 + arrivalBurst * 0.08), rgba(shade(familyColor, 0.68), 0.78 + breath * 0.20), 1.45 + breath * 0.55);
        ctx.setLineDash([5 * DPR, 3 * DPR]);
        ctx.lineDashOffset = reduceMotion ? 0 : -age * 0.018 * DPR;
        polygon(face, null, rgba("#ffffff", 0.30 + breath * 0.42), 0.75);
        ctx.setLineDash([]);
        const rr = Math.max(8 * DPR, nodeRadius * 2.75) * (0.90 + breath * 0.15 + arrivalBurst * 0.16);
        ctx.strokeStyle = rgba(familyColor, 0.90); ctx.lineWidth = 1.45 * DPR;
        ctx.beginPath(); ctx.arc(center.x, center.y, rr, 0, TAU); ctx.stroke();
        for (let i = 0; i < 3; i += 1) {
          const angle = age * 0.0023 + i * TAU / 3;
          const orbitRadius = rr * (1.08 + i * 0.07);
          ctx.fillStyle = i === 1 ? rgba("#ffffff", 0.86) : rgba(familyColor, 0.94);
          ctx.beginPath(); ctx.arc(center.x + Math.cos(angle) * orbitRadius, center.y + Math.sin(angle) * orbitRadius, (1.15 + arrivalBurst * 1.25) * DPR, 0, TAU); ctx.fill();
        }
        ctx.restore();
      } else if (isHover) {
        const pulse = reduceMotion ? 1 : 0.88 + Math.sin(t * 0.007) * 0.12;
        const rr = Math.max(7 * DPR, nodeRadius * 2.5) * pulse;
        ctx.save(); ctx.strokeStyle = "rgba(235,251,255,.82)"; ctx.lineWidth = 1.05 * DPR;
        ctx.shadowColor = "rgba(144,231,255,.82)"; ctx.shadowBlur = 11 * DPR;
        ctx.beginPath(); ctx.arc(center.x, center.y, rr, 0, TAU); ctx.stroke(); ctx.restore();
      }

      if (c.state !== "reserved") {
        labelList.push({ cell: c, geom, center, nodeRadius, frontness, isActive, isSelected, isHover, surge, face: hasExtrusion ? geom.top : geom.base });
      }

      if (geom.depth > -0.02 && c.state !== "reserved") {
        const hitFace = (hasExtrusion ? geom.top : geom.base).map((p) => [p.x, p.y]);
        pickList.push({ cell: c, poly: hitFace, depth: geom.depth });
      }
    }

    function drawMetricLabels(t) {
      if (!labelList.length) return;
      const entries = labelList.slice().sort((a, b) => a.geom.depth - b.geom.depth);
      for (const entry of entries) {
        const c = entry.cell;
        const familyColor = c.familyColor || "#00a3e0";
        const xs = entry.face.map((p) => p.x), ys = entry.face.map((p) => p.y);
        const faceWidth = Math.max(...xs) - Math.min(...xs);
        const faceHeight = Math.max(...ys) - Math.min(...ys);
        const projectedMinor = Math.max(1, Math.min(faceWidth, faceHeight));
        const zoomCss = layout.radius / DPR;
        const fontCss = clamp(projectedMinor / DPR * 0.23 + Math.log2(Math.max(0.5, view.userZoom)) * 1.1, 6.8, 15.5);
        const fontSize = fontCss * DPR;
        const selectedPulse = entry.isSelected ? (reduceMotion ? 1 : 0.80 + Math.sin((t - selectionStartedAt) * 0.0068) * 0.20) : 0;
        const surgeIntensity = Math.max(entry.surge?.intensity || 0, entry.surge?.wave || 0);
        const heroBlink = entry.surge?.blink || 0;
        const yShift = Math.max(entry.nodeRadius * 2.0, fontSize * 0.72);
        const x = entry.center.x;
        const y = entry.center.y - yShift;
        if (x < -40 * DPR || x > canvas.width + 40 * DPR || y < -30 * DPR || y > canvas.height + 30 * DPR) continue;
        ctx.save();
        ctx.font = `850 ${fontSize}px ui-monospace,Consolas,monospace`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const textWidth = ctx.measureText(c.measurementId).width;
        const padX = clamp(fontSize * 0.34, 2.4 * DPR, 6.2 * DPR);
        const padY = clamp(fontSize * 0.20, 1.6 * DPR, 4.0 * DPR);
        const boxW = textWidth + padX * 2;
        const boxH = fontSize + padY * 2;
        const alpha = c.excluded ? 0.36 : 0.66 + entry.frontness * 0.18 + selectedPulse * 0.12 + surgeIntensity * 0.12;
        roundedRect(x - boxW / 2, y - boxH / 2, boxW, boxH, clamp(boxH * 0.22, 2 * DPR, 5 * DPR));
        ctx.fillStyle = c.excluded ? "rgba(12,20,27,.64)" : `rgba(1,7,13,${clamp(alpha, 0.62, 0.94)})`;
        ctx.fill();
        ctx.strokeStyle = c.excluded
          ? "rgba(95,125,153,.42)"
          : entry.isSelected
            ? rgba(shade(familyColor, 0.66), 0.92)
            : heroBlink > 0.02
              ? rgba("#ffffff", 0.42 + heroBlink * 0.58)
              : rgba(familyColor, 0.38 + entry.frontness * 0.30 + surgeIntensity * 0.25);
        ctx.lineWidth = (entry.isSelected ? 1.15 : 0.70) * DPR;
        ctx.shadowColor = entry.isSelected || surgeIntensity > 0.05 ? rgba(familyColor, 0.95) : "rgba(0,0,0,.92)";
        ctx.shadowBlur = (entry.isSelected ? 10 : 3) * DPR + surgeIntensity * 12 * DPR;
        ctx.stroke();
        ctx.lineWidth = Math.max(1, fontSize * 0.18);
        ctx.strokeStyle = "rgba(0,0,0,.94)";
        ctx.strokeText(c.measurementId, x, y);
        ctx.fillStyle = c.excluded
          ? "rgba(142,162,176,.64)"
          : entry.isSelected
            ? "#f4fdff"
            : heroBlink > 0.04
              ? "#ffffff"
              : entry.isHover
                ? "#f1fbff"
                : entry.isActive
                  ? "rgba(237,252,255,.96)"
                  : rgba(shade(familyColor, 0.45), 0.92);
        ctx.shadowColor = entry.isSelected || heroBlink > 0.04 ? rgba(familyColor, 0.95) : "rgba(0,0,0,.88)";
        ctx.shadowBlur = (entry.isSelected ? 8 : 2) * DPR + heroBlink * 12 * DPR;
        ctx.fillText(c.measurementId, x, y);
        ctx.restore();
      }
    }

    function drawCells(t, back) {
      const entries = MODEL.map((c) => {
        const baseExtrusion = currentExtrusion(c, t);
        const surge = tsunamiVisual(c, t);
        const extrusion = clamp(baseExtrusion + surge.offset, -0.235, 0.46);
        return { c, baseExtrusion, surge, geom: geometryForCell(c, extrusion) };
      }).sort((a, b) => a.geom.depth - b.geom.depth);
      if (!back) { pickList = []; labelList = []; }
      for (const entry of entries) {
        if (back && entry.geom.depth < 0) drawBackCell(entry.c, entry.geom, entry.surge);
        if (!back && entry.geom.depth >= -0.05) drawFrontCell(entry.c, entry.geom, t, entry.surge, entry.baseExtrusion);
      }
    }

    const FAMILY_LABELS = { TARGET_QUALITY: "TARGET QUALITY", EVIDENCE_ASSURANCE: "EVIDENCE & ASSURANCE", ACCEPTANCE_GATES: "ACCEPTANCE GATES", CLUE_SELF: "CLU-E SELF" };
    function familyStats(family) {
      const cells = MODEL.filter((c) => c.family === family && !c.excluded);
      const active = cells.filter(measured);
      return { count: cells.length, active: active.length, net: active.reduce((s, c) => s + (Number(c.netContribution) || 0), 0) };
    }


    function drawInspectorTrace(anchor, t) {
      if (!selectedCell || !anchor || !finP(anchor) || !insp.classList.contains("is-open")) return;
      const hostRect = container.getBoundingClientRect();
      const inspectorRect = insp.getBoundingClientRect();
      const targetX = (inspectorRect.left - hostRect.left - 7) * DPR;
      const targetY = clamp(anchor.y, (inspectorRect.top - hostRect.top + 42) * DPR, (inspectorRect.bottom - hostRect.top - 42) * DPR);
      const age = Math.max(0, t - selectionStartedAt);
      const breath = reduceMotion ? 1 : 0.74 + (0.5 + 0.5 * Math.sin(age * 0.0068)) * 0.26;
      const color = selectedCell.familyColor || "#f4af2d";
      const bendX = Math.min(targetX - 18 * DPR, anchor.x + Math.max(24 * DPR, (targetX - anchor.x) * .44));
      ctx.save();ctx.strokeStyle=rgba(color,.38+breath*.34);ctx.lineWidth=(.9+breath*.42)*DPR;ctx.shadowColor=rgba(color,.92);ctx.shadowBlur=(6+breath*8)*DPR;ctx.setLineDash([5*DPR,4*DPR]);ctx.lineDashOffset=reduceMotion?0:-age*.014*DPR;
      ctx.beginPath();ctx.moveTo(anchor.x,anchor.y);ctx.lineTo(anchor.x+16*DPR,anchor.y);ctx.lineTo(bendX,targetY);ctx.lineTo(targetX,targetY);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle=rgba(shade(color,.66),.92);ctx.shadowColor=rgba(color,.95);ctx.shadowBlur=11*DPR;ctx.beginPath();ctx.arc(anchor.x,anchor.y,(2.1+breath*1.1)*DPR,0,TAU);ctx.fill();ctx.beginPath();ctx.arc(targetX,targetY,(1.3+breath*.6)*DPR,0,TAU);ctx.fill();ctx.restore();
    }

    function drawSelectedTrace(t) {
      if (!selectedCell) return;
      const baseExtrusion = currentExtrusion(selectedCell, t);
      const surge = tsunamiVisual(selectedCell, t);
      const geom = geometryForCell(selectedCell, clamp(baseExtrusion + surge.offset, -0.235, 0.46));
      if (geom.depth < -0.08) return;
      selectedAnchor = Math.abs(geom.extrusion) > 0.001 ? geom.centerTop : geom.centerBase;
      drawInspectorTrace(selectedAnchor, t);
    }


    function gridTileCorners(gx, gy, elevation) {
      const o = 0.5;
      return [gridProject(gx - o, gy - o, elevation), gridProject(gx + o, gy - o, elevation), gridProject(gx + o, gy + o, elevation), gridProject(gx - o, gy + o, elevation)];
    }

    function gridExtrusionPixels(extrusion) {
      if (extrusion >= 0) return extrusion / 0.345 * GRID_MAX_BAR;
      return extrusion / 0.18 * GRID_MAX_PIT;
    }

    function gridFillGradient(points, topColor, bottomColor) {
      if (!points.every(finP)) return;
      const top = { x: (points[2].x + points[3].x) / 2, y: (points[2].y + points[3].y) / 2 };
      const bottom = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      let fill = bottomColor;
      if (top.x !== bottom.x || top.y !== bottom.y) {
        const gradient = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y);
        gradient.addColorStop(0, topColor); gradient.addColorStop(1, bottomColor); fill = gradient;
      }
      polygon(points, fill, null);
    }

    function drawGridTile(c, corners, t, surge, extrusionPx) {
      const familyColor = c.familyColor || "#00a3e0";
      const active = measured(c);
      const selected = c === selectedCell;
      const hovered = c === hoverCell;
      const transient = Math.max(surge?.intensity || 0, surge?.wave || 0);
      let fill, edge;
      if (c.excluded) { fill = "rgba(43,58,69,.16)"; edge = "rgba(95,125,153,.38)"; }
      else if (c.state === "reserved") { fill = "rgba(5,16,25,.64)"; edge = "rgba(20,50,70,.42)"; }
      else { fill = rgba(familyColor, (active ? 0.11 : 0.052) + transient * 0.12); edge = rgba(familyColor, (active ? 0.34 : 0.18) + transient * 0.62); }
      polygon(corners, fill, null);
      ctx.save();
      if (c.state === "stale") ctx.setLineDash([4 * DPR, 3 * DPR]);
      ctx.shadowColor = rgba(familyColor, transient * 0.92); ctx.shadowBlur = transient * 15 * DPR;
      polygon(corners, null, edge, 0.85 + transient * 0.8);
      ctx.restore();
      if (c.excluded) {
        drawLine(corners[0], corners[2], "rgba(111,142,162,.50)", 0.8);
        drawLine(corners[1], corners[3], "rgba(111,142,162,.50)", 0.8);
      }
      if (selected) {
        const age = Math.max(0, t - selectionStartedAt);
        const breath = reduceMotion ? 1 : 0.78 + Math.sin(age * 0.0068) * 0.22;
        ctx.save(); ctx.globalCompositeOperation = "lighter";
        ctx.shadowColor = rgba(familyColor, .98); ctx.shadowBlur = (14 + breath * 12) * DPR;
        polygon(corners, rgba(familyColor, .075 + breath * .055), rgba(shade(familyColor, .68), .82), 1.45 + breath * .55);
        ctx.setLineDash([5 * DPR, 3 * DPR]); ctx.lineDashOffset = reduceMotion ? 0 : -age * .018 * DPR;
        polygon(corners, null, rgba("#ffffff", .28 + breath * .44), .75); ctx.setLineDash([]);
        const center = { x: corners.reduce((s,p)=>s+p.x,0)/4, y: corners.reduce((s,p)=>s+p.y,0)/4 };
        for (let i=0;i<3;i++) { const a=age*.0024+i*TAU/3, r=Math.max(9*DPR,Math.abs(corners[1].x-corners[0].x)*.24); ctx.fillStyle=i===1?"rgba(255,255,255,.88)":rgba(familyColor,.94); ctx.beginPath(); ctx.arc(center.x+Math.cos(a)*r,center.y+Math.sin(a)*r,(1.15+breath*.35)*DPR,0,TAU);ctx.fill(); }
        ctx.restore();
      } else if (hovered) {
        ctx.save(); ctx.shadowColor = "rgba(144,231,255,.82)"; ctx.shadowBlur = 11 * DPR; polygon(corners, null, "rgba(235,251,255,.82)", 1.05); ctx.restore();
      }
      if (surge?.hero && surge.blink > .02) {
        ctx.save();ctx.globalCompositeOperation="lighter";ctx.shadowColor=rgba(familyColor,1);ctx.shadowBlur=(18+surge.blink*26)*DPR;
        polygon(corners,rgba("#ffffff",surge.blink*.10),rgba(shade(familyColor,.76),.58+surge.blink*.42),1.4+surge.blink*1.2);ctx.restore();
      }
    }

    function drawGridBar(c, px, surge, baseExtrusion) {
      const gx = c.x - 1, gy = c.y - 1, offset = 0.46;
      const up = px > 0, zTop = Math.max(0, px), zBottom = Math.min(0, px);
      const points = [[-offset,-offset],[offset,-offset],[offset,offset],[-offset,offset]];
      const bottom = points.map(([dx,dy])=>gridProject(gx+dx,gy+dy,zBottom));
      const top = points.map(([dx,dy])=>gridProject(gx+dx,gy+dy,zTop));
      if (![...bottom,...top].every(finP)) return [];
      const baseTruth = baseExtrusion;
      const truthNegative = baseTruth < -.001;
      const familyColor = c.familyColor || "#00a3e0";
      const color = c.excluded ? "#5f7d99" : truthNegative ? "#ff5500" : familyColor;
      const transient = surge?.intensity || 0;
      const sides=[];
      for(let i=0;i<4;i++){const j=(i+1)%4;sides.push({points:[bottom[i],bottom[j],top[j],top[i]],depth:(bottom[i].depth+bottom[j].depth+top[i].depth+top[j].depth)/4});}
      sides.sort((a,b)=>a.depth-b.depth);
      if (up) {
        for (const side of sides) gridFillGradient(side.points, rgba(shade(color,.32),.50+transient*.20), rgba(shade(color,-.58),.38+transient*.18));
        ctx.save();ctx.shadowColor=rgba(color,.95);ctx.shadowBlur=(10+transient*18)*DPR;
        gridFillGradient(top,rgba(shade(color,.64),.92),rgba(color,.54));polygon(top,null,rgba(shade(color,.60),.95),1.25+transient*.7);ctx.restore();
      } else {
        const pitColor = truthNegative ? "#ff5500" : familyColor;
        ctx.save();ctx.shadowColor=rgba(pitColor,.80);ctx.shadowBlur=(9+transient*14)*DPR;polygon(bottom,rgba(shade(pitColor,-.86),.92),rgba(shade(pitColor,.36),.68),.9);ctx.restore();
        for (const side of sides) gridFillGradient(side.points,rgba(pitColor,.38+transient*.20),rgba(shade(pitColor,-.86),.82));
        polygon(top,rgba(shade(pitColor,-.58),.50),rgba(pitColor,.48),.9);
      }
      ctx.save();ctx.strokeStyle=rgba(shade(color,.45),.88);ctx.shadowColor=rgba(color,.72);ctx.shadowBlur=4*DPR;ctx.lineWidth=1.05*DPR;
      for(let i=0;i<4;i++){ctx.beginPath();ctx.moveTo(bottom[i].x,bottom[i].y);ctx.lineTo(top[i].x,top[i].y);ctx.stroke();}ctx.restore();
      return [top.map(p=>[p.x,p.y]),...sides.map(s=>s.points.map(p=>[p.x,p.y]))];
    }

    function drawGridMetricLabel(c, point, face, t, surge) {
      if (c.state === "reserved" || !finP(point)) return;
      const familyColor = c.familyColor || "#00a3e0";
      const xs=face.map(p=>p.x), ys=face.map(p=>p.y);
      const minor=Math.max(1,Math.min(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)));
      const fontCss=clamp(minor/DPR*.28 + Math.log2(Math.max(.35,gridView.userZoom))*.75,5.8,17.2);
      const font=fontCss*DPR;
      const selected=c===selectedCell, hovered=c===hoverCell, transient=Math.max(surge?.intensity||0,surge?.wave||0), heroBlink=surge?.blink||0;
      ctx.save();ctx.font=`850 ${font}px ui-monospace,Consolas,monospace`;ctx.textAlign="center";ctx.textBaseline="middle";
      const tw=ctx.measureText(c.measurementId).width,padX=clamp(font*.30,2.2*DPR,6*DPR),padY=clamp(font*.17,1.4*DPR,3.6*DPR),w=tw+padX*2,h=font+padY*2;
      roundedRect(point.x-w/2,point.y-h/2,w,h,clamp(h*.18,1.5*DPR,4*DPR));
      ctx.fillStyle=c.excluded?"rgba(12,20,27,.66)":`rgba(1,7,13,${clamp(.72+transient*.16+(selected?.10:0),.70,.96)})`;ctx.fill();
      ctx.strokeStyle=c.excluded?"rgba(95,125,153,.44)":selected?rgba(shade(familyColor,.68),.96):heroBlink>.02?rgba("#ffffff",.42+heroBlink*.58):rgba(familyColor,.42+transient*.36+(hovered?.18:0));
      ctx.lineWidth=(selected?1.15:.70)*DPR;ctx.shadowColor=(selected||transient>.04)?rgba(familyColor,.96):"rgba(0,0,0,.90)";ctx.shadowBlur=(selected?10:3)*DPR+transient*11*DPR;ctx.stroke();
      ctx.lineWidth=Math.max(1,font*.18);ctx.strokeStyle="rgba(0,0,0,.96)";ctx.strokeText(c.measurementId,point.x,point.y);
      ctx.fillStyle=c.excluded?"rgba(142,162,176,.64)":selected?"#f4fdff":heroBlink>.04?"#ffffff":hovered?"#f1fbff":measured(c)?"rgba(237,252,255,.96)":rgba(shade(familyColor,.48),.94);
      ctx.shadowColor=(selected||heroBlink>.04)?rgba(familyColor,.95):"rgba(0,0,0,.86)";ctx.shadowBlur=(selected?8:2)*DPR+heroBlink*12*DPR;ctx.fillText(c.measurementId,point.x,point.y);ctx.restore();
    }

    function gridLineForWave(t, laneOffset=0) {
      if (!tsunami) return null;
      const elapsed=t-tsunami.start;
      if(elapsed<0||elapsed>TSUNAMI_TRAVEL_MS+420)return null;
      const progress=clamp(elapsed/TSUNAMI_TRAVEL_MS,0,1);
      const coord=(tsunami.gridDirection>0?progress:1-progress)+laneOffset;
      const dot=coord*(Math.SQRT2*2)-Math.SQRT2;
      const nx=Math.cos(tsunami.gridAngle),ny=Math.sin(tsunami.gridAngle),tx=-ny,ty=nx;
      const length=2.15;
      const a={x:nx*dot+tx*length,y:ny*dot+ty*length};
      const b={x:nx*dot-tx*length,y:ny*dot-ty*length};
      return [gridProject(GRID_CENTER+a.x*5,GRID_CENTER+a.y*5,1.5),gridProject(GRID_CENTER+b.x*5,GRID_CENTER+b.y*5,1.5)];
    }

    function drawGridTsunami(t) {
      if(!tsunami)return;
      const envelope=tsunamiEnvelope(t);
      if(envelope<=.001)return;
      ctx.save();ctx.globalCompositeOperation="lighter";
      const lanes=[-.055,-.028,0,.028,.055];
      for(let i=0;i<lanes.length;i++){const line=gridLineForWave(t,lanes[i]);if(!line)continue;const centrality=1-Math.abs(lanes[i])/.06;ctx.strokeStyle=i===2?rgba("#e9fdff",envelope*.82):rgba(i%2?"#f4af2d":"#00a3e0",envelope*.42*centrality);ctx.lineWidth=(i===2?2.2:.8)*DPR;ctx.shadowColor=i===2?"rgba(233,253,255,.96)":"rgba(0,163,224,.86)";ctx.shadowBlur=(i===2?16:7)*DPR;ctx.beginPath();ctx.moveTo(line[0].x,line[0].y);ctx.lineTo(line[1].x,line[1].y);ctx.stroke();}
      const head=gridLineForWave(t,0);if(head){const p={x:(head[0].x+head[1].x)/2,y:(head[0].y+head[1].y)/2};ctx.fillStyle=rgba("#e9fdff",.62+envelope*.34);ctx.shadowColor="rgba(0,163,224,.98)";ctx.shadowBlur=(14+envelope*18)*DPR;ctx.beginPath();ctx.arc(p.x,p.y,(3.1+envelope*4.1)*DPR,0,TAU);ctx.fill();}
      ctx.restore();
    }

    function drawGridBackdrop(t) {
      const w=canvas.width,h=canvas.height;
      const bg=ctx.createRadialGradient(gridLayout.cx,gridLayout.cy,20*DPR,gridLayout.cx,gridLayout.cy,Math.max(w,h)*.78);bg.addColorStop(0,"#071a29");bg.addColorStop(.48,"#04101b");bg.addColorStop(1,"#01050a");ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
      ctx.save();for(const s of stars){const twinkle=reduceMotion?1:.72+Math.sin(t*.0012+s.p)*.28;ctx.fillStyle=`rgba(104,207,255,${s.a*twinkle*.58})`;ctx.fillRect(s.x*w,s.y*h,Math.max(.7,s.r*DPR),Math.max(.7,s.r*DPR));}ctx.restore();
      ctx.save();ctx.globalAlpha=.12;ctx.strokeStyle="#1b526f";ctx.lineWidth=.55*DPR;const step=32*DPR;for(let x=(w%step)/2;x<w;x+=step){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=(h%step)/2;y<h;y+=step){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}ctx.restore();
      const horizon=ctx.createLinearGradient(0,0,w,0);horizon.addColorStop(0,"rgba(0,163,224,0)");horizon.addColorStop(.5,"rgba(0,163,224,.16)");horizon.addColorStop(1,"rgba(0,163,224,0)");ctx.fillStyle=horizon;ctx.fillRect(0,gridLayout.cy,w,Math.max(1,DPR));
    }

    function drawGridScene(t) {
      drawGridBackdrop(t);
      const order=[...MODEL].map(c=>({c,depth:gridProject(c.x-1,c.y-1,0).depth})).sort((a,b)=>a.depth-b.depth).map(o=>o.c);
      pickList=[];labelList=[];selectedAnchor=null;
      const labels=[];
      for(const c of order){
        const surge=tsunamiVisual(c,t);const extrusion=clamp(currentExtrusion(c,t)+surge.offset,-.235,.46);const px=gridExtrusionPixels(extrusion);const base=gridTileCorners(c.x-1,c.y-1,0);if(!base.every(finP))continue;
        drawGridTile(c,base,t,surge,px);
        let hit=[base.map(p=>[p.x,p.y])],face=base,labelPoint=gridProject(c.x-1,c.y-1,0);
        if(Math.abs(px)>=1.25){const polys=drawGridBar(c,px,surge,currentExtrusion(c,t));if(polys.length)hit=polys;face=gridTileCorners(c.x-1,c.y-1,px);labelPoint=gridProject(c.x-1,c.y-1,Math.max(0,px));}
        pickList.push({cell:c,poly:hit[0],polys:hit});labels.push({c,point:labelPoint,face,surge});
        if(c===selectedCell)selectedAnchor=labelPoint;
      }
      drawGridTsunami(t);
      for(const entry of labels)drawGridMetricLabel(entry.c,entry.point,entry.face,t,entry.surge);
      drawInspectorTrace(selectedAnchor,t);
    }

    function draw(t) {
      if (!container.isConnected) return;
      try {
        const dt = clamp(t - lastFrameAt, 0, 48);
        lastFrameAt = t;
        updateTsunami(t);
        updateLayout();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (viewMode === "grid") {
          drawGridScene(t);
        } else {
          if (view.autoRotate && !reduceMotion && !dragging && !hoverCell && !selectedCell && t - lastInteractionAt > 950) view.yaw += AUTO_SPEED * dt;
          selectedAnchor = null;
          drawBackdrop(t);
          drawPlatform(t);
          drawOrbitPass(t, false);
          drawTsunamiPass(t, false);
          drawCells(t, true);
          drawSphereBody(t);
          drawGridPass(false, true);
          drawGridPass(false, false);
          drawGridPass(true, true);
          drawGridPass(true, false);
          drawAxis();
          drawCells(t, false);
          drawTsunamiPass(t, true);
          drawOrbitPass(t, true);
          drawSelectedTrace(t);
          drawMetricLabels(t);
        }
      } catch (error) {
        if (!window.__gbfErrLogged) { window.__gbfErrLogged = true; console.warn("[Q2] dual-field frame skipped:", error && error.message); }
      } finally {
        if (!reduceMotion && container.isConnected) rafId = requestAnimationFrame(draw);
      }
    }

    /* inspector */
    const famLabel = (c) => c.family ? c.family.replace(/_/g, " ") : "";
    const effectiveMeta = (id) => { try { const src = (window.__clueMetricsMeta && window.__clueMetricsMeta.source) || "canonical"; if (src === "canonical") return null; const reg = window.__clueMetrics; return Array.isArray(reg) ? (reg.find((m) => m.id === id) || null) : null; } catch (e) { return null; } };
    function inspectorStateSignature(c, imported, name, definition, segs) {
      try {
        return JSON.stringify({
          projection: viewMode,
          aggregation: aggMode,
          id: c.measurementId,
          legacyId: c.legacyId,
          name,
          definition,
          imported: imported ? { id: imported.id, name: imported.name, definition: imported.definition, status: imported.status } : null,
          family: c.family,
          familyColor: c.familyColor,
          state: c.state,
          excluded: Boolean(c.excluded),
          positiveHeight: c.positiveHeight,
          negativeDepth: c.negativeDepth,
          netContribution: c.netContribution,
          confidence: c.confidence,
          coverage: c.coverage,
          freshness: c.freshness,
          contributionCount: c.contributionCount,
          segments: segs.map((s) => ({
            normalizedContribution: s.normalizedContribution,
            confidence: s.confidence,
            freshness: s.freshness,
            scopeId: s.scopeId,
            cycleId: s.cycleId,
            verdict: s.verdict,
            certified: s.certified,
            invalidated: s.invalidated,
            greatBookEntryId: s.greatBookEntryId,
            proofContractId: s.proofContractId,
            benchmarkRunId: s.benchmarkRunId,
            recordedAt: s.recordedAt,
            native: s.native ? {
              baseline: s.native.baseline,
              result: s.native.result,
              unit: s.native.unit,
              delta: s.native.delta,
            } : null,
          })),
        });
      } catch (error) {
        return `${viewMode}|${aggMode}|${c.measurementId}|${c.state}|${c.netContribution}|${segs.length}`;
      }
    }

    function renderInspector(c, switching = false) {
      if (!c) {
        if (inspectorSwitchTimer) clearTimeout(inspectorSwitchTimer);
        if (inspectorOpenRaf) cancelAnimationFrame(inspectorOpenRaf);
        inspectorSwitchTimer = null;
        inspectorOpenRaf = null;
        inspectorMetricId = null;
        inspectorSignature = "";
        insp.classList.remove("is-open", "is-switching");
        insp.setAttribute("aria-hidden", "true");
        return;
      }
      const fc = c.familyColor || (FAM[c.family] && FAM[c.family].color) || "#00a3e0";
      const imported = effectiveMeta(c.measurementId);
      const name = imported && imported.name ? imported.name : c.name;
      const definition = imported && imported.definition != null ? imported.definition : DEF[c.measurementId];
      const projectionLabel = viewMode === "sphere" ? "sphere sector" : "grid cell";
      const segs = c.segments || [];
      const nextSignature = inspectorStateSignature(c, imported, name, definition, segs);
      const metricChanged = inspectorMetricId !== c.measurementId;
      const contentChanged = inspectorSignature !== nextSignature;
      const wasOpen = insp.classList.contains("is-open");
      const previousScrollTop = !metricChanged && wasOpen ? insp.scrollTop : 0;

      if (contentChanged) {
        let h = `<div class="ih"><span class="id">${esc(c.measurementId)}</span><span class="x" data-close title="Close">✕</span></div><div class="co">${esc(c.legacyId || "")}${c.legacyId ? " · " : ""}${projectionLabel} ${c.x},${c.y}${imported ? ' · <span style="color:#c7b8ff">imported catalogue</span>' : ""}</div><div class="nm">${esc(name)}</div>`;
        if (definition) h += `<div class="def"><span class="dl">DEFINITION</span>${esc(definition)}</div>`;
        if (c.state === "reserved") { h += `<div class="note">Reserved catalogue coordinate — held for future expansion.</div>`; }
        if (!segs.length && c.state !== "reserved") {
          h += `<div class="bg"><span class="b" style="color:${fc};border-color:${fc}">${famLabel(c)}</span><span class="b" style="color:#5f7d99;border-color:#2a4456">not yet measured</span></div><div class="note">No Great Book contributions are recorded for this measure yet. The active projection remains at its neutral surface until admissible evidence creates a proven gain or evidenced regression.</div>`;
        }
        const net = c.netContribution;
        if (segs.length) {
          const staleBadge = c.state === "stale" ? `<span class="b" style="color:${fc};border-color:${fc};opacity:.7">stale evidence</span>` : "";
          const excludedBadge = c.excluded ? '<span class="b" style="color:#ffad73;border-color:rgba(255,85,0,.58)">excluded from cycle</span>' : "";
          const aggregationBadge = aggMode ? `<span class="b" style="color:#8fe6ff;border-color:#2a4456">${esc(aggMode.replace(/_/g, " "))}</span>` : "";
          h += `<div class="bg"><span class="b" style="color:${fc};border-color:${fc}">${famLabel(c)}</span>${staleBadge}${excludedBadge}${aggregationBadge}</div>${c.excluded ? '<div class="note" style="margin:-2px 0 10px;color:#d59c75">This measure remains inspectable, but its contribution is omitted from the active cycle projection.</div>' : ""}<div class="g2"><div><div class="k">Net contribution</div><div class="v" style="color:${net >= 0 ? "#39e08b" : "#ff7a3d"}">${num(net, true)}</div></div><div><div class="k">Contributions</div><div class="v">${c.contributionCount}</div></div><div><div class="k">Positive height</div><div class="v up">${num(c.positiveHeight, true)}</div></div><div><div class="k">Negative depth</div><div class="v dn">${num(c.negativeDepth)}</div></div><div><div class="k">Confidence</div><div class="v">${c.confidence ?? "—"}</div></div><div><div class="k">Coverage</div><div class="v">${c.coverage ?? "—"}</div></div><div><div class="k">Freshness</div><div class="v">${c.freshness ?? "—"}</div></div></div><div class="st">GREAT BOOK ENTRIES (${segs.length})</div>`;
          for (const s of segs) {
            const good = (s.normalizedContribution ?? 0) >= 0;
            const borderColor = s.invalidated ? "#ff5500" : (good ? fc : "#ff7a3d");
            const verdictColor = s.invalidated ? "#ff7a3d" : (s.certified === false ? "#ffd166" : (good ? "#39e08b" : "#ff7a3d"));
            const native = s.native || {};
            h += `<div class="seg" style="border-left-color:${borderColor}"><div class="nat">${esc(String(native.baseline))}<span class="ar">→</span>${esc(String(native.result))} <span style="color:#5f7d99">${esc(native.unit || "")}</span>${native.delta != null ? ` <span style="color:#5f7d99">Δ ${native.delta > 0 ? "+" : ""}${esc(String(native.delta))}</span>` : ""}</div><div class="l2">norm <b style="color:${good ? "#39e08b" : "#ff7a3d"}">${s.normalizedContribution > 0 ? "+" : ""}${esc(String(s.normalizedContribution))}</b>${s.confidence != null ? ` · conf ${esc(String(s.confidence))}` : ""}${s.freshness != null ? ` · fresh ${esc(String(s.freshness))}` : ""}${s.scopeId ? ` · ${esc(s.scopeId)}` : ""}${s.cycleId ? ` · ${esc(s.cycleId)}` : ""}</div>${s.verdict ? `<div class="vd" style="color:${verdictColor}">${esc(s.verdict)}</div>` : ""}<div class="ids">${esc(s.greatBookEntryId || "")}${s.proofContractId ? " · " + esc(s.proofContractId) : ""}${s.benchmarkRunId ? " · " + esc(s.benchmarkRunId) : ""}${s.recordedAt ? " · " + esc(String(s.recordedAt).slice(0, 10)) : ""}</div></div>`;
          }
        }
        insp.style.setProperty("--gbf-accent", fc);
        insp.innerHTML = h;
        inspectorMetricId = c.measurementId;
        inspectorSignature = nextSignature;
        if (previousScrollTop > 0) {
          requestAnimationFrame(() => {
            if (inspectorMetricId === c.measurementId && insp.classList.contains("is-open")) insp.scrollTop = previousScrollTop;
          });
        }
      } else {
        insp.style.setProperty("--gbf-accent", fc);
      }

      insp.setAttribute("aria-hidden", "false");
      if (!wasOpen) {
        if (inspectorOpenRaf) cancelAnimationFrame(inspectorOpenRaf);
        inspectorOpenRaf = requestAnimationFrame(() => {
          inspectorOpenRaf = null;
          if (selectedCell && selectedCell.measurementId === c.measurementId && insp.isConnected) insp.classList.add("is-open");
        });
      } else if (metricChanged || switching) {
        if (inspectorSwitchTimer) clearTimeout(inspectorSwitchTimer);
        insp.classList.remove("is-switching");
        void insp.offsetWidth;
        insp.classList.add("is-switching");
        inspectorSwitchTimer = setTimeout(() => {
          inspectorSwitchTimer = null;
          insp.classList.remove("is-switching");
        }, 380);
      }
    }

    insp.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.hasAttribute && target.hasAttribute("data-close")) {
        selectedCell = null;
        selectionStartedAt = 0;
        renderInspector(null);
        updateLayout();
        lastInteractionAt = now();
        if (reduceMotion) draw(now());
      }
    });

    const FAMILY_LEGEND = { TARGET_QUALITY: "Target Quality", EVIDENCE_ASSURANCE: "Evidence & Assurance", ACCEPTANCE_GATES: "Acceptance Gates", CLUE_SELF: "CLU-E Self" };
    function renderLegend() {
      let html = `<div class="lt">FAMILIES · ${viewMode === "sphere" ? "radial" : "planar"} net contribution</div>`;
      for (const family of ["TARGET_QUALITY", "EVIDENCE_ASSURANCE", "ACCEPTANCE_GATES", "CLUE_SELF"]) {
        const cells = MODEL.filter((c) => c.family === family && !c.excluded);
        const active = cells.some((c) => c.netContribution != null);
        const net = cells.reduce((sum, c) => sum + (c.netContribution || 0), 0);
        const color = FAM[family]?.color || "#00a3e0";
        html += `<div class="lr"><span class="sw" style="color:${color};background:${color}"></span><span class="ln">${FAMILY_LEGEND[family]}</span><span class="lv">${active ? (net >= 0 ? "+" : "") + Math.round(net) : "—"}</span></div>`;
      }
      legend.innerHTML = html;
    }

    function renderHud() {
      const stats = fieldStats();
      const netClass = !stats.active ? "hot" : stats.net >= 0 ? "up" : "dn";
      hud.innerHTML = `<div class="ht"><span class="orb"></span><span>${viewMode === "sphere" ? "SPHERICAL" : "GRID"} IMPROVEMENT FIELD</span></div><div class="hs"><span>catalogue surface</span><b>${MODEL.filter((c) => c.state !== "reserved").length} / ${MODEL.length}</b><span>proven active</span><b>${stats.active}</b><span>net contribution</span><b class="${netClass}">${stats.active ? (stats.net >= 0 ? "+" : "") + Math.round(stats.net) : "—"}</b><span>excluded</span><b>${stats.excluded}</b><span>aggregation</span><b>${esc((aggMode || "unaggregated").replace(/_/g, " "))}</b></div>`;
    }

    function inPolygon(px, py, polygonPoints) {
      let inside = false;
      for (let i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i++) {
        const xi = polygonPoints[i][0], yi = polygonPoints[i][1], xj = polygonPoints[j][0], yj = polygonPoints[j][1];
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
      }
      return inside;
    }

    function pickAt(mx, my) {
      for (let i = pickList.length - 1; i >= 0; i -= 1) {
        const polygons = Array.isArray(pickList[i].polys) ? pickList[i].polys : [pickList[i].poly];
        for (const polygonPoints of polygons) {
          if (polygonPoints && inPolygon(mx, my, polygonPoints)) return pickList[i].cell;
        }
      }
      return null;
    }

    function select(c) {
      selectedCell = c && c.state !== "reserved" ? c : null;
      selectionStartedAt = selectedCell ? now() : 0;
      renderInspector(selectedCell);
      updateLayout();
      try { container.dispatchEvent(new CustomEvent("gbf-cell-select", { detail: selectedCell ? selectedCell.measurementId : null })); } catch (e) {}
      lastInteractionAt = now();
      if (reduceMotion) draw(now());
    }

    function showTooltip(c, clientX, clientY) {
      if (!c || c.state === "reserved") { tip.style.display = "none"; return; }
      const rect = canvas.getBoundingClientRect();
      const value = measured(c) ? c.netContribution : null;
      const color = c.familyColor || "#00a3e0";
      tip.style.display = "block";
      tip.style.left = `${clientX - rect.left}px`;
      tip.style.top = `${clientY - rect.top}px`;
      tip.innerHTML = `<span class="mi">${c.measurementId}</span> ${esc((effectiveMeta(c.measurementId) || {}).name || c.name)} · <span class="fam" style="color:${color}">${esc(FAMILY_LEGEND[c.family] || c.family)}</span>${c.excluded ? ' · <span style="color:#ffad73">excluded from cycle</span>' : value != null ? ` · <b class="${value >= 0 ? "up" : "dn"}">${value >= 0 ? "+" : ""}${value}</b>` : ` · <span class="muted">${c.state === "unknown" ? "not yet measured" : esc(c.state)}</span>`}`;
    }

    function resetView() {
      if (viewMode === "grid") {
        gridView.yaw = GRID_DEF_YAW; gridView.pitch = GRID_DEF_PITCH; gridView.userZoom = 1; gridView.panX = 0; gridView.panY = 0;
      } else {
        view.yaw = DEF_YAW; view.pitch = DEF_PITCH; view.userZoom = 1; view.panX = 0; view.panY = 0;
      }
      lastInteractionAt = now(); updateLayout(); if (reduceMotion) draw(now());
    }

    function toggleAuto() {
      view.autoRotate = !view.autoRotate;
      lastInteractionAt = now() - 1200;
      updateControlUi();
      if (reduceMotion) draw(now());
    }

    autoButton.addEventListener("click", toggleAuto);
    resetButton.addEventListener("click", resetView);
    gridModeButton.addEventListener("click", () => setViewMode("grid"));
    sphereModeButton.addEventListener("click", () => setViewMode("sphere"));

    canvas.addEventListener("pointerdown", (event) => {
      if (activePointerId != null) return;
      activePointerId = event.pointerId;
      canvas.setPointerCapture?.(event.pointerId);
      downX = lastX = event.clientX; downY = lastY = event.clientY;
      dragging = event.shiftKey ? "pan" : "rotate";
      canvas.classList.add("is-dragging");
      tip.style.display = "none";
      lastInteractionAt = now();
      event.preventDefault();
    });

    canvas.addEventListener("pointermove", (event) => {
      if (dragging && event.pointerId === activePointerId) {
        const dx = event.clientX - lastX, dy = event.clientY - lastY;
        lastX = event.clientX; lastY = event.clientY;
        if (dragging === "rotate") {
          if (viewMode === "grid") {
            gridView.yaw += dx * 0.010;
            gridView.pitch = clamp(gridView.pitch - dy * 0.0045, 0.12, 0.96);
          } else {
            view.yaw += dx * 0.0085;
            view.pitch = clamp(view.pitch + dy * 0.0065, -1.08, 1.08);
          }
        } else if (viewMode === "grid") {
          gridView.panX += dx; gridView.panY += dy;
        } else {
          view.panX += dx; view.panY += dy;
        }
        hoverCell = null;
        lastInteractionAt = now();
        updateLayout();
        if (reduceMotion) draw(now());
        event.preventDefault();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const c = pickAt((event.clientX - rect.left) * DPR, (event.clientY - rect.top) * DPR);
      hoverCell = c;
      showTooltip(c, event.clientX, event.clientY);
      if (reduceMotion) draw(now());
    });

    function finishPointer(event) {
      if (event.pointerId !== activePointerId) return;
      const moved = Math.hypot(event.clientX - downX, event.clientY - downY) > 5;
      if (!moved && dragging === "rotate") {
        const rect = canvas.getBoundingClientRect();
        select(pickAt((event.clientX - rect.left) * DPR, (event.clientY - rect.top) * DPR));
      }
      try { canvas.releasePointerCapture?.(event.pointerId); } catch (e) {}
      activePointerId = null;
      dragging = null;
      canvas.classList.remove("is-dragging");
      lastInteractionAt = now();
    }
    canvas.addEventListener("pointerup", finishPointer);
    canvas.addEventListener("pointercancel", finishPointer);
    canvas.addEventListener("pointerleave", () => { if (!dragging) { hoverCell = null; tip.style.display = "none"; if (reduceMotion) draw(now()); } });

    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const activeView = viewMode === "grid" ? gridView : view;
      const minZoom = viewMode === "grid" ? 0.20 : 0.48;
      const maxZoom = viewMode === "grid" ? 8.0 : 4.2;
      const oldZoom = activeView.userZoom;
      activeView.userZoom = clamp(activeView.userZoom * (event.deltaY < 0 ? 1.11 : 0.901), minZoom, maxZoom);
      const ratio = activeView.userZoom / oldZoom;
      const centerCssX = (viewMode === "grid" ? gridLayout.cx : layout.cx) / DPR;
      const centerCssY = (viewMode === "grid" ? gridLayout.cy : layout.cy) / DPR;
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      activeView.panX += (cursorX - centerCssX) * (1 - ratio);
      activeView.panY += (cursorY - centerCssY) * (1 - ratio);
      lastInteractionAt = now();
      updateLayout();
      if (reduceMotion) draw(now());
    }, { passive: false });

    canvas.addEventListener("dblclick", (event) => { event.preventDefault(); resetView(); });

    canvas.addEventListener("keydown", (event) => {
      let handled = true;
      const panStep = 22, orbitStep = viewMode === "grid" ? 0.09 : 0.10, pitchStep = viewMode === "grid" ? 0.055 : 0.07;
      const activeView = viewMode === "grid" ? gridView : view;
      if (event.shiftKey && event.key === "ArrowLeft") activeView.panX -= panStep;
      else if (event.shiftKey && event.key === "ArrowRight") activeView.panX += panStep;
      else if (event.shiftKey && event.key === "ArrowUp") activeView.panY -= panStep;
      else if (event.shiftKey && event.key === "ArrowDown") activeView.panY += panStep;
      else if (event.key === "ArrowLeft") activeView.yaw -= orbitStep;
      else if (event.key === "ArrowRight") activeView.yaw += orbitStep;
      else if (event.key === "ArrowUp") activeView.pitch = viewMode === "grid" ? clamp(activeView.pitch + pitchStep, .12, .96) : clamp(activeView.pitch - pitchStep, -1.08, 1.08);
      else if (event.key === "ArrowDown") activeView.pitch = viewMode === "grid" ? clamp(activeView.pitch - pitchStep, .12, .96) : clamp(activeView.pitch + pitchStep, -1.08, 1.08);
      else if (event.key === "+" || event.key === "=") activeView.userZoom = clamp(activeView.userZoom * 1.11, viewMode === "grid" ? .20 : .48, viewMode === "grid" ? 8 : 4.2);
      else if (event.key === "-") activeView.userZoom = clamp(activeView.userZoom * .901, viewMode === "grid" ? .20 : .48, viewMode === "grid" ? 8 : 4.2);
      else if (event.key === "0" || event.key === "Home") resetView();
      else if ((event.key === " " || event.code === "Space") && viewMode === "sphere") toggleAuto();
      else if (event.key === "v" || event.key === "V") setViewMode(viewMode === "sphere" ? "grid" : "sphere");
      else if (event.key === "Enter" && hoverCell) select(hoverCell);
      else handled = false;
      if (handled) { event.preventDefault(); lastInteractionAt = now(); updateLayout(); if (reduceMotion) draw(now()); }
    });

    resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    if (resizeObserver) resizeObserver.observe(container); else window.addEventListener("resize", resize);

    function setProjection(value) {
      try { window.__q2LastView = value; } catch (e) {}
      const t = now();
      const previous = captureExtrusions(t);
      const wasEmpty = MODEL.every((c) => !measured(c));
      aggMode = value && value.aggregationMode || "";
      MODEL = modelFromView(value);
      applyExcluded();
      renderLegend();
      renderHud();
      if (selectedCell) {
        const keep = MODEL.find((c) => c.measurementId === selectedCell.measurementId);
        selectedCell = keep || null;
        if (!selectedCell) selectionStartedAt = 0;
        renderInspector(selectedCell);
      }
      retarget(wasEmpty ? "back" : "smooth", previous);
      updateLayout();
      if (reduceMotion) draw(now());
    }

    function selectCell(id) {
      const cell = MODEL.find((c) => c.measurementId === id) || null;
      if (cell && viewMode === "sphere") {
        const bounds = cellAngularBounds(cell);
        view.yaw = -bounds.lonCenter;
        view.pitch = clamp(bounds.latCenter, -0.86, 0.86);
      }
      select(cell);
      return selectedCell;
    }

    function setExcluded(list) {
      const previous = captureExtrusions(now());
      EXCLUDED = new Set(list || []);
      applyExcluded();
      renderLegend(); renderHud();
      try { window.__q2Excluded = [...EXCLUDED]; } catch (e) {}
      retarget("smooth", previous);
      if (selectedCell) renderInspector(selectedCell);
      try { container.dispatchEvent(new CustomEvent("gbf-exclusions-change", { detail: [...EXCLUDED] })); } catch (e) {}
      if (reduceMotion) draw(now());
    }

    function getExcluded() { return [...EXCLUDED]; }
    function refresh() { renderLegend(); renderHud(); if (selectedCell) renderInspector(selectedCell); if (reduceMotion) draw(now()); }
    function setAutoRotate(value) { view.autoRotate = Boolean(value) && !reduceMotion; updateControlUi(); lastInteractionAt = now() - 1200; if (reduceMotion) draw(now()); return view.autoRotate; }
    function triggerTsunami() { return beginTsunami(now()); }
    function getAnimationState() { return { projection: viewMode, autoRotate: view.autoRotate, selectedMetricId: selectedCell?.measurementId || null, tsunamiActive: Boolean(tsunami), tsunamiSequence, nextTsunamiAt }; }
    function getViewMode() { return viewMode; }
    function toggleViewMode() { return setViewMode(viewMode === "sphere" ? "grid" : "sphere"); }
    function remove() {
      try { if (rafId) cancelAnimationFrame(rafId); } catch (e) {}
      try { if (inspectorOpenRaf) cancelAnimationFrame(inspectorOpenRaf); } catch (e) {}
      try { if (inspectorSwitchTimer) clearTimeout(inspectorSwitchTimer); } catch (e) {}
      inspectorOpenRaf = null;
      inspectorSwitchTimer = null;
      try { if (resizeObserver) resizeObserver.disconnect(); else window.removeEventListener("resize", resize); } catch (e) {}
      tsunami = null;
      hud.classList.remove("is-surge");
      try { canvas.remove(); tip.remove(); insp.remove(); hud.remove(); legend.remove(); controls.remove(); hint.remove(); modeFlash.remove(); modeSwitch.remove(); } catch (e) {}
      container.classList.remove("gbf-field-host");
    }

    applyExcluded();
    retarget("back");
    renderLegend();
    renderHud();
    updateControlUi();
    renderInspector(null);
    resize();
    scheduleNextTsunami(now(), true);
    if (!reduceMotion) rafId = requestAnimationFrame(draw);

    return { setProjection, selectCell, setExcluded, getExcluded, refresh, setAutoRotate, triggerTsunami, getAnimationState, setViewMode, getViewMode, toggleViewMode, remove };
  }

  /* ---- bring-up (isolated) ---- */
  try {
    injectStyle();
    const body = document.querySelector('#q2 .body');
    if (!body) {
      ClueInterface.setPanelState('q2', 'unavailable', 'FIELD HOST MISSING');
      console.warn('[Q2] container not found');
      return;
    }
    body.innerHTML = '';
    body.style.position = 'relative';
    const fieldCore = mountField(body);
    let unsubscribe = () => {};
    const field = {
      ...fieldCore,
      remove() {
        unsubscribe();
        fieldCore.remove();
      },
    };
    window.__q2Field = field;
    const foot = $('q2foot');
    if (foot) { foot.textContent = ''; foot.style.display = 'none'; }

    const setFoot = (view) => {
      if (foot) foot.textContent = '';
      // DEV-P1-16: what the panel may claim — including that "all excluded" is never reported
      // as "awaiting proof" — is decided in quadrants/q2Field.js.
      const decision = q2PanelDecision(view, new Set(field.getExcluded?.() ?? []));
      ClueInterface.setPanelState('q2', decision.state, decision.label);
      if (decision.pulse) ClueInterface.pulse('q2');
    };

    fetchJson('/api/improvement-field').then((data) => {
      const view = data?.improvementField;
      if (view) field.setProjection(view);
      setFoot(view ?? null);
    }).catch((error) => {
      setFoot(null);
      ClueInterface.setPanelState('q2', 'warning', 'FIELD REGISTRY UNAVAILABLE');
      console.warn('[Q2] initial improvement field unavailable:', error.message);
    });

    body.addEventListener('gbf-exclusions-change', () => setFoot(window.__q2LastView ?? null));
    body.addEventListener('gbf-view-mode-change', () => setFoot(window.__q2LastView ?? null));

    unsubscribe = ConsoleFrameBus.subscribe((frame) => {
      const view = frame?.snapshot?.dashboard?.improvementField;
      if (!view) return;
      field.setProjection(view);
      setFoot(view);
    });
  } catch (error) {
    ClueInterface.setPanelState('q2', 'unavailable', 'FIELD UNAVAILABLE');
    console.error('[Q2] dual improvement field bring-up failed (dashboard continues):', error);
  }
})();


/* ======================= Q3 INSTRUMENT CLUSTER (inline) ====================
 * Four truth-preserving instruments now inhabit one dimensional holographic bay:
 * extruded optical-black pods, perspective deck, live data conduits, parallax, hover
 * lift, click-to-hold cinematic focus and infrequent sealed-bus sweeps. External
 * planetary orbit arcs and secondary visualization frames are intentionally absent.
 * Canvas-2D remains the crisp authoritative layer; WebGPU contributes
 * bloom only and silently degrades. Isolated IIFE + try/catch means Q3 can never take
 * the rest of the operational console down.
 *
 * The four measurement areas (each gauge = the area's most unified value; the
 * frameless visual beneath carries that area's dedicated sub-visualization):
 *   A · AI UTILIZATION   (cyan)   — session/call telemetry, provider-owned billing
 *       state and observed token usage. CLU-E does not administer the OpenAI budget and
 *       never derives a fictitious token balance from money. A provider funding refusal
 *       becomes the explicit LACK OF $ controlled-pause state; remaining tokens appear
 *       only when the provider supplies an authoritative allowance.
 *       Its lower visual is LIVE: the CALL STREAMGRAPH — a wiggle-baseline river of
 *       per-tick outcomes (ok / cache / retry / fail) built from counter deltas.
 *   B · CYCLE PROGRESS   (amber)  — weighted completion across the five real
 *       phases (recognition → deep review → proven improvement → certification →
 *       test maturity), cycle counter, next-milestone text. Its lower visual is LIVE:
 *       the PHASE RING — a segmented radial dial with a comet on the active phase.
 *   C · OVERALL IMPROVEMENT (green) — center-zero dial: mean net contribution per
 *       active measure from the Q2 Great Book field; LCD shows total net; empty
 *       until proven evidence lands (never fabricated). Its lower visual is LIVE: the
 *       GAINS CASCADE — a waterfall of contributions building to Σ net, with
 *       concrete native-outcome chips (deps/ms/MB/fps saved).
 *   D · CLU-E HEALTH     (violet) — composite self-integrity: state-seal
 *       consistency, pipeline failures, dropped console events, custody/sessions.
 *       Its lower visual is LIVE: the VITALS MONITOR — a multi-parameter patient monitor
 *       (ECG/resp/SpO2-pleth/capno) with per-lane readouts + a composite heart rate
 *       that races as health falls; flatline NO SIGNAL where unknown; alarm on crit.
 *
 * Data: /api/frame once + every console-events SSE frame (snapshot.dashboard).
 * window.__q3Cluster = { setTelemetry, getState, remove } is exposed so a data
 * probe can feed this cluster directly.
 * ======================================================================== */
(function initQ3Cluster() {
  const AREAS = [
    { key:'ai',     tag:'A', label:'AI UTILIZATION',    sub:'CALL STREAMGRAPH', color:'#00d9ff', dial:'0-100', unit:'%',   redline:0.85 },
    { key:'cycle',  tag:'B', label:'CYCLE PROGRESS',    sub:'PHASE RING',       color:'#f4af2d', dial:'0-100', unit:'%',   redline:null },
    { key:'gain',   tag:'C', label:'OVERALL IMPROVEMENT',sub:'GAINS CASCADE',   color:'#39ff88', dial:'center',unit:'net', redline:null },
    { key:'health', tag:'D', label:'CLU-E HEALTH',      sub:'VITALS MONITOR',   color:'#c77dff', dial:'0-100', unit:'',    redline:0.30 }
  ];
  const esc3 = (s) => String(s==null?"":s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const fin3 = (v) => Number.isFinite(v);
  const clamp3 = (v,a,b)=>v<a?a:v>b?b:v;
  const fmtK = (n)=>{ if(!fin3(n)) return '—'; const a=Math.abs(n); if(a>=1e6) return (n/1e6).toFixed(1)+'M'; if(a>=1e4) return (n/1e3).toFixed(1)+'k'; return String(Math.round(n)); };
  const fmtDelta = (v)=>{ if(!fin3(v)) return '—'; const s=v<0?'−':'+'; const a=Math.abs(v); return s+(a>=100?fmtK(a):(a>=10?a.toFixed(0):a.toFixed(1))); };
  const excludedMeasureIds = () => {
    try {
      const direct = window.__q2Field?.getExcluded?.();
      if (Array.isArray(direct)) return new Set(direct.map(String));
      const raw = window.localStorage?.getItem('clue.excluded');
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch (e) { return new Set(); }
  };

  /* ---------------- telemetry derivation (real frame → 4 areas) ----------- */
  /* ---------------- telemetry derivation (real frame → 4 areas) ----------- */
  // DEV-P1-16: moved verbatim to quadrants/q3Gauges.js, where it can be tested. Its honest
  // absence rules — a flatline where a signal is genuinely missing, never a fabricated pulse
  // — were a comment above a calculation and are now assertions.

  function injectStyle3() {
    if (document.getElementById('q3g-style')) return;
    const st = document.createElement('style'); st.id = 'q3g-style';
    st.textContent = `
.q3g-canvas{position:absolute;inset:0;display:block;width:100%;height:100%;cursor:crosshair;touch-action:none;outline:none;transform:translateZ(0);backface-visibility:hidden}
.q3g-canvas:focus-visible{outline:1px solid rgba(191,241,255,.58);outline-offset:-3px}
.q3g-tip{--q3-tip-accent:#00d9ff;position:absolute;z-index:12;pointer-events:none;display:none;max-width:min(390px,78vw);padding:9px 11px;font:10px/1.52 ui-monospace,Consolas,monospace;color:#def5ff;background:linear-gradient(145deg,rgba(8,22,36,.985),rgba(2,9,16,.975));border:1px solid color-mix(in srgb,var(--q3-tip-accent) 42%,rgba(111,202,241,.24));border-radius:4px;white-space:nowrap;transform:translate(-50%,-116%) translateZ(0);box-shadow:0 18px 46px rgba(0,0,0,.64),0 0 24px color-mix(in srgb,var(--q3-tip-accent) 10%,transparent),inset 0 1px rgba(255,255,255,.05);backdrop-filter:blur(15px) saturate(128%);clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);backface-visibility:hidden}
.q3g-tip::before{content:"";position:absolute;left:0;top:0;width:54%;height:1px;background:linear-gradient(90deg,var(--q3-tip-accent),transparent);box-shadow:0 0 12px color-mix(in srgb,var(--q3-tip-accent) 58%,transparent)}
.q3g-tip .t{color:#f4fdff;font-weight:800;text-shadow:0 0 10px color-mix(in srgb,var(--q3-tip-accent) 58%,transparent)}.q3g-tip .k{color:#68869c}
.q3g-foot{display:none!important}
.q3g-foot::before{display:none!important}
#q3:fullscreen .q3g-foot,#q3.clue-soft-fullscreen .q3g-foot{display:none!important}
@media(prefers-reduced-motion:reduce){.q3g-tip{backdrop-filter:none}}`;
    document.head.appendChild(st);
  }

  /* ------------------------------ WebGPU bloom ---------------------------- */
  async function initBloom(overlay, srcCanvas) {
    if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter(); if (!adapter) return null;
    const device = await adapter.requestDevice(); if (!device) return null;
    const gctx = overlay.getContext('webgpu'); if (!gctx) return null;
    const format = navigator.gpu.getPreferredCanvasFormat();
    gctx.configure({ device, format, alphaMode: 'premultiplied' });
    const VS = `struct VSOut{@builtin(position) pos:vec4f, @location(0) uv:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->VSOut{var p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));var o:VSOut;o.pos=vec4f(p[i],0.,1.);o.uv=vec2f((p[i].x+1.)*.5,1.-(p[i].y+1.)*.5);return o;}`;
    const mk = (fs) => device.createShaderModule({ code: VS + '\n' + fs });
    const smTh = mk(`@group(0)@binding(0) var sm:sampler;@group(0)@binding(1) var tx:texture_2d<f32>;
@fragment fn fs(in:VSOut)->@location(0) vec4f{let c=textureSample(tx,sm,in.uv).rgb;let l=dot(c,vec3f(.299,.587,.114));let k=max(l-.52,0.)*2.1;return vec4f(c*k,1.);}`);
    const smBl = mk(`@group(0)@binding(0) var sm:sampler;@group(0)@binding(1) var tx:texture_2d<f32>;@group(0)@binding(2) var<uniform> u:vec4f;
@fragment fn fs(in:VSOut)->@location(0) vec4f{var acc=vec3f(0.);let w=array<f32,5>(.227,.194,.121,.054,.016);acc+=textureSample(tx,sm,in.uv).rgb*w[0];
for(var i=1;i<5;i++){let o=u.xy*f32(i);acc+=textureSample(tx,sm,in.uv+o).rgb*w[i];acc+=textureSample(tx,sm,in.uv-o).rgb*w[i];}return vec4f(acc,1.);}`);
    const smOut = mk(`@group(0)@binding(0) var sm:sampler;@group(0)@binding(1) var tx:texture_2d<f32>;
@fragment fn fs(in:VSOut)->@location(0) vec4f{let b=textureSample(tx,sm,in.uv).rgb*1.15;let a=clamp(max(max(b.r,b.g),b.b),0.,1.);return vec4f(b,a);}`);
    const sampler = device.createSampler({ magFilter:'linear', minFilter:'linear' });
    const pipe = (mod, blend) => device.createRenderPipeline({ layout:'auto',
      vertex:{ module: mod, entryPoint:'vs' },
      fragment:{ module: mod, entryPoint:'fs', targets:[ blend? { format, blend:{ color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}, alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'} } } : { format:'rgba8unorm' } ] },
      primitive:{ topology:'triangle-list' } });
    const pTh = pipe(smTh,false), pBl = pipe(smBl,false), pOut = pipe(smOut,true);
    const ubuf = device.createBuffer({ size:16, usage: GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST });
    let W=0,H=0,src=null,ta=null,tb=null;
    const mkTex=(w,h)=>device.createTexture({size:[w,h],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST});
    function ensure(w,h){ if(w===W&&h===H&&src)return; W=w;H=h;
      try{src&&src.destroy();ta&&ta.destroy();tb&&tb.destroy();}catch(e){}
      src=mkTex(w,h); const hw=Math.max(2,w>>1), hh=Math.max(2,h>>1); ta=mkTex(hw,hh); tb=mkTex(hw,hh); }
    function frame(){
      const w=srcCanvas.width, h=srcCanvas.height; if(!(w>0&&h>0)) return;
      ensure(w,h);
      device.queue.copyExternalImageToTexture({ source: srcCanvas }, { texture: src }, [w,h]);
      const hw=Math.max(2,w>>1), hh=Math.max(2,h>>1);
      const enc=device.createCommandEncoder();
      const pass=(pl,dstView,binds)=>{ const rp=enc.beginRenderPass({colorAttachments:[{view:dstView,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]}); rp.setPipeline(pl);
        rp.setBindGroup(0,device.createBindGroup({layout:pl.getBindGroupLayout(0),entries:binds})); rp.draw(3); rp.end(); };
      pass(pTh, ta.createView(), [{binding:0,resource:sampler},{binding:1,resource:src.createView()}]);
      device.queue.writeBuffer(ubuf,0,new Float32Array([1.6/hw,0,0,0]));
      pass(pBl, tb.createView(), [{binding:0,resource:sampler},{binding:1,resource:ta.createView()},{binding:2,resource:{buffer:ubuf}}]);
      device.queue.writeBuffer(ubuf,0,new Float32Array([0,1.6/hh,0,0]));
      pass(pBl, ta.createView(), [{binding:0,resource:sampler},{binding:1,resource:tb.createView()},{binding:2,resource:{buffer:ubuf}}]);
      pass(pOut, gctx.getCurrentTexture().createView(), [{binding:0,resource:sampler},{binding:1,resource:ta.createView()}]);
      device.queue.submit([enc.finish()]);
    }
    function destroy(){ try{src&&src.destroy();ta&&ta.destroy();tb&&tb.destroy();device.destroy&&device.destroy();}catch(e){} }
    return { frame, destroy };
  }

  /* ------------------------------- the cluster ---------------------------- */
  function mountCluster(container) {
    const reduceMotion = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || false;
    const now = () => (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
    const base = document.createElement('canvas');
    base.className = 'q3g-canvas';
    base.tabIndex = 0;
    base.setAttribute('role', 'application');
    base.setAttribute('aria-label', 'Four dimensional CLU-E mission instruments: AI utilization, cycle progress, proven improvement and system health. Move the pointer for parallax, hover for exact telemetry, click an instrument to hold cinematic focus, and press Escape to release it.');
    container.appendChild(base);
    const overlay = document.createElement('canvas');
    overlay.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none;z-index:2;';
    container.appendChild(overlay);
    const tip = document.createElement('div'); tip.className='q3g-tip'; container.appendChild(tip);
    const foot = document.createElement('div'); foot.className='q3g-foot'; foot.textContent=''; foot.style.display='none'; container.appendChild(foot);
    const ctx = base.getContext('2d');
    let DPR = Math.min(window.devicePixelRatio||1, 2);

    const G = AREAS.map((a,index) => ({
      a,index,pos:0,vel:0,target:0,hasData:false,state:null,trail:[],geo:null,baseGeo:null,
      lift:0,liftVel:0,signal:0,telemetrySignature:'',floatPhase:index*1.731+0.42,
    }));
    G[0].series = []; G[0].lastRaw = null; G[0].lastPush = 0; G[0].emaMax = 3;   // A · call-stream ring buffer (counter deltas only)
    const scene = {
      x:0,y:0,targetX:0,targetY:0,hover:-1,focus:-1,
      waveStart:-Infinity,waveSequence:0,nextWaveAt:now()+9000,
    };
    let bloom = null;
    initBloom(overlay, base).then(b => { bloom = b; if(!b) overlay.remove(); }).catch(()=>{ try{overlay.remove();}catch(e){} });

    const SWEEP_A = -Math.PI*7/6, SWEEP_B = Math.PI/6;          // −210° … +30°
    const angAt = (f)=>SWEEP_A + (SWEEP_B-SWEEP_A)*clamp3(f,0,1);
    const frac = (g)=> g.a.dial==='center' ? (clamp3(g.pos,-100,100)+100)/200 : clamp3(g.pos,0,100)/100;

    function layout() {
      const w = base.width, h = base.height;
      const n = G.length, colW = w/n;
      const topPad = Math.max(13*DPR, h*0.045);
      const bottomPad = Math.max(19*DPR, h*0.052);
      for (let i=0;i<n;i++){
        const inset = Math.max(5*DPR, Math.min(11*DPR, colW*0.034));
        const pod = { x: colW*i + inset, y: topPad, w: colW - inset*2, h: Math.max(70*DPR, h-topPad-bottomPad) };
        const cx = colW*i + colW/2;
        const r = Math.max(25*DPR, Math.min(colW*0.355, h*0.255));
        const cy = Math.max(topPad+r*1.10, h*0.335);
        const panelY = Math.max(cy+r*0.78, h*0.655);
        const panelBottom = pod.y+pod.h-9*DPR;
        const panel = { x: colW*i + 8*DPR, y: panelY, w: colW - 16*DPR, h: Math.max(22*DPR, panelBottom-panelY) };
        G[i].baseGeo = { cx,cy,r,panel,pod,colW };
        prepareGeometry(G[i], now());
      }
    }
    function resize(){ if(!container.isConnected)return; const rc=container.getBoundingClientRect(); DPR=Math.min(window.devicePixelRatio||1,2);
      base.width=Math.max(240,Math.floor(rc.width*DPR)); base.height=Math.max(140,Math.floor(rc.height*DPR));
      overlay.width=base.width; overlay.height=base.height; layout(); if(reduceMotion) draw(); }

    const hex2rgb3=h=>{const n=parseInt(h.slice(1),16);return[n>>16&255,n>>8&255,n&255];};
    const rgba3=(h,a)=>{const[r,g,b]=hex2rgb3(h);return`rgba(${r},${g},${b},${a})`;};
    const rgbaA=(c,al)=>`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${al})`;
    const lerpRGB=(h1,h2,tt)=>{const p=hex2rgb3(h1),q=hex2rgb3(h2);return [p[0]+(q[0]-p[0])*tt,p[1]+(q[1]-p[1])*tt,p[2]+(q[2]-p[2])*tt];};

    const hash3 = (n) => { const x=Math.sin(n*91.733+17.17)*43758.5453123; return x-Math.floor(x); };
    const q3Stars = Array.from({length:150},(_,i)=>({
      x:hash3(i*3.11),y:hash3(i*5.37+2),r:0.35+hash3(i*7.91+4)*1.15,
      a:0.07+hash3(i*11.27+9)*0.34,p:hash3(i*13.71+11)*Math.PI*2,
    }));

    function polygon3(points,fill,stroke,lineWidth=1){
      if(!points||!points.length)return;
      ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);
      for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);
      ctx.closePath();
      if(fill){ctx.fillStyle=fill;ctx.fill();}
      if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lineWidth*DPR;ctx.stroke();}
    }
    function chamferPath3(x,y,w,h,c){
      const cut=Math.max(0,Math.min(c,Math.abs(w)/2,Math.abs(h)/2));
      ctx.beginPath();ctx.moveTo(x+cut,y);ctx.lineTo(x+w-cut,y);ctx.lineTo(x+w,y+cut);
      ctx.lineTo(x+w,y+h-cut);ctx.lineTo(x+w-cut,y+h);ctx.lineTo(x+cut,y+h);
      ctx.lineTo(x,y+h-cut);ctx.lineTo(x,y+cut);ctx.closePath();
    }
    function updateSceneWave(t){
      if(reduceMotion)return;
      if(t>=scene.nextWaveAt){
        scene.waveStart=t;scene.waveSequence+=1;
        scene.nextWaveAt=t+26000+hash3(scene.waveSequence*7.37)*18000;
      }
      if(t-scene.waveStart>5100)scene.waveStart=-Infinity;
    }
    function waveFor(g,t){
      if(!Number.isFinite(scene.waveStart))return 0;
      const elapsed=t-scene.waveStart;
      if(elapsed<0||elapsed>5100)return 0;
      const travel=clamp3(elapsed/3900,0,1);
      const center=travel*(G.length+1)-0.5;
      const distance=g.index-center;
      const core=Math.exp(-(distance*distance)/(2*0.42*0.42));
      const fade=Math.sin(Math.PI*clamp3(elapsed/5100,0,1));
      return core*fade;
    }
    function prepareGeometry(g,t){
      const b=g.baseGeo;if(!b)return;
      const side=(g.index-(G.length-1)/2)/Math.max(1,(G.length-1)/2);
      const ambient=reduceMotion?0:Math.sin(t*0.00056+g.floatPhase)*1.55*DPR;
      const wave=waveFor(g,t);
      const lift=-(g.lift*8.6+g.signal*2.8+wave*4.2)*DPR;
      const ox=scene.x*(3.2+Math.abs(side)*1.9)*DPR-scene.y*side*1.35*DPR;
      const oy=scene.y*(1.8+Math.abs(side)*0.65)*DPR+ambient+lift;
      const depthX=(side<0?-1:1)*(5.5+Math.abs(side)*3.0)*DPR+scene.x*1.45*DPR;
      const depthY=(8.2+g.lift*2.1+wave*1.8)*DPR;
      g.geo={
        cx:b.cx+ox,cy:b.cy+oy,r:b.r,
        panel:{x:b.panel.x+ox,y:b.panel.y+oy,w:b.panel.w,h:b.panel.h},
        pod:{x:b.pod.x+ox,y:b.pod.y+oy,w:b.pod.w,h:b.pod.h},
        colW:b.colW,depthX,depthY,side,wave,
        hovered:scene.hover===g.index,focused:scene.focus===g.index,
      };
    }

    function drawSceneBackdrop(t){
      const w=base.width,h=base.height;
      const vanX=w*0.5+scene.x*w*0.026;
      const horizon=h*0.565+scene.y*h*0.012;
      const bg=ctx.createRadialGradient(vanX,h*0.32,12*DPR,vanX,h*0.46,Math.max(w,h)*0.78);
      bg.addColorStop(0,'#081d2d');bg.addColorStop(.38,'#04121f');bg.addColorStop(.72,'#020811');bg.addColorStop(1,'#010307');
      ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);

      ctx.save();
      for(const s of q3Stars){
        const tw=reduceMotion?1:0.72+Math.sin(t*0.00125+s.p)*0.28;
        const x=(((s.x+scene.x*0.012)%1)+1)%1*w;
        const y=s.y*h*0.68;
        ctx.fillStyle=`rgba(104,207,255,${s.a*tw})`;
        ctx.fillRect(x,y,Math.max(.7,s.r*DPR),Math.max(.7,s.r*DPR));
      }
      ctx.restore();

      ctx.save();ctx.globalCompositeOperation='lighter';
      for(const g of G){if(!g.geo)continue;const halo=ctx.createRadialGradient(g.geo.cx,g.geo.cy,g.geo.r*.28,g.geo.cx,g.geo.cy,g.geo.r*1.6);
        halo.addColorStop(0,rgba3(g.a.color,g.hasData?.032:.012));halo.addColorStop(.62,rgba3(g.a.color,.012));halo.addColorStop(1,rgba3(g.a.color,0));
        ctx.fillStyle=halo;ctx.beginPath();ctx.arc(g.geo.cx,g.geo.cy,g.geo.r*1.6,0,Math.PI*2);ctx.fill();}
      ctx.restore();

      ctx.save();ctx.beginPath();ctx.rect(0,horizon,w,h-horizon);ctx.clip();
      const floor=ctx.createLinearGradient(0,horizon,0,h);floor.addColorStop(0,'rgba(0,163,224,.015)');floor.addColorStop(1,'rgba(0,163,224,.085)');
      ctx.fillStyle=floor;ctx.fillRect(0,horizon,w,h-horizon);
      ctx.lineWidth=.65*DPR;
      for(let i=-12;i<=12;i++){
        const bx=vanX+i*(w/11.2);
        ctx.strokeStyle=i%4===0?'rgba(0,163,224,.18)':'rgba(50,139,181,.085)';
        ctx.beginPath();ctx.moveTo(vanX,horizon);ctx.lineTo(bx,h+8*DPR);ctx.stroke();
      }
      for(let i=0;i<16;i++){
        const p=i/15;const eased=p*p;const y=horizon+(h-horizon)*eased;
        ctx.strokeStyle=i%4===0?'rgba(0,163,224,.18)':'rgba(45,131,174,.075)';
        ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
      }
      ctx.restore();

      ctx.save();ctx.strokeStyle='rgba(111,213,255,.12)';ctx.lineWidth=.7*DPR;
      for(const rr of [w*.12,w*.22,w*.34]){ctx.beginPath();ctx.ellipse(vanX,horizon,rr,rr*.13,0,Math.PI,Math.PI*2);ctx.stroke();}
      ctx.restore();

      if(!reduceMotion){
        const sy=((t*0.034)%(h*1.45))-h*0.22;
        const scan=ctx.createLinearGradient(0,sy-18*DPR,0,sy+18*DPR);
        scan.addColorStop(0,'rgba(0,217,255,0)');scan.addColorStop(.5,'rgba(0,217,255,.028)');scan.addColorStop(1,'rgba(0,217,255,0)');
        ctx.fillStyle=scan;ctx.fillRect(0,sy-18*DPR,w,36*DPR);
      }
    }

    function drawEnergySpine(t){
      if(!G.length||!G[0].geo)return;
      const y=base.height*0.615+scene.y*1.5*DPR;
      const x0=G[0].geo.cx-G[0].geo.r*.44,x1=G[G.length-1].geo.cx+G[G.length-1].geo.r*.44;
      ctx.save();ctx.globalCompositeOperation='lighter';
      const grad=ctx.createLinearGradient(x0,y,x1,y);
      G.forEach((g,i)=>grad.addColorStop(i/(G.length-1),rgba3(g.a.color,.36)));
      ctx.strokeStyle='rgba(86,184,224,.13)';ctx.lineWidth=5*DPR;ctx.beginPath();ctx.moveTo(x0,y);ctx.lineTo(x1,y);ctx.stroke();
      ctx.strokeStyle=grad;ctx.lineWidth=.9*DPR;ctx.shadowColor='rgba(0,163,224,.72)';ctx.shadowBlur=8*DPR;
      ctx.beginPath();ctx.moveTo(x0,y);ctx.lineTo(x1,y);ctx.stroke();ctx.shadowBlur=0;
      for(let i=0;i<G.length;i++){
        const g=G[i],live=g.hasData,px=g.geo.cx;
        ctx.fillStyle=rgba3(g.a.color,live?.86:.30);ctx.shadowColor=rgba3(g.a.color,.84);ctx.shadowBlur=live?8*DPR:2*DPR;
        ctx.beginPath();ctx.arc(px,y,(live?2.2:1.35)*DPR,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
        if(i<G.length-1&&live&&!reduceMotion){
          const nx=G[i+1].geo.cx;const phase=(t*0.00019+i*0.23)%1;
          const bx=px+(nx-px)*phase;
          ctx.fillStyle=rgba3(g.a.color,.96);ctx.shadowColor=rgba3(g.a.color,.98);ctx.shadowBlur=12*DPR;
          ctx.beginPath();ctx.arc(bx,y,(1.4+g.signal*1.2)*DPR,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
        }
      }
      if(Number.isFinite(scene.waveStart)){
        const p=clamp3((t-scene.waveStart)/3900,0,1);const wx=x0+(x1-x0)*p;
        ctx.strokeStyle='rgba(233,253,255,.78)';ctx.lineWidth=1.6*DPR;ctx.shadowColor='rgba(0,217,255,.98)';ctx.shadowBlur=18*DPR;
        ctx.beginPath();ctx.moveTo(wx,y-10*DPR);ctx.lineTo(wx,y+10*DPR);ctx.stroke();ctx.shadowBlur=0;
      }
      ctx.restore();
    }

    function drawPodShell(g,t){
      const {pod,depthX:dx,depthY:dy,wave}=g.geo;const col=g.a.color;
      const hot=Math.max(g.lift,g.signal,wave,g.geo.focused?1:0);
      const back={x:pod.x+dx,y:pod.y+dy,w:pod.w,h:pod.h};
      ctx.save();
      ctx.fillStyle='rgba(0,0,0,.55)';ctx.shadowColor='rgba(0,0,0,.72)';ctx.shadowBlur=20*DPR;
      ctx.beginPath();ctx.ellipse(pod.x+pod.w/2+dx*.35,pod.y+pod.h+dy*.75,pod.w*.42,Math.max(3*DPR,pod.h*.025),0,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;

      chamferPath3(back.x,back.y,back.w,back.h,11*DPR);ctx.fillStyle='rgba(1,6,11,.88)';ctx.fill();ctx.strokeStyle=rgba3(col,.10);ctx.lineWidth=.8*DPR;ctx.stroke();
      const sidePoints=dx>=0
        ? [{x:pod.x+pod.w,y:pod.y+9*DPR},{x:back.x+back.w,y:back.y+9*DPR},{x:back.x+back.w,y:back.y+back.h-9*DPR},{x:pod.x+pod.w,y:pod.y+pod.h-9*DPR}]
        : [{x:pod.x,y:pod.y+9*DPR},{x:back.x,y:back.y+9*DPR},{x:back.x,y:back.y+back.h-9*DPR},{x:pod.x,y:pod.y+pod.h-9*DPR}];
      const sideGrad=ctx.createLinearGradient(pod.x,pod.y,back.x+pod.w,back.y+pod.h);
      sideGrad.addColorStop(0,rgba3(col,.10+hot*.04));sideGrad.addColorStop(1,'rgba(1,7,13,.78)');
      polygon3(sidePoints,sideGrad,rgba3(col,.16+hot*.12),.8);
      polygon3([{x:pod.x+9*DPR,y:pod.y+pod.h},{x:pod.x+pod.w-9*DPR,y:pod.y+pod.h},{x:back.x+back.w-9*DPR,y:back.y+back.h},{x:back.x+9*DPR,y:back.y+back.h}],
        'rgba(2,10,18,.84)',rgba3(col,.13+hot*.10),.8);

      const face=ctx.createLinearGradient(pod.x,pod.y,pod.x+pod.w,pod.y+pod.h);
      face.addColorStop(0,'rgba(16,42,61,.22)');face.addColorStop(.34,'rgba(4,17,29,.34)');face.addColorStop(1,'rgba(1,7,13,.44)');
      chamferPath3(pod.x,pod.y,pod.w,pod.h,11*DPR);ctx.fillStyle=face;ctx.fill();
      ctx.strokeStyle=rgba3(col,.18+hot*.34);ctx.lineWidth=(.8+hot*.55)*DPR;ctx.shadowColor=rgba3(col,.82);ctx.shadowBlur=hot*14*DPR;ctx.stroke();ctx.shadowBlur=0;

      ctx.save();chamferPath3(pod.x,pod.y,pod.w,pod.h,11*DPR);ctx.clip();
      if(!reduceMotion){const sy=pod.y+((t*0.028+g.index*137)%(pod.h+70*DPR))-35*DPR;
        const scan=ctx.createLinearGradient(0,sy-24*DPR,0,sy+24*DPR);scan.addColorStop(0,rgba3(col,0));scan.addColorStop(.5,rgba3(col,.025+hot*.025));scan.addColorStop(1,rgba3(col,0));ctx.fillStyle=scan;ctx.fillRect(pod.x,sy-24*DPR,pod.w,48*DPR);}
      ctx.restore();

      const cut=10*DPR,arm=Math.min(26*DPR,pod.w*.15);
      ctx.strokeStyle=rgba3(col,.38+hot*.36);ctx.lineWidth=1.05*DPR;ctx.shadowColor=rgba3(col,.9);ctx.shadowBlur=hot*8*DPR;
      ctx.beginPath();ctx.moveTo(pod.x+cut,pod.y);ctx.lineTo(pod.x+cut+arm,pod.y);ctx.moveTo(pod.x,pod.y+cut);ctx.lineTo(pod.x,pod.y+cut+arm);
      ctx.moveTo(pod.x+pod.w-cut,pod.y+pod.h);ctx.lineTo(pod.x+pod.w-cut-arm,pod.y+pod.h);ctx.moveTo(pod.x+pod.w,pod.y+pod.h-cut);ctx.lineTo(pod.x+pod.w,pod.y+pod.h-cut-arm);ctx.stroke();ctx.shadowBlur=0;
      const titleX=pod.x+12*DPR,titleY=pod.y+7*DPR;
      const titleSize=clamp3(pod.w*.046,8.5*DPR,13*DPR);
      ctx.save();ctx.textAlign='left';ctx.textBaseline='top';
      ctx.font=`850 ${titleSize}px ui-monospace,Consolas,monospace`;ctx.fillStyle=rgba3(col,.98);
      ctx.shadowColor=rgba3(col,.72);ctx.shadowBlur=(3+hot*5)*DPR;ctx.fillText(g.a.tag,titleX,titleY);
      const tagWidth=ctx.measureText(g.a.tag).width;
      ctx.shadowBlur=0;ctx.font=`760 ${titleSize*.92}px ui-monospace,Consolas,monospace`;ctx.fillStyle='rgba(229,247,255,.91)';
      ctx.fillText(g.a.label,titleX+tagWidth+6*DPR,titleY+titleSize*.04);ctx.restore();
      ctx.restore();
    }

    function drawPodForeground(g,t){
      const {cx,cy,r,panel,wave}=g.geo,col=g.a.color,energy=Math.max(g.lift,g.signal,wave);
      const y0=cy+r*.78,y1=panel.y-4*DPR;
      if(y1>y0){
        ctx.save();ctx.globalCompositeOperation='lighter';
        const beam=ctx.createLinearGradient(0,y0,0,y1);beam.addColorStop(0,rgba3(col,.24+energy*.16));beam.addColorStop(1,rgba3(col,.035));
        ctx.strokeStyle=beam;ctx.lineWidth=1*DPR;ctx.setLineDash([3*DPR,5*DPR]);ctx.lineDashOffset=reduceMotion?0:-t*.012*DPR;
        ctx.beginPath();ctx.moveTo(cx,y0);ctx.lineTo(cx,y1);ctx.stroke();ctx.setLineDash([]);
        const phase=reduceMotion?.5:(t*.00032+g.index*.21)%1;const py=y0+(y1-y0)*phase;
        ctx.fillStyle=rgba3(col,.92);ctx.shadowColor=rgba3(col,.96);ctx.shadowBlur=8*DPR;ctx.beginPath();ctx.arc(cx,py,(1.25+energy*.75)*DPR,0,Math.PI*2);ctx.fill();ctx.restore();
      }
      if(energy>.025){
        ctx.save();ctx.globalCompositeOperation='lighter';ctx.strokeStyle=rgba3(col,.18+energy*.52);ctx.lineWidth=(.8+energy*.9)*DPR;ctx.shadowColor=rgba3(col,.96);ctx.shadowBlur=(8+energy*12)*DPR;
        ctx.beginPath();ctx.arc(cx,cy,r*(1.03+energy*.12),0,Math.PI*2);ctx.stroke();ctx.restore();
      }
    }

    function drawSceneOverlay(t){
      const w=base.width,h=base.height;
      if(!reduceMotion){
        const sx=((t*0.046)%(w*1.55))-w*.28;
        const scan=ctx.createLinearGradient(sx-80*DPR,0,sx+80*DPR,0);
        scan.addColorStop(0,'rgba(233,253,255,0)');scan.addColorStop(.5,'rgba(233,253,255,.025)');scan.addColorStop(1,'rgba(233,253,255,0)');
        ctx.save();ctx.transform(1,-.10,0,1,0,0);ctx.fillStyle=scan;ctx.fillRect(0,0,w,h*1.15);ctx.restore();
      }
      const vignette=ctx.createRadialGradient(w*.5,h*.46,Math.min(w,h)*.26,w*.5,h*.46,Math.max(w,h)*.72);
      vignette.addColorStop(0,'rgba(0,0,0,0)');vignette.addColorStop(.72,'rgba(0,0,0,.08)');vignette.addColorStop(1,'rgba(0,0,0,.52)');
      ctx.fillStyle=vignette;ctx.fillRect(0,0,w,h);
    }


    function drawGauge(g,t){
      const {cx,cy,r} = g.geo, a=g.a, st=g.state||{}, critical=st.critical===true, col=critical?'#ff4d3d':a.color, live=g.hasData;
      const valueFraction = live ? frac(g) : (a.dial==='center' ? .5 : 0);
      const needleAngle = angAt(valueFraction);
      const energy = Math.max(g.lift,g.signal,g.geo.wave,g.geo.focused?1:0);
      const shellDx = g.geo.depthX*.38, shellDy = g.geo.depthY*.34;
      ctx.save();

      /* dimensional instrument chassis: layered optical-black cylinder */
      ctx.save();
      for(let layer=7;layer>=1;layer--){
        const q=layer/7, lx=cx+shellDx*q, ly=cy+shellDy*q;
        const metal=ctx.createRadialGradient(lx-r*.20,ly-r*.25,r*.08,lx,ly,r*1.01);
        metal.addColorStop(0,`rgba(22,42,56,${0.54+q*.12})`);metal.addColorStop(.55,`rgba(4,13,21,${0.88+q*.08})`);metal.addColorStop(1,'rgba(0,3,7,.98)');
        ctx.fillStyle=metal;ctx.beginPath();ctx.arc(lx,ly,r*(1.004+q*.004),0,Math.PI*2);ctx.fill();
        ctx.strokeStyle=rgba3(col,.045+energy*.018);ctx.lineWidth=.55*DPR;ctx.stroke();
      }
      ctx.restore();

      /* optical halo: data emits light, chrome does not */
      const halo=ctx.createRadialGradient(cx,cy,r*.38,cx,cy,r*1.12);
      halo.addColorStop(0,rgba3(col,live?.055:.018));halo.addColorStop(.72,rgba3(col,live?.022:.008));halo.addColorStop(1,rgba3(col,0));
      ctx.fillStyle=halo;ctx.beginPath();ctx.arc(cx,cy,r*1.12,0,Math.PI*2);ctx.fill();

      /* monolithic black-glass instrument body */
      const face=ctx.createRadialGradient(cx-r*.20,cy-r*.24,r*.05,cx,cy,r);
      face.addColorStop(0,'rgba(17,38,55,.92)');face.addColorStop(.42,'rgba(6,17,28,.97)');face.addColorStop(1,'rgba(1,6,11,.995)');
      ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fillStyle=face;ctx.fill();
      ctx.lineWidth=1*DPR;ctx.strokeStyle='rgba(125,207,241,.16)';ctx.stroke();
      ctx.beginPath();ctx.arc(cx,cy,r*.94,0,Math.PI*2);ctx.strokeStyle=rgba3(col,live?.19:.08);ctx.stroke();
      ctx.beginPath();ctx.arc(cx,cy,r*.86,0,Math.PI*2);ctx.strokeStyle='rgba(146,206,234,.055)';ctx.stroke();

      /* rotating segmented outer encoder ring */
      ctx.save();ctx.lineCap='round';ctx.globalCompositeOperation='lighter';
      const encoderPhase=reduceMotion?0:t*0.00022*(g.index%2?-1:1);
      for(let i=0;i<28;i++){
        const a0=encoderPhase+i/28*Math.PI*2,a1=a0+Math.PI*2/28*.46;
        const major=i%7===0;ctx.strokeStyle=rgba3(col,(major?.42:.16)+(live?.08:.02)+energy*.18);
        ctx.lineWidth=(major?1.55:.78)*DPR;ctx.shadowColor=rgba3(col,.86);ctx.shadowBlur=(major?4:1)*DPR+energy*5*DPR;
        ctx.beginPath();ctx.arc(cx,cy,r*(major?.985:.968),a0,a1);ctx.stroke();
      }
      ctx.restore();

      /* holographic depth core + moving tomography slice */
      const core=ctx.createRadialGradient(cx-r*.08,cy-r*.10,0,cx,cy,r*.29);
      core.addColorStop(0,rgba3(col,live?.11:.035));core.addColorStop(.58,rgba3(col,.025+energy*.025));core.addColorStop(1,rgba3(col,0));
      ctx.fillStyle=core;ctx.beginPath();ctx.arc(cx,cy,r*.30,0,Math.PI*2);ctx.fill();
      if(!reduceMotion){
        ctx.save();ctx.beginPath();ctx.arc(cx,cy,r*.91,0,Math.PI*2);ctx.clip();
        const sy=cy-r*.83+((t*0.031+g.index*71)%(r*1.66));
        const scan=ctx.createLinearGradient(0,sy-8*DPR,0,sy+8*DPR);scan.addColorStop(0,rgba3(col,0));scan.addColorStop(.5,rgba3(col,.045+energy*.035));scan.addColorStop(1,rgba3(col,0));
        ctx.fillStyle=scan;ctx.fillRect(cx-r,sy-8*DPR,r*2,16*DPR);ctx.restore();
      }

      /* restrained reticle gives spatial precision without visual noise */
      ctx.save();ctx.globalAlpha=live?.18:.08;ctx.strokeStyle=col;ctx.lineWidth=.65*DPR;ctx.setLineDash([2*DPR,5*DPR]);
      ctx.beginPath();ctx.moveTo(cx-r*.55,cy);ctx.lineTo(cx+r*.55,cy);ctx.moveTo(cx,cy-r*.55);ctx.lineTo(cx,cy+r*.55);ctx.stroke();ctx.setLineDash([]);
      for(const rr of [.26,.48,.70]){ctx.beginPath();ctx.arc(cx,cy,r*rr,0,Math.PI*2);ctx.stroke();}ctx.restore();

      /* sweep track, protected zones and authoritative value */
      ctx.save();ctx.lineCap='round';
      ctx.lineWidth=5*DPR;ctx.strokeStyle=rgba3(col,.10);ctx.beginPath();ctx.arc(cx,cy,r*.77,SWEEP_A,SWEEP_B);ctx.stroke();
      ctx.lineWidth=1*DPR;ctx.strokeStyle=rgba3(col,.20);ctx.beginPath();ctx.arc(cx,cy,r*.83,SWEEP_A,SWEEP_B);ctx.stroke();
      if(a.redline!=null){
        const ra0=a.dial==='center'?SWEEP_A:angAt(a.key==='health'?0:a.redline), ra1=a.key==='health'?angAt(a.redline):SWEEP_B;
        ctx.lineWidth=3*DPR;ctx.strokeStyle='rgba(255,77,94,.52)';ctx.shadowColor='rgba(255,77,94,.72)';ctx.shadowBlur=7*DPR;
        ctx.beginPath();ctx.arc(cx,cy,r*.77,ra0,ra1);ctx.stroke();ctx.shadowBlur=0;
      }
      if(live){
        const va0=a.dial==='center'?angAt(.5):SWEEP_A, va1=needleAngle;
        ctx.lineWidth=5*DPR;ctx.strokeStyle=rgba3(col,.92);ctx.shadowColor=rgba3(col,.92);ctx.shadowBlur=13*DPR;
        ctx.beginPath();ctx.arc(cx,cy,r*.77,Math.min(va0,va1),Math.max(va0,va1));ctx.stroke();ctx.shadowBlur=0;
        const ex=cx+Math.cos(va1)*r*.77,ey=cy+Math.sin(va1)*r*.77;
        const tracer=(reduceMotion?2.1:2.1+Math.sin(t*.009)*.75)*DPR;
        ctx.fillStyle=rgba3(col,.98);ctx.shadowColor=rgba3(col,.98);ctx.shadowBlur=11*DPR;ctx.beginPath();ctx.arc(ex,ey,tracer,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      }
      ctx.restore();

      /* calibrated ticks; labels are sparse to protect readability */
      ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
      for(let i=0;i<=40;i++){
        const f=i/40,major=i%5===0,ang=angAt(f),r1=r*.72,r0=major?r*.635:r*.675;
        ctx.strokeStyle=major?rgba3(col,live?.72:.30):'rgba(148,192,216,.22)';ctx.lineWidth=(major?1.35:.7)*DPR;
        ctx.beginPath();ctx.moveTo(cx+Math.cos(ang)*r0,cy+Math.sin(ang)*r0);ctx.lineTo(cx+Math.cos(ang)*r1,cy+Math.sin(ang)*r1);ctx.stroke();
        if(major && i%10===0){
          const n=a.dial==='center'?f*200-100:f*100,nr=r*.56;
          ctx.font=`650 ${Math.max(6.5,r*.073)}px ui-monospace,Consolas,monospace`;ctx.fillStyle='rgba(185,217,234,.48)';
          ctx.fillText(String(Math.round(n)),cx+Math.cos(ang)*nr,cy+Math.sin(ang)*nr);
        }
      }
      ctx.restore();

      /* motion trail is temporal context, not decoration */
      if(!reduceMotion && live && g.trail.length>1){
        ctx.save();ctx.globalCompositeOperation='lighter';
        for(let i=1;i<g.trail.length;i++){
          const p0=g.trail[i-1],p1=g.trail[i],alpha=(i/g.trail.length)*.11;
          ctx.strokeStyle=rgba3(col,alpha);ctx.lineWidth=1.8*DPR;ctx.beginPath();ctx.arc(cx,cy,r*.61,Math.min(p0,p1),Math.max(p0,p1));ctx.stroke();
        }
        ctx.restore();
      }

      /* precise light pointer, intentionally subordinate to the digital readout */
      const nx=cx+Math.cos(needleAngle)*r*.64,ny=cy+Math.sin(needleAngle)*r*.64;
      const bx=cx-Math.cos(needleAngle)*r*.10,by=cy-Math.sin(needleAngle)*r*.10;
      ctx.save();ctx.strokeStyle=live?rgba3(col,.82):'rgba(100,126,145,.28)';ctx.lineWidth=1.25*DPR;ctx.shadowColor=rgba3(col,.9);ctx.shadowBlur=live?9*DPR:0;
      ctx.beginPath();ctx.moveTo(bx,by);ctx.lineTo(nx,ny);ctx.stroke();ctx.restore();
      ctx.beginPath();ctx.arc(cx,cy,3.3*DPR,0,Math.PI*2);ctx.fillStyle=live?col:'#425766';ctx.shadowColor=rgba3(col,.92);ctx.shadowBlur=live?8*DPR:0;ctx.fill();ctx.shadowBlur=0;

      /* central data hierarchy */
      const bigText=(st.big??'—')+(st.bigUnit?` ${st.bigUnit}`:'');
      const readable = live || (st.big != null && st.big !== '—');
      ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
      const bigBase=Math.max(13,r*.205),bigScale=bigText.length>8?clamp3(8/bigText.length,.56,1):1;
      ctx.font=`750 ${bigBase*bigScale}px ui-monospace,Consolas,monospace`;ctx.fillStyle=critical?'#ff7180':readable?'#eefbff':'rgba(145,171,188,.54)';
      ctx.shadowColor=live?rgba3(col,.46):'transparent';ctx.shadowBlur=live?9*DPR:0;ctx.fillText(bigText,cx,cy+r*.12);ctx.shadowBlur=0;
      ctx.font=`700 ${Math.max(6.5,r*.073)}px ui-monospace,Consolas,monospace`;ctx.fillStyle=readable?rgba3(col,.86):'rgba(114,143,162,.72)';
      ctx.fillText(st.status??'UNKNOWN',cx,cy+r*.31);
      ctx.restore();

      /* optical highlight is clipped to the instrument, never crossing text */
      ctx.save();ctx.beginPath();ctx.arc(cx,cy,r*.92,0,Math.PI*2);ctx.clip();
      const glass=ctx.createLinearGradient(cx-r*.7,cy-r,cx+r*.4,cy+r*.5);glass.addColorStop(0,'rgba(255,255,255,.085)');glass.addColorStop(.31,'rgba(255,255,255,.018)');glass.addColorStop(.42,'rgba(255,255,255,0)');
      ctx.fillStyle=glass;ctx.beginPath();ctx.ellipse(cx-r*.22,cy-r*.45,r*.78,r*.37,-.23,0,Math.PI*2);ctx.fill();ctx.restore();
      if(g.signal>0.015||g.geo.wave>0.015){
        const burst=Math.max(g.signal,g.geo.wave);ctx.save();ctx.globalCompositeOperation='lighter';ctx.strokeStyle=rgba3(col,.18+burst*.55);ctx.lineWidth=(.8+burst*1.2)*DPR;ctx.shadowColor=rgba3(col,.96);ctx.shadowBlur=(8+burst*18)*DPR;
        ctx.beginPath();ctx.arc(cx,cy,r*(1.02+burst*.14),0,Math.PI*2);ctx.stroke();ctx.restore();
      }
      ctx.restore();
    }

    function drawSubvisualHeader(g,{alert='',alertColor='#ff4d3d'}={}){
      const {panel}=g.geo,a=g.a;
      const padX=clamp3(panel.w*.035,5*DPR,9*DPR);
      const titleSize=clamp3(panel.h*.105,7.2*DPR,10.5*DPR);
      const titleY=panel.y+1*DPR;
      ctx.save();ctx.textAlign='left';ctx.textBaseline='top';
      ctx.font=`820 ${titleSize}px ui-monospace,Consolas,monospace`;
      ctx.fillStyle=rgba3(a.color,.86);ctx.shadowColor=rgba3(a.color,.58);ctx.shadowBlur=4*DPR;
      ctx.fillText(a.sub,panel.x+padX,titleY);ctx.shadowBlur=0;
      if(alert){
        ctx.textAlign='right';ctx.font=`820 ${Math.max(6.2*DPR,titleSize*.82)}px ui-monospace,Consolas,monospace`;
        ctx.fillStyle=rgba3(alertColor,.94);ctx.shadowColor=rgba3(alertColor,.68);ctx.shadowBlur=5*DPR;
        ctx.fillText(alert,panel.x+panel.w-padX,titleY+titleSize*.08);ctx.shadowBlur=0;
      }
      const lineY=titleY+titleSize+4*DPR;
      const line=ctx.createLinearGradient(panel.x+padX,lineY,panel.x+panel.w-padX,lineY);
      line.addColorStop(0,rgba3(a.color,.52));line.addColorStop(.44,rgba3(a.color,.12));line.addColorStop(1,rgba3(a.color,0));
      ctx.strokeStyle=line;ctx.lineWidth=.8*DPR;ctx.beginPath();ctx.moveTo(panel.x+padX,lineY);ctx.lineTo(panel.x+panel.w-padX,lineY);ctx.stroke();
      ctx.restore();
      const contentY=lineY+4*DPR,bottom=panel.y+panel.h-2*DPR;
      const content={x:panel.x+padX,y:contentY,w:Math.max(16*DPR,panel.w-padX*2),h:Math.max(12*DPR,bottom-contentY)};
      ctx.save();
      ctx.beginPath();ctx.rect(content.x,content.y,content.w,content.h);ctx.clip();
      const panelFill=ctx.createLinearGradient(content.x,content.y,content.x,content.y+content.h);
      panelFill.addColorStop(0,rgba3(a.color,.055));
      panelFill.addColorStop(.42,'rgba(8,18,28,.18)');
      panelFill.addColorStop(1,rgba3(a.color,.095));
      ctx.fillStyle=panelFill;
      ctx.fillRect(content.x,content.y,content.w,content.h);
      const edgeGlow=ctx.createLinearGradient(content.x,content.y,content.x+content.w,content.y);
      edgeGlow.addColorStop(0,rgba3(a.color,.18));
      edgeGlow.addColorStop(.22,rgba3(a.color,.04));
      edgeGlow.addColorStop(1,rgba3(a.color,0));
      ctx.fillStyle=edgeGlow;
      ctx.fillRect(content.x,content.y,Math.max(2*DPR,content.w*.14),content.h);
      const bottomGlow=ctx.createRadialGradient(content.x+content.w*.5,content.y+content.h*.96,2*DPR,content.x+content.w*.5,content.y+content.h*.96,Math.max(content.w*.7,content.h*.9));
      bottomGlow.addColorStop(0,rgba3(a.color,.16));
      bottomGlow.addColorStop(.35,rgba3(a.color,.07));
      bottomGlow.addColorStop(1,rgba3(a.color,0));
      ctx.fillStyle=bottomGlow;
      ctx.fillRect(content.x,content.y,content.w,content.h);
      if(content.h > 24*DPR){
        ctx.strokeStyle=rgba3(a.color,.05);ctx.lineWidth=1*DPR;
        const gridStep=Math.max(8*DPR,Math.min(14*DPR,content.h*.16));
        for(let gy=content.y+gridStep; gy<content.y+content.h; gy+=gridStep){ ctx.beginPath();ctx.moveTo(content.x,gy);ctx.lineTo(content.x+content.w,gy);ctx.stroke(); }
      }
      ctx.restore();
      return content;
    }

    function drawSubvisualEmpty(content,text,color){
      const size=clamp3(Math.min(content.h*.105,content.w*.052),6.5*DPR,10.5*DPR);
      ctx.save();ctx.beginPath();ctx.rect(content.x,content.y,content.w,content.h);ctx.clip();
      ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`650 ${size}px ui-monospace,Consolas,monospace`;
      ctx.fillStyle=color;ctx.fillText(text,content.x+content.w/2,content.y+content.h*.52,content.w*.88);ctx.restore();
    }

    function aiProviderReadoutHeight(content,provider){
      return provider ? clamp3(content.h*.28,18*DPR,34*DPR) : 0;
    }
    function drawAiProviderReadout(content,provider){
      if(!provider)return;
      const h=aiProviderReadoutHeight(content,provider),y=content.y+content.h-h;
      const cells=[
        ['TOK USED',provider.totalTokens===null?'—':fmtK(provider.totalTokens)],
        ['TOK LEFT',provider.remainingAuthoritative?fmtK(provider.remainingTokens):'N/A'],
        ['MODEL',provider.model?String(provider.model).slice(0,18):'—'],
      ];
      ctx.save();ctx.beginPath();ctx.rect(content.x,content.y,content.w,content.h);ctx.clip();
      const critical=provider.providerBudgetExhausted===true,col=critical?'#ff4d3d':'#00d9ff';
      ctx.fillStyle=critical?'rgba(40,5,10,.90)':'rgba(1,10,18,.88)';ctx.fillRect(content.x,y,content.w,h);
      ctx.strokeStyle=rgba3(col,critical?.54:.24);ctx.lineWidth=.8*DPR;ctx.beginPath();ctx.moveTo(content.x,y);ctx.lineTo(content.x+content.w,y);ctx.stroke();
      const cw=content.w/cells.length;
      for(let i=0;i<cells.length;i++){
        const x=content.x+cw*i;
        if(i>0){ctx.strokeStyle=rgba3(col,.11);ctx.beginPath();ctx.moveTo(x,y+3*DPR);ctx.lineTo(x,y+h-3*DPR);ctx.stroke();}
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.font=`650 ${Math.max(5.4*DPR,h*.19)}px ui-monospace,Consolas,monospace`;ctx.fillStyle='rgba(102,137,158,.82)';ctx.fillText(cells[i][0],x+cw/2,y+h*.31,cw*.88);
        ctx.font=`800 ${Math.max(6.2*DPR,h*.27)}px ui-monospace,Consolas,monospace`;ctx.fillStyle=rgba3(col,.94);ctx.shadowColor=rgba3(col,.55);ctx.shadowBlur=3*DPR;ctx.fillText(cells[i][1],x+cw/2,y+h*.69,cw*.88);ctx.shadowBlur=0;
      }
      ctx.restore();
    }

    /* A · CALL STREAMGRAPH — wiggle-baseline river of per-tick call outcomes.
     * Bands: ok / cache-avoided / retry / fail. Heights are true counter deltas;
     * zero traffic is a flat river, standby is no river. Nothing is invented. */
    function drawCallStream(g,t){
      const {panel}=g.geo, a=g.a, provider=g.state?.raw?.provider||null;
      ctx.save();
      const content=drawSubvisualHeader(g,{alert:provider?.providerBudgetExhausted?'LACK OF $':provider?.providerPaused?'PAUSED':''});
      const footerH=aiProviderReadoutHeight(content,provider);
      const px=content.x,py=content.y,pw=content.w,ph=Math.max(12*DPR,content.h-footerH);
      const S=g.series||[];
      const KEYS=[['succ','#00d9ff','ok'],['cache','#2affd0','cache'],['retry','#ffb020','retry'],['fail','#ff4d3d','fail']];
      if(provider?.providerBudgetExhausted){
        ctx.save();ctx.beginPath();ctx.rect(content.x,content.y,content.w,Math.max(1,content.h-footerH));ctx.clip();
        ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`900 ${clamp3(content.w*.075,13*DPR,26*DPR)}px ui-monospace,Consolas,monospace`;
        ctx.fillStyle='#ff7180';ctx.shadowColor='rgba(255,77,61,.82)';ctx.shadowBlur=12*DPR;ctx.fillText('LACK OF $',content.x+content.w/2,content.y+(content.h-footerH)*.40,content.w*.88);ctx.shadowBlur=0;
        ctx.font=`700 ${clamp3(content.w*.026,6.5*DPR,10*DPR)}px ui-monospace,Consolas,monospace`;ctx.fillStyle='rgba(255,190,196,.84)';ctx.fillText('CONTROLLED PAUSE · NEW AI SUBMISSIONS BLOCKED',content.x+content.w/2,content.y+(content.h-footerH)*.62,content.w*.90);ctx.restore();
        drawAiProviderReadout(content,provider);ctx.restore();return;
      }
      if(S.length<2){
        const emptyText=provider?.enabled?(provider.ready?'CONFIGURED · awaiting call traffic':'PROVIDER ROUTE BLOCKED'):(provider?'GATEWAY DISABLED':g.state?.status === 'UNAVAILABLE'?'GATEWAY TELEMETRY UNAVAILABLE':'AWAITING SEALED TELEMETRY');
        const streamOnly={...content,h:Math.max(1,content.h-footerH)};
        drawSubvisualEmpty(streamOnly,emptyText,rgba3(a.color,.35));
        drawAiProviderReadout(content,provider);ctx.restore();return;
      }
      const n=S.length;
      let mx=1; for(const s of S){ const tt=s.succ+s.cache+s.retry+s.fail; if(tt>mx)mx=tt; }
      g.emaMax=g.emaMax+(mx-g.emaMax)*0.15; const M=Math.max(g.emaMax,mx,3);
      const top=py+ph*0.22, innerH=ph*0.66, midY=top+innerH/2;
      const X=(i)=>px+pw*(i/(n-1));
      const H=(v)=>(v/M)*innerH;
      ctx.save(); ctx.beginPath(); ctx.rect(content.x,content.y,content.w,content.h); ctx.clip();
      ctx.setLineDash([3*DPR,4*DPR]); ctx.strokeStyle=rgba3(a.color,.10); ctx.lineWidth=1*DPR;
      ctx.beginPath(); ctx.moveTo(px,midY); ctx.lineTo(px+pw,midY); ctx.stroke(); ctx.setLineDash([]);
      const curve=(pts)=>{ ctx.moveTo(pts[0].x,pts[0].y);
        for(let i=0;i<pts.length-1;i++){ const p0=pts[i>0?i-1:0],p1=pts[i],p2=pts[i+1],p3=pts[i+2<pts.length?i+2:pts.length-1];
          ctx.bezierCurveTo(p1.x+(p2.x-p0.x)/6,p1.y+(p2.y-p0.y)/6,p2.x-(p3.x-p1.x)/6,p2.y-(p3.y-p1.y)/6,p2.x,p2.y); } };
      const curveRev=(pts)=>{ for(let i=pts.length-1;i>0;i--){ const p0=pts[i+1<pts.length?i+1:pts.length-1],p1=pts[i],p2=pts[i-1],p3=pts[i-2>=0?i-2:0];
          ctx.bezierCurveTo(p1.x+(p2.x-p0.x)/6,p1.y+(p2.y-p0.y)/6,p2.x-(p3.x-p1.x)/6,p2.y-(p3.y-p1.y)/6,p2.x,p2.y); } };
      const totals=S.map(s=>H(s.succ)+H(s.cache)+H(s.retry)+H(s.fail));
      let cur=totals.map(tt=>midY-tt/2);
      let firstTop=null,lastBot=null;
      for(const [k,col] of KEYS){
        const tp=cur.map((y,i)=>({x:X(i),y}));
        const bt=cur.map((y,i)=>({x:X(i),y:y+H(S[i][k])}));
        if(!firstTop)firstTop=tp;
        lastBot=bt;
        ctx.beginPath(); curve(tp); ctx.lineTo(bt[bt.length-1].x,bt[bt.length-1].y); curveRev(bt); ctx.closePath();
        const gGr=ctx.createLinearGradient(0,top,0,top+innerH);
        gGr.addColorStop(0,rgba3(col,.62)); gGr.addColorStop(1,rgba3(col,.22));
        ctx.fillStyle=gGr; ctx.fill();
        ctx.strokeStyle=rgba3(col,.35); ctx.lineWidth=0.8*DPR; ctx.stroke();
        cur=bt.map(p=>p.y);
      }
      ctx.save(); ctx.shadowColor=rgba3(a.color,.9); ctx.shadowBlur=7*DPR; ctx.strokeStyle=rgba3(a.color,.85); ctx.lineWidth=1.4*DPR;
      ctx.beginPath(); curve(firstTop); ctx.stroke();
      ctx.beginPath(); curve(lastBot); ctx.stroke(); ctx.restore();
      if(!reduceMotion){ const sw=54*DPR, sx=px+(((t*0.045)%(pw+sw*2))-sw);
        const sh=ctx.createLinearGradient(sx,0,sx+sw,0);
        sh.addColorStop(0,'rgba(255,255,255,0)'); sh.addColorStop(.5,'rgba(255,255,255,.06)'); sh.addColorStop(1,'rgba(255,255,255,0)');
        ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.fillStyle=sh; ctx.fillRect(px,top-6*DPR,pw,innerH+12*DPR); ctx.restore(); }
      const lastS=S[n-1]; const inF=(g.state&&g.state.raw&&g.state.raw.inFlight)||0;
      const pr=(reduceMotion?2.4:2.4+Math.sin(t*0.008)*0.9)*DPR + Math.min(4,inF)*0.6*DPR;
      ctx.save(); ctx.shadowColor=rgba3(a.color,.95); ctx.shadowBlur=10*DPR;
      ctx.fillStyle=rgba3(a.color,.9); ctx.beginPath(); ctx.arc(px+pw,midY,Math.max(1.5*DPR,pr),0,Math.PI*2); ctx.fill(); ctx.restore();
      ctx.textAlign='right'; ctx.textBaseline='middle';
      ctx.font=`600 ${Math.max(6,ph*0.115)}px ui-monospace,Consolas,monospace`;
      let ry=py+ph*0.18;
      for(const [k,col,lab] of KEYS){ const v=lastS[k]; if(v>0){ ctx.fillStyle=rgba3(col,.95);
          ctx.shadowColor=rgba3(col,.8); ctx.shadowBlur=4*DPR;
          ctx.fillText(`${lab} +${fmtK(v)}`, px+pw-2*DPR, ry); ctx.shadowBlur=0; ry+=ph*0.135; } }
      if(ph>34*DPR){ let lx=px; const lyy=content.y+content.h-2*DPR;
        ctx.textAlign='left'; ctx.textBaseline='middle';
        ctx.font=`600 ${Math.max(5.5,ph*0.10)}px ui-monospace,Consolas,monospace`;
        for(const [k,col,lab] of KEYS){ ctx.fillStyle=col; ctx.beginPath(); ctx.arc(lx+2*DPR,lyy,1.6*DPR,0,Math.PI*2); ctx.fill();
          ctx.fillStyle='rgba(160,190,210,.55)'; ctx.fillText(lab,lx+5.5*DPR,lyy); lx+=ctx.measureText(lab).width+14*DPR; } }
      ctx.restore();
      drawAiProviderReadout(content,provider);
      ctx.restore();
    }

    /* B · PHASE RING — five cycle phases as a segmented radial dial; each arc
     * fills by its real % in sequence, a comet rides the active phase, and the
     * center reads the cycle number + current phase. IDLE/empty is honest. */
    const PH_INIT={recognition:'R',deep_review:'D',proven_improvement:'P',certification:'C',test_maturity:'T'};
    const PH_SHORT={recognition:'RECOG',deep_review:'REVIEW',proven_improvement:'PROVE',certification:'CERT',test_maturity:'TEST'};
    function drawPhaseRing(g,t){
      const {panel}=g.geo, a=g.a;
      ctx.save();
      const content=drawSubvisualHeader(g);
      const raw=g.state&&g.state.raw;
      if(!raw){drawSubvisualEmpty(content,'awaiting cycle telemetry',rgba3(a.color,.35));ctx.restore();return;}
      const disp=g.phaseDisp||raw.phases.map(p=>p.value ?? 0);
      const N=5, R=Math.min(content.w,content.h)*0.31;
      const cx=content.x+content.w*0.5,cy=content.y+content.h*0.50+2*DPR;
      const gap=0.16, span=(Math.PI*2 - N*gap)/N, start=-Math.PI/2 + gap/2;
      let active=-1; for(let i=0;i<N;i++){ if(raw.phases[i].value!=null&&raw.phases[i].value<100){active=i;break;} }
      const lw=Math.max(3.5,R*0.26)*DPR; ctx.lineCap='round';
      if(!reduceMotion){ ctx.save(); ctx.globalAlpha=.10; ctx.strokeStyle=a.color; ctx.lineWidth=1*DPR;
        const sa=(t*0.0012)%(Math.PI*2); ctx.beginPath(); ctx.arc(cx,cy,R+lw*0.7,sa,sa+0.5); ctx.stroke(); ctx.restore(); }
      for(let i=0;i<N;i++){
        const a0=start+i*(span+gap), a1=a0+span, ac=lerpRGB('#a86f16','#ffd24a',i/(N-1));
        ctx.strokeStyle=rgba3(a.color,.13); ctx.lineWidth=lw;
        ctx.beginPath(); ctx.arc(cx,cy,R,a0,a1); ctx.stroke();
        const f=clamp3(disp[i],0,100)/100, comp=raw.phases[i].value>=100;
        if(f>0.004){ ctx.strokeStyle=rgbaA(ac,.92); ctx.lineWidth=lw;
          ctx.shadowColor=rgbaA(ac,.85); ctx.shadowBlur=(i===active?10:5)*DPR;
          ctx.beginPath(); ctx.arc(cx,cy,R,a0,a0+(a1-a0)*Math.min(1,f)); ctx.stroke(); ctx.shadowBlur=0; }
        if(i===active && f>0.004 && !reduceMotion){ const ta=a0+(a1-a0)*Math.min(1,f), hx=cx+Math.cos(ta)*R, hy=cy+Math.sin(ta)*R;
          const pr=(2.2+Math.sin(t*0.011)*0.9)*DPR; ctx.save(); ctx.shadowColor=rgbaA(ac,.95); ctx.shadowBlur=11*DPR; ctx.fillStyle=rgbaA(ac,.98);
          ctx.beginPath(); ctx.arc(hx,hy,pr,0,Math.PI*2); ctx.fill(); ctx.restore(); }
        const mid=a0+span/2, ix=cx+Math.cos(mid)*R, iy=cy+Math.sin(mid)*R;
        ctx.save(); ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font=`800 ${Math.max(6,lw*0.62)}px ui-monospace,Consolas,monospace`;
        ctx.fillStyle= comp? 'rgba(4,10,16,.9)' : (i===active? 'rgba(255,255,255,.92)':rgba3('#04101a',.6));
        ctx.fillText(PH_INIT[raw.phases[i].key], ix, iy); ctx.restore();
      }
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle=rgba3(a.color,.5); ctx.font=`600 ${Math.max(5,R*0.20)}px ui-monospace,Consolas,monospace`;
      ctx.fillText('CYCLE', cx, cy-R*0.44);
      ctx.fillStyle=rgba3(a.color,.95); ctx.shadowColor=rgba3(a.color,.7); ctx.shadowBlur=6*DPR;
      ctx.font=`800 ${Math.max(11,R*0.55)}px ui-monospace,Consolas,monospace`;
      ctx.fillText(String(raw.cycleNum), cx, cy-R*0.02, R*1.6); ctx.shadowBlur=0;
      const cur=raw.grade?.toUpperCase() ?? (active<0 ? '' : PH_SHORT[raw.phases[active].key]);
      ctx.fillStyle= raw.grade==='proof-authoritative'? 'rgba(57,255,136,.85)':'rgba(255,255,255,.62)';
      ctx.font=`700 ${Math.max(5.5,R*0.20)}px ui-monospace,Consolas,monospace`;
      ctx.fillText(cur, cx, cy+R*0.42, R*1.55);
      if(raw.next){ ctx.textAlign='center'; ctx.textBaseline='alphabetic';
        ctx.font=`600 ${clamp3(content.h*.085,5.5*DPR,8.5*DPR)}px ui-monospace,Consolas,monospace`;ctx.fillStyle=rgba3(a.color,.42);
        ctx.fillText('▸ '+String(raw.next).slice(0,28), content.x+content.w/2, content.y+content.h-2*DPR); }
      ctx.restore();
    }

    /* C · GAINS CASCADE — waterfall of per-measure net contributions building to
     * the improvement index (gains up green, regressions down orange, cumulative
     * connectors + Σ net marker), with concrete native-outcome chips (deps/ms/MB/
     * fps saved) across the top. Everything is real Great Book evidence. */
    function drawGainsCascade(g,t){
      const {panel}=g.geo,a=g.a;ctx.save();
      const content=drawSubvisualHeader(g);
      const raw=g.state&&g.state.raw;
      if(!raw||!raw.cells||!raw.cells.length){
        drawSubvisualEmpty(content,(g.state&&g.state.status==='AWAITING PROOF')?'no proven gains yet':'awaiting improvement data',rgba3(a.color,.35));
        ctx.restore();return;
      }
      /* native-outcome chips */
      const chipY=content.y;let chipX=content.x+content.w;
      ctx.textAlign='right'; ctx.textBaseline='top'; ctx.font=`700 ${Math.max(6*DPR,content.h*0.105)}px ui-monospace,Consolas,monospace`;
      for(const u of (raw.units||[]).slice(0,3)){ const txt=`${u.unit} ${fmtDelta(u.delta)}`; const w=ctx.measureText(txt).width+8*DPR;
        if(chipX-w<content.x+Math.min(content.w*.64,140*DPR))break; const col=u.up?'#39ff88':'#ff7a3d';
        ctx.fillStyle=rgba3(col,.14);ctx.strokeStyle=rgba3(col,.4);ctx.lineWidth=1*DPR;
        ctx.beginPath();ctx.roundRect(chipX-w,chipY,w,Math.max(9*DPR,content.h*0.14),3*DPR);ctx.fill();ctx.stroke();
        ctx.fillStyle=rgba3(col,.95); ctx.fillText(txt, chipX-4*DPR, chipY+1.5*DPR); chipX-=w+4*DPR; }
      /* waterfall */
      const reveal=g.gainReveal==null?1:g.gainReveal;
      const pos=raw.cells.filter(c=>c.net>0).sort((x,y)=>y.net-x.net);
      const neg=raw.cells.filter(c=>c.net<0).sort((x,y)=>x.net-y.net);
      const pack=(arr,k,lab)=>{ if(arr.length<=k) return arr.slice(); const head=arr.slice(0,k-1).slice();
        const rest=arr.slice(k-1).reduce((s,c)=>s+c.net,0); head.push({id:lab,net:rest,col:'#5f7d99'}); return head; };
      const steps=[...pack(pos,5,'+…'), ...pack(neg,3,'−…')];
      const px=content.x,pyTop=content.y+content.h*0.25,pw=content.w,ph=content.h*0.62;
      const C=[0]; for(const s of steps)C.push(C[C.length-1]+s.net);
      const lo=Math.min(0,...C), hi=Math.max(0,...C), range=Math.max(hi-lo,1);
      const Y=(v)=>pyTop+ph*(1-((v-lo)/range)); const zeroY=Y(0);
      const n=steps.length, slot=pw/Math.max(1,n);
      ctx.save();ctx.setLineDash([3*DPR,3*DPR]);ctx.strokeStyle=rgba3(a.color,.18);ctx.lineWidth=1*DPR;
      ctx.beginPath();ctx.moveTo(px,zeroY);ctx.lineTo(px+pw,zeroY);ctx.stroke();ctx.setLineDash([]);ctx.restore();
      for(let i=0;i<n;i++){ const s=steps[i], up=s.net>=0, gcol=up?'#39ff88':'#ff7a3d';
        const x=px+slot*i+slot*0.15, bw=slot*0.70;
        const y0=Y(C[i]), y1=Y(C[i]+s.net*reveal), top=Math.min(y0,y1), hh=Math.max(1*DPR,Math.abs(y1-y0));
        const grd=ctx.createLinearGradient(0,top,0,top+hh+0.001); grd.addColorStop(0,rgba3(gcol,.72)); grd.addColorStop(1,rgba3(gcol,.28));
        ctx.fillStyle=grd; ctx.strokeStyle=rgba3(gcol,.5); ctx.lineWidth=0.8*DPR;
        ctx.beginPath(); ctx.roundRect(x,top,bw,hh,1.5*DPR); ctx.fill(); ctx.stroke();
        ctx.save();ctx.shadowColor=rgba3(gcol,.75);ctx.shadowBlur=5*DPR;ctx.strokeStyle=rgba3(gcol,.7);ctx.lineWidth=1.1*DPR;
        ctx.beginPath();ctx.moveTo(x,y1);ctx.lineTo(x+bw,y1);ctx.stroke();ctx.restore();
        if(i<n-1){ const nx=px+slot*(i+1)+slot*0.15; ctx.strokeStyle=rgba3(a.color,.22);ctx.lineWidth=1*DPR;ctx.setLineDash([2*DPR,2*DPR]);
          ctx.beginPath();ctx.moveTo(x+bw,Y(C[i+1]));ctx.lineTo(nx,Y(C[i+1]));ctx.stroke();ctx.setLineDash([]); } }
      const netY=Y(C[n]); ctx.save();ctx.shadowColor=rgba3(a.color,.8);ctx.shadowBlur=6*DPR;
      ctx.strokeStyle=rgba3(a.color,.8);ctx.lineWidth=1.4*DPR;ctx.setLineDash([4*DPR,2*DPR]);
      ctx.beginPath();ctx.moveTo(px,netY);ctx.lineTo(px+pw,netY);ctx.stroke();ctx.setLineDash([]);ctx.restore();
      ctx.textAlign='right'; ctx.textBaseline=(netY<pyTop+9*DPR)?'top':'bottom';
      ctx.font=`800 ${Math.max(6.5*DPR,content.h*0.12)}px ui-monospace,Consolas,monospace`; ctx.fillStyle=rgba3(a.color,.95);
      ctx.shadowColor=rgba3(a.color,.7);ctx.shadowBlur=5*DPR;
      ctx.fillText(`Σ ${raw.net>=0?'+':''}${fmtK(raw.net)}`, px+pw-1*DPR, netY + (netY<pyTop+9*DPR? 2*DPR : -2*DPR)); ctx.shadowBlur=0;
      ctx.restore();
    }

    /* D · VITALS ECG — a MULTI-PARAMETER PATIENT MONITOR of CLU-E's self-integrity.
     * Each lane is a distinct clinical waveform whose SHAPE + numeric readout encode a
     * subsystem's real status, and the composite heart-rate races as health falls:
     *   SEAL → ECG (HR bpm) · PIPE → respiration (RR) · EVID → SpO2 pleth (from dropped
     *   events) · CUST → capnography (EtCO2).  ok=normal, warn=weak/irregular, crit=erratic
     *   + alarm, unknown=flatline NO SIGNAL. The status is real; the trace renders it. */
    const _gauss=(x,mu,s)=>Math.exp(-((x-mu)*(x-mu))/(2*s*s));
    const _hash=(i)=>{ const x=Math.sin(i*127.1)*43758.5453; return x-Math.floor(x); };
    const _ecg=(p)=> 0.10*_gauss(p,0.16,0.030) - 0.05*_gauss(p,0.235,0.010) + 0.95*_gauss(p,0.265,0.007) - 0.16*_gauss(p,0.295,0.010) + 0.20*_gauss(p,0.55,0.045);
    function _wave(type,p){
      if(type==='ecg') return _ecg(p);
      if(type==='resp'){ const q=p<0.42?(p/0.42):(1-(p-0.42)/0.58); return (Math.sin(q*Math.PI-Math.PI/2)*0.5)*1.5; }
      if(type==='pleth'){ const a=_gauss(p,0.16,0.0032)*1.0 + _gauss(p,0.33,0.011)*0.34; return (a-0.26)*1.75; }
      if(type==='capno'){ let y; if(p<0.14)y=0; else if(p<0.20)y=(p-0.14)/0.06; else if(p<0.78)y=1+(p-0.20)*0.05; else if(p<0.86)y=1-(p-0.78)/0.08; else y=0; return (y-0.5)*1.5; }
      return 0;
    }
    function _sampleLane(type,status,ci,li,spacing){
      if(status==='unknown') return (_hash(ci*3.3+li)*2-1)*0.02;
      const jitAmt = status==='crit'? spacing*0.22 : status==='warn'? spacing*0.09 : 0;
      const jit = jitAmt? (_hash(ci*1.7+li)*jitAmt - jitAmt/2) : 0;
      const p=(((ci+jit)%spacing)+spacing)%spacing / spacing;
      let y=_wave(type,p)*(status==='warn'?0.7:status==='crit'?0.92:1);
      y+=(_hash(ci*5.5+li)-0.5)*(status==='crit'?0.16:status==='warn'?0.05:0.02);
      return y;
    }
    const VIT_COL={ok:'#c77dff',warn:'#ffb020',crit:'#ff4d3d',unknown:'#5f7d99'};
    const VIT_TYPE={seal:'ecg',pipe:'resp',evid:'pleth',cust:'capno'};
    function vitalReadouts(raw){
      const m=raw.metrics||{}, score=raw.score;
      const byKey=Object.fromEntries((raw.vitals||[]).map(v=>[v.key,v.status]));
      const bpm=(score==null)?null:Math.round(clamp3(66+(100-score)*0.85,50,175));
      const rd={};
      rd.seal={ v: byKey.seal==='unknown'||bpm==null?'--':String(bpm), u:' bpm', rate: bpm||72 };
      const rr = byKey.pipe==='unknown'?null: byKey.pipe==='crit'?30: byKey.pipe==='warn'?22:16;
      rd.pipe={ v: rr==null?'--':String(rr), u:' rpm', rate: rr||16 };
      let spo2=null; if(byKey.evid && byKey.evid!=='unknown'){ const dr=Number(m.dropped||0); spo2=Math.round(clamp3(99-Math.min(16,dr*4)-(byKey.evid==='crit'?6:0),70,100)); }
      rd.evid={ v: spo2==null?'--':String(spo2)+'%', u:'', rate: rd.seal.rate };
      const co2 = byKey.cust==='unknown'?null: byKey.cust==='crit'?22: byKey.cust==='warn'?30:38;
      rd.cust={ v: co2==null?'--':String(co2), u:'', rate: rr||16 };
      return { bpm, rd };
    }
    function drawVitalsECG(g,t){
      const {panel}=g.geo,a=g.a;const raw=g.state&&g.state.raw;
      const anyCrit=raw&&raw.vitals&&raw.vitals.some(v=>v.status==='crit');
      ctx.save();
      const content=drawSubvisualHeader(g,{alert:anyCrit?'\u26a0 ALARM':''});
      /* compact composite readout above the waveform lanes */
      const hh=content.h*0.18,hy=content.y+hh*0.50;
      ctx.textAlign='left';ctx.textBaseline='middle';
      ctx.font=`650 ${clamp3(content.h*.075,5.5*DPR,8*DPR)}px ui-monospace,Consolas,monospace`;
      ctx.fillStyle=rgba3(a.color,.44);ctx.fillText('COMPOSITE',content.x,hy);
      const R = raw? vitalReadouts(raw): null;
      if(R){ const bpm=R.bpm, hc= anyCrit?'#ff3b30':(bpm!=null&&bpm>120?'#ffb020':a.color);
        const bp=bpm?((t/60000*bpm)%1):0, flash=bpm?Math.exp(-Math.pow(bp/0.10,2)):0;
        const hx=content.x+content.w,hf=clamp3(content.h*.14,8*DPR,14*DPR);
        ctx.textAlign='right';ctx.textBaseline='middle';
        ctx.font=`800 ${hf}px ui-monospace,Consolas,monospace`; ctx.fillStyle=rgba3(hc,.95);
        ctx.shadowColor=rgba3(hc,.75); ctx.shadowBlur=(3+flash*9)*DPR;
        ctx.fillText(bpm==null?'--':String(bpm), hx-hf*0.95, hy);
        ctx.font=`${hf*(1+0.42*flash)}px ui-monospace,Consolas,monospace`;
        ctx.fillText('\u2665', hx, hy); ctx.shadowBlur=0;
        ctx.font=`600 ${Math.max(5*DPR,content.h*0.065)}px ui-monospace,Consolas,monospace`; ctx.fillStyle=rgba3(hc,.55);
        ctx.fillText('bpm', hx-hf*0.95, hy+hf*0.72);
      }
      if(!raw||!raw.vitals){drawSubvisualEmpty(content,'awaiting self-telemetry',rgba3(a.color,.35));ctx.restore();return;}
      const vitals=raw.vitals, N=vitals.length;
      const px=content.x,pw=content.w;
      const py=content.y+hh,ph=content.h-hh,laneH=ph/N;
      const plotX0=px+6*DPR, plotX1=px+pw-26*DPR, plotW=Math.max(20,plotX1-plotX0);
      const cols=Math.max(24, Math.floor(plotW/(2*DPR)));
      const laneType=vitals.map(v=>VIT_TYPE[v.key]||'ecg');
      const laneSpacing=vitals.map((v,li)=>{ const type=laneType[li]; const rate=(R.rd[v.key]&&R.rd[v.key].rate)||72;
        const across=(type==='ecg'||type==='pleth')?clamp3(rate/16,2.5,9):clamp3(rate/8,1.2,4); return Math.max(8, cols/across); });
      if(!g.ecg||g.ecg.cols!==cols||g.ecg.n!==N){ const waves=vitals.map(()=>new Float32Array(cols));
        g.ecg={cols,n:N,waves,sweep:0}; for(let ci=0;ci<cols;ci++) for(let li=0;li<N;li++) waves[li][ci]=_sampleLane(laneType[li],vitals[li].status,ci,li,laneSpacing[li]); }
      const E=g.ecg;
      if(reduceMotion){ for(let ci=0;ci<cols;ci++) for(let li=0;li<N;li++) E.waves[li][ci]=_sampleLane(laneType[li],vitals[li].status,ci,li,laneSpacing[li]); }
      else { const sp=Math.max(1,cols*0.010); const sPrev=Math.floor(E.sweep)%cols; E.sweep+=sp; const sNow0=Math.floor(E.sweep)%cols;
        let steps=((sNow0-sPrev+cols)%cols); let ci=sPrev; for(let k=0;k<steps;k++){ ci=(ci+1)%cols; for(let li=0;li<N;li++) E.waves[li][ci]=_sampleLane(laneType[li],vitals[li].status,ci,li,laneSpacing[li]); } }
      const sNow=Math.floor(E.sweep)%cols;
      /* graph paper */
      ctx.save(); ctx.beginPath(); ctx.rect(plotX0,py,plotW,ph); ctx.clip();
      ctx.strokeStyle=rgba3(a.color,.06); ctx.lineWidth=1*DPR;
      for(let gx=plotX0; gx<=plotX1; gx+=8*DPR){ ctx.beginPath();ctx.moveTo(gx,py);ctx.lineTo(gx,py+ph);ctx.stroke(); }
      for(let gy=py; gy<=py+ph; gy+=8*DPR){ ctx.beginPath();ctx.moveTo(plotX0,gy);ctx.lineTo(plotX1,gy);ctx.stroke(); }
      ctx.restore();
      for(let li=0;li<N;li++){ const v=vitals[li], col=VIT_COL[v.status]||a.color;
        const cy=py+laneH*li+laneH*0.56, amp=laneH*0.36;
        ctx.strokeStyle=rgba3(col,.14);ctx.lineWidth=1*DPR;ctx.beginPath();ctx.moveTo(px,cy);ctx.lineTo(px+pw-26*DPR,cy);ctx.stroke();
        if(v.status!=='unknown'){ const cX=px, cW=5*DPR, cH=amp*0.7;
          ctx.strokeStyle=rgba3(col,.5);ctx.lineWidth=1*DPR;
          ctx.beginPath();ctx.moveTo(cX,cy);ctx.lineTo(cX,cy-cH);ctx.lineTo(cX+cW,cy-cH);ctx.lineTo(cX+cW,cy);ctx.stroke(); }
        ctx.save();ctx.beginPath();ctx.rect(plotX0,py+laneH*li,plotW,laneH);ctx.clip();
        ctx.shadowColor=rgba3(col,.7);ctx.shadowBlur=(v.status==='unknown'?0:5)*DPR;
        ctx.strokeStyle=rgba3(col,v.status==='unknown'?0.42:0.92);ctx.lineWidth=1.3*DPR;ctx.lineJoin='round';
        ctx.beginPath();let pen=false;
        for(let ci=0;ci<cols;ci++){ const ahead=((ci-sNow+cols)%cols);
          if(!reduceMotion&&ahead>0&&ahead<=4){pen=false;continue;}
          const x=plotX0+(ci/(cols-1))*plotW, y=cy - E.waves[li][ci]*amp;
          if(!pen){ctx.moveTo(x,y);pen=true;}else ctx.lineTo(x,y); }
        ctx.stroke();ctx.restore();
        if(!reduceMotion&&v.status!=='unknown'){ const x=plotX0+(sNow/(cols-1))*plotW, y=cy - E.waves[li][sNow]*amp;
          ctx.save();ctx.shadowColor=rgba3(col,.95);ctx.shadowBlur=8*DPR;ctx.fillStyle=rgba3(col,.98);ctx.beginPath();ctx.arc(x,y,1.8*DPR,0,Math.PI*2);ctx.fill();ctx.restore(); }
        ctx.save();ctx.textBaseline='top';ctx.textAlign='left';
        ctx.fillStyle=rgba3(col,.95);ctx.beginPath();ctx.arc(px+2*DPR,py+laneH*li+laneH*0.19,1.5*DPR,0,Math.PI*2);ctx.fill();
        ctx.font=`700 ${Math.max(5,laneH*0.23)}px ui-monospace,Consolas,monospace`;ctx.fillStyle=rgba3(col,.72);
        ctx.fillText(v.label,px+6*DPR,py+laneH*li+laneH*0.11); ctx.restore();
        const rr=R&&R.rd[v.key], flashR=v.status==='crit'?(0.55+0.45*Math.sin(t*0.014)):1;
        ctx.save();ctx.textAlign='right';ctx.textBaseline='middle';
        ctx.font=`800 ${Math.max(6,laneH*0.30)}px ui-monospace,Consolas,monospace`;
        ctx.fillStyle= v.status==='unknown'?'rgba(95,125,153,.6)':rgba3(col,0.95*flashR);
        ctx.shadowColor=rgba3(col,.6);ctx.shadowBlur=(v.status==='unknown'?0:3)*DPR;
        ctx.fillText(rr?(rr.v+(rr.u||'')):'--', px+pw-1*DPR, cy-laneH*0.06); ctx.restore();
        if(v.status==='unknown'){ ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
          ctx.font=`600 ${Math.max(5,laneH*0.20)}px ui-monospace,Consolas,monospace`;ctx.fillStyle='rgba(95,125,153,.55)';
          ctx.fillText('NO SIGNAL',plotX0+plotW*0.5,cy); ctx.restore(); }
      }
      ctx.restore();
    }

    function drawPanel(g,t){
      if(g.a.key==='ai'){ drawCallStream(g,t); return; }
      if(g.a.key==='cycle'){ drawPhaseRing(g,t); return; }
      if(g.a.key==='gain'){ drawGainsCascade(g,t); return; }
      if(g.a.key==='health'){ drawVitalsECG(g,t); return; }
      const {panel}=g.geo,a=g.a;
      ctx.save();
      const content=drawSubvisualHeader(g);
      ctx.globalAlpha=.28;
      for(let gx=content.x;gx<content.x+content.w;gx+=14*DPR)
        for(let gy=content.y;gy<content.y+content.h;gy+=12*DPR){ctx.fillStyle=rgba3(a.color,.10);ctx.fillRect(gx,gy,1.2*DPR,1.2*DPR);}
      ctx.globalAlpha=1;ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.font=`600 ${Math.max(7*DPR,content.h*0.14)}px ui-monospace,Consolas,monospace`;ctx.fillStyle=rgba3(a.color,.45);
      ctx.fillText('NEXT STAGE',content.x+content.w/2,content.y+content.h/2);ctx.restore();
    }

    let lastT=now(), rafId=null, lastPanelSignature="";
    function step(dt){
      const sub=Math.max(1,Math.min(6,Math.round(dt/16)));
      const cameraEase=Math.min(1,dt*0.0055);
      scene.x+=(scene.targetX-scene.x)*cameraEase;
      scene.y+=(scene.targetY-scene.y)*cameraEase;
      for(const g of G){
        for(let s=0;s<sub;s++){
          const k=0.085,d=0.80;
          g.vel=(g.vel+(g.target-g.pos)*k)*d;g.pos+=g.vel;
          const liftTarget=(scene.hover===g.index?1:0)+(scene.focus===g.index?.58:0)+Math.min(1,g.signal)*.18;
          g.liftVel=(g.liftVel+(liftTarget-g.lift)*.105)*.78;g.lift+=g.liftVel;
        }
        g.signal=Math.max(0,g.signal-dt*0.00082);
        if(!reduceMotion){
          const f=frac(g),ang=angAt(f);const lt=g.trail[g.trail.length-1];
          if(lt===undefined||Math.abs(lt-ang)>0.002)g.trail.push(ang);
          if(g.trail.length>14)g.trail.shift();
          if(Math.abs(g.vel)<0.01&&g.trail.length)g.trail.shift();
        }
      }
      const gb=G[1];
      if(!reduceMotion&&gb.phaseTarget&&gb.phaseDisp){for(let i=0;i<gb.phaseDisp.length;i++)gb.phaseDisp[i]+=(gb.phaseTarget[i]-gb.phaseDisp[i])*Math.min(1,0.10*sub);}
      if(!reduceMotion&&G[2].gainReveal!=null&&G[2].gainReveal<1)G[2].gainReveal=Math.min(1,G[2].gainReveal+0.06*sub);
    }
    function draw(){
      if(!container.isConnected)return;
      try{
        const t=now();const dt=Math.min(64,t-lastT);lastT=t;
        updateSceneWave(t);
        step(dt);
        for(const g of G)prepareGeometry(g,t);
        ctx.clearRect(0,0,base.width,base.height);
        ctx.imageSmoothingEnabled=true;
        drawSceneBackdrop(t);
        drawEnergySpine(t);
        for(const g of G)drawPodShell(g,t);
        /* A · keep the river advancing in real time while LIVE (zero-rate ticks are truth) */
        if(G[0].state&&G[0].state.status==='LIVE'&&G[0].series.length&&(t-G[0].lastPush)>1200){
          G[0].series.push({succ:0,cache:0,retry:0,fail:0});if(G[0].series.length>110)G[0].series.shift();G[0].lastPush=t;
        }
        for(const g of G){
          drawPanel(g,t);
          drawGauge(g,t);
          drawPodForeground(g,t);
        }
        drawSceneOverlay(t);
        if(bloom&&!document.hidden){try{bloom.frame();}catch(e){try{bloom.destroy();}catch(_){ }bloom=null;try{overlay.remove();}catch(_){}}}
      }catch(err){if(!window.__q3ErrLogged){window.__q3ErrLogged=true;console.warn('[Q3] frame skipped:',err&&err.message);}}
      finally{if(!reduceMotion&&container.isConnected)rafId=requestAnimationFrame(draw);}
    }

    /* interaction: parallax hover + click-to-hold cinematic focus */
    base.style.pointerEvents='auto';
    function hitTest3(clientX,clientY){
      const rc=base.getBoundingClientRect();
      const mx=(clientX-rc.left)*DPR,my=(clientY-rc.top)*DPR;
      let hit=null,hitPanel=false;
      for(const g of G){
        if(!g.geo)continue;
        const dx=mx-g.geo.cx,dy=my-g.geo.cy;
        if(Math.hypot(dx,dy)<g.geo.r*1.10){hit=g;hitPanel=false;break;}
        const p=g.geo.panel;
        if(mx>=p.x&&mx<=p.x+p.w&&my>=p.y&&my<=p.y+p.h){hit=g;hitPanel=true;break;}
        const pod=g.geo.pod;
        if(mx>=pod.x&&mx<=pod.x+pod.w&&my>=pod.y&&my<=pod.y+pod.h){hit=g;hitPanel=false;break;}
      }
      return {rc,hit,hitPanel};
    }
    function renderTip3(hit,hitPanel,e,rc){
      if(!hit){tip.style.display='none';return;}
      const st=hit.state||{};
      tip.style.setProperty('--q3-tip-accent',hit.a.color);
      tip.style.display='block';tip.style.left=(e.clientX-rc.left)+'px';tip.style.top=(e.clientY-rc.top)+'px';
      if(hitPanel&&hit.a.key==='ai'){
        const last=hit.series?.[hit.series.length-1]||{succ:0,cache:0,retry:0,fail:0},r=st.raw||{},p=r.provider||null;
        const providerRows=p?`<br><span class="k">provider</span> ${esc3(String(p.provider||'openai').toUpperCase())} · <span class="k">model</span> ${esc3(p.model||'—')}`+
          `<br><span class="k">tokens</span> used ${p.totalTokens==null?'—':fmtK(p.totalTokens)} · left ${p.remainingAuthoritative?fmtK(p.remainingTokens):'provider n/a'}`+
          `<br><span class="k">observed spend</span> today ${formatObservedUsd(p.todayActualUsd)} · month ${formatObservedUsd(p.monthActualUsd)}`+
          (p.providerBudgetExhausted?`<br><span style="color:#ff7180;font-weight:800">LACK OF $ · CONTROLLED PAUSE</span>`:''):'';
        tip.innerHTML=`<span class="t">A · AI / CALL STREAM</span> — ${esc3(st.status||'')}`+
          `<br><span class="k">last tick</span> ok +${fmtK(last.succ)} · cache +${fmtK(last.cache)} · retry +${fmtK(last.retry)} · fail +${fmtK(last.fail)}`+
          `<br><span class="k">cumulative</span> ok ${fmtK(r.successful)} · cache ${fmtK(r.cache)} · retry ${fmtK(r.retries)} · fail ${fmtK(r.failed)}`+
          `<br><span class="k">in-flight</span> ${fmtK(r.inFlight)} · <span class="k">window</span> ${hit.series?.length||0} ticks`+providerRows+
          (st.warn?`<br><span class="k">${esc3(st.warn)}</span>`:'');
      }else if(hitPanel&&hit.a.key==='cycle'&&hit.state&&hit.state.raw){
        const rw=hit.state.raw,PL={recognition:'recognition',deep_review:'deep review',proven_improvement:'proven improvement',certification:'certification',test_maturity:'test maturity'};
        const rows=rw.phases.map(p=>`<span class="k">${PL[p.key]||p.key}</span> ${p.value==null?'—':p.value>=100?'✓ complete':Math.round(p.value)+'%'}`).join('<br>');
        tip.innerHTML=`<span class="t">B · CYCLE PHASES</span> — ${esc3(rw.cycleNum)} · ${esc3(hit.state.big)}${rw.grade?` · ${esc3(rw.grade)}`:''}<br>${rows}${rw.next?`<br><span class="k">next</span> ${esc3(String(rw.next).slice(0,30))}`:''}`;
      }else if(hitPanel&&hit.a.key==='gain'&&hit.state&&hit.state.raw){
        const rw=hit.state.raw;
        const topc=rw.cells.slice().sort((x,y)=>Math.abs(y.net)-Math.abs(x.net)).slice(0,3).map(c=>`<span class="k">${esc3(c.id)}</span> ${c.net>=0?'+':''}${Math.round(c.net)}`).join('<br>');
        const un=(rw.units||[]).map(u=>`${esc3(u.unit)} ${fmtDelta(u.delta)}`).join(' · ');
        tip.innerHTML=`<span class="t">C · GAINS CASCADE</span> — net ${rw.net>=0?'+':''}${fmtK(rw.net)} · ${rw.count} contributions`+(un?`<br><span class="k">native</span> ${un}`:'')+(topc?`<br><span class="k">top</span><br>${topc}`:'');
      }else if(hitPanel&&hit.a.key==='health'&&hit.state&&hit.state.raw){
        const rw=hit.state.raw,RR=vitalReadouts(rw);
        const LB={seal:'seal · HR',pipe:'pipe · RR',evid:'evid · SpO₂',cust:'cust · EtCO₂'};
        const vits=(rw.vitals||[]).map(v=>`<span class="k">${LB[v.key]||v.label.toLowerCase()}</span> ${v.status.toUpperCase()} <b>${(RR.rd[v.key]&&RR.rd[v.key].v)||'--'}${(RR.rd[v.key]&&RR.rd[v.key].u)||''}</b>`).join('<br>');
        tip.innerHTML=`<span class="t">D · VITALS</span> — ${esc3(hit.state.status||'')} · ♥ ${RR.bpm==null?'--':RR.bpm} bpm<br>${vits}${hit.state.warn?`<br><span class="k">${esc3(hit.state.warn)}</span>`:''}`;
      }else{
        const lines=(st.lines||[]).map(([k,v])=>`<span class="k">${esc3(k)}</span> ${esc3(v)}`).join('<br>');
        tip.innerHTML=`<span class="t">${hit.a.tag} · ${esc3(hit.a.label)}</span> — ${esc3(st.status||'UNKNOWN')}${scene.focus===hit.index?' · FOCUS LOCKED':''}${st.warn?`<br><span class="k">${esc3(st.warn)}</span>`:''}${lines?'<br>'+lines:''}`;
      }
    }
    base.addEventListener('mousemove',(e)=>{
      const result=hitTest3(e.clientX,e.clientY),rc=result.rc,hit=result.hit;
      scene.targetX=clamp3(((e.clientX-rc.left)/Math.max(1,rc.width))*2-1,-1,1);
      scene.targetY=clamp3(((e.clientY-rc.top)/Math.max(1,rc.height))*2-1,-1,1);
      scene.hover=hit?hit.index:-1;
      base.style.cursor=hit?'crosshair':'default';
      renderTip3(hit,result.hitPanel,e,rc);
    });
    base.addEventListener('mouseleave',()=>{
      tip.style.display='none';scene.hover=-1;scene.targetX=0;scene.targetY=0;base.style.cursor='crosshair';
    });
    base.addEventListener('click',(e)=>{
      const result=hitTest3(e.clientX,e.clientY),hit=result.hit;
      if(!hit)return;
      scene.focus=scene.focus===hit.index?-1:hit.index;
      hit.signal=1;
      try{base.focus({preventScroll:true});}catch(_){base.focus();}
      if(reduceMotion)draw();
    });
    base.addEventListener('keydown',(e)=>{
      let handled=true;
      if(e.key==='Escape')scene.focus=-1;
      else if(/^[1-4]$/.test(e.key))scene.focus=Number(e.key)-1;
      else if(e.key==='Enter'&&scene.hover>=0)scene.focus=scene.focus===scene.hover?-1:scene.hover;
      else handled=false;
      if(handled){e.preventDefault();if(scene.focus>=0)G[scene.focus].signal=1;if(reduceMotion)draw();}
    });
    const ro=(typeof ResizeObserver!=='undefined')?new ResizeObserver(()=>resize()):null;
    if(ro) ro.observe(container); else window.addEventListener('resize',resize);

    function telemetrySignalSignature(g,st){
      if(!st)return '';
      const r=st.raw||{};
      if(g.a.key==='ai'){const p=r.provider||{};return JSON.stringify([st.status,st.value,st.big,r.successful,r.retries,r.cache,r.failed,r.inFlight,r.thisCycle,p.providerBudgetExhausted,p.providerPaused,p.totalTokens,p.remainingTokens,p.remainingAuthoritative,p.model,p.ready]);}
      if(g.a.key==='cycle')return JSON.stringify([st.status,st.value,st.big,(r.phases||[]).map(p=>[p.key,p.value]),r.cycleNum,r.next]);
      if(g.a.key==='gain')return JSON.stringify([st.status,st.value,st.big,r.net,r.count,r.excluded,(r.cells||[]).map(c=>[c.id,c.net])]);
      if(g.a.key==='health')return JSON.stringify([st.status,st.value,st.warn,(r.vitals||[]).map(v=>[v.key,v.status]),r.metrics&&r.metrics.dropped,r.metrics&&r.metrics.failed,r.metrics&&r.metrics.sessionsActive]);
      return JSON.stringify([st.status,st.value,st.big]);
    }
    function applyTelemetry(T){
      const upd=(g,st)=>{ if(st){
        const signature=telemetrySignalSignature(g,st);
        if(signature!==g.telemetrySignature){g.telemetrySignature=signature;g.signal=1;}
      }
        g.state=st??null;g.hasData=st?.value!=null;g.target=st?.value??0;
      };
      upd(G[0],T.ai); upd(G[1],T.cycle); upd(G[2],T.gain); upd(G[3],T.health);
      /* A · call-stream series from counter deltas — truth only, never synthesized */
      const st0=G[0].state;
      if(!st0?.raw){G[0].lastRaw=null;G[0].series.length=0;}
      else{
        const r=st0.raw, tn=now(), prev=G[0].lastRaw;
        const active = st0.status==='LIVE' || r.successful||r.retries||r.cache||r.failed||r.inFlight;
        if(active){
          if(!prev){ G[0].lastRaw={...r}; G[0].series.push({succ:0,cache:0,retry:0,fail:0}); G[0].lastPush=tn; }
          else{
            const d={succ:Math.max(0,r.successful-prev.successful),cache:Math.max(0,r.cache-prev.cache),
                     retry:Math.max(0,r.retries-prev.retries),fail:Math.max(0,r.failed-prev.failed)};
            const changed=d.succ||d.cache||d.retry||d.fail;
            if(changed || tn-G[0].lastPush>900){ G[0].series.push(d); if(G[0].series.length>110)G[0].series.shift(); G[0].lastPush=tn; }
            G[0].lastRaw={...r};
          }
        }
      }
      /* B · phase-ring animated fill targets (snap in reduced-motion) */
      const cyc=G[1].state && G[1].state.raw;
      if(cyc){ G[1].phaseTarget=cyc.phases.map(p=>clamp3(p.value??0,0,100));
        if(!G[1].phaseDisp || G[1].phaseDisp.length!==G[1].phaseTarget.length) G[1].phaseDisp = reduceMotion?[...G[1].phaseTarget]:G[1].phaseTarget.map(()=>0);
        if(reduceMotion) G[1].phaseDisp=[...G[1].phaseTarget]; }
      /* C · cascade reveal (re-grows only when the contribution set changes) */
      const gr=G[2].state && G[2].state.raw;
      if(gr && gr.cells && gr.cells.length){ const key=gr.net+'/'+gr.count;
        if(G[2].lastGainKey!==key){ G[2].gainReveal=reduceMotion?1:0; G[2].lastGainKey=key; } if(G[2].gainReveal==null)G[2].gainReveal=1; }
      else { G[2].gainReveal=1; }
      if (foot) foot.textContent = '';
      const health=G[3].state, cycleState=G[1].state, aiState=G[0].state, aiProvider=aiState?.raw?.provider||null;
      const aiFundingBlocked=aiProvider?.providerBudgetExhausted===true;
      const panelState=aiFundingBlocked?'critical':!health||health.status==='NO SIGNAL'?'idle':health.status==='CRITICAL'?'critical':health.status==='DEGRADED'?'warning':'live';
      const panelLabel=aiFundingBlocked?'LACK OF $ · AI CONTROLLED PAUSE':health?`${health.status}${cycleState&&cycleState.big!=='—'?` · CYCLE ${cycleState.big}${cycleState.bigUnit||''}`:''}`:'AWAITING TELEMETRY';
      ClueInterface.setPanelState('q3',panelState,panelLabel);
      const signature=[G[0].state?.status,G[0].state?.big,G[1].state?.big,G[2].state?.big,G[3].state?.status].join('|');
      if(signature!==lastPanelSignature){lastPanelSignature=signature;ClueInterface.pulse('q3');}
      if(reduceMotion) draw();
    }
    function setTelemetry(input){
      if(input && (input.ai!==undefined||input.cycle!==undefined||input.gain!==undefined||input.health!==undefined)) {
        applyTelemetry(input);
      } else {
        const snapshot = input?.snapshot ?? input;
        if(snapshot?.dashboard) applyTelemetry(deriveTelemetry(snapshot, excludedMeasureIds()));
      }
    }
    function setProviderStatus(input){
      const frame = ConsoleFrameBus.getLastFrame();
      const base = deriveTelemetry(frame?.snapshot, excludedMeasureIds());
      applyTelemetry({...base, ai:projectAiGauge(input)});
      return normalizeAiProviderStatus(input);
    }
    function getProviderStatus(){return G[0].state?.raw?.provider ?? null;}
    function clearTelemetry(reason='PROJECT SWITCH · AWAITING SEALED FRAME'){
      for(const g of G){g.state=null;g.hasData=false;g.target=0;g.telemetrySignature='';g.signal=0;if(Array.isArray(g.series))g.series.length=0;g.lastRaw=null;}
      G[1].phaseTarget=null;G[1].phaseDisp=null;G[2].gainReveal=1;G[2].lastGainKey=null;
      lastPanelSignature='';ClueInterface.setPanelState('q3','connecting',reason);
      if(reduceMotion)draw();
      return true;
    }
    function getState(){ return G.map(g=>({
      area:g.a.key,hasData:g.hasData,target:g.target,pos:g.pos,state:g.state,series:(g.series?g.series.length:0),
      focused:scene.focus===g.index,hovered:scene.hover===g.index,waveActive:Number.isFinite(scene.waveStart),lift:g.lift,signal:g.signal,
    })); }
    function focusArea(key){ const index=G.findIndex(g=>g.a.key===key||g.a.tag===key);scene.focus=index; if(index>=0)G[index].signal=1; if(reduceMotion)draw(); return index>=0?G[index].a.key:null; }
    function clearFocus(){scene.focus=-1;if(reduceMotion)draw();}
    function triggerSweep(){scene.waveStart=now();scene.waveSequence+=1;scene.nextWaveAt=scene.waveStart+30000+hash3(scene.waveSequence*4.3)*12000;if(reduceMotion)draw();return true;}
    function remove(){ try{if(rafId)cancelAnimationFrame(rafId);}catch(e){} try{if(ro)ro.disconnect();else window.removeEventListener('resize',resize);}catch(e){}
      try{if(bloom)bloom.destroy();}catch(e){}
      try{base.remove();overlay.remove();tip.remove();foot.remove();}catch(e){} }

    resize();
    if(!reduceMotion){ lastT=now(); rafId=requestAnimationFrame(draw); } else draw();
    return { setTelemetry, setProviderStatus, getProviderStatus, clearTelemetry, getState, focusArea, clearFocus, triggerSweep, remove };
  }

  /* ---- bring-up (isolated) ---- */
  try {
    injectStyle3();
    const body = document.querySelector('#q3 .body');
    if (!body) {
      ClueInterface.setPanelState('q3', 'unavailable', 'INSTRUMENT HOST MISSING');
      console.warn('[Q3] container not found');
      return;
    }
    body.innerHTML = '';
    body.style.position = 'relative';
    const clusterCore = mountCluster(body);
    let unsubscribe = () => {},providerPollBusy=false,lastProviderError=null;
    async function refreshProviderStatus(){
      if(providerPollBusy)return clusterCore.getProviderStatus();
      providerPollBusy=true;
      try{
        const frame = await fetchJson('/api/frame', { cache: 'no-store' });
        ConsoleFrameBus.acceptFetchedFrame(frame);
        lastProviderError=null;
        return clusterCore.getProviderStatus();
      }catch(error){
        lastProviderError=error instanceof Error?error.message:String(error);
        return clusterCore.getProviderStatus();
      }finally{providerPollBusy=false;}
    }
    const q2Body = document.querySelector('#q2 .body');
    const onExclusionsChange = () => {
      const frame = ConsoleFrameBus.getLastFrame();
      if (frame?.snapshot) clusterCore.setTelemetry({ snapshot: frame.snapshot });
    };
    q2Body?.addEventListener('gbf-exclusions-change', onExclusionsChange);
    const cluster = {
      ...clusterCore,
      refreshProviderStatus,
      providerDiagnostics:()=>({busy:providerPollBusy,lastError:lastProviderError,status:clusterCore.getProviderStatus()}),
      remove() {
        unsubscribe();
        q2Body?.removeEventListener('gbf-exclusions-change', onExclusionsChange);
        clusterCore.remove();
      },
    };
    window.__q3Cluster = cluster;
    window.__clueAiProviderTelemetry = {refresh:refreshProviderStatus,get:cluster.providerDiagnostics};
    ClueInterface.setPanelState('q3', 'connecting', 'AWAITING TELEMETRY');
    unsubscribe = ConsoleFrameBus.subscribe((frame) => {
      if (frame?.snapshot) cluster.setTelemetry({ snapshot: frame.snapshot });
    });
    void refreshProviderStatus().then(() => {
      if (lastProviderError && !ConsoleFrameBus.getLastFrame()) {
        ClueInterface.setPanelState('q3', 'warning', 'INITIAL FRAME UNAVAILABLE');
      }
    });
  } catch (error) {
    ClueInterface.setPanelState('q3', 'unavailable', 'INSTRUMENTS UNAVAILABLE');
    console.error('[Q3] instrument cluster bring-up failed (dashboard continues):', error);
  }
})();

/* -------------------------- Start + Configure ---------------------------- */

let runPollBusy = false;
let lastRunSignature = '';
let lastCycleReceipt = null;
let lastRunCheckpoint = '';
let runGeneration = 0;

async function pollRun() {
  if (runPollBusy || projectTransition) return;
  runPollBusy = true;
  const generation = runGeneration;
  try {
    const run = await fetchJson('/api/run', { cache: 'no-store' });
    if (generation !== runGeneration) return;
    const { processState: state, stage, stageLabel, guidance, detail } = describeDashboardRun(run);
    if (state === 'running') ribbon.notice(null);
    ribbon.updateRun(run);
    document.body.dataset.clueRunState = state;
    const signature = `${state}|${detail}`;
    if (signature !== lastRunSignature) {
      lastRunSignature = signature;
      if (state === 'running') ClueInterface.pulse('q4');
    }
    const checkpoint = stage && `${run.cycleId || run.runId}|${stage}|${run.checkpointAt ?? ''}|${guidance}`;
    if (checkpoint && checkpoint !== lastRunCheckpoint) {
      lastRunCheckpoint = checkpoint;
      terminal.recordReceipt?.({
        action: 'Cycle checkpoint',
        state: stageLabel,
        cycleId: run.cycleId,
        runId: run.runId,
        detail: [run.checkpointAt, guidance].filter(Boolean).join(' · '),
      });
    }
    const receipt = run?.receipts?.at(-1);
    if (receipt?.finishedAt && receipt.finishedAt !== lastCycleReceipt) {
      lastCycleReceipt = receipt.finishedAt;
      if (receipt.timedOut || receipt.exitCode !== 0 || !stage) {
        terminal.recordReceipt?.({
          action: 'Cycle process',
          state: receipt.timedOut ? 'timeout' : receipt.exitCode === 0 ? 'exited' : 'failed',
          cycleId: run.cycleId,
          runId: run.runId,
          dispatchId: run.dispatchId,
          detail: receipt.lastLine || `Process exit ${receipt.exitCode ?? 'unavailable'}`,
        });
      }
    }
  } catch {
    if (generation !== runGeneration) return;
    document.body.dataset.clueRunState = 'unreachable';
    ribbon.updateRun(null);
  } finally {
    runPollBusy = false;
  }
}

/**
 * DEV-P1-17: the Configuration surface is a tab panel, not a drawer.
 *
 * This was a click handler that toggled an `open` class on an `<aside>` and loaded its body as a
 * side effect of that toggle. Two things followed from the shape. The panel could only be reached
 * by clicking one specific button, so an operator arriving by keyboard never loaded it; and the
 * loader ran on the odd clicks and returned early on the even ones, which is invisible until you
 * ask why the content did not refresh.
 *
 * Named, it is callable by the tab shell on the first selection however that selection was made.
 */
const cfg = $('cfg');
let configurationController = null;
let configurationLoad = null;
let configurationFocusRequest = 0;

function projectRecordIdentity(record) {
  if (!record?.profile || !Number.isSafeInteger(record.generation)) return null;
  return {
    projectId: record.profile.projectId,
    targetRootIdentity: record.profile.targetRootIdentity,
    projectProfileHash: record.projectProfileHash,
    profileGeneration: record.generation,
  };
}

function clearProjectBoundDashboard(reason = 'PROJECT SWITCH · AWAITING PROJECT-BOUND EVIDENCE') {
  runGeneration += 1;
  try { window.__q2Field?.setProjection?.(null); window.__q2LastView = null; } catch { /* Q2 remains isolated */ }
  try { window.__q3Cluster?.clearTelemetry?.(reason); } catch { /* Q3 remains isolated */ }
  renderWork(null);
  renderFeed([]);
  const q2foot = $('q2foot');
  if (q2foot) q2foot.textContent = '';
  ClueInterface.setPanelState('q2', 'connecting', reason);
  ClueInterface.setPanelState('q4', 'connecting', reason);
  ribbon.updateFrame(null);
  ribbon.updateRun(null);
  lastRunSignature = '';
  lastCycleReceipt = null;
  lastRunCheckpoint = '';
  terminal.reset();
}

function onProjectActivationPending(record, validation) {
  const identity = projectRecordIdentity(record);
  const recognitionIdentity = validation?.recognition?.identity ?? null;
  if (!identity || !recognitionIdentity) return false;
  const q1 = window.__q1V9;
  if (q1?.activateProjectGeneration && q1.activateProjectGeneration(recognitionIdentity) !== true) return false;
  if (!ConsoleFrameBus.parkForProjectTransition(identity)) {
    q1?.cancelProjectGenerationActivation?.();
    return false;
  }
  projectTransition = true;
  clearProjectBoundDashboard();
  return true;
}

function onProjectActivationCancelled() {
  try { window.__q1V9?.cancelProjectGenerationActivation?.(); } catch { /* Q1 optional */ }
  ConsoleFrameBus.cancelProjectTransition();
  projectTransition = false;
  clearProjectBoundDashboard('PROJECT ACTIVATION CANCELLED · AWAITING REPLAY');
  void pollRun();
}

function onActiveProjectChanged({ record, pointer }) {
  ConsoleFrameBus.activateProjectIdentity(pointer);
  const identity = projectRecordIdentity(record);
  window.__clueActiveProject = Object.freeze({ ...pointer });
  try {
    window.dispatchEvent(new CustomEvent('clue:active-project-changed', {
      detail: Object.freeze({ pointer: { ...pointer }, operationIdentity: identity }),
    }));
  } catch { /* diagnostics only */ }
  projectTransition = false;
  clearProjectBoundDashboard();
  void pollRun();
  try { void clueStatus.refresh(); } catch { /* next poll remains authoritative */ }
}

function loadConfiguration() {
  const body = $('cfgBody');
  if (!cfg || !body) return;
  if (configurationLoad !== null) return configurationLoad;
  if (!configurationController) {
    configurationController = mountConfigurationPanel({
      root: body,
      actionClient,
      fetchJson,
      onActivationPending: onProjectActivationPending,
      onActivationCancelled: onProjectActivationCancelled,
      onActiveProjectChanged,
      mountAgents(host) {
        const panel = mountAgentsPanel({ root: host, actionClient });
        void panel.load();
        return panel;
      },
    });
  }
  configurationLoad = configurationController.load();
  return configurationLoad;
}

async function openRibbonConfiguration(capability, result) {
  if (!tabShell) return;
  const request = ++configurationFocusRequest;
  tabShell.select('configuration');
  await loadConfiguration();
  if (request === configurationFocusRequest && tabShell.current() === 'configuration') {
    configurationController?.focusCapability(capability, result);
  }
}

/* ================= typed action contracts — DEV-P1-16 =====================
 * §20.1's sixth responsibility. The registry in configuration/actionContracts.js is the list
 * of ways this UI may change the workspace; an undeclared action or a credential-shaped
 * payload is refused before any request is made.
 * ======================================================================== */
const actionClient = createActionClient({
  request: ({ method, path, payload, signal }) =>
    fetchJson(path, {
      method,
      signal,
      ...(payload === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    }),
});

function requireAction(invoked) {
  if (invoked.ok) return invoked.result;
  throw new Error(invoked.serverDetails?.reply ?? invoked.serverDetails?.message ?? invoked.reason);
}

function commandReceipt(action, state, detail) {
  return { reply: detail, receipt: { action, state, detail } };
}

function acceptedStart(result) {
  const { state, detail } = describeStartReceipt(result);
  return { reply: detail, receipt: { ...result, action: 'Cycle drive', state, detail } };
}

const terminalActions = {
  async start({ signal }) {
    if (projectTransition) return commandReceipt('Cycle drive', 'refused', 'Project activation is in progress.');
    const invoked = await actionClient.invoke('start', undefined, { signal });
    if (!invoked.ok || invoked.result?.started !== true) {
      const refusal = invoked.serverDetails ?? invoked.result;
      const detail = refusal?.message ?? refusal?.reason ?? invoked.reason ?? 'Cycle dispatch could not be confirmed.';
      ribbon.notice(detail, 'failed');
      return commandReceipt('Cycle drive', 'refused', detail);
    }
    ribbon.notice(null);
    ClueInterface.pulse('q4');
    void pollRun();
    return acceptedStart(invoked.result);
  },
  async gitSync({ signal }) {
    if (projectTransition) return commandReceipt('Git sync', 'refused', 'Project activation is in progress.');
    const invoked = await actionClient.invoke('syncGit', undefined, { signal });
    const result = invoked.ok ? invoked.result : invoked.serverDetails;
    const completed = invoked.ok && result?.code === 'OK' && ['unchanged', 'fast_forwarded', 'pushed'].includes(result.state);
    const detail = result?.detail ?? invoked.reason ?? 'Git sync did not return a recognized receipt.';
    if (completed) {
      ClueInterface.pulse('q4');
      void clueStatus.refresh();
    }
    return commandReceipt('Git sync', completed ? result.state : 'refused', detail);
  },
  async status({ signal }) {
    if (projectTransition) return 'Project activation is in progress.';
    const run = requireAction(await actionClient.invoke('readRun', undefined, { signal }));
    const { processState, detail } = describeDashboardRun(run);
    return [`Run ${processState}`, detail].filter(Boolean).join(' · ');
  },
};

function terminalCore(result) {
  const text = typeof result === 'string' ? result : result.reply;
  const receipt = result?.receipt;
  const ok = receipt?.state !== 'refused';
  return { kind: 'core', ok, lines: [{ source: 'CORE', tone: ok ? 'info' : 'error', text }], receipts: receipt ? [receipt] : [] };
}

const terminal = mountQ4Terminal({
  root: $('q4'),
  async send({ line, command, signal }) {
    if (projectTransition) return terminalCore(commandReceipt('Console', 'refused', 'Project activation is in progress.'));
    if (command === '/start') return terminalCore(await terminalActions.start({ signal }));
    if (command === '/git sync') return terminalCore(await terminalActions.gitSync({ signal }));
    if (command === '/status' || command === '/cycle status') return terminalCore(await terminalActions.status({ signal }));
    const invoked = await actionClient.invoke('agentConsole', { line }, { signal });
    return invoked.ok ? invoked.result
      : terminalCore(commandReceipt('CLUE', 'refused', invoked.serverDetails?.reason ?? invoked.reason));
  },
  async activity({ after, signal }) {
    if (projectTransition) return null;
    return requireAction(await actionClient.invoke('readAgentActivity', { query: { after } }, { signal }));
  },
  async dialogue({ signal }) {
    if (projectTransition) return null;
    return requireAction(await actionClient.invoke('readAgentDialogue', undefined, { signal }));
  },
});
setInterval(pollRun, 1000);
void pollRun();

/* ================== the quadrant seam — DEV-P1-16 =========================
 * Directory §20.1: one sealed Status store, one selection and cross-highlighting bus, and
 * quadrant controllers. All four modules are tested on their own; this is the wiring, and
 * it is deliberately additive.
 *
 * No rendering moves here and the existing fullscreen implementation is untouched. Each
 * controller currently owns one thing: the panel's honest state, drawn from the Status
 * branch that quadrant declared. That is small enough to see working, and it establishes
 * the seam the rendering migrates through one quadrant at a time.
 *
 * Each controller reads only its declared Status branches. Q3 reads the gauge projection
 * branch for its four instruments. Golden Metrics has its own Status contract.
 * ======================================================================== */
const clueStatus = createStatusStore();
const clueSelection = createSelectionBus();

mountQuadrantStatus({ findPanel: $, store: clueStatus, bus: clueSelection });

// Read once, rather than `connect()`. The store can follow the sealed frame stream itself, and
// doing so here would open a second EventSource on `/api/console-events` beside the one
// `ConsoleFrameBus` already holds — two connections, two sets of frames, one workspace. Feeding
// the store from the existing bus is part of the Q4 migration; until then a single read is
// honest and costs nothing.
void clueStatus.refresh();

/* ===================== top level tabs — DEV-P1-17 =========================
 * Directory §20.1: exactly two top-level tabs, Dashboard and Configuration, with the
 * accessibility, focus and landmark behaviour the shell owns. The logic is
 * `components/tabShell.js`, tested on its own; this is only the wiring.
 * ======================================================================== */
const tabShell = (() => {
  const dashboardTab = $('tabDashboard');
  const configurationTab = $('tabConfiguration');
  const dashboardPanel = $('grid');
  const configurationPanel = $('cfg');
  if (!dashboardTab || !configurationTab || !dashboardPanel || !configurationPanel) return null;

  const shell = createTabShell({
    tabs: [
      { id: 'dashboard', tab: dashboardTab, panel: dashboardPanel },
      { id: 'configuration', tab: configurationTab, panel: configurationPanel },
    ],
    onChange: (id) => {
      // Loaded on first arrival, however the operator got there — click, arrow key or Home/End.
      if (id === 'configuration') void loadConfiguration();
      else configurationFocusRequest += 1;
    },
  });

  for (const [id, element] of [['dashboard', dashboardTab], ['configuration', configurationTab]]) {
    element.addEventListener('click', () => shell.select(id, { moveFocus: true }));
  }
  const tablist = $('toplevelTabs');
  if (tablist) {
    tablist.addEventListener('keydown', (event) => {
      if (shell.handleKey(event)) event.preventDefault();
    });
  }
  return shell;
})();

/* ===================== shared overlay UI (Book + Metrics) ==================
 * Secondary workspaces use the same optical-black material and control grammar as
 * Q1–Q4. Each opens as a focused application, supports native fullscreen with a
 * soft fallback, restores focus on close and remains isolated from the dashboard.
 * ======================================================================== */
const CLUE_UI = (() => {
  const esc = escapeHtml;
  const fullscreenIcon = (expanded) => expanded
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v2H6v3H4V4h5Zm11 5h-2V6h-3V4h5v5ZM4 15h2v3h3v2H4v-5Zm16 5h-5v-2h3v-3h2v5Z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"/></svg>';
  let activeOverlay = null;

  function injectStyle() {
    if (document.getElementById('clue-ov-style')) return;
    const st = document.createElement('style');
    st.id = 'clue-ov-style';
    st.textContent = `
body.clue-overlay-lock{overflow:hidden!important}
.clue-panel-action{border:1px solid rgba(104,192,232,.24);border-radius:8px;background:linear-gradient(180deg,rgba(12,31,48,.86),rgba(3,10,17,.92));color:#aee9ff;box-shadow:inset 0 1px rgba(255,255,255,.045);font:650 9.5px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.07em;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease,color .18s ease}
.clue-panel-action:hover{color:#effcff;border-color:rgba(0,163,224,.66);box-shadow:0 0 20px rgba(0,163,224,.12);transform:translateY(-1px)}
.clue-panel-action:focus-visible{outline:2px solid #dff8ff;outline-offset:2px}
.clue-ov{--overlay-accent:var(--clue-cyan);position:fixed;inset:0;z-index:2147482500;display:none;align-items:center;justify-content:center;padding:clamp(10px,2vw,28px);box-sizing:border-box;background:radial-gradient(circle at 50% 18%,color-mix(in srgb,var(--overlay-accent) 9%,transparent),transparent 42rem),rgba(1,5,10,.78);backdrop-filter:blur(15px) saturate(118%)}
.clue-ov.open{display:flex;animation:clue-ov-enter .20s ease-out}
@keyframes clue-ov-enter{from{opacity:0}to{opacity:1}}
.clue-ov-panel{position:relative;isolation:isolate;width:min(1180px,94vw);height:min(880px,90vh);min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid rgba(109,194,235,.28);border-radius:16px;background:linear-gradient(135deg,rgba(255,255,255,.035),transparent 22%),linear-gradient(180deg,rgba(8,22,36,.985),rgba(2,8,15,.99));box-shadow:0 34px 110px rgba(0,0,0,.72),0 0 52px color-mix(in srgb,var(--overlay-accent) 7%,transparent),inset 0 1px rgba(255,255,255,.055)}
.clue-ov-panel::before{content:"";position:absolute;inset:0;z-index:10;pointer-events:none;border-radius:inherit;background:linear-gradient(90deg,var(--overlay-accent),transparent 72%) left top/29% 1px no-repeat,linear-gradient(180deg,var(--overlay-accent),transparent 72%) left top/1px 27% no-repeat,linear-gradient(270deg,var(--overlay-accent),transparent 72%) right bottom/24% 1px no-repeat,linear-gradient(0deg,var(--overlay-accent),transparent 72%) right bottom/1px 24% no-repeat;opacity:.55}
.clue-ov-panel:fullscreen,.clue-ov-panel.is-maximized{width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;background:#020711!important}
.clue-ov-panel.is-maximized{position:fixed!important;inset:0!important;z-index:2147483000!important}
.clue-ov-head{position:relative;z-index:12;display:flex;align-items:center;gap:11px;min-width:0;padding:10px 11px 10px 13px;border-bottom:1px solid rgba(105,188,229,.16);background:linear-gradient(180deg,rgba(10,25,40,.92),rgba(5,14,24,.82));backdrop-filter:blur(16px) saturate(125%)}
.clue-ov-ident{display:flex;align-items:center;gap:10px;min-width:0}
.clue-ov-code{display:grid;place-items:center;min-width:30px;height:23px;padding:0 6px;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--overlay-accent) 48%,transparent);border-radius:5px;color:var(--overlay-accent);background:color-mix(in srgb,var(--overlay-accent) 9%,transparent);font:800 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.09em}
.clue-ov-titlewrap{min-width:0}.clue-ov-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6f6ff;font:750 12px/1.22 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase}.clue-ov-sub{margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#607e94;font:500 9px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.045em}
.clue-ov-tools{margin-left:auto;display:flex;align-items:center;gap:6px;flex:0 0 auto}.clue-ov-tool{display:grid;place-items:center;width:29px;height:29px;padding:0;border:1px solid rgba(112,197,235,.22);border-radius:7px;color:#8fdcf8;background:linear-gradient(180deg,rgba(13,31,48,.82),rgba(3,10,17,.88));cursor:pointer;box-shadow:inset 0 1px rgba(255,255,255,.045);transition:.16s ease}.clue-ov-tool svg{width:15px;height:15px;fill:currentColor}.clue-ov-tool:hover{color:#effcff;border-color:color-mix(in srgb,var(--overlay-accent) 62%,transparent);background:color-mix(in srgb,var(--overlay-accent) 12%,#06101a);box-shadow:0 0 18px color-mix(in srgb,var(--overlay-accent) 18%,transparent);transform:translateY(-1px)}.clue-ov-tool.is-close:hover{color:#ff9aa5;border-color:rgba(255,77,94,.55);background:rgba(58,10,18,.55)}.clue-ov-tool:focus-visible{outline:2px solid #dff8ff;outline-offset:2px}
.clue-ov-body{position:relative;z-index:2;min-height:0;overflow:auto;scrollbar-color:rgba(0,163,224,.28) transparent}.clue-ov-body::-webkit-scrollbar{width:10px}.clue-ov-body::-webkit-scrollbar-thumb{background:rgba(0,163,224,.28);border-radius:6px}.clue-ov-body::-webkit-scrollbar-track{background:transparent}
.clue-ov-bar{position:sticky;top:0;z-index:8;display:flex;gap:9px;align-items:center;padding:10px 13px;background:linear-gradient(180deg,rgba(7,19,32,.98),rgba(4,13,22,.94));border-bottom:1px solid rgba(102,181,220,.16);box-shadow:0 8px 24px rgba(0,0,0,.22)}
.clue-ov-bar input{flex:1;min-width:90px;height:31px;box-sizing:border-box;padding:0 10px;border:1px solid rgba(103,189,229,.23);border-radius:7px;background:rgba(1,7,13,.62);color:#dff5ff;font:500 10.5px ui-monospace,Consolas,monospace;outline:none;box-shadow:inset 0 1px 8px rgba(0,0,0,.24)}.clue-ov-bar input::placeholder{color:#526f84}.clue-ov-bar input:focus{border-color:color-mix(in srgb,var(--overlay-accent) 68%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--overlay-accent) 9%,transparent),inset 0 1px 8px rgba(0,0,0,.24)}
.clue-ov-bar .cnt{color:#668399;font:500 9.5px/1.3 ui-monospace,Consolas,monospace;white-space:nowrap}.clue-ov-bar button{height:30px;padding:0 10px;border:1px solid rgba(104,190,230,.22);border-radius:7px;background:rgba(5,18,29,.72);color:#9adff8;font:650 9px ui-monospace,Consolas,monospace;letter-spacing:.05em;cursor:pointer}.clue-ov-bar button:hover{border-color:color-mix(in srgb,var(--overlay-accent) 60%,transparent);color:#effcff}
.clue-ov-list{padding:12px 13px 18px;display:flex;flex-direction:column;gap:8px}.clue-ov-empty,.clue-ov-loading{display:grid;place-items:center;min-height:260px;padding:44px 22px;box-sizing:border-box;text-align:center;color:#607e94;font:500 11px/1.72 ui-monospace,Consolas,monospace}.clue-ov-loading::before{content:"";width:20px;height:20px;margin-bottom:12px;border:2px solid rgba(0,163,224,.16);border-top-color:var(--overlay-accent);border-radius:50%;animation:clue-spin .8s linear infinite}@keyframes clue-spin{to{transform:rotate(360deg)}}
/* Great Book log entries */
.gb-e{position:relative;border:1px solid rgba(104,186,225,.15);border-left-width:3px;border-radius:9px;padding:10px 12px;background:linear-gradient(135deg,rgba(7,23,36,.61),rgba(2,10,17,.47));box-shadow:inset 0 1px rgba(255,255,255,.025);font:500 10.5px/1.52 ui-monospace,Consolas,monospace;transition:border-color .16s ease,background .16s ease,transform .16s ease}.gb-e:hover{border-color:rgba(118,205,244,.28);background:linear-gradient(135deg,rgba(9,29,45,.72),rgba(3,12,20,.56));transform:translateY(-1px)}.gb-r1{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.gb-mid{color:#ffd166;font-size:12.5px;font-weight:800}.gb-nm{color:#e5f5ff}.gb-fam{font-size:8px;letter-spacing:.09em;text-transform:uppercase}.gb-vd{margin-left:auto;font-size:8.5px;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border:1px solid;border-radius:4px}.gb-nat{color:#c7efff;margin-top:6px;font-size:11.5px}.gb-nat .ar{color:#607d92;margin:0 5px}.gb-nat .d{color:#607d92;margin-left:8px}.gb-meta{color:#6f90a7;margin-top:4px;font-size:9.2px}.gb-ids{color:#506d82;margin-top:5px;font-size:8.5px;word-break:break-all;display:flex;gap:8px;flex-wrap:wrap;align-items:center}.gb-badge{font-size:7.5px;letter-spacing:.07em;padding:1px 5px;border-radius:3px;border:1px solid}.up{color:#55f09b}.dn{color:#ff8750}
/* Metrics catalogue */
.mx-grp{position:sticky;top:52px;z-index:5;margin:0 -13px;padding:8px 14px;border-top:1px solid rgba(103,181,220,.08);border-bottom:1px solid rgba(103,181,220,.14);background:rgba(5,16,27,.96);color:#668399;font:750 9px ui-monospace,Consolas,monospace;letter-spacing:.13em}.mx-e{border:1px solid rgba(103,183,223,.14);border-left-width:3px;border-radius:9px;padding:9px 11px;background:linear-gradient(135deg,rgba(6,22,35,.57),rgba(2,10,17,.44));cursor:pointer;transition:opacity .15s ease,border-color .15s ease,background .15s ease,transform .15s ease}.mx-e:hover{border-color:rgba(116,205,244,.27);background:linear-gradient(135deg,rgba(8,28,43,.69),rgba(3,12,20,.53));transform:translateY(-1px)}.mx-e.excluded{opacity:.46;filter:saturate(.55)}.mx-e.excluded .mx-id{color:#788b99}.mx-r1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.mx-id{color:#ffd166;font:800 12.5px ui-monospace,Consolas,monospace}.mx-leg{color:#5c788d;font-size:8.5px}.mx-nm{color:#e4f4fe;font:600 10.8px ui-monospace,Consolas,monospace}.mx-fam{font-size:7.8px;letter-spacing:.09em;text-transform:uppercase;margin-left:auto}.mx-def{color:#9bb5c8;font:500 10.5px/1.55 ui-monospace,Consolas,monospace;margin-top:6px}.mx-tog{position:relative;display:inline-block;width:31px;height:17px;flex:0 0 auto;cursor:pointer}.mx-tog input{opacity:0;width:1px;height:1px;position:absolute;margin:0}.mx-sw{position:absolute;inset:0;background:rgba(95,125,153,.31);border:1px solid rgba(110,164,192,.14);border-radius:999px;transition:.15s}.mx-sw::before{content:"";position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:#738b9c;box-shadow:0 1px 4px rgba(0,0,0,.5);transition:.15s}.mx-tog input:checked+.mx-sw{background:rgba(57,255,136,.76);border-color:rgba(57,255,136,.35)}.mx-tog input:checked+.mx-sw::before{transform:translateX(14px);background:#03160b}.mx-tog input:focus-visible+.mx-sw{outline:2px solid #dff8ff;outline-offset:2px}.mx-caret{margin-left:7px;color:#607d92;transition:transform .15s;flex:0 0 auto;font-size:10px}.mx-e.open .mx-caret{transform:rotate(90deg);color:#8fe6ff}.mx-detail{max-height:0;overflow:hidden;transition:max-height .22s ease}.mx-e.open .mx-detail{max-height:820px;margin-top:8px}.mxd-sec{margin:7px 0;padding:7px 9px;border-left:2px solid rgba(0,163,224,.28);border-radius:0 5px 5px 0;background:rgba(2,11,19,.34);color:#bcd7e8;font:500 10.4px/1.62 ui-monospace,Consolas,monospace}.mxd-h{display:block;font-size:7.5px;letter-spacing:.14em;color:#607d92;margin-bottom:3px}.mx-detail ul{margin:2px 0 0;padding-left:16px}.mx-detail li{margin:2px 0;color:#9fb8cc}.mxd-meta{color:#506d82;font-size:8.5px;margin-top:8px;border-top:1px solid rgba(92,161,197,.15);padding-top:7px}
@media(max-width:760px){.clue-ov{padding:0}.clue-ov-panel{width:100vw;height:100vh;border:0;border-radius:0}.clue-ov-sub{display:none}.clue-ov-bar{flex-wrap:wrap}.clue-ov-bar input{flex-basis:100%}.clue-ov-bar .cnt{flex:1;overflow:hidden;text-overflow:ellipsis}.mx-fam{width:100%;margin-left:39px}.gb-vd{margin-left:0}}
@media(prefers-reduced-motion:reduce){.clue-ov.open,.clue-ov-loading::before{animation:none}.clue-panel-action,.clue-ov-tool,.gb-e,.mx-e,.mx-sw,.mx-sw::before,.mx-caret,.mx-detail{transition:none!important}}
`;
    document.head.appendChild(st);
  }

  function panelButton(panelId, id, label, title) {
    const tools = document.getElementById(panelId)?.querySelector('.clue-panel-tools');
    if (!tools) return null;
    let button = document.getElementById(id);
    if (button) return button;
    button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'clue-panel-action';
    button.textContent = label;
    button.setAttribute('aria-haspopup', 'dialog');
    if (title) button.title = title;
    tools.insertBefore(button, tools.querySelector('.clue-panel-state'));
    return button;
  }

  function makeOverlay(id, title, subtitle, { accent = '#00a3e0', code = 'WS' } = {}) {
    injectStyle();
    const existing = document.getElementById(id);
    if (existing?.__ov) return existing.__ov;

    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'clue-ov';
    overlay.style.setProperty('--overlay-accent', accent);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-hidden', 'true');

    const panel = document.createElement('section');
    panel.className = 'clue-ov-panel';
    panel.tabIndex = -1;

    const head = document.createElement('header');
    head.className = 'clue-ov-head';
    const ident = document.createElement('div');
    ident.className = 'clue-ov-ident';
    const codeEl = document.createElement('span');
    codeEl.className = 'clue-ov-code';
    codeEl.textContent = code;
    const titleWrap = document.createElement('div');
    titleWrap.className = 'clue-ov-titlewrap';
    const titleEl = document.createElement('div');
    titleEl.className = 'clue-ov-title';
    titleEl.id = `${id}-title`;
    titleEl.textContent = title;
    const subEl = document.createElement('div');
    subEl.className = 'clue-ov-sub';
    subEl.textContent = subtitle || '';
    titleWrap.append(titleEl, subEl);
    ident.append(codeEl, titleWrap);
    overlay.setAttribute('aria-labelledby', titleEl.id);

    const tools = document.createElement('div');
    tools.className = 'clue-ov-tools';
    const fs = document.createElement('button');
    fs.type = 'button';
    fs.className = 'clue-ov-tool';
    fs.title = 'Full screen · Esc exits';
    fs.setAttribute('aria-label', `Open ${title} full screen`);
    fs.innerHTML = fullscreenIcon(false);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'clue-ov-tool is-close';
    closeButton.title = 'Close workspace (Esc)';
    closeButton.setAttribute('aria-label', `Close ${title}`);
    closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/></svg>';
    tools.append(fs, closeButton);
    head.append(ident, tools);

    const body = document.createElement('div');
    body.className = 'clue-ov-body';
    panel.append(head, body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let previousFocus = null;
    let softMaximized = false;

    function expanded() {
      return document.fullscreenElement === panel || softMaximized;
    }

    function updateFullscreenUi() {
      const isExpanded = expanded();
      fs.innerHTML = fullscreenIcon(isExpanded);
      fs.setAttribute('aria-pressed', String(isExpanded));
      fs.setAttribute('aria-label', isExpanded ? `Exit ${title} full screen` : `Open ${title} full screen`);
    }

    function setSoftMaximized(value) {
      softMaximized = Boolean(value);
      panel.classList.toggle('is-maximized', softMaximized);
      updateFullscreenUi();
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }

    async function toggleFullscreen() {
      if (document.fullscreenElement === panel) {
        try { await document.exitFullscreen(); } catch { /* browser retains current state */ }
        return;
      }
      if (softMaximized) {
        setSoftMaximized(false);
        return;
      }
      if (document.fullscreenElement) {
        try { await document.exitFullscreen(); } catch { /* continue with fallback */ }
      }
      if (panel.requestFullscreen) {
        try {
          await panel.requestFullscreen({ navigationUI: 'hide' });
          return;
        } catch { /* use soft fullscreen */ }
      }
      setSoftMaximized(true);
    }

    async function close() {
      if (!overlay.classList.contains('open')) return;
      if (document.fullscreenElement === panel) {
        try { await document.exitFullscreen(); } catch { /* continue closing */ }
      }
      setSoftMaximized(false);
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      if (activeOverlay?.overlay === overlay) activeOverlay = null;
      if (!activeOverlay) document.body.classList.remove('clue-overlay-lock');
      const restore = previousFocus;
      previousFocus = null;
      if (restore?.isConnected) requestAnimationFrame(() => restore.focus({ preventScroll: true }));
    }

    function open() {
      if (activeOverlay && activeOverlay.overlay !== overlay) void activeOverlay.close();
      previousFocus = document.activeElement;
      activeOverlay = api;
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.classList.add('clue-overlay-lock');
      requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    }

    fs.addEventListener('click', () => void toggleFullscreen());
    closeButton.addEventListener('click', () => void close());
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay && !expanded()) void close(); });
    const onFullscreen = () => { if (document.fullscreenElement !== panel && !softMaximized) panel.classList.remove('is-maximized'); updateFullscreenUi(); };
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !overlay.classList.contains('open')) return;
      if (document.fullscreenElement === panel) return;
      event.preventDefault();
      if (softMaximized) setSoftMaximized(false);
      else void close();
    });

    const api = {
      overlay, panel, body, tools, subEl, open, close, toggleFullscreen,
      setSub(text) { subEl.textContent = text; },
      isOpen() { return overlay.classList.contains('open'); },
    };
    try { overlay.__ov = api; } catch { /* diagnostics are optional */ }
    updateFullscreenUi();
    return api;
  }

  return { esc, panelButton, makeOverlay };
})();
window.__clueOverlayUi = CLUE_UI;

try {
  mountProofBoard({ overlayUi: CLUE_UI, fetchJson, interfaceApi: ClueInterface });
} catch (error) {
  console.error('[Proof Board] workspace unavailable:', error);
}

/* ===================== Book of Improvements viewer ======================== */
(function initBookViewer() {
  try {
    const esc = CLUE_UI.esc;
    const btn = CLUE_UI.panelButton('q2', 'bookBtn', '▤ BOOK', 'Great Book of Efficiency — improvements log');
    if (!btn) { console.warn('[Book] rail not found'); return; }
    const ov = CLUE_UI.makeOverlay('bookOverlay', 'GREAT BOOK OF EFFICIENCY', 'Proven improvements · detailed evidence log', { accent: '#f4af2d', code: 'BK' });
    window.__clueBook = ov;
    let entries = [];
    btn.addEventListener('click', () => { ov.open(); load(); });

    const vColor = (s) => s.invalidated ? '#ff5500' : (s.certified === false ? '#ffd166' : ((s.normalizedContribution ?? 0) >= 0 ? '#39e08b' : '#ff7a3d'));
    function collect(view) {
      const out = [];
      if (view && Array.isArray(view.cells)) for (const c of view.cells) for (const s of (c.segments || []))
        out.push(Object.assign({}, s, { _mid: c.measurementId, _nm: c.name, _fam: c.family, _col: c.familyColor }));
      out.sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')));
      return out;
    }
    async function load() {
      ov.body.innerHTML = '<div class="clue-ov-loading">loading Great Book…</div>';
      let view = null;
      try { view = window.__q2LastView || (await fetchJson('/api/improvement-field')).improvementField; }
      catch (e) { ov.body.innerHTML = '<div class="clue-ov-empty">Great Book unavailable — ' + esc(e.message) + '</div>'; return; }
      entries = collect(view);
      ov.setSub(`${entries.length} proven entries · native evidence preserved`);
      render('');
    }
    function render(q, refocus = false) {
      const ql = q.trim().toLowerCase();
      const rows = ql ? entries.filter(s => (s._mid + ' ' + (s._nm || '') + ' ' + (s.verdict || '') + ' ' + (s.cycleId || '')).toLowerCase().includes(ql)) : entries;
      const bar = `<div class="clue-ov-bar"><input type="text" placeholder="filter by measure, name, verdict, cycle…" value="${esc(q)}"><span class="cnt">${rows.length} / ${entries.length} entries</span><button data-refresh>↻ refresh</button></div>`;
      if (!entries.length) { ov.body.innerHTML = bar + `<div class="clue-ov-empty">No proven improvements recorded in the Great Book yet.<br>Entries appear here as CLU-E lands proven changes.<br><br><span style="color:#4d6b7d">Tip: inject the Q2 data probe to preview the log with simulated entries.</span></div>`; wire(q, refocus); return; }
      const list = rows.map(s => {
        const good = (s.normalizedContribution ?? 0) >= 0, nat = s.native || {}, vc = vColor(s);
        const badges = [];
        if (s.certified === false) badges.push('<span class="gb-badge" style="color:#ffd166;border-color:#ffd166">UNCERTIFIED</span>');
        if (s.invalidated) badges.push('<span class="gb-badge" style="color:#ff5500;border-color:#ff5500">INVALIDATED</span>');
        if (s.certified && !s.invalidated) badges.push('<span class="gb-badge" style="color:#39e08b;border-color:#39e08b">CERTIFIED</span>');
        return `<div class="gb-e" style="border-left-color:${s._col || '#00a3e0'}">
<div class="gb-r1"><span class="gb-mid">${esc(s._mid)}</span><span class="gb-nm">${esc(s._nm || '')}</span><span class="gb-fam" style="color:${s._col || '#00a3e0'}">${esc((s._fam || '').replace(/_/g, ' '))}</span><span class="gb-vd" style="color:${vc};border-color:${vc}">${esc(s.verdict || (good ? 'improvement' : 'regression'))}</span></div>
<div class="gb-nat">${esc(String(nat.baseline))}<span class="ar">→</span>${esc(String(nat.result))} <span style="color:#5f7d99">${esc(nat.unit || '')}</span>${nat.delta != null ? `<span class="d">Δ ${nat.delta > 0 ? '+' : ''}${esc(String(nat.delta))} ${esc(nat.unit || '')}</span>` : ''} <span style="margin-left:10px;color:${good ? '#39e08b' : '#ff7a3d'}">norm ${good ? '+' : ''}${esc(String(s.normalizedContribution))}</span></div>
<div class="gb-meta">${s.confidence != null ? `confidence ${esc(String(s.confidence))} · ` : ''}${s.freshness != null ? `freshness ${esc(String(s.freshness))} · ` : ''}${s.scopeId ? `scope ${esc(s.scopeId)} · ` : ''}${s.cycleId ? `cycle ${esc(s.cycleId)}` : ''}</div>
<div class="gb-ids">${badges.join('')}${s.greatBookEntryId ? `<span>📖 ${esc(s.greatBookEntryId)}</span>` : ''}${s.proofContractId ? `<span>⊢ ${esc(s.proofContractId)}</span>` : ''}${s.benchmarkRunId ? `<span>⏱ ${esc(s.benchmarkRunId)}</span>` : ''}${s.recordedAt ? `<span>${esc(String(s.recordedAt).replace('T', ' ').slice(0, 19))}</span>` : ''}</div>
</div>`;
      }).join('');
      ov.body.innerHTML = bar + `<div class="clue-ov-list">${list}</div>`;
      wire(q, refocus);
    }
    function wire(q, refocus = false) {
      const inp = ov.body.querySelector('input');
      if (inp) {
        inp.setAttribute('aria-label', 'Filter Great Book entries');
        inp.addEventListener('input', (event) => render(event.target.value, true));
        if (refocus) requestAnimationFrame(() => { inp.focus({ preventScroll: true }); inp.setSelectionRange(q.length, q.length); });
      }
      const rf = ov.body.querySelector('[data-refresh]'); if (rf) rf.addEventListener('click', load);
    }
  } catch (e) { console.error('[Book] init failed (dashboard continues):', e); }
})();


/* ===================== Measurement Catalogue viewer ====================== */
(function initMetricsViewer() {
  try {
    const esc = CLUE_UI.esc;
    const btn = CLUE_UI.panelButton('q2', 'metricsBtn', '\u229e METRICS', 'Measurement catalogue — the metrics CLU-E evaluates against');
    if (!btn) { console.warn('[Metrics] rail not found'); return; }
    const ov = CLUE_UI.makeOverlay('metricsOverlay', 'MEASUREMENT CATALOGUE', 'Canonical measures · intention, evidence, failure patterns and cycle scope', { accent: '#00a3e0', code: 'MX' });
    window.__clueMetricsView = ov;
    const AREA = { A: 'Purpose, value & outcome', B: 'Correctness & contracts', C: 'Structure & maintainability', D: 'Efficiency & performance', E: 'Reliability & resilience', F: 'Security, privacy & safety', G: 'Compatibility & operability', H: 'Explainability & balance', I: 'Evidence & assurance', J: 'Acceptance gates', K: 'CLU-E self-performance' };
    const FAM_LABEL = { TARGET_QUALITY: 'Target Quality', EVIDENCE_ASSURANCE: 'Evidence & Assurance', ACCEPTANCE_GATES: 'Acceptance Gates', CLUE_SELF: 'CLU-E Self' };
    let metrics = [], status = {}, hash = '', source = 'canonical';
    window.__clueExcluded = window.__clueExcluded || new Set((function(){ try{ return JSON.parse((window.localStorage && window.localStorage.getItem('clue.excluded')) || '[]'); }catch(e){ return []; } })());
    const PROJ = { signed_score: 'Signed score (−100…+100) — a two-sided dial', gate_state: 'Gate state — PASS / FAIL / UNKNOWN', percentage: 'Percentage (0–100%)', ratio: 'Ratio', count: 'Count', duration_ms: 'Duration (ms)' };
    function persist(){ try{ window.localStorage.setItem('clue.excluded', JSON.stringify([...window.__clueExcluded])); }catch(e){} }
    function applyToQ2(){ try{ if(window.__q2Field && window.__q2Field.setExcluded) window.__q2Field.setExcluded([...window.__clueExcluded]); }catch(e){} }
    function setExclusion(id, excluded){ if(excluded) window.__clueExcluded.add(id); else window.__clueExcluded.delete(id); persist(); applyToQ2(); ClueInterface.pulse('q2'); const el=ov.body.querySelector('[data-count]'); if(el) el.innerHTML=countHtml(); }
    window.__clueSetExclusion = setExclusion;
    function countHtml(){ const ex=metrics.filter(m=>window.__clueExcluded.has(m.id)).length, on=Math.max(0,metrics.length-ex); return `${on} in cycle · <b style="color:#ff9d5c">${ex} excluded</b>`; }
    function detailHtml(m){
      const s=[];
      if(m.definition) s.push(`<div class="mxd-sec"><span class="mxd-h">MEASUREMENT INTENTION</span>${esc(m.definition)}</div>`);
      if(m.projectionType) s.push(`<div class="mxd-sec"><span class="mxd-h">PROJECTION</span>${esc(PROJ[m.projectionType]||m.projectionType)}</div>`);
      if(m.evidenceSources && m.evidenceSources.length) s.push(`<div class="mxd-sec"><span class="mxd-h">EVIDENCE SOURCES</span><ul>${m.evidenceSources.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`);
      if(m.failurePatterns && m.failurePatterns.length) s.push(`<div class="mxd-sec"><span class="mxd-h">FAILURE PATTERNS (what to guard against)</span><ul>${m.failurePatterns.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`);
      if(m.verdictImpact) s.push(`<div class="mxd-sec"><span class="mxd-h">VERDICT IMPACT</span>${esc(m.verdictImpact)}</div>`);
      s.push(`<div class="mxd-meta">${esc(FAM_LABEL[m.family]||m.family)} · legacy ${esc(m.legacyId||'—')} · grid cell ${m.grid.x},${m.grid.y} · status ${esc(status[m.id]||m.status||'ACTIVE')}</div>`);
      return s.join('');
    }
    btn.addEventListener('click', () => { ov.open(); load(); });
    async function load() {
      ov.body.innerHTML = '<div class="clue-ov-loading">loading catalogue…</div>';
      metrics = (window.__clueMetrics || []).slice();
      source = (window.__clueMetricsMeta && window.__clueMetricsMeta.source) || 'canonical';
      status = {}; hash = '';
      try { const c = await fetchJson('/api/catalogue'); hash = c.contentHash || ''; for (const r of (c.records || [])) status[r.id] = r.status; } catch (e) { console.warn('[Metrics] catalogue status overlay unavailable:', e.message); }
      applyToQ2();
      ov.setSub(`${metrics.length} canonical measures · ${source === 'canonical' ? 'canonical source' : `imported ${source}`}`);
      render('');
    }
    function render(q, refocus = false) {
      const ql = q.trim().toLowerCase();
      const rows = ql ? metrics.filter(m => (m.id + ' ' + (m.legacyId || '') + ' ' + m.name + ' ' + (m.definition || '')).toLowerCase().includes(ql)) : metrics;
      const src = source !== 'canonical' ? ` · <b style="color:#ffd166">imported: ${esc(source)}</b>` : '';
      const bar = `<div class="clue-ov-bar"><input class="mxSearch" type="text" placeholder="search id, legacy id, name, purpose…" value="${esc(q)}"><span class="cnt"><span data-count>${countHtml()}</span>${hash ? ' · catalogue ' + esc(hash.slice(0, 10)) : ''}${src} · ${rows.length}/${metrics.length}</span><button data-restore>restore all</button></div>`;
      let html = '', curArea = null;
      for (const m of rows) {
        const area = (m.id.match(/^M([A-K])/) || [])[1];
        if (area !== curArea) { curArea = area; html += `<div class="mx-grp">AREA ${esc(area)} · ${esc(AREA[area] || '')}</div>`; }
        const st = status[m.id] || m.status || 'ACTIVE', col = m.familyColor, off = window.__clueExcluded.has(m.id);
        html += `<div class="mx-e${off ? ' excluded' : ''}" data-id="${esc(m.id)}" style="border-left-color:${col}">
<div class="mx-r1"><label class="mx-tog" title="include / exclude from the CLU-E cycle (dims its Q2 cell)"><input type="checkbox" data-tog aria-label="Include ${esc(m.id)} in this CLU-E cycle"${off ? '' : ' checked'}><span class="mx-sw"></span></label><span class="mx-id">${esc(m.id)}</span><span class="mx-leg">${esc(m.legacyId || '')} · ${m.grid.x},${m.grid.y}</span><span class="mx-nm">${esc(m.name)}</span><span class="mx-fam" style="color:${col}">${esc(FAM_LABEL[m.family] || m.family)} · ${esc(st)}</span><span class="mx-caret">▸</span></div>
${m.definition ? `<div class="mx-def">${esc(m.definition)}</div>` : '<div class="mx-def" style="color:#5f7d99">(no purpose recorded)</div>'}
<div class="mx-detail">${detailHtml(m)}</div></div>`;
      }
      if (!rows.length) html += '<div class="clue-ov-empty">no metrics match the search</div>';
      ov.body.innerHTML = bar + `<div class="clue-ov-list" data-list>${html}</div>`;
      const inp = ov.body.querySelector('.mxSearch');
      if (inp) {
        inp.setAttribute('aria-label', 'Search the measurement catalogue');
        inp.addEventListener('input', (event) => render(event.target.value, true));
        if (refocus) requestAnimationFrame(() => { inp.focus({ preventScroll: true }); inp.setSelectionRange(q.length, q.length); });
      }
      const rst = ov.body.querySelector('[data-restore]'); if (rst) rst.addEventListener('click', () => { window.__clueExcluded.clear(); persist(); applyToQ2(); render(q); });
      const list = ov.body.querySelector('[data-list]');
      if (list) {
        for (const row of list.querySelectorAll('.mx-e')) { row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-expanded', String(row.classList.contains('open'))); }
        list.addEventListener('change', (event) => { const target = event.target; if (target && target.getAttribute && target.getAttribute('data-tog') !== null) { const row = target.closest('.mx-e'); const id = row.getAttribute('data-id'); const excluded = !target.checked; row.classList.toggle('excluded', excluded); setExclusion(id, excluded); } });
        const toggleRow = (row) => { if (!row) return; row.classList.toggle('open'); row.setAttribute('aria-expanded', String(row.classList.contains('open'))); };
        list.addEventListener('click', (event) => { if (event.target.closest?.('.mx-tog')) return; toggleRow(event.target.closest?.('.mx-e')); });
        list.addEventListener('keydown', (event) => { if (event.key !== 'Enter' && event.key !== ' ') return; const row = event.target.closest?.('.mx-e'); if (!row || event.target.closest?.('.mx-tog')) return; event.preventDefault(); toggleRow(row); });
      }
    }
  } catch (e) { console.error('[Metrics] init failed (dashboard continues):', e); }
})();


/* ===================== Catalogue import (Configure) ======================
 * Author or preview a measurement set, then export a loader-valid catalogue.yaml.
 * Mirrors src/analysis/measure/catalogue.ts exactly: canonical ids only; grid,
 * family, colour and legacy alias are DERIVED from the id (frozen 10x10 map) and
 * therefore omitted from the exported YAML (the loader rejects declared values
 * that disagree). The browser preview is session-only and never invents server
 * state — deploying the YAML is a catalogue revision, not a hot swap.
 * ======================================================================== */
(function initCatalogueImport() {
  try {
    const esc = CLUE_UI.esc;

    /* ---- engine-exact constants (src/analysis/measure/catalogue.ts) ---- */
    const AREAS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
    const CARD = { A: 6, B: 7, C: 15, D: 10, E: 7, F: 6, G: 7, H: 2, I: 11, J: 7, K: 18 };
    const AREA_FAMILY = { A: 'TARGET_QUALITY', B: 'TARGET_QUALITY', C: 'TARGET_QUALITY', D: 'TARGET_QUALITY', E: 'TARGET_QUALITY', F: 'TARGET_QUALITY', G: 'TARGET_QUALITY', H: 'TARGET_QUALITY', I: 'EVIDENCE_ASSURANCE', J: 'ACCEPTANCE_GATES', K: 'CLUE_SELF' };
    const FAM_COLOR = { TARGET_QUALITY: '#00a3e0', EVIDENCE_ASSURANCE: '#f4af2d', ACCEPTANCE_GATES: '#ff5500', CLUE_SELF: '#39ff88' };
    const FAM_LABEL = { TARGET_QUALITY: 'Target Quality', EVIDENCE_ASSURANCE: 'Evidence & Assurance', ACCEPTANCE_GATES: 'Acceptance Gates', CLUE_SELF: 'CLU-E Self' };
    const AREA_LABEL = { A: 'Purpose, value & outcome', B: 'Correctness & contracts', C: 'Structure & maintainability', D: 'Efficiency & performance', E: 'Reliability & resilience', F: 'Security, privacy & safety', G: 'Compatibility & operability', H: 'Explainability & balance', I: 'Evidence & assurance', J: 'Acceptance gates', K: 'CLU-E self-performance' };
    const PROJECTION_TYPES = ['signed_score', 'percentage', 'count', 'ratio', 'ordinal', 'gate_state', 'distribution', 'categorical'];
    const METRIC_STATUSES = ['ACTIVE', 'EXPERIMENTAL', 'DEPRECATED', 'RETIRED'];
    const CANON_ID = /^M[A-K][0-9]{2}$/;
    const NORM_ID = /^NORM-[A-Za-z0-9._-]+$/;
    const CAT_ID = /^MCAT-[A-Za-z0-9._-]+$/;
    const CAT_VER = /^[0-9]+\.[0-9]+(\.[0-9]+)?$/;
    const pad2 = (n) => (n < 10 ? '0' + n : String(n));
    const offsetBefore = (area) => { let o = 0; for (const a of AREAS) { if (a === area) break; o += CARD[a] || 0; } return o; };

    function derive(id) {
      const area = id[1], ord = parseInt(id.slice(2), 10);
      const inFrozen = ord >= 1 && ord <= (CARD[area] || 0);
      const gi = inFrozen ? offsetBefore(area) + ord : null;
      const family = AREA_FAMILY[area] || 'TARGET_QUALITY';
      let legacy = null;
      if (inFrozen) legacy = family === 'TARGET_QUALITY' ? 'Q' + pad2(offsetBefore(area) + ord) : family === 'EVIDENCE_ASSURANCE' ? 'A' + pad2(ord) : family === 'ACCEPTANCE_GATES' ? 'G' + pad2(ord) : 'S' + pad2(ord);
      const grid = gi != null ? { index: gi, x: ((gi - 1) % 10) + 1, y: Math.floor((gi - 1) / 10) + 1 } : { index: null, x: null, y: null };
      return { area, ordinal: ord, inFrozen, family, familyColor: FAM_COLOR[family], legacyId: legacy, grid };
    }

    /* ---- validation (against the loader's rules) ---- */
    const cleanList = (x) => Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean) : (x == null || x === '' ? [] : [String(x).trim()]);
    const slugCatId = (name) => 'MCAT-' + (String(name || 'imported').replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported');

    function validate(text, sourceName) {
      const errors = [], warnings = [];
      let doc;
      try { doc = JSON.parse(text); } catch (e) { return { ok: false, errors: ['Not valid JSON — ' + e.message], warnings: [], metrics: [], cat: null, summary: { count: 0, families: {}, withEvidence: 0, catalogueId: '—', version: '—' } }; }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, errors: ['Top level must be a JSON object with a "metrics" array.'], warnings: [], metrics: [], cat: null, summary: { count: 0, families: {}, withEvidence: 0, catalogueId: '—', version: '—' } };
      if (!Array.isArray(doc.metrics) || doc.metrics.length === 0) errors.push('"metrics" must be a non-empty array.');

      let catalogueId = doc.catalogueId != null ? String(doc.catalogueId) : slugCatId(sourceName);
      if (!CAT_ID.test(catalogueId)) { warnings.push('catalogueId "' + catalogueId + '" is not MCAT-… — using "' + slugCatId(sourceName) + '" for export.'); catalogueId = slugCatId(sourceName); }
      let version = doc.version != null ? String(doc.version) : '1.0';
      if (!CAT_VER.test(version)) { warnings.push('version "' + version + '" is not N.N[.N] — using "1.0" for export.'); version = '1.0'; }
      const status = ['ACTIVE', 'DEPRECATED', 'RETIRED'].includes(String(doc.status)) ? String(doc.status) : 'ACTIVE';
      if (Array.isArray(doc.families) && doc.families.length) warnings.push('Custom "families" are ignored — family, colour, grid cell and legacy id are derived from each metric id (frozen 10×10 map).');

      const seen = new Set(), metrics = [];
      (Array.isArray(doc.metrics) ? doc.metrics : []).forEach((r, i) => {
        if (!r || typeof r !== 'object') { errors.push('metrics[' + i + ']: not an object.'); return; }
        const id = String(r.id || '').trim();
        const name = String(r.name || '').trim();
        const definition = String((r.definition != null ? r.definition : r.question) || '').trim();
        if (!id) { errors.push('metrics[' + i + ']: missing "id".'); return; }
        if (!CANON_ID.test(id) || id.slice(2) === '00') { errors.push(id + ': id must be a canonical M<Area A–K><NN> id (e.g. MA01) — custom ids cannot be placed on the frozen grid.'); return; }
        if (seen.has(id)) { errors.push(id + ': duplicate id.'); return; }
        seen.add(id);
        if (!name) errors.push(id + ': missing "name".');
        if (!definition) errors.push(id + ': missing "definition".');
        let projectionType = r.projectionType != null ? String(r.projectionType) : 'signed_score';
        if (!PROJECTION_TYPES.includes(projectionType)) { errors.push(id + ': projectionType "' + projectionType + '" invalid (one of ' + PROJECTION_TYPES.join(', ') + ').'); projectionType = 'signed_score'; }
        let mstatus = r.status != null ? String(r.status) : 'ACTIVE';
        if (!METRIC_STATUSES.includes(mstatus)) { errors.push(id + ': status "' + mstatus + '" invalid (one of ' + METRIC_STATUSES.join(', ') + ').'); mstatus = 'ACTIVE'; }
        let norm = r.normalizationProfileId != null ? String(r.normalizationProfileId) : ('NORM-' + id + '-v1');
        if (!NORM_ID.test(norm)) { warnings.push(id + ': normalizationProfileId "' + norm + '" is not NORM-… — using "NORM-' + id + '-v1".'); norm = 'NORM-' + id + '-v1'; }
        const d = derive(id);
        if (!d.inFrozen) warnings.push(id + ': ordinal is outside the frozen area size (area ' + d.area + ' has ' + CARD[d.area] + ') — no standard grid cell; a reserved cell would be required to deploy.');
        if (r.family != null && r.family !== d.family) warnings.push(id + ': declared family "' + r.family + '" ignored — derived ' + d.family + '.');
        if (r.legacyId != null && r.legacyId !== d.legacyId) warnings.push(id + ': declared legacyId "' + r.legacyId + '" ignored — derived ' + (d.legacyId || 'none') + '.');
        if (r.grid != null) warnings.push(id + ': declared grid ignored — derived from id.');
        metrics.push({ id, legacyId: d.legacyId, name: name || id, family: d.family, familyColor: d.familyColor, grid: { index: d.grid.index, x: d.grid.x, y: d.grid.y }, definition, evidenceSources: cleanList(r.evidenceSources), failurePatterns: cleanList(r.failurePatterns), verdictImpact: r.verdictImpact != null ? String(r.verdictImpact).trim() : '', projectionType, normalizationProfileId: norm, status: mstatus, unit: r.unit != null ? String(r.unit).trim() : '' });
      });
      if (metrics.length > 100) warnings.push(metrics.length + ' metrics — the field holds 100 (10×10); extra metrics have no cell.');
      const ordByArea = {};
      for (const m of metrics) { const a = m.id[1], o = parseInt(m.id.slice(2), 10); (ordByArea[a] = ordByArea[a] || []).push(o); }
      Object.keys(ordByArea).forEach((a) => { const s = ordByArea[a].slice().sort((x, y) => x - y); if (!s.every((v, i) => v === i + 1)) warnings.push('Area ' + a + ' ordinals must be contiguous from 1 to deploy (got ' + s.join(', ') + ').'); });
      if (String(version).split('.')[0] === '3') { const present = new Set(metrics.map((m) => m.id)); let missing = 0; for (const a of AREAS) { for (let o = 1; o <= (CARD[a] || 0); o++) { if (!present.has('M' + a + pad2(o))) missing += 1; } } if (missing) warnings.push('version ' + version + ' (v3-major) requires the complete 96-metric frozen set — ' + missing + ' missing; the loader rejects an incomplete v3 catalogue.'); }
      metrics.sort((a, b) => (a.grid.index == null ? 1e9 : a.grid.index) - (b.grid.index == null ? 1e9 : b.grid.index));
      const families = {}; metrics.forEach((m) => { families[m.family] = (families[m.family] || 0) + 1; });
      const summary = { count: metrics.length, families, withEvidence: metrics.filter((m) => m.evidenceSources.length).length, catalogueId, version, status };
      return { ok: errors.length === 0 && metrics.length > 0, errors, warnings, metrics, cat: { catalogueId, version, status }, summary };
    }

    /* ---- loader-valid YAML (grid/family/legacy DERIVED → omitted) ---- */
    const yq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const yqOneLine = (s) => yq(String(s).replace(/\s+/g, ' ').trim());
    function toYaml(result) {
      const cat = result.cat, metrics = result.metrics, L = [];
      L.push('# CLU-E measurement catalogue — generated by the dashboard import ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
      L.push('# Deploy as a catalogue REVISION (not a hot swap):');
      L.push('#   1. replace config/measurements/catalogue.yaml with this file;');
      L.push('#   2. regenerate the Markdown catalogue + Catalogue-Content-Hash (the loader rejects a stale hash);');
      L.push('#   3. restart the daemon.');
      L.push('# grid coordinates, family, family colours and legacy aliases are DERIVED by the');
      L.push('# loader from each canonical id and are deliberately omitted here.');
      L.push('catalogueId: ' + cat.catalogueId);
      L.push('version: ' + JSON.stringify(cat.version));
      L.push('status: ' + cat.status);
      L.push('sourceArtifactHash: null');
      L.push('targetProfileIds: []');
      L.push('measures:');
      let curArea = null;
      for (const m of metrics) {
        const area = m.id[1];
        if (area !== curArea) { curArea = area; L.push('  # Area ' + area + ' — ' + (AREA_LABEL[area] || '') + ' (' + (FAM_LABEL[m.family] || m.family) + ')'); }
        L.push('  - id: ' + m.id);
        L.push('    name: ' + yqOneLine(m.name));
        L.push('    question: ' + yqOneLine(m.definition));
        if (m.evidenceSources.length) { L.push('    evidenceSources:'); m.evidenceSources.forEach((e) => L.push('      - ' + yqOneLine(e))); } else L.push('    evidenceSources: []');
        if (m.failurePatterns.length) { L.push('    failurePatterns:'); m.failurePatterns.forEach((e) => L.push('      - ' + yqOneLine(e))); } else L.push('    failurePatterns: []');
        L.push('    verdictImpact: ' + (m.verdictImpact ? yqOneLine(m.verdictImpact) : 'null'));
        L.push('    projectionType: ' + m.projectionType);
        L.push('    normalizationProfileId: ' + m.normalizationProfileId);
        L.push('    status: ' + m.status);
        L.push('');
      }
      return L.join('\n');
    }

    /* ---- overlay + state ---- */
    if (!document.getElementById('clue-import-style')) {
      const st = document.createElement('style');
      st.id = 'clue-import-style';
      st.textContent = `
.cfg-import{padding:5px 11px;border:1px solid rgba(155,140,255,.45);border-radius:7px;background:rgba(20,16,38,.72);color:#d7cfff;font:650 9.5px ui-monospace,Consolas,monospace;letter-spacing:.04em;cursor:pointer;transition:.15s ease}
.cfg-import:hover{border-color:rgba(155,140,255,.82);color:#efeaff;box-shadow:0 0 16px rgba(155,140,255,.18)}
.cfg-catselect{padding:4px 8px;border:1px solid rgba(103,189,229,.3);border-radius:6px;background:rgba(1,7,13,.6);color:#dff5ff;font:500 10px ui-monospace,Consolas,monospace;cursor:pointer;max-width:230px}
.cfg-catselect:focus{outline:none;border-color:rgba(155,140,255,.6)}
.clue-ov-bar button[data-apply]{white-space:nowrap}.clue-ov-bar button[disabled]{opacity:.4;cursor:not-allowed}
.mono2{font-family:ui-monospace,Consolas,monospace;color:#c7b8ff}
.imp-note{padding:11px 13px;border:1px solid rgba(155,140,255,.22);border-left-width:3px;border-radius:9px;background:linear-gradient(135deg,rgba(24,18,44,.6),rgba(6,8,20,.5));color:#c3c8e6;font:500 10.6px/1.62 ui-monospace,Consolas,monospace}.imp-note b{color:#e7e0ff}
.imp-paste{display:flex;flex-direction:column;gap:8px}.imp-paste textarea{width:100%;min-height:150px;box-sizing:border-box;padding:10px 12px;border:1px solid rgba(103,189,229,.23);border-radius:9px;background:rgba(1,7,13,.7);color:#dff5ff;font:500 11px/1.5 ui-monospace,Consolas,monospace;outline:none;resize:vertical}.imp-paste textarea:focus{border-color:rgba(155,140,255,.6);box-shadow:0 0 0 3px rgba(155,140,255,.1)}.imp-paste-actions{display:flex;gap:8px}.imp-paste-actions button{height:30px;padding:0 12px;border:1px solid rgba(155,140,255,.4);border-radius:7px;background:rgba(20,16,38,.7);color:#d7cfff;font:650 9px ui-monospace,Consolas,monospace;letter-spacing:.05em;cursor:pointer}
.imp-report{padding:11px 13px;border:1px solid;border-radius:10px;font:500 10.4px/1.55 ui-monospace,Consolas,monospace}.imp-report.ok{border-color:rgba(57,224,139,.34);background:linear-gradient(135deg,rgba(8,30,20,.5),rgba(4,12,10,.4))}.imp-report.bad{border-color:rgba(255,90,110,.4);background:linear-gradient(135deg,rgba(36,10,16,.5),rgba(14,5,8,.4))}.imp-rhead{color:#e6f6ff;font-weight:700;font-size:11px;margin-bottom:7px}.imp-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:2px}.imp-chip{font-size:8px;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border:1px solid;border-radius:999px}.imp-list{margin-top:7px;border-top:1px solid rgba(92,161,197,.16);padding-top:6px}.imp-lh{font-size:7.5px;letter-spacing:.14em;margin-bottom:3px}.imp-list.err .imp-lh{color:#ff8a99}.imp-list.warn .imp-lh{color:#ffcf8a}.imp-li{color:#b9c6d4;font-size:9.6px;margin:2px 0}.imp-list.err .imp-li{color:#ffc2cc}
.imp-previewhead{color:#8f9bd6;font:700 8.5px ui-monospace,Consolas,monospace;letter-spacing:.14em;margin-top:4px}
@media(prefers-reduced-motion:reduce){.cfg-import{transition:none}}`;
      document.head.appendChild(st);
    }

    const ov = CLUE_UI.makeOverlay('importOverlay', 'IMPORT METRIC CATALOGUE', 'Author or preview a measurement set · export a deploy-ready catalogue.yaml', { accent: '#9b8cff', code: 'IM' });
    const CANON_SNAP = (Array.isArray(window.__clueMetrics) ? window.__clueMetrics.slice() : []);
    const state = { name: '', result: null, pasteOpen: false, pasteText: '', rawText: '' };
    let fileInput = null;

    function statusText() {
      if (!state.result) return 'No catalogue loaded';
      const r = state.result;
      return (state.name ? esc(state.name) + ' · ' : '') + r.metrics.length + ' metric' + (r.metrics.length === 1 ? '' : 's') + ' · ' + r.errors.length + ' error' + (r.errors.length === 1 ? '' : 's') + ' · ' + r.warnings.length + ' warning' + (r.warnings.length === 1 ? '' : 's');
    }

    function render() {
      const r = state.result, canApply = !!(r && r.ok);
      const bar = '<div class="clue-ov-bar">'
        + '<button data-choose>⇱ Choose .json</button>'
        + '<button data-paste>⌨ Paste JSON</button>'
        + '<button data-example>Load example</button>'
        + '<span class="cnt" data-status>' + statusText() + '</span>'
        + '<span style="flex:1"></span>'
        + '<button data-apply ' + (canApply ? '' : 'disabled') + ' style="' + (canApply ? 'border-color:rgba(155,140,255,.6);color:#e7e0ff' : '') + '">Apply</button>'
        + '<button data-upload ' + (canApply ? '' : 'disabled') + ' title="Store this catalogue in the server library">⇧ Upload to server</button>'
        + '<button data-yaml ' + (canApply ? '' : 'disabled') + '>⇩ catalogue.yaml</button>'
        + '<button data-restorecanon title="Revert the preview to the canonical catalogue">Restore canonical</button>'
        + '</div>';

      let body = '<div class="clue-ov-list">';
      body += '<div class="imp-note"><b>What this does.</b> Load a catalogue JSON — a list of measures with their descriptions — to preview it here and swap the <b>Measurement catalogue</b> view for this session. Pick a server-hosted catalogue from <b>Configure</b>, or choose a local file / paste one here; <b>⇧ Upload to server</b> stores the loaded catalogue in the shared library. Metric ids must be canonical (<span class="mono2">MA01</span> … <span class="mono2">MK18</span>); family, colour, grid cell and legacy id are derived from the id, exactly like the engine. <b>To deploy it for real,</b> export <span class="mono2">catalogue.yaml</span> and apply it as a catalogue revision (replace the file, regenerate the content hash, restart) — the browser preview alone does not change what CLU-E measures.</div>';

      if (state.pasteOpen) body += '<div class="imp-paste"><textarea data-pastebox spellcheck="false" placeholder=\'{ "metrics": [ { "id": "MA01", "name": "…", "definition": "…" } ] }\'></textarea><div class="imp-paste-actions"><button data-parsepaste>Validate pasted JSON</button></div></div>';

      if (r) {
        const s = r.summary;
        const chips = Object.keys(s.families).map((f) => '<span class="imp-chip" style="border-color:' + (FAM_COLOR[f] || '#00a3e0') + ';color:' + (FAM_COLOR[f] || '#00a3e0') + '">' + esc(FAM_LABEL[f] || f) + ' ' + s.families[f] + '</span>').join('');
        body += '<div class="imp-report ' + (r.ok ? 'ok' : 'bad') + '">'
          + '<div class="imp-rhead">' + (r.ok ? '✓ Valid — ready to apply or export' : '✗ Cannot apply — fix the errors below') + ' · <span class="mono2">' + esc(s.catalogueId) + '</span> v' + esc(s.version) + ' · ' + s.count + ' metrics · ' + s.withEvidence + ' with evidence</div>'
          + '<div class="imp-chips">' + chips + '</div>'
          + (r.errors.length ? '<div class="imp-list err"><div class="imp-lh">ERRORS (block apply)</div>' + r.errors.map((e) => '<div class="imp-li">• ' + esc(e) + '</div>').join('') + '</div>' : '')
          + (r.warnings.length ? '<div class="imp-list warn"><div class="imp-lh">WARNINGS</div>' + r.warnings.map((e) => '<div class="imp-li">• ' + esc(e) + '</div>').join('') + '</div>' : '')
          + '</div>';
        if (r.metrics.length) {
          body += '<div class="imp-previewhead">PREVIEW · ' + r.metrics.length + ' measures as they will appear in the catalogue</div>';
          let curArea = null;
          for (const m of r.metrics) {
            const area = m.id[1];
            if (area !== curArea) { curArea = area; body += '<div class="mx-grp">AREA ' + esc(area) + ' · ' + esc(AREA_LABEL[area] || '') + '</div>'; }
            body += '<div class="mx-e" style="border-left-color:' + m.familyColor + '">'
              + '<div class="mx-r1"><span class="mx-id">' + esc(m.id) + '</span><span class="mx-leg">' + esc(m.legacyId || '—') + ' · ' + (m.grid.x == null ? '—' : m.grid.x) + ',' + (m.grid.y == null ? '—' : m.grid.y) + '</span><span class="mx-nm">' + esc(m.name) + '</span><span class="mx-fam" style="color:' + m.familyColor + '">' + esc(FAM_LABEL[m.family] || m.family) + ' · ' + esc(m.status) + '</span></div>'
              + '<div class="mx-def">' + esc(m.definition || '(no description)') + '</div>'
              + '</div>';
          }
        }
      } else {
        body += '<div class="clue-ov-empty">Choose a <span class="mono2">.json</span> catalogue or paste JSON to begin.<br>Use <b>Load example</b> to see the expected shape.</div>';
      }
      body += '</div>';
      ov.body.innerHTML = bar + body;
      ov.setSub(state.result ? statusText() : 'Author or preview a measurement set · export a deploy-ready catalogue.yaml');
      wire();
    }

    function ensureFileInput() {
      if (fileInput && fileInput.isConnected) return fileInput;
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => loadText(String(rd.result || ''), f.name);
        rd.onerror = () => { state.name = f.name; state.result = { ok: false, errors: ['Could not read file.'], warnings: [], metrics: [], summary: { count: 0, families: {}, withEvidence: 0, catalogueId: '—', version: '—' } }; render(); };
        rd.readAsText(f);
        fileInput.value = '';
      });
      document.body.appendChild(fileInput);
      return fileInput;
    }

    function loadText(text, name) {
      state.name = name || 'pasted.json';
      state.rawText = text || '';
      state.pasteText = state.pasteOpen ? (text || '') : state.pasteText;
      state.result = validate(text, state.name);
      render();
    }

    function applyResult(r) {
      if (!r || !r.ok) return false;
      window.__clueMetrics = r.metrics.map((m) => ({ id: m.id, legacyId: m.legacyId, name: m.name, family: m.family, familyColor: m.familyColor, grid: { index: m.grid.index, x: m.grid.x, y: m.grid.y }, definition: m.definition, evidenceSources: m.evidenceSources.slice(), failurePatterns: m.failurePatterns.slice(), verdictImpact: m.verdictImpact, projectionType: m.projectionType, status: m.status, unit: m.unit }));
      window.__clueMetricsMeta = { source: r.summary.catalogueId + ' (session)', count: r.metrics.length };
      try { if (window.__q2Field && window.__q2Field.setExcluded) window.__q2Field.setExcluded([...(window.__clueExcluded || [])]); } catch (e) { /* Q2 optional */ }
      try { ClueInterface.pulse('q2'); } catch (e) { /* pulse optional */ }
      try { if (window.__q2Field && window.__q2Field.refresh) window.__q2Field.refresh(); } catch (e) { /* Q2 optional */ }
      return true;
    }
    function apply() {
      const r = state.result;
      if (!applyResult(r)) return;
      const st = ov.body.querySelector('[data-status]');
      if (st) st.innerHTML = 'Applied ✓ · ' + r.metrics.length + ' metrics now in the catalogue view — open ⊞ METRICS to review. Export catalogue.yaml to deploy.';
    }

    function restoreCanonical() {
      try {
        window.__clueMetrics = CANON_SNAP.slice();
        window.__clueMetricsMeta = { source: 'canonical', count: CANON_SNAP.length };
        try { if (window.__q2Field && window.__q2Field.setExcluded) window.__q2Field.setExcluded([...(window.__clueExcluded || [])]); } catch (e) { /* Q2 optional */ }
        try { ClueInterface.pulse('q2'); } catch (e) { /* pulse optional */ }
        try { if (window.__q2Field && window.__q2Field.refresh) window.__q2Field.refresh(); } catch (e) { /* Q2 optional */ }
        const st = ov.body.querySelector('[data-status]');
        if (st) st.innerHTML = 'Restored ✓ · ' + CANON_SNAP.length + ' canonical measures back in the catalogue view.';
      } catch (e) { const st = ov.body.querySelector('[data-status]'); if (st) st.textContent = 'Restore failed: ' + e.message; }
    }

    function download() {
      const r = state.result;
      if (!r || !r.ok) return;
      try {
        const blob = new Blob([toYaml(r)], { type: 'text/yaml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'catalogue.yaml';
        document.body.appendChild(a);
        a.click();
        requestAnimationFrame(() => { a.remove(); URL.revokeObjectURL(url); });
      } catch (e) { const st = ov.body.querySelector('[data-status]'); if (st) st.textContent = 'Export failed: ' + e.message; }
    }

    const EXAMPLE = JSON.stringify({
      catalogueId: 'MCAT-example', version: '1.0', status: 'ACTIVE',
      metrics: [
        { id: 'MA01', name: 'Purpose alignment', definition: 'Does the unit and the whole program still serve the reason they exist?', projectionType: 'signed_score', evidenceSources: ['mission documents', 'user-visible outcomes'], failurePatterns: ['narrowing purpose to move the metric'], verdictImpact: 'Failure triggers REJECTED_PURPOSE_VIOLATION' },
        { id: 'MA02', name: 'Utility and value realization', definition: 'Does the unit deliver real value to users, the system or a recovery path?', projectionType: 'signed_score' },
        { id: 'MJ01', name: 'Proof gate', definition: 'Does every landed change carry a valid, non-broken proof?', projectionType: 'gate_state', status: 'ACTIVE' }
      ]
    }, null, 2);

    function openWithCatalogue(doc, sourceName) {
      let text;
      try { text = JSON.stringify(doc); } catch (e) { text = String(doc); }
      state.name = sourceName || 'server catalogue';
      state.rawText = text;
      state.pasteOpen = false;
      state.result = validate(text, state.name);
      ov.open();
      render();
    }

    async function uploadCurrent() {
      const r = state.result;
      if (!r || !r.ok) return;
      const status = ov.body.querySelector('[data-status]');
      let doc;
      try { doc = JSON.parse(state.rawText); } catch (e) { if (status) status.textContent = 'Upload failed: the loaded source is not valid JSON.'; return; }
      if (status) status.textContent = 'Uploading to the server library…';
      try {
        const published = await actionClient.invoke('publishCatalogue', { name: r.summary.catalogueId, catalogue: doc });
        if (!published.ok) throw new Error(published.reason);
        const out = published.result ?? {};
        const stored = out && out.stored ? String(out.stored) : '';
        if (status) status.innerHTML = 'Uploaded ✓ to the server library' + (stored ? ' as <span class="mono2">' + esc(stored) + '</span>' : '') + ' — it now appears in Configure.';
      } catch (e) { if (status) status.textContent = 'Upload failed: ' + e.message; }
    }

    function wire() {
      const q = (sel) => ov.body.querySelector(sel);
      const c = q('[data-choose]'); if (c) c.addEventListener('click', () => ensureFileInput().click());
      const p = q('[data-paste]'); if (p) p.addEventListener('click', () => { state.pasteOpen = !state.pasteOpen; render(); if (state.pasteOpen) requestAnimationFrame(() => { const t = ov.body.querySelector('[data-pastebox]'); if (t) t.focus(); }); });
      const ex = q('[data-example]'); if (ex) ex.addEventListener('click', () => { state.pasteOpen = true; state.pasteText = EXAMPLE; render(); requestAnimationFrame(() => { const t = ov.body.querySelector('[data-pastebox]'); if (t) t.focus(); }); });
      const pp = q('[data-parsepaste]'); if (pp) pp.addEventListener('click', () => { const t = ov.body.querySelector('[data-pastebox]'); loadText(t ? t.value : '', 'pasted.json'); });
      const ap = q('[data-apply]'); if (ap) ap.addEventListener('click', apply);
      const rc = q('[data-restorecanon]'); if (rc) rc.addEventListener('click', restoreCanonical);
      const yb = q('[data-yaml]'); if (yb) yb.addEventListener('click', download);
      const ub = q('[data-upload]'); if (ub) ub.addEventListener('click', uploadCurrent);
      const tb = q('[data-pastebox]'); if (tb) { tb.value = state.pasteText || ''; tb.addEventListener('input', (e) => { state.pasteText = e.target.value; }); }
    }

    function pickFile() { ov.open(); render(); ensureFileInput().click(); }

    window.__clueImport = { open: () => { ov.open(); render(); }, pickFile, openWithCatalogue, uploadCurrent, close: () => ov.close(), overlay: ov, validate, toYaml, applyResult, restoreCanonical };
  } catch (e) { console.error('[Import] init failed (dashboard continues):', e); }
})();



/* ===================== Recognition backlog viewer ========================
 * Surfaces snapshot.dashboard.recognition.findings (priority-ordered) as a
 * reviewable, deferrable backlog. Findings are minted with SEQUENTIAL ids, so
 * exclusions are keyed to a CONTENT-STABLE key (target::category): a finding
 * re-detected in a later cycle carries a new findingId but the same key, so it
 * reconciles against a prior defer instead of duplicating. Deferred findings are
 * snapshotted to localStorage so they remain visible across cycles even when a
 * cycle does not re-detect them. Honest empty state until deep review produces
 * findings (the current projector emits none).
 * ======================================================================== */
(function initBacklogViewer() {
  try {
    const esc = CLUE_UI.esc;
    const btn = CLUE_UI.panelButton('q1', 'backlogBtn', '\u2691 BACKLOG', 'Recognition backlog — prioritised findings; defer to carry them across cycles');
    if (!btn) { console.warn('[Backlog] rail not found'); return; }
    const ov = CLUE_UI.makeOverlay('backlogOverlay', 'RECOGNITION BACKLOG', 'Prioritised findings from recognition · defer to exclude from improvement areas', { accent: '#2dd4bf', code: 'BL' });
    window.__clueBacklog = ov;

    if (!document.getElementById('clue-backlog-style')) {
      const st = document.createElement('style');
      st.id = 'clue-backlog-style';
      st.textContent = `
.bk-pri{flex:0 0 auto;min-width:24px;text-align:center;color:#04201c;background:#2dd4bf;border-radius:5px;padding:2px 6px;font:800 9.5px ui-monospace,Consolas,monospace}
.bk-pri.bk-def{color:#8fb8c8;background:transparent;border:1px solid rgba(120,170,190,.35);font-weight:600}
.bk-target{color:#8fb0c4;font:500 10px ui-monospace,Consolas,monospace;word-break:break-all}
.bk-ev{font-size:7.5px;letter-spacing:.07em;text-transform:uppercase;padding:2px 7px;border:1px solid;border-radius:999px;flex:0 0 auto}
.bk-e .mx-nm{font-weight:700}`;
      document.head.appendChild(st);
    }

    const EV = {
      candidate: { label: 'candidate', color: '#5f7d99' },
      observed: { label: 'observed', color: '#00a3e0' },
      hypothesis: { label: 'hypothesis', color: '#f4af2d' },
      proof_designed: { label: 'proof designed', color: '#8fe6ff' },
      baseline_captured: { label: 'baseline captured', color: '#c77dff' },
      proven: { label: 'proven', color: '#39ff88' },
      refuted: { label: 'refuted', color: '#ff5500' },
    };
    const evColor = (e) => (EV[e] && EV[e].color) || '#5f7d99';
    const evLabel = (e) => (EV[e] && EV[e].label) || String(e || 'unknown');

    // content-stable dedup key: same (target, category) across cycles
    const keyOf = (f) => String(f && f.target || '').trim().toLowerCase() + '::' + String(f && f.category || '').trim().toLowerCase();

    const LS_DEFER = 'clue.backlog.deferred';
    let deferred = {};
    try { deferred = JSON.parse((window.localStorage && window.localStorage.getItem(LS_DEFER)) || '{}') || {}; } catch (e) { deferred = {}; }
    const persist = () => { try { window.localStorage.setItem(LS_DEFER, JSON.stringify(deferred)); } catch (e) { /* storage optional */ } };
    window.__clueBacklogDeferred = deferred;

    let findings = [];
    let lastFrameSeen = false;
    let currentQuery = '';
    let probeMode = false;

    const snapOf = (f) => ({ key: keyOf(f), target: f.target || '', category: f.category || '', evidence: f.evidence || 'candidate', mitigationEase: f.mitigationEase, predictedValue: f.predictedValue || '', risk: f.risk || '', nextAction: f.nextAction || '', deferredAt: new Date().toISOString() });

    function setDeferred(f, off) {
      const k = keyOf(f);
      if (off) deferred[k] = snapOf(f); else delete deferred[k];
      persist();
    }
    window.__clueBacklogDefer = (f, off) => { setDeferred(f, off); if (ov.isOpen()) render(); };

    // Console-probe seam (backlog-findings-probe.console.js). While probe mode is on, live
    // sealed frames are ignored so injected simulated findings are not clobbered.
    window.__clueBacklogFeed = {
      setFindings: (list) => { probeMode = true; findings = Array.isArray(list) ? list.slice() : []; lastFrameSeen = true; if (ov.isOpen()) render(); return findings.length; },
      clear: () => { findings = []; if (ov.isOpen()) render(); },
      restore: () => { probeMode = false; try { const fr = ConsoleFrameBus.getLastFrame(); const list = fr && fr.snapshot && fr.snapshot.dashboard && fr.snapshot.dashboard.recognition && fr.snapshot.dashboard.recognition.findings; findings = Array.isArray(list) ? list : []; } catch (e) { findings = []; } if (ov.isOpen()) render(); },
      getFindings: () => findings.slice(),
      isProbeMode: () => probeMode,
    };

    ConsoleFrameBus.subscribe((frame) => {
      if (probeMode) return;
      try {
        const list = frame && frame.snapshot && frame.snapshot.dashboard && frame.snapshot.dashboard.recognition && frame.snapshot.dashboard.recognition.findings;
        findings = Array.isArray(list) ? list : [];
        lastFrameSeen = true;
        if (ov.isOpen()) render();
      } catch (e) { /* one bad frame does not break the backlog */ }
    });

    btn.addEventListener('click', () => { ov.open(); render(); });

    function detailHtml(f, findingId, isDeferred) {
      const s = [];
      if (f.predictedValue) s.push(`<div class="mxd-sec"><span class="mxd-h">PREDICTED VALUE OF FIXING</span>${esc(f.predictedValue)}</div>`);
      if (f.risk) s.push(`<div class="mxd-sec"><span class="mxd-h">RISK</span>${esc(f.risk)}</div>`);
      if (f.nextAction) s.push(`<div class="mxd-sec"><span class="mxd-h">RECOMMENDED NEXT ACTION</span>${esc(f.nextAction)}</div>`);
      s.push(`<div class="mxd-meta">${findingId ? 'finding ' + esc(String(findingId)) + ' · ' : ''}target ${esc(f.target || '—')} · evidence ${esc(evLabel(f.evidence))}${isDeferred && f.deferredAt ? ' · deferred ' + esc(String(f.deferredAt).slice(0, 10)) : ''}</div>`);
      return s.join('');
    }

    function row(f, opts) {
      const off = !!opts.off, rank = opts.rank, findingId = opts.findingId, isDeferred = !!opts.isDeferred;
      const ec = evColor(f.evidence);
      const ease = (f.mitigationEase == null || isNaN(Number(f.mitigationEase))) ? null : Math.round(Number(f.mitigationEase));
      return `<div class="mx-e bk-e${off ? ' excluded' : ''}" data-key="${esc(keyOf(f))}" style="border-left-color:${ec}">
<div class="mx-r1"><label class="mx-tog" title="include in / defer from improvement areas"><input type="checkbox" data-tog aria-label="Include this finding in improvement areas"${off ? '' : ' checked'}><span class="mx-sw"></span></label>${rank ? `<span class="bk-pri">#${rank}</span>` : '<span class="bk-pri bk-def">deferred</span>'}<span class="mx-nm">${esc(f.category || 'finding')}</span><span class="bk-target">${esc(f.target || '')}</span><span class="bk-ev" style="color:${ec};border-color:${ec}">${esc(evLabel(f.evidence))}</span><span class="mx-fam" style="color:#8fb8c8">${ease == null ? '' : 'ease ' + ease + '%'}</span><span class="mx-caret">▸</span></div>
<div class="mx-detail">${detailHtml(f, findingId, isDeferred)}</div></div>`;
    }

    function render(refocus) {
      const deferredKeys = new Set(Object.keys(deferred));
      const liveKeys = new Set(findings.map(keyOf));
      const activeCount = findings.filter((f) => !deferredKeys.has(keyOf(f))).length;
      const orphanDeferred = Object.keys(deferred).filter((k) => !liveKeys.has(k)).map((k) => deferred[k]);
      const ql = currentQuery.trim().toLowerCase();
      const match = (f) => !ql || (String(f.category || '') + ' ' + String(f.target || '') + ' ' + String(f.nextAction || '') + ' ' + String(f.predictedValue || '')).toLowerCase().includes(ql);

      const bar = `<div class="clue-ov-bar"><input class="bkSearch" type="text" placeholder="search category, target, action…" value="${esc(currentQuery)}"><span class="cnt"><b style="color:#2dd4bf">${activeCount} active</b> · ${deferredKeys.size} deferred · ${findings.length} detected</span><button data-refresh>↻ refresh</button></div>`;

      let html = '';
      if (!findings.length && !orphanDeferred.length) {
        html = lastFrameSeen
          ? `<div class="clue-ov-empty">No findings in the backlog yet.<br>Findings appear here once CLU-E's <b>deep-review</b> phase surfaces them from recognition — recognition is complete; deep review is the next phase.<br><br><span style="color:#4d6b7d">Each finding lists its priority, evidence state, predicted value, risk, and recommended next action. Toggle one off to defer it — it stays in the backlog across cycles and will not duplicate if re-detected.</span></div>`
          : `<div class="clue-ov-loading">connecting to the sealed frame…</div>`;
      } else {
        const liveRows = findings.map((f, i) => ({ f, i })).filter(({ f }) => match(f));
        if (liveRows.length) {
          html += `<div class="mx-grp">CURRENT CYCLE · ${findings.length} finding${findings.length === 1 ? '' : 's'} · priority order</div>`;
          for (const { f, i } of liveRows) html += row(f, { rank: i + 1, off: deferredKeys.has(keyOf(f)), findingId: f.findingId, isDeferred: false });
        }
        const orphanRows = orphanDeferred.filter(match);
        if (orphanRows.length) {
          html += `<div class="mx-grp">DEFERRED · not re-detected this cycle · ${orphanDeferred.length}</div>`;
          for (const d of orphanRows) html += row(d, { rank: null, off: true, findingId: null, isDeferred: true });
        }
        if (!liveRows.length && !orphanRows.length) html += `<div class="clue-ov-empty">no findings match the search</div>`;
      }

      ov.body.innerHTML = bar + `<div class="clue-ov-list" data-list>${html}</div>`;
      ov.setSub(`${activeCount} active · ${deferredKeys.size} deferred${findings.length ? ' · ' + findings.length + ' detected this cycle' : ''}`);
      wire(refocus);
    }

    function wire(refocus) {
      const inp = ov.body.querySelector('.bkSearch');
      if (inp) {
        inp.addEventListener('input', (e) => { currentQuery = e.target.value; render(true); });
        if (refocus) requestAnimationFrame(() => { inp.focus({ preventScroll: true }); inp.setSelectionRange(currentQuery.length, currentQuery.length); });
      }
      const rf = ov.body.querySelector('[data-refresh]');
      if (rf) rf.addEventListener('click', () => { try { const fr = ConsoleFrameBus.getLastFrame(); const list = fr && fr.snapshot && fr.snapshot.dashboard && fr.snapshot.dashboard.recognition && fr.snapshot.dashboard.recognition.findings; if (Array.isArray(list)) findings = list; } catch (e) { /* keep last */ } render(); });
      const list = ov.body.querySelector('[data-list]');
      if (list) {
        for (const r of list.querySelectorAll('.bk-e')) { r.tabIndex = 0; r.setAttribute('role', 'button'); r.setAttribute('aria-expanded', String(r.classList.contains('open'))); }
        list.addEventListener('change', (event) => {
          const t = event.target;
          if (t && t.getAttribute && t.getAttribute('data-tog') !== null) {
            const rowEl = t.closest('.bk-e'); const k = rowEl.getAttribute('data-key'); const off = !t.checked;
            const f = findings.find((x) => keyOf(x) === k) || deferred[k];
            if (f) { setDeferred(f, off); render(); }
          }
        });
        const toggleRow = (r) => { if (!r) return; r.classList.toggle('open'); r.setAttribute('aria-expanded', String(r.classList.contains('open'))); };
        list.addEventListener('click', (event) => { if (event.target.closest && event.target.closest('.mx-tog')) return; toggleRow(event.target.closest && event.target.closest('.bk-e')); });
        list.addEventListener('keydown', (event) => { if (event.key !== 'Enter' && event.key !== ' ') return; const r = event.target.closest && event.target.closest('.bk-e'); if (!r || (event.target.closest && event.target.closest('.mx-tog'))) return; event.preventDefault(); toggleRow(r); });
      }
    }
  } catch (e) { console.error('[Backlog] init failed (dashboard continues):', e); }
})();
