import { backgroundShader, blurShader, compositeShader, edgeShader, nodeShader } from './shaders.js';

const GLOBAL_FLOATS = 48;
const NODE_FLOATS = 16;
const EDGE_FLOATS = 8;

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function blendState() {
  return {
    color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
}

function textureDescriptor(label, width, height, format = 'rgba16float') {
  return {
    label,
    size: { width, height },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  };
}

/** WebGPU graph renderer with a two-scale bloom pipeline. */
export class WebGPUScene extends EventTarget {
  constructor(canvas, options = {}) {
    super();
    this.canvas = canvas;
    this.options = {
      powerPreference: options.powerPreference ?? 'high-performance',
      // Fidelity contract: render internally at antialiasScale × DPR and let the composite +
      // CSS downscale resolve it — supersampled AA without MSAA or any shader change. The
      // pixel budget keeps 4K / high-DPR hosts from tanking the frame rate: the effective
      // scale degrades gracefully (never below native DPR) instead of overshooting.
      antialiasScale: options.antialiasScale ?? 1.6,
      bloomScale: options.bloomScale ?? 0.5,
      maxRenderPixels: options.maxRenderPixels ?? 9_500_000,
      ...options,
    };
    this.device = null;
    this.adapter = null;
    this.context = null;
    this.canvasFormat = null;
    this.width = 1;
    this.height = 1;
    this.presentWidth = 1;
    this.presentHeight = 1;
    this.renderScale = 1;
    this.nodeCapacity = 0;
    this.edgeCapacity = 0;
    this.nodeBuffer = null;
    this.edgeBuffer = null;
    this.globalBuffer = null;
    this.blurBuffers = [];
    this.textures = null;
    this.bloomWidth = 1;
    this.bloomHeight = 1;
    this.destroyed = false;
    this.lastRenderStats = { nodes: 0, edges: 0, width: 0, height: 0 };
  }

  static async create(canvas, options = {}) {
    const scene = new WebGPUScene(canvas, options);
    await scene.initialize();
    return scene;
  }

  async initialize() {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU is unavailable. CLUE System Navigator requires a WebGPU-capable Chromium browser.');
    }
    this.adapter = await navigator.gpu.requestAdapter({ powerPreference: this.options.powerPreference });
    if (!this.adapter) throw new Error('No WebGPU adapter was returned.');
    this.device = await this.adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) throw new Error('Could not acquire a WebGPU canvas context.');
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: 'opaque',
    });

    this.globalBuffer = this.device.createBuffer({
      label: 'clue.navigator.globals',
      size: GLOBAL_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.blurBuffers = [0, 1].map((index) => this.device.createBuffer({
      label: `clue.navigator.blurUniforms.${index}`,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    this.linearSampler = this.device.createSampler({
      label: 'clue.navigator.linearSampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });

    this.#createPipelines();
    this.#ensureNodeCapacity(64);
    this.#ensureEdgeCapacity(128);
    this.resize(true);

    this.device.lost.then((info) => {
      if (this.destroyed) return;
      this.dispatchEvent(new CustomEvent('device-lost', { detail: info }));
    });
    this.device.addEventListener?.('uncapturederror', (event) => {
      this.dispatchEvent(new CustomEvent('gpu-error', { detail: event.error }));
    });
  }

  resize(force = false) {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const clientWidth = Math.max(1, this.canvas.clientWidth);
    const clientHeight = Math.max(1, this.canvas.clientHeight);
    // Effective supersample: requested scale clamped so the internal target never exceeds the
    // pixel budget, and never drops below native DPR resolution.
    let scale = Math.max(1, this.options.antialiasScale);
    const budget = Math.max(2_000_000, this.options.maxRenderPixels);
    const basePixels = clientWidth * clientHeight * dpr * dpr;
    if (basePixels * scale * scale > budget) scale = Math.max(1, Math.sqrt(budget / basePixels));
    const displayWidth = Math.max(1, Math.floor(clientWidth * dpr * scale));
    const displayHeight = Math.max(1, Math.floor(clientHeight * dpr * scale));
    const presentWidth = Math.max(1, Math.floor(clientWidth * dpr));
    const presentHeight = Math.max(1, Math.floor(clientHeight * dpr));
    if (!force && displayWidth === this.width && displayHeight === this.height) return false;
    this.renderScale = scale;
    this.presentWidth = presentWidth;
    this.presentHeight = presentHeight;
    this.width = displayWidth;
    this.height = displayHeight;
    this.canvas.width = displayWidth;
    this.canvas.height = displayHeight;
    this.#recreateTargets();
    return true;
  }

  /** Host fidelity knob: adjust supersampling live (clamped 0.75–2.5); returns the effective scale. */
  setAntialiasScale(scale) {
    this.options.antialiasScale = Math.min(2.5, Math.max(0.75, Number(scale) || 1));
    this.resize(true);
    return this.renderScale;
  }

  render(frame) {
    if (this.destroyed) return;
    this.resize();
    const nodes = frame.nodes ?? [];
    const edges = frame.edges ?? [];
    this.#ensureNodeCapacity(Math.max(1, nodes.length));
    this.#ensureEdgeCapacity(Math.max(1, edges.length));
    this.#writeGlobals(frame.camera, frame.timeSeconds ?? 0, frame.semanticDepth ?? 0);
    this.#writeNodes(nodes);
    this.#writeEdges(edges);

    const encoder = this.device.createCommandEncoder({ label: 'clue.navigator.frame' });
    const sceneView = this.textures.scene.createView();
    const emissiveView = this.textures.emissive.createView();

    {
      const pass = encoder.beginRenderPass({
        label: 'clue.navigator.scene',
        colorAttachments: [
          { view: sceneView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
          { view: emissiveView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      // Background grid / horizon / stars / scanline removed — leave only the graph on black.
      // The scene + emissive attachments are already cleared to solid black above, so skipping
      // this draw yields a pure black background with only edges + nodes. The backgroundPipeline
      // is still built (see setup), so restoring it is a one-line change: re-add
      //   pass.setPipeline(this.backgroundPipeline);
      //   pass.setBindGroup(0, this.backgroundBindGroup);
      //   pass.draw(3);

      if (edges.length > 0) {
        pass.setPipeline(this.edgePipeline);
        pass.setBindGroup(0, this.edgeBindGroup);
        pass.draw(6, edges.length);
      }
      if (nodes.length > 0) {
        pass.setPipeline(this.nodePipeline);
        pass.setBindGroup(0, this.nodeBindGroup);
        pass.draw(6, nodes.length);
      }
      pass.end();
    }

    this.#encodeBlur(encoder, this.textures.emissive.createView(), this.textures.bloomA.createView(), [1, 0], 0);
    this.#encodeBlur(encoder, this.textures.bloomA.createView(), this.textures.bloomB.createView(), [0, 1], 1);

    {
      const currentView = this.context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        label: 'clue.navigator.composite',
        colorAttachments: [
          { view: currentView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, this.compositeBindGroup);
      pass.draw(3);
      pass.end();
    }

    this.device.queue.submit([encoder.finish()]);
    this.lastRenderStats = { nodes: nodes.length, edges: edges.length, width: this.width, height: this.height, renderScale: this.renderScale };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.nodeBuffer?.destroy();
    this.edgeBuffer?.destroy();
    this.globalBuffer?.destroy();
    for (const buffer of this.blurBuffers) buffer.destroy();
    this.blurBuffers = [];
    this.#destroyTargets();
    this.context?.unconfigure();
  }

  #createPipelines() {
    const sceneTargets = [
      { format: 'rgba16float', blend: blendState(), writeMask: GPUColorWrite.ALL },
      { format: 'rgba16float', blend: blendState(), writeMask: GPUColorWrite.ALL },
    ];

    this.backgroundPipeline = this.device.createRenderPipeline({
      label: 'clue.navigator.backgroundPipeline',
      layout: 'auto',
      vertex: { module: this.device.createShaderModule({ code: backgroundShader }), entryPoint: 'vertexMain' },
      fragment: {
        module: this.device.createShaderModule({ code: backgroundShader }),
        entryPoint: 'fragmentMain',
        targets: sceneTargets,
      },
      primitive: { topology: 'triangle-list' },
    });

    this.nodePipeline = this.device.createRenderPipeline({
      label: 'clue.navigator.nodePipeline',
      layout: 'auto',
      vertex: { module: this.device.createShaderModule({ code: nodeShader }), entryPoint: 'vertexMain' },
      fragment: {
        module: this.device.createShaderModule({ code: nodeShader }),
        entryPoint: 'fragmentMain',
        targets: sceneTargets,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    this.edgePipeline = this.device.createRenderPipeline({
      label: 'clue.navigator.edgePipeline',
      layout: 'auto',
      vertex: { module: this.device.createShaderModule({ code: edgeShader }), entryPoint: 'vertexMain' },
      fragment: {
        module: this.device.createShaderModule({ code: edgeShader }),
        entryPoint: 'fragmentMain',
        targets: sceneTargets,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    const blurModule = this.device.createShaderModule({ code: blurShader });
    this.blurPipeline = this.device.createRenderPipeline({
      label: 'clue.navigator.blurPipeline',
      layout: 'auto',
      vertex: { module: blurModule, entryPoint: 'vertexMain' },
      fragment: { module: blurModule, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });

    const compositeModule = this.device.createShaderModule({ code: compositeShader });
    this.compositePipeline = this.device.createRenderPipeline({
      label: 'clue.navigator.compositePipeline',
      layout: 'auto',
      vertex: { module: compositeModule, entryPoint: 'vertexMain' },
      fragment: { module: compositeModule, entryPoint: 'fragmentMain', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  #ensureNodeCapacity(count) {
    if (count <= this.nodeCapacity) return;
    this.nodeCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
    this.nodeBuffer?.destroy();
    this.nodeBuffer = this.device.createBuffer({
      label: 'clue.navigator.nodes',
      size: align(this.nodeCapacity * NODE_FLOATS * 4, 256),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#rebuildGraphBindGroups();
  }

  #ensureEdgeCapacity(count) {
    if (count <= this.edgeCapacity) return;
    this.edgeCapacity = Math.max(128, 2 ** Math.ceil(Math.log2(count)));
    this.edgeBuffer?.destroy();
    this.edgeBuffer = this.device.createBuffer({
      label: 'clue.navigator.edges',
      size: align(this.edgeCapacity * EDGE_FLOATS * 4, 256),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#rebuildGraphBindGroups();
  }

  #rebuildGraphBindGroups() {
    if (!this.globalBuffer) return;
    this.backgroundBindGroup = this.device.createBindGroup({
      label: 'clue.navigator.backgroundBindGroup',
      layout: this.backgroundPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globalBuffer } }],
    });
    if (this.nodeBuffer) {
      this.nodeBindGroup = this.device.createBindGroup({
        label: 'clue.navigator.nodeBindGroup',
        layout: this.nodePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.globalBuffer } },
          { binding: 1, resource: { buffer: this.nodeBuffer } },
        ],
      });
    }
    if (this.nodeBuffer && this.edgeBuffer) {
      this.edgeBindGroup = this.device.createBindGroup({
        label: 'clue.navigator.edgeBindGroup',
        layout: this.edgePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.globalBuffer } },
          { binding: 1, resource: { buffer: this.nodeBuffer } },
          { binding: 2, resource: { buffer: this.edgeBuffer } },
        ],
      });
    }
  }

  #recreateTargets() {
    this.#destroyTargets();
    const bloomWidth = Math.max(1, Math.floor(this.width * this.options.bloomScale));
    const bloomHeight = Math.max(1, Math.floor(this.height * this.options.bloomScale));
    this.bloomWidth = bloomWidth;
    this.bloomHeight = bloomHeight;
    this.textures = {
      scene: this.device.createTexture(textureDescriptor('clue.navigator.scene', this.width, this.height)),
      emissive: this.device.createTexture(textureDescriptor('clue.navigator.emissive', this.width, this.height)),
      bloomA: this.device.createTexture(textureDescriptor('clue.navigator.bloomA', bloomWidth, bloomHeight)),
      bloomB: this.device.createTexture(textureDescriptor('clue.navigator.bloomB', bloomWidth, bloomHeight)),
    };
    this.#rebuildCompositeBindGroup();
  }

  #destroyTargets() {
    if (!this.textures) return;
    for (const texture of Object.values(this.textures)) texture.destroy();
    this.textures = null;
  }

  #rebuildCompositeBindGroup() {
    this.compositeBindGroup = this.device.createBindGroup({
      label: 'clue.navigator.compositeBindGroup',
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.textures.scene.createView() },
        { binding: 1, resource: this.textures.bloomB.createView() },
        { binding: 2, resource: this.linearSampler },
      ],
    });
  }

  #encodeBlur(encoder, sourceView, targetView, direction, uniformIndex) {
    const targetWidth = this.bloomWidth;
    const targetHeight = this.bloomHeight;
    const uniforms = new Float32Array([
      1 / Math.max(1, targetWidth),
      1 / Math.max(1, targetHeight),
      direction[0],
      direction[1],
    ]);
    const uniformBuffer = this.blurBuffers[uniformIndex];
    this.device.queue.writeBuffer(uniformBuffer, 0, uniforms);
    const bindGroup = this.device.createBindGroup({
      label: 'clue.navigator.blurBindGroup',
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: uniformBuffer } },
      ],
    });
    const pass = encoder.beginRenderPass({
      label: 'clue.navigator.blur',
      colorAttachments: [
        { view: targetView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(this.blurPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  #writeGlobals(camera, timeSeconds, semanticDepth) {
    const values = new Float32Array(GLOBAL_FLOATS);
    values.set(camera.viewProjection, 0);
    values.set(camera.inverseViewProjection, 16);
    values.set([...camera.position, 1], 32);
    values.set([...camera.right, 0], 36);
    values.set([...camera.up, 0], 40);
    // viewport.xy carries the PRESENTATION resolution (CSS × DPR), not the supersampled
    // internal size. Its only active .xy consumer is the edge shader's pixel-thickness NDC
    // conversion — presentation units keep edge width constant on screen at any antialias
    // scale instead of thinning as supersampling rises. (.z = time, .w = semantic depth, as
    // before. If the background grid draw is ever restored, its density keys off this too and
    // presentation units are the correct semantics for it as well.)
    values.set([this.presentWidth, this.presentHeight, timeSeconds, semanticDepth], 44);
    this.device.queue.writeBuffer(this.globalBuffer, 0, values);
  }

  #writeNodes(nodes) {
    if (nodes.length === 0) return;
    const values = new Float32Array(nodes.length * NODE_FLOATS);
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const offset = index * NODE_FLOATS;
      values.set([node.position[0], node.position[1], node.position[2], node.radius], offset);
      values.set([node.color[0], node.color[1], node.color[2], node.opacity], offset + 4);
      values.set([node.shape, node.pulse, node.selected ? 1 : 0, node.phaseCode], offset + 8);
      values.set([node.seed, node.discovery, node.optimized ? 1 : 0, node.level], offset + 12);
    }
    this.device.queue.writeBuffer(this.nodeBuffer, 0, values);
  }

  #writeEdges(edges) {
    if (edges.length === 0) return;
    const values = new Float32Array(edges.length * EDGE_FLOATS);
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      const offset = index * EDGE_FLOATS;
      values.set([edge.fromIndex, edge.toIndex, edge.weight, edge.highlight], offset);
      values.set([edge.color[0], edge.color[1], edge.color[2], edge.opacity], offset + 4);
    }
    this.device.queue.writeBuffer(this.edgeBuffer, 0, values);
  }
}