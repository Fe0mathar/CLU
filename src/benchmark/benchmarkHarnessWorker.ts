/** Private subprocess for benchmark JavaScript. No host object is installed in the guest realm. */
import { randomUUID } from 'node:crypto';
import { createContext, Script, type Context } from 'node:vm';

const EVALUATION_MS = 500;
const MAX_WIRE_BYTES = 2 * 1024 * 1024;
const binding = `broker_${randomUUID().replace(/-/gu, '')}`;
const harness = `harness_${randomUUID().replace(/-/gu, '')}`;

let realm: Context | null = null;
let waiting = false;
let finished = false;

function send(message: unknown): void {
  const wire = JSON.stringify(message);
  if (Buffer.byteLength(wire) > MAX_WIRE_BYTES) throw new Error('Benchmark worker message exceeded its size limit.');
  process.send?.(wire);
}

function fail(stage: 'syntax' | 'execute', reason: string): void {
  if (finished) return;
  finished = true;
  send({ kind: 'failed', stage, reason: reason.slice(0, 500) });
}

function evaluate(source: string): unknown {
  if (realm === null) throw new Error('Benchmark worker realm is absent.');
  return new Script(source, { filename: 'benchmark-guest.js' }).runInContext(realm, { timeout: EVALUATION_MS });
}

function initialize(body: string, data: string): void {
  realm = createContext(Object.create(null), {
    name: 'CLU-E benchmark harness',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  // All functions, promises, errors and objects below are constructed inside the guest realm.
  // Only JSON text crosses between realms. Lexical controller names are not global properties.
  evaluate(`
    const ${binding} = (() => {
      const parse = JSON.parse;
      const stringify = JSON.stringify;
      const StringValue = String;
      const PromiseValue = Promise;
      const push = Function.prototype.call.bind(Array.prototype.push);
      const freeze = Object.freeze;
      const failGuest = Error;
      Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });
      Object.defineProperty(globalThis, 'Error', { value: failGuest, writable: false, configurable: false });
      for (const name of [
        'Date', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly',
        'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
        'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array',
        'BigInt64Array', 'BigUint64Array',
      ]) Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
      let messages = [];
      let pending = null;
      let requestCount = 0;
      let logCount = 0;
      const context = freeze({
        ...parse(${JSON.stringify(data)}),
        exec: (argv, options) => new PromiseValue((resolve, reject) => {
          if (pending !== null) {
            throw new failGuest('Concurrent benchmark commands are not allowed.');
          }
          if (++requestCount > 10000) {
            throw new failGuest('Benchmark command limit reached.');
          }
          pending = { resolve, reject };
          push(messages, { kind: 'exec', argv, options: options ?? null });
        }),
        log: (value) => {
          if (++logCount <= 100) push(messages, { kind: 'log', line: StringValue(value).slice(0, 2000) });
        },
      });
      return freeze({
        start: async (program) => {
          try {
            const result = await program(context);
            push(messages, { kind: 'result', value: result ?? null });
          } catch (error) {
            push(messages, { kind: 'failed', stage: 'execute', reason: StringValue(error).slice(0, 500) });
          }
        },
        reply: (payload) => {
          if (pending === null) throw new failGuest('No benchmark command is pending.');
          const { resolve, reject } = pending;
          pending = null;
          const reply = parse(payload);
          if (reply.error === undefined) resolve(reply.result);
          else reject(new failGuest(reply.error));
        },
        drain: () => {
          const wire = stringify(messages);
          messages = [];
          return wire;
        },
      });
    })();
  `);
  try {
    evaluate(`const ${harness} = async (context) => {\n${body}\n};`);
  } catch (error) {
    fail(error instanceof SyntaxError || (error as { name?: string }).name === 'SyntaxError' ? 'syntax' : 'execute', String(error));
    return;
  }
  evaluate(`void ${binding}.start(${harness});`);
}

function drain(): void {
  if (finished) return;
  const wire = evaluate(`${binding}.drain()`);
  if (typeof wire !== 'string' || Buffer.byteLength(wire) > MAX_WIRE_BYTES) {
    throw new Error('Benchmark guest exceeded the message size limit.');
  }
  const messages = JSON.parse(wire) as Array<{ kind: string; stage?: 'syntax' | 'execute'; reason?: string }>;
  for (const message of messages) {
    if (message.kind === 'exec') {
      if (waiting) throw new Error('Concurrent benchmark commands are not allowed.');
      waiting = true;
    }
    if (message.kind === 'failed') {
      fail(message.stage ?? 'execute', message.reason ?? 'Benchmark harness failed.');
      return;
    }
    if (message.kind === 'result') {
      if (waiting) throw new Error('Benchmark harness returned while a command was pending.');
      finished = true;
    }
    send(message);
  }
  if (!finished && !waiting) fail('execute', 'Benchmark harness stopped without a result or a pending command.');
}

process.on('message', (wire: unknown) => {
  if (finished) return;
  try {
    if (typeof wire !== 'string' || Buffer.byteLength(wire) > MAX_WIRE_BYTES) throw new Error('Invalid benchmark parent message.');
    const message = JSON.parse(wire) as { kind?: string; body?: string; data?: string; payload?: string };
    if (message.kind === 'start' && realm === null && typeof message.body === 'string' && typeof message.data === 'string') {
      initialize(message.body, message.data);
    } else if (message.kind === 'reply' && waiting && typeof message.payload === 'string') {
      waiting = false;
      evaluate(`${binding}.reply(${JSON.stringify(message.payload)});`);
    } else {
      throw new Error('Unexpected benchmark parent message.');
    }
    drain();
  } catch (error) {
    fail('execute', String(error));
  }
});
