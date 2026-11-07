import { SystemNavigator } from './SystemNavigator.js';
import { navigatorStyles } from './ui/styles.js';

const template = document.createElement('template');
template.innerHTML = `
  <style>${navigatorStyles}</style>
  <div class="navigator-root" part="root">
    <canvas class="graph-canvas" part="canvas" aria-label="CLUE System Navigator WebGPU graph"></canvas>
    <div class="frame" aria-hidden="true"></div>
    <div class="label-layer" part="labels" aria-hidden="true"></div>
    <div class="dragon-overlay" part="dragon" aria-hidden="true"></div>
    <div class="breadcrumb" part="breadcrumb"></div>
    <div class="quick-label" part="quick-label">
      <div class="quick-label-kind"></div>
      <div class="quick-label-name"></div>
    </div>
    <div class="inspector-layer" part="inspector">
      <svg class="inspector-svg" aria-hidden="true">
        <polyline class="inspector-leader-back" points="0,0 0,0 0,0"></polyline>
        <polyline class="inspector-leader" points="0,0 0,0 0,0"></polyline>
      </svg>
      <article class="inspector-panel"></article>
    </div>
    <div class="legend" part="legend">
      <span class="legend-title">STATE</span>
      <span class="legend-item legend-blue"><i class="legend-swatch"></i>STABLE</span>
      <span class="legend-item legend-orange"><i class="legend-swatch"></i>DIAGNOSE / TEST</span>
      <span class="legend-item legend-green"><i class="legend-swatch"></i>PATCH</span>
      <span class="legend-item legend-gold"><i class="legend-swatch"></i>SELECTED</span>
    </div>
    <div class="scan-badge" part="scan"></div>
    <div class="error-panel" role="alert"></div>
  </div>
`;

/**
 * Embeddable custom element.
 *
 * The element has no framework dependency. Add one script and one tag, then send
 * recognition events through its public methods.
 */
export class ClueSystemNavigatorElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.append(template.content.cloneNode(true));
    this.navigator = null;
    this.ready = this.#initialize();
  }

  async #initialize() {
    const root = this.shadowRoot.querySelector('.navigator-root');
    const canvas = this.shadowRoot.querySelector('.graph-canvas');
    const scanBadge = this.shadowRoot.querySelector('.scan-badge');
    const labelLayer = this.shadowRoot.querySelector('.label-layer');
    const dragonOverlay = this.shadowRoot.querySelector('.dragon-overlay');
    const breadcrumb = this.shadowRoot.querySelector('.breadcrumb');
    const quickLabel = this.shadowRoot.querySelector('.quick-label');
    const inspectorLayer = this.shadowRoot.querySelector('.inspector-layer');
    const errorPanel = this.shadowRoot.querySelector('.error-panel');

    const options = {
      projectName: this.getAttribute('project-name') ?? 'Murugan',
      audioEnabled: this.getAttribute('audio') !== 'off',
      discoveryCinematics: this.getAttribute('discovery-cinematics') !== 'off',
      autoStart: this.getAttribute('auto-start') !== 'off',
    };

    this.navigator = await SystemNavigator.create({
      host: this,
      root,
      canvas,
      scanBadge,
      labelLayer,
      dragonOverlay,
      breadcrumb,
      quickLabel,
      inspectorLayer,
      errorPanel,
    }, options);

    const forwarded = [
      'ready',
      'error',
      'recognition-progress',
      'node-added',
      'node-select',
      'node-focus',
      'node-inspect',
      'node-phase',
      'node-moved',
      'discovery-start',
      'discovery-complete',
      'semantic-depth',
      'observer-error',
      'recognition-committed',
      'overview-changed',
      'file-dive-entered',
      'file-dive-unavailable',
    ];
    for (const type of forwarded) {
      this.navigator.addEventListener(type, (event) => {
        this.dispatchEvent(new CustomEvent(type, {
          detail: event.detail,
          bubbles: true,
          composed: true,
        }));
      });
    }
    return this.navigator;
  }

  connectedCallback() {
    if (this.navigator && this.getAttribute('auto-start') !== 'off') this.navigator.start();
  }

  disconnectedCallback() {
    this.navigator?.stop();
  }

  async beginScan(payload) { return (await this.ready).beginScan(payload); }
  async updateProgress(payload) { return (await this.ready).updateProgress(payload); }
  async addUnit(unit, options) { return (await this.ready).addUnit(unit, options); }
  async addEdge(edge) { return (await this.ready).addEdge(edge); }
  async completeScan(payload) { return (await this.ready).completeScan(payload); }
  async loadRecognitionResult(result, options) { return (await this.ready).loadRecognitionResult(result, options); }
  async setNodePhase(id, phase, metadata) { return (await this.ready).setNodePhase(id, phase, metadata); }
  async setNodeDetails(id, details) { return (await this.ready).setNodeDetails(id, details); }
  async focusNode(id, options) { return (await this.ready).focusNode(id, options); }
  async enterDiveForFile(context) { return (await this.ready).enterDiveForFile(context); }
  async frameProject() { return (await this.ready).frameProject(); }
  async applyEvent(event) { return (await this.ready).applyEvent(event); }
  async enableAudio() { return (await this.ready).enableAudio(); }
  async exportViewState() { return (await this.ready).exportViewState(); }
  async importViewState(state) { return (await this.ready).importViewState(state); }
  async start() { return (await this.ready).start(); }
  async stop() { return (await this.ready).stop(); }

  destroy() {
    this.navigator?.destroy();
    this.navigator = null;
  }
}