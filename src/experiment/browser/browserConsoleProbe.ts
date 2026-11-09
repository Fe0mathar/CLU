import { randomUUID } from 'node:crypto';
import type { BrowserAgent } from './browserAgent.js';

/** Requires a command return and a separate Runtime.consoleAPICalled event for one nonce. */
export async function probeChromeConsole(
  agent: Pick<BrowserAgent, 'onConsole'>,
  evaluate: (source: string) => Promise<unknown>,
  timeoutMs = 2_500,
): Promise<{ executed: boolean; captured: boolean }> {
  const token = `CLU-E console verification ${randomUUID()}`;
  let markCaptured: () => void = () => {};
  const captured = new Promise<boolean>((done) => { markCaptured = () => done(true); });
  const unsubscribe = agent.onConsole((entry) => {
    if (entry.level === 'info' && entry.text === token) markCaptured();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = JSON.stringify(token);
    const executed = await evaluate(`(console.info(${value}), ${value})`) === token;
    if (!executed) return { executed, captured: false };
    return {
      executed,
      captured: await Promise.race([captured, new Promise<boolean>((done) => { timer = setTimeout(() => done(false), timeoutMs); })]),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
  }
}
