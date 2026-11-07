import {
  parseConsoleEvent,
  parseConsoleProjection,
  type ConsoleEvent,
  type ConsoleProjection,
} from './protocol.js';

export interface OperationalConsoleClientOptions {
  readonly baseUrl?: string;
}

export class OperationalConsoleClient extends EventTarget {
  private readonly baseUrl: string;
  private source: EventSource | null = null;
  private lastSequence = -1;

  public constructor(options: OperationalConsoleClientOptions = {}) {
    super();
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  }

  public async snapshot(): Promise<ConsoleProjection> {
    const response = await fetch(`${this.baseUrl}/api/operational-console`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Console snapshot failed: HTTP ${response.status}`);
    return parseConsoleProjection(await response.json());
  }

  public connect(since = this.lastSequence): void {
    this.disconnect();
    const query = since >= 0 ? `?since=${since}` : '';
    this.source = new EventSource(`${this.baseUrl}/api/operational-console-events${query}`);
    this.source.onmessage = (message) => {
      try {
        const event = parseConsoleEvent(JSON.parse(message.data) as unknown);
        if (event.sequence <= this.lastSequence) return;
        this.lastSequence = event.sequence;
        this.dispatchEvent(new CustomEvent<ConsoleEvent>('console-event', { detail: event }));
      } catch (error) {
        this.dispatchEvent(new CustomEvent('console-error', { detail: error }));
      }
    };
    this.source.onerror = () => this.dispatchEvent(new CustomEvent('console-disconnected'));
  }

  public disconnect(): void {
    this.source?.close();
    this.source = null;
  }

  public async artifact(hash: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/operational-console-artifacts/${hash}`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Artifact fetch failed: HTTP ${response.status}`);
    return response.text();
  }
}
