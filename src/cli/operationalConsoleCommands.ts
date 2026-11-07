/** CLI surface for the initial Operational Console implementation. */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Command } from 'commander';

import { OperationalConsoleServer } from '../daemon/operationalConsoleServer.js';
import { projectOperationalConsole } from '../observability/operationalConsole/projection.js';

interface UiOptions {
  readonly port: string;
  readonly host: string;
  readonly workspace: string;
}

export function registerOperationalConsoleCommands(consoleCommand: Command): void {
  consoleCommand
    .command('ui')
    .description('serve the cinematic source-faithful Operational Console')
    .option('--host <host>', 'bind host', '127.0.0.1')
    .option('--port <port>', 'bind port', '47833')
    .option('--workspace <path>', 'CLU-E workspace root', 'workspace')
    .action(async (options: UiOptions) => {
      const workspace = resolve(options.workspace);
      const eventFile = join(workspace, 'console', 'operational-console.ndjson');
      const blobsDir = join(workspace, 'blobs');
      mkdirSync(join(workspace, 'console'), { recursive: true });
      mkdirSync(blobsDir, { recursive: true });
      if (!existsSync(eventFile)) writeFileSync(eventFile, '', 'utf8');
      const server = new OperationalConsoleServer({
        eventFile,
        blobsDir,
        staticRoot: resolve('ui', 'operational-console'),
        host: options.host,
        port: Number.parseInt(options.port, 10),
      });
      const address = await server.start();
      process.stdout.write(
        `CLU-E Operational Console\n  ui      ${address.root}\n  stream  ${address.events}\n  events  ${eventFile}\nPress Ctrl+C to stop.\n`,
      );
      const stop = async (): Promise<void> => {
        await server.stop();
        process.exit(0);
      };
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());
    });

  consoleCommand
    .command('export-ui-state')
    .description('export the current Operational Console projection as JSON')
    .option('--workspace <path>', 'CLU-E workspace root', 'workspace')
    .requiredOption('--out <path>', 'destination JSON file')
    .action((options: { workspace: string; out: string }) => {
      const eventFile = join(resolve(options.workspace), 'console', 'operational-console.ndjson');
      const projection = projectOperationalConsole(eventFile, { limit: 1000 });
      const output = resolve(options.out);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
      process.stdout.write(`${output}\n`);
    });
}
