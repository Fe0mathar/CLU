/** Resolvers from durable Project Profile state to the shared governed operation basis. */

import {
  PROJECT_GOVERNANCE_BASIS_VERSION,
  projectGovernanceBasisSchema,
  type ProjectGovernanceBasis,
} from '../../shared/projectGovernanceBasis.js';
import { operationIdentityFromProfileRecord } from '../../shared/projectOperationIdentity.js';
import type { ProjectProfileRecord } from '../../shared/schemas.js';
import type { ResolvedProjectBenchmarkRuntime } from './benchmarkRuntime.js';
import type { ProjectAuthoritySnapshot } from './projectAuthority.js';
import type { ResolvedProjectRuntimeBinding } from './projectRuntimeBinding.js';

export { PROJECT_GOVERNANCE_BASIS_VERSION, projectGovernanceBasisSchema };
export type { ProjectGovernanceBasis };

export function projectGovernanceBasisFromState(input: {
  readonly record: ProjectProfileRecord;
  readonly authority: ProjectAuthoritySnapshot;
  readonly benchmarkRuntime: ResolvedProjectBenchmarkRuntime;
}): ProjectGovernanceBasis | null {
  if (input.authority.manifest === null || input.benchmarkRuntime.masterBenchmarkHash === null) {
    return null;
  }
  return projectGovernanceBasisSchema.parse({
    basisVersion: PROJECT_GOVERNANCE_BASIS_VERSION,
    operationIdentity: operationIdentityFromProfileRecord(input.record),
    profileGeneration: input.record.generation,
    authorityHash: input.authority.manifest.manifestHash,
    masterBenchmarkHash: input.authority.manifest.masterBenchmarkHash,
    recognitionConfigHash: input.authority.recognitionConfigHash,
    benchmarkRuntimeHash: input.benchmarkRuntime.runtimeHash,
  });
}

export function projectGovernanceBasisFromBinding(
  binding: ResolvedProjectRuntimeBinding,
): ProjectGovernanceBasis | null {
  return projectGovernanceBasisFromState({
    record: binding.record,
    authority: binding.authority,
    benchmarkRuntime: binding.benchmarkRuntime,
  });
}
