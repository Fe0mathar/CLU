/**
 * Great Book Improvement Field — render scene.
 *
 * Reconciled to the authoritative `GreatBookImprovementFieldView` contract
 * (src/ui/greatBookImprovementField.ts): cells keyed by canonical `measurementId`
 * with `x/y`, `netContribution`, `positiveHeight/negativeDepth`, UPPER-case
 * `family` enum, `state`, and `segments`. It renders the same neon-glass isometric
 * field the live dashboard shows: family-colored floor districts, a metric ID on
 * every block, glass bars above the floor for gains / below for regressions,
 * cinematic staggered rise, and a continuous idle wave once settled.
 *
 * Backward-compatible: it also accepts the earlier demo projection shape
 * (`row/column/value`, camelCase family names, `contributions`, `selectedCell`),
 * so the existing `demo/sample-projection.json` and `FieldRenderer` sidebar keep
 * working unchanged. Bars are placed at their permanent canonical coordinates
 * regardless of which shape fed them. Nothing is invented: a cell only grows a bar
 * when its projection carries a value.
 *
 * The public interface is unchanged — `attach(canvas)` + `render(projection, canvas)` —
 * so `FieldRenderer` compiles and behaves as before.
 */

type Family = 'TARGET_QUALITY' | 'EVIDENCE_ASSURANCE' | 'ACCEPTANCE_GATES' | 'CLUE_SELF' | 'RESERVED';

interface Cell {
  gridIndex: number;
  x: number;
  y: number;
  measurementId: string;
  legacyId: string | null;
  name: string;
  family: Family;
  familyColor: string;
  state: string;
  positiveHeight: number | null;
  negativeDepth: number | null;
  netContribution: number | null;
  confidence: number | null;
  coverage: number | null;
  freshness: number | null;
  contributionCount: number;
  segments: any[];
  // animation
  bar: boolean;
  from: number;
  to: number;
  startT: number;
  delay: number;
  dur: number;
  ease: 'back' | 'inout';
}

const M: ReadonlyArray<readonly [string, string | null, string]> = [
  ['MA01', 'Q01', 'Purpose alignment'], ['MA02', 'Q02', 'Utility and value realization'],
  ['MA03', 'Q03', 'Capability preservation and evolution'], ['MA04', 'Q04', 'Workload integrity'],
  ['MA05', 'Q05', 'Stakeholder and user outcome'], ['MA06', 'Q06', 'Economy and total cost of ownership'],
  ['MB01', 'Q07', 'Functional completeness'], ['MB02', 'Q08', 'Functional correctness'],
  ['MB03', 'Q09', 'Contract and API conformance'], ['MB04', 'Q10', 'State and data integrity'],
  ['MB05', 'Q11', 'Temporal and concurrency correctness'], ['MB06', 'Q12', 'Determinism and controlled variability'],
  ['MB07', 'Q13', 'Numerical and precision integrity'], ['MC01', 'Q14', 'Complexity proportionality'],
  ['MC02', 'Q15', 'Architectural coherence'], ['MC03', 'Q16', 'Cohesion'],
  ['MC04', 'Q17', 'Coupling and dependency surface'], ['MC05', 'Q18', 'Modularity and replaceability'],
  ['MC06', 'Q19', 'Boundary and interface quality'], ['MC07', 'Q20', 'Responsibility concentration'],
  ['MC08', 'Q21', 'Redundancy'], ['MC09', 'Q22', 'Dead code'],
  ['MC10', 'Q23', 'Obsolescence'], ['MC11', 'Q24', 'Technical debt'],
  ['MC12', 'Q25', 'Architectural entropy and evolvability'], ['MC13', 'Q26', 'Analyzability and understandability'],
  ['MC14', 'Q27', 'Testability'], ['MC15', 'Q28', 'Observability'],
  ['MD01', 'Q29', 'Intrinsic efficiency'], ['MD02', 'Q30', 'Cost amplification'],
  ['MD03', 'Q31', 'Critical-path influence'], ['MD04', 'Q32', 'Throughput and latency'],
  ['MD05', 'Q33', 'Tail behavior and cost predictability'], ['MD06', 'Q34', 'Memory and resource lifecycle'],
  ['MD07', 'Q35', 'I/O, network, and storage efficiency'], ['MD08', 'Q36', 'Scalability'],
  ['MD09', 'Q37', 'Degradation shape and resource adaptability'], ['MD10', 'Q38', 'Energy and carbon efficiency'],
  ['ME01', 'Q39', 'Reliability and availability'], ['ME02', 'Q40', 'Fragility and blast radius'],
  ['ME03', 'Q41', 'Fault isolation and containment'], ['ME04', 'Q42', 'Resilience and recovery'],
  ['ME05', 'Q43', 'Graceful degradation and fallback quality'], ['ME06', 'Q44', 'Reversibility and rollback'],
  ['ME07', 'Q45', 'Safety and fail-safe behavior'], ['MF01', 'Q46', 'Security'],
  ['MF02', 'Q47', 'Privacy and data minimization'], ['MF03', 'Q48', 'Supply-chain and provenance integrity'],
  ['MF04', 'Q49', 'Abuse and misuse resistance'], ['MF05', 'Q50', 'Autonomy appropriateness and human control'],
  ['MF06', 'Q51', 'Auditability, accountability, and policy conformance'], ['MG01', 'Q52', 'Compatibility and interoperability'],
  ['MG02', 'Q53', 'Backward and forward compatibility'], ['MG03', 'Q54', 'Portability'],
  ['MG04', 'Q55', 'Adaptability and plasticity'], ['MG05', 'Q56', 'Deployability and operability'],
  ['MG06', 'Q57', 'Accessibility, inclusivity, and usability'], ['MG07', 'Q58', 'Reusability and generalization'],
  ['MH01', 'Q59', 'Explainability and transparency'], ['MH02', 'Q60', 'Quality balance and Pareto integrity'],
  ['MI01', 'A01', 'Purpose-context sufficiency'], ['MI02', 'A02', 'Measurement validity'],
  ['MI03', 'A03', 'Benchmark representativeness'], ['MI04', 'A04', 'Coverage completeness'],
  ['MI05', 'A05', 'Causal attribution'], ['MI06', 'A06', 'Confidence and uncertainty calibration'],
  ['MI07', 'A07', 'Knowledge freshness'], ['MI08', 'A08', 'Instrument self-validity and observer effect'],
  ['MI09', 'A09', 'Reproducibility and replicability'], ['MI10', 'A10', 'Regression sensitivity'],
  ['MI11', 'A11', 'Scope-of-claim integrity and residual unknowns'], ['MJ01', 'G01', 'Purpose Preservation'],
  ['MJ02', 'G02', 'Capability Preservation'], ['MJ03', 'G03', 'Workload Integrity'],
  ['MJ04', 'G04', 'Correctness and Contract Integrity'], ['MJ05', 'G05', 'Evidence Admissibility'],
  ['MJ06', 'G06', 'Global Regression Guardrail'], ['MJ07', 'G07', 'Reversibility and Recovery'],
  ['MK01', 'S01', 'Cost per proven improvement'], ['MK02', 'S02', 'Time to terminal disposition'],
  ['MK03', 'S03', 'Finding precision'], ['MK04', 'S04', 'Regression escape rate'],
  ['MK05', 'S05', 'Repeated-work rate'], ['MK06', 'S06', 'Coverage and uncertainty reduction'],
  ['MK07', 'S07', 'Forecast calibration'], ['MK08', 'S08', 'Instrument validity rate'],
  ['MK09', 'S09', 'Test-catalogue efficiency'], ['MK10', 'S10', 'Mission continuity'],
  ['MK11', 'S11', 'Custody safety'], ['MK12', 'S12', 'Equilibrium credibility'],
  ['MK13', 'S13', 'Measure-session token efficiency'], ['MK14', 'S14', 'Model-routing value'],
  ['MK15', 'S15', 'Catalogue maintainability'], ['MK16', 'S16', 'Catalogue-review effectiveness'],
  ['MK17', 'S17', 'Conversation-orchestration integrity'], ['MK18', 'S18', 'Status fidelity'],
  ['RESERVED-97', null, 'Future catalogue expansion'], ['RESERVED-98', null, 'Future catalogue expansion'],
  ['RESERVED-99', null, 'Future catalogue expansion'], ['RESERVED-100', null, 'Future catalogue expansion'],
];

const FAM: Record<Family, { color: string }> = {
  TARGET_QUALITY: { color: '#00a3e0' },
  EVIDENCE_ASSURANCE: { color: '#f4af2d' },
  ACCEPTANCE_GATES: { color: '#ff5500' },
  CLUE_SELF: { color: '#39ff88' },
  RESERVED: { color: '#0b1a28' },
};
const FAMILY_ORDER: Family[] = ['TARGET_QUALITY', 'EVIDENCE_ASSURANCE', 'ACCEPTANCE_GATES', 'CLUE_SELF'];
const FAMILY_LABEL: Record<string, string> = {
  TARGET_QUALITY: 'Target Quality', EVIDENCE_ASSURANCE: 'Evidence & Assurance',
  ACCEPTANCE_GATES: 'Acceptance Gates', CLUE_SELF: 'CLU-E Self',
};
const LEGACY_FAMILY: Record<string, Family> = {
  targetQuality: 'TARGET_QUALITY', evidenceAssurance: 'EVIDENCE_ASSURANCE',
  acceptanceGates: 'ACCEPTANCE_GATES', clueSelfMetrics: 'CLUE_SELF',
};

function familyOf(i: number): Family {
  return i <= 60 ? 'TARGET_QUALITY' : i <= 71 ? 'EVIDENCE_ASSURANCE' : i <= 78 ? 'ACCEPTANCE_GATES' : i <= 96 ? 'CLUE_SELF' : 'RESERVED';
}
function pick<T>(...vals: Array<T | null | undefined>): T | null {
  for (const v of vals) if (v !== null && v !== undefined) return v;
  return null;
}
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}
function emptyModel(): Cell[] {
  return M.map((row, idx): Cell => {
    const gridIndex = idx + 1;
    const family = familyOf(gridIndex);
    return {
      gridIndex, x: (idx % 10) + 1, y: Math.floor(idx / 10) + 1,
      measurementId: row[0], legacyId: row[1], name: row[2],
      family, familyColor: FAM[family].color,
      state: family === 'RESERVED' ? 'reserved' : 'unknown',
      positiveHeight: null, negativeDepth: null, netContribution: null,
      confidence: null, coverage: null, freshness: null, contributionCount: 0, segments: [],
      bar: false, from: 0, to: 0, startT: 0, delay: 0, dur: 1, ease: 'back',
    };
  });
}
function modelFromProjection(projection: any): Cell[] {
  const base = emptyModel();
  const cells: unknown = projection?.cells;
  if (!Array.isArray(cells)) return base;
  const byId = new Map(base.map((c) => [c.measurementId, c] as const));
  for (const rc of cells) {
    const id = rc?.measurementId;
    if (typeof id !== 'string') continue;
    const c = byId.get(id);
    if (!c) continue;
    c.state = typeof rc.state === 'string' ? rc.state : 'available';
    c.netContribution = pick<number>(rc.netContribution, rc.value);
    c.positiveHeight = pick<number>(rc.positiveHeight, rc.positiveValue);
    c.negativeDepth = pick<number>(rc.negativeDepth, rc.negativeValue);
    c.confidence = pick<number>(rc.confidence);
    c.coverage = pick<number>(rc.coverage);
    c.freshness = pick<number>(rc.freshness);
    const segs: any[] = Array.isArray(rc.segments) ? rc.segments : Array.isArray(rc.contributions) ? rc.contributions : [];
    c.segments = segs;
    c.contributionCount = pick<number>(rc.contributionCount, segs.length) ?? 0;
    if (typeof rc.familyColor === 'string') c.familyColor = rc.familyColor;
    else if (typeof rc.family === 'string' && LEGACY_FAMILY[rc.family]) c.familyColor = FAM[LEGACY_FAMILY[rc.family]!].color;
  }
  return base;
}
function selectedIdOf(projection: any): string | null {
  const s = projection?.selectedMeasurementId;
  if (typeof s === 'string') return s;
  const sc = projection?.selectedCell?.measurementId;
  return typeof sc === 'string' ? sc : null;
}

const HALF_W = 32, HALF_H = 16, MAX_BAR = 150, MAX_PIT = 95;

function createController(canvas: HTMLCanvasElement, reduceMotion: boolean) {
  const ctxOrNull = canvas.getContext('2d');
  if (!ctxOrNull) return { setProjection(_p: any): void {}, destroy(): void {} };
  const context: CanvasRenderingContext2D = ctxOrNull;

  const tip = typeof document !== 'undefined' ? document.createElement('div') : null;
  if (tip) {
    tip.style.cssText = 'position:fixed;z-index:9;pointer-events:none;display:none;padding:5px 8px;font:11px/1.4 ui-monospace,Consolas,monospace;color:#dff;background:rgba(1,10,18,.95);border:1px solid rgba(0,163,224,.5);border-radius:4px;white-space:nowrap;transform:translate(-50%,-125%);box-shadow:0 6px 18px rgba(0,0,0,.5)';
    (canvas.parentElement ?? canvas).appendChild(tip);
  }

  let model: Cell[] = emptyModel();
  let selectedId: string | null = null;
  let hover: Cell | null = null;
  let waveGain = 0;
  let lastT = 0;
  let raf = 0;
  let zoom = 1, originX = 0, originY = 0;

  const now = (): number => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
  const easeOutBack = (t: number): number => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const waveFn = (gx: number, gy: number, t: number): number => Math.sin(t * 0.0016 - (gx + gy) * 0.55) * 0.6 + Math.sin(t * 0.0009 - (gx * 0.9 - gy * 0.45)) * 0.4;
  const waveAmp = (px: number): number => Math.min(15, 5 + Math.abs(px) * 0.07);
  const hex2rgb = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgba = (h: string, a: number): string => { const [r, g, b] = hex2rgb(h); return `rgba(${r},${g},${b},${a})`; };
  const shade = (h: string, f: number): string => { let [r, g, b] = hex2rgb(h); if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; } return `rgb(${r | 0},${g | 0},${b | 0})`; };

  const isBar = (c: Cell): boolean => (c.state === 'available' || c.state === 'stale') && c.netContribution !== null;
  const targetPx = (c: Cell): number => {
    if (!isBar(c) || c.netContribution === null) return 0;
    const v = c.netContribution;
    if (v < 0) return -Math.min(MAX_PIT, (Math.abs(v) / 100) * MAX_PIT + 6);
    return Math.max(6, (v / 100) * MAX_BAR);
  };
  const project = (gx: number, gy: number, elev: number): { x: number; y: number } => ({
    x: originX + (gx - gy) * HALF_W * zoom,
    y: originY + (gx + gy) * HALF_H * zoom - elev * zoom,
  });
  const depthOf = (c: Cell): number => (c.x - 1 + c.y - 1) * 100 + (c.x - 1);
  const diamond = (cx: number, cy: number): number[][] => { const w = HALF_W * zoom, h = HALF_H * zoom; return [[cx, cy - h], [cx + w, cy], [cx, cy + h], [cx - w, cy]]; };
  function poly(pts: number[][], fill: string | null, stroke: string | null, lw?: number): void {
    context.beginPath();
    const first = pts[0]; if (!first) return;
    context.moveTo(first[0]!, first[1]!);
    for (let i = 1; i < pts.length; i++) { const p = pts[i]!; context.lineTo(p[0]!, p[1]!); }
    context.closePath();
    if (fill) { context.fillStyle = fill; context.fill(); }
    if (stroke) { context.strokeStyle = stroke; context.lineWidth = lw ?? 1; context.stroke(); }
  }

  function fit(): void {
    zoom = Math.max(0.4, Math.min((canvas.width - 40) / (18 * HALF_W), (canvas.height - 40) / (MAX_BAR + 18 * HALF_H)));
    const totalH = (MAX_BAR + 18 * HALF_H) * zoom;
    originX = canvas.width / 2;
    originY = MAX_BAR * zoom + Math.max(6, (canvas.height - totalH) / 2);
  }

  function animPx(c: Cell, t: number): number {
    if (!c.bar) return 0;
    const p = clamp((t - c.startT - c.delay) / c.dur, 0, 1);
    const e = c.ease === 'back' ? easeOutBack(p) : easeInOutCubic(p);
    let v = c.from + (c.to - c.from) * e;
    if (p >= 1 && waveGain > 0) v = c.to + Math.sign(c.to || 1) * waveAmp(c.to) * waveFn(c.x - 1, c.y - 1, t) * waveGain;
    return v;
  }
  function retarget(ease: 'back' | 'inout'): void {
    const t = now();
    for (const c of model) {
      c.bar = isBar(c);
      const to = targetPx(c);
      c.from = ease === 'back' || reduceMotion ? (reduceMotion ? to : 0) : animPx(c, t);
      c.to = to;
      c.delay = ease === 'back' && !reduceMotion ? ((c.x - 1) + (c.y - 1)) * 30 + Math.random() * 220 : 0;
      c.dur = reduceMotion ? 1 : ease === 'back' ? 900 + Math.random() * 1000 : 600;
      c.startT = t;
      c.ease = ease;
    }
    if (ease === 'back') waveGain = 0;
  }

  function glassBar(c: Cell, px: number): number[][][] {
    const up = px > 0;
    const fc = up ? c.familyColor : '#ff5500';
    const w = HALF_W * zoom, h = HALF_H * zoom;
    const U = project(c.x - 1, c.y - 1, Math.max(0, px));
    const L = project(c.x - 1, c.y - 1, Math.min(0, px));
    const F = project(c.x - 1, c.y - 1, 0);
    const topFace = [[U.x, U.y - h], [U.x + w, U.y], [U.x, U.y + h], [U.x - w, U.y]];
    const leftFace = [[U.x - w, U.y], [U.x, U.y + h], [L.x, L.y + h], [L.x - w, L.y]];
    const rightFace = [[U.x, U.y + h], [U.x + w, U.y], [L.x + w, L.y], [L.x, L.y + h]];
    const stale = c.state === 'stale';
    const aBody = stale ? 0.3 : 0.5;
    const conf = c.confidence ?? 0.6;
    const rg = context.createRadialGradient(F.x, F.y, 2, F.x, F.y, w * 1.15);
    rg.addColorStop(0, rgba(fc, up ? 0.16 : 0.14)); rg.addColorStop(1, rgba(fc, 0));
    poly([[F.x, F.y - h * 1.1], [F.x + w * 1.1, F.y], [F.x, F.y + h * 1.1], [F.x - w * 1.1, F.y]], rg as unknown as string, null);
    const gl = context.createLinearGradient(U.x, U.y, L.x, L.y);
    gl.addColorStop(0, rgba(shade(fc, 0.35), aBody)); gl.addColorStop(1, rgba(shade(fc, -0.55), aBody * 0.7));
    poly(leftFace, gl as unknown as string, null);
    const gr = context.createLinearGradient(U.x, U.y, L.x, L.y);
    gr.addColorStop(0, rgba(shade(fc, 0.12), aBody)); gr.addColorStop(1, rgba(shade(fc, -0.4), aBody * 0.7));
    poly(rightFace, gr as unknown as string, null);
    const live = c.segments.filter((s) => s && !s.invalidated && (s.normalizedContribution ?? 0) > 0);
    const tot = live.reduce((a: number, s) => a + (s.normalizedContribution ?? 0), 0) || 1;
    let acc = 0;
    for (let i = 0; i < live.length - 1; i++) {
      acc += (live[i]!.normalizedContribution ?? 0) / tot;
      const S = project(c.x - 1, c.y - 1, Math.max(0, px) * acc);
      poly([[S.x, S.y - h], [S.x + w, S.y], [S.x, S.y + h], [S.x - w, S.y]], null, rgba(shade(fc, 0.5), 0.35), 1);
    }
    context.save();
    context.shadowColor = rgba(fc, (stale ? 0.35 : 0.75) * (0.6 + 0.4 * conf));
    context.shadowBlur = stale ? 7 : 13;
    const gt = context.createLinearGradient(U.x, U.y - h, U.x, U.y + h);
    gt.addColorStop(0, rgba(shade(fc, 0.6), up ? 0.85 : 0.6)); gt.addColorStop(1, rgba(fc, up ? 0.5 : 0.4));
    poly(topFace, gt as unknown as string, null);
    context.restore();
    poly([[U.x, U.y - h], [U.x + w * 0.5, U.y - h * 0.5], [U.x, U.y], [U.x - w * 0.5, U.y - h * 0.5]], rgba('#ffffff', up ? 0.18 : 0.1), null);
    const topSeg = c.segments[c.segments.length - 1];
    const uncert = !!topSeg && topSeg.certified === false;
    context.save();
    context.shadowColor = rgba(fc, 0.9); context.shadowBlur = 6;
    if (uncert) context.setLineDash([3, 2]);
    poly(topFace, null, rgba(shade(fc, 0.55), 0.95), 1.4);
    context.restore();
    context.save();
    context.shadowColor = rgba(fc, 0.8); context.shadowBlur = 5;
    context.strokeStyle = rgba(shade(fc, 0.45), 0.9); context.lineWidth = 1.2;
    const edges = [[U.x - w, U.y, L.x - w, L.y], [U.x, U.y + h, L.x, L.y + h], [U.x + w, U.y, L.x + w, L.y]];
    for (const e of edges) { context.beginPath(); context.moveTo(e[0]!, e[1]!); context.lineTo(e[2]!, e[3]!); context.stroke(); }
    context.restore();
    if (!up) {
      const B = project(c.x - 1, c.y - 1, Math.min(0, px));
      poly([[B.x, B.y - h], [B.x + w, B.y], [B.x, B.y + h], [B.x - w, B.y]], rgba(shade('#ff5500', -0.5), 0.5), rgba('#ff7a3d', 0.5), 1);
    }
    return [topFace, leftFace, rightFace];
  }

  function label(c: Cell, elev: number): void {
    if (c.state === 'reserved') return;
    const fontPx = clamp(11 * zoom, 8, 16);
    const empty = !c.bar;
    if (empty && fontPx < 9) return;
    const P = project(c.x - 1, c.y - 1, elev);
    context.save();
    context.font = `600 ${fontPx}px ui-monospace,Consolas,monospace`;
    context.textAlign = 'center'; context.textBaseline = 'middle';
    context.shadowColor = 'rgba(0,0,0,0.9)'; context.shadowBlur = 3;
    const sel = c.measurementId === selectedId;
    const hov = c === hover;
    context.fillStyle = sel ? '#ffd873' : hov ? '#eafcff' : empty ? rgba(c.familyColor, 0.42) : 'rgba(232,251,255,0.82)';
    context.fillText(c.measurementId, P.x, P.y);
    context.restore();
  }

  function drawLegend(): void {
    const rows = FAMILY_ORDER.length;
    const pad = 10, rowH = 18, sw = 11, panelW = 176, panelH = rowH * (rows + 1) + pad;
    const x0 = 14, y0 = canvas.height - panelH - 12;
    context.save();
    context.fillStyle = 'rgba(4,12,22,0.82)';
    context.strokeStyle = 'rgba(0,163,224,0.28)';
    context.lineWidth = 1;
    context.beginPath(); context.rect(x0, y0, panelW, panelH); context.fill(); context.stroke();
    context.textBaseline = 'middle';
    context.font = '8px ui-monospace,Consolas,monospace';
    context.fillStyle = '#5f7d99';
    context.fillText('FAMILIES · NET CONTRIBUTION', x0 + pad, y0 + pad + 4);
    let y = y0 + pad + rowH;
    for (const fam of FAMILY_ORDER) {
      const cells = model.filter((c) => c.family === fam);
      const active = cells.some((c) => c.netContribution !== null);
      const net = cells.reduce((s, c) => s + (c.netContribution ?? 0), 0);
      const col = FAM[fam].color;
      context.fillStyle = col; context.shadowColor = col; context.shadowBlur = 6;
      context.beginPath(); context.rect(x0 + pad, y - sw / 2, sw, sw); context.fill();
      context.shadowBlur = 0;
      context.font = '10px ui-monospace,Consolas,monospace';
      context.fillStyle = '#bcd7e8'; context.textAlign = 'left';
      context.fillText(FAMILY_LABEL[fam] ?? fam, x0 + pad + sw + 7, y);
      context.fillStyle = '#9fe9ff'; context.textAlign = 'right';
      context.fillText(active ? `${net >= 0 ? '+' : ''}${Math.round(net)}` : '—', x0 + panelW - pad, y);
      context.textAlign = 'left';
      y += rowH;
    }
    context.restore();
  }

  let pickList: { cell: Cell; polys: number[][][] }[] = [];
  function draw(): void {
    const t = now();
    const dt = Math.min(50, t - lastT); lastT = t;
    const settledAll = model.every((c) => !c.bar || (t - c.startT - c.delay) >= c.dur);
    if (!reduceMotion) waveGain = settledAll ? Math.min(1, waveGain + dt / 900) : waveGain;
    const amb = reduceMotion ? 0 : 0.5 + 0.5 * Math.sin(t * 0.0012);

    context.clearRect(0, 0, canvas.width, canvas.height);
    const bg = context.createRadialGradient(canvas.width / 2, canvas.height * 0.44, 40, canvas.width / 2, canvas.height * 0.44, canvas.height);
    bg.addColorStop(0, '#06131f'); bg.addColorStop(1, '#02060c');
    context.fillStyle = bg; context.fillRect(0, 0, canvas.width, canvas.height);

    const order = [...model].sort((a, b) => depthOf(a) - depthOf(b));

    for (const c of order) {
      const p = project(c.x - 1, c.y - 1, 0);
      const tile = diamond(p.x, p.y);
      const fc = c.familyColor;
      let baseFill: string, edge: string;
      if (c.state === 'reserved') { baseFill = rgba('#0a1622', 0.8); edge = rgba('#12324a', 0.5); }
      else {
        const lit = c.bar ? 0.11 : 0.05 + 0.02 * amb * (0.5 + 0.5 * Math.sin(c.x + c.y));
        baseFill = rgba(fc, c.bar ? 0.11 : Math.max(0.03, lit));
        edge = rgba(fc, c.bar ? 0.34 : 0.15 + 0.06 * amb);
      }
      poly(tile, baseFill, null);
      if (c.state !== 'reserved') {
        const g = context.createLinearGradient(p.x, p.y - HALF_H * zoom, p.x, p.y);
        g.addColorStop(0, rgba('#ffffff', 0.05)); g.addColorStop(1, rgba('#ffffff', 0));
        poly(tile, g as unknown as string, null);
      }
      context.save(); context.shadowColor = edge; context.shadowBlur = c.bar ? 6 : 0; poly(tile, null, edge, 1); context.restore();
      if (c.state === 'stale') { context.save(); context.setLineDash([4, 3]); poly(tile, null, rgba(fc, 0.5), 1); context.restore(); }
      if (c.measurementId === selectedId) poly(tile, null, '#ffd166', 2);
      else if (c === hover) poly(tile, null, rgba('#ffffff', 0.65), 1.5);
    }

    pickList = [];
    for (const c of order) {
      const base = project(c.x - 1, c.y - 1, 0);
      const tile = diamond(base.x, base.y);
      const px = animPx(c, t);
      if (!c.bar || Math.abs(px) < 1.4) { pickList.push({ cell: c, polys: [tile] }); label(c, Math.max(0, px)); continue; }
      pickList.push({ cell: c, polys: glassBar(c, px) });
      label(c, px > 0 ? px : 0);
    }

    drawLegend();
    if (!reduceMotion) raf = requestAnimationFrame(draw);
  }

  const inPoly = (px: number, py: number, pg: number[][]): boolean => {
    let inside = false;
    for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
      const pi = pg[i]!, pj = pg[j]!;
      const xi = pi[0]!, yi = pi[1]!, xj = pj[0]!, yj = pj[1]!;
      if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  function pickAt(mx: number, my: number): Cell | null {
    for (let i = pickList.length - 1; i >= 0; i--) {
      const e = pickList[i]!;
      for (const pg of e.polys) if (inPoly(mx, my, pg)) return e.cell;
    }
    return null;
  }

  function onMove(e: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / (rect.width || canvas.width);
    const sy = canvas.height / (rect.height || canvas.height);
    const c = pickAt((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
    hover = c;
    if (tip && c && c.state !== 'reserved') {
      const v = isBar(c) ? c.netContribution : null;
      tip.style.display = 'block';
      tip.style.left = e.clientX + 'px';
      tip.style.top = e.clientY + 'px';
      tip.innerHTML = `<span style="color:#ffd166">${esc(c.measurementId)}</span> ${esc(c.name)}` +
        (v !== null ? ` · <b style="color:${v >= 0 ? '#39ff88' : '#ff7a3d'}">${v >= 0 ? '+' : ''}${v}</b>` : ` · <span style="color:#5f7d99">${c.state === 'unknown' ? 'not yet measured' : c.state}</span>`);
    } else if (tip) tip.style.display = 'none';
    if (reduceMotion) draw();
  }
  function onLeave(): void { hover = null; if (tip) tip.style.display = 'none'; if (reduceMotion) draw(); }
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);

  fit();
  retarget('back');
  if (!reduceMotion) raf = requestAnimationFrame(draw); else draw();

  return {
    setProjection(projection: any): void {
      const wasEmpty = model.every((c) => !isBar(c));
      model = modelFromProjection(projection);
      selectedId = selectedIdOf(projection);
      fit();
      retarget(wasEmpty ? 'back' : 'inout');
      if (reduceMotion) draw();
    },
    destroy(): void {
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      if (tip && tip.parentElement) tip.parentElement.removeChild(tip);
    },
  };
}

type Controller = ReturnType<typeof createController>;

export class WebGPUImprovementFieldScene {
  #controller: Controller | null = null;
  #boundCanvas: HTMLCanvasElement | null = null;

  attach(canvas: HTMLCanvasElement): void {
    const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
    this.#controller?.destroy();
    this.#controller = createController(canvas, reduce);
    this.#boundCanvas = canvas;
  }

  render(projection: any, canvas: HTMLCanvasElement): void {
    if (!this.#controller || this.#boundCanvas !== canvas) this.attach(canvas);
    this.#controller?.setProjection(projection);
  }
}