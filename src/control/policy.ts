/**
 * CLUE policy engine.
 *
 * Architecture: CLUE_Architecture_v8.md (restricted command host, capability tokens, trust classes).
 * Constitution: CLUE_Constitution_v8.md (deny by default; amendment A2 Custodian write authority).
 * Interface: CLUE_Interface_Design_v10.md (host request/response; host-confirmed path resolution).
 * Backlog: DEV-P0-09 — tokens bind subject/purpose/attempt; partial grants refused; explicit
 *          host-zone, command-argument, and Git-ref constraints.
 *
 * Deny by default. Every command that touches the filesystem, a process, a browser, or
 * a model passes through `evaluate` first, and a request that does not match an
 * explicit rule is refused rather than interpreted generously.
 *
 * The engine is deliberately pure: no filesystem access, no clock beyond token expiry,
 * no logging. It takes a request and returns a decision. That makes every boundary rule
 * testable in isolation, which is the only way the Stage A gate can prove the denials
 * hold rather than merely assert it. Because it cannot resolve symlinks itself, a path
 * action can be required to carry the zone the HOST resolved the real path to, and a
 * disagreement between that and the engine's own classification is refused as a possible
 * escape rather than trusted.
 *
 * A token is not a bearer key to the whole of an actor's authority. It is minted for one
 * subject (a task or run), optionally one purpose and one attempt, and the exact set of
 * capabilities requested — never a silently narrowed subset. A request that presents a
 * token for a different subject, purpose, or attempt is refused, so a token minted for one
 * piece of work cannot be replayed against another.
 *
 * The most important rule in this file, and the reason amendment A2 remains safe:
 *
 *   NO capability grants filesystem writes inside the canonical Murugan tree.
 *   Not the Custodian's. Not the Creator's token. Not in maintenance mode.
 *
 * The Custodian's authority is over a *Git operation* (`git.land.canonical`), never
 * over the filesystem. Murugan's working tree can therefore only ever change through
 * a Git command that is itself recorded, hash-bound, and revertible. A component that
 * wanted to quietly rewrite a source file has no path to doing so, whatever token it
 * holds.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolveAbsolute } from 'node:path';

import type { Actor, ClueConfig } from '../shared/schemas.js';

/* ------------------------------------------------------------------------- */
/* Capabilities and zones                                                     */
/* ------------------------------------------------------------------------- */

export const CAPABILITIES = [
  'fs.read.canonical',
  'fs.read.shadow',
  'fs.write.shadow',
  'fs.read.workspace',
  'fs.write.workspace',
  'fs.read.browserProfile',
  'fs.write.browserProfile',
  'git.read.canonical',
  /** Amendment A2: the single write authority, and it is a Git operation, not a write. */
  'git.land.canonical',
  'git.push.accepted',
  'process.run.shadow',
  'process.run.host',
  'browser.control',
  'model.call',
  /** Present so that it can be permanently refused rather than silently absent. */
  'settlement.real',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type PathZone = 'canonical' | 'shadow' | 'workspace' | 'browserProfile' | 'external';

/** Which zone a path-bearing capability is allowed to touch. */
const CAPABILITY_ZONE: Partial<Record<Capability, PathZone>> = {
  'fs.read.canonical': 'canonical',
  'fs.read.shadow': 'shadow',
  'fs.write.shadow': 'shadow',
  'fs.read.workspace': 'workspace',
  'fs.write.workspace': 'workspace',
  'fs.read.browserProfile': 'browserProfile',
  'fs.write.browserProfile': 'browserProfile',
  'git.read.canonical': 'canonical',
  'git.land.canonical': 'canonical',
  'git.push.accepted': 'canonical',
  'process.run.shadow': 'shadow',
};

/** Capabilities that mutate the filesystem. Used by the canonical-write hard rule. */
const WRITE_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'fs.write.shadow',
  'fs.write.workspace',
  'fs.write.browserProfile',
]);

/** Every Git capability. Any Git operation's ref is safety-checked, independent of read vs land. */
const GIT_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'git.read.canonical',
  'git.land.canonical',
  'git.push.accepted',
]);

/**
 * Default grants. A starting policy, not a ceiling: the daemon issues narrower tokens
 * per task, and nothing here grants a capability an actor has no business holding.
 */
export const DEFAULT_GRANTS: Readonly<Record<Actor, readonly Capability[]>> = {
  creator: [
    'fs.read.canonical',
    'fs.read.shadow',
    'fs.read.workspace',
    'fs.write.workspace',
    'git.read.canonical',
    'process.run.host',
  ],
  daemon: [
    'fs.read.canonical',
    'fs.read.shadow',
    'fs.write.shadow',
    'fs.read.workspace',
    'fs.write.workspace',
    'git.read.canonical',
    'process.run.shadow',
    'process.run.host',
  ],
  worker: ['fs.read.workspace', 'fs.write.workspace'],
  custodian: [
    'fs.read.canonical',
    'fs.read.shadow',
    'fs.write.shadow',
    'fs.read.workspace',
    'fs.write.workspace',
    'git.read.canonical',
    'git.land.canonical',
    'git.push.accepted',
    'process.run.shadow',
  ],
  gateway: ['fs.read.workspace', 'fs.write.workspace', 'model.call'],
  cli: ['fs.read.canonical', 'fs.read.shadow', 'fs.read.workspace', 'git.read.canonical'],
};

/* ------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* ------------------------------------------------------------------------- */

export interface CapabilityToken {
  readonly id: string;
  readonly secret: string;
  readonly actor: Actor;
  readonly capabilities: readonly Capability[];
  readonly issuedAt: number;
  readonly expiresAt: number | null;
  /** Task, experiment, or run this token was minted for; null for long-lived tokens. */
  readonly subjectId: string | null;
  /** Operation class this token authorises (e.g. a lane or command family); null if unbound. */
  readonly purpose: string | null;
  /** Attempt number this token belongs to, tying it to one task lease; null if unbound. */
  readonly attempt: number | null;
}

interface TokenRecord {
  readonly token: CapabilityToken;
  readonly capabilitySet: ReadonlySet<Capability>;
}

/** Raised when a token cannot be issued as requested — never a silent narrowing. */
export class PolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/* ------------------------------------------------------------------------- */
/* Requests and decisions                                                     */
/* ------------------------------------------------------------------------- */

export interface PolicyRequest {
  readonly actor: Actor;
  readonly capability: Capability;
  /** Command name for the audit trail, e.g. "git.merge" or "fs.writeFile". */
  readonly command: string;
  /** Absolute path or resource identifier, when the capability is path-bearing. */
  readonly target?: string | null;
  readonly tokenSecret?: string | null;
  /** Subject the operation is for; must match a subject-bound token. */
  readonly subjectId?: string | null;
  /** Purpose the operation is for; must match a purpose-bound token. */
  readonly purpose?: string | null;
  /** Attempt the operation is for; must match an attempt-bound token. */
  readonly attempt?: number | null;
  /**
   * The zone the host resolved the real target to (after following symlinks). When present it
   * must agree with the engine's own classification; when the engine is configured to require
   * it, a path action without it is refused.
   */
  readonly hostZone?: PathZone | null;
  /** Arguments for a process capability, constrained against shell-injection metacharacters. */
  readonly commandArgs?: readonly string[];
  /** Git ref for a Git capability, constrained to a safe ref within the landing branch prefix. */
  readonly gitRef?: string | null;
}

export type DenialCode =
  | 'UNKNOWN_CAPABILITY'
  | 'NO_TOKEN'
  | 'TOKEN_UNKNOWN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ACTOR_MISMATCH'
  | 'TOKEN_SUBJECT_MISMATCH'
  | 'TOKEN_PURPOSE_MISMATCH'
  | 'TOKEN_ATTEMPT_MISMATCH'
  | 'CAPABILITY_NOT_GRANTED'
  | 'TARGET_REQUIRED'
  | 'ZONE_MISMATCH'
  | 'OUTSIDE_ALL_ZONES'
  | 'HOST_ZONE_REQUIRED'
  | 'HOST_ZONE_MISMATCH'
  | 'COMMAND_ARG_FORBIDDEN'
  | 'GIT_REF_FORBIDDEN'
  | 'CANONICAL_WRITE_FORBIDDEN'
  | 'LANDING_NOT_AUTHORISED'
  | 'LANDING_WRONG_ACTOR'
  | 'PERMANENTLY_DENIED';

export interface PolicyDecision {
  readonly decision: 'allowed' | 'denied';
  readonly code: DenialCode | null;
  readonly reason: string | null;
  readonly zone: PathZone | null;
  readonly resolvedTarget: string | null;
}

/* ------------------------------------------------------------------------- */
/* Policy engine                                                              */
/* ------------------------------------------------------------------------- */

export class PolicyEngine {
  private readonly zones: ReadonlyArray<{ zone: PathZone; prefix: string }>;
  private readonly canonicalWrites: 'denied' | 'custodian_only';
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly secrets: SecretRegistry;
  private readonly requireHostZone: boolean;
  private readonly landingBranchPrefix: string;

  public constructor(
    config: ClueConfig,
    secrets: SecretRegistry = new SecretRegistry(),
    options: { requireHostConfirmedZone?: boolean } = {},
  ) {
    this.canonicalWrites = config.security.canonical_source_writes;
    this.secrets = secrets;
    this.requireHostZone = options.requireHostConfirmedZone ?? false;
    this.landingBranchPrefix = config.patching.landing_branch_prefix;

    // Longest prefix first, so a nested root is classified as itself rather than its
    // parent. The config schema already forbids the shadow tree living inside the
    // canonical tree, but ordering here keeps the engine correct regardless.
    this.zones = [
      { zone: 'canonical' as const, prefix: resolvePhysicalPath(config.project.root) },
      { zone: 'shadow' as const, prefix: resolvePhysicalPath(config.shadow.root) },
      { zone: 'workspace' as const, prefix: resolvePhysicalPath(config.workspace.root) },
      { zone: 'browserProfile' as const, prefix: resolvePhysicalPath(config.browser.profile_dir) },
    ].sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /* ------------------------------ tokens ------------------------------ */

  /**
   * Mints a token for exactly the capabilities requested, or refuses.
   *
   * A request for any capability the actor is not granted is rejected whole — never issued as a
   * silently narrowed subset. Silent narrowing is the failure that hands a caller a token it
   * believes is more capable than it is, so the caller proceeds and the operation fails far from
   * the mistake. The token may be bound to a subject, a purpose, and an attempt; a bound token
   * is refused for any other subject, purpose, or attempt at evaluation time.
   */
  public issueToken(
    actor: Actor,
    capabilities: readonly Capability[],
    options: {
      ttlMs?: number;
      subjectId?: string | null;
      purpose?: string | null;
      attempt?: number | null;
    } = {},
  ): CapabilityToken {
    const granted = DEFAULT_GRANTS[actor];
    const requested = [...new Set(capabilities)];
    const ungranted = requested.filter((capability) => !granted.includes(capability));
    if (ungranted.length > 0) {
      throw new PolicyError(
        `Actor "${actor}" cannot be granted ${ungranted.join(', ')}; ` +
          'a partially grantable token is refused rather than silently narrowed',
      );
    }

    const issuedAt = Date.now();
    const token: CapabilityToken = {
      id: `TOKEN-${randomBytes(8).toString('hex')}`,
      secret: randomBytes(24).toString('hex'),
      actor,
      capabilities: requested,
      issuedAt,
      expiresAt: options.ttlMs === undefined ? null : issuedAt + options.ttlMs,
      subjectId: options.subjectId ?? null,
      purpose: options.purpose ?? null,
      attempt: options.attempt ?? null,
    };

    this.tokens.set(token.secret, { token, capabilitySet: new Set(requested) });
    return token;
  }

  public revokeToken(secret: string): boolean {
    return this.tokens.delete(secret);
  }

  public revokeAll(): void {
    this.tokens.clear();
  }

  /* ----------------------------- evaluation --------------------------- */

  /**
   * The single decision point. Rules are applied in a fixed order, and the order
   * matters: the unconditional rules run before token checks, so no token can ever be
   * the reason a forbidden operation succeeds.
   */
  public evaluate(request: PolicyRequest): PolicyDecision {
    const { capability } = request;

    if (!isCapability(capability)) {
      return deny('UNKNOWN_CAPABILITY', `Unknown capability "${String(capability)}"`);
    }

    // Rule 0 — permanent refusals, checked before anything else.
    if (capability === 'settlement.real') {
      return deny(
        'PERMANENTLY_DENIED',
        'Real settlement is refused by the constitution; tests are mock-only',
      );
    }

    // Rule 1 — path resolution, for capabilities that carry a target.
    const expectedZone = CAPABILITY_ZONE[capability];
    let zone: PathZone | null = null;
    let resolved: string | null = null;

    if (expectedZone !== undefined) {
      const target = request.target ?? null;
      if (target === null || target.length === 0) {
        return deny('TARGET_REQUIRED', `Capability ${capability} requires a target path`);
      }
      // DEV-P0-08: resolve the target physically (following symlinks/junctions on the engine's own
      // filesystem) before classifying it, so a link out of or into a zone is judged by where it lands,
      // not by its spelling. Where the engine cannot follow a link the host can (a different machine),
      // the host-confirmed zone below is still required and cross-checked.
      resolved = resolvePhysicalPath(target);
      zone = this.classify(resolved);

      // The engine cannot follow symlinks, so a path action can be required to carry the zone
      // the host resolved the real target to. A disagreement between the two is refused as a
      // possible escape rather than trusted — a symlink pointing out of (or into) a zone would
      // otherwise be judged by its spelling, not by where it actually lands.
      const hostZone = request.hostZone ?? null;
      if (this.requireHostZone && hostZone === null) {
        return deny(
          'HOST_ZONE_REQUIRED',
          `Capability ${capability} requires a host-confirmed resolved zone`,
          zone,
          resolved,
        );
      }
      if (hostZone !== null && hostZone !== zone) {
        return deny(
          'HOST_ZONE_MISMATCH',
          `Host resolved the target to the ${hostZone} zone; the engine classified it as ` +
            `${zone}. Refusing a possible symlink escape.`,
          zone,
          resolved,
        );
      }

      if (zone === 'external') {
        return deny(
          'OUTSIDE_ALL_ZONES',
          `Target lies outside every configured root: ${resolved}`,
          null,
          resolved,
        );
      }
      if (zone !== expectedZone) {
        return deny(
          'ZONE_MISMATCH',
          `Capability ${capability} may not act on the ${zone} zone`,
          zone,
          resolved,
        );
      }
    }

    // Rule 1b — process capabilities: reject any command argument that could break out of the
    // argument vector into a shell. Enforced when arguments are supplied, so a host that passes
    // them has them checked here before the process is ever spawned.
    if (capability === 'process.run.shadow' || capability === 'process.run.host') {
      const offending = unsafeCommandArg(request.commandArgs);
      if (offending !== null) {
        return deny(
          'COMMAND_ARG_FORBIDDEN',
          `Command argument rejected as unsafe: ${offending}`,
          zone,
          resolved,
        );
      }
    }

    // Rule 2 — the canonical tree is never filesystem-writable. Unconditional: this
    // check precedes token validation precisely so that no token can override it.
    if (WRITE_CAPABILITIES.has(capability) && zone === 'canonical') {
      return deny(
        'CANONICAL_WRITE_FORBIDDEN',
        'No capability permits filesystem writes inside the canonical Murugan tree',
        zone,
        resolved,
      );
    }

    // Rule 3 — every Git operation's ref must be a safe, well-formed ref, whichever Git capability it
    // is (DEV-P0-09). A read (fetch) ref is not constrained to the landing prefix, but it must never be
    // a traversal, a pattern, or a leading-dash option a Git command would misread — so a malicious ref
    // is refused by the client's own policy, not left for the host to catch.
    if (GIT_CAPABILITIES.has(capability)) {
      const refError = unsafeGitRefSyntax(request.gitRef);
      if (refError !== null) {
        return deny('GIT_REF_FORBIDDEN', refError, zone, resolved);
      }
    }

    // Rule 4 — landing is the one authorised mutation of the canonical tree, it is a
    // Git operation, and only the Custodian may request it.
    if (capability === 'git.land.canonical') {
      if (this.canonicalWrites !== 'custodian_only') {
        return deny(
          'LANDING_NOT_AUTHORISED',
          'security.canonical_source_writes is "denied"; landing requires "custodian_only"',
          zone,
          resolved,
        );
      }
      if (request.actor !== 'custodian') {
        return deny(
          'LANDING_WRONG_ACTOR',
          `Only the custodian may land patches; actor was "${request.actor}"`,
          zone,
          resolved,
        );
      }
      // The landing ref, when supplied, must be a safe Git ref inside the configured landing
      // branch prefix, so a land can never be aimed at `main` or an arbitrary ref.
      const refError = unsafeGitRef(request.gitRef, this.landingBranchPrefix);
      if (refError !== null) {
        return deny('GIT_REF_FORBIDDEN', refError, zone, resolved);
      }
    }

    // Publication is a distinct Custodian operation on one accepted branch.
    if (capability === 'git.push.accepted') {
      if (request.actor !== 'custodian') return deny('LANDING_WRONG_ACTOR', 'Publication requires the Custodian', zone, resolved);
      const refError = unsafeGitRef(request.gitRef, this.landingBranchPrefix);
      if (request.gitRef == null || request.gitRef.length <= this.landingBranchPrefix.length || refError !== null) {
        return deny('GIT_REF_FORBIDDEN', refError ?? 'Publication requires one exact accepted branch', zone, resolved);
      }
    }

    // Rule 5 — token validation.
    const secret = request.tokenSecret ?? null;
    if (secret === null) {
      return deny('NO_TOKEN', `Capability ${capability} requires a token`, zone, resolved);
    }

    const record = this.tokens.get(secret);
    if (record === undefined) {
      return deny('TOKEN_UNKNOWN', 'Token is not recognised', zone, resolved);
    }
    if (record.token.expiresAt !== null && Date.now() > record.token.expiresAt) {
      this.tokens.delete(secret);
      return deny('TOKEN_EXPIRED', 'Token has expired', zone, resolved);
    }
    if (record.token.actor !== request.actor) {
      return deny(
        'TOKEN_ACTOR_MISMATCH',
        `Token belongs to "${record.token.actor}", request came from "${request.actor}"`,
        zone,
        resolved,
      );
    }

    // A bound token is refused for any other subject, purpose, or attempt, so a token minted for
    // one piece of work cannot be replayed against another. Unbound fields (null) impose nothing.
    if (record.token.subjectId !== null && (request.subjectId ?? null) !== record.token.subjectId) {
      return deny(
        'TOKEN_SUBJECT_MISMATCH',
        `Token is bound to subject ${record.token.subjectId}; request was for ` +
          `${request.subjectId ?? 'no subject'}`,
        zone,
        resolved,
      );
    }
    if (record.token.purpose !== null && (request.purpose ?? null) !== record.token.purpose) {
      return deny(
        'TOKEN_PURPOSE_MISMATCH',
        `Token is bound to purpose ${record.token.purpose}; request was for ` +
          `${request.purpose ?? 'no purpose'}`,
        zone,
        resolved,
      );
    }
    if (record.token.attempt !== null && (request.attempt ?? null) !== record.token.attempt) {
      return deny(
        'TOKEN_ATTEMPT_MISMATCH',
        `Token is bound to attempt ${String(record.token.attempt)}; request was for ` +
          `${request.attempt === undefined || request.attempt === null ? 'no attempt' : String(request.attempt)}`,
        zone,
        resolved,
      );
    }
    if (!record.capabilitySet.has(capability)) {
      return deny(
        'CAPABILITY_NOT_GRANTED',
        `Token does not grant ${capability}`,
        zone,
        resolved,
      );
    }

    return { decision: 'allowed', code: null, reason: null, zone, resolvedTarget: resolved };
  }

  /** Which configured root a resolved path belongs to. */
  public classify(resolvedPath: string): PathZone {
    for (const { zone, prefix } of this.zones) {
      if (resolvedPath === prefix || resolvedPath.startsWith(`${prefix}/`)) return zone;
    }
    return 'external';
  }

  /** Whether landing is enabled at all, for `clue doctor` and status reporting. */
  public get landingAuthorised(): boolean {
    return this.canonicalWrites === 'custodian_only';
  }

  public get secretRegistry(): SecretRegistry {
    return this.secrets;
  }
}

function deny(
  code: DenialCode,
  reason: string,
  zone: PathZone | null = null,
  resolvedTarget: string | null = null,
): PolicyDecision {
  return { decision: 'denied', code, reason, zone, resolvedTarget };
}

function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** Characters that would let a command argument break out of the argument vector into a shell. */
const SHELL_METACHARACTERS = /[;|&`$><\n\r\0()]/;

/**
 * The first command argument that is unsafe, or null if every argument is safe (or none given).
 *
 * The host runs commands as an argument vector, but an argument carrying shell metacharacters is
 * refused regardless: it is the shape of an injection, and a boundary that only holds when the
 * far side happens not to use a shell is not a boundary.
 */
function unsafeCommandArg(args: readonly string[] | undefined): string | null {
  if (args === undefined) return null;
  for (const arg of args) {
    if (SHELL_METACHARACTERS.test(arg)) return arg;
  }
  return null;
}

/** Git ref characters and sequences that are unsafe or ambiguous, per git-check-ref-format. */
const UNSAFE_GIT_REF = /(\.\.|[~^:?*[\\\s\0]|@\{|^-|\.lock$|\/$|^\/)/;

/**
 * An error describing why a Git ref is not a well-formed, safe ref, or null if it is (or none given).
 * Independent of any branch prefix: this catches traversal, ref-log/pattern syntax, a leading dash a
 * Git command would read as an option, and other injection shapes. Applied to every Git operation.
 */
function unsafeGitRefSyntax(ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  if (ref.length === 0) return 'Git ref must not be empty';
  if (UNSAFE_GIT_REF.test(ref)) return `Git ref "${ref}" is not a well-formed, safe ref`;
  return null;
}

/**
 * An error describing why a Git landing ref is unsafe, or null if it is safe (or none given).
 *
 * A land can only ever be aimed at a ref inside the configured landing branch prefix, and the ref
 * itself must be a well-formed Git ref. Validated only when a ref is supplied; a caller that omits it
 * is checked by the flow that requires it, not here.
 */
function unsafeGitRef(ref: string | null | undefined, landingBranchPrefix: string): string | null {
  const syntax = unsafeGitRefSyntax(ref);
  if (syntax !== null) return syntax;
  if (ref !== null && ref !== undefined && !ref.startsWith(landingBranchPrefix)) {
    return `Git ref "${ref}" is outside the landing branch prefix "${landingBranchPrefix}"`;
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Secret redaction (spec §95)                                                */
/* ------------------------------------------------------------------------- */

/**
 * Holds the secret VALUES that must never appear in any artifact, prompt, commit
 * message, report, or audit entry. Values are loaded from the environment by name and
 * are never written anywhere by CLUE itself.
 */
export class SecretRegistry {
  private readonly values = new Map<string, string>();

  /** Registers the value of an environment variable, if it is set and non-trivial. */
  public registerFromEnv(name: string): boolean {
    const value = process.env[name];
    if (value === undefined || value.trim().length < 8) return false;
    this.values.set(name, value.trim());
    return true;
  }

  /** Loads every secret this installation is configured to use. */
  public loadFromConfig(config: ClueConfig): void {
    this.registerFromEnv(config.gateway.api_key_env);
    const webhook = config.notifications.webhook_url_env;
    if (webhook !== null) this.registerFromEnv(webhook);
  }

  public get size(): number {
    return this.values.size;
  }

  /**
   * Replaces registered secrets, then anything shaped like a credential.
   *
   * The registry catches the keys CLUE knows about; the patterns catch keys that
   * arrived from somewhere unexpected — a pasted snippet, a tool's error message, a
   * captured environment dump. Both matter, because the leak that hurts is the one
   * from the source nobody enumerated.
   */
  public redact(text: string): string {
    let output = text;
    for (const [name, value] of this.values) {
      if (value.length === 0) continue;
      output = output.split(value).join(`«REDACTED:${name}»`);
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      output = output.replace(pattern, '«REDACTED:PATTERN»');
    }
    return output;
  }

  /** True when any registered secret appears verbatim in the text. */
  public containsSecret(text: string): boolean {
    for (const value of this.values.values()) {
      if (value.length > 0 && text.includes(value)) return true;
    }
    return false;
  }

  /**
   * Throws if a registered secret is present. Used at the boundaries where redaction
   * is not good enough and the write must simply not happen: context packs, commit
   * messages, patch bundles, and anything pushed to a remote.
   */
  public assertClean(text: string, context: string): void {
    if (this.containsSecret(text)) {
      throw new Error(`Refusing to write ${context}: it contains a registered secret value`);
    }
  }

  /** Redacts an environment fingerprint before it is stored as evidence. */
  public redactEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      output[key] = SENSITIVE_ENV_KEY.test(key) ? '«REDACTED»' : this.redact(value);
    }
    return output;
  }
}

const SENSITIVE_ENV_KEY = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i;

/**
 * Shapes that are almost never legitimate content in CLUE evidence. Kept deliberately
 * narrow: a pattern that fires on ordinary text would teach operators to ignore
 * redaction markers, which is worse than the leak it was meant to prevent.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g,
];

/* ------------------------------------------------------------------------- */
/* Lexical path resolution                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Resolves a path lexically: forward slashes, collapsed separators, `.` and `..`
 * segments removed, lowercased for comparison.
 *
 * Lexical rather than filesystem-based on purpose. The engine must be pure and
 * deterministic so its rules can be tested without a Murugan checkout present, and it
 * must give the same answer on a developer machine as on the Creator's Windows host.
 *
 * Known limitation, mitigated elsewhere: lexical resolution cannot see through a
 * junction or symlink that points from an allowed zone into the canonical tree. The
 * PowerShell host performs a real-path check at execution time as the second layer;
 * neither layer is sufficient alone, which is why both exist.
 */
export function normaliseAbsolute(input: string): string {
  const forward = input.replace(/\\/g, '/');

  const driveMatch = /^([A-Za-z]):\/?/.exec(forward);
  const prefix = driveMatch === null ? (forward.startsWith('/') ? '/' : '') : `${driveMatch[1]}:/`;
  const body = driveMatch === null ? forward.replace(/^\//, '') : forward.slice(driveMatch[0].length);

  const segments: string[] = [];
  for (const segment of body.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `${prefix}${segments.join('/')}`.replace(/\/$/, '').toLowerCase();
}

/**
 * The first source root that physically resolves outside the project tree, or null if all are inside
 * (DEV-P0-08). Source roots are configured relative to the project, but a `..` segment or a symlink
 * could point the scanner at files outside the target program — recognising, snapshotting, and
 * eventually patching them. Each root is resolved physically (following links) and required to sit at
 * or beneath the project's own real path; anything else is refused before it is ever scanned.
 */
export function sourceRootOutsideProject(projectRoot: string, sourceRoots: readonly string[]): string | null {
  const projectReal = resolvePhysicalPath(projectRoot);
  const prefix = `${projectReal}/`;
  for (const sourceRoot of sourceRoots) {
    const absolute = isAbsolute(sourceRoot) ? sourceRoot : join(projectRoot, sourceRoot);
    const real = resolvePhysicalPath(absolute);
    if (real !== projectReal && !real.startsWith(prefix)) {
      return `source root "${sourceRoot}" resolves to ${real}, which is outside the project root ${projectReal}`;
    }
  }
  return null;
}

/**
 * Resolves a path to its physical location, following symlinks and Windows junctions (DEV-P0-08).
 *
 * Lexical normalization judges a path by its spelling; this judges it by where it actually lands. An
 * existing path is realpath'd; a path that does not exist yet is resolved by realpath'ing its nearest
 * existing ancestor and re-appending the remaining suffix, so a target under a symlinked directory is
 * classified by the directory's real location even before the leaf is created. realpath runs on a
 * real-case absolute path; only the final result is normalised (lowercased, drive-folded) for zone
 * comparison. If nothing on the path exists, or realpath fails, the lexical normalisation is returned —
 * there is no link to follow, so the spelling is the honest answer.
 */
export function resolvePhysicalPath(input: string): string {
  let current: string;
  try {
    current = resolveAbsolute(input.replace(/\\/g, '/'));
  } catch {
    return normaliseAbsolute(input);
  }

  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return normaliseAbsolute(input);
    suffix.unshift(basename(current));
    current = parent;
  }

  try {
    const real = realpathSync(current);
    return normaliseAbsolute(suffix.length === 0 ? real : join(real, ...suffix));
  } catch {
    return normaliseAbsolute(input);
  }
}
