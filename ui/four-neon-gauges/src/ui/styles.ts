export const gaugeStyles = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 420px;
  color: #d8f8ff;
  font-family: "Rajdhani", "Orbitron", "Segoe UI", sans-serif;
  --panel: rgba(2, 10, 18, 0.78);
  --line: rgba(0, 163, 224, 0.28);
}
* { box-sizing: border-box; }
.frame {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background:
    radial-gradient(circle at 20% 12%, rgba(0,163,224,.12), transparent 34%),
    radial-gradient(circle at 82% 82%, rgba(57,255,136,.08), transparent 30%),
    linear-gradient(180deg, #020810 0%, #01040a 100%);
  border: 1px solid rgba(0,163,224,.38);
  box-shadow: inset 0 0 42px rgba(0,163,224,.09), 0 0 26px rgba(0,163,224,.05);
}
.header {
  position: absolute;
  z-index: 4;
  top: 14px;
  left: 18px;
  right: 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  pointer-events: none;
}
.heading {
  font-size: 18px;
  letter-spacing: .13em;
  color: #7ee6ff;
  text-shadow: 0 0 14px rgba(0,163,224,.7);
}
.subheading {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  letter-spacing: .1em;
  color: rgba(183,239,255,.62);
}
canvas.scene {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.gauges {
  position: absolute;
  z-index: 3;
  inset: 48px 12px 12px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 10px;
  pointer-events: none;
}
.gauge {
  --family: #00a3e0;
  position: relative;
  min-width: 0;
  padding: 18px 18px 14px;
  border: 1px solid color-mix(in srgb, var(--family) 38%, transparent);
  clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--family) 8%, transparent), transparent 38%),
    rgba(2, 9, 16, .42);
  box-shadow: inset 0 0 24px color-mix(in srgb, var(--family) 10%, transparent);
  pointer-events: auto;
  cursor: pointer;
  transition: border-color .2s ease, box-shadow .2s ease, transform .2s ease;
}
.gauge:hover, .gauge:focus-visible {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--family) 78%, white 10%);
  box-shadow: inset 0 0 32px color-mix(in srgb, var(--family) 15%, transparent), 0 0 18px color-mix(in srgb, var(--family) 18%, transparent);
  outline: none;
}
.identity {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.metric-id {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  letter-spacing: .1em;
  color: var(--family);
  text-shadow: 0 0 12px color-mix(in srgb, var(--family) 70%, transparent);
}
.metric-name {
  margin-top: 3px;
  max-width: 220px;
  font-size: 13px;
  line-height: 1.12;
  color: #d8f8ff;
}
.availability {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 9px;
  padding: 3px 6px;
  border: 1px solid color-mix(in srgb, var(--family) 45%, transparent);
  color: var(--family);
}
.value-block {
  position: absolute;
  left: 50%;
  top: 47%;
  transform: translate(-50%, -50%);
  width: 54%;
  text-align: center;
  pointer-events: none;
}
.primary {
  font-size: clamp(32px, 4vw, 58px);
  font-weight: 600;
  line-height: .9;
  color: var(--family);
  text-shadow: 0 0 18px color-mix(in srgb, var(--family) 88%, transparent), 0 0 36px color-mix(in srgb, var(--family) 36%, transparent);
}
.native {
  margin-top: 8px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  color: rgba(222,248,255,.78);
}
.delta {
  margin-top: 5px;
  font-size: 10px;
  letter-spacing: .06em;
  color: rgba(213,247,255,.72);
}
.meta {
  position: absolute;
  left: 18px;
  right: 18px;
  bottom: 14px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.meta-item { min-width: 0; }
.meta-label {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 8px;
  color: rgba(172,226,241,.52);
  letter-spacing: .08em;
}
.meta-value {
  margin-top: 2px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  color: #d8f8ff;
}
.spark {
  position: absolute;
  right: 18px;
  top: 44px;
  width: 82px;
  height: 26px;
  opacity: .8;
}
.warning {
  position: absolute;
  left: 18px;
  right: 18px;
  top: 76px;
  color: #ff7b2f;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 9px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: #ff8b47;
  background: rgba(1,5,10,.86);
  z-index: 2;
}
`;
