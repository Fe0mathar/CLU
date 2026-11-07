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

fn line(value: f32, width: f32) -> f32 {
  let distance = abs(fract(value) - 0.5);
  return 1.0 - smoothstep(width, width + 0.02, distance);
}

@fragment
fn fsMain(input: VertexOut) -> @location(0) vec4f {
  let aspect = max(globals.width / max(globals.height, 1.0), 1.0);
  let centered = (input.uv - vec2f(0.5)) * vec2f(aspect, 1.0);
  let perspectiveY = max(0.08, input.uv.y);
  let floorUv = vec2f(centered.x / perspectiveY, 1.0 / perspectiveY + globals.time * 0.08);
  let fineGrid = max(line(floorUv.x * 7.0, 0.035), line(floorUv.y * 2.5, 0.035));
  let majorGrid = max(line(floorUv.x * 1.75, 0.022), line(floorUv.y * 0.625, 0.022));
  let horizon = exp(-pow((input.uv.y - 0.47) * 24.0, 2.0));
  let scan = 0.55 + 0.45 * sin(input.uv.y * globals.height * 1.65 + globals.time * 5.0);
  let vignette = 1.0 - smoothstep(0.32, 0.78, length(centered));

  let blue = vec3f(0.0, 0.639, 0.878);
  let gold = vec3f(0.957, 0.686, 0.176);
  let orange = vec3f(1.0, 0.333, 0.0);
  let gridColor = blue * (fineGrid * 0.085 + majorGrid * 0.19);
  let activityGlow = blue * horizon * (0.09 + globals.activity * 0.17);
  let proofGlow = gold * horizon * globals.proof * 0.24;
  let warningGlow = orange * (0.04 + horizon * 0.2) * globals.warning;
  let color = (gridColor + activityGlow + proofGlow + warningGlow) * (0.78 + scan * 0.22) * vignette;
  return vec4f(color, 1.0);
}
