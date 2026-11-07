/** Parent IPC broker. The subprocess can ask for commands but cannot launch them. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { z } from 'zod';

import type { ExecFn } from './benchmarkRunner.js';

const MAX_WIRE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_COMMANDS = 10000;
// The Windows process-tree cleanup has a five-second bound. Leave room for its
// final request-directory cleanup before releasing the enclosing broker scope.
const CANCEL_GRACE_MS = 6500;

const workerMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exec'),
    argv: z.array(z.string().min(1).max(16000).refine((value) => !value.includes('\0'))).min(1).max(24),
    options: z.object({ timeoutSeconds: z.number().finite().positive().optional() }).strict().nullable(),
  }).strict(),
  z.object({ kind: z.literal('log'), line: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('failed'), stage: z.enum(['syntax', 'execute']), reason: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('result'), value: z.unknown() }).strict(),
]);

export type HarnessProcessOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly stage: 'syntax' | 'execute'; readonly reason: string };

/** No native module loader, including via a dynamic import with a rejected host promise. */
function harnessSyntax(body: string): HarnessProcessOutcome | null {
  const source = ts.createSourceFile(
    'benchmark-guest.js',
    `async function benchmarkHarness(context) {\n${body}\n}`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  if (source.statements.length !== 1 || !ts.isFunctionDeclaration(source.statements[0]!)) {
    return { ok: false, stage: 'syntax', reason: 'Benchmark must contain one harness body.' };
  }
  let dynamicImport = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImport = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return dynamicImport
    ? { ok: false, stage: 'execute', reason: 'Dynamic module loading is not allowed in a benchmark harness.' }
    : null;
}

export async function executeBenchmarkHarness(input: {
  readonly body: string;
  readonly context: unknown;
  readonly exec: ExecFn;
  readonly log?: (line: string) => void;
  readonly deadlineMs: number;
}): Promise<HarnessProcessOutcome> {
  if (Buffer.byteLength(input.body) > MAX_BODY_BYTES) {
    return { ok: false, stage: 'execute', reason: 'Benchmark harness body exceeded the size limit.' };
  }
  const syntaxFailure = harnessSyntax(input.body);
  if (syntaxFailure !== null) return syntaxFailure;
  const flag = process.allowedNodeEnvironmentFlags.has('--permission')
    ? '--permission'
    : '--experimental-permission';
  if (!process.allowedNodeEnvironmentFlags.has(flag)) {
    return { ok: false, stage: 'execute', reason: 'This Node runtime cannot isolate the benchmark worker.' };
  }

  const path = fileURLToPath(new URL('./benchmarkHarnessWorker.js', import.meta.url));
  const start = JSON.stringify({ kind: 'start', body: input.body, data: JSON.stringify(input.context) });
  if (Buffer.byteLength(start) > MAX_WIRE_BYTES) {
    return { ok: false, stage: 'execute', reason: 'Benchmark harness input exceeded the message size limit.' };
  }

  return await new Promise<HarnessProcessOutcome>((resolve) => {
    const child = spawn(
      process.execPath,
      [flag, `--allow-fs-read=${path}`, '--max-old-space-size=64', path],
      { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
    );
    const abort = new AbortController();
    let done = false;
    let pending = false;
    let inFlight: Promise<void> | null = null;
    let commands = 0;
    let logs = 0;

    const finish = (result: HarnessProcessOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      abort.abort();
      child.kill();
      // The execution scope is disposed by the caller. Allow the command broker to
      // terminate its process tree before disposal, even after the worker itself fails.
      if (inFlight === null) {
        resolve(result);
      } else {
        const grace = setTimeout(() => resolve(result), CANCEL_GRACE_MS);
        void inFlight.then(() => {
          clearTimeout(grace);
          resolve(result);
        });
      }
    };
    const fail = (reason: string): void => finish({ ok: false, stage: 'execute', reason });
    const deadline = setTimeout(() => fail('Benchmark harness exceeded its wall-clock deadline.'), input.deadlineMs);

    const send = (wire: string): void => {
      if (done) return;
      if (Buffer.byteLength(wire) > MAX_WIRE_BYTES) {
        fail('Benchmark broker reply exceeded the message size limit.');
        return;
      }
      child.send(wire, (error) => {
        if (error !== null) fail('The benchmark worker IPC channel closed.');
      });
    };

    child.once('error', () => fail('Could not start the permission-restricted benchmark worker.'));
    child.once('exit', (code, signal) => fail(`Benchmark worker exited before a result (${code ?? signal ?? 'unknown'}).`));
    child.once('spawn', () => send(start));
    child.on('message', (wire: unknown) => {
      if (done) return;
      try {
        if (typeof wire !== 'string' || Buffer.byteLength(wire) > MAX_WIRE_BYTES) throw new Error('size');
        const parsed = workerMessage.safeParse(JSON.parse(wire));
        if (!parsed.success) throw new Error('shape');
        const message = parsed.data;
        if (message.kind === 'failed') {
          finish({ ok: false, stage: message.stage, reason: message.reason });
        } else if (message.kind === 'result') {
          if (pending) throw new Error('pending');
          finish({ ok: true, value: message.value });
        } else if (message.kind === 'log') {
          if (++logs > 100) throw new Error('log limit');
          input.log?.(message.line);
        } else {
          if (pending || ++commands > MAX_COMMANDS) throw new Error('command limit');
          pending = true;
          const timeoutSeconds = message.options?.timeoutSeconds;
          const command = Promise.resolve()
            .then(() => input.exec(message.argv, {
              ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
              signal: abort.signal,
            }))
            .then((result) => {
              pending = false;
              send(JSON.stringify({ kind: 'reply', payload: JSON.stringify({ result }) }));
            })
            .catch((error: unknown) => {
              fail(`Benchmark broker refused a command: ${error instanceof Error ? error.message.slice(0, 350) : 'unknown error'}`);
            });
          inFlight = command;
          void command.then(() => {
            if (inFlight === command) inFlight = null;
          });
        }
      } catch {
        fail('Benchmark worker violated the command broker protocol.');
      }
    });
  });
}
