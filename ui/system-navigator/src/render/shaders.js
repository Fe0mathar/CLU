export const backgroundShader = /* wgsl */ `
struct Globals {
  viewProjection: mat4x4<f32>,
  inverseViewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  cameraRight: vec4<f32>,
  cameraUp: vec4<f32>,
  viewport: vec4<f32>,
};

@group(0) @binding(0) var<uniform> globals: Globals;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct FragmentOutput {
  @location(0) scene: vec4<f32>,
  @location(1) emissive: vec4<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  let position = positions[vertexIndex];
  var out: VertexOutput;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.uv = position * 0.5 + 0.5;
  return out;
}

fn hash21(p: vec2<f32>) -> f32 {
  let p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  let q = p3 + vec3<f32>(dot(p3, p3.yzx + vec3<f32>(33.33)));
  return fract((q.x + q.y) * q.z);
}

fn gridLine(value: f32, width: f32) -> f32 {
  let local = abs(fract(value - 0.5) - 0.5) / max(fwidth(value), 0.0001);
  return 1.0 - smoothstep(width, width + 1.0, local);
}

@fragment
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  let resolution = globals.viewport.xy;
  let time = globals.viewport.z;
  let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, (1.0 - in.uv.y) * 2.0 - 1.0);

  var background = vec3<f32>(0.0006, 0.002, 0.0045);
  let radial = max(0.0, 1.0 - length(ndc * vec2<f32>(0.82, 1.0)));
  background += vec3<f32>(0.0, 0.015, 0.028) * radial * radial;

  let near4 = globals.inverseViewProjection * vec4<f32>(ndc, 0.0, 1.0);
  let far4 = globals.inverseViewProjection * vec4<f32>(ndc, 1.0, 1.0);
  let nearPoint = near4.xyz / max(near4.w, 0.00001);
  let farPoint = far4.xyz / max(far4.w, 0.00001);
  let ray = normalize(farPoint - nearPoint);
  let floorY = -8.5;
  let planeT = (floorY - nearPoint.y) / ray.y;

  // fwidth (inside gridLine) must be evaluated in UNIFORM control flow, so the grid
  // lines are computed here, before the per-pixel if, and only used inside the branch.
  // world is derived unconditionally; when the ray misses the floor the branch discards
  // these values, exactly as before, but the derivative is now always taken.
  let world = nearPoint + ray * planeT;
  let distanceFade = exp(-length(world.xz) * 0.028);
  let majorX = gridLine(world.x * 0.10, 0.38);
  let majorZ = gridLine(world.z * 0.10, 0.38);
  let minorX = gridLine(world.x * 0.50, 0.18);
  let minorZ = gridLine(world.z * 0.50, 0.18);

  var gridGlow = 0.0;
  if (planeT > 0.0 && ray.y < -0.0001) {
    gridGlow = max(max(majorX, majorZ), max(minorX, minorZ) * 0.22) * distanceFade;
    let horizon = pow(max(0.0, 1.0 - abs(ray.y) * 7.0), 4.0);
    background += vec3<f32>(0.0, 0.20, 0.34) * gridGlow * 0.43;
    background += vec3<f32>(0.0, 0.08, 0.16) * horizon;
  }

  let pixel = in.uv * resolution;
  let starCell = floor(pixel / 31.0);
  let starNoise = hash21(starCell);
  let starLocal = fract(pixel / 31.0) - 0.5;
  let star = step(0.985, starNoise) * smoothstep(0.08, 0.0, length(starLocal));
  background += vec3<f32>(0.05, 0.46, 0.72) * star * (0.3 + 0.7 * sin(time * 1.7 + starNoise * 20.0) * 0.5 + 0.5);

  let scanline = 0.018 * sin(pixel.y * 0.62 + time * 1.4);
  background *= 1.0 + scanline;

  var out: FragmentOutput;
  out.scene = vec4<f32>(background, 1.0);
  out.emissive = vec4<f32>(vec3<f32>(0.0, 0.10, 0.18) * gridGlow, 1.0);
  return out;
}
`;

export const nodeShader = /* wgsl */ `
struct Globals {
  viewProjection: mat4x4<f32>,
  inverseViewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  cameraRight: vec4<f32>,
  cameraUp: vec4<f32>,
  viewport: vec4<f32>,
};

struct NodeData {
  positionRadius: vec4<f32>,
  colorOpacity: vec4<f32>,
  meta0: vec4<f32>,
  meta1: vec4<f32>,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage, read> nodes: array<NodeData>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) meta0: vec4<f32>,
  @location(3) meta1: vec4<f32>,
};

struct FragmentOutput {
  @location(0) scene: vec4<f32>,
  @location(1) emissive: vec4<f32>,
};

fn corner(vertexIndex: u32) -> vec2<f32> {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  return corners[vertexIndex];
}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let node = nodes[instanceIndex];
  let c = corner(vertexIndex);
  let time = globals.viewport.z;
  let seed = node.meta1.x;
  let level = node.meta1.w;
  let floatMagnitude = mix(0.018, 0.085, clamp(level / 6.0, 0.0, 1.0));
  let ambient = vec3<f32>(
    sin(time * 0.43 + seed * 0.013),
    sin(time * 0.57 + seed * 0.021 + 1.7),
    cos(time * 0.37 + seed * 0.017)
  ) * floatMagnitude;
  let sizePulse = 1.0 + node.meta0.y * 0.10;
  let world = node.positionRadius.xyz + ambient
    + globals.cameraRight.xyz * c.x * node.positionRadius.w * sizePulse
    + globals.cameraUp.xyz * c.y * node.positionRadius.w * sizePulse;

  var out: VertexOutput;
  out.position = globals.viewProjection * vec4<f32>(world, 1.0);
  out.local = c;
  out.color = node.colorOpacity;
  out.meta0 = node.meta0;
  out.meta1 = node.meta1;
  return out;
}

fn sdCircle(p: vec2<f32>, radius: f32) -> f32 {
  return length(p) - radius;
}

fn sdBox(p: vec2<f32>, halfSize: vec2<f32>) -> f32 {
  let d = abs(p) - halfSize;
  return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sdRhombus(pInput: vec2<f32>, size: vec2<f32>) -> f32 {
  let p = abs(pInput);
  let h = clamp((-2.0 * dot(p, size) + dot(size, size)) / dot(size, size), -1.0, 1.0);
  let d = length(p - 0.5 * size * vec2<f32>(1.0 - h, 1.0 + h));
  return d * sign(p.x * size.y + p.y * size.x - size.x * size.y);
}

fn sdRegularPolygon(p: vec2<f32>, radius: f32, sides: f32, rotation: f32) -> f32 {
  let angle = atan2(p.y, p.x) + rotation;
  let sector = 6.28318530718 / sides;
  return cos(floor(0.5 + angle / sector) * sector - angle) * length(p) - radius;
}

fn sdTriangle(pInput: vec2<f32>) -> f32 {
  var p = pInput;
  let k = 1.7320508;
  p.x = abs(p.x) - 0.62;
  p.y = p.y + 0.36;
  if (p.x + k * p.y > 0.0) {
    p = vec2<f32>(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  }
  p.x -= clamp(p.x, -1.15, 0.0);
  return -length(p) * sign(p.y);
}

fn shapeDistance(p: vec2<f32>, shape: f32) -> f32 {
  let index = i32(round(shape));
  if (index == 0) { return sdCircle(p, 0.68); }
  if (index == 1) { return sdRegularPolygon(p, 0.76, 6.0, 0.5235988); }
  if (index == 2) { return sdRegularPolygon(p, 0.76, 8.0, 0.3926991); }
  if (index == 3) { return sdRhombus(p, vec2<f32>(0.88, 0.64)); }
  if (index == 4) { return sdBox(p, vec2<f32>(0.78, 0.54)); }
  if (index == 5) { return sdTriangle(p * vec2<f32>(1.0, -1.0)); }
  return sdCircle(p, 0.57);
}

@fragment
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  let p = in.local;
  let shape = in.meta0.x;
  let pulse = in.meta0.y;
  let selected = in.meta0.z;
  let phase = in.meta0.w;
  let optimized = in.meta1.z;
  let distance = shapeDistance(p, shape);
  let aa = max(fwidth(distance) * 1.05, 0.0018);
  let inside = 1.0 - smoothstep(-aa, aa, distance);
  let outline = 1.0 - smoothstep(0.018, 0.018 + aa * 3.0, abs(distance));
  let innerLine = 1.0 - smoothstep(0.013, 0.013 + aa * 2.0, abs(distance + 0.105));
  let outerLine = 1.0 - smoothstep(0.018, 0.018 + aa * 2.5, abs(distance - 0.085));
  let center = 1.0 - smoothstep(0.08, 0.46, length(p));
  let singularityRing = select(0.0, 1.0 - smoothstep(0.014, 0.038, abs(length(p) - 0.34)), i32(round(shape)) == 0);
  let functionCore = select(0.0, 1.0 - smoothstep(0.04, 0.12, length(p)), i32(round(shape)) == 6);
  let scan = 0.5 + 0.5 * sin((p.y + globals.viewport.z * 0.32) * 19.0);
  let phaseEnergy = 0.45 + pulse * 1.65 + selected * 1.15;

  let base = in.color.rgb;
  let fill = inside * (0.165 + center * 0.16 + scan * 0.028);
  let geometry = outline * 1.25 + innerLine * 0.40 + outerLine * 0.24 + singularityRing * 0.85 + functionCore * 0.70;
  let alpha = in.color.a * clamp(fill * 2.0 + geometry, 0.0, 1.0);
  if (alpha < 0.005) { discard; }

  let gold = vec3<f32>(0.9569, 0.6863, 0.1765);
  let displayColor = mix(base, gold, selected * 0.68 + optimized * 0.20);
  let sceneColor = displayColor * (fill * 0.85 + geometry * 0.98);
  var emissiveColor = displayColor * geometry * (1.65 + phaseEnergy * 1.25);
  emissiveColor += displayColor * pulse * inside * 0.40;

  var out: FragmentOutput;
  out.scene = vec4<f32>(sceneColor, alpha);
  out.emissive = vec4<f32>(emissiveColor, alpha);
  return out;
}
`;

export const edgeShader = /* wgsl */ `
struct Globals {
  viewProjection: mat4x4<f32>,
  inverseViewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  cameraRight: vec4<f32>,
  cameraUp: vec4<f32>,
  viewport: vec4<f32>,
};
struct NodeData {
  positionRadius: vec4<f32>,
  colorOpacity: vec4<f32>,
  meta0: vec4<f32>,
  meta1: vec4<f32>,
};
struct EdgeData {
  indicesWeight: vec4<f32>,
  colorOpacity: vec4<f32>,
};
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage, read> nodes: array<NodeData>;
@group(0) @binding(2) var<storage, read> edges: array<EdgeData>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) along: f32,
};
struct FragmentOutput {
  @location(0) scene: vec4<f32>,
  @location(1) emissive: vec4<f32>,
};

fn endpointVertex(vertexIndex: u32) -> vec2<f32> {
  var values = array<vec2<f32>, 6>(
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  return values[vertexIndex];
}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let edge = edges[instanceIndex];
  let startNode = nodes[u32(edge.indicesWeight.x)];
  let endNode = nodes[u32(edge.indicesWeight.y)];
  let startClip = globals.viewProjection * vec4<f32>(startNode.positionRadius.xyz, 1.0);
  let endClip = globals.viewProjection * vec4<f32>(endNode.positionRadius.xyz, 1.0);
  let startNdc = startClip.xy / max(startClip.w, 0.00001);
  let endNdc = endClip.xy / max(endClip.w, 0.00001);
  let direction = normalize(endNdc - startNdc + vec2<f32>(0.000001));
  let normal = vec2<f32>(-direction.y, direction.x);
  let endpoint = endpointVertex(vertexIndex);
  let thicknessPx = 0.62 + min(2.6, log2(1.0 + edge.indicesWeight.z) * 0.42) + edge.indicesWeight.w * 0.8;
  let offsetNdc = normal * endpoint.y * thicknessPx * 2.0 / globals.viewport.xy;
  let clip = mix(startClip, endClip, endpoint.x);
  let clipOffset = vec4<f32>(offsetNdc * clip.w, 0.0, 0.0);
  let clipFinal = clip + clipOffset;

  var out: VertexOutput;
  out.position = clipFinal;
  out.color = edge.colorOpacity;
  out.along = endpoint.x;
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  let travel = 0.58 + 0.42 * sin(in.along * 26.0 - globals.viewport.z * 2.8);
  let alpha = in.color.a * (0.40 + travel * 0.35);
  let sceneColor = in.color.rgb * alpha * 0.42;
  let emissiveColor = in.color.rgb * alpha * 1.62;
  var out: FragmentOutput;
  out.scene = vec4<f32>(sceneColor, alpha);
  out.emissive = vec4<f32>(emissiveColor, alpha);
  return out;
}
`;

export const blurShader = /* wgsl */ `
struct BlurUniforms {
  texelAndDirection: vec4<f32>,
};
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> blur: BlurUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  let p = positions[vertexIndex];
  var out: VertexOutput;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let direction = blur.texelAndDirection.zw * blur.texelAndDirection.xy;
  var color = textureSample(sourceTexture, sourceSampler, in.uv) * 0.227027;
  color += textureSample(sourceTexture, sourceSampler, in.uv + direction * 1.384615) * 0.316216;
  color += textureSample(sourceTexture, sourceSampler, in.uv - direction * 1.384615) * 0.316216;
  color += textureSample(sourceTexture, sourceSampler, in.uv + direction * 3.230769) * 0.070270;
  color += textureSample(sourceTexture, sourceSampler, in.uv - direction * 3.230769) * 0.070270;
  return color;
}
`;

export const compositeShader = /* wgsl */ `
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  let p = positions[vertexIndex];
  var out: VertexOutput;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
  return out;
}

fn aces(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTexture, linearSampler, in.uv);
  let bloom = textureSample(bloomTexture, linearSampler, in.uv);
  let vignette = smoothstep(1.35, 0.20, length(in.uv - vec2<f32>(0.5)));
  let color = aces((scene.rgb + bloom.rgb * 1.15) * mix(0.76, 1.0, vignette));
  return vec4<f32>(color, 1.0);
}
`;
