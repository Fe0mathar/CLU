import { parseFourNeonGaugesProjection, type FourNeonGaugesProjection } from './protocol.js';
import { WebGPUNeonGaugeScene } from './render/WebGPUNeonGaugeScene.js';
import { GaugeOverlayRenderer } from './ui/GaugeOverlayRenderer.js';
import { gaugeStyles } from './ui/styles.js';

export class FourNeonGaugesElement extends HTMLElement {
  private readonly root: ShadowRoot;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLDivElement;
  private readonly fallback: HTMLDivElement;
  private readonly scene = new WebGPUNeonGaugeScene();
  private readonly renderer: GaugeOverlayRenderer;
  private connected = false;

  public constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = gaugeStyles;

    const frame = document.createElement('section');
    frame.className = 'frame';

    const header = document.createElement('header');
    header.className = 'header';
    header.innerHTML = `
      <div class="heading">FOUR NEON GAUGES</div>
      <div class="subheading">NATIVE TRUTH · NORMALIZED VIEW · EXACTLY FOUR</div>
    `;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scene';

    this.overlay = document.createElement('div');
    this.overlay.className = 'gauges';
    this.renderer = new GaugeOverlayRenderer(this.overlay);

    this.fallback = document.createElement('div');
    this.fallback.className = 'fallback';
    this.fallback.textContent = 'WEBGPU UNAVAILABLE — DATA REMAINS VISIBLE';
    this.fallback.hidden = true;

    frame.append(this.canvas, header, this.overlay, this.fallback);
    this.root.append(style, frame);
    this.scene.onDeviceLost((message) => {
      this.fallback.hidden = false;
      this.fallback.textContent = `WEBGPU DEVICE LOST — ${message}`;
      this.dispatchEvent(new CustomEvent('gauge-device-lost', { detail: { message } }));
    });
  }

  public connectedCallback(): void {
    if (this.connected) return;
    this.connected = true;
    void this.scene.attach(this.canvas).then((available) => {
      this.fallback.hidden = available;
    }).catch((error: unknown) => {
      this.fallback.hidden = false;
      this.fallback.textContent = `WEBGPU INITIALIZATION FAILED — ${String(error)}`;
    });
  }

  public disconnectedCallback(): void {
    this.scene.stop();
    this.connected = false;
  }

  public setProjection(input: unknown): void {
    const projection: FourNeonGaugesProjection = parseFourNeonGaugesProjection(input);
    this.renderer.update(projection);
    this.scene.setProjection(projection);
  }
}
