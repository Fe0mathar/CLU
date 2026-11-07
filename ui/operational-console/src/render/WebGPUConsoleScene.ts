import type { Channel, ConsoleEvent } from '../protocol.js';

const CHANNEL_INDEX: Readonly<Record<Channel, number>> = {
  CLUE_CORE: 0,
  RECOGNITION: 1,
  GPT: 2,
  BENCHMARK: 3,
  POWERSHELL: 4,
  CHROME_CDP: 5,
  PROOF: 6,
  CUSTODIAN: 7,
  GREAT_BOOK: 8,
  STATUS: 9,
};

interface GPUState {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  readonly uniformBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly backdrop: GPURenderPipeline;
  readonly signals: GPURenderPipeline;
}

async function shader(path: string): Promise<string> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`WGSL fetch failed: ${path}`);
  return response.text();
}

export class WebGPUConsoleScene extends EventTarget {
  private gpu: GPUState | null = null;
  private frame = 0;
  private running = false;
  private startedAt = performance.now();
  private activity = 0;
  private warning = 0;
  private proof = 0;
  private channel = 0;
  private resizeObserver: ResizeObserver | null = null;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    super();
  }

  public async initialize(shaderBase = '/shaders'): Promise<boolean> {
    if (navigator.gpu === undefined) {
      this.dispatchEvent(new CustomEvent('webgpu-unavailable'));
      return false;
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter === null) {
      this.dispatchEvent(new CustomEvent('webgpu-unavailable'));
      return false;
    }
    const device = await adapter.requestDevice();
    const context = this.canvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
    if (context === null) throw new Error('WebGPU canvas context unavailable.');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const backdropCode = await shader(`${shaderBase}/consoleBackdrop.wgsl`);
    const signalCode = await shader(`${shaderBase}/consoleSignals.wgsl`);
    const backdropModule = device.createShaderModule({ code: backdropCode, label: 'console backdrop' });
    const signalModule = device.createShaderModule({ code: signalCode, label: 'console signals' });
    const compilation = await Promise.all([
      backdropModule.getCompilationInfo(),
      signalModule.getCompilationInfo(),
    ]);
    const errors = compilation.flatMap((info) =>
      info.messages.filter((message) => message.type === 'error'),
    );
    if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('\n'));

    const uniformBuffer = device.createBuffer({
      label: 'console globals',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    const bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const backdrop = device.createRenderPipeline({
      label: 'console backdrop pipeline',
      layout: pipelineLayout,
      vertex: { module: backdropModule, entryPoint: 'vsMain' },
      fragment: { module: backdropModule, entryPoint: 'fsMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const signals = device.createRenderPipeline({
      label: 'console signal pipeline',
      layout: pipelineLayout,
      vertex: { module: signalModule, entryPoint: 'vsMain' },
      fragment: {
        module: signalModule,
        entryPoint: 'fsMain',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.gpu = { device, context, format, uniformBuffer, bindGroup, backdrop, signals };
    device.lost.then((info: GPUDeviceLostInfo) => {
      this.stop();
      this.gpu = null;
      this.dispatchEvent(new CustomEvent('device-lost', { detail: info }));
    });
    this.resizeObserver = new ResizeObserver(() => this.configure());
    this.resizeObserver.observe(this.canvas);
    this.configure();
    this.start();
    return true;
  }

  public notify(event: ConsoleEvent): void {
    this.activity = Math.min(1, this.activity + 0.45);
    this.channel = CHANNEL_INDEX[event.channel];
    if (
      event.kind === 'warning' ||
      event.kind === 'error' ||
      event.validationState === 'evidence_rejected'
    ) {
      this.warning = Math.min(1, this.warning + 0.8);
    }
    if (
      event.validationState === 'evidence_admissible' ||
      event.cinematicCue === 'proof_accept'
    ) {
      this.proof = Math.min(1, this.proof + 0.75);
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = performance.now();
    this.frame = requestAnimationFrame((time) => this.render(time));
  }

  public stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  public destroy(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.gpu?.uniformBuffer.destroy();
    this.gpu = null;
  }

  private configure(): void {
    const gpu = this.gpu;
    if (gpu === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
  }

  private render(now: number): void {
    if (!this.running) return;
    const gpu = this.gpu;
    if (gpu !== null) {
      this.activity *= 0.965;
      this.warning *= 0.94;
      this.proof *= 0.95;
      const values = new Float32Array([
        (now - this.startedAt) / 1000,
        this.activity,
        this.warning,
        this.proof,
        this.channel,
        this.canvas.width,
        this.canvas.height,
        window.devicePixelRatio || 1,
      ]);
      gpu.device.queue.writeBuffer(gpu.uniformBuffer, 0, values);
      const encoder = gpu.device.createCommandEncoder({ label: 'operational console frame' });
      const view = gpu.context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setBindGroup(0, gpu.bindGroup);
      pass.setPipeline(gpu.backdrop);
      pass.draw(3);
      pass.setPipeline(gpu.signals);
      pass.draw(3);
      pass.end();
      gpu.device.queue.submit([encoder.finish()]);
    }
    this.frame = requestAnimationFrame((time) => this.render(time));
  }
}
