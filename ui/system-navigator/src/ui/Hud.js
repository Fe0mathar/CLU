function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function compactNumber(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(number);
}

/** UPPERCASE plural for a granularity word ("class" is the only irregular case). */
function pluralGranularity(granularity) {
  const single = String(granularity ?? 'unit').toUpperCase();
  if (single === 'CLASS') return 'CLASSES';
  return `${single}S`;
}

/**
 * Bottom-right scan/units badge — a small glass panel (translucent over the graph), legend-sized.
 *
 * It ALTERNATES on a fixed PHASE_MS (10s) cadence between two faces:
 *   • "scan"  — the preserved FILE SCAN bar + percentage.
 *   • "units" — every recognized-unit category laid out inline on one line
 *               ("3 DOMAINS  8 SUBSYSTEMS  42 MODULES  210 FILES  380 CLASSES  1.2K FUNCTIONS").
 *
 * bar 10s → units 10s → bar 10s → … forever, driven by elapsed-time modulo (no manual timers).
 * While a scan is actively running the bar shows live; alternation begins once recognition
 * settles. File-scan progress is never conflated with recognition: only a committed seal (or a
 * real ≥100% scan) settles the badge. The in-flow face drives width so the glass wraps it snugly;
 * the other face overlays faded out.
 */
export class ScanBadge {
  static PHASE_MS = 10000;

  constructor(element) {
    this.element = element ?? null;
    this.settleAt = null;        // performance.now() when the alternation clock started
    this.everScanned = false;
    this.mode = 'scan';
    this.pulseTimer = 0;
    this.lastPercentText = '';
    this.lastCountsSig = '';
    this.lastState = '';
    if (!this.element) return;

    element.dataset.mode = 'scan';
    element.dataset.state = 'idle';
    element.innerHTML = `
      <span class="badge-face badge-scan">
        <span class="badge-label">FILE SCAN</span>
        <span class="badge-track"><i class="badge-fill"></i><i class="badge-sweep"></i></span>
        <span class="badge-percent">0%</span>
      </span>
      <span class="badge-face badge-units"></span>
    `;
    this.percentEl = element.querySelector('.badge-percent');
    this.fillEl = element.querySelector('.badge-fill');
    this.unitsFace = element.querySelector('.badge-units');
  }

  /** Recognition lifecycle → coarse kind, kept distinct from raw file-scan percent. */
  static recognitionKind(status, percent) {
    const text = String(status ?? '').toUpperCase();
    if (text.includes('COMMITTED')) return 'committed';
    if (text.includes('FAILED')) return 'failed';
    if (text.includes('SCAN COMPLETE')) return 'provisional';
    if (text.includes('COMMITTING')) return 'committing';
    if (Number(percent) >= 100) return 'provisional';
    if (text.length === 0 || text === 'IDLE') return 'idle';
    return 'scanning';
  }

  /**
   * @param {number}  now      performance.now()
   * @param {number}  percent  file-scan percent
   * @param {string}  status   recognition lifecycle status
   * @param {Array<{granularity:string,count:number}>} counts  per-category totals (>0 only)
   */
  update({ now, percent, status, counts }) {
    if (!this.element) return;
    const pct = Math.max(0, Math.min(100, Number(percent ?? 0)));
    const kind = ScanBadge.recognitionKind(status, pct);
    const scanning = kind === 'scanning' || kind === 'committing' || kind === 'provisional';
    const settled = kind === 'committed' || kind === 'failed';
    const categories = Array.isArray(counts) ? counts : [];

    // Decide which face shows.
    let desired;
    if (scanning) {
      this.everScanned = true;
      this.settleAt = null;      // restart the clock so alternation begins fresh after settle
      desired = 'scan';
    } else if (settled || categories.length > 0) {
      // Settled, or an idle-but-loaded graph: enter the bar↔units alternation.
      if (settled) this.everScanned = true;
      if (this.settleAt == null) this.settleAt = now;
      const phase = Math.floor((now - this.settleAt) / ScanBadge.PHASE_MS) % 2; // 0 = bar, 1 = units
      desired = phase === 1 ? 'units' : 'scan';
    } else {
      this.settleAt = null;
      desired = 'scan';          // idle, no graph yet — standby bar
    }
    if (desired === 'units' && categories.length === 0) desired = 'scan';

    if (desired !== this.mode) {
      this.mode = desired;
      this.element.dataset.mode = desired;
      this.element.classList.add('pulse');
      clearTimeout(this.pulseTimer);
      this.pulseTimer = setTimeout(() => this.element.classList.remove('pulse'), 560);
    }

    if (kind !== this.lastState) {
      this.lastState = kind;
      this.element.dataset.state = kind;
    }

    // Scan face: only touch DOM when the percent text changes.
    const percentText = `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
    if (percentText !== this.lastPercentText) {
      this.lastPercentText = percentText;
      if (this.percentEl) this.percentEl.textContent = percentText;
      if (this.fillEl) this.fillEl.style.width = `${pct}%`;
    }

    // Units face: rebuild the inline all-categories line only when the counts change.
    const sig = categories.map((c) => `${c.granularity}:${c.count}`).join('|');
    if (sig !== this.lastCountsSig && this.unitsFace) {
      this.lastCountsSig = sig;
      this.unitsFace.innerHTML = categories.map((c) => {
        const n = Number(c.count);
        const countText = Number.isFinite(n) ? compactNumber(n) : '—';
        const unitText = n === 1 ? String(c.granularity ?? 'unit').toUpperCase() : pluralGranularity(c.granularity);
        return `<span class="cat"><b class="badge-count">${escapeHtml(countText)}</b>`
          + `<span class="badge-unit">${escapeHtml(unitText)}</span></span>`;
      }).join('');
    }
  }
}

/**
 * Top-left directory. Renders the clicked (selected) node's full ancestor path as white,
 * clickable segments — clicking one navigates the graph to that node (moving "higher" when it
 * is an ancestor of the current selection). The segment matching the current *view* granularity
 * (from scroll) is marked blue: the merged "current granularity" readout that used to live in
 * the retired window, now following the operator's zoom along the path. Zoomed deeper than the
 * selection, the current granularity appears as a blue ghost token.
 */
export class NavigatorBreadcrumb {
  constructor(element) {
    this.element = element ?? null;
    this.onNavigate = null;
    if (!this.element) return;
    element.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('.crumb[data-id]') : null;
      if (!target) return;
      const id = target.getAttribute('data-id');
      if (id && typeof this.onNavigate === 'function') this.onNavigate(id);
    });
  }

  /**
   * @param {Array} ancestorsDeepestFirst  getAncestors(selected): [selected, …, root]
   * @param {number} activeDepth            current semantic depth (0=project … 6=function)
   * @param {string} currentGranularity     LEVEL_GRANULARITY[activeDepth]
   */
  update(ancestorsDeepestFirst = [], activeDepth = 0, currentGranularity = 'project') {
    if (!this.element) return;
    const ordered = [...ancestorsDeepestFirst].reverse(); // root → selected
    const selectedLevel = ordered.length ? Number(ordered[ordered.length - 1].level ?? 0) : 0;

    const parts = ordered.map((node) => {
      const isCurrent = Number(node.level) === Number(activeDepth);
      return `<span class="crumb${isCurrent ? ' current' : ''}" data-id="${escapeHtml(node.id)}" `
        + `data-level="${escapeHtml(node.level)}" role="button" tabindex="0" `
        + `title="Go to ${escapeHtml(node.label)}">${escapeHtml(node.label)}</span>`;
    });

    if (Number(activeDepth) > selectedLevel) {
      parts.push(`<span class="crumb current ghost" data-level="${escapeHtml(activeDepth)}">`
        + `${escapeHtml(String(currentGranularity ?? '').toUpperCase())}</span>`);
    }

    this.element.innerHTML = parts.join('<span class="separator">›</span>');
  }
}

export class QuickLabel {
  constructor(element) {
    this.element = element ?? null;
    if (!this.element) return;
    this.kind = element.querySelector('.quick-label-kind');
    this.name = element.querySelector('.quick-label-name');
  }

  show(node, projected, color) {
    if (!this.element) return;
    this.element.style.setProperty('--quick-color', color);
    if (this.kind) this.kind.textContent = `${String(node.granularity ?? 'unit').toUpperCase()} · ${String(node.phase ?? 'stable').toUpperCase()}`;
    if (this.name) this.name.textContent = node.label ?? node.id;
    this.move(projected);
    this.element.classList.add('visible');
  }

  move(projected) {
    if (!this.element) return;
    this.element.style.left = `${projected.x + Math.max(10, projected.radiusPx ?? 0)}px`;
    this.element.style.top = `${projected.y}px`;
  }

  hide() {
    if (!this.element) return;
    this.element.classList.remove('visible');
  }
}
