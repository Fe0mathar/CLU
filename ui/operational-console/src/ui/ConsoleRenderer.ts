import { CHANNELS, type Channel, type ConsoleEvent, type CurrentWorkContract } from '../protocol.js';
import { OperationalConsoleState } from '../OperationalConsoleState.js';

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour12: false });
}

function channelLabel(channel: Channel): string {
  return channel.replace('_', ' / ');
}

interface ExchangeGroup {
  readonly id: string;
  readonly events: ConsoleEvent[];
}

function groupEvents(events: readonly ConsoleEvent[]): readonly ExchangeGroup[] {
  const groups: ExchangeGroup[] = [];
  const byId = new Map<string, ExchangeGroup>();
  for (const event of events) {
    const id = event.exchangeId ?? event.eventId;
    const existing = byId.get(id);
    if (existing !== undefined) {
      existing.events.push(event);
      continue;
    }
    const group: ExchangeGroup = { id, events: [event] };
    byId.set(id, group);
    groups.push(group);
  }
  return groups;
}

export class ConsoleRenderer {
  private readonly scroll: HTMLDivElement;
  private readonly contract: HTMLDivElement;
  private readonly channelStrip: HTMLDivElement;
  private readonly liveDot: HTMLSpanElement;
  private readonly liveText: HTMLSpanElement;
  private readonly footerReadout: HTMLSpanElement;
  private readonly drawer: HTMLDivElement;
  private readonly drawerTitle: HTMLDivElement;
  private readonly drawerBody: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly channelButtons = new Map<Channel, HTMLButtonElement>();
  private connected = false;
  private artifactLoader: ((hash: string) => Promise<string>) | null = null;

  public constructor(
    private readonly root: ShadowRoot,
    private readonly state: OperationalConsoleState,
  ) {
    const shell = this.root.querySelector<HTMLDivElement>('.shell');
    if (shell === null) throw new Error('Operational Console shell is missing.');
    this.scroll = shell.querySelector<HTMLDivElement>('.event-scroll') as HTMLDivElement;
    this.contract = shell.querySelector<HTMLDivElement>('.work-contract') as HTMLDivElement;
    this.channelStrip = shell.querySelector<HTMLDivElement>('.channel-strip') as HTMLDivElement;
    this.liveDot = shell.querySelector<HTMLSpanElement>('.live-dot') as HTMLSpanElement;
    this.liveText = shell.querySelector<HTMLSpanElement>('[data-role="live-text"]') as HTMLSpanElement;
    this.footerReadout = shell.querySelector<HTMLSpanElement>('.footer-readout') as HTMLSpanElement;
    this.drawer = shell.querySelector<HTMLDivElement>('.detail-drawer') as HTMLDivElement;
    this.drawerTitle = shell.querySelector<HTMLDivElement>('.detail-title') as HTMLDivElement;
    this.drawerBody = shell.querySelector<HTMLDivElement>('.detail-body') as HTMLDivElement;
    this.empty = shell.querySelector<HTMLDivElement>('.empty-state') as HTMLDivElement;
    this.buildChannels();
    this.state.addEventListener('state-changed', () => this.render());
    this.bindControls(shell);
  }

  public setArtifactLoader(loader: (hash: string) => Promise<string>): void {
    this.artifactLoader = loader;
  }

  public setConnected(connected: boolean): void {
    this.connected = connected;
    this.liveDot.dataset['state'] = connected ? 'connected' : 'disconnected';
    this.liveText.textContent = connected ? 'LIVE EVENT STREAM' : 'STREAM DISCONNECTED';
  }

  public render(): void {
    const projection = this.state.projection;
    this.renderContract(projection?.currentWorkContract ?? null);
    const active = new Set(projection?.activeChannels ?? []);
    for (const [channel, button] of this.channelButtons) {
      button.dataset['active'] = String(active.has(channel));
    }

    const groups = groupEvents(this.state.visibleEvents);
    this.scroll.textContent = '';
    this.empty.hidden = groups.length > 0;
    for (const group of groups) this.scroll.append(this.renderGroup(group));
    const first = projection?.firstSequence ?? null;
    const last = projection?.lastSequence ?? null;
    this.footerReadout.textContent =
      `SEQ ${first ?? '—'}…${last ?? '—'} · COLLAPSED ${projection?.collapsedEvents ?? 0} · ` +
      `DROPPED ${projection?.droppedEvents ?? 0} · ${this.connected ? 'LIVE' : 'OFFLINE'}`;
    if (this.state.autoScroll) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  private buildChannels(): void {
    for (const channel of CHANNELS) {
      const button = element('button', 'channel-chip');
      button.type = 'button';
      button.dataset['enabled'] = 'true';
      button.dataset['active'] = 'false';
      button.textContent = channelLabel(channel);
      button.addEventListener('click', () => {
        const enabled = button.dataset['enabled'] !== 'true';
        button.dataset['enabled'] = String(enabled);
        this.state.setChannel(channel, enabled);
      });
      this.channelButtons.set(channel, button);
      this.channelStrip.append(button);
    }
  }

  private bindControls(shell: HTMLDivElement): void {
    shell.querySelector<HTMLButtonElement>('[data-action="autoscroll"]')?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const enabled = !this.state.autoScroll;
      this.state.setAutoScroll(enabled);
      button.textContent = enabled ? 'PAUSE AUTO-SCROLL' : 'RESUME AUTO-SCROLL';
    });
    shell.querySelector<HTMLButtonElement>('[data-action="pause"]')?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const paused = !this.state.isPaused;
      this.state.setPaused(paused);
      button.textContent = paused ? 'RESUME STREAM' : 'PAUSE STREAM';
    });
    shell.querySelector<HTMLButtonElement>('[data-action="status"]')?.addEventListener('click', () => {
      this.root.host.dispatchEvent(
        new CustomEvent('clue-status-request', { bubbles: true, composed: true }),
      );
    });
    shell.querySelector<HTMLButtonElement>('[data-action="close-detail"]')?.addEventListener('click', () => {
      this.drawer.dataset['open'] = 'false';
    });
  }

  private renderContract(contract: CurrentWorkContract | null): void {
    const values: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: string }> =
      contract === null
        ? [
            { key: 'what', label: 'WHAT', value: 'Awaiting a durable CLU-E operation.' },
            { key: 'why', label: 'WHY', value: 'No active work contract is available.' },
            { key: 'proof', label: 'HOW PROVEN', value: 'Not yet defined.' },
            { key: 'who', label: 'WHO / MODEL', value: 'No logical session active.' },
            { key: 'status', label: 'CURRENT STATUS', value: 'IDLE' },
            { key: 'next', label: 'NEXT', value: 'Wait for the next committed event.' },
          ]
        : [
            { key: 'what', label: 'WHAT', value: `${contract.targetLabel} · ${contract.what}` },
            { key: 'why', label: 'WHY', value: contract.why },
            { key: 'proof', label: 'HOW PROVEN', value: contract.howProven },
            { key: 'who', label: 'WHO / MODEL', value: contract.whoOrModel },
            { key: 'status', label: 'CURRENT STATUS', value: contract.currentStatus },
            { key: 'next', label: 'NEXT', value: contract.next },
          ];
    this.contract.textContent = '';
    for (const item of values) {
      const cell = element('div', 'contract-cell');
      cell.dataset['key'] = item.key;
      const label = element('div', 'label');
      label.textContent = item.label;
      const value = element('div', 'value');
      value.textContent = item.value;
      cell.append(label, value);
      this.contract.append(cell);
    }
  }

  private renderGroup(group: ExchangeGroup): HTMLElement {
    const primary = group.events[0];
    if (primary === undefined) return element('div');
    const wrapper = element('article', 'exchange');
    const severity = group.events.some((event) => event.kind === 'error')
      ? 'error'
      : group.events.some((event) => event.kind === 'warning')
        ? 'warning'
        : 'normal';
    wrapper.dataset['severity'] = severity;
    wrapper.dataset['proof'] = String(
      group.events.some((event) => event.validationState === 'evidence_admissible'),
    );

    const header = element('header', 'exchange-header');
    const channel = element('span', 'channel-tag');
    channel.textContent = channelLabel(primary.channel);
    const direction = element('span', 'direction-tag');
    direction.dataset['direction'] = primary.direction;
    direction.textContent = primary.direction;
    const title = element('div', 'exchange-title');
    title.textContent = primary.title;
    const meta = element('div', 'event-meta');
    meta.textContent = `#${primary.sequence} · ${shortTime(primary.occurredAt)}${
      primary.durationMs === null ? '' : ` · ${primary.durationMs.toFixed(0)} ms`
    }`;
    header.append(channel, direction, title, meta);
    wrapper.append(header);

    for (const event of group.events) wrapper.append(this.renderLayer(event));
    return wrapper;
  }

  private renderLayer(event: ConsoleEvent): HTMLElement {
    const layer = element('section', 'event-layer');
    const label = element('div', 'layer-label');
    label.textContent =
      event.direction === 'OUTBOUND'
        ? 'EXACT SEND'
        : event.direction === 'INBOUND'
          ? 'EXACT RECEIVE'
          : event.kind === 'summary'
            ? 'CLU-E SUMMARY'
            : 'STATE';
    const body = element('div', 'layer-body');
    const summary = element('div', 'layer-summary');
    summary.textContent = `${event.status} · ${event.what} · ${event.why}${
      event.nextAction === null ? '' : ` · Next: ${event.nextAction}`
    }`;
    body.append(summary);

    if (event.payload !== null) {
      const frame = element('div', 'code-frame');
      frame.dataset['format'] = event.payload.format.toUpperCase();
      const pre = element('pre');
      pre.textContent = event.payload.preview;
      frame.append(pre);
      body.append(frame);
      if (!event.payload.complete) {
        const button = element('button', 'artifact-button');
        button.type = 'button';
        button.textContent = `OPEN FULL REDACTED PAYLOAD · ${event.payload.byteLength} BYTES`;
        button.addEventListener('click', () => void this.openArtifact(event));
        body.append(button);
      }
    }

    const validation = element('span', 'validation-tag');
    validation.dataset['state'] = event.validationState;
    validation.textContent = event.validationState.replaceAll('_', ' ').toUpperCase();
    body.append(validation);
    layer.append(label, body);
    return layer;
  }

  private async openArtifact(event: ConsoleEvent): Promise<void> {
    const payload = event.payload;
    if (payload === null || this.artifactLoader === null) return;
    this.drawer.dataset['open'] = 'true';
    this.drawerTitle.textContent = `${event.channel} · ${event.title} · ${payload.artifactHash.slice(0, 12)}…`;
    this.drawerBody.textContent = 'LOADING REDACTED ARTIFACT…';
    try {
      const text = await this.artifactLoader(payload.artifactHash);
      this.drawerBody.textContent = '';
      const frame = element('div', 'code-frame');
      frame.dataset['format'] = payload.format.toUpperCase();
      const pre = element('pre');
      pre.textContent = text;
      frame.append(pre);
      this.drawerBody.append(frame);
    } catch (error) {
      this.drawerBody.textContent = `ARTIFACT UNAVAILABLE · ${String(error)}`;
    }
  }
}
