import {
  clamp,
  damp,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  v3add,
  v3cross,
  v3damp,
  v3normalize,
  v3scale,
  v3sub,
} from './Math3D.js';

const LEVEL_DISTANCE = Object.freeze([108, 72, 48, 30, 18, 11, 6.6]);

/**
 * Orbit camera with semantic zoom.
 *
 * Distance is not merely visual: it selects which hierarchy depth the Navigator
 * presents. The camera therefore keeps a smooth visual state and a stable semantic
 * state, avoiding rapid level flicker around thresholds.
 */
export class NavigatorCamera {
  constructor(options = {}) {
    this.fov = options.fov ?? (48 * Math.PI) / 180;
    this.near = options.near ?? 0.08;
    this.far = options.far ?? 2000;
    this.minimumDistance = options.minimumDistance ?? 4.2;
    this.maximumDistance = options.maximumDistance ?? 150;
    this.target = [...(options.target ?? [0, 0, 0])];
    this.desiredTarget = [...this.target];
    this.yaw = options.yaw ?? 0.72;
    this.desiredYaw = this.yaw;
    this.pitch = options.pitch ?? 0.33;
    this.desiredPitch = this.pitch;
    this.distance = options.distance ?? LEVEL_DISTANCE[0];
    this.desiredDistance = this.distance;
    // The distance at which the current granularity's contents exactly fill the view.
    // The navigator compares desiredDistance against this to decide when a zoom gesture
    // should dive into a node or ascend out of the current scope.
    this.scopeDistance = this.distance;
    this.position = [0, 0, this.distance];
    this.right = [1, 0, 0];
    this.up = [0, 1, 0];
    this.forward = [0, 0, -1];
    this.viewProjection = new Float32Array(16);
    this.inverseViewProjection = new Float32Array(16);
    this.focusNodeId = null;
    this.cinematicBoostUntil = 0;
    this.semanticLevel = 0;
    this.#updateMatrices(1);
  }

  frameProject(center = [0, 0, 0]) {
    this.desiredTarget = [...center];
    this.desiredDistance = LEVEL_DISTANCE[0];
    this.scopeDistance = LEVEL_DISTANCE[0];
    this.desiredYaw = 0.72;
    this.desiredPitch = 0.33;
    this.focusNodeId = null;
  }

  /**
   * Frame a granularity's contents: place the target at `centroid` and pull the camera
   * back just far enough that a bounding sphere of `boundingRadius` fits the field of view
   * with margin, so everything the operator should see at this level sits centred in front
   * of them. The resulting distance is remembered as `scopeDistance`; the navigator uses it
   * to know when a further zoom-in means "dive" and a zoom-out means "ascend".
   */
  frameContents(centroid = [0, 0, 0], boundingRadius = 8, options = {}) {
    const margin = options.margin ?? 1.32;
    const radius = Math.max(boundingRadius, 0.75);
    const halfFov = this.fov / 2;
    const fit = (radius / Math.max(1e-3, Math.sin(halfFov))) * margin;
    this.desiredTarget = [...centroid];
    this.desiredDistance = clamp(fit, this.minimumDistance, this.maximumDistance);
    this.scopeDistance = this.desiredDistance;
    if (Number.isFinite(options.yaw)) this.desiredYaw = options.yaw;
    if (Number.isFinite(options.pitch)) this.desiredPitch = options.pitch;
    if (options.nodeId !== undefined) this.focusNodeId = options.nodeId;
    if (options.cinematic !== false) this.cinematicBoostUntil = performance.now() + 850;
  }

  focus(position, distance = this.distance, nodeId = null, options = {}) {
    this.desiredTarget = [...position];
    this.desiredDistance = clamp(distance, this.minimumDistance, this.maximumDistance);
    if (Number.isFinite(options.yaw)) this.desiredYaw = options.yaw;
    if (Number.isFinite(options.pitch)) this.desiredPitch = options.pitch;
    this.focusNodeId = nodeId;
    if (options.cinematic !== false) this.cinematicBoostUntil = performance.now() + 850;
  }

  distanceForLevel(level) {
    return LEVEL_DISTANCE[clamp(Math.round(level), 0, 6)] ?? LEVEL_DISTANCE[0];
  }

  orbit(deltaX, deltaY) {
    this.desiredYaw += deltaX;
    this.desiredPitch = clamp(this.desiredPitch + deltaY, -1.18, 1.18);
  }

  pan(deltaRight, deltaUp) {
    this.desiredTarget = v3add(
      this.desiredTarget,
      v3add(v3scale(this.right, deltaRight), v3scale(this.up, deltaUp)),
    );
  }

  zoom(delta) {
    this.desiredDistance = clamp(
      this.desiredDistance * Math.exp(delta),
      this.minimumDistance,
      this.maximumDistance,
    );
  }

  update(dt, width, height) {
    const cinematic = performance.now() < this.cinematicBoostUntil;
    const positionRate = cinematic ? 5.6 : 8.8;
    const orbitRate = cinematic ? 4.6 : 9.5;
    const distanceRate = cinematic ? 5.2 : 10.2;

    this.target = v3damp(this.target, this.desiredTarget, positionRate, dt);
    this.yaw = damp(this.yaw, this.desiredYaw, orbitRate, dt);
    this.pitch = damp(this.pitch, this.desiredPitch, orbitRate, dt);
    this.distance = damp(this.distance, this.desiredDistance, distanceRate, dt);
    this.#updateMatrices(Math.max(1e-5, width / Math.max(1, height)));
  }

  semanticDepth() {
    // Midpoints between canonical distances provide hysteresis-like stable regions.
    const distance = this.distance;
    let depth = 0;
    for (let level = 1; level < LEVEL_DISTANCE.length; level += 1) {
      const threshold = Math.sqrt(LEVEL_DISTANCE[level - 1] * LEVEL_DISTANCE[level]);
      if (distance <= threshold) depth = level;
    }
    this.semanticLevel = depth;
    return depth;
  }

  #updateMatrices(aspect) {
    const cosPitch = Math.cos(this.pitch);
    const orbit = [
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch,
    ];
    this.position = v3add(this.target, v3scale(orbit, this.distance));
    this.forward = v3normalize(v3sub(this.target, this.position));
    this.right = v3normalize(v3cross(this.forward, [0, 1, 0]));
    if (Math.hypot(...this.right) < 1e-5) this.right = [1, 0, 0];
    this.up = v3normalize(v3cross(this.right, this.forward));

    const view = mat4LookAt(this.position, this.target, this.up);
    const projection = mat4Perspective(this.fov, aspect, this.near, this.far);
    this.viewProjection = mat4Multiply(projection, view);
    this.inverseViewProjection = mat4Invert(this.viewProjection);
  }
}
