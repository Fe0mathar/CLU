import { CHANNELS, type Channel, type ConsoleEvent, type ConsoleProjection } from './protocol.js';

export class OperationalConsoleState extends EventTarget {
  private eventList: ConsoleEvent[] = [];
  private currentProjection: ConsoleProjection | null = null;
  private channelFilter = new Set<Channel>(CHANNELS);
  private autoScrollEnabled = true;
  private paused = false;

  public get projection(): ConsoleProjection | null {
    return this.currentProjection;
  }

  public get visibleEvents(): readonly ConsoleEvent[] {
    return this.eventList.filter((event) => this.channelFilter.has(event.channel));
  }

  public get autoScroll(): boolean {
    return this.autoScrollEnabled;
  }

  public get isPaused(): boolean {
    return this.paused;
  }

  public replace(projection: ConsoleProjection): void {
    this.currentProjection = projection;
    this.eventList = [...projection.events].sort((a, b) => a.sequence - b.sequence);
    this.emit();
  }

  public append(event: ConsoleEvent): void {
    const existing = this.eventList.findIndex((item) => item.sequence === event.sequence);
    if (existing >= 0) this.eventList[existing] = event;
    else this.eventList.push(event);
    this.eventList.sort((a, b) => a.sequence - b.sequence);
    if (this.eventList.length > 500) this.eventList.splice(0, this.eventList.length - 500);
    if (!this.paused) this.emit();
  }

  public setChannel(channel: Channel, enabled: boolean): void {
    if (enabled) this.channelFilter.add(channel);
    else this.channelFilter.delete(channel);
    this.emit();
  }

  public setAutoScroll(enabled: boolean): void {
    this.autoScrollEnabled = enabled;
    this.emit();
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
    this.emit();
  }

  private emit(): void {
    this.dispatchEvent(new CustomEvent('state-changed'));
  }
}
