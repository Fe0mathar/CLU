/** Optional Git parent evidence for the exact inputs measured by a local proof. */
import { z } from 'zod';

import { resolveTargetRootIdentity } from '../../shared/pathIdentity.js';
import { gitObjectIdSchema, type ProjectProfileRecord } from '../../shared/schemas.js';
import { inspectLocalLandingBase } from './localLandingGit.js';

export const localLandingBaseSchema = z.object({
  branch: z.string().min(1),
  commit: gitObjectIdSchema,
  tree: gitObjectIdSchema,
}).strict();

export type LocalLandingBase = z.infer<typeof localLandingBaseSchema>;

/** Local proof still works when a clean, attached Git parent cannot be established. */
export function observeLocalLandingBase(
  record: ProjectProfileRecord | null,
  projectRoot: string,
): LocalLandingBase | null {
  if (record === null) return null;
  const { repositoryRoot, defaultBranch, currentBasePin } = record.profile.integrations.git;
  try {
    if (resolveTargetRootIdentity(projectRoot) !== record.profile.targetRootIdentity ||
        resolveTargetRootIdentity(repositoryRoot) !== record.profile.targetRootIdentity) return null;
    const { baseCommit, baseTree } = inspectLocalLandingBase(repositoryRoot, defaultBranch);
    if (currentBasePin !== null && currentBasePin !== baseCommit) return null;
    return localLandingBaseSchema.parse({ branch: defaultBranch, commit: baseCommit, tree: baseTree });
  } catch {
    return null;
  }
}
