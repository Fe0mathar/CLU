const shaderSource = /* wgsl */ `
struct Timing { elapsed: f32, width: f32, height: f32, padding: f32 }
@group(0) @binding(0) var glyph: texture_2d<f32>;
@group(0) @binding(1) var glyphSampler: sampler;
@group(0) @binding(2) var<uniform> timing: Timing;

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let vertices = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(vertices[index], 0, 1);
}

fn mask(uv: vec2f) -> f32 {
  return textureSample(glyph, glyphSampler, uv).a;
}

@fragment fn fragmentMain(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let uv = pixel.xy / vec2f(timing.width, timing.height);
  let texel = 1.0 / vec2f(timing.width, timing.height);
  let face = mask(uv);
  let near = max(
    max(mask(uv + vec2f(3, 0) * texel), mask(uv - vec2f(3, 0) * texel)),
    max(mask(uv + vec2f(0, 3) * texel), mask(uv - vec2f(0, 3) * texel))
  );
  let halo = 0.25 * (
    mask(uv + vec2f(10, 0) * texel) + mask(uv - vec2f(10, 0) * texel) +
    mask(uv + vec2f(0, 10) * texel) + mask(uv - vec2f(0, 10) * texel)
  );
  let depth = mask(uv - vec2f(2, 5) * texel) * (1.0 - face);
  let scanPosition = fract(timing.elapsed * 0.24) * 1.9 - 0.45;
  let scanDistance = uv.x + uv.y * 0.13 - scanPosition;
  let scan = exp(-65.0 * scanDistance * scanDistance);
  let striation = 0.96 + 0.04 * sin(pixel.y * 2.3);
  let alpha = max(max(face, near * 0.72), max(depth * 0.72, halo * 0.48));
  let upper = smoothstep(0.30, 0.65, uv.y);
  let metal = mix(vec3f(0.87, 0.99, 1.0), vec3f(0.23, 0.69, 0.88), upper);
  let light = metal * face * striation
    + vec3f(0.17, 0.74, 0.98) * (near - face) * 0.68
    + vec3f(0.04, 0.30, 0.63) * depth * 0.68
    + vec3f(0.12, 0.78, 0.99) * halo * 0.23
    + vec3f(0.66, 0.95, 1.0) * scan * face * 0.55;
  return vec4f(clamp(light, vec3f(0.0), vec3f(alpha)), alpha);
}
`;

function wordmarkMask(brand, width, height) {
  const document = brand.ownerDocument;
  const logo = brand.querySelector('.clue-ribbon-wordmark');
  const outline = logo?.querySelector('path')?.getAttribute('d');
  const geometry = logo?.viewBox.baseVal;
  const Path = document.defaultView?.Path2D;
  if (!outline || !geometry?.width || !geometry.height || !Path) return null;
  const image = document.createElement('canvas');
  image.width = width;
  image.height = height;
  const ink = image.getContext('2d');
  if (!ink) return null;
  const scale = Math.min((width - 38) / geometry.width, (height - 26) / geometry.height);
  ink.translate((width - geometry.width * scale) / 2, (height - geometry.height * scale) / 2);
  ink.scale(scale, scale);
  ink.fillStyle = '#fff';
  ink.fill(new Path(outline));
  return image;
}

export function mountRibbonWordmark(brand) {
  const canvas = brand?.querySelector('canvas');
  const document = canvas?.ownerDocument;
  const view = document?.defaultView;
  const gpu = view?.navigator?.gpu;
  if (!canvas || !view || !gpu) return () => {};

  let stopped = false;
  let animation = 0;
  let device;
  let context;
  let glyph;
  let uniform;
  let draw;
  const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
  const epoch = view.performance.now();

  function cancelFrame() {
    if (animation) view.cancelAnimationFrame(animation);
    animation = 0;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelFrame();
    reduced.removeEventListener('change', syncMotion);
    document.removeEventListener('visibilitychange', syncMotion);
    brand.removeAttribute('data-renderer');
    context?.unconfigure();
    glyph?.destroy();
    uniform?.destroy();
    device?.destroy();
  }

  function syncMotion() {
    cancelFrame();
    if (stopped || document.hidden || !draw) return;
    if (reduced.matches) {
      draw(0);
      return;
    }
    let last = -Infinity;
    const step = (now) => {
      if (stopped) return;
      if (now - last >= 40) {
        last = now;
        draw((now - epoch) / 1000);
      }
      if (!stopped) animation = view.requestAnimationFrame(step);
    };
    animation = view.requestAnimationFrame(step);
  }

  async function initialize() {
    const adapter = await gpu.requestAdapter({ powerPreference: 'low-power' });
    if (!adapter || stopped) return;
    const acquired = await adapter.requestDevice();
    if (stopped) { acquired.destroy(); return; }
    device = acquired;
    void device.lost.then(stop);
    context = canvas.getContext('webgpu');
    const { width, height } = canvas;
    const mask = wordmarkMask(brand, width, height);
    if (!context || !mask) { stop(); return; }

    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });
    glyph = device.createTexture({
      size: [width, height], format: 'rgba8unorm',
      usage: view.GPUTextureUsage.TEXTURE_BINDING | view.GPUTextureUsage.COPY_DST | view.GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: mask }, { texture: glyph }, [width, height]);
    uniform = device.createBuffer({ size: 16, usage: view.GPUBufferUsage.UNIFORM | view.GPUBufferUsage.COPY_DST });
    const shader = device.createShaderModule({ code: shaderSource });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vertexMain' },
      fragment: { module: shader, entryPoint: 'fragmentMain', targets: [{ format }] },
    });
    if (stopped) return;

    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: glyph.createView() },
        { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 2, resource: { buffer: uniform } },
      ],
    });
    const timing = new Float32Array([0, width, height, 0]);
    draw = (elapsed) => {
      try {
        timing[0] = elapsed;
        device.queue.writeBuffer(uniform, 0, timing);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store',
        }] });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        brand.dataset.renderer = 'webgpu';
      } catch {
        stop();
      }
    };
    reduced.addEventListener('change', syncMotion);
    document.addEventListener('visibilitychange', syncMotion);
    syncMotion();
  }

  void initialize().catch(stop);
  return stop;
}
