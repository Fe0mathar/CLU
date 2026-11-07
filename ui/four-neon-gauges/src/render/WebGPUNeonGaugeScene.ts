import type { FourNeonGaugesProjection } from '../protocol.js';

interface GpuRoot {
  requestAdapter(): Promise<GpuAdapter | null>;
  getPreferredCanvasFormat(): string;
}

interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}

interface GpuQueue {
  writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView): void;
  submit(commandBuffers: readonly unknown[]): void;
}

interface GpuBuffer {}
interface GpuBindGroup {}
interface GpuShaderModule {}
interface GpuTextureView {}

interface GpuRenderPipeline {
  getBindGroupLayout(index: number): unknown;
}

interface GpuRenderPass {
  setPipeline(pipeline: GpuRenderPipeline): void;
  setBindGroup(index: number, bindGroup: GpuBindGroup): void;
  draw(vertexCount: number): void;
  end(): void;
}

interface GpuCommandEncoder {
  beginRenderPass(descriptor: unknown): GpuRenderPass;
  finish(): unknown;
}

interface GpuDevice {
  readonly queue: GpuQueue;
  readonly lost: Promise<{ readonly message: string }>;
  createShaderModule(descriptor: { readonly code: string }): GpuShaderModule;
  createRenderPipeline(descriptor: unknown): GpuRenderPipeline;
  createBuffer(descriptor: { readonly size: number; readonly usage: number }): GpuBuffer;
  createBindGroup(descriptor: unknown): GpuBindGroup;
  createCommandEncoder(): GpuCommandEncoder;
}

interface GpuTexture {
  createView(): GpuTextureView;
}

interface GpuCanvasContext {
  configure(descriptor: unknown): void;
  getCurrentTexture(): GpuTexture;
}

const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function hexToRgb(hex: string): readonly [number, number, number] {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '00a3e0';
  return [
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255,
  ];
}

function warningFlag(gauge: FourNeonGaugesProjection['gauges'][number]): number {
  if (gauge.gateState === 'FAIL') return 1;
  if (gauge.gateState === 'WARNING' || gauge.warning !== null) return 0.82;
  if (gauge.availability === 'stale') return 0.58;
  if (gauge.availability === 'unknown' || gauge.availability === 'not_applicable') return 0.34;
  return 0;
}

function deltaSignal(gauge: FourNeonGaugesProjection['gauges'][number]): number {
  if (gauge.delta === null || gauge.trend === 'unknown') return 0;
  const direction = gauge.trend === 'worsening' ? -1 : gauge.trend === 'improving' ? 1 : 0;
  return direction * Math.min(1, Math.abs(gauge.delta) / 10);
}

export class WebGPUNeonGaugeScene {
  private canvas: HTMLCanvasElement | null = null;
  private context: GpuCanvasContext | null = null;
  private device: GpuDevice | null = null;
  private pipeline: GpuRenderPipeline | null = null;
  private uniformBuffer: GpuBuffer | null = null;
  private bindGroup: GpuBindGroup | null = null;
  private projection: FourNeonGaugesProjection | null = null;
  private frameHandle: number | null = null;
  private startedAt = performance.now();
  private resizeObserver: ResizeObserver | null = null;
  private deviceLostListener: ((message: string) => void) | null = null;

  public onDeviceLost(listener: (message: string) => void): void {
    this.deviceLostListener = listener;
  }

  public async attach(canvas: HTMLCanvasElement): Promise<boolean> {
    this.canvas = canvas;
    const gpu = (navigator as Navigator & { readonly gpu?: GpuRoot }).gpu;
    if (gpu === undefined) return false;

    const adapter = await gpu.requestAdapter();
    if (adapter === null) return false;
    const device = await adapter.requestDevice();
    const contextValue = (canvas as unknown as { getContext(id: string): unknown }).getContext('webgpu');
    if (contextValue === null || typeof contextValue !== 'object') return false;
    const context = contextValue as GpuCanvasContext;

    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });

    const shaderUrl = new URL('../../shaders/fourNeonGauges.wgsl', import.meta.url);
    const shaderResponse = await fetch(shaderUrl);
    if (!shaderResponse.ok) {
      throw new Error(`Could not load gauge shader: ${shaderResponse.status}`);
    }
    const shader = device.createShaderModule({ code: await shaderResponse.text() });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const uniformBuffer = device.createBuffer({
      size: 192,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    this.context = context;
    this.device = device;
    this.pipeline = pipeline;
    this.uniformBuffer = uniformBuffer;
    this.bindGroup = bindGroup;
    this.startedAt = performance.now();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    void device.lost.then((loss) => {
      this.stop();
      this.deviceLostListener?.(loss.message);
    });

    this.start();
    return true;
  }

  public setProjection(projection: FourNeonGaugesProjection): void {
    this.projection = projection;
  }

  public stop(): void {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private resize(): void {
    const canvas = this.canvas;
    if (canvas === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  private start(): void {
    if (this.frameHandle !== null) return;
    const frame = (): void => {
      this.render();
      this.frameHandle = requestAnimationFrame(frame);
    };
    this.frameHandle = requestAnimationFrame(frame);
  }

  private packUniforms(): Float32Array {
    const data = new Float32Array(48);
    const canvas = this.canvas;
    const projection = this.projection;
    data[0] = canvas?.width ?? 1;
    data[1] = canvas?.height ?? 1;
    data[2] = (performance.now() - this.startedAt) / 1000;
    data[3] = window.devicePixelRatio || 1;

    for (let index = 0; index < 4; index += 1) {
      const gauge = projection?.gauges[index];
      const dial = gauge?.dialPosition ?? 0;
      data[4 + index] = clamp01(dial);
      data[8 + index] = gauge === undefined ? 0 : deltaSignal(gauge);
      data[12 + index] = gauge?.confidence ?? 0;
      data[16 + index] = gauge?.coverage ?? 0;
      data[20 + index] = gauge?.freshness ?? 0;

      const [red, green, blue] = hexToRgb(gauge?.familyColor ?? '#00a3e0');
      const colorOffset = 24 + index * 4;
      data[colorOffset] = red;
      data[colorOffset + 1] = green;
      data[colorOffset + 2] = blue;
      data[colorOffset + 3] = 1;
      data[40 + index] = gauge === undefined ? 0.34 : warningFlag(gauge);
    }
    return data;
  }

  private render(): void {
    const device = this.device;
    const context = this.context;
    const pipeline = this.pipeline;
    const uniformBuffer = this.uniformBuffer;
    const bindGroup = this.bindGroup;
    if (device === null || context === null || pipeline === null || uniformBuffer === null || bindGroup === null) {
      return;
    }

    device.queue.writeBuffer(uniformBuffer, 0, this.packUniforms());
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.001, g: 0.006, b: 0.012, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
