import { styles } from './styles.js';
import { WebGPUImprovementFieldScene } from '../render/WebGPUImprovementFieldScene.js';

export class FieldRenderer {
  readonly #root: ShadowRoot;
  readonly #scene: WebGPUImprovementFieldScene;
  readonly #canvas = document.createElement('canvas');
  readonly #sidebar = document.createElement('div');
  readonly #header = document.createElement('div');

  constructor(root: ShadowRoot, scene: WebGPUImprovementFieldScene) {
    this.#root = root;
    this.#scene = scene;
  }

  mount(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper';
    this.#header.className = 'header';
    this.#header.textContent = 'GREAT BOOK IMPROVEMENT FIELD';
    this.#canvas.className = 'field';
    this.#canvas.width = 1100;
    this.#canvas.height = 720;
    this.#sidebar.className = 'sidebar';
    this.#sidebar.innerHTML = '<div class="title">SELECTED CELL</div><div class="body">Awaiting projection…</div>';
    const style = document.createElement('style');
    style.textContent = styles;
    wrapper.append(this.#header, this.#canvas, this.#sidebar);
    this.#root.append(style, wrapper);
    this.#scene.attach(this.#canvas);
  }

  update(projection: any): void {
    this.#scene.render(projection, this.#canvas);
    const selected = projection?.selectedCell;
    this.#sidebar.innerHTML = selected
      ? `<div class="title">${selected.measurementId}</div>
         <div class="body">
           <div>Net: ${selected.value.toFixed(1)}</div>
           <div>Contributions: ${selected.contributionCount}</div>
           <div>Confidence: ${selected.confidence.toFixed(2)}</div>
           <div>Family: ${selected.family}</div>
           <div>Native: ${selected.contributions?.[0]?.native?.baseline} → ${selected.contributions?.[0]?.native?.result} ${selected.contributions?.[0]?.native?.unit}</div>
         </div>`
      : '<div class="title">SELECTED CELL</div><div class="body">None</div>';
  }
}
