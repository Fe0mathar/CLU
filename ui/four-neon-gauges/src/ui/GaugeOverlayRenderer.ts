import type { FourNeonGaugesProjection, GaugeProjection } from '../protocol.js';

function percent(value: number | null): string {
  return value === null ? 'UNKNOWN' : `${Math.round(value * 100)}%`;
}

function primaryValue(gauge: GaugeProjection): string {
  if (gauge.projectionType === 'gate_state') return gauge.gateState ?? 'UNKNOWN';
  if (gauge.normalizedValue === null) return '—';
  if (gauge.projectionType === 'percentage') return `${Math.round(gauge.normalizedValue)}%`;
  const sign = gauge.normalizedValue > 0 ? '+' : '';
  return `${sign}${Math.round(gauge.normalizedValue)}`;
}

function deltaText(gauge: GaugeProjection): string {
  if (gauge.delta === null) return 'Δ unknown';
  const sign = gauge.delta > 0 ? '+' : '';
  return `Δ ${sign}${gauge.delta.toFixed(2)}${gauge.deltaUnit === null ? '' : ` ${gauge.deltaUnit}`}`;
}

function sparkline(history: readonly number[], color: string): string {
  if (history.length < 2) return '';
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = Math.max(max - min, 1e-9);
  const points = history.map((value, index) => {
    const x = index / (history.length - 1) * 80 + 1;
    const y = 24 - (value - min) / range * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 82 26" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.4"/><line x1="0" x2="82" y1="24.5" y2="24.5" stroke="${color}" opacity=".18"/></svg>`;
}

function detailText(gauge: GaugeProjection): string {
  return [
    `${gauge.metricId} — ${gauge.metricName}`,
    `Native: ${gauge.nativeValue.display}`,
    `Normalized: ${gauge.normalizedValue === null ? 'unknown' : gauge.normalizedValue.toFixed(2)}`,
    `Confidence: ${percent(gauge.confidence)}`,
    `Coverage: ${percent(gauge.coverage)}`,
    `Freshness: ${percent(gauge.freshness)}`,
    `Scope: ${gauge.scope.kind}:${gauge.scope.id}`,
    `Aggregation: ${gauge.aggregationMode}`,
    `Evidence: ${gauge.evidenceRef ?? 'none'}`,
  ].join('\n');
}

export class GaugeOverlayRenderer {
  private readonly container: HTMLDivElement;
  private projection: FourNeonGaugesProjection | null = null;

  public constructor(container: HTMLDivElement) {
    this.container = container;
  }

  public update(projection: FourNeonGaugesProjection): void {
    this.projection = projection;
    this.container.replaceChildren(...projection.gauges.map((gauge) => this.renderGauge(gauge)));
  }

  private renderGauge(gauge: GaugeProjection): HTMLElement {
    const card = document.createElement('article');
    card.className = 'gauge';
    card.tabIndex = 0;
    card.style.setProperty('--family', gauge.familyColor);
    card.setAttribute('aria-label', detailText(gauge));
    card.title = detailText(gauge);

    const identity = document.createElement('div');
    identity.className = 'identity';
    identity.innerHTML = `
      <div>
        <div class="metric-id">${gauge.metricId}</div>
        <div class="metric-name">${gauge.metricName}</div>
      </div>
      <div class="availability">${gauge.availability.toUpperCase()}</div>
    `;

    const spark = document.createElement('div');
    spark.className = 'spark';
    spark.innerHTML = sparkline(gauge.history, gauge.familyColor);

    const valueBlock = document.createElement('div');
    valueBlock.className = 'value-block';
    valueBlock.innerHTML = `
      <div class="primary">${primaryValue(gauge)}</div>
      <div class="native">${gauge.nativeValue.display}</div>
      <div class="delta">${deltaText(gauge)} · ${gauge.trend.toUpperCase()}</div>
    `;

    const warning = document.createElement('div');
    warning.className = 'warning';
    warning.textContent = gauge.warning ?? '';
    warning.hidden = gauge.warning === null;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <div class="meta-item"><div class="meta-label">CONFIDENCE</div><div class="meta-value">${percent(gauge.confidence)}</div></div>
      <div class="meta-item"><div class="meta-label">COVERAGE</div><div class="meta-value">${percent(gauge.coverage)}</div></div>
      <div class="meta-item"><div class="meta-label">FRESHNESS</div><div class="meta-value">${percent(gauge.freshness)}</div></div>
    `;

    card.append(identity, spark, warning, valueBlock, meta);
    card.addEventListener('click', () => {
      this.container.dispatchEvent(new CustomEvent('gauge-focus', {
        bubbles: true,
        composed: true,
        detail: { metricId: gauge.metricId, slot: gauge.slot },
      }));
    });
    card.addEventListener('dblclick', () => {
      this.container.dispatchEvent(new CustomEvent('gauge-open-catalogue', {
        bubbles: true,
        composed: true,
        detail: { metricId: gauge.metricId, evidenceRef: gauge.evidenceRef },
      }));
    });
    return card;
  }
}
