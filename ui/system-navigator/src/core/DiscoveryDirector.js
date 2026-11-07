/**
 * Serializes cinematic node acquisition without blocking recognition.
 *
 * Every recognized node appears immediately in the graph. The director controls only
 * the camera ceremony. Under extreme recognition throughput it compacts the camera
 * queue while retaining every graph node, preventing a 30,000-function project from
 * spending hours replaying obsolete fly-ins after the scan has completed.
 */
export class DiscoveryDirector extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = {
      enabled: options.enabled ?? true,
      acquisitionMs: options.acquisitionMs ?? 1480,
      settleMs: options.settleMs ?? 240,
      maximumBacklog: options.maximumBacklog ?? 240,
      ...options,
    };
    this.queue = [];
    this.active = null;
    this.activeStartedAt = 0;
    this.collapsed = 0;
  }

  enqueue(node) {
    if (!this.options.enabled || !node) return false;
    if (this.active?.id === node.id || this.queue.some((entry) => entry.id === node.id)) return false;

    if (this.queue.length >= this.options.maximumBacklog) {
      // Keep representative continuity and always retain the newest discovery.
      const replaceIndex = Math.max(0, this.queue.length - 1);
      this.queue[replaceIndex] = node;
      this.collapsed += 1;
    } else {
      this.queue.push(node);
    }
    return true;
  }

  update(now = performance.now()) {
    if (!this.options.enabled) return;
    if (!this.active) {
      const next = this.queue.shift();
      if (!next) return;
      this.active = next;
      this.activeStartedAt = now;
      this.dispatchEvent(new CustomEvent('start', { detail: { node: next, pending: this.queue.length } }));
      return;
    }

    const pressureFactor = this.queue.length > 96 ? 0.28 : this.queue.length > 32 ? 0.52 : 1;
    const duration = (this.options.acquisitionMs + this.options.settleMs) * pressureFactor;
    if (now - this.activeStartedAt < duration) return;

    const completed = this.active;
    this.active = null;
    this.dispatchEvent(new CustomEvent('complete', {
      detail: { node: completed, pending: this.queue.length, collapsed: this.collapsed },
    }));
  }

  clear() {
    this.queue.length = 0;
    this.active = null;
    this.activeStartedAt = 0;
    this.collapsed = 0;
  }

  snapshot() {
    return {
      enabled: this.options.enabled,
      active: this.active,
      pending: this.queue.length,
      collapsed: this.collapsed,
    };
  }
}
