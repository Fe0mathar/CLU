/**
 * CLUE console commands.
 *
 * Spec: CLUE_implementation.md §96 (dedicated profile, allowed origins).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.3, Part IX §39-43.
 *
 * The operator surface for observation. Capture what Murugan says while it runs,
 * attribute it to units, and report what stands between a scope and a clean console.
 *
 * The capture flow has one shape worth understanding, because it looks roundabout and
 * is not. Entries are collected first and attributed second. Attribution needs source
 * maps; source maps are fetched over the protocol; and fetching them *during* capture
 * would put network latency inside the window being measured. So the browser is listened
 * to, then released, then the maps for the scripts that actually appeared are collected,
 * and only then is a synchronous attributor built and the ledger fed. Capture stays
 * cheap, and the ledger never learns that a network was involved.
 *
 * Registered separately from the main command file because that file is already the
 * largest in the repository and console work is a coherent group of its own.
 */

import type { Command } from 'commander';

import {
  checkLine,
  short,
  truncate,
  write,
  type CheckLevel,
} from './output/formatter.js';
import { latestSnapshot as resolveLatestSnapshot } from './commands/shared.js';

import { withRuntime, withRuntimeAsync, type Runtime } from '../control/runtime.js';
import { BrowserAgent, BrowserAgentError, originAllowed } from '../experiment/browser/browserAgent.js';
import { assessAttribution, type SourceMapProvider } from '../experiment/console/attribution.js';
import type {
  ConsoleClassification,
  ConsoleLevel,
  RawConsoleEntry,
} from '../experiment/console/consoleLedger.js';
import { registerOperationalConsoleCommands } from './operationalConsoleCommands.js';

/* ------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* ------------------------------------------------------------------------- */

// DEV-P1-07: this file carried its own copy of the formatter, which had drifted to a
// 28-column label where index.ts used 34. The copy is gone and the width is now the one
// shared value — console output aligns with the rest of the CLI for the first time.
function check(level: CheckLevel, label: string, detail: string): void {
  checkLine(level, label, detail);
}

// DEV-P1-07: the third copy of this helper is gone. The console's message is preserved
// exactly — it explains that nothing can be *attributed*, which is what its callers were
// about to do, and a generic message would be less useful precisely where it is read.
function latestSnapshot(runtime: Runtime, override?: string): string {
  return resolveLatestSnapshot(
    runtime,
    override,
    'No snapshot has been captured, so nothing can be attributed. Run `clue snapshot` first.',
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/* ------------------------------------------------------------------------- */
/* clue console status                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Reports what is reachable, without attaching.
 *
 * Separate from `capture` so the answer to "is the browser up" never depends on being
 * able to complete a capture. It also lists targets that were refused, because "no
 * allowed target" and "no browser" are different problems with different fixes.
 */
async function commandStatus(port?: number): Promise<number> {
  return withRuntimeAsync({ withLog: false }, async (runtime) => {
    const endpointPort = port ?? runtime.config.browser.remote_debugging_port;
    const allowed = runtime.config.browser.allowed_origins;

    let targets;
    try {
      targets = await BrowserAgent.listTargets('127.0.0.1', endpointPort);
    } catch (error) {
      check('fail', 'endpoint', (error as Error).message);
      write();
      write('Start the dedicated profile:');
      write(
        `  pwsh scripts/launch-test-browser.ps1 -ProfileDir "${runtime.config.browser.profile_dir}" ` +
          `-Port ${endpointPort} -Url http://localhost:5173`,
      );
      return 1;
    }

    const pages = targets.filter((target) => target.type === 'page');
    check('ok', 'endpoint', `127.0.0.1:${endpointPort} answers`);
    check('info', 'targets', `${targets.length} total, ${pages.length} page(s)`);

    if (pages.length === 0) {
      check('warn', 'attachable', 'no page targets');
      return 1;
    }

    let attachable = 0;
    for (const target of pages) {
      const permitted = originAllowed(target.url, allowed);
      if (permitted) attachable += 1;
      check(
        permitted ? 'ok' : 'warn',
        permitted ? 'allowed' : 'refused',
        `${truncate(target.url, 68)}`,
      );
    }

    if (attachable === 0) {
      write();
      write(`No open page matches ${allowed.join(', ')}.`);
      write('CLUE measures the tree it is reasoning over; attaching elsewhere would measure');
      write('a different program and look entirely valid doing it.');
      return 1;
    }

    return 0;
  });
}

/* ------------------------------------------------------------------------- */
/* clue console capture                                                       */
/* ------------------------------------------------------------------------- */

interface CaptureOptions {
  readonly duration: string;
  readonly port?: string;
  readonly snapshot?: string;
  readonly scenario?: string;
  readonly checkpoint?: string;
  readonly origin: string;
}

async function commandCapture(options: CaptureOptions): Promise<number> {
  return withRuntimeAsync({ withLog: true }, async (runtime) => {
    const snapshotId = latestSnapshot(runtime, options.snapshot);
    const durationMs = Math.max(1, Number.parseInt(options.duration, 10)) * 1000;
    const port = options.port === undefined
      ? runtime.config.browser.remote_debugging_port
      : Number.parseInt(options.port, 10);

    let agent: BrowserAgent;
    try {
      agent = await BrowserAgent.attach({
        port,
        allowedOrigins: runtime.config.browser.allowed_origins,
      });
    } catch (error) {
      const failure = error as BrowserAgentError;
      check('fail', 'attach', failure.message);
      if (failure.code === 'ENDPOINT_UNREACHABLE' || failure.code === 'NO_TARGET') {
        write();
        write('Start the dedicated profile with scripts/launch-test-browser.ps1 first.');
      }
      return 1;
    }

    check('ok', 'attached', truncate(agent.target.url, 60));
    check('info', 'snapshot', short(snapshotId));
    check('info', 'capturing', `${durationMs / 1000}s`);
    write();

    // DEV-P1-21: the labels the ledger binds a sighting to. Both are optional and both are
    // recorded as absent when omitted; neither is guessed from the capture window.
    const label = (entry: RawConsoleEntry): RawConsoleEntry => ({
      ...entry,
      ...(options.scenario === undefined ? {} : { scenarioId: options.scenario }),
      ...(options.checkpoint === undefined ? {} : { checkpointId: options.checkpoint }),
    });

    const entries: RawConsoleEntry[] = [];
    const stop = agent.onConsole((entry) => {
      entries.push(label(entry));
    });

    // Wall-clock capture is the manual form. Scenario-driven capture replaces it at
    // Stage G2, where the window is defined by steps rather than by a stopwatch.
    const tick = 5000;
    for (let elapsed = 0; elapsed < durationMs; elapsed += tick) {
      await delay(Math.min(tick, durationMs - elapsed));
      const errors = entries.filter((entry) => entry.level === 'error').length;
      const warnings = entries.filter((entry) => entry.level === 'warning').length;
      write(
        `       ${String(Math.min(elapsed + tick, durationMs) / 1000).padStart(4)}s  ` +
          `${entries.length} entries · ${errors} error(s) · ${warnings} warning(s)`,
      );
    }
    stop();

    if (entries.length === 0) {
      agent.close();
      write();
      check('info', 'result', 'nothing was emitted during the window');
      write();
      write('A silent window is a fact, not a success: it may mean the application was idle.');
      write('Exercise the feature you care about while capturing, or wait for Stage G2 scenarios.');
      return 0;
    }

    // Maps are collected after the window closes. Fetching them during capture would put
    // protocol latency inside the interval being observed.
    write();
    const scripts = new Set<string>(agent.knownScripts());
    for (const entry of entries) {
      for (const frame of entry.frames) {
        if (frame.url.length > 0) scripts.add(frame.url);
      }
    }

    const collected = new Map<string, string | null>();
    let fetched = 0;
    for (const url of scripts) {
      if (fetched >= 400) break;
      collected.set(url, await agent.sourceMapFor(url));
      fetched += 1;
    }
    agent.close();

    const provider: SourceMapProvider = (url) => collected.get(url) ?? null;
    const health = assessAttribution(entries, provider);

    const ledger = runtime.makeConsoleLedger(runtime.makeAttributor(snapshotId, provider));
    const session = ledger.beginSession({
      snapshotId,
      scenarioId: options.scenario ?? null,
      origin: options.origin === 'shadow' ? 'shadow' : 'external',
    });
    const result = ledger.ingest(session.id, entries);

    check('ok', 'session', session.id);
    check('ok', 'entries', String(result.entriesIngested));
    check('ok', 'signatures', `${result.signaturesTouched} (${result.newSignatures.length} new)`);
    check(
      health.ratio === 0 ? 'fail' : health.ratio < 0.5 ? 'warn' : 'ok',
      'source maps',
      `${health.scriptsWithMaps}/${health.scriptsSeen} scripts mapped (${(health.ratio * 100).toFixed(0)}%)`,
    );

    write();
    for (const bucket of ['actionable', 'unclassified', 'external', 'intentional'] as const) {
      write(`  ${bucket.padEnd(14)} ${result.byClassification[bucket]}`);
    }

    // Zero mapped scripts is a configuration problem that presents as a corpus problem:
    // every entry lands in `unclassified` and the ledger looks useless rather than blind.
    if (health.ratio === 0 && health.scriptsSeen > 0) {
      write();
      write('No source maps were available, so nothing could be attributed to a unit.');
      write('The dev server must serve source maps before the ledger can inform ranking.');
      for (const url of health.missing.slice(0, 5)) write(`  unmapped: ${truncate(url, 70)}`);
    }

    write();
    write('Next: clue console clean');
    return 0;
  });
}

/* ------------------------------------------------------------------------- */
/* clue console clean                                                         */
/* ------------------------------------------------------------------------- */

function commandClean(): number {
  return withRuntime({ withLog: true }, (runtime) => {
    const report = runtime.requireConsole().cleanliness();

    check(report.clean ? 'ok' : 'warn', 'clean', report.clean ? 'yes' : 'no');
    check(report.actionable === 0 ? 'ok' : 'warn', 'actionable', String(report.actionable));
    check(report.unclassified === 0 ? 'ok' : 'warn', 'unclassified', String(report.unclassified));
    check('info', 'external', `${report.external} (counted, does not block)`);
    check('info', 'intentional', `${report.intentional} (declared, does not block)`);

    if (report.blocking.length > 0) {
      write();
      write('standing in the way:');
      for (const signature of report.blocking.slice(0, 20)) {
        write(
          `  ${signature.level.toUpperCase().padEnd(7)} ${String(signature.occurrences).padStart(6)}×  ` +
            `${signature.attributed_to ?? '(unattributed)'}`,
        );
        write(`          ${truncate(signature.sample_text, 88)}`);
      }
      if (report.blocking.length > 20) {
        write(`  … and ${report.blocking.length - 20} more`);
      }
    }

    write();
    write(report.qualifier);
    return report.clean ? 0 : 1;
  });
}

/* ------------------------------------------------------------------------- */
/* clue console signatures / show / classify                                  */
/* ------------------------------------------------------------------------- */

interface SignaturesOptions {
  readonly classification?: string;
  readonly level?: string;
  readonly unit?: string;
  readonly untriaged: boolean;
  readonly count: string;
}

function commandSignatures(options: SignaturesOptions): number {
  return withRuntime({ withLog: true }, (runtime) => {
    const signatures = runtime.requireConsole().signatures({
      ...(options.classification === undefined
        ? {}
        : { classification: options.classification as ConsoleClassification }),
      ...(options.level === undefined ? {} : { level: options.level as ConsoleLevel }),
      ...(options.unit === undefined ? {} : { attributedTo: options.unit }),
      onlyUntriaged: options.untriaged,
      limit: Number.parseInt(options.count, 10),
    });

    if (signatures.length === 0) {
      write('No signatures match. Run `clue console capture` first.');
      return 0;
    }

    for (const signature of signatures) {
      write(
        `${short(signature.signature, 10)}  ${signature.level.padEnd(7)} ` +
          `${signature.classification.padEnd(13)} ${String(signature.occurrences).padStart(6)}×  ` +
          `${signature.scenario_count} scenario(s)${signature.triaged ? '  [triaged]' : ''}`,
      );
      write(`            ${truncate(signature.sample_text, 90)}`);
      if (signature.attributed_to !== null) {
        write(`            → ${signature.attributed_to}`);
      }
      write();
    }

    write(`${signatures.length} signature(s).`);
    return 0;
  });
}

function commandShow(signatureId: string): number {
  return withRuntime({ withLog: true }, (runtime) => {
    const matches = runtime
      .requireConsole()
      .signatures({ limit: 5000 })
      .filter((entry) => entry.signature.startsWith(signatureId));

    if (matches.length === 0) {
      write(`No signature starts with ${signatureId}.`);
      return 1;
    }
    if (matches.length > 1) {
      write(`${signatureId} is ambiguous across ${matches.length} signatures:`);
      for (const match of matches.slice(0, 10)) {
        write(`  ${short(match.signature, 16)}  ${truncate(match.sample_text, 70)}`);
      }
      return 1;
    }

    const signature = matches[0];
    if (signature === undefined) return 1;

    write(signature.signature);
    write();
    write(`  level          ${signature.level}`);
    write(`  classification ${signature.classification}${signature.triaged ? ' (triaged)' : ' (automatic)'}`);
    if (signature.intentional_reason !== null) {
      write(`  declared       ${signature.intentional_reason}`);
    }
    write(`  occurrences    ${signature.occurrences} across ${signature.session_count} session(s)`);
    write(`  scenarios      ${signature.scenario_count}`);
    write(`  first seen     ${signature.first_seen_at}`);
    write(`  last seen      ${signature.last_seen_at}`);
    write();
    write(`  attribution    ${signature.attribution_outcome}`);
    write(`                 ${signature.attribution_detail}`);
    if (signature.attributed_to !== null) {
      write(`  unit           ${signature.attributed_to}`);
      write(`  location       ${signature.attributed_path}:${signature.attributed_line}`);
    }
    if (signature.top_frame !== null) {
      write(`  top frame      ${signature.top_frame}`);
    }
    write();
    write('  normalised:');
    write(`    ${truncate(signature.normalised_text, 92)}`);
    write('  sample:');
    for (const line of signature.sample_text.split('\n').slice(0, 8)) {
      write(`    ${truncate(line, 92)}`);
    }
    return 0;
  });
}

interface ClassifyOptions {
  readonly as: string;
  readonly reason?: string;
}

/**
 * Records a triage decision.
 *
 * `intentional` and `external` require a reason, because both remove an entry from the
 * clean-console criterion. An exclusion nobody explained is indistinguishable from an
 * exclusion nobody thought about, and §42 exists so silence stays auditable.
 */
function commandClassify(signatureId: string, options: ClassifyOptions): number {
  return withRuntime({ withLog: true }, (runtime) => {
    const ledger = runtime.requireConsole();
    const classification = options.as as ConsoleClassification;

    if (!['actionable', 'external', 'intentional', 'unclassified'].includes(classification)) {
      write(`Unknown classification "${options.as}".`);
      return 1;
    }

    const silencing = classification === 'intentional' || classification === 'external';
    if (silencing && (options.reason === undefined || options.reason.trim().length === 0)) {
      write(`Marking a signature "${classification}" removes it from the clean-console criterion.`);
      write('That needs a stated reason. Pass --reason.');
      return 1;
    }

    const matches = ledger
      .signatures({ limit: 5000 })
      .filter((entry) => entry.signature.startsWith(signatureId));

    if (matches.length !== 1) {
      write(
        matches.length === 0
          ? `No signature starts with ${signatureId}.`
          : `${signatureId} is ambiguous across ${matches.length} signatures.`,
      );
      return 1;
    }

    const signature = matches[0];
    if (signature === undefined) return 1;

    ledger.classify(signature.signature, classification, options.reason ?? null);
    check('ok', 'classified', `${short(signature.signature, 16)} → ${classification}`);
    if (options.reason !== undefined) check('info', 'reason', options.reason);
    write();
    write('The decision is sticky: a later capture will not silently reclassify it.');
    return 0;
  });
}

/* ------------------------------------------------------------------------- */
/* Registration                                                               */
/* ------------------------------------------------------------------------- */

export function registerConsoleCommands(program: Command): void {
  const console = program
    .command('console')
    .description('observe what Murugan says while it runs');

  console
    .command('status')
    .description('report whether a dedicated browser is reachable and attachable')
    .option('--port <port>', 'debugging port; defaults to the configured one')
    .action((options: { port?: string }) => {
      void commandStatus(options.port === undefined ? undefined : Number.parseInt(options.port, 10))
        .then((code) => {
          process.exitCode = code;
        })
        .catch((error: unknown) => {
          process.stderr.write(`${(error as Error).message}\n`);
          process.exitCode = 1;
        });
    });

  console
    .command('capture')
    .description('collect console output, attribute it to units, and record it')
    .option('-d, --duration <seconds>', 'capture window', '30')
    .option('--port <port>', 'debugging port; defaults to the configured one')
    .option('--snapshot <id>', 'snapshot to attribute against; defaults to the latest')
    .option('--scenario <id>', 'label this capture as belonging to a scenario')
    .option('--checkpoint <id>', 'label this capture as taken at a scenario checkpoint')
    .option('--origin <origin>', 'shadow | external', 'external')
    .action((options: CaptureOptions) => {
      void commandCapture(options)
        .then((code) => {
          process.exitCode = code;
        })
        .catch((error: unknown) => {
          process.stderr.write(`${(error as Error).message}\n`);
          process.exitCode = 1;
        });
    });

  console
    .command('clean')
    .description('report whether the console is clean, and what stands in the way')
    .action(() => {
      process.exitCode = runGuarded(commandClean);
    });

  console
    .command('signatures')
    .description('list deduplicated console signatures')
    .option('--classification <bucket>', 'actionable | unclassified | external | intentional')
    .option('--level <level>', 'error | warning | info | debug | log')
    .option('--unit <logicalId>', 'only signatures attributed to this unit')
    .option('--untriaged', 'only signatures no human has judged', false)
    .option('-n, --count <number>', 'maximum rows', '25')
    .action((options: SignaturesOptions) => {
      process.exitCode = runGuarded(() => commandSignatures(options));
    });

  console
    .command('show <signature>')
    .description('show one signature in full, including how attribution went')
    .action((signature: string) => {
      process.exitCode = runGuarded(() => commandShow(signature));
    });

  console
    .command('classify <signature>')
    .description('record a triage decision for a signature')
    .requiredOption('--as <classification>', 'actionable | external | intentional | unclassified')
    .option('--reason <reason>', 'required when the decision removes it from the clean criterion')
    .action((signature: string, options: ClassifyOptions) => {
      process.exitCode = runGuarded(() => commandClassify(signature, options));
    });

  registerOperationalConsoleCommands(console);
}

function runGuarded(work: () => number): number {
  try {
    return work();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
