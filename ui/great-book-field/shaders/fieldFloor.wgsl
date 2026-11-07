struct VsOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index : u32) -> VsOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
  );
  var out : VsOut;
  out.position = vec4<f32>(positions[index], 0.0, 1.0);
  out.uv = positions[index] * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let grid = step(0.96, fract(in.uv.x * 10.0)) + step(0.96, fract(in.uv.y * 10.0));
  let glow = 0.08 + grid * 0.22;
  return vec4<f32>(0.0, 0.55 + glow, 0.78 + glow * 0.8, 0.95);
}
