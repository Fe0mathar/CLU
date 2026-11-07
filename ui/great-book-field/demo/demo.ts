import { GreatBookFieldElement } from '../src/GreatBookFieldElement.js';

customElements.define('clue-great-book-field', GreatBookFieldElement);

const element = document.querySelector('clue-great-book-field') as GreatBookFieldElement;
const response = await fetch('./sample-projection.json');
const projection = await response.json();
element.setProjection(projection);
