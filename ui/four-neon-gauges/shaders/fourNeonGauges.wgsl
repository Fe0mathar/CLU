struct GaugeUniforms {
  resolution: vec2<f32>,
  time: f32,
  pixelRatio: f32,
  values: vec4<f32>,
  deltas: vec4<f32>,
  confidence: vec4<f32>,
  coverage: vec4<f32>,
  freshness: vec4<f32>,
  colors: array<vec4<f32>, 4>,
  flags: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: GaugeUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return output;
}

fn sdRing(radius: f32, target: f32, thickness: f32) -> f32 {
  return abs(radius - target) - thickness;
}

fn arcCoordinate(angle: f32) -> f32 {
  let start = -2.35619449;
  let span = 4.71238898;
  var normalized = angle;
  if (normalized < start) {
    normalized = normalized + 6.28318531;
  }
  return (normalized - start) / span;
}

fn lineGlow(distance: f32, width: f32, softness: f32) -> f32 {
  return 1.0 - smoothstep(width, width + softness, abs(distance));
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = position.xy / u.resolution;
  let column = select(0u, 1u, uv.x >= 0.5);
  let row = select(0u, 1u, uv.y >= 0.5);
  let index = row * 2u + column;

  let cellUv = fract(uv * 2.0);
  var p = cellUv - vec2<f32>(0.5, 0.52);
  let cellAspect = u.resolution.x / max(u.resolution.y, 1.0);
  p.x = p.x * cellAspect;

  let radius = length(p);
  let angle = atan2(-p.y, p.x);
  let arcT = arcCoordinate(angle);
  let inArc = step(0.0, arcT) * step(arcT, 1.0);

  let family = u.colors[index].rgb;
  let value = u.values[index];
  let delta = u.deltas[index];
  let confidence = u.confidence[index];
  let coverage = u.coverage[index];
  let freshness = u.freshness[index];
  let flag = u.flags[index];

  let backgroundArc = lineGlow(sdRing(radius, 0.285, 0.014), 0.0, 0.008) * inArc;
  let progressMask = step(arcT, value);
  let progressArc = backgroundArc * progressMask;

  let tickPhase = abs(fract(arcT * 28.0) - 0.5);
  let tickMask = (1.0 - smoothstep(0.42, 0.49, tickPhase)) * inArc;
  let tickRing = lineGlow(sdRing(radius, 0.318, 0.004), 0.0, 0.003) * tickMask;

  let confidenceRing = lineGlow(sdRing(radius, 0.235, 0.006), 0.0, 0.004)
    * step(arcT, confidence) * inArc;
  let coverageRing = lineGlow(sdRing(radius, 0.205, 0.004), 0.0, 0.003)
    * step(arcT, coverage) * inArc;

  let sweepT = fract(u.time * 0.16 + f32(index) * 0.19);
  let sweep = exp(-pow((arcT - sweepT) * 34.0, 2.0)) * backgroundArc * freshness;

  let core = exp(-radius * 11.0) * (0.12 + 0.18 * sin(u.time * 1.8 + f32(index)));
  let panelGrid = 0.025 * (step(0.985, fract(cellUv.x * 18.0)) + step(0.985, fract(cellUv.y * 12.0)));

  let warningColor = vec3<f32>(1.0, 0.333, 0.0);
  let warningRing = lineGlow(sdRing(radius, 0.352, 0.007), 0.0, 0.006)
    * flag * (0.45 + 0.55 * sin(u.time * 4.0 + f32(index)));

  let deltaPositive = max(delta, 0.0);
  let deltaNegative = max(-delta, 0.0);
  let deltaPulse = exp(-pow((radius - 0.16) * 34.0, 2.0));

  var color = vec3<f32>(0.002, 0.012, 0.022);
  color = color + family * backgroundArc * 0.18;
  color = color + family * progressArc * 1.35;
  color = color + family * tickRing * 0.52;
  color = color + family * confidenceRing * 0.55;
  color = color + family * coverageRing * 0.34;
  color = color + family * sweep * 2.0;
  color = color + family * core;
  color = color + family * deltaPulse * deltaPositive * 0.24;
  color = color + warningColor * deltaPulse * deltaNegative * 0.34;
  color = color + warningColor * warningRing * 1.5;
  color = color + vec3<f32>(0.0, 0.14, 0.22) * panelGrid;

  let scanline = 0.97 + 0.03 * sin(position.y * 1.4 + u.time * 9.0);
  color = color * scanline;
  return vec4<f32>(color, 1.0);
}
