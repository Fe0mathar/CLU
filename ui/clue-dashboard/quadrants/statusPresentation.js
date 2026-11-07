import { presentBranch, presentationAriaLabel } from '../components/branchPresentation.js';
import { createQuadrantController } from './quadrantController.js';

const listSize = (value) => Array.isArray(value) ? value.length : undefined;
const fileCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const QUADRANTS = [
  { id: 'q1', branches: ['repositoryInventory', 'recognition'], readValue: (branch) => fileCount(branch.fileCount), unit: 'files in Status inventory' },
  { id: 'q2', branches: ['improvementField'], readValue: (branch) => listSize(branch.cells), unit: 'metric cells' },
  { id: 'q3', branches: ['gauges'], readValue: (branch) => listSize(branch.gauges), unit: 'gauge projections' },
  { id: 'q4', branches: ['operationalConsole'], readValue: (branch) => listSize(branch.events), unit: 'console events in this snapshot' },
];

/** Bind each quadrant's accessibility label to its own structured Status branch. */
export function mountQuadrantStatus({ findPanel, store, bus }) {
  const controllers = [];
  for (const { id, branches, readValue, unit } of QUADRANTS) {
    const panel = findPanel(id);
    if (!panel) continue;
    const [primary] = branches;
    panel.dataset.statusBranch = primary;
    const controller = createQuadrantController({
      id,
      store,
      bus,
      branches,
      render(context) {
        const decision = presentBranch(context.branch(primary), { readValue });
        panel.dataset.statusState = decision.kind;
        panel.setAttribute('aria-label', presentationAriaLabel(decision, id.toUpperCase(), (value) => `${value} ${unit}`));
      },
    });
    controller.mount();
    controllers.push(controller);
  }
  return controllers;
}
