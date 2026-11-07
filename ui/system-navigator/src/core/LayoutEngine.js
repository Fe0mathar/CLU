import {
  hash01,
  hashSigned,
  v3add,
  v3cross,
  v3normalize,
  v3scale,
} from './Math3D.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const SHELL_RADIUS = Object.freeze({
  project: 0,
  domain: 18,
  subsystem: 9,
  module: 5.4,
  file: 3.2,
  class: 1.9,
  function: 1.15,
});

/**
 * Deterministic hierarchical 3D layout.
 *
 * A force solver is intentionally not the source of truth: force layouts shift every
 * time a new unit arrives and make recognition look like the architecture itself is
 * unstable. Each node receives a stable orbit slot derived from its id. A light local
 * relaxation only resolves immediate overlaps without changing the map's identity.
 */
export class LayoutEngine {
  constructor(model, options = {}) {
    this.model = model;
    this.options = {
      shellScale: options.shellScale ?? 1,
      verticalCompression: options.verticalCompression ?? 0.72,
      relaxationIterations: options.relaxationIterations ?? 3,
      ...options,
    };
    this.lastVersion = -1;
  }

  ensureCurrent() {
    if (this.lastVersion === this.model.version) return false;
    this.rebuild();
    return true;
  }

  rebuild() {
    const root = this.model.nodes.get(this.model.rootId);
    if (!root) return;
    root.basePosition = [0, 0, 0];
    this.#layoutChildren(root, [0, 1, 0], 0);
    this.#relaxSiblingOverlaps(root);
    this.lastVersion = this.model.version;
  }

  #layoutChildren(parent, parentAxis, depth) {
    const children = parent.children
      .map((id) => this.model.nodes.get(id))
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (children.length === 0) return;

    const shell = (SHELL_RADIUS[children[0].granularity] ?? 1) * this.options.shellScale;
    const seedAngle = hash01(`${parent.id}:angle`) * Math.PI * 2;
    const seedAxis = v3normalize([
      hashSigned(`${parent.id}:x`),
      0.35 + hash01(`${parent.id}:y`),
      hashSigned(`${parent.id}:z`),
    ]);
    let tangent = v3normalize(v3cross(seedAxis, Math.abs(seedAxis[1]) > 0.86 ? [1, 0, 0] : [0, 1, 0]));
    if (Math.hypot(...tangent) < 0.01) tangent = [1, 0, 0];
    const bitangent = v3normalize(v3cross(seedAxis, tangent));

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const normalizedIndex = (index + 0.5) / children.length;
      const y = 1 - 2 * normalizedIndex;
      const radial = Math.sqrt(Math.max(0, 1 - y * y));
      const angle = seedAngle + index * GOLDEN_ANGLE;
      const localDirection = v3add(
        v3scale(seedAxis, y * this.options.verticalCompression),
        v3add(
          v3scale(tangent, Math.cos(angle) * radial),
          v3scale(bitangent, Math.sin(angle) * radial),
        ),
      );
      const densityScale = Math.max(0.82, Math.min(1.65, Math.sqrt(children.length) / 2.2));
      const jitter = 0.88 + hash01(`${child.id}:shell`) * 0.24;
      child.basePosition = v3add(parent.basePosition, v3scale(localDirection, shell * densityScale * jitter));
      this.#layoutChildren(child, seedAxis, depth + 1);
    }
  }

  #relaxSiblingOverlaps(parent) {
    const children = parent.children.map((id) => this.model.nodes.get(id)).filter(Boolean);
    if (children.length > 1 && children.length < 180) {
      const minimumDistance = Math.max(0.8, (SHELL_RADIUS[children[0].granularity] ?? 1) * 0.22);
      for (let iteration = 0; iteration < this.options.relaxationIterations; iteration += 1) {
        for (let aIndex = 0; aIndex < children.length; aIndex += 1) {
          for (let bIndex = aIndex + 1; bIndex < children.length; bIndex += 1) {
            const a = children[aIndex];
            const b = children[bIndex];
            const delta = [
              b.basePosition[0] - a.basePosition[0],
              b.basePosition[1] - a.basePosition[1],
              b.basePosition[2] - a.basePosition[2],
            ];
            const distance = Math.hypot(...delta);
            if (distance >= minimumDistance || distance < 1e-4) continue;
            const push = (minimumDistance - distance) * 0.16;
            const direction = v3scale(delta, 1 / distance);
            a.basePosition = v3add(a.basePosition, v3scale(direction, -push));
            b.basePosition = v3add(b.basePosition, v3scale(direction, push));
          }
        }
      }
    }
    for (const child of children) this.#relaxSiblingOverlaps(child);
  }
}
