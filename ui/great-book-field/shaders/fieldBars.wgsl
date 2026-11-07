struct VsOut {
  @builtin(position) position : vec4<f32>,
  @location(0) height : f32,
  @location(1) familyColor : vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) position : vec3<f32>,
  @location(1) height : f32,
  @location(2) familyColor : vec3<f32>
) -> VsOut {
  var out : VsOut;
  out.position = vec4<f32>(position, 1.0);
  out.height = height;
  out.familyColor = familyColor;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let glow = 0.18 + abs(in.height) * 0.002;
  let color = in.familyColor + vec3<f32>(glow, glow, glow) * 0.25;
  return vec4<f32>(color, 0.95);
}
