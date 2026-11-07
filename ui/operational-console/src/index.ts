import { ClueOperationalConsoleElement } from './OperationalConsoleElement.js';

export * from './protocol.js';
export * from './OperationalConsoleClient.js';
export * from './OperationalConsoleState.js';
export * from './OperationalConsoleElement.js';

if (!customElements.get('clue-operational-console')) {
  customElements.define('clue-operational-console', ClueOperationalConsoleElement);
}
