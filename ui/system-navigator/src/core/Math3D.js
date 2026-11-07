/**
 * Small deterministic math kernel for the CLUE System Navigator.
 *
 * Matrices are column-major, matching WGSL/WebGPU uniform layout conventions.
 * The module intentionally has no external dependency so the visualizer remains a
 * drop-in component inside the CLUE repository.
 */

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate-independent exponential convergence. */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-Math.max(0, lambda) * Math.max(0, dt)));
}

/** FNV-1a 32-bit hash. */
export function hashString(value) {
  const text = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hash01(value) {
  return hashString(value) / 0xffffffff;
}

export function hashSigned(value) {
  return hash01(value) * 2 - 1;
}

export function hexToRgb(hex) {
  const normalized = String(hex ?? '#00a3e0').replace('#', '').trim();
  const value = normalized.length === 3
    ? normalized.split('').map((character) => character + character).join('')
    : normalized.padEnd(6, '0').slice(0, 6);
  const number = Number.parseInt(value, 16);
  if (!Number.isFinite(number)) return [0, 0.6392156863, 0.8784313725];
  return [
    ((number >> 16) & 0xff) / 255,
    ((number >> 8) & 0xff) / 255,
    (number & 0xff) / 255,
  ];
}

export function v3add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function v3sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function v3scale(value, scalar) {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

export function v3dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function v3cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function v3length(value) {
  return Math.hypot(value[0], value[1], value[2]);
}

export function v3normalize(value) {
  const length = v3length(value);
  return length > 1e-9 ? v3scale(value, 1 / length) : [0, 0, 0];
}

export function v3lerp(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function v3damp(current, target, lambda, dt) {
  const t = 1 - Math.exp(-Math.max(0, lambda) * Math.max(0, dt));
  return v3lerp(current, target, t);
}

export function mat4Identity() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

/** Returns a * b. */
export function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    const b0 = b[column * 4 + 0];
    const b1 = b[column * 4 + 1];
    const b2 = b[column * 4 + 2];
    const b3 = b[column * 4 + 3];
    out[column * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[column * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[column * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[column * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/** Right-handed perspective matrix with WebGPU's 0..1 depth range. */
export function mat4Perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / Math.max(1e-6, aspect);
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (near * far) / (near - far);
  return out;
}

export function mat4LookAt(eye, target, upInput = [0, 1, 0]) {
  const z = v3normalize(v3sub(eye, target));
  let x = v3normalize(v3cross(upInput, z));
  if (v3length(x) < 1e-6) x = [1, 0, 0];
  const y = v3cross(z, x);

  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -v3dot(x, eye), -v3dot(y, eye), -v3dot(z, eye), 1,
  ]);
}

/** General 4x4 inverse, adapted to column-major matrices. */
export function mat4Invert(matrix) {
  const a00 = matrix[0], a01 = matrix[1], a02 = matrix[2], a03 = matrix[3];
  const a10 = matrix[4], a11 = matrix[5], a12 = matrix[6], a13 = matrix[7];
  const a20 = matrix[8], a21 = matrix[9], a22 = matrix[10], a23 = matrix[11];
  const a30 = matrix[12], a31 = matrix[13], a32 = matrix[14], a33 = matrix[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(determinant) < 1e-12) return mat4Identity();
  determinant = 1 / determinant;

  const out = new Float32Array(16);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * determinant;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * determinant;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * determinant;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * determinant;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * determinant;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * determinant;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * determinant;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * determinant;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * determinant;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * determinant;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * determinant;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * determinant;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * determinant;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * determinant;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * determinant;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * determinant;
  return out;
}

export function transformVec4(matrix, value) {
  return [
    matrix[0] * value[0] + matrix[4] * value[1] + matrix[8] * value[2] + matrix[12] * value[3],
    matrix[1] * value[0] + matrix[5] * value[1] + matrix[9] * value[2] + matrix[13] * value[3],
    matrix[2] * value[0] + matrix[6] * value[1] + matrix[10] * value[2] + matrix[14] * value[3],
    matrix[3] * value[0] + matrix[7] * value[1] + matrix[11] * value[2] + matrix[15] * value[3],
  ];
}

export function projectToScreen(position, viewProjection, width, height) {
  const clip = transformVec4(viewProjection, [position[0], position[1], position[2], 1]);
  if (clip[3] <= 1e-5) return null;
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  const ndcZ = clip[2] / clip[3];
  if (ndcZ < -0.1 || ndcZ > 1.1) return null;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
    depth: ndcZ,
    clipW: clip[3],
    ndcX,
    ndcY,
  };
}

export function unprojectScreen(x, y, depth, inverseViewProjection, width, height) {
  const ndc = [
    (x / Math.max(1, width)) * 2 - 1,
    1 - (y / Math.max(1, height)) * 2,
    depth,
    1,
  ];
  const world = transformVec4(inverseViewProjection, ndc);
  const reciprocal = Math.abs(world[3]) > 1e-9 ? 1 / world[3] : 1;
  return [world[0] * reciprocal, world[1] * reciprocal, world[2] * reciprocal];
}

export function screenRay(x, y, inverseViewProjection, width, height) {
  const near = unprojectScreen(x, y, 0, inverseViewProjection, width, height);
  const far = unprojectScreen(x, y, 1, inverseViewProjection, width, height);
  return { origin: near, direction: v3normalize(v3sub(far, near)) };
}
