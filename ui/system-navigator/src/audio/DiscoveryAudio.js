/**
 * Restrained procedural audio for cinematic discovery.
 *
 * This is intentionally a replaceable placeholder. The permanent CLUE sonic identity
 * should be selected by the Creator after hearing it in the target room and speakers.
 */
export class DiscoveryAudio {
  constructor(options = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      masterGain: options.masterGain ?? 0.075,
      ...options,
    };
    this.context = null;
    this.master = null;
    this.customPlayer = null;
    this.enabledByGesture = false;
  }

  async enable() {
    if (!this.options.enabled) return false;
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) return false;
    if (!this.context) {
      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.gain.value = this.options.masterGain;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    this.enabledByGesture = this.context.state === 'running';
    return this.enabledByGesture;
  }

  setCustomPlayer(player) {
    this.customPlayer = typeof player === 'function' ? player : null;
  }

  playDiscovery(node) {
    if (this.customPlayer) {
      try {
        this.customPlayer({ type: 'discovery', node });
      } catch {
        // Audio must never disturb the recognition process.
      }
      return;
    }
    if (!this.#ready()) return;
    const now = this.context.currentTime;
    const base = 240 + Math.min(360, (node?.level ?? 6) * 42);
    this.#tone(now, base, base * 1.58, 0.34, 'sine', 0.62);
    this.#tone(now + 0.055, base * 2.01, base * 2.42, 0.21, 'triangle', 0.25);
  }

  playPhase(phase) {
    if (!this.#ready()) return;
    const now = this.context.currentTime;
    if (phase === 'patching') {
      this.#tone(now, 330, 495, 0.22, 'sine', 0.30);
    } else if (phase === 'verified') {
      this.#tone(now, 420, 630, 0.25, 'sine', 0.32);
      this.#tone(now + 0.08, 630, 840, 0.22, 'triangle', 0.18);
    } else if (phase === 'blocked') {
      this.#tone(now, 180, 96, 0.28, 'sawtooth', 0.22);
    }
  }

  destroy() {
    try {
      this.context?.close();
    } catch {
      // Best-effort teardown.
    }
    this.context = null;
    this.master = null;
  }

  #ready() {
    return Boolean(
      this.options.enabled
      && this.enabledByGesture
      && this.context
      && this.context.state === 'running'
      && this.master,
    );
  }

  #tone(start, startFrequency, endFrequency, duration, type, strength) {
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, strength), start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
  }
}
