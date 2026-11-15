import type { Command } from 'commander';
import {
  loadProjectProfileStartup, readActiveProjectProfileForBenchmark, resolveProjectProfilesRoot,
} from '../../control/projectProfiles/projectProfileStartup.js';
import { findRepoRoot, withProjectRuntimeSnapshot, withRuntimeAsync } from '../../control/runtime.js';
import { previewAcceptedPublication, publishAcceptedSource } from '../../integration/git/acceptedPublication.js';
import { redactSecretText } from '../../shared/secretSafety.js';
import { write } from '../output/formatter.js';

async function commandPublication(proofEventId: string, confirmation?: string): Promise<void> {
  try {
    if (!/^EVENT-\d{6,}$/u.test(proofEventId)) throw new Error('Supply the exact ACCEPT verdict event ID.');
    const repoRoot = findRepoRoot();
    const profile = readActiveProjectProfileForBenchmark(repoRoot);
    const selector = loadProjectProfileStartup(repoRoot);
    if (profile === null || selector === null) throw new Error('Activate a saved Project Profile before publication.');
    const result = confirmation === undefined
      ? withProjectRuntimeSnapshot(profile, repoRoot, resolveProjectProfilesRoot(repoRoot, selector.profiles.registry_root),
        (runtime) => previewAcceptedPublication(runtime, proofEventId))
      : await withRuntimeAsync({ repoRoot, projectProfile: profile, withLog: true, verifyLog: 'full',
        requireMission: true, allowStaleHeartbeatReclaim: false }, (runtime) =>
        publishAcceptedSource(runtime, proofEventId, confirmation));
    write(JSON.stringify(result));
    process.exitCode = result.state === 'PENDING_REMOTE' && confirmation !== undefined ? 1 : 0;
  } catch (error) {
    const reason = redactSecretText(error instanceof Error ? error.message : String(error)).text.slice(0, 2048);
    write(JSON.stringify({ schemaVersion: 'clue-accepted-publication/1', state: 'BLOCKED', proofEventId, reason }));
    process.exitCode = 1;
  }
}

export function registerPublicationCommands(program: Command): void {
  const publication = program.command('publication').description('reviewed GitHub publication of one verified accepted source branch');
  publication.command('preview <proofEventId>')
    .description('show the accepted GitHub source publication scope and exact confirmation locally')
    .action((proofEventId: string) => commandPublication(proofEventId));
  publication.command('push <proofEventId>')
    .description('publish and verify the exact accepted source commit on its dedicated GitHub branch')
    .requiredOption('--confirmation <phrase>', 'exact PUBLISH SOURCE phrase emitted by publication preview')
    .action((proofEventId: string, options: { confirmation: string }) => commandPublication(proofEventId, options.confirmation));
}
