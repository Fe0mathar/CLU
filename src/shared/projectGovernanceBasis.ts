/** Shared project-scoped authority envelope used by cycle, proof, evidence and Great Book. */

import { hashCanonicalJson, type Sha256 } from './ids.js';
import {
  projectGovernanceBasisSchema,
  type ProjectGovernanceBasis,
} from './schemas.js';

export const PROJECT_GOVERNANCE_BASIS_VERSION = 'clue-project-governance-basis/1' as const;
export { projectGovernanceBasisSchema };
export type { ProjectGovernanceBasis };

export function projectGovernanceBasisHash(basis: ProjectGovernanceBasis): Sha256 {
  return hashCanonicalJson(projectGovernanceBasisSchema.parse(basis));
}
