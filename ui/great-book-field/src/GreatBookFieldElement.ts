import { FieldRenderer } from './ui/FieldRenderer.js';
import { WebGPUImprovementFieldScene } from './render/WebGPUImprovementFieldScene.js';

export class GreatBookFieldElement extends HTMLElement {
  #root: ShadowRoot;
  #renderer: FieldRenderer;
  #scene: WebGPUImprovementFieldScene;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#scene = new WebGPUImprovementFieldScene();
    this.#renderer = new FieldRenderer(this.#root, this.#scene);
  }

  connectedCallback(): void {
    this.#renderer.mount();
  }

  setProjection(projection: unknown): void {
    this.#renderer.update(projection as any);
  }
}
