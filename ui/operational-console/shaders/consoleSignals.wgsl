struct Globals {
  time: f32,
  activity: f32,
  warning: f32,
  proof: f32,
  channel: f32,
  width: f32,
  height: f32,
  dpr: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var out: VertexOut;
  let position = positions[index];
  out.position = vec4f(position, 0.0, 1.0);
  out.uv = position * 0.5 + vec2f(0.5);
  return out;
}

fn glowLine(distance: f32, width: f32) -> f32 {
  return exp(-pow(distance / max(width, 0.0001), 2.0));
}

@fragment
fn fsMain(input: VertexOut) -> @location(0) vec4f {
  let blue = vec3f(0.0, 0.639, 0.878);
  let gold = vec3f(0.957, 0.686, 0.176);
  let orange = vec3f(1.0, 0.333, 0.0);
  let x = input.uv.x;
  let y = input.uv.y;
  let lane = 0.16 + fract(globals.channel * 0.173) * 0.66;
  let wave = lane + sin(x * 20.0 + globals.time * 4.8) * (0.006 + globals.activity * 0.012);
  let primary = glowLine(abs(y - wave), 0.004 + globals.activity * 0.004);
  let packetX = fract(globals.time * (0.13 + globals.activity * 0.22) + globals.channel * 0.097);
  let packet = glowLine(abs(x - packetX), 0.018) * glowLine(abs(y - wave), 0.02);
  let warningBand = glowLine(abs(y - (0.87 + sin(globals.time * 7.0) * 0.004)), 0.004) * globals.warning;
  let proofBand = glowLine(abs(y - 0.09), 0.003) * globals.proof;
  let rgb = blue * (primary * 0.35 + packet * 1.8) + orange * warningBand + gold * proofBand;
  let alpha = clamp(primary * 0.2 + packet + warningBand + proofBand, 0.0, 0.95);
  return vec4f(rgb, alpha);
}
