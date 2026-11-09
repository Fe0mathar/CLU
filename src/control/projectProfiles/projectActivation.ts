/** Creator/operator-facing Project Profile activation coordination. */

import type { BrowserAgent } from '../../experiment/browser/browserAgent.js';
import type { Actor, ProjectProfileRecord, WorkspaceProjectIdentity } from '../../shared/schemas.js';
import {
  adoptLegacyWorkspaceProjectIdentity,
  type WorkspaceProjectIdentityInput,
} from '../../memory/db.js';
import { operationIdentityFromProfileRecord } from '../../shared/projectOperationIdentity.js';
import { ProjectBrowserSessionCoordinator } from './projectBrowserSessions.js';
import { assertProjectStatePaths } from './projectPathIsolation.js';
import {
  ProjectRuntimeManager,
  type ProjectRuntimeActivationRequest,
  type ProjectRuntimePublication,
} from './projectRuntimeManager.js';

export interface ActivateProjectRequest {
  readonly projectId: string;
  readonly actor?: Actor;
  readonly reason?: string;
  readonly expectedCurrentIdentity?: ProjectRuntimeActivationRequest['expectedCurrentIdentity'];
}

export class ProjectActivationService {
  public constructor(private readonly manager: ProjectRuntimeManager) {}

  public activate(request: ActivateProjectRequest): ProjectRuntimePublication {
    return this.manager.activate({
      projectId: request.projectId,
      actor: request.actor ?? 'creator',
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.expectedCurrentIdentity === undefined
        ? {}
        : { expectedCurrentIdentity: request.expectedCurrentIdentity }),
    });
  }
}

/**
 * Explicit one-time ownership adoption for a profile produced by the legacy migration. The
 * projection rows and event history are not rewritten; the receipt records their existing head.
 */
export function adoptLegacyWorkspaceForProfile(
  record: ProjectProfileRecord,
  options: { readonly now?: () => string } = {},
): WorkspaceProjectIdentity {
  if (record.profile.provenance.source !== 'legacy-target-profile') {
    throw new Error(
      `Project ${record.profile.projectId} is native; legacy workspace adoption is forbidden`,
    );
  }
  assertProjectStatePaths(record.profile);
  const identity = operationIdentityFromProfileRecord(record);
  const expected: WorkspaceProjectIdentityInput = {
    projectId: identity.projectId,
    targetRootIdentity: identity.targetRootIdentity,
    profileVersion: record.profile.profileVersion,
    initialProfileHash: identity.projectProfileHash,
  };
  return adoptLegacyWorkspaceProjectIdentity(record.profile.state.databasePath, expected, options);
}

/**
 * Registers one already-established governed browser agent with the atomic project switch boundary.
 * The callbacks park Project A before Project B publication, restore A on rollback, and close a
 * released session. Registration itself never starts Chrome and never guesses a desktop window.
 */
export function registerProjectBrowserAgent(
  coordinator: ProjectBrowserSessionCoordinator,
  record: ProjectProfileRecord,
  agent: BrowserAgent,
): void {
  coordinator.register(record, {
    session: agent.identity(),
    onActivate: () => agent.resume(),
    onPark: () => agent.park(),
    onRelease: () => agent.close(),
  });
}
