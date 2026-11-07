import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NavigatorSseServer } from '../integration/node/NavigatorSseServer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const navigatorRoot = resolve(here, '..');
const repositoryRoot = resolve(navigatorRoot, '..', '..');

const args = process.argv.slice(2);
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const host = valueAfter('--host', '127.0.0.1');
const port = Number.parseInt(valueAfter('--port', '47831'), 10);
const eventFile = resolve(valueAfter(
  '--events',
  resolve(repositoryRoot, 'workspace', 'graph', 'system-navigator.ndjson'),
));

const server = new NavigatorSseServer({
  host,
  port: Number.isFinite(port) ? port : 47831,
  staticRoot: navigatorRoot,
  eventFile,
});

const urls = await server.start();
process.stdout.write(`CLUE System Navigator\n`);
process.stdout.write(`  dashboard  ${urls.dashboard}\n`);
process.stdout.write(`  stream     ${urls.events}\n`);
process.stdout.write(`  events     ${eventFile}\n`);
process.stdout.write(`\nRun \`clue recognize --navigator\` in another terminal.\n`);
process.stdout.write(`Press Ctrl+C to stop.\n`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
