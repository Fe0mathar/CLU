import { OperationalConsoleClient } from './OperationalConsoleClient.js';
import { OperationalConsoleState } from './OperationalConsoleState.js';
import { parseConsoleProjection, type ConsoleEvent, type ConsoleProjection } from './protocol.js';
import { WebGPUConsoleScene } from './render/WebGPUConsoleScene.js';
import { ConsoleRenderer } from './ui/ConsoleRenderer.js';
import { OPERATIONAL_CONSOLE_STYLES } from './ui/styles.js';

function template(): string {
  return `
    <style>${OPERATIONAL_CONSOLE_STYLES}</style>
    <canvas class="backdrop" aria-hidden="true"></canvas>
    <div class="noise" aria-hidden="true"></div>
    <div class="scanlines" aria-hidden="true"></div>
    <div class="frame-glow" aria-hidden="true"></div>
    <div class="fallback" data-visible="false">WEBGPU BACKDROP UNAVAILABLE · TEXTUAL CONSOLE REMAINS AUTHORITATIVE</div>
    <div class="shell">
      <header class="top-rail">
        <div class="brand">
          <span class="brand-mark"></span>
          <span>
            <span class="brand-title">CLU-E OPERATIONAL CONSOLE</span><br>
            <span class="brand-subtitle">SOURCE-FAITHFUL TRANSPORT MIRROR</span>
          </span>
        </div>
        <div class="channel-strip" aria-label="Console channels"></div>
        <div class="status-micro">
          <span class="live-dot" data-state="disconnected"></span>
          <span data-role="live-text">STREAM DISCONNECTED</span>
        </div>
      </header>
      <section class="work-contract" aria-label="Current work contract"></section>
      <section class="event-viewport" aria-label="Operational traffic">
        <div class="event-scroll"></div>
        <div class="empty-state">AWAITING REAL CLU-E TRAFFIC<br>NO OPERATION WILL BE FABRICATED</div>
      </section>
      <footer class="footer-rail">
        <button class="control-button primary" type="button" data-action="status">CLU-E STATUS</button>
        <button class="control-button" type="button" data-action="autoscroll">PAUSE AUTO-SCROLL</button>
        <button class="control-button" type="button" data-action="pause">PAUSE STREAM</button>
        <span class="footer-spacer"></span>
        <span class="footer-readout">SEQ — · OFFLINE</span>
      </footer>
      <aside class="detail-drawer" data-open="false">
        <header class="detail-header">
          <div class="detail-title">RAW REDACTED ARTIFACT</div>
          <button class="control-button" type="button" data-action="close-detail">CLOSE</button>
        </header>
        <div class="detail-body"></div>
      </aside>
    </div>
  `;
}

export class ClueOperationalConsoleElement extends HTMLElement {
  private readonly state = new OperationalConsoleState();
  private client: OperationalConsoleClient | null = null;
  private scene: WebGPUConsoleScene | null = null;
  private renderer: ConsoleRenderer | null = null;

  public static get observedAttributes(): readonly string[] {
    return ['endpoint'];
  }

  public constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = template();
  }

  public connectedCallback(): void {
    const shadow = this.shadowRoot;
    if (shadow === null) return;
    this.renderer = new ConsoleRenderer(shadow, this.state);
    const canvas = shadow.querySelector<HTMLCanvasElement>('canvas.backdrop');
    if (canvas !== null) {
      this.scene = new WebGPUConsoleScene(canvas);
      void this.scene
        .initialize(this.shaderBase())
        .then((available) => {
          const fallback = shadow.querySelector<HTMLElement>('.fallback');
          if (fallback !== null) fallback.dataset['visible'] = String(!available);
        })
        .catch((error: unknown) => {
          const fallback = shadow.querySelector<HTMLElement>('.fallback');
          if (fallback !== null) {
            fallback.dataset['visible'] = 'true';
            fallback.textContent = `WEBGPU BACKDROP FAILED · ${String(error)}`;
          }
        });
    }
    void this.connect();
  }

  public disconnectedCallback(): void {
    this.client?.disconnect();
    this.client = null;
    this.scene?.destroy();
    this.scene = null;
  }

  public attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'endpoint' || oldValue === newValue || !this.isConnected) return;
    void this.connect();
  }

  public setProjection(value: ConsoleProjection | unknown): void {
    const projection = parseConsoleProjection(value);
    this.state.replace(projection);
    for (const event of projection.events.slice(-12)) this.scene?.notify(event);
    this.renderer?.render();
  }

  public appendEvent(event: ConsoleEvent): void {
    this.state.append(event);
    this.scene?.notify(event);
  }

  private endpoint(): string {
    return (this.getAttribute('endpoint') ?? '').replace(/\/$/, '');
  }

  private shaderBase(): string {
    const configured = this.getAttribute('shader-base');
    if (configured !== null) return configured.replace(/\/$/, '');
    return `${this.endpoint()}/shaders`;
  }

  private async connect(): Promise<void> {
    this.client?.disconnect();
    const client = new OperationalConsoleClient({ baseUrl: this.endpoint() });
    this.client = client;
    this.renderer?.setArtifactLoader((hash) => client.artifact(hash));
    client.addEventListener('console-event', (event) => {
      const detail = (event as CustomEvent<ConsoleEvent>).detail;
      this.appendEvent(detail);
      this.renderer?.setConnected(true);
    });
    client.addEventListener('console-disconnected', () => this.renderer?.setConnected(false));
    client.addEventListener('console-error', (event) => {
      this.dispatchEvent(
        new CustomEvent('operational-console-error', {
          detail: (event as CustomEvent).detail,
          bubbles: true,
          composed: true,
        }),
      );
    });
    try {
      const projection = await client.snapshot();
      this.setProjection(projection);
      client.connect(projection.lastSequence ?? -1);
      this.renderer?.setConnected(true);
    } catch {
      client.connect(-1);
      this.renderer?.setConnected(false);
    }
  }
}
