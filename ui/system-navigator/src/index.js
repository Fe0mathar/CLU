import { ClueSystemNavigatorElement } from './SystemNavigatorElement.js';

if (!customElements.get('clue-system-navigator')) {
  customElements.define('clue-system-navigator', ClueSystemNavigatorElement);
}

export { SystemNavigator } from './SystemNavigator.js';
export { ClueSystemNavigatorElement } from './SystemNavigatorElement.js';
export { ClueRecognitionAdapter } from './adapters/ClueRecognitionAdapter.js';
export { SseNavigatorAdapter } from './adapters/SseNavigatorAdapter.js';
export { ConsoleSealAdapter } from './adapters/ConsoleSealAdapter.js';
export { GraphModel, GRANULARITY_LEVEL, LEVEL_GRANULARITY } from './core/GraphModel.js';
export { LayoutEngine } from './core/LayoutEngine.js';
export {
  GRANULARITIES,
  NODE_PHASES,
  NAVIGATOR_EVENT_TYPES,
  DEFAULT_PHASE_COLORS,
  assertNavigatorEvent,
  phaseLabel,
} from './protocol.js';