/** Minimal WebGPU declarations used by the standalone Operational Console build. */

type GPUTextureFormat = string;

interface GPUDeviceLostInfo {
  readonly reason: string;
  readonly message: string;
}

interface GPUCompilationMessage {
  readonly type: 'error' | 'warning' | 'info';
  readonly message: string;
}

interface GPUCompilationInfo {
  readonly messages: readonly GPUCompilationMessage[];
}

interface GPUShaderModule {
  getCompilationInfo(): Promise<GPUCompilationInfo>;
}

interface GPUBuffer {
  destroy(): void;
}

interface GPUBindGroup {}
interface GPUBindGroupLayout {}
interface GPUPipelineLayout {}
interface GPURenderPipeline {}
interface GPUTextureView {}

interface GPUTexture {
  createView(): GPUTextureView;
}

interface GPURenderPassEncoder {
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  setPipeline(pipeline: GPURenderPipeline): void;
  draw(vertexCount: number): void;
  end(): void;
}

interface GPUCommandBuffer {}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: unknown): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}

interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: BufferSource): void;
  submit(commandBuffers: readonly GPUCommandBuffer[]): void;
}

interface GPUDevice {
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createShaderModule(descriptor: unknown): GPUShaderModule;
  createBuffer(descriptor: unknown): GPUBuffer;
  createBindGroupLayout(descriptor: unknown): GPUBindGroupLayout;
  createBindGroup(descriptor: unknown): GPUBindGroup;
  createPipelineLayout(descriptor: unknown): GPUPipelineLayout;
  createRenderPipeline(descriptor: unknown): GPURenderPipeline;
  createCommandEncoder(descriptor?: unknown): GPUCommandEncoder;
}

interface GPUAdapter {
  requestDevice(descriptor?: unknown): Promise<GPUDevice>;
}

interface GPU {
  requestAdapter(options?: unknown): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

interface GPUCanvasContext {
  configure(configuration: unknown): void;
  getCurrentTexture(): GPUTexture;
}

interface Navigator {
  readonly gpu?: GPU;
}

declare const GPUBufferUsage: {
  readonly UNIFORM: number;
  readonly COPY_DST: number;
};

declare const GPUShaderStage: {
  readonly FRAGMENT: number;
};
