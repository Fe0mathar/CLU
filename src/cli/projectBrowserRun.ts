/** Local operator entry point for one pinned scenario in the active managed Chrome instance. */

import { runProjectBrowserScenario, type BrowserRunOptions } from '../experiment/browser/projectBrowserRun.js';
import { write } from './output/formatter.js';

export type { BrowserRunOptions };

export async function commandProjectBrowserRun(repoRoot: string, projectId: string, options: BrowserRunOptions): Promise<number> {
  const result = await runProjectBrowserScenario(repoRoot, projectId, options);
  if (result.status !== 'COMPLETED') {
    process.stderr.write(`${result.errorCode}: ${result.errorDetail}\nEvidence: ${result.evidence}\n`);
    return 1;
  }
  const { status, browserExecutionId, evidence, comparison } = result;
  write(JSON.stringify({ status, browserExecutionId, evidence, comparison }, null, 2));
  return comparison?.state === 'INCOMPARABLE' ? 2 : 0;
}
