export const styles = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  color: #d6f7ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 18px;
  background: radial-gradient(circle at 20% 15%, rgba(0,163,224,0.09), transparent 35%), #02060c;
  border: 1px solid rgba(0,163,224,0.35);
  box-shadow: inset 0 0 28px rgba(0,163,224,0.12);
}
.header {
  position: absolute;
  left: 18px;
  top: 18px;
  color: #71dfff;
  letter-spacing: 0.08em;
  font-size: 24px;
}
.field {
  position: absolute;
  left: 18px;
  top: 58px;
  width: calc(100% - 340px);
  height: calc(100% - 76px);
  background: linear-gradient(180deg, rgba(0, 16, 28, 0.95), rgba(1, 7, 14, 0.95));
  border: 1px solid rgba(0,163,224,0.25);
  box-shadow: inset 0 0 26px rgba(0,163,224,0.06);
}
.sidebar {
  position: absolute;
  right: 18px;
  top: 58px;
  width: 286px;
  height: calc(100% - 76px);
  border: 1px solid rgba(0,163,224,0.25);
  background: rgba(1, 8, 14, 0.85);
  padding: 14px;
  box-sizing: border-box;
}
.title {
  color: #f4af2d;
  font-size: 18px;
  margin-bottom: 12px;
}
.body {
  line-height: 1.55;
  font-size: 13px;
  color: #d6f7ff;
}
`;
