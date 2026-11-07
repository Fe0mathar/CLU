export const OPERATIONAL_CONSOLE_STYLES = String.raw`
:host {
  --black: #000000;
  --blue: #00a3e0;
  --gold: #f4af2d;
  --orange: #ff5500;
  --green: #39ff88;
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;
  color: rgba(220, 248, 255, 0.94);
  font-family: "Rajdhani", "Orbitron", "Segoe UI", system-ui, sans-serif;
  background: #000;
  overflow: hidden;
  contain: layout paint style;
}
* { box-sizing: border-box; }
button { font: inherit; }
.shell { position:absolute; inset:0; display:grid; grid-template-rows:auto auto 1fr auto; gap:8px; padding:11px; isolation:isolate; }
.backdrop { position:absolute; inset:0; width:100%; height:100%; z-index:-3; }
.scanlines,.noise,.frame-glow { position:absolute; inset:0; pointer-events:none; }
.scanlines { z-index:-1; opacity:.16; background:repeating-linear-gradient(180deg,rgba(255,255,255,.025) 0,rgba(255,255,255,.025) 1px,transparent 1px,transparent 4px); mix-blend-mode:screen; }
.noise { z-index:-2; opacity:.08; background-image:radial-gradient(circle at 10% 20%,rgba(0,163,224,.3) 0 1px,transparent 1px),radial-gradient(circle at 80% 60%,rgba(244,175,45,.2) 0 1px,transparent 1px); background-size:47px 43px,61px 59px; animation:noise-drift 19s linear infinite; }
.frame-glow { z-index:-1; box-shadow:inset 0 0 0 1px rgba(0,163,224,.55),inset 0 0 30px rgba(0,163,224,.07),0 0 24px rgba(0,163,224,.13); clip-path:polygon(0 0,97% 0,100% 7%,100% 100%,3% 100%,0 93%); }
.top-rail,.work-contract,.event-viewport,.footer-rail,.detail-drawer { border:1px solid rgba(0,163,224,.42); background:linear-gradient(145deg,rgba(0,15,23,.88),rgba(0,0,0,.7)),radial-gradient(circle at top right,rgba(0,163,224,.08),transparent 46%); box-shadow:inset 0 0 0 1px rgba(0,163,224,.08),0 0 16px rgba(0,163,224,.08); backdrop-filter:blur(16px) saturate(125%); }
.top-rail { min-height:40px; display:flex; align-items:center; gap:10px; padding:6px 9px; clip-path:polygon(0 0,98% 0,100% 30%,100% 100%,0 100%); }
.brand { display:grid; grid-template-columns:auto 1fr; align-items:center; gap:8px; min-width:190px; }
.brand-mark { width:11px; height:24px; border:1px solid var(--gold); box-shadow:0 0 14px rgba(244,175,45,.8),inset 0 0 9px rgba(244,175,45,.25); transform:skewX(-12deg); }
.brand-title { color:var(--blue); letter-spacing:.22em; font-weight:700; font-size:12px; text-shadow:0 0 11px rgba(0,163,224,.75); }
.brand-subtitle,.status-micro,.event-meta,.label { font-family:"IBM Plex Mono","Cascadia Mono",Consolas,monospace; }
.brand-subtitle { font-size:9px; color:rgba(170,228,245,.58); letter-spacing:.13em; }
.channel-strip { flex:1; display:flex; gap:4px; overflow:hidden; }
.channel-chip { appearance:none; border:1px solid rgba(0,163,224,.3); background:rgba(0,20,29,.58); color:rgba(176,228,244,.63); padding:4px 7px; font-size:8px; letter-spacing:.09em; cursor:pointer; white-space:nowrap; transition:120ms ease; }
.channel-chip[data-enabled="true"] { color:var(--blue); border-color:rgba(0,163,224,.72); box-shadow:inset 0 0 11px rgba(0,163,224,.12),0 0 8px rgba(0,163,224,.12); }
.channel-chip[data-active="true"] { color:var(--gold); border-color:rgba(244,175,45,.8); animation:active-channel 1.3s ease-in-out infinite; }
.status-micro { display:flex; align-items:center; gap:8px; color:rgba(176,228,244,.65); font-size:9px; white-space:nowrap; }
.live-dot { width:6px; height:6px; border-radius:50%; background:var(--blue); box-shadow:0 0 10px var(--blue); }
.live-dot[data-state="disconnected"] { background:var(--orange); box-shadow:0 0 10px var(--orange); }
.work-contract { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:1px; padding:1px; overflow:hidden; }
.contract-cell { min-width:0; padding:7px 8px 8px; background:rgba(0,10,16,.76); border-right:1px solid rgba(0,163,224,.14); }
.contract-cell:last-child { border-right:0; }
.label { color:rgba(0,163,224,.69); font-size:8px; letter-spacing:.17em; margin-bottom:4px; }
.value { color:rgba(226,248,255,.93); font-size:10px; line-height:1.25; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.contract-cell[data-key="status"] .value { color:var(--gold); text-shadow:0 0 10px rgba(244,175,45,.35); }
.event-viewport { position:relative; min-height:0; overflow:hidden; }
.event-scroll { position:absolute; inset:0; overflow:auto; padding:10px 10px 48px; scrollbar-color:rgba(0,163,224,.55) rgba(0,0,0,.4); scrollbar-width:thin; }
.exchange { position:relative; margin:0 0 10px; border-left:2px solid rgba(0,163,224,.55); background:linear-gradient(90deg,rgba(0,163,224,.055),transparent 52%); animation:exchange-enter 260ms cubic-bezier(.2,.75,.2,1) both; }
.exchange[data-severity="warning"],.exchange[data-severity="error"] { border-left-color:var(--orange); background:linear-gradient(90deg,rgba(255,85,0,.08),transparent 58%); }
.exchange[data-proof="true"] { border-left-color:var(--gold); background:linear-gradient(90deg,rgba(244,175,45,.065),transparent 58%); }
.exchange-header { min-height:31px; display:grid; grid-template-columns:auto auto 1fr auto; align-items:center; gap:8px; padding:5px 8px; border-top:1px solid rgba(0,163,224,.18); border-bottom:1px solid rgba(0,163,224,.12); }
.channel-tag,.direction-tag,.validation-tag { font-family:"IBM Plex Mono","Cascadia Mono",Consolas,monospace; font-size:8px; letter-spacing:.11em; padding:2px 5px; border:1px solid rgba(0,163,224,.32); color:var(--blue); }
.direction-tag[data-direction="INBOUND"] { color:var(--gold); border-color:rgba(244,175,45,.42); }
.direction-tag[data-direction="INTERNAL"] { color:rgba(205,238,248,.68); }
.validation-tag[data-state="evidence_rejected"] { color:var(--orange); border-color:rgba(255,85,0,.62); }
.validation-tag[data-state="evidence_admissible"] { color:var(--gold); border-color:rgba(244,175,45,.62); }
.exchange-title { min-width:0; font-size:11px; letter-spacing:.06em; color:rgba(228,249,255,.95); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.event-meta { color:rgba(143,206,226,.48); font-size:8px; white-space:nowrap; }
.event-layer { display:grid; grid-template-columns:86px minmax(0,1fr); gap:8px; padding:7px 8px; border-bottom:1px solid rgba(0,163,224,.08); }
.layer-label { color:rgba(0,163,224,.58); font-family:"IBM Plex Mono","Cascadia Mono",Consolas,monospace; font-size:8px; letter-spacing:.12em; padding-top:3px; }
.layer-body { min-width:0; }
.layer-summary { font-size:10px; line-height:1.35; color:rgba(206,240,250,.78); margin-bottom:5px; }
.code-frame { position:relative; border:1px solid rgba(0,163,224,.2); background:rgba(0,0,0,.72); overflow:hidden; }
.code-frame::before { content:attr(data-format); position:absolute; top:4px; right:6px; color:rgba(0,163,224,.38); font-family:"IBM Plex Mono",Consolas,monospace; font-size:7px; letter-spacing:.12em; }
pre { margin:0; padding:18px 9px 9px; max-height:180px; overflow:auto; color:rgba(196,239,252,.88); font:9px/1.45 "IBM Plex Mono","Cascadia Mono",Consolas,monospace; white-space:pre-wrap; word-break:break-word; tab-size:2; }
.artifact-button,.control-button { appearance:none; border:1px solid rgba(0,163,224,.38); background:rgba(0,10,16,.76); color:rgba(173,229,247,.77); padding:4px 7px; font-size:8px; letter-spacing:.08em; cursor:pointer; }
.artifact-button:hover,.control-button:hover { color:var(--blue); border-color:rgba(0,163,224,.82); box-shadow:0 0 12px rgba(0,163,224,.16); }
.control-button.primary { color:var(--gold); border-color:rgba(244,175,45,.7); }
.empty-state { position:absolute; inset:0; display:grid; place-items:center; color:rgba(0,163,224,.5); letter-spacing:.16em; font-size:10px; text-align:center; }
.empty-state[hidden] { display:none; }
.footer-rail { min-height:34px; display:flex; align-items:center; gap:6px; padding:5px 7px; }
.footer-spacer { flex:1; }
.footer-readout { font:8px "IBM Plex Mono",Consolas,monospace; color:rgba(150,213,232,.54); }
.detail-drawer { position:absolute; right:14px; bottom:50px; width:min(72%,860px); max-height:74%; z-index:4; display:none; grid-template-rows:auto 1fr; box-shadow:0 0 40px rgba(0,163,224,.18); }
.detail-drawer[data-open="true"] { display:grid; }
.detail-header { display:flex; align-items:center; gap:8px; padding:7px 9px; border-bottom:1px solid rgba(0,163,224,.22); }
.detail-title { flex:1; color:var(--gold); letter-spacing:.08em; font-size:10px; }
.detail-body { overflow:auto; padding:8px; }
.detail-body pre { max-height:none; }
.fallback { position:absolute; left:12px; top:48px; color:rgba(255,85,0,.72); font:8px "IBM Plex Mono",Consolas,monospace; display:none; }
.fallback[data-visible="true"] { display:block; }
@keyframes active-channel { 0%,100%{box-shadow:0 0 5px rgba(244,175,45,.2)} 50%{box-shadow:0 0 14px rgba(244,175,45,.65)} }
@keyframes exchange-enter { from{opacity:0;transform:translateX(10px);filter:blur(2px)} to{opacity:1;transform:translateX(0);filter:blur(0)} }
@keyframes noise-drift { from{transform:translate3d(0,0,0)} to{transform:translate3d(47px,59px,0)} }
@media (max-width:900px){.work-contract{grid-template-columns:repeat(3,minmax(0,1fr))}.channel-strip{display:none}.event-layer{grid-template-columns:70px minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important}}
`;
