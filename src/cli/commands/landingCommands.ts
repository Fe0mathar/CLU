import type { Command } from 'commander';
import { loadProjectProfileStartup, readActiveProjectProfileForBenchmark, resolveProjectProfilesRoot } from '../../control/projectProfiles/projectProfileStartup.js';
import { findRepoRoot, withProjectRuntimeSnapshot, withRuntimeAsync } from '../../control/runtime.js';
import { executeAcceptedLanding, previewAcceptedLanding } from '../../integration/git/localLanding.js';
import { redactSecretText } from '../../shared/secretSafety.js';
import { loadProofPatchManifest } from './proofCommands.js';
import { write } from '../output/formatter.js';

interface LandingOptions { readonly patch: string; readonly confirmation?: string }

async function commandLanding(mode: 'preview' | 'apply' | 'rollback', proofEventId: string, options: LandingOptions): Promise<void> {
  try {
    if (!/^EVENT-\d{6,}$/u.test(proofEventId)) throw new Error('Supply the exact ACCEPT verdict event ID.');
    const repoRoot = findRepoRoot();
    const profile = readActiveProjectProfileForBenchmark(repoRoot);
    const selector = loadProjectProfileStartup(repoRoot);
    if (profile === null || selector === null) throw new Error('Activate a saved Project Profile before reviewing a landing.');
    const registryRoot = resolveProjectProfilesRoot(repoRoot, selector.profiles.registry_root);
    const input = { proofEventId, patch: loadProofPatchManifest(options.patch) };
    const confirmation = options.confirmation;
    const receipt = mode === 'preview'
      ? withProjectRuntimeSnapshot(profile, repoRoot, registryRoot, (runtime) => previewAcceptedLanding(runtime, input))
      : await withRuntimeAsync({ repoRoot, projectProfile: profile, withLog: true, verifyLog: 'full',
        requireMission: true, allowStaleHeartbeatReclaim: false }, (runtime) =>
        executeAcceptedLanding(runtime, { ...input, mode, confirmation: confirmation ?? '' }));
    write(JSON.stringify(receipt));
    process.exitCode = mode === 'apply' && 'state' in receipt && receipt.state === 'ROLLED_BACK' ? 1 : 0;
  } catch (error) {
    const reason = redactSecretText(error instanceof Error ? error.message : String(error)).text.slice(0, 2048);
    write(JSON.stringify({ schemaVersion: 'clue-local-landing/1', state: 'BLOCKED', mode, proofEventId, reason }));
    process.exitCode = 1;
  }
}

export function registerLandingCommands(program: Command): void {
  const landing = program.command('landing').description('reviewed Custodian operations on a local accepted Git branch');
  landing.command('preview <proofEventId>').description('review the current accepted proof and exact Git base')
    .requiredOption('--patch <file>', 'typed patch manifest containing the actual proved file bytes')
    .action((proofEventId: string, options: LandingOptions) => commandLanding('preview', proofEventId, options));
  for (const [mode, description] of [
    ['apply', 'create and verify the local accepted branch for an explicitly confirmed proof'],
    ['rollback', 'restore the accepted branch tree with an exact compensating commit'],
  ] as const) {
    landing.command(mode + ' <proofEventId>').description(description)
      .requiredOption('--patch <file>', 'typed patch manifest containing the actual proved file bytes')
      .requiredOption('--confirmation <phrase>', 'exact phrase emitted by landing preview')
      .action((proofEventId: string, options: LandingOptions) => commandLanding(mode, proofEventId, options));
  }
}
