export const navigatorStyles = /* css */ `
:host {
  --clue-black: #000000;
  --clue-blue: #00a3e0;
  --clue-gold: #f4af2d;
  --clue-orange: #ff5500;
  --clue-patch-green: #39ff88;
  --clue-font: "Rajdhani", "Orbitron", "Segoe UI", system-ui, sans-serif;
  display: block;
  position: relative;
  min-width: 320px;
  min-height: 320px;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--clue-blue);
  background: #000;
  font-family: var(--clue-font);
  font-variant-numeric: tabular-nums;
  isolation: isolate;
}

* { box-sizing: border-box; }

.navigator-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 42%, rgba(0, 163, 224, 0.08), transparent 43%),
    #000;
  user-select: none;
  touch-action: none;
}

.graph-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  outline: none;
}

.frame {
  position: absolute;
  inset: 10px;
  pointer-events: none;
  border: 1px solid rgba(0, 163, 224, 0.44);
  clip-path: polygon(18px 0, calc(100% - 30px) 0, 100% 30px, 100% calc(100% - 18px), calc(100% - 18px) 100%, 18px 100%, 0 calc(100% - 18px), 0 18px);
  box-shadow:
    inset 0 0 28px rgba(0, 163, 224, 0.05),
    0 0 16px rgba(0, 163, 224, 0.10);
}

.frame::before,
.frame::after {
  content: "";
  position: absolute;
  height: 1px;
  left: 26px;
  right: 26px;
  background: linear-gradient(90deg, transparent, rgba(0, 163, 224, 0.88), transparent);
  filter: drop-shadow(0 0 5px var(--clue-blue));
  animation: frameSweep 7s linear infinite;
}
.frame::before { top: 5px; }
.frame::after { bottom: 5px; animation-direction: reverse; }

@keyframes frameSweep {
  0% { transform: scaleX(0.18) translateX(-220%); opacity: 0.15; }
  45% { opacity: 0.95; }
  100% { transform: scaleX(0.18) translateX(220%); opacity: 0.15; }
}

.inspector-kicker,
.quick-label-kind,
.legend-title {
  font-size: 10px;
  letter-spacing: 0.23em;
  text-transform: uppercase;
  opacity: 0.78;
}

/* Bottom-right scan/units badge — glass panel (translucent over the graph), legend-sized.
   Alternates every 10s: FILE SCAN bar ↔ all recognized-unit categories inline on one line.
   The visible face is in normal flow so the glass wraps it snugly (narrow for the bar, wide
   for the counts); the hidden face overlays, faded out. */
.scan-badge {
  position: absolute;
  right: 26px;
  bottom: 23px;
  z-index: 9;
  max-width: calc(100% - 52px);
  padding: 7px 11px;
  pointer-events: none;
  color: var(--clue-blue);
  background: rgba(0, 8, 12, 0.34);
  border: 1px solid rgba(0, 163, 224, 0.20);
  clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
  backdrop-filter: blur(14px) saturate(1.25);
  box-shadow: inset 0 0 16px rgba(0, 163, 224, 0.05), 0 4px 18px rgba(0, 0, 0, 0.28);
  font-variant-numeric: tabular-nums;
}
.scan-badge[data-state="failed"] { color: var(--clue-orange); border-color: color-mix(in srgb, var(--clue-orange) 40%, transparent); }
.scan-badge.pulse { box-shadow: inset 0 0 20px rgba(0,163,224,0.10), 0 4px 22px rgba(0,0,0,0.30), 0 0 16px rgba(0,163,224,0.22); }

/* Active face flows (drives glass width); inactive face overlays at the content origin, faded. */
.scan-badge .badge-face { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; transition: opacity 380ms ease; }
.scan-badge .badge-scan { opacity: 1; }
.scan-badge .badge-units { position: absolute; left: 11px; top: 7px; opacity: 0; flex-wrap: wrap; gap: 4px 12px; }
.scan-badge[data-mode="units"] .badge-scan { position: absolute; left: 11px; top: 7px; opacity: 0; }
.scan-badge[data-mode="units"] .badge-units { position: static; opacity: 1; }

.scan-badge .badge-label { color: rgba(185, 225, 237, 0.66); font-size: 8px; letter-spacing: 0.10em; text-transform: uppercase; }
.scan-badge .badge-track { position: relative; width: 84px; height: 2px; overflow: hidden; background: rgba(0, 163, 224, 0.14); }
.scan-badge .badge-fill { position: absolute; inset: 0 auto 0 0; width: 0%; background: linear-gradient(90deg, var(--clue-blue), #9ce8ff, var(--clue-gold)); box-shadow: 0 0 6px var(--clue-blue); transition: width 240ms cubic-bezier(.2,.7,.1,1); }
.scan-badge .badge-sweep { position: absolute; top: -1px; bottom: -1px; width: 30px; background: linear-gradient(90deg, transparent, rgba(255,255,255,.8), transparent); animation: badgeSweep 1.7s linear infinite; }
@keyframes badgeSweep { from { left: -34px; } to { left: calc(100% + 34px); } }
.scan-badge[data-mode="units"] .badge-sweep,
.scan-badge[data-state="committed"] .badge-sweep,
.scan-badge[data-state="failed"] .badge-sweep,
.scan-badge[data-state="idle"] .badge-sweep { display: none; }
.scan-badge .badge-percent { color: var(--clue-gold); font-size: 10px; letter-spacing: 0.04em; }

/* Inline categories: "3 DOMAINS  8 SUBSYSTEMS  42 MODULES  210 FILES …" */
.scan-badge .cat { display: inline-flex; align-items: baseline; gap: 4px; }
.scan-badge .badge-count { color: rgba(230, 250, 255, 0.94); font-size: 12px; font-weight: 500; }
.scan-badge .badge-unit { color: var(--clue-blue); font-size: 8px; letter-spacing: 0.12em; text-transform: uppercase; }

.breadcrumb {
  position: absolute;
  top: 24px;
  left: 26px;
  max-width: calc(100% - 240px);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  pointer-events: none;
  color: rgba(0, 163, 224, 0.74);
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  text-shadow: 0 0 8px rgba(0, 163, 224, 0.4);
}
.breadcrumb .separator { color: var(--clue-gold); opacity: 0.8; }
/* White directory of the clicked element; the segment at the current view granularity is blue. */
.breadcrumb .crumb {
  color: rgba(225, 249, 255, 0.95);
  font-weight: 500;
  transition: color 160ms ease, text-shadow 160ms ease;
}
.breadcrumb .crumb[data-id] { pointer-events: auto; cursor: pointer; outline: none; }
.breadcrumb .crumb[data-id]:hover,
.breadcrumb .crumb[data-id]:focus-visible {
  color: #ffffff;
  text-shadow: 0 0 10px rgba(0, 163, 224, 0.85);
}
.breadcrumb .crumb.current { color: var(--clue-blue); text-shadow: 0 0 10px rgba(0, 163, 224, 0.8); }
.breadcrumb .crumb.ghost { opacity: 0.85; font-style: italic; pointer-events: none; }

.quick-label {
  position: absolute;
  z-index: 8;
  min-width: 150px;
  max-width: 330px;
  padding: 8px 11px 9px;
  pointer-events: none;
  opacity: 0;
  transform: translate(14px, -50%) scale(.96);
  transition: opacity 110ms linear, transform 180ms ease-out;
  background: rgba(0, 5, 8, 0.86);
  border-left: 2px solid var(--quick-color, var(--clue-blue));
  border-top: 1px solid color-mix(in srgb, var(--quick-color, var(--clue-blue)) 60%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--quick-color, var(--clue-blue)) 28%, transparent);
  clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 0 100%);
  backdrop-filter: blur(12px);
  box-shadow: 0 0 18px color-mix(in srgb, var(--quick-color, var(--clue-blue)) 16%, transparent);
}
.quick-label.visible { opacity: 1; transform: translate(14px, -50%) scale(1); }
.quick-label-name {
  margin-top: 3px;
  color: rgba(235, 251, 255, 0.96);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.label-layer {
  position: absolute; inset: 0; z-index: 6; pointer-events: none; overflow: hidden;
}
.node-label {
  position: absolute; transform: translate(-50%, -50%);
  font-family: 'Consolas', 'SF Mono', monospace; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap;
  color: rgba(214, 236, 255, 0.92);
  text-shadow: 0 0 6px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 1), 0 0 14px var(--label-glow, rgba(33,199,255,.55));
  opacity: 0; transition: opacity 160ms ease; will-change: left, top;
}
.node-label.visible { opacity: 1; }
.dragon-overlay {
  position: absolute; z-index: 7; pointer-events: none;
  transform: translate(-50%, -50%);
  opacity: 0; transition: opacity 420ms ease;
  filter: drop-shadow(0 0 26px rgba(0, 168, 107, 0.35));
}
.dragon-overlay.visible { opacity: 1; }
.dragon-overlay svg { display: block; width: 100%; height: 100%; }

.inspector-layer {
  position: absolute;
  inset: 0;
  z-index: 11;
  pointer-events: none;
}
.inspector-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; opacity: 0; transition: opacity 200ms ease; }
.inspector-layer.visible .inspector-svg { opacity: 1; }
.inspector-leader-back {
  fill: none;
  stroke: rgba(0,0,0,.92);
  stroke-width: 5;
  vector-effect: non-scaling-stroke;
}
.inspector-leader {
  fill: none;
  stroke: var(--inspector-color, var(--clue-blue));
  stroke-width: 1.5;
  stroke-dasharray: 640;
  stroke-dashoffset: 640;
  filter: drop-shadow(0 0 5px var(--inspector-color, var(--clue-blue)));
  vector-effect: non-scaling-stroke;
}
.inspector-layer.visible .inspector-leader { animation: leaderTrace 420ms cubic-bezier(.2,.75,.15,1) forwards; }
@keyframes leaderTrace { to { stroke-dashoffset: 0; } }

.inspector-panel {
  position: absolute;
  width: min(440px, calc(100% - 36px));
  min-height: 410px;
  max-height: min(590px, calc(100% - 44px));
  overflow: hidden;
  opacity: 0;
  transform: translateY(7px) scale(.972);
  transform-origin: var(--panel-origin, 50% 50%);
  transition: opacity 170ms ease, transform 310ms cubic-bezier(.16,.8,.2,1);
  color: rgba(216, 247, 255, 0.92);
  background:
    linear-gradient(155deg, color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 12%, transparent), transparent 28%),
    linear-gradient(120deg, rgba(5,18,24,.72), rgba(0,0,0,.93));
  border: 1px solid color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 74%, transparent);
  clip-path: polygon(18px 0, calc(100% - 45px) 0, 100% 45px, 100% calc(100% - 17px), calc(100% - 17px) 100%, 0 100%, 0 18px);
  backdrop-filter: blur(24px) saturate(1.4);
  box-shadow:
    inset 0 0 45px color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 7%, transparent),
    0 0 32px color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 14%, transparent);
}
.inspector-layer.visible .inspector-panel { opacity: 1; transform: translateY(0) scale(1); }
.inspector-panel::before {
  content: "";
  position: absolute;
  inset: 5px;
  border-top: 1px solid color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 30%, transparent);
  border-left: 1px solid color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 20%, transparent);
  clip-path: inherit;
  pointer-events: none;
}
.inspector-panel::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 8%, transparent) 48%, transparent 56%);
  transform: translateY(-120%);
  animation: inspectorScan 3.8s linear infinite;
  pointer-events: none;
}
@keyframes inspectorScan { to { transform: translateY(120%); } }

.inspector-inner { position: relative; z-index: 2; padding: 20px 22px 18px; }
.inspector-header {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 15px;
  align-items: start;
  padding-bottom: 13px;
  border-bottom: 1px solid color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 28%, transparent);
}
.inspector-name {
  margin: 6px 0 0;
  color: #edfaff;
  font-size: clamp(20px, 2vw, 29px);
  line-height: 1.02;
  font-weight: 500;
  letter-spacing: 0.04em;
  overflow-wrap: anywhere;
  text-shadow: 0 0 14px color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 30%, transparent);
}
.inspector-classification {
  margin-top: 7px;
  color: color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 86%, white);
  font-size: 10px;
  letter-spacing: .17em;
  text-transform: uppercase;
}
.inspector-status {
  padding: 6px 8px;
  color: var(--inspector-color, var(--clue-blue));
  border: 1px solid currentColor;
  font-size: 9px;
  letter-spacing: .15em;
  text-transform: uppercase;
  white-space: nowrap;
  box-shadow: inset 0 0 12px color-mix(in srgb, currentColor 12%, transparent), 0 0 10px color-mix(in srgb, currentColor 14%, transparent);
}
.inspector-purpose {
  margin: 14px 0 13px;
  color: rgba(197, 228, 237, .82);
  font-size: 12px;
  line-height: 1.54;
}
.inspector-id {
  padding: 8px 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(0, 163, 224, .72);
  background: rgba(0, 163, 224, .045);
  border-left: 1px solid rgba(0, 163, 224, .42);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 9px;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  margin-top: 14px;
  background: color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--inspector-color, var(--clue-blue)) 20%, transparent);
}
.metric {
  min-height: 57px;
  padding: 9px 9px 8px;
  background: rgba(0, 4, 7, .82);
}
.metric-label { color: rgba(0,163,224,.53); font-size: 8px; letter-spacing: .13em; text-transform: uppercase; }
.metric-value { margin-top: 5px; color: rgba(230,250,255,.94); font-size: 13px; overflow: hidden; text-overflow: ellipsis; }
.metric-bar { height: 2px; margin-top: 7px; background: rgba(0,163,224,.10); }
.metric-bar > i { display: block; height: 100%; width: var(--metric, 0%); background: var(--inspector-color, var(--clue-blue)); box-shadow: 0 0 6px currentColor; }

.history-section { margin-top: 15px; }
.history-title { display: flex; justify-content: space-between; align-items: center; color: rgba(0,163,224,.66); font-size: 9px; letter-spacing: .16em; text-transform: uppercase; }
.history-list { margin-top: 8px; max-height: 123px; overflow: hidden auto; scrollbar-width: thin; scrollbar-color: rgba(0,163,224,.4) transparent; }
.history-entry { position: relative; padding: 7px 8px 7px 16px; border-left: 1px solid rgba(0,163,224,.26); color: rgba(190,222,232,.78); font-size: 10px; line-height: 1.34; }
.history-entry::before { content: ""; position: absolute; left: -3px; top: 12px; width: 5px; height: 5px; background: var(--inspector-color, var(--clue-blue)); box-shadow: 0 0 7px currentColor; }
.history-entry strong { display: block; color: rgba(235,251,255,.94); font-weight: 500; }
.history-empty { padding: 11px; color: rgba(0,163,224,.48); font-size: 10px; border: 1px dashed rgba(0,163,224,.18); }

.inspector-footer { display: flex; justify-content: space-between; gap: 12px; margin-top: 13px; padding-top: 9px; border-top: 1px solid rgba(0,163,224,.16); color: rgba(0,163,224,.52); font-size: 8px; letter-spacing: .11em; text-transform: uppercase; }

.legend {
  position: absolute;
  left: 26px;
  bottom: 23px;
  display: flex;
  align-items: center;
  gap: 13px;
  pointer-events: none;
  padding: 9px 11px;
  background: rgba(0, 4, 7, .66);
  border: 1px solid rgba(0,163,224,.20);
  backdrop-filter: blur(12px);
  clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
}
.legend-item { display: flex; align-items: center; gap: 5px; color: rgba(185,225,237,.66); font-size: 8px; letter-spacing: .10em; text-transform: uppercase; }
.legend-swatch { width: 7px; height: 7px; border: 1px solid currentColor; box-shadow: 0 0 7px currentColor; transform: rotate(45deg); }
.legend-blue { color: var(--clue-blue); }
.legend-orange { color: var(--clue-orange); }
.legend-green { color: var(--clue-patch-green); }
.legend-gold { color: var(--clue-gold); }

.error-panel {
  position: absolute;
  inset: 18%;
  z-index: 20;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--clue-orange);
  background: rgba(0,0,0,.91);
  border: 1px solid var(--clue-orange);
  text-align: center;
  letter-spacing: .08em;
  text-transform: uppercase;
  box-shadow: 0 0 32px rgba(255,85,0,.18);
}
.error-panel.visible { display: flex; }

@media (max-width: 800px) {
  .scan-badge { max-width: calc(100% - 40px); }
  .breadcrumb { max-width: calc(100% - 200px); }
  .legend { gap: 8px; }
  .legend-title { display: none; }
  .metric-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .frame::before, .frame::after, .badge-sweep, .inspector-panel::after { animation: none !important; }
  .scan-badge .badge-face { transition: opacity 1ms !important; }
  .inspector-leader { animation-duration: 1ms !important; }
}
`;
