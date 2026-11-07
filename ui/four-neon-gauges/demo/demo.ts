import { FourNeonGaugesElement } from '../src/FourNeonGaugesElement.js';

if (!customElements.get('clue-four-neon-gauges')) {
  customElements.define('clue-four-neon-gauges', FourNeonGaugesElement);
}

const element = document.querySelector('clue-four-neon-gauges');
if (!(element instanceof FourNeonGaugesElement)) {
  throw new Error('Gauge element did not mount.');
}

const response = await fetch('./sample-gauges.json', { cache: 'no-store' });
if (!response.ok) throw new Error(`Could not load sample gauges: ${response.status}`);
element.setProjection(await response.json());

element.addEventListener('gauge-focus', (event) => {
  console.log('gauge-focus', (event as CustomEvent).detail);
});
element.addEventListener('gauge-open-catalogue', (event) => {
  console.log('gauge-open-catalogue', (event as CustomEvent).detail);
});
