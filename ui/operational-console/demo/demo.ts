import '../src/index.js';
import type { ClueOperationalConsoleElement } from '../src/OperationalConsoleElement.js';
import { parseConsoleProjection } from '../src/protocol.js';

const consoleElement = document.querySelector<ClueOperationalConsoleElement>('clue-operational-console');
if (consoleElement === null) throw new Error('Operational Console element not found.');

const params = new URLSearchParams(location.search);
if (params.get('sample') === '1') {
  const response = await fetch('/demo/sample-events.json', { cache: 'no-store' });
  consoleElement.setProjection(parseConsoleProjection(await response.json()));
} else {
  consoleElement.setAttribute('endpoint', location.origin);
}
