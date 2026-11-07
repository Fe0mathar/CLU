import { phaseLabel } from '../protocol.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toLocaleString() : String(value ?? '—');
}

function normalizedMetric(value, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, (number / Math.max(1, max)) * 100));
}

export class CinematicInspector {
  constructor(layer, options = {}) {
    this.layer = layer;
    this.options = {
      minimumMargin: options.minimumMargin ?? 24,
      preferredWidth: options.preferredWidth ?? 440,
      ...options,
    };
    this.panel = layer.querySelector('.inspector-panel');
    this.svg = layer.querySelector('.inspector-svg');
    this.leader = layer.querySelector('.inspector-leader');
    this.leaderBack = layer.querySelector('.inspector-leader-back');
    this.visibleNodeId = null;
    this.pinned = false;
    this.lastAnchor = null;
  }

  show(node, anchor, containerRect, color, options = {}) {
    this.visibleNodeId = node.id;
    this.lastAnchor = anchor;
    this.pinned = options.pinned ?? this.pinned;
    this.layer.style.setProperty('--inspector-color', color);
    this.#populate(node);
    this.#place(anchor, containerRect);
    // Restart trace animation even when retargeting in place.
    this.layer.classList.remove('visible');
    void this.layer.offsetWidth;
    this.layer.classList.add('visible');
  }

  updateAnchor(anchor, containerRect) {
    if (!this.visibleNodeId || !anchor) return;
    this.lastAnchor = anchor;
    this.#place(anchor, containerRect, false);
  }

  hide(force = false) {
    if (this.pinned && !force) return;
    this.layer.classList.remove('visible');
    this.visibleNodeId = null;
    this.lastAnchor = null;
    if (force) this.pinned = false;
    // Clear the connector geometry. The backing polyline is a near-opaque black stroke that
    // is not gated on `.visible`, so without clearing its points it lingers as a black line
    // artifact after the panel fades. Emptying points draws nothing.
    this.leader?.setAttribute('points', '');
    this.leaderBack?.setAttribute('points', '');
  }

  pin(value = true) {
    this.pinned = value;
  }

  #populate(node) {
    const details = node.details ?? {};
    const metrics = node.metrics ?? {};
    const history = Array.isArray(details.history) ? details.history : [];
    const optimized = details.optimized === 'verified'
      ? 'OPTIMIZED · VERIFIED'
      : details.optimized === true
        ? 'OPTIMIZED'
        : details.optimized === false
          ? 'IMPROVEMENT CANDIDATE'
          : 'OPTIMIZATION UNKNOWN';

    const classification = details.classification && details.classification !== 'UNCLASSIFIED'
      ? details.classification
      : [details.fileSpan, details.dependencySurface]
        .filter((value) => value && value !== 'unknown')
        .join(' · ') || 'UNCLASSIFIED';

    const metricRows = [
      ['INBOUND', formatNumber(metrics.inbound), normalizedMetric(metrics.inbound, 30)],
      ['OUTBOUND', formatNumber(metrics.outbound), normalizedMetric(metrics.outbound, 30)],
      ['DESCENDANTS', formatNumber(metrics.totalDescendants), normalizedMetric(metrics.totalDescendants, 250)],
      ['SOURCE UNITS', formatNumber(metrics.sourceUnits), normalizedMetric(metrics.sourceUnits, 20)],
      ['BLAST RADIUS', String(details.blastRadius ?? 'unknown').toUpperCase(), details.blastRadius === 'foundational' ? 100 : details.blastRadius === 'systemic' ? 72 : 28],
      ['CONFIDENCE', details.confidence == null ? '—' : `${(Number(details.confidence) * 100).toFixed(0)}%`, details.confidence == null ? 0 : Number(details.confidence) * 100],
    ];

    const historyHtml = history.length === 0
      ? '<div class="history-empty">NO GREAT BOOK RECORDS ARE ATTACHED TO THIS UNIT YET.</div>'
      : history.slice(-8).reverse().map((entry) => {
          const title = entry.title ?? entry.verdict ?? entry.kind ?? 'Ledger record';
          const summary = entry.summary ?? entry.result ?? entry.detail ?? '';
          const when = entry.at ?? entry.date ?? entry.generatedAt ?? '';
          return `<div class="history-entry"><strong>${escapeHtml(title)}</strong>${escapeHtml(summary)}${when ? `<br><small>${escapeHtml(when)}</small>` : ''}</div>`;
        }).join('');

    this.panel.innerHTML = `
      <div class="inspector-inner">
        <div class="inspector-header">
          <div>
            <div class="inspector-kicker">SYSTEM NAVIGATOR · ${escapeHtml(node.granularity)}</div>
            <div class="inspector-name">${escapeHtml(node.label)}</div>
            <div class="inspector-classification">${escapeHtml(classification)}</div>
          </div>
          <div class="inspector-status">${escapeHtml(phaseLabel(node.phase))}</div>
        </div>
        <div class="inspector-purpose">${escapeHtml(details.purpose ?? 'Purpose has not yet been supplied by CLUE.')}</div>
        <div class="inspector-id">${escapeHtml([...node.sourceLogicalIds][0] ?? node.id)}</div>
        <div class="metric-grid">
          ${metricRows.map(([label, value, normalized]) => `
            <div class="metric">
              <div class="metric-label">${escapeHtml(label)}</div>
              <div class="metric-value">${escapeHtml(value)}</div>
              <div class="metric-bar"><i style="--metric:${Math.max(0, Math.min(100, normalized))}%"></i></div>
            </div>
          `).join('')}
        </div>
        <div class="history-section">
          <div class="history-title"><span>GREAT BOOK OF TRUTH</span><span>${history.length} RECORD${history.length === 1 ? '' : 'S'}</span></div>
          <div class="history-list">${historyHtml}</div>
        </div>
        <div class="inspector-footer">
          <span>${escapeHtml(optimized)}</span>
          <span>${escapeHtml(node.modulePath ?? node.sourceKind ?? node.granularity)}</span>
        </div>
      </div>
    `;
  }

  #place(anchor, containerRect, updatePanel = true) {
    const margin = this.options.minimumMargin;
    const panelWidth = Math.min(this.options.preferredWidth, containerRect.width - margin * 2);
    const panelHeight = Math.min(560, containerRect.height - margin * 2);
    const preferRight = anchor.x < containerRect.width * 0.54;
    let left = preferRight ? anchor.x + 80 : anchor.x - panelWidth - 80;
    left = Math.max(margin, Math.min(containerRect.width - panelWidth - margin, left));
    let top = anchor.y - panelHeight * 0.42;
    top = Math.max(margin, Math.min(containerRect.height - panelHeight - margin, top));

    if (updatePanel) {
      this.panel.style.width = `${panelWidth}px`;
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
      this.panel.style.setProperty('--panel-origin', preferRight ? '0 50%' : '100% 50%');
    } else {
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
    }

    const connectionX = preferRight ? left : left + panelWidth;
    const connectionY = Math.max(top + 54, Math.min(top + panelHeight - 54, anchor.y));
    const bendX = preferRight
      ? Math.min(connectionX - 22, anchor.x + Math.max(28, (connectionX - anchor.x) * 0.56))
      : Math.max(connectionX + 22, anchor.x - Math.max(28, (anchor.x - connectionX) * 0.56));
    const points = `${anchor.x},${anchor.y} ${bendX},${anchor.y} ${connectionX},${connectionY}`;
    this.leader.setAttribute('points', points);
    this.leaderBack.setAttribute('points', points);
  }
}
