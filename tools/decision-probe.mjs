/**
 * CLU-E decision probe — read-only.
 *
 * Purpose: replace the questions I cannot answer from here with facts from the Creator's machine,
 * so the decisions left open are narrowed to the ones that are genuinely judgement.
 *
 * Run from the repository root, after a successful build:
 *
 *     npx tsc && node tools/decision-probe.mjs
 *
 * Optionally write the report to a file as well:
 *
 *     node tools/decision-probe.mjs --out probe-report.txt
 *
 * ## What this probe will not do
 *
 * It never takes the event-log writer lock, never writes durable state, never spawns a CLI
 * command, and never creates a directory. Every runtime attach is `withLog: false`, which as of
 * this session is a guarantee rather than an intention: the projection database is opened
 * `readonly: true` and the artifact store refuses writes with `ArtifactStoreError('READ_ONLY')`.
 *
 * It is therefore safe to run while the daemon is up, while a recognition is in flight, and on a
 * live workspace. If it ever cannot answer something without writing, it reports that it could
 * not answer rather than writing.
 *
 * ## What it reports, and which decision each section serves
 *
 *   A. Host and configuration portability  → does DEV-P1-35's refusal affect this machine at all?
 *   B. Tracked documents                   → can `clue init` bootstrap here? (continuation §5C)
 *   C. Protected-surface policy            → is `patching.policy_file` found, and does the
 *                                            nullable-schema question actually bite?
 *   D. Workspace state                     → is there a live workspace, and what is in it?
 *   E. Authority table vs. reality         → the DEV-P1-36 review, reduced to the contested rows
 *   F. Questions                           → the answers I need, numbered
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------------- */
/* Output                                                                     */
/* ------------------------------------------------------------------------- */

const lines = [];
const say = (text = '') => {
  lines.push(text);
  console.log(text);
};
const heading = (text) => {
  say('');
  say(text);
  say('-'.repeat(text.length));
};
const bullet = (text) => say(`  ${text}`);

/** Never let one failed section hide the rest — a partial report beats no report. */
function section(title, work) {
  heading(title);
  try {
    work();
  } catch (error) {
    bullet(`COULD NOT ANSWER: ${error?.message ?? String(error)}`);
    if (error?.code) bullet(`  code: ${error.code}`);
    if (error?.code === 'CONFIG_PATH_FOREIGN') {
      bullet('  This is section A showing through, not a probe defect: the workspace cannot be');
      bullet('  located on a host the configuration was not written for. On the intended host');
      bullet('  this section will report normally.');
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Locating the build                                                         */
/* ------------------------------------------------------------------------- */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

function distModule(relative) {
  const path = join(repoRoot, 'dist', 'src', relative);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing — run \`npx tsc\` first (noEmitOnError leaves dist stale)`);
  }
  return import(`file://${path}`);
}

const runtime = await distModule('control/runtime.js');
const schemas = await distModule('shared/schemas.js');
const authority = await distModule('cli/commandAuthority.js');

say('CLU-E decision probe — read-only');
say(`repo root: ${repoRoot}`);
say(`host:      ${process.platform} ${process.arch}, node ${process.version}`);
say(`run at:    ${new Date().toISOString()}`);

/* ------------------------------------------------------------------------- */
/* A. Configuration portability                                               */
/* ------------------------------------------------------------------------- */

let config = null;

section('A. Configuration portability (DEV-P1-35 / -40 / -41)', () => {
  config = runtime.loadConfig(repoRoot);

  const keys = [
    ['project.root', config.project.root],
    ['workspace.root', config.workspace.root],
    ['shadow.root', config.shadow.root],
    ['browser.profile_dir', config.browser.profile_dir],
    ['patching.policy_file', config.patching.policy_file],
    ['equilibrium.policy_file', config.equilibrium.policy_file],
    ['gateway.budget_policy_file', config.gateway.budget_policy_file],
    ['gateway.routing_file', config.gateway.routing_file],
  ];

  let foreign = 0;
  for (const [key, value] of keys) {
    const form = schemas.absolutePathForm(value);
    const nativeHere = isAbsolute(value);
    const isForeign = form !== null && !nativeHere;
    if (isForeign) foreign += 1;
    const verdict = isForeign
      ? 'FOREIGN — would be refused on this host'
      : form === null
        ? 'relative (resolved against the repo root)'
        : 'absolute here — fine';
    bullet(`${key.padEnd(28)} ${verdict}`);
    bullet(`${''.padEnd(28)} value: ${value}   [form: ${String(form)}]`);
  }

  say('');
  bullet(
    foreign === 0
      ? 'VERDICT: nothing in this configuration is refused on this host. DEV-P1-35 costs you nothing.'
      : `VERDICT: ${foreign} configured path(s) would be REFUSED on this host. On Windows this is normally 0.`,
  );
  bullet('Only the first four and patching.policy_file are resolved through the guard;');
  bullet('the other policy files are listed so you can see whether they would ever matter.');
});

/* ------------------------------------------------------------------------- */
/* B. Tracked documents                                                       */
/* ------------------------------------------------------------------------- */

section('B. Tracked documents — can `clue init` bootstrap here? (continuation §5C)', () => {
  if (config === null) throw new Error('configuration did not load; see section A');

  const tracked = config.constitution.tracked_documents;
  const constitutionFile = config.constitution.file;

  // Sibling search: a document named `X_v8.md` when `X_v9.md` exists on disk is a version-number
  // mismatch, not a lost file. That distinction decides whether this is an edit or a recovery.
  const rootEntries = existsSync(repoRoot)
    ? readdirSync(repoRoot).filter((name) => name.toLowerCase().endsWith('.md'))
    : [];
  const stemOf = (name) => basename(name).replace(/_v\d+(\.\d+)*\.md$/iu, '').replace(/\.md$/iu, '');

  let missing = 0;
  let recoverable = 0;

  for (const doc of tracked) {
    const path = join(repoRoot, doc);
    const marker = doc === constitutionFile ? ' (constitution.file)' : '';
    if (existsSync(path)) {
      bullet(`present  ${doc}${marker}`);
      continue;
    }
    missing += 1;
    const stem = stemOf(doc);
    const siblings = rootEntries.filter((name) => stemOf(name) === stem && name !== basename(doc));
    if (siblings.length > 0) {
      recoverable += 1;
      bullet(`MISSING  ${doc}${marker}  — but found: ${siblings.join(', ')}`);
    } else {
      bullet(`MISSING  ${doc}${marker}  — no same-stem file in the repo root`);
    }
  }

  say('');
  if (missing === 0) {
    bullet('VERDICT: every tracked document is readable. `clue init` is not blocked by §5C here.');
  } else {
    bullet(`VERDICT: ${missing} tracked document(s) unreadable — \`clue init\` will refuse.`);
    bullet(`         ${recoverable} of those look like version-number drift (a newer file exists).`);
    bullet(`         ${missing - recoverable} appear genuinely absent.`);
  }
});

/* ------------------------------------------------------------------------- */
/* C. Protected-surface policy                                                */
/* ------------------------------------------------------------------------- */

section('C. Protected-surface policy (DEV-P1-40)', () => {
  if (config === null) throw new Error('configuration did not load; see section A');

  bullet(`patching.mode:        ${config.patching.mode}`);
  bullet(`landing/patching on:  ${runtime.landingOrPatchingEnabled(config)}`);

  const declared = config.patching.policy_file;
  const resolvedPath = isAbsolute(declared) ? declared : join(repoRoot, declared);
  bullet(`policy_file declared: ${declared}`);
  bullet(`resolves to:          ${resolvedPath}`);
  bullet(`exists on disk:       ${existsSync(resolvedPath)}`);

  const state = runtime.readProtectedPolicy(repoRoot, config);
  bullet(`present:              ${state.present}`);
  bullet(`malformed:            ${state.malformed}`);
  bullet(`declared surfaces:    ${state.rules.length}`);

  say('');
  if (!state.present) {
    bullet('VERDICT: no policy is being read. Two very different situations look identical here:');
    bullet('  (a) deliberate — nothing may mutate the canonical tree, or');
    bullet('  (b) a typo — the path is portable but names a file that is not there.');
    bullet('This is exactly the ambiguity a nullable `policy_file` would remove. See question 3.');
  } else if (state.malformed) {
    bullet('VERDICT: the policy exists and cannot be parsed. A patch-capable startup is blocked,');
    bullet('which is correct, but the policy needs fixing before anything can land.');
  } else {
    bullet(`VERDICT: policy read cleanly with ${state.rules.length} protected surface(s).`);
    bullet('The nullable-schema question is real but not urgent for you.');
  }
});

/* ------------------------------------------------------------------------- */
/* D. Workspace state                                                         */
/* ------------------------------------------------------------------------- */

let hasMission = null;

section('D. Workspace state (read-only attach — no writer lock taken)', () => {
  if (config === null) throw new Error('configuration did not load; see section A');

  const resolved = runtime.resolveConfigPaths(config, repoRoot);
  const workspaceRoot = resolved.workspace.root;
  bullet(`workspace root:  ${workspaceRoot}`);
  bullet(`exists:          ${existsSync(workspaceRoot)}`);

  const dbPath = join(workspaceRoot, 'db', 'clue.db');
  bullet(`projection db:   ${existsSync(dbPath) ? dbPath : 'absent'}`);
  if (existsSync(dbPath)) {
    bullet(`db size:         ${statSync(dbPath).size} bytes`);
  }

  const eventsPath = join(workspaceRoot, 'events', 'events.ndjson');
  if (existsSync(eventsPath)) {
    const bytes = statSync(eventsPath).size;
    const count = readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
    bullet(`event log:       ${count} event(s), ${bytes} bytes`);
  } else {
    bullet('event log:       absent');
  }

  runtime.withRuntime({ withLog: false, repoRoot }, (r) => {
    const missions = r.mission === null ? null : r.mission.history();
    hasMission = missions !== null && missions.length > 0;
    bullet(`missions:        ${missions === null ? 'registry unavailable' : missions.length}`);
    if (missions !== null && missions.length > 0) {
      const current = missions.find((m) => m.superseded_by === null) ?? missions[missions.length - 1];
      bullet(`current mission: ${current.id ?? '(unnamed)'}`);
      bullet(`tracked docs:    ${current.documents?.length ?? 0}`);
    }

    const snapshots = r.snapshots === null ? null : r.snapshots.list?.() ?? null;
    bullet(`snapshots:       ${snapshots === null ? 'not enumerable through this API' : snapshots.length}`);

    bullet(`claims registry: ${r.claims === null ? 'unavailable' : 'present'}`);
    bullet(`seeds registry:  ${r.seeds === null ? 'unavailable' : 'present'}`);
    bullet(`metric registry: ${r.metrics === null ? 'unavailable' : 'present'}`);
    return 0;
  });

  say('');
  bullet(
    hasMission
      ? 'VERDICT: this is a live workspace with a registered mission.'
      : 'VERDICT: no mission is registered — the system has not bootstrapped here.',
  );
});

/* ------------------------------------------------------------------------- */
/* E. Authority table vs. reality — the DEV-P1-36 review                      */
/* ------------------------------------------------------------------------- */

section('E. Authority table vs. reality (DEV-P1-36)', () => {
  const commandsDir = join(repoRoot, 'src', 'cli', 'commands');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');

  /**
   * The `withLog` a specific command opens with.
   *
   * Per function, not per module. The first version of this probe scanned the whole file and
   * reported WRITER if any call in it passed `true` — which is right for a single-command module
   * and wrong for a mixed one. `task` has four writers and two readers, so it reported WRITER for
   * `task list` and `task show` even after both were corrected: a false positive on exactly the
   * defect the probe had been used to find.
   *
   * `task list` maps to `commandTaskList`, so the function name is derived from the command words
   * and the nearest `withRuntime` below it is the one that belongs to it.
   */
  const attachmentFor = (command) => {
    const [domain, ...rest] = command.split(' ');
    const file = join(commandsDir, `${domain}Commands.ts`);
    if (!existsSync(file)) return null;

    const source = strip(readFileSync(file, 'utf8'));
    const camel = [domain, ...rest]
      .map((word) => word.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(''))
      .join('');
    const fn = new RegExp(`function\\s+command${camel}\\s*\\(`, 'u');
    const at = source.search(fn);
    if (at === -1) return null;

    const after = source.slice(at);
    const call = /withRuntime(?:Async)?\s*\(\s*\{[^}]*?withLog:\s*(true|false)/u.exec(after);
    return call === null ? null : call[1] === 'true';
  };

  /**
   * Module-wide fallback, for domains that do not give each subcommand its own function.
   *
   * `audit tail` and `audit denials` share one `commandAudit`, so the per-function lookup finds
   * nothing. Reporting `n/a` there would hide a real answer; reporting the module's answer and
   * marking it is honest about how it was obtained.
   */
  const moduleWide = (command) => {
    const file = join(commandsDir, `${command.split(' ')[0]}Commands.ts`);
    if (!existsSync(file)) return null;
    const found = [];
    const pattern = /withRuntime(?:Async)?\s*\(\s*\{[^}]*?withLog:\s*(true|false)/gu;
    for (const m of strip(readFileSync(file, 'utf8')).matchAll(pattern)) found.push(m[1] === 'true');
    if (found.length === 0) return null;
    return found.some(Boolean);
  };

  const moduleWideGate = (command) => {
    const file = join(commandsDir, `${command.split(' ')[0]}Commands.ts`);
    if (!existsSync(file)) return null;
    return /requireMission:\s*true/u.test(strip(readFileSync(file, 'utf8')));
  };

  /** Whether a specific command passes the runtime's own mission gate. */
  const gatesOnMission = (command) => {
    const [domain, ...rest] = command.split(' ');
    const file = join(commandsDir, `${domain}Commands.ts`);
    if (!existsSync(file)) return null;

    const source = strip(readFileSync(file, 'utf8'));
    const camel = [domain, ...rest]
      .map((word) => word.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(''))
      .join('');
    const at = source.search(new RegExp(`function\\s+command${camel}\\s*\\(`, 'u'));
    if (at === -1) return null;

    const call = /withRuntime(?:Async)?\s*\(\s*\{([^}]*)\}/u.exec(source.slice(at));
    return call === null ? null : /requireMission:\s*true/u.test(call[1]);
  };

  say('  command                     declared         attaches   runtime gate');
  say('  --------------------------- ---------------- ---------- ------------');

  const wouldStartRefusing = [];
  const readersTakingTheWriter = [];
  for (const entry of authority.COMMAND_AUTHORITIES) {
    const exact = attachmentFor(entry.command);
    const attach = exact === null ? moduleWide(entry.command) : exact;
    const exactGate = gatesOnMission(entry.command);
    const gate = exactGate === null ? moduleWideGate(entry.command) : exactGate;
    // `*` marks an answer read from the whole module because the command has no function of its
    // own — accurate for the module, possibly coarse for the command.
    const mark = exact === null && attach !== null ? '*' : '';
    const declared = `${entry.mutates ? 'writes' : 'reads '} ${entry.requiresMission ? 'mission' : 'nomission'}`;
    const attachText = attach === null ? 'n/a' : `${attach ? 'WRITER' : 'read-only'}${mark}`;
    const gateText = gate === null ? 'n/a' : `${gate ? 'enforced' : 'NOT enforced'}${mark}`;
    say(`  ${entry.command.padEnd(27)} ${declared.padEnd(16)} ${attachText.padEnd(10)} ${gateText}`);

    // The decision-relevant set: declared to need a mission, but nothing enforces it today. These
    // are the commands whose behaviour would CHANGE if DEV-P1-36 were completed as declared.
    if (entry.requiresMission && gate === false) wouldStartRefusing.push(entry.command);
    if (!entry.mutates && attach === true) readersTakingTheWriter.push(entry.command);
  }

  if (readersTakingTheWriter.length > 0) {
    say('');
    bullet('Declared read-only but attaching with the WRITER lock:');
    for (const command of readersTakingTheWriter) bullet(`    ${command}`);
    bullet('`cli-attachment-conformance.test.ts` only checks domains whose commands are ALL');
    bullet('declared read-only, so a reader inside a mixed domain is outside the rule. `doctor`');
    bullet('is a deliberate exception (it verifies the log, which cannot be opened read-only);');
    bullet('anything else here is a candidate DEV-P1-38 that the rule cannot see.');
  }

  say('');
  bullet(`Commands that would START REFUSING on a mission-less workspace if the table were`);
  bullet(`enforced as written (${wouldStartRefusing.length} of ${authority.COMMAND_AUTHORITIES.length}):`);
  for (const command of wouldStartRefusing) bullet(`    ${command}`);

  say('');
  bullet('The rows I believe are wrong, and why — confirm or overrule each in question 4:');
  bullet('  mission        — would refuse to explain that no mission is registered. Circular.');
  bullet('  audit tail     — the audit log is what you read when nothing works, including');
  bullet('  audit denials     before a mission exists. Same argument that exempted `status show`.');
  bullet('  doctor         — already exempt, and is the model: an inspection command that must');
  bullet('                   work when the system does not.');
  bullet('Everything else on the list produces or consumes evidence, where requiring a mission');
  bullet('is the point rather than an obstacle — but that is my reading, not a measurement.');
});

/* ------------------------------------------------------------------------- */
/* F. Questions                                                               */
/* ------------------------------------------------------------------------- */

heading('F. What I need from you');

say(`
 1. Section B — bootstrap.
    If documents are missing: are the v8 bytes recoverable, or should the config be
    repointed at the v9 pack? Repointing changes constitution_hash, so it is a new
    mission rather than an edit. Your call, and it is DEV-P1-25/-26 territory.

 2. Section A — portability.
    If any path shows FOREIGN: is this machine the intended host? If you run CLU-E on
    Windows and only I saw the refusal, nothing needs doing and I will stop raising it.

 3. Section C — protected policy.
    If "no policy is being read": is that deliberate (nothing may mutate the canonical
    tree) or an accident? If deliberate, the nullable-\`policy_file\` schema change is worth
    doing so the declaration is explicit. If accidental, the path needs fixing first.

 4. Section E — the mission gate (DEV-P1-36).
    Four questions, and the fourth is the only one that needs thought:
      (a) Should \`mission\` be exempt?      (my reading: yes — circular otherwise)
      (b) Should \`audit tail/denials\`?     (my reading: yes — diagnostics must work)
      (c) Any others on the refusal list that should be exempt?
      (d) Once the table is right: do you want it ENFORCED — the seam in
          commands/shared.ts, sixteen call sites, roughly ten turns — or left declared
          and documented as advisory? Enforcing it buys a real gate; leaving it buys
          those ten turns for cluster D or E. I have no preference I can justify from
          the evidence; it depends how soon you expect \`src/cycle/\` to exist.

 5. Unrelated to this probe, and overdue: I have been reporting P1 as 18 of 30 on the
    continuation brief's word rather than my own measurement. Do you want me to audit
    those eighteen against the tree? It produces a report, not a patch, and it would
    make the percentage yours rather than inherited.
`);

/* ------------------------------------------------------------------------- */

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && process.argv[outIndex + 1] !== undefined) {
  const target = process.argv[outIndex + 1];
  writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\n[report written to ${target}]`);
}
