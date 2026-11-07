/**
 * CLUE restricted-host client.
 *
 * Architecture: CLUE_Architecture_v8.md (persistent PowerShell host, typed commands, fixed
 *   command registry; PowerShell Controller: approved builds, servers, test scripts, process
 *   measurement, file hashing, repository-state checks).
 * Interface: CLUE_Interface_Design_v10.md (host request/response envelopes; the host re-resolves
 *   and returns the path/zone it acted on, which the client checks against its own decision).
 * Execution: CLUE_Execution_Model_v8.md Stage G1 ("typecheck and build run without arbitrary shell").
 * Backlog: DEV-P0-11 — strict response schemas (sha256, timestamps, integers, paths, zones, refs,
 *   process receipts), durable audit-execution correlation per request, and host-resolved
 *   path/zone parity checked before a reply becomes evidence.
 *
 * This is the analysis and experiment planes' *only* sanctioned way to run a process,
 * touch Git, hash a file on disk, or start and stop the dedicated test browser. The
 * browser agent attaches but never launches for exactly this reason: process execution
 * belongs behind one restricted host with a capability token, and this client is the
 * typed half of that boundary. `scripts/launch-test-browser.ps1` and the forthcoming
 * `scripts/clue-host.ps1` are its counterpart on the PowerShell side.
 *
 * Three properties make this a boundary rather than a convenience:
 *
 *   **A closed registry, not a shell.** There is deliberately no "run this command"
 *   method. Every operation is a named member of a fixed set, and the arguments each
 *   accepts are constrained — `run` takes one of the shadow tree's own npm scripts, not
 *   an argv; `git` takes one of a small set of verbs with per-verb argument allowlists.
 *   The closed set *is* the security surface. A method that forwarded an arbitrary
 *   string would reintroduce the arbitrary shell that Stage G1's gate exists to forbid.
 *
 *   **A capability per command, checked before the wire.** Every command is bound to
 *   exactly one {@link Capability}. Before a request is written to the host, it is put
 *   through the {@link PolicyEngine}; a denial short-circuits and nothing reaches the
 *   host. This is the first of two path defences. The host re-resolves the target path
 *   at execution time and returns the zone it actually landed in; the client refuses a
 *   reply whose zone disagrees with the one it authorised, because a client that assumes
 *   the host will check is a client that has stopped checking.
 *
 *   **Responses are validated before they are trusted.** A host reply becomes evidence
 *   the moment a caller reads it, so every reply is parsed against a strict schema — every
 *   hash a strict sha256, every count an integer, every closed shape refusing unknown keys —
 *   and its resolved path and zone are checked against the client's decision, before it is
 *   believed. A malformed or zone-mismatched reply is refused, never recorded; a malformed
 *   *line* off the host is counted and logged, never allowed to crash the reader.
 *
 * Everything here is asynchronous, unlike most of CLUE. That is inherent to driving a
 * long-lived external process, and this module is the boundary: callers await a plain,
 * validated {@link HostResult} and hand it to synchronous consumers. A single host
 * crash aborts the requests in flight with {@link HostClientErrorCode} `HOST_CRASHED`;
 * the caller decides what that means for its run. A run interrupted by a dead
 * instrument is an *invalid test*, not a Murugan defect, and the distinction is the
 * caller's to record — this client only reports faithfully that the instrument died.
 *
 * **No dependency.** The host is spawned with `node:child_process` and read line by line
 * off its stdout. A {@link HostSpawn} seam lets the whole client be exercised against a
 * fake host in a unit test without a real `pwsh`, the same way the browser agent feature-
 * detects its socket constructor.
 */

import { z } from 'zod';

import type { Actor } from '../../shared/schemas.js';
import {
  pathSchema,
  shadowRunResultSchema,
  gitResultSchema,
  fsHashResultSchema,
  fsStatResultSchema,
  browserLaunchResultSchema,
  browserStatusResultSchema,
  browserStopResultSchema,
} from '../../shared/schemas.js';
import type {
  Capability,
  PathZone,
  PolicyDecision,
  PolicyEngine,
  PolicyRequest,
} from '../../control/policy.js';
import { normaliseAbsolute } from '../../control/policy.js';
import { hashText, nowIso, type Sha256 } from '../../shared/ids.js';
import {
  assertProjectOperationIdentity,
  canonicalProjectOperationIdentity,
  projectOperationIdentitySchema,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import {
  type OperationalConsoleExchange,
  OperationalConsoleRecorder,
} from '../../observability/operationalConsole/recorder.js';
import { openWindowsHostObserver, type WindowsHostObserver } from './windowsHostObserver.js';

/* ------------------------------------------------------------------------- */
/* Wire protocol                                                              */
/* ------------------------------------------------------------------------- */

/** Protocol version. The host echoes it; a mismatch is refused rather than guessed. */
export const HOST_PROTOCOL_VERSION = 1 as const;

/**
 * The fixed command registry. This constant is the contract: the PowerShell host
 * implements exactly these names, and no code path can send anything outside the set,
 * because {@link HostCommandName} is derived from it and every public method targets one
 * member by name.
 */
export const HOST_COMMANDS = [
  /** Liveness and identity — returns the host banner (pwsh version, OS). */
  'host.hello',
  /** Host-side environment fingerprint for a run's evidence envelope. */
  'env.host',
  /** Refresh the shadow clone from a canonical snapshot. Effect is a shadow write. */
  'shadow.refresh',
  /** Run one of the shadow tree's own npm scripts (typecheck, build, serve). */
  'shadow.run',
  /** A constrained Git verb, zone-scoped. Landing verbs require the landing capability. */
  'git',
  /** SHA-256 of a file on disk, zone-scoped to a readable zone. */
  'fs.hash',
  /** Stat a path (existence, kind, size, mtime), zone-scoped to a readable zone. */
  'fs.stat',
  /** Start the dedicated test browser via the launch script. */
  'browser.launch',
  /** Poll the dedicated browser's DevTools endpoint. */
  'browser.status',
  /** Stop only the CLUE-launched browser, matched by its profile directory. */
  'browser.stop',
] as const;

export type HostCommandName = (typeof HOST_COMMANDS)[number];

/**
 * The capability each command requires. `git` and the `fs.*` commands are the two whose
 * capability depends on the target zone, so they are resolved per call rather than from
 * this table; the entries here are their *floor* and are overridden by the resolver.
 */
const STATIC_COMMAND_CAPABILITY: Readonly<Record<HostCommandName, Capability>> = {
  'host.hello': 'process.run.host',
  'env.host': 'process.run.host',
  'shadow.refresh': 'fs.write.shadow',
  'shadow.run': 'process.run.shadow',
  git: 'process.run.shadow',
  'fs.hash': 'fs.read.workspace',
  'fs.stat': 'fs.read.workspace',
  'browser.launch': 'browser.control',
  'browser.status': 'browser.control',
  'browser.stop': 'browser.control',
} as const;

/** The npm scripts the shadow tree exposes. A closed set; never an arbitrary argv. */
export const SHADOW_SCRIPTS = [
  'npm.ci',
  'typecheck',
  'build',
  'serve.start',
  'serve.stop',
] as const;

export type ShadowScript = (typeof SHADOW_SCRIPTS)[number];

/** The Git verbs the host will run. Each has its own argument allowlist below. */
export const GIT_VERBS = [
  'status',
  'revParseHead',
  'revParseBranch',
  'hashObject',
  'clone',
  'fetch',
  'checkout',
  'applyCheck',
  'apply',
  'addAll',
  'commit',
  'mergeFfOnly',
  'revert',
] as const;

export type GitVerb = (typeof GIT_VERBS)[number];

/** Verbs that mutate the canonical tree. These require `git.land.canonical`. */
const CANONICAL_LANDING_VERBS: ReadonlySet<GitVerb> = new Set<GitVerb>(['mergeFfOnly', 'revert']);

/** Verbs that only read. On the canonical zone these require `git.read.canonical`. */
const GIT_READ_VERBS: ReadonlySet<GitVerb> = new Set<GitVerb>([
  'status',
  'revParseHead',
  'revParseBranch',
  'hashObject',
]);

/* ------------------------------------------------------------------------- */
/* Command argument shapes                                                    */
/* ------------------------------------------------------------------------- */

interface HelloArgs {
  readonly kind: 'host.hello';
  /** The authoritative roots the client requires the host to enforce (DEV-P0-11). */
  readonly roots?: HostRoots;
}

interface EnvHostArgs {
  readonly kind: 'env.host';
}

interface ShadowRefreshArgs {
  readonly kind: 'shadow.refresh';
  readonly canonicalRoot: string;
  readonly shadowRoot: string;
  /** Commit to check out into the shadow tree; null takes the canonical HEAD. */
  readonly commit: string | null;
}

interface ShadowRunArgs {
  readonly kind: 'shadow.run';
  readonly shadowRoot: string;
  readonly script: ShadowScript;
  readonly timeoutMs: number;
}

interface GitArgs {
  readonly kind: 'git';
  readonly zone: Extract<PathZone, 'canonical' | 'shadow'>;
  readonly root: string;
  readonly verb: GitVerb;
  /** Verb-specific parameters. Resolved into a fixed argv by {@link gitArgv}. */
  readonly params: GitParams;
}

/** Union of the small parameter sets the constrained Git verbs accept. */
export type GitParams =
  | { readonly of: 'none' }
  | { readonly of: 'path'; readonly path: string }
  | { readonly of: 'ref'; readonly ref: string }
  | { readonly of: 'clone'; readonly source: string; readonly dest: string }
  | { readonly of: 'commit'; readonly message: string }
  | { readonly of: 'sha'; readonly sha: string };

interface FsHashArgs {
  readonly kind: 'fs.hash';
  readonly zone: PathZone;
  readonly path: string;
}

interface FsStatArgs {
  readonly kind: 'fs.stat';
  readonly zone: PathZone;
  readonly path: string;
}

interface BrowserLaunchArgs {
  readonly kind: 'browser.launch';
  readonly executable: string;
  readonly profileDir: string;
  readonly port: number;
  readonly url: string;
  readonly timeoutMs: number;
}

interface BrowserStatusArgs {
  readonly kind: 'browser.status';
  readonly port: number;
}

interface BrowserStopArgs {
  readonly kind: 'browser.stop';
  readonly profileDir: string;
}

type CommandArgs =
  | HelloArgs
  | EnvHostArgs
  | ShadowRefreshArgs
  | ShadowRunArgs
  | GitArgs
  | FsHashArgs
  | FsStatArgs
  | BrowserLaunchArgs
  | BrowserStatusArgs
  | BrowserStopArgs;

/* ------------------------------------------------------------------------- */
/* Result shapes                                                              */
/* ------------------------------------------------------------------------- */

export interface HostBanner {
  readonly host: string;
  readonly protocol: number;
  readonly pwshVersion: string;
  readonly os: string;
  /** The operating roots the host will enforce, echoed back for the client to verify (DEV-P0-11). */
  readonly roots?: HostRoots;
  /** Project Profile identity pinned to this host session, when profile-bound. */
  readonly projectIdentity?: ProjectOperationIdentity;
}

/**
 * The authoritative operating roots (DEV-P0-11). The client sends these at startup and the host echoes
 * the ones it will actually enforce; the client refuses to proceed unless every one matches, so a host
 * pointed at a different canonical, shadow, workspace, or browser-profile directory than the client
 * believes is caught before a single command is sent.
 */
export interface HostRoots {
  readonly canonical: string;
  readonly shadow: string;
  readonly workspace: string;
  readonly browserProfile: string;
}

const hostRootsSchema = z
  .object({
    canonical: z.string().min(1),
    shadow: z.string().min(1),
    workspace: z.string().min(1),
    browserProfile: z.string().min(1),
  })
  .strict();

export interface HostEnvironment {
  readonly os: string;
  readonly arch: string;
  readonly pwshVersion: string;
  readonly cpuCount: number;
  readonly totalMemBytes: number;
  readonly capturedAt: string;
}

export interface ShadowRefreshResult {
  readonly head: string;
  readonly refreshedAt: string;
}

export interface ShadowRunResult {
  readonly script: ShadowScript;
  readonly exitCode: number;
  readonly durationMs: number;
  /**
   * Output is captured to files by the host and referenced by hash and path, never
   * inlined. A build log is evidence; pasting it into a response is not.
   */
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdoutPath: string | null;
  readonly stderrPath: string | null;
}

export interface GitResult {
  readonly verb: GitVerb;
  readonly exitCode: number;
  readonly durationMs: number;
  /** Trimmed stdout. Small by construction — porcelain status, a hash, a ref. */
  readonly stdout: string;
}

export interface FsHashResult {
  readonly sha256: string;
  readonly bytes: number;
}

export interface FsStatResult {
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly bytes: number | null;
  readonly mtimeMs: number | null;
}

export interface BrowserLaunchResult {
  readonly started: boolean;
  readonly endpoint: string | null;
  readonly pid: number | null;
}

export interface BrowserStatusResult {
  readonly running: boolean;
  readonly endpoint: string | null;
}

export interface BrowserStopResult {
  readonly stopped: boolean;
}

/* ------------------------------------------------------------------------- */
/* Result envelope and errors                                                 */
/* ------------------------------------------------------------------------- */

export type HostClientErrorCode =
  /** The policy engine denied the request; it never reached the host. */
  | 'POLICY_DENIED'
  /** The client was asked to act before {@link HostClient.start} resolved. */
  | 'NOT_STARTED'
  /** The host process exited while requests were in flight. */
  | 'HOST_CRASHED'
  /** No reply within the command's timeout. The late reply, if any, is ignored. */
  | 'HOST_TIMEOUT'
  /** The host answered with `ok: false`. Its own code is carried in {@link hostCode}. */
  | 'HOST_ERROR'
  /** A line off the host did not match the response schema. */
  | 'MALFORMED_RESPONSE'
  /** The host reported acting in a zone other than the one the client authorised. */
  | 'ZONE_PARITY_MISMATCH'
  /**
   * The host resolved the target to a different path than the one the client authorised, even though
   * it lay in the authorised zone (DEV-P0-11). A path substitution within the zone is refused as an
   * escape rather than accepted as evidence.
   */
  | 'PATH_PARITY_MISMATCH'
  /** The host echoed operating roots at startup that do not match the client's (DEV-P0-11). */
  | 'ROOT_PARITY_MISMATCH'
  /** The host session/request belongs to another Project Profile generation. */
  | 'PROJECT_IDENTITY_MISMATCH'
  /** A verb or script argument failed the client-side allowlist before sending. */
  | 'INVALID_ARGUMENT'
  /** The platform did not provide a usable child-process spawner. */
  | 'NO_SPAWNER';

export class HostClientError extends Error {
  public override readonly name = 'HostClientError';
  public readonly code: HostClientErrorCode;
  /** The denial code from the policy engine, when {@link code} is `POLICY_DENIED`. */
  public readonly policyCode: string | null;
  /** The host's own error code, when {@link code} is `HOST_ERROR`. */
  public readonly hostCode: string | null;

  public constructor(
    code: HostClientErrorCode,
    message: string,
    detail?: { policyCode?: string | null; hostCode?: string | null },
  ) {
    super(message);
    this.code = code;
    this.policyCode = detail?.policyCode ?? null;
    this.hostCode = detail?.hostCode ?? null;
  }
}

/**
 * A total result. Callers switch on `ok` rather than catching, so a denied command and
 * a dead host are handled on the same footing as a successful one — none of them is
 * exceptional in a system whose whole job is to run experiments that may fail.
 */
export type HostResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HostClientError };

function ok<T>(value: T): HostResult<T> {
  return { ok: true, value };
}

function err<T>(error: HostClientError): HostResult<T> {
  return { ok: false, error };
}

/* ------------------------------------------------------------------------- */
/* Spawn seam                                                                 */
/* ------------------------------------------------------------------------- */

/** Minimal surface of a spawned host process the client depends on. */
export interface HostProcess {
  /** Write one newline-terminated line to the host's stdin. */
  writeLine(line: string): void;
  /** Register the stdout line reader. Lines arrive already split on `\n`. */
  onLine(listener: (line: string) => void): void;
  /** Register the exit handler. Fires once. */
  onExit(listener: (code: number | null) => void): void;
  /** Terminate the host. Idempotent. */
  kill(): void;
}

/** Constructs a host process. The seam that lets a fake host stand in under test. */
export type HostSpawn = (executable: string, args: readonly string[]) => HostProcess;

/**
 * The default spawner over `node:child_process`. Imported lazily so that a test passing
 * its own {@link HostSpawn} never loads the module, and so this file has no static
 * dependency on Node internals beyond types.
 */
async function defaultSpawn(executable: string, args: readonly string[]): Promise<HostSpawn> {
  const { spawn } = await import('node:child_process');
  return (exe, spawnArgs) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.toUpperCase() === 'OPENAI_API_KEY') delete env[name];
    }
    const child = spawn(exe, [...spawnArgs], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(code: number | null) => void> = [];

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          for (const listener of lineListeners) {
            listener(line);
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
    // Consume diagnostics without exposing a host script's unrestricted stderr.
    child.stderr.resume();
    child.on('error', () => { /* close reports the failed process to the client */ });
    child.stdin.on('error', () => { /* close also handles a pipe failure when the host exits */ });
    child.on('close', (code) => {
      for (const listener of exitListeners) {
        listener(code);
      }
    });

    return {
      writeLine(line: string): void {
        child.stdin.write(`${line}\n`);
      },
      onLine(listener: (line: string) => void): void {
        lineListeners.push(listener);
      },
      onExit(listener: (code: number | null) => void): void {
        exitListeners.push(listener);
      },
      kill(): void {
        child.kill();
      },
    };
  };
  void executable;
  void args;
}

/* ------------------------------------------------------------------------- */
/* Secret redaction                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Names of environment variables whose values must never appear in a log, an audit
 * line, or a commit message. The host client never places a secret in a command
 * argument — Git and npm do not need the OpenAI key — but the redactor exists so that
 * any string derived from a request is safe by construction rather than by vigilance.
 */
const SECRET_ENV_NAMES: readonly string[] = ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'];

/**
 * Replaces any known secret value found in a string with a marker. Reads the values
 * from the environment once per call; a value not present in the environment cannot be
 * matched, which is correct — there is nothing to hide.
 */
export function redactSecrets(text: string, env: Readonly<Record<string, string | undefined>>): string {
  let result = text;
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined && value.length >= 8) {
      result = result.split(value).join(`«${name}»`);
    }
  }
  return result;
}

/* ------------------------------------------------------------------------- */
/* Git argv construction                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Builds the exact argv for a Git verb, or throws {@link HostClientError} with
 * `INVALID_ARGUMENT` if the parameters do not match the verb. This is the client-side
 * allowlist: the host holds the same one, and neither trusts the other. Kept pure and
 * exported so a self-test can assert that, for every verb, only its intended argv can be
 * produced and every other parameter shape is refused.
 */
export function gitArgv(verb: GitVerb, params: GitParams): readonly string[] {
  const wrong = (): never => {
    throw new HostClientError('INVALID_ARGUMENT', `git verb "${verb}" received the wrong parameters`);
  };
  // DEV-P0-09: an operand that begins with a dash would be read by Git as an option, and a path
  // containing `..` can traverse out of its zone. Both are refused here, on the client, so a malicious
  // operand never reaches the argv — independent of the host's own equivalent checks.
  const operand = (value: string, kind: string): string => {
    if (value.length === 0) throw new HostClientError('INVALID_ARGUMENT', `git ${kind} must not be empty`);
    if (value.startsWith('-')) {
      throw new HostClientError('INVALID_ARGUMENT', `git ${kind} "${value}" must not begin with a dash`);
    }
    return value;
  };
  const pathOperand = (value: string, kind: string): string => {
    operand(value, kind);
    if (/(^|[/\\])\.\.([/\\]|$)/.test(value)) {
      throw new HostClientError('INVALID_ARGUMENT', `git ${kind} "${value}" must not contain a path traversal`);
    }
    return value;
  };

  switch (verb) {
    case 'status':
      return params.of === 'none' ? ['status', '--porcelain=v1'] : wrong();
    case 'revParseHead':
      return params.of === 'none' ? ['rev-parse', 'HEAD'] : wrong();
    case 'revParseBranch':
      return params.of === 'none' ? ['rev-parse', '--abbrev-ref', 'HEAD'] : wrong();
    case 'hashObject':
      return params.of === 'path' ? ['hash-object', pathOperand(params.path, 'path')] : wrong();
    case 'clone':
      return params.of === 'clone'
        ? ['clone', '--no-checkout', pathOperand(params.source, 'clone source'), pathOperand(params.dest, 'clone destination')]
        : wrong();
    case 'fetch':
      return params.of === 'none' ? ['fetch', '--all', '--prune'] : wrong();
    case 'checkout':
      return params.of === 'ref' ? ['checkout', operand(params.ref, 'ref')] : wrong();
    case 'applyCheck':
      return params.of === 'path' ? ['apply', '--check', pathOperand(params.path, 'path')] : wrong();
    case 'apply':
      return params.of === 'path' ? ['apply', pathOperand(params.path, 'path')] : wrong();
    case 'addAll':
      return params.of === 'none' ? ['add', '-A'] : wrong();
    case 'commit':
      return params.of === 'commit' ? ['commit', '-m', params.message] : wrong();
    case 'mergeFfOnly':
      return params.of === 'ref' ? ['merge', '--ff-only', operand(params.ref, 'ref')] : wrong();
    case 'revert':
      return params.of === 'sha' ? ['revert', '--no-edit', params.sha] : wrong();
    default:
      return wrong();
  }
}

/**
 * Resolves the capability a Git call requires from its zone and verb. Landing verbs on
 * the canonical zone require the single write authority; read verbs on canonical require
 * the read authority; anything in the shadow zone is process execution there. A shadow-
 * zone landing verb is a contradiction and is refused before it can be sent.
 */
export function gitCapability(zone: GitArgs['zone'], verb: GitVerb): Capability {
  if (zone === 'canonical') {
    if (CANONICAL_LANDING_VERBS.has(verb)) {
      return 'git.land.canonical';
    }
    if (GIT_READ_VERBS.has(verb)) {
      return 'git.read.canonical';
    }
    throw new HostClientError(
      'INVALID_ARGUMENT',
      `git verb "${verb}" is not permitted on the canonical zone`,
    );
  }
  // Shadow zone: any allowed verb is process execution in the shadow tree.
  return 'process.run.shadow';
}

/** Maps a readable zone to its read capability for the `fs.*` commands. */
function fsReadCapability(zone: PathZone): Capability {
  switch (zone) {
    case 'canonical':
      return 'fs.read.canonical';
    case 'shadow':
      return 'fs.read.shadow';
    case 'workspace':
      return 'fs.read.workspace';
    case 'browserProfile':
      return 'fs.read.browserProfile';
    case 'external':
      throw new HostClientError('INVALID_ARGUMENT', 'fs commands may not target the external zone');
    default:
      throw new HostClientError('INVALID_ARGUMENT', `unknown zone "${String(zone)}"`);
  }
}

/* ------------------------------------------------------------------------- */
/* Response validation                                                        */
/* ------------------------------------------------------------------------- */

export interface ParsedResponse {
  readonly id: string;
  readonly rawLine: string;
  readonly ok: boolean;
  readonly result: unknown;
  readonly code: string | null;
  readonly message: string | null;
  /** The absolute path the host resolved the target to, when the command was path-bearing. */
  readonly resolvedPath: string | null;
  /** The zone the host resolved that path into, checked for parity with the client decision. */
  readonly zone: string | null;
  /** Exact Project Profile identity echoed by a project-bound host session. */
  readonly projectIdentity?: ProjectOperationIdentity;
}

/** The operating zones, as a schema, for validating a zone the host reports. */
const hostZoneSchema = z.enum(['canonical', 'shadow', 'workspace', 'browserProfile', 'external']);

interface ParsedEvent {
  readonly event: string;
  readonly level: string | null;
  readonly message: string | null;
}

export type ParsedLine =
  | { readonly of: 'response'; readonly response: ParsedResponse }
  | { readonly of: 'event'; readonly event: ParsedEvent }
  | { readonly of: 'malformed'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/*
 * The strict outer response envelope (DEV-P0-11). A host reply is one of exactly two shapes, keyed by
 * `ok`, and each rejects any field outside its shape and any contradictory field:
 *   - a success carries a `result` and never an error `code`/`message`;
 *   - a failure carries a non-empty `code` and never a `result`.
 * `resolvedPath`/`zone` are the host's resolution and may appear on either. Anything else — an unknown
 * key, `ok: true` with a `code`, `ok: false` with no `code`, `ok: false` with a `result` — fails to
 * parse and is reported as malformed, so a contradictory or padded reply never becomes evidence.
 */
const responseSuccessSchema = z
  .object({
    v: z.literal(HOST_PROTOCOL_VERSION),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
    resolvedPath: z.string().nullable().optional(),
    zone: z.string().nullable().optional(),
    projectIdentity: projectOperationIdentitySchema.optional(),
  })
  .strict();

const responseErrorSchema = z
  .object({
    v: z.literal(HOST_PROTOCOL_VERSION),
    id: z.string().min(1),
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().nullable().optional(),
    resolvedPath: z.string().nullable().optional(),
    zone: z.string().nullable().optional(),
    projectIdentity: projectOperationIdentitySchema.optional(),
  })
  .strict();

const hostResponseEnvelopeSchema = z.discriminatedUnion('ok', [responseSuccessSchema, responseErrorSchema]);

function toParsedResponse(line: string, parsed: z.infer<typeof hostResponseEnvelopeSchema>): ParsedResponse {
  const base = {
    rawLine: line,
    resolvedPath: parsed.resolvedPath ?? null,
    zone: parsed.zone ?? null,
    ...(parsed.projectIdentity === undefined ? {} : { projectIdentity: parsed.projectIdentity }),
  };
  if (parsed.ok) {
    return { id: parsed.id, ok: true, result: parsed.result, code: null, message: null, ...base };
  }
  return { id: parsed.id, ok: false, result: undefined, code: parsed.code, message: parsed.message ?? null, ...base };
}

/**
 * Parses one line off the host without a schema dependency. A response carries an `id`;
 * an unsolicited event carries an `event`; anything else is malformed and reported as
 * such rather than thrown, so one bad line never stops the reader.
 */
export function parseLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { of: 'malformed', reason: 'not JSON' };
  }
  if (!isRecord(value)) {
    return { of: 'malformed', reason: 'not an object' };
  }
  if (value['v'] !== HOST_PROTOCOL_VERSION) {
    return { of: 'malformed', reason: 'protocol mismatch' };
  }

  const id = value['id'];
  if (typeof id === 'string') {
    // Parse the whole reply through the strict envelope. Unknown keys and contradictory success/error
    // combinations fail here and are reported as malformed rather than becoming a trusted response.
    const parsed = hostResponseEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      return { of: 'malformed', reason: parsed.error.issues[0]?.message ?? 'invalid response envelope' };
    }
    return { of: 'response', response: toParsedResponse(line, parsed.data) };
  }

  const eventName = value['event'];
  if (typeof eventName === 'string') {
    return {
      of: 'event',
      event: {
        event: eventName,
        level: optionalString(value['level']),
        message: optionalString(value['message']),
      },
    };
  }

  return { of: 'malformed', reason: 'neither response nor event' };
}

/**
 * Verifies the host acted where the client authorised it to.
 *
 * For a path-bearing command the client classified a zone at authorisation time; the host resolves
 * the real path (following symlinks the client cannot) and reports the zone it landed in. A missing
 * resolution, an unparseable one, or one that disagrees with the client's zone is refused here —
 * before the reply becomes evidence — because a target that resolves somewhere the client did not
 * authorise is the exact shape of an escape. Commands with no target zone impose no parity.
 */
export function checkZoneParity(
  command: HostCommandName,
  decision: PolicyDecision,
  response: ParsedResponse,
  classifyZone?: (resolvedPath: string) => PathZone,
  expectedZone?: PathZone | null,
): HostClientError | null {
  // DEV-P0-11: normally the zone to enforce is the one the policy classified. Some commands carry a
  // path the policy does not zone (a browser-profile operation authorised by the un-zoned
  // browser.control capability), yet the host still resolves that path and must be held to the right
  // zone. An explicit expected zone covers exactly those, so profile-bearing operations get the same
  // parity as filesystem ones.
  const zoneToCheck = expectedZone ?? decision.zone;
  if (zoneToCheck === null) return null;

  if (response.resolvedPath === null || response.zone === null) {
    return new HostClientError(
      'ZONE_PARITY_MISMATCH',
      `host did not return a resolved path/zone for ${command}`,
    );
  }
  const zone = hostZoneSchema.safeParse(response.zone);
  const path = pathSchema.safeParse(response.resolvedPath);
  if (!zone.success || !path.success) {
    return new HostClientError(
      'MALFORMED_RESPONSE',
      `host returned an invalid resolved path/zone for ${command}`,
    );
  }
  if (zone.data !== zoneToCheck) {
    return new HostClientError(
      'ZONE_PARITY_MISMATCH',
      `host resolved ${command} into the ${zone.data} zone; ` +
        `the client authorised the ${zoneToCheck} zone`,
    );
  }

  // DEV-P0-09: the host's zone label is never trusted on its own. The client independently classifies
  // the host-returned resolved path against its own zone roots, and requires that classification to
  // agree with both the host's label and the required zone. A host that resolves into one zone but
  // labels it another — or names a zone for a path that falls outside it — is caught here.
  if (classifyZone !== undefined) {
    const clientZone = classifyZone(path.data);
    if (clientZone !== zone.data) {
      return new HostClientError(
        'ZONE_PARITY_MISMATCH',
        `the client classified the host's resolved path as ${clientZone}, but the host labelled it ${zone.data}`,
      );
    }
    if (clientZone !== zoneToCheck) {
      return new HostClientError(
        'ZONE_PARITY_MISMATCH',
        `the client classified the host's resolved path as ${clientZone}, but authorised the ${zoneToCheck} zone`,
      );
    }
  }

  // DEV-P0-11: the zone matching is not enough — the host must have resolved the target to the EXACT
  // path the client authorised. A different path inside the same zone (a symlink or junction pointing
  // elsewhere in the zone, or a host substituting one file for another) would otherwise be accepted as
  // evidence for the wrong file. Both sides are compared in the engine's normalised space.
  if (decision.resolvedTarget !== null && normaliseAbsolute(path.data) !== decision.resolvedTarget) {
    return new HostClientError(
      'PATH_PARITY_MISMATCH',
      `host resolved ${command} to ${path.data}; the client authorised ${decision.resolvedTarget}. ` +
        `Refusing a path substitution within the ${decision.zone} zone.`,
    );
  }
  return null;
}

/* Strict payload schemas for host replies not already shaped by shared/schemas.ts. Every hash is a
 * strict sha256, every count an integer, every git ref a hex object id, and every shape refuses
 * unknown keys — a host reply that drifts from the contract is rejected rather than half-read. */

/** A git object id (commit/tree/blob): lower-case hex, 7–64 chars, covering both SHA-1 and SHA-256. */
const gitObjectIdSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, 'not a git object id');

const hostBannerPayloadSchema = z
  .object({
    host: z.string().min(1),
    protocol: z.literal(HOST_PROTOCOL_VERSION),
    pwshVersion: z.string().min(1),
    os: z.string().min(1),
    roots: hostRootsSchema.optional(),
    projectIdentity: projectOperationIdentitySchema.optional(),
  })
  .strict();

const hostEnvironmentPayloadSchema = z
  .object({
    os: z.string().min(1),
    arch: z.string().min(1),
    pwshVersion: z.string().min(1),
    cpuCount: z.number().int().nonnegative(),
    totalMemBytes: z.number().int().nonnegative(),
  })
  .strict();

const hostShadowRefreshPayloadSchema = z.object({ head: gitObjectIdSchema }).strict();

/* ------------------------------------------------------------------------- */
/* Client                                                                     */
/* ------------------------------------------------------------------------- */

/** Per-command timeout ceilings. Builds are patient; a ping is not. */
const DEFAULT_TIMEOUTS_MS: Readonly<Record<HostCommandName, number>> = {
  'host.hello': 5_000,
  'env.host': 5_000,
  'shadow.refresh': 300_000,
  'shadow.run': 600_000,
  git: 120_000,
  'fs.hash': 30_000,
  'fs.stat': 10_000,
  'browser.launch': 60_000,
  'browser.status': 10_000,
  'browser.stop': 15_000,
} as const;

export interface HostClientConfig {
  /** The PowerShell executable, from `clue.config.yaml → powershell.executable`. */
  readonly executable: string;
  /** Path to the host script, e.g. `scripts/clue-host.ps1`. */
  readonly scriptPath: string;
  /** The policy engine that authorises every command before it is sent. */
  readonly policy: PolicyEngine;
  /** The actor this client acts as. The daemon drives experiments; the custodian lands. */
  readonly actor: Actor;
  /** A capability-token secret minted for {@link actor} by whoever built the client. */
  readonly tokenSecret: string;
  /**
   * DEV-P0-09 — the operation context this client acts under: the task/run subject, the purpose, and
   * the attempt the client's token was minted for. Carried into every `PolicyEngine.evaluate` call, so
   * a token bound to one subject/purpose/attempt is refused when used from a client built for another —
   * a token minted for task A cannot authorise a host call for task B. A client built per lease sets
   * these to the leased task's identity; omitting a field leaves that binding unimposed.
   */
  readonly operationSubjectId?: string | null;
  readonly operationPurpose?: string | null;
  readonly operationAttempt?: number | null;
  /**
   * Correlates each request with a durable audit execution id. Called once per command, before the
   * request is sent; the returned id becomes the wire correlation id, so the host reply and the
   * audit record share one identifier. When omitted, an in-process sequence id is used — adequate
   * for tests, but the daemon supplies an id drawn from the audit log so every request is traceable.
   */
  readonly auditExecutionId?: (
    command: HostCommandName,
    capability: Capability,
    target: string | null,
  ) => string;
  /** Optional source-faithful mirror of every JSON line sent to and received from the host. */
  readonly operationalConsole?: OperationalConsoleRecorder;
  /** Optional injected spawner for testing. Defaults to `node:child_process`. */
  readonly spawn?: HostSpawn;
  /**
   * The authoritative operating roots this client requires (DEV-P0-11). When set, `start()` sends them
   * in the hello and refuses the handshake unless the host echoes matching roots, so a misconfigured
   * host is caught before any command. Omitted, startup performs no root parity (legacy behaviour).
   */
  readonly hostRoots?: HostRoots;
  /** Exact Project Profile identity bound to every wire request and echoed by the host. */
  readonly projectIdentity?: ProjectOperationIdentity;
  /** Optional diagnostics sink. Receives already-redacted lines. Defaults to no-op. */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Optional environment for redaction. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface Pending {
  readonly command: HostCommandName;
  readonly exchange: OperationalConsoleExchange | null;
  readonly resolve: (response: ParsedResponse) => void;
  readonly reject: (error: HostClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class HostClient {
  private readonly config: HostClientConfig;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private process: HostProcess | null = null;
  private observer: WindowsHostObserver | null = null;
  private banner: HostBanner | null = null;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private crashed = false;
  private malformedLineCount = 0;

  public constructor(config: HostClientConfig) {
    this.config = config;
    this.env = config.env ?? process.env;
  }

  /** How many lines the host emitted that failed to parse. An instrument-health metric. */
  public get malformedLines(): number {
    return this.malformedLineCount;
  }

  /** The host banner captured at start, or null before {@link start} resolves. */
  public get hostBanner(): HostBanner | null {
    return this.banner;
  }

  private diag(level: 'info' | 'warn' | 'error', message: string): void {
    this.config.log?.(level, redactSecrets(message, this.env));
  }

  /**
   * Spawns the host and waits for its ready banner. Resolves with the banner or an error
   * result; it never throws for an expected failure, so start-up is on the same footing
   * as every other command.
   */
  public async start(): Promise<HostResult<HostBanner>> {
    if (this.process !== null) {
      return this.banner !== null
        ? ok(this.banner)
        : err(new HostClientError('NOT_STARTED', 'host is starting'));
    }

    let spawner: HostSpawn;
    try {
      spawner = this.config.spawn ?? (await defaultSpawn(this.config.executable, []));
    } catch (cause) {
      return err(
        new HostClientError('NO_SPAWNER', `could not obtain a host spawner: ${String(cause)}`),
      );
    }

    // DEV-P0-11 (§5.11): the host script declares mandatory -CanonicalRoot/-ShadowRoot/-WorkspaceRoot/
    // -BrowserProfileDir parameters and cannot start without them. When the client knows its authoritative
    // roots, it passes them here so a real host can actually be launched (and the startup hello then
    // re-verifies the host echoes matching roots). Omitted, the legacy bare invocation is kept.
    // DEV-P0-11/12: run pwsh with -ExecutionPolicy Bypass. The host script is an unsigned local file;
    // a default Windows machine policy (Restricted/RemoteSigned/AllSigned) refuses to load it and the
    // process exits before a single line runs — the host would be silent for a reason that has nothing
    // to do with its logic. Bypass affects only THIS invocation, not the machine policy. Harmless on
    // POSIX, where execution policy is Unrestricted.
    const args = ['-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.config.scriptPath];
    if (this.config.hostRoots !== undefined) {
      args.push(
        '-CanonicalRoot',
        this.config.hostRoots.canonical,
        '-ShadowRoot',
        this.config.hostRoots.shadow,
        '-WorkspaceRoot',
        this.config.hostRoots.workspace,
        '-BrowserProfileDir',
        this.config.hostRoots.browserProfile,
      );
    }
    if (this.config.projectIdentity !== undefined) {
      args.push(
        '-ProjectIdentityJson',
        JSON.stringify(canonicalProjectOperationIdentity(this.config.projectIdentity)),
      );
    }
    let proc: HostProcess;
    try {
      proc = spawner(this.config.executable, args);
    } catch (cause) {
      return err(new HostClientError('NO_SPAWNER', `spawn failed: ${String(cause)}`));
    }
    this.process = proc;
    this.crashed = false;
    if (this.config.spawn === undefined) {
      this.observer = openWindowsHostObserver();
      this.observer?.show('PowerShell host launched. Verifying the protocol and root bindings.');
    }

    proc.onLine((line) => this.handleLine(line));
    proc.onExit((code) => {
      if (this.process === proc) this.handleExit(code);
    });

    const helloArgs: HelloArgs = {
      kind: 'host.hello',
      ...(this.config.hostRoots !== undefined ? { roots: this.config.hostRoots } : {}),
    };
    const hello = await this.call<HostBanner>(helloArgs, (raw) => this.readBanner(raw));
    if (hello.ok) {
      this.banner = hello.value;
      this.diag('info', `host ready: ${hello.value.pwshVersion} on ${hello.value.os}`);
    }
    return hello;
  }

  /** Terminates the host and fails any request still in flight. */
  public stop(): void {
    const proc = this.process;
    this.process = null;
    if (proc !== null) {
      proc.kill();
      this.observer?.show('Host stop requested.');
    }
    this.failAllPending(new HostClientError('HOST_CRASHED', 'host stopped by client'));
    this.observer?.finish();
    this.observer = null;
  }

  /* --------------------------- typed commands --------------------------- */

  public ping(): Promise<HostResult<HostBanner>> {
    return this.call<HostBanner>({ kind: 'host.hello' }, (raw) => this.readBanner(raw));
  }

  public hostEnvironment(): Promise<HostResult<HostEnvironment>> {
    return this.call<HostEnvironment>({ kind: 'env.host' }, (raw) => this.readEnvironment(raw));
  }

  public refreshShadow(input: {
    canonicalRoot: string;
    shadowRoot: string;
    commit?: string | null;
  }): Promise<HostResult<ShadowRefreshResult>> {
    return this.call<ShadowRefreshResult>(
      {
        kind: 'shadow.refresh',
        canonicalRoot: input.canonicalRoot,
        shadowRoot: input.shadowRoot,
        commit: input.commit ?? null,
      },
      (raw) => this.readShadowRefresh(raw),
      // DEV-P0-11: the shadow clone IS the target of the operation. Without it the policy sees a null
      // target for fs.write.shadow and refuses the refresh outright; passing the shadow root lets it
      // classify the shadow zone and authorise the write there.
      { target: input.shadowRoot },
    );
  }

  public runShadowScript(input: {
    shadowRoot: string;
    script: ShadowScript;
    timeoutMs?: number;
  }): Promise<HostResult<ShadowRunResult>> {
    return this.call<ShadowRunResult>(
      {
        kind: 'shadow.run',
        shadowRoot: input.shadowRoot,
        script: input.script,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUTS_MS['shadow.run'],
      },
      (raw) => this.readShadowRun(input.script, raw),
      // DEV-P0-11: the shadow clone is where the script runs; pass it so process.run.shadow authorises
      // against the shadow zone rather than being refused for a null target.
      { target: input.shadowRoot },
    );
  }

  public git(input: {
    zone: GitArgs['zone'];
    root: string;
    verb: GitVerb;
    params: GitParams;
  }): Promise<HostResult<GitResult>> {
    // Validate the argv and resolve the capability before touching the wire; a bad verb
    // is an argument error the caller sees immediately, not a round trip to the host.
    let capabilityForCall: Capability;
    try {
      gitArgv(input.verb, input.params);
      capabilityForCall = gitCapability(input.zone, input.verb);
    } catch (cause) {
      return Promise.resolve(
        err<GitResult>(
          cause instanceof HostClientError
            ? cause
            : new HostClientError('INVALID_ARGUMENT', String(cause)),
        ),
      );
    }
    return this.call<GitResult>(
      { kind: 'git', zone: input.zone, root: input.root, verb: input.verb, params: input.params },
      (raw) => this.readGit(input.verb, raw),
      { capability: capabilityForCall, target: input.root },
    );
  }

  public hashFile(input: { zone: PathZone; path: string }): Promise<HostResult<FsHashResult>> {
    let capabilityForCall: Capability;
    try {
      capabilityForCall = fsReadCapability(input.zone);
    } catch (cause) {
      return Promise.resolve(
        err<FsHashResult>(
          cause instanceof HostClientError ? cause : new HostClientError('INVALID_ARGUMENT', String(cause)),
        ),
      );
    }
    return this.call<FsHashResult>(
      { kind: 'fs.hash', zone: input.zone, path: input.path },
      (raw) => this.readFsHash(raw),
      { capability: capabilityForCall, target: input.path },
    );
  }

  public statPath(input: { zone: PathZone; path: string }): Promise<HostResult<FsStatResult>> {
    let capabilityForCall: Capability;
    try {
      capabilityForCall = fsReadCapability(input.zone);
    } catch (cause) {
      return Promise.resolve(
        err<FsStatResult>(
          cause instanceof HostClientError ? cause : new HostClientError('INVALID_ARGUMENT', String(cause)),
        ),
      );
    }
    return this.call<FsStatResult>(
      { kind: 'fs.stat', zone: input.zone, path: input.path },
      (raw) => this.readFsStat(raw),
      { capability: capabilityForCall, target: input.path },
    );
  }

  public launchBrowser(input: {
    executable: string;
    profileDir: string;
    port: number;
    url: string;
    timeoutMs?: number;
  }): Promise<HostResult<BrowserLaunchResult>> {
    return this.call<BrowserLaunchResult>(
      {
        kind: 'browser.launch',
        executable: input.executable,
        profileDir: input.profileDir,
        port: input.port,
        url: input.url,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUTS_MS['browser.launch'],
      },
      (raw) => this.readBrowserLaunch(raw),
      // DEV-P0-11: browser.control is not a zoned capability, but the profile directory is a real path
      // the host resolves. Force browser-profile parity so a symlinked or escaped profile dir is caught
      // exactly as a filesystem operation would be.
      { target: input.profileDir, parityZone: 'browserProfile' },
    );
  }

  public browserStatus(input: { port: number }): Promise<HostResult<BrowserStatusResult>> {
    return this.call<BrowserStatusResult>(
      { kind: 'browser.status', port: input.port },
      (raw) => this.readBrowserStatus(raw),
    );
  }

  public stopBrowser(input: { profileDir: string }): Promise<HostResult<BrowserStopResult>> {
    return this.call<BrowserStopResult>(
      { kind: 'browser.stop', profileDir: input.profileDir },
      (raw) => this.readBrowserStop(raw),
      // DEV-P0-11: same profile-dir parity as launch.
      { target: input.profileDir, parityZone: 'browserProfile' },
    );
  }

  /* ------------------------------ internals ----------------------------- */

  /**
   * The one path every command takes: authorise, send, await a correlated reply within
   * the timeout, then decode. `decode` turns the host's untyped `result` into the typed
   * value; a decode failure is a malformed response, because a reply the client cannot
   * read is not a reply it can trust.
   */
  private async call<T>(
    args: CommandArgs,
    decode: (raw: unknown) => T,
    override?: { capability?: Capability; target?: string | null; parityZone?: PathZone | null },
  ): Promise<HostResult<T>> {
    const command = args.kind;
    const capability = override?.capability ?? STATIC_COMMAND_CAPABILITY[command];
    const target = override?.target ?? null;

    // DEV-P0-09 (§5.10): the operand the host would act on must reach the policy. A Git verb's ref
    // operand (when it takes one) is held to the landing prefix by the engine; a shadow run's script is
    // carried as its process argument. Everything else bears neither.
    const gitRef =
      args.kind === 'git'
        ? args.params.of === 'ref'
          ? args.params.ref
          : args.params.of === 'sha'
            ? args.params.sha
            : null
        : null;

    const decision = this.authorise(command, capability, target, {
      gitRef,
      ...(args.kind === 'shadow.run' ? { commandArgs: [args.script] } : {}),
    });
    if (decision.decision === 'denied') {
      return err(
        new HostClientError('POLICY_DENIED', decision.reason ?? 'denied', {
          policyCode: decision.code,
        }),
      );
    }

    if (this.crashed) {
      return err(new HostClientError('HOST_CRASHED', 'host has exited'));
    }
    const proc = this.process;
    if (proc === null) {
      return err(new HostClientError('NOT_STARTED', 'call before start'));
    }

    const id = this.config.auditExecutionId?.(command, capability, target) ?? this.nextId(command);
    const timeoutMs = DEFAULT_TIMEOUTS_MS[command];
    const wire = this.encode(id, command, args);
    const startedAt = Date.now();
    this.observer?.show(`SEND ${command}`);
    const exchange = this.config.operationalConsole?.beginExchange({
      channel: 'POWERSHELL',
      kind: 'command',
      title: `Host command · ${command}`,
      what: `Transmit the exact typed host request for ${command}.`,
      why: 'PowerShell and Git operations must remain visible, redacted, and auditable.',
      status: 'TRANSMITTING TO POWERSHELL HOST',
      nextAction: 'Await the correlated host response.',
      exactPayload: wire,
      payloadFormat: 'json',
      cinematicCue: 'transmit',
      physicalCallId: id,
      sourceIds: [`host-command:${command}`],
    }) ?? null;

    const replyPromise = new Promise<ParsedResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.observer?.show(`TIMEOUT ${command} after ${timeoutMs} ms`);
        exchange?.fail(new HostClientError('HOST_TIMEOUT', `${command} timed out after ${timeoutMs}ms`));
        reject(new HostClientError('HOST_TIMEOUT', `${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { command, exchange, resolve, reject, timer });
    });

    try {
      proc.writeLine(wire);
    } catch (cause) {
      this.observer?.show(`SEND FAILED ${command}`);
      const entry = this.pending.get(id);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
      }
      exchange?.fail(cause);
      return err(new HostClientError('HOST_CRASHED', `write failed: ${String(cause)}`));
    }

    let response: ParsedResponse;
    try {
      response = await replyPromise;
    } catch (error) {
      return err(error instanceof HostClientError ? error : new HostClientError('HOST_CRASHED', String(error)));
    }

    exchange?.receive({
      title: `Host response · ${command}`,
      what: `Receive the exact correlated host response for ${command}.`,
      why: 'A command being sent is not evidence that it completed or succeeded.',
      status: response.ok ? 'HOST RESPONSE RECEIVED' : 'HOST REPORTED FAILURE',
      nextAction: response.ok
        ? 'Decode and validate the typed response.'
        : 'Preserve the failure and decide whether the operation may be retried.',
      exactPayload: response.rawLine,
      payloadFormat: 'json',
      validationState: 'received',
      cinematicCue: response.ok ? 'receive' : 'error_fracture',
      physicalCallId: id,
      sourceIds: [`host-command:${command}`],
    });

    const responseIdentityError = this.checkProjectIdentityParity(response);
    if (responseIdentityError !== null) {
      this.observer?.show(`REJECTED ${command} · Project Profile identity mismatch`);
      exchange?.summarize({
        title: `Host response rejected · ${command}`,
        what: 'The host response belongs to a different Project Profile generation.',
        why: 'A stale or cross-project host response is not admissible operational state or evidence.',
        status: 'HOST PROJECT IDENTITY PARITY FAILED',
        nextAction: 'Restart the host under the active Project Profile and retry the command.',
        validationState: 'evidence_rejected',
        cinematicCue: 'error_fracture',
      });
      return err(responseIdentityError);
    }

    if (!response.ok) {
      this.observer?.show(`REJECTED ${command} · PowerShell host reported failure`);
      exchange?.summarize({
        title: `Host command rejected · ${command}`,
        what: 'The PowerShell host returned an explicit failure response.',
        why: 'A failed host operation cannot advance an experiment or patch lifecycle.',
        status: 'HOST OPERATION FAILED',
        nextAction: 'Inspect the redacted response and host audit record.',
        validationState: 'evidence_rejected',
        cinematicCue: 'error_fracture',
      });
      return err(
        new HostClientError('HOST_ERROR', response.message ?? 'host reported failure', {
          hostCode: response.code,
        }),
      );
    }

    try {
      const decoded = decode(response.result);
      const parityError = checkZoneParity(command, decision, response, (resolvedPath) =>
        this.config.policy.classify(resolvedPath),
        override?.parityZone,
      );
      if (parityError !== null) {
        this.observer?.show(`REJECTED ${command} · resolved path zone mismatch`);
        exchange?.summarize({
          title: `Host response rejected · ${command}`,
          what: 'The host reported acting in a zone the client did not authorise.',
          why: 'A zone the client did not authorise is a possible escape, not admissible evidence.',
          status: 'HOST ZONE PARITY FAILED',
          nextAction: 'Quarantine the response and inspect host path resolution.',
          validationState: 'evidence_rejected',
          cinematicCue: 'error_fracture',
        });
        return err(parityError);
      }
      exchange?.summarize({
        title: `Host command validated · ${command}`,
        what: 'The received host response matched the expected typed result and resolved zone.',
        why: 'Only validated responses may become CLU-E operational state or evidence.',
        status: 'HOST RESPONSE VALIDATED',
        nextAction: 'Continue with the operation-specific workflow.',
        validationState: 'schema_validated',
        cinematicCue: 'checkpoint',
      });
      const exitCode = typeof decoded === 'object' && decoded !== null && 'exitCode' in decoded
        && typeof decoded.exitCode === 'number' ? ` · process exit ${decoded.exitCode}` : '';
      this.observer?.show(`RECV ${command} · validated in ${Date.now() - startedAt} ms${exitCode}`);
      return ok(decoded);
    } catch (cause) {
      this.observer?.show(`REJECTED ${command} · response validation failed`);
      exchange?.summarize({
        title: `Host response invalid · ${command}`,
        what: 'The host replied, but the result did not match the expected schema.',
        why: 'Malformed instrumentation output is not admissible evidence.',
        status: 'HOST RESPONSE INVALID',
        nextAction: 'Quarantine the response and inspect host/client protocol drift.',
        validationState: 'evidence_rejected',
        cinematicCue: 'error_fracture',
      });
      return err(
        cause instanceof HostClientError
          ? cause
          : new HostClientError('MALFORMED_RESPONSE', `could not decode ${command} result: ${String(cause)}`),
      );
    }
  }

  private checkProjectIdentityParity(response: ParsedResponse): HostClientError | null {
    const expected = this.config.projectIdentity;
    if (expected === undefined) {
      return response.projectIdentity === undefined
        ? null
        : new HostClientError(
            'PROJECT_IDENTITY_MISMATCH',
            'the host returned a project-bound response to a legacy unbound client',
          );
    }
    if (response.projectIdentity === undefined) {
      return new HostClientError(
        'PROJECT_IDENTITY_MISMATCH',
        'the profile-bound host response omitted Project Profile identity',
      );
    }
    try {
      assertProjectOperationIdentity(expected, response.projectIdentity, 'PowerShell host response');
      return null;
    } catch (error) {
      return new HostClientError(
        'PROJECT_IDENTITY_MISMATCH',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private authorise(
    command: HostCommandName,
    capability: Capability,
    target: string | null,
    context?: { readonly gitRef?: string | null; readonly commandArgs?: readonly string[] },
  ): PolicyDecision {
    const request: PolicyRequest = {
      actor: this.config.actor,
      capability,
      command: `host:${command}`,
      target,
      tokenSecret: this.config.tokenSecret,
      // DEV-P0-09: bind the call to the operation the client's token was minted for. evaluate refuses a
      // token whose subject/purpose/attempt do not match, so a production host call can no longer omit
      // these bindings and a token cannot be replayed across tasks, runs, or attempts.
      subjectId: this.config.operationSubjectId ?? null,
      purpose: this.config.operationPurpose ?? null,
      attempt: this.config.operationAttempt ?? null,
      // DEV-P0-09 (§5.10): the operand the host would act on is part of what the policy authorises. A Git
      // verb carries its ref so the engine can refuse a ref outside the landing prefix HERE, before the
      // request reaches the host — the very case that previously slipped through to a host-state error. A
      // process carries its arguments for the shell-injection check. The client's own gitArgv/allowlist is
      // the first gate; passing the operand makes the engine the authority rather than an afterthought.
      ...(context?.gitRef !== undefined && context.gitRef !== null ? { gitRef: context.gitRef } : {}),
      ...(context?.commandArgs !== undefined ? { commandArgs: context.commandArgs } : {}),
    };
    return this.config.policy.evaluate(request);
  }

  private nextId(command: HostCommandName): string {
    this.sequence += 1;
    return `${command}#${String(this.sequence)}`;
  }

  private encode(id: string, command: HostCommandName, args: CommandArgs): string {
    // The `kind` discriminator is internal; the wire carries `command` + a plain args map.
    const { kind: _discard, ...rest } = args;
    void _discard;
    const payload = {
      v: HOST_PROTOCOL_VERSION,
      id,
      command,
      args: rest,
      ...(this.config.projectIdentity === undefined
        ? {}
        : { projectIdentity: canonicalProjectOperationIdentity(this.config.projectIdentity) }),
    };
    return JSON.stringify(payload);
  }

  private handleLine(line: string): void {
    const parsed = parseLine(line);
    switch (parsed.of) {
      case 'response': {
        const entry = this.pending.get(parsed.response.id);
        if (entry === undefined) {
          // A reply to a request that already timed out, or an unknown id. Recorded, dropped.
          this.diag('warn', `unmatched host reply id=${parsed.response.id}`);
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(parsed.response.id);
        entry.resolve(parsed.response);
        return;
      }
      case 'event': {
        const level = parsed.event.level === 'error' ? 'error' : parsed.event.level === 'warn' ? 'warn' : 'info';
        this.diag(level, `host event ${parsed.event.event}: ${parsed.event.message ?? ''}`);
        return;
      }
      case 'malformed': {
        this.malformedLineCount += 1;
        this.diag('warn', `malformed host line (${parsed.reason})`);
        return;
      }
      default:
        return;
    }
  }

  private handleExit(code: number | null): void {
    this.crashed = true;
    this.process = null;
    this.diag('error', `host exited with code ${code === null ? 'null' : String(code)}`);
    this.observer?.show(`PowerShell host process ended${code === null ? '' : ` · exit ${code}`}.`);
    this.failAllPending(new HostClientError('HOST_CRASHED', `host exited (code ${String(code)})`));
    this.observer?.finish();
    this.observer = null;
  }

  private failAllPending(error: HostClientError): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.exchange?.fail(error);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /* ------------------------------- decoders ----------------------------- */

  private readBanner(raw: unknown): HostBanner {
    const parsed = hostBannerPayloadSchema.parse(raw);

    // DEV-P0-11: root parity. If the client declared authoritative roots, the host must echo them and
    // every one must match (path-normalised). A host enforcing different roots than the client believes
    // is refused here, before the handshake completes and before any command is authorised.
    const expected = this.config.hostRoots;
    if (expected !== undefined) {
      if (parsed.roots === undefined) {
        throw new HostClientError('ROOT_PARITY_MISMATCH', 'the host did not echo the authoritative roots at startup');
      }
      for (const zone of ['canonical', 'shadow', 'workspace', 'browserProfile'] as const) {
        if (normaliseAbsolute(parsed.roots[zone]) !== normaliseAbsolute(expected[zone])) {
          throw new HostClientError(
            'ROOT_PARITY_MISMATCH',
            `the host's ${zone} root (${parsed.roots[zone]}) does not match the client's (${expected[zone]})`,
          );
        }
      }
    }

    const expectedProjectIdentity = this.config.projectIdentity;
    if (expectedProjectIdentity !== undefined) {
      if (parsed.projectIdentity === undefined) {
        throw new HostClientError(
          'PROJECT_IDENTITY_MISMATCH',
          'the host did not echo the Project Profile identity pinned by the client',
        );
      }
      try {
        assertProjectOperationIdentity(
          expectedProjectIdentity,
          parsed.projectIdentity,
          'PowerShell host handshake',
        );
      } catch (error) {
        throw new HostClientError(
          'PROJECT_IDENTITY_MISMATCH',
          error instanceof Error ? error.message : String(error),
        );
      }
    } else if (parsed.projectIdentity !== undefined) {
      throw new HostClientError(
        'PROJECT_IDENTITY_MISMATCH',
        'the host is project-bound but this client is running in the legacy unbound mode',
      );
    }

    return {
      host: parsed.host,
      protocol: parsed.protocol,
      pwshVersion: parsed.pwshVersion,
      os: parsed.os,
      ...(parsed.roots !== undefined ? { roots: parsed.roots } : {}),
      ...(parsed.projectIdentity !== undefined
        ? { projectIdentity: parsed.projectIdentity }
        : {}),
    };
  }

  private readEnvironment(raw: unknown): HostEnvironment {
    const parsed = hostEnvironmentPayloadSchema.parse(raw);
    // capturedAt is the client's record of when it read the environment, so it is a guaranteed-valid
    // timestamp set here rather than trusted from the host.
    return { ...parsed, capturedAt: nowIso() };
  }

  private readShadowRefresh(raw: unknown): ShadowRefreshResult {
    const parsed = hostShadowRefreshPayloadSchema.parse(raw);
    return { head: parsed.head, refreshedAt: nowIso() };
  }

  private readShadowRun(script: ShadowScript, raw: unknown): ShadowRunResult {
    const parsed = shadowRunResultSchema.parse(raw);
    if (parsed.script !== script) {
      throw new Error(`host echoed script "${parsed.script}", client sent "${script}"`);
    }
    return {
      script,
      exitCode: parsed.exitCode,
      durationMs: parsed.durationMs,
      stdoutSha256: parsed.stdoutSha256,
      stderrSha256: parsed.stderrSha256,
      stdoutPath: parsed.stdoutPath,
      stderrPath: parsed.stderrPath,
    };
  }

  private readGit(verb: GitVerb, raw: unknown): GitResult {
    const parsed = gitResultSchema.parse(raw);
    if (parsed.verb !== verb) {
      throw new Error(`host echoed verb "${parsed.verb}", client sent "${verb}"`);
    }
    return { verb, exitCode: parsed.exitCode, durationMs: parsed.durationMs, stdout: parsed.stdout.trim() };
  }

  private readFsHash(raw: unknown): FsHashResult {
    return fsHashResultSchema.parse(raw);
  }

  private readFsStat(raw: unknown): FsStatResult {
    return fsStatResultSchema.parse(raw);
  }

  private readBrowserLaunch(raw: unknown): BrowserLaunchResult {
    return browserLaunchResultSchema.parse(raw);
  }

  private readBrowserStatus(raw: unknown): BrowserStatusResult {
    return browserStatusResultSchema.parse(raw);
  }

  private readBrowserStop(raw: unknown): BrowserStopResult {
    return browserStopResultSchema.parse(raw);
  }
}

/* ------------------------------------------------------------------------- */
/* Pure helpers exported for self-tests                                       */
/* ------------------------------------------------------------------------- */

/**
 * The capability a command floors at, for a self-test that asserts the table stays in
 * step with the registry — every command name has an entry and no entry is orphaned.
 */
export function staticCapabilityFor(command: HostCommandName): Capability {
  return STATIC_COMMAND_CAPABILITY[command];
}

/** Content hash of a request line, for deduplicating identical host calls in a run log. */
export function requestSignature(command: HostCommandName, argsJson: string): Sha256 {
  return hashText(`${command}\u0000${argsJson}`);
}
