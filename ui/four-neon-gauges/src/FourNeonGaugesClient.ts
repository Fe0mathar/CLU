import {
  parseFourNeonGaugesProjection,
  type FourNeonGaugesProjection,
} from './protocol.js';

export class FourNeonGaugesClient extends EventTarget {
  private source: EventSource | null = null;

  public async load(url: string): Promise<FourNeonGaugesProjection> {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Gauge request failed: ${response.status}`);
    return parseFourNeonGaugesProjection(await response.json());
  }

  public connect(url: string): void {
    this.disconnect();
    const source = new EventSource(url);
    source.addEventListener('message', (event) => {
      try {
        const projection = parseFourNeonGaugesProjection(JSON.parse((event as MessageEvent<string>).data));
        this.dispatchEvent(new CustomEvent('projection', { detail: projection }));
      } catch (error) {
        this.dispatchEvent(new CustomEvent('protocol-error', { detail: String(error) }));
      }
    });
    source.addEventListener('error', () => {
      this.dispatchEvent(new CustomEvent('connection-error'));
    });
    this.source = source;
  }

  public disconnect(): void {
    this.source?.close();
    this.source = null;
  }
}
