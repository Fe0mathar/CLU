/**
 * CLUE `docs` commands.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain; the CLI is argument handling, one service call, and printing.
 *       §11.5 — document content identity and location/version identity, claims, conflicts,
 *       evidence and lifecycle are preserved outside source syntax. This command is the
 *       operator's entry to that registry; it owns none of it.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`.
 *
 * ## What ingestion actually does
 *
 * Every governed Markdown file is parsed into blocks, each assertion is registered as a
 * claim bound to the exact location it was made at, and test seeds are derived from the
 * claims that are precise enough to support one. Three further passes then run over the
 * whole corpus rather than per document, because each is a question about the corpus:
 * which cited sources do not exist, which claims contradict each other, and which claims
 * are now seedable.
 *
 * ## Three properties of the code worth knowing before editing it
 *
 * **It is a writer.** `withLog: true` takes the single-writer event-log lock, and the
 * authority registry declares `mutates: true, requiresMission: true` — a claim is durable
 * evidence and must be attributable to a mission. It is not the read-only inspection command
 * its name suggests, and running it will lock out a concurrent recognition.
 *
 * **Unchanged documents are skipped, and say so.** Ingestion is content-addressed, so a
 * document whose bytes have not moved is reported `unchanged` with its existing claim count
 * rather than re-registered. That is what makes the command safe to run repeatedly, and it
 * is why `--reseed` exists: seed extraction has improved more often than the documents have,
 * and the only way to pick that up would otherwise be to rewrite claim history for documents
 * that never changed.
 *
 * **An empty corpus exits 1.** "No documents to ingest" is a configuration fault — the
 * tracked-document list names files, and finding none of them means the configuration is
 * wrong rather than the corpus being legitimately empty. A document listed in configuration
 * but absent from disk is reported `fail` per file for the same reason.
 *
 * ## The closing message is doctrine, not decoration
 *
 * Unresolved conflicts print a note that they are not defects in CLU-E but disagreements in
 * the corpus. That distinction is load-bearing: a conflict is durable evidence that two
 * governed documents disagree, and resolving one means deciding which is right — an act with
 * authority attached. A future edit that "cleans up" conflicts to make this command's output
 * quieter would be discarding evidence.
 *
 * Behaviour is moved, not changed.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { Command } from 'commander';

import { collectDocumentSources, findRepoRoot, loadConfig, withRuntime } from '../../control/runtime.js';
import { parsePackSeal } from '../../control/mission.js';
import { resolveDocumentationPack } from '../../control/documentationPack.js';
import type { DocumentStructure } from '../../analysis/documents/markdownStructure.js';
import { printChecks, truncate, write, type Check } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue docs ingest                                                           */
/* ------------------------------------------------------------------------- */

function commandDocsIngest(reseed: boolean): number {
  return withRuntime({ withLog: true, verifyLog: 'tail' }, (runtime) => {
    const claims = runtime.requireClaims();
    const seeds = runtime.seeds;
    const { sources, missing } = collectDocumentSources(runtime);

    if (sources.length === 0) {
      write('No documents to ingest.');
      return 1;
    }

    const structures: DocumentStructure[] = [];
    const changedHashes: string[] = [];
    const checks: Check[] = [];

    for (const source of sources) {
      const bytes = readFileSync(source.absolutePath);
      const result = claims.ingestDocument(source.path, bytes);
      structures.push(result.structure);
      if (!result.unchanged) changedHashes.push(result.document.hash);

      checks.push({
        level: result.unchanged ? 'info' : 'ok',
        label: truncate(source.path, 34),
        detail: result.unchanged
          ? `unchanged (${result.registered.length} claims)`
          : `${result.registered.length} claims, ${result.structure.blocks.length} blocks` +
            (result.superseded.length > 0 ? `, ${result.superseded.length} superseded` : ''),
      });
    }

    for (const path of missing) {
      checks.push({
        level: 'fail',
        label: truncate(path, 34),
        detail: 'listed in configuration but absent',
      });
    }

    printChecks(checks);
    write('');

    const missingSources = claims.refreshMissingSources(structures);
    const conflicts = claims.detectConflicts();

    let seedSummary = 'skipped (registry unavailable)';
    if (seeds !== null) {
      const target = reseed
        ? claims.claims({})
        : claims.claims({}).filter((claim) => changedHashes.includes(claim.document_hash));
      if (target.length === 0) seedSummary = 'no new claims to seed';
      else {
        const generated = seeds.generate(target);
        seedSummary = `${generated.seeds.length} seeds, ${generated.rejections.length} rejected`;
      }
    }

    const fromProject = sources.filter((source) => source.origin === 'project').length;
    write(`documents     ${sources.length} (${fromProject} from ${runtime.config.project.id})`);
    write(`claims        ${claims.claims({}).length} active`);
    write(
      `conflicts     ${conflicts.length} newly detected, ${claims.conflicts(true).length} unresolved`,
    );
    write(
      `missing srcs  ${missingSources.length} newly cited, ${claims.missingSources(true).length} outstanding`,
    );
    write(`seeds         ${seedSummary}`);

    if (claims.conflicts(true).length > 0) {
      write('');
      write('Unresolved conflicts are not defects in CLUE — they are disagreements in the corpus.');
      write('Inspect them with `clue conflicts`.');
    }
    return 0;
  });
}

/* ------------------------------------------------------------------------- */
/* clue docs ratify (DEV-P2-05, Gate 7)                                        */
/* ------------------------------------------------------------------------- */

/**
 * The Creator's ratification of the installed documentation pack, as a command.
 *
 * The CLI's share of the act is making it deliberate; the service's share
 * (`MissionRegistry.ratifyInstalledAuthority`) is making it true. Deliberate means three
 * things here:
 *
 * **Interactive only.** There is no `--yes`, and non-TTY input is refused outright. A
 * ratification that a script can perform is not an act, it is a side effect.
 *
 * **The confirmation phrase is bound to the state being ratified.** The operator types
 * `RATIFY <first 12 of the seal hash>`, read off the preview this command just printed.
 * A remembered phrase from last time cannot ratify a pack that has since moved on, and
 * the exact line typed is recorded as the act's `statement`.
 *
 * **The writer lock is held only for the act.** The preview reads the seal and the
 * configuration directly, without a runtime; a human deciding at the prompt must not be
 * holding the event-log lock against the daemon. The service then re-verifies everything
 * from disk inside the lock, so a file that drifted between preview and confirmation is
 * refused there — the preview informs, the service decides.
 */
async function commandDocsRatify(): Promise<number> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    write('docs ratify is an interactive Creator act; non-interactive input is refused');
    write('(no --yes exists by design).');
    return 1;
  }

  let packReleaseName: string;
  let packReleaseVersion: string;
  let sealFile: string;
  let manifestFile: string;
  let sealSha: string;
  let declaredCount: number;
  let manifestSha: string;
  let constitutionPath: string;
  let constitutionSha: string;
  try {
    const repoRoot = findRepoRoot();
    const config = loadConfig(repoRoot);
    const pack = resolveDocumentationPack(repoRoot);
    packReleaseName = pack.releaseName;
    packReleaseVersion = pack.releaseVersion;
    sealFile = pack.sealFile;
    manifestFile = pack.manifestFile;
    const sealPath = join(repoRoot, ...sealFile.split('/'));
    if (!existsSync(sealPath)) {
      write(`${sealFile} absent — ${pack.installHint} first.`);
      return 1;
    }
    const sealBytes = readFileSync(sealPath);
    sealSha = createHash('sha256').update(sealBytes).digest('hex');
    const parsed = parsePackSeal(sealBytes.toString('utf8'));
    if ('error' in parsed) {
      write(`${sealFile}: ${parsed.error}`);
      return 1;
    }
    declaredCount = parsed.declared.size;
    const manifest = parsed.declared.get(manifestFile);
    if (manifest === undefined) {
      write(`${sealFile} does not declare ${manifestFile}.`);
      return 1;
    }
    manifestSha = manifest;
    constitutionPath = config.constitution.file;
    const constitution = parsed.declared.get(constitutionPath);
    if (constitution === undefined) {
      write(`The registered constitution (${constitutionPath}) is not declared by ${sealFile}.`);
      return 1;
    }
    constitutionSha = constitution;
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }

  write('You are about to ratify the installed documentation pack as the governing authority:');
  write('');
  write(`  pack          ${packReleaseName} ${packReleaseVersion}`);
  write(`  seal          ${sealFile}  ${sealSha}`);
  write(`  declares      ${declaredCount} files`);
  write(`  manifest      ${manifestFile}  ${manifestSha}`);
  write(`  constitution  ${constitutionPath}  ${constitutionSha}`);
  write('');
  write('The act is recorded durably, attributed to the Creator, bound to the mission in force.');
  write('The service will refuse if any pack file disagrees with the seal at the moment of the act.');
  write('');

  const token = sealSha.slice(0, 12);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type exactly \`RATIFY ${token}\` to proceed, anything else aborts: `)).trim();
  rl.close();

  if (answer !== `RATIFY ${token}`) {
    write('Aborted — nothing was recorded.');
    return 1;
  }

  return runGuarded(() =>
    withRuntime({ withLog: true, verifyLog: 'tail' }, (runtime) => {
      const record = runtime.requireMission().ratifyInstalledAuthority({ statement: answer });
      write('');
      write(`Ratified as ${record.event_id} (sequence ${record.sequence}).`);
      write(`  pack        ${record.pack_release} ${record.release_version}`);
      write(`  seal        ${record.seal_sha256}`);
      write(`  statement   ${record.statement}`);
      write(`  at          ${record.ratified_at}`);
      return 0;
    }),
  );
}

/** Registers the `docs` commands. */
export function registerDocsCommands(program: Command): void {
  const docs = program.command('docs').description('document corpus');
  docs
    .command('ingest')
    .description('parse tracked documents into blocks, claims and test seeds')
    .option('--reseed', 're-derive seeds for documents whose content is unchanged', false)
    .action((options: { reseed: boolean }) => {
      process.exitCode = runGuarded(() => commandDocsIngest(options.reseed));
    });
  docs
    .command('ratify')
    .description("record the Creator's ratification of the installed documentation pack")
    .action(async () => {
      process.exitCode = await commandDocsRatify();
    });
}
