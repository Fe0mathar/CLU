/**
 * CLUE shared schemas.
 *
 * Architecture: CLUE_Architecture_v9.md (shape of every persisted record and the config).
 * Status: CLUE_Status_Contract_v9.md (status header identity). Interface: CLUE_Interface_Design_v9.md
 *         (host request/response envelopes).
 * Backlog: DEV-P0-08 — path semantics resolved before cross-field validation; strict schemas
 *          for the recognition basis, graph identity version, status header, and host responses.
 *          DEV-P1-41 — one portable notion of "absolute", exported, instead of two that agreed
 *          only because someone made them agree.
 *
 * Revision 4 (DEV-P1-41) — `absolutePathForm` is exported and `isAbsolutePath` delegates to it.
 * This file always had the portable answer: `normaliseSegments` understands drive letters and
 * UNC roots regardless of host, which is why `relativePathSchema` correctly rejects a Windows
 * path in `source_roots` on Linux. `control/runtime.ts` did not, and DEV-P1-35 and -40 were both
 * the consequence — the second failed open on the protected-surface policy. The fix for those
 * added a compensating predicate there, written to agree with the rules here; two
 * implementations that agree by hand are the arrangement that drifts, so there is now one.
 *
 * Revision 3 (DEV-P0-08) — relative paths (source and document roots, tracked documents) are
 * validated for absoluteness and traversal at the field, and the four operating zones
 * (project, workspace, shadow, browser profile) are checked pairwise for overlap on RESOLVED,
 * case-folded paths, with source roots additionally checked for mutual nesting. Recognition
 * basis, graph identity version, the status header, and every host response are strict schemas
 * whose hashes are strict sha256 and whose timestamps are strict ISO-8601, so a malformed
 * digest, a traversal, an equal or nested root, or a case-variant spelling fails closed here
 * rather than being discovered when something reads or writes the wrong tree.
 *
 * Revision 2 — `parseOrThrow` is now generic over the schema rather than over a single
 * value type. Revision 1 declared it as `z.ZodType<T>`, which forces a schema's input
 * and output types to be the same. Any field carrying a `.default(...)` breaks that
 * assumption — its input is optional and its output is not — so TypeScript resolved `T`
 * to the input shape and handed back optional properties. Under
 * `exactOptionalPropertyTypes` that produced an error at eleven call sites across six
 * files, all of them the same mistake made once, here.
 *
 * One validation idiom for everything CLUE persists or ingests. Nothing enters the
 * event log, the projections, or the policy engine without passing through a schema
 * declared here. A typo in clue.config.yaml must fail loudly at `clue init`, never
 * silently at 03:00 during an unattended landing.
 *
 * Conventions:
 *   - `.strict()` on every object: an unknown key is a defect, not a courtesy.
 *     Config files are hand-edited; a silently ignored misspelled key is exactly the
 *     failure mode this module exists to prevent.
 *   - A path expected to stay within a base is validated as a relative path with no
 *     escaping `..`; cross-field containment (see Path resolution below) compares paths
 *     resolved and case-folded so spelling cannot hide an overlap.
 *   - Secrets are referenced by environment-variable NAME only; a value shaped like an
 *     actual key is rejected outright.
 */

import { z } from 'zod';

import { ENTITY_PREFIXES, HASH_HEX_LENGTH, SEQUENCE_WIDTH } from './ids.js';
import { findSecretMaterial, looksLikeSecretValue } from './secretSafety.js';
import {
  targetPublicationProblem,
  targetRemoteDecisionRecordSchema,
  UNRECORDED_TARGET_REMOTE_DECISION,
} from './targetPublication.js';

/* ------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* ------------------------------------------------------------------------- */

/** Lowercase hex sha256 digest. */
export const sha256Schema = z
  .string()
  .regex(new RegExp(`^[0-9a-f]{${HASH_HEX_LENGTH}}$`), 'expected a lowercase hex sha256 digest');

/** UTC ISO-8601 timestamp with millisecond precision, as produced by nowIso(). */
export const isoTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'expected a UTC ISO-8601 timestamp');

const entityPrefixPattern = Object.values(ENTITY_PREFIXES).join('|');

/** Sequential CLUE entity identifier, e.g. "TASK-000123". */
export const entityIdSchema = z
  .string()
  .regex(
    new RegExp(`^(${entityPrefixPattern})-[0-9]{${SEQUENCE_WIDTH},}$`),
    'expected a CLUE entity id such as TASK-000123',
  );

/** Non-empty path string; existence is verified by `clue doctor`, not here. */
export const pathSchema = z.string().min(1, 'path must not be empty');

/** Fully-qualified path form used by durable Project Profile roots and state bindings. */
export const absoluteProjectProfilePathSchema = pathSchema.refine((value) => {
  const form = absolutePathForm(value);
  return form !== null && form !== 'windows-rooted';
}, 'expected a fully-qualified POSIX, Windows drive, or UNC path');

/**
 * A relative path that stays within its base.
 *
 * Used for inputs resolved against a root — source and document roots under the project,
 * tracked documents under the repository. Rejects an absolute path (which would ignore the
 * base entirely) and any `..` sequence that resolves above the base. A traversal that would
 * escape its root is refused here rather than discovered when it reads or writes the wrong
 * tree. Helpers are hoisted function declarations, so referencing them before their definition
 * is intentional and safe.
 */
export const relativePathSchema = z
  .string()
  .min(1, 'path must not be empty')
  .refine((value) => !isAbsolutePath(value), 'expected a relative path, not an absolute one')
  .refine(
    (value) => !pathEscapesBase(value),
    'path must not traverse outside its base with ".."',
  );

/**
 * Name of an environment variable holding a secret.
 *
 * Rejects anything shaped like an actual credential, so a pasted key fails validation
 * instead of being committed to the repository (spec §95).
 */
export const envVarNameSchema = z
  .string()
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'expected an environment variable NAME, not a secret value');

/** Actors permitted to appear in events and audit entries. */
export const actorSchema = z.enum(['creator', 'daemon', 'worker', 'custodian', 'gateway', 'cli']);
export type Actor = z.infer<typeof actorSchema>;

/* ------------------------------------------------------------------------- */
/* Configuration — mirrors config/clue.config.yaml field for field            */
/* ------------------------------------------------------------------------- */

export const CONFIG_SCHEMA_VERSION = 2;

/**
 * A Git remote for the registered target.
 *
 * ADR-0005 decision 1. Two forms are accepted, matching what Git itself accepts:
 * a URL (`https://`, `ssh://`, `git://`, `file://`) and the scp-like `user@host:path`.
 *
 * Credentials are refused, not warned about. `CLUE_Git_Integration_v9.md` §5.3 states that
 * credentials embedded in URLs are prohibited, and a configuration file is the worst possible
 * place for one — it is versioned, it is included in a release archive, and it is read by
 * `clue doctor` which prints what it read. The two shapes differ in where the credential hides:
 *
 *   `https://TOKEN@host/repo.git`      the *username* is the credential — refused
 *   `ssh://git@host/repo.git`          `git` is a login name, not a secret — allowed
 *   `user:password@host:path`          a password in any form — refused
 *
 * So http(s) refuses any userinfo at all, and every other transport refuses a password while
 * allowing a bare username. This validates a string; it opens no connection. Whether CLU-E may
 * ever push here is a separate decision reserved to the Creator by §6.3, and recording the URL
 * does not grant it.
 */
export const gitRemoteSchema = z
  .string()
  .min(1, 'remote must not be empty')
  .superRefine((value, ctx) => {
    const refuse = (message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };

    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        refuse('not a parseable URL');
        return;
      }
      if (url.password !== '') {
        refuse('remote must not embed a password (Git Integration §5.3)');
        return;
      }
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.username !== '') {
        refuse(
          'an http(s) remote must not carry userinfo — a token in the username position is a ' +
            'credential in a versioned file (Git Integration §5.3)',
        );
      }
      return;
    }

    // scp-like `user@host:path`. The user part must not contain `:`, which is how a password
    // would appear in this form.
    const scp = value.match(/^([^@/\\]+)@([A-Za-z0-9.-]+):(.+)$/u);
    if (scp === null) {
      refuse('expected a URL (https://, ssh://, git://, file://) or `user@host:path`');
      return;
    }
    if (scp[1]?.includes(':') === true) {
      refuse('remote must not embed a password (Git Integration §5.3)');
    }
  });

/**
 * A path to a target input file, relative to `project.root` or absolute on this host.
 *
 * `CLUE_AI_Utilization_v9.md` §25.2 prefers these inside the target repository so both inputs
 * travel in its Git history — but CLU-E must be able to assess a target whose owner will not
 * accept two new files in their tree, so an absolute path outside it stays legal and is reported
 * as `insideRepository: false` (Status §4.1) rather than refused.
 *
 * What is refused is a relative path that climbs out of its base. A foreign-absolute form
 * (`F:/…` read on POSIX) is not caught here — `resolveConfigPaths` owns that check for every
 * configured path, and duplicating it would create the second authority DEV-P1-41 consolidated away.
 */
export const projectInputPathSchema = z
  .string()
  .min(1, 'path must not be empty')
  .refine(
    (value) => isAbsolutePath(value) || !pathEscapesBase(value),
    'path must not traverse outside the project root with ".."',
  );

/**
 * The two governed target inputs (ADR-0005, `DEV-P1-29`).
 *
 * Both are nullable and default to null. Null is the honest reading for an installation that has
 * not registered them yet: it is a stated absence that `clue doctor` reports and Status §4.1
 * exposes, not a missing key that looks like an oversight. Constitution §3.4 makes the description
 * authoritative for declared intent and never for observed truth, so registering one changes what
 * CLU-E can compare against — never what it may claim.
 */
export const projectInputsSchema = z
  .object({
    /** `target description.md` — declared project intent. */
    description: projectInputPathSchema.nullable().default(null),
    /**
     * The Master Benchmark — **one artifact** (ADR-0010, accepted 2026-08-11). The contract
     * carries its own harness in a `[harness.<id>]` block, so there is nothing for a second
     * path to point at and no version disagreement to police: a file cannot disagree with
     * itself. Null until the Creator registers one (DEV-P2-07).
     */
    benchmark: projectInputPathSchema.nullable().default(null),
  })
  .strict();

/**
 * A target profile — everything that is *the target's* rather than CLU-E's (D1, accepted
 * 2026-08-11).
 *
 * The boundary this cuts along already existed in the configuration:
 * `constitution.tracked_documents` is CLU-E's own governing pack and is never
 * target-selectable, while every field under `project.*` describes whatever is being
 * improved. A profile is exactly that second set, lifted into `targets/<id>/profile.yaml`
 * so switching targets is switching one line — "Murugan will not always be the target".
 *
 * **Resolution, not replacement.** The loader overlays the named profile onto
 * `config.project` before validation completes, so every existing reader
 * (`config.project.root`, `.source_roots`, `.inputs.description`, …) keeps working
 * unchanged and there is still one in-memory shape. The profile is where the values come
 * from; it is not a second thing to consult at every call site.
 *
 * **The profile is governed.** Because it now carries the target's identity, the profile
 * file joins the mission basis: editing it moves the world, and a moved world must
 * register a successor mission before producing evidence, exactly as editing the
 * configuration does today.
 */
export const targetProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    root: pathSchema,
    main_branch: z.string().min(1).default('main'),
    source_roots: z.array(relativePathSchema).min(1),
    document_roots: z.array(relativePathSchema).min(1),
    exclude: z.array(z.string().min(1)).default([]),
    /**
     * Where a proven improvement is published (ADR-0005). Null means this target does not
     * publish — a decision, distinguishable from an absent key, which would read as an
     * oversight. Set from the dashboard's configuration panel (B6/B7).
     */
    remote: gitRemoteSchema.nullable().default(null),
    /**
     * The name of the environment variable holding the push credential — never the
     * credential (D4). The dashboard's Grant/Revoke writes this name and records an
     * authority event; no secret reaches the log, an artifact, or Status.
     */
    credential_env: envVarNameSchema.nullable().default(null),
    /**
     * Explicit Creator publication decision. Legacy profiles default to UNRECORDED, which
     * is deliberately different from the mission-bound NO_REMOTE_YET P2 closure state.
     */
    remote_decision: targetRemoteDecisionRecordSchema.default(
      UNRECORDED_TARGET_REMOTE_DECISION,
    ),
    inputs: projectInputsSchema.default({ description: null, benchmark: null }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const problem = targetPublicationProblem(
      value.remote,
      value.credential_env,
      value.remote_decision,
    );
    if (problem !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remote_decision'],
        message: problem,
      });
    }
  });
export type TargetProfile = z.infer<typeof targetProfileSchema>;

/* ------------------------------------------------------------------------- */
/* Project Profiles — post-P2 multi-target control-plane authority            */
/* ------------------------------------------------------------------------- */

export const PROJECT_PROFILE_VERSION = 'clue-project-profile/1' as const;
export const PROJECT_PROFILE_RECORD_VERSION = 'clue-project-profile-record/1' as const;
export const PROJECT_PROFILE_HASH_VERSION = 'profile:v1' as const;

/** Canonical CLU-E-local namespace. Creation-time normalization is explicit, not implicit. */
export const projectIdSchema = z
  .string()
  .min(1, 'Project ID must not be empty')
  .max(128, 'Project ID must not exceed 128 characters')
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/u,
    'Project ID must match [a-z0-9][a-z0-9._-]* and already be canonical lowercase',
  )
  .refine((value) => !looksLikeSecretValue(value), 'Project ID must not contain secret material');

/** Stable physical-root identity emitted by `shared/pathIdentity.ts`. */

/** Explicit creation-input normalization. Existing persisted IDs are never renamed. */
export function normaliseProjectIdInput(value: string): string {
  return projectIdSchema.parse(value.trim().toLowerCase());
}

export const targetRootIdentitySchema = z
  .string()
  .regex(
    /^path:v1:[a-z0-9._-]+:[0-9a-f]{64}$/u,
    'expected path:v1:<platform>:<sha256>',
  );

/** Deterministic hash emitted by `control/projectProfiles/profileHash.ts`. */
export const projectProfileHashSchema = z
  .string()
  .regex(/^profile:v1:[0-9a-f]{64}$/u, 'expected profile:v1:<sha256>');

/** Credential identity only. Secret bytes are rejected by the enclosing profile schema. */
export const credentialReferenceSchema = z.union([
  z.string().regex(/^env:[A-Z][A-Z0-9_]{0,63}$/u, 'expected env:VARIABLE_NAME'),
  z
    .string()
    .regex(
      /^credential-store:[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u,
      'expected credential-store:<stable-reference>',
    ),
]);

export const projectSettingSourceSchema = z.enum(['global-default', 'project-override']);

export const inheritedPathSettingSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('global-default'),
      defaultKey: z.string().min(1),
      value: z.null(),
    })
    .strict(),
  z
    .object({
      source: z.literal('project-override'),
      defaultKey: z.string().min(1),
      value: pathSchema,
    })
    .strict(),
]);

export const inheritedCredentialSettingSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('global-default'),
      defaultKey: z.string().min(1),
      value: z.null(),
    })
    .strict(),
  z
    .object({
      source: z.literal('project-override'),
      defaultKey: z.string().min(1),
      value: credentialReferenceSchema,
    })
    .strict(),
]);

export const governedDocumentRoleSchema = z.enum([
  'architecture',
  'coding-standard',
  'performance',
  'security',
  'product-requirements',
  'operational-constraint',
  'testing',
  'deployment',
  'creator-instruction',
  'known-limitation',
  'other',
]);

export const governedDocumentKindSchema = z.enum([
  'target-description',
  'master-benchmark',
  'project-intent',
  'additional',
]);

export const governedDocumentBindingSchema = z
  .object({
    bindingId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u, 'bindingId must be canonical lowercase'),
    kind: governedDocumentKindSchema,
    path: pathSchema,
    canonicalPath: absoluteProjectProfilePathSchema,
    sha256: sha256Schema,
    role: governedDocumentRoleSchema,
    enabled: z.boolean(),
    order: z.number().int().nonnegative(),
    validationState: z.enum(['VALID', 'INVALID', 'MISSING', 'UNVALIDATED']),
    lastValidated: isoTimestampSchema.nullable(),
  })
  .strict();

export type GovernedDocumentBinding = z.infer<typeof governedDocumentBindingSchema>;

export const masterBenchmarkBindingSchema = governedDocumentBindingSchema.extend({
  kind: z.literal('master-benchmark'),
  benchmarkId: z.string().min(1).max(128).nullable(),
  benchmarkVersion: z.string().min(1).max(128).nullable(),
});

export type MasterBenchmarkBinding = z.infer<typeof masterBenchmarkBindingSchema>;

export const projectAuthoritySchema = z
  .object({
    targetDescription: governedDocumentBindingSchema.nullable(),
    masterBenchmark: masterBenchmarkBindingSchema.nullable(),
    projectIntent: governedDocumentBindingSchema.nullable(),
    additionalDocuments: z.array(governedDocumentBindingSchema),
  })
  .strict()
  .superRefine((authority, ctx) => {
    const distinguished = [
      ['targetDescription', authority.targetDescription, 'target-description', 0],
      ['masterBenchmark', authority.masterBenchmark, 'master-benchmark', 1],
      ['projectIntent', authority.projectIntent, 'project-intent', 2],
    ] as const;

    for (const [field, binding, kind, order] of distinguished) {
      if (binding === null) continue;
      if (binding.kind !== kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, 'kind'],
          message: `${field} must use kind ${kind}`,
        });
      }
      if (!binding.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, 'enabled'],
          message: `${field} is distinguished authority and must be enabled when present`,
        });
      }
      if (binding.order !== order) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, 'order'],
          message: `${field} must use deterministic authority order ${order}`,
        });
      }
    }

    const all = [
      authority.targetDescription,
      authority.masterBenchmark,
      authority.projectIntent,
      ...authority.additionalDocuments,
    ].filter((value): value is z.infer<typeof governedDocumentBindingSchema> => value !== null);

    const paths = new Map<string, string>();
    const bindingIds = new Set<string>();
    const orders = new Map<number, string>();
    for (const binding of all) {
      if (bindingIds.has(binding.bindingId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['additionalDocuments'],
          message: `governed document bindingId ${binding.bindingId} is duplicated`,
        });
      }
      bindingIds.add(binding.bindingId);

      const comparablePath = binding.canonicalPath.replace(/\\/gu, '/').toLowerCase();
      const previousPath = paths.get(comparablePath);
      if (previousPath !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['additionalDocuments'],
          message: `governed document ${binding.bindingId} duplicates canonical path owned by ${previousPath}`,
        });
      } else {
        paths.set(comparablePath, binding.bindingId);
      }

      if (binding.kind === 'additional' && binding.order < 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['additionalDocuments'],
          message: `additional document ${binding.bindingId} must use order >= 100`,
        });
      }
      if (binding.kind !== 'additional' && authority.additionalDocuments.includes(binding)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['additionalDocuments'],
          message: `additional document ${binding.bindingId} must use kind additional`,
        });
      }
      const previousOrder = orders.get(binding.order);
      if (previousOrder !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['additionalDocuments'],
          message: `authority order ${binding.order} is duplicated by ${previousOrder} and ${binding.bindingId}`,
        });
      } else {
        orders.set(binding.order, binding.bindingId);
      }
    }
  });

export const projectRecognitionSchema = z
  .object({
    sourceRoots: z.array(relativePathSchema).min(1),
    excludedPaths: z.array(relativePathSchema),
    buildConfig: projectInputPathSchema.nullable(),
    adapters: z.array(
      z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u, 'adapter id must be canonical'),
    ),
    policy: z
      .object({
        policyVersion: z.literal('recognition-policy/1'),
        fullScanOnActivation: z.boolean(),
        reuseUnchangedSnapshot: z.boolean(),
        followSymlinks: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((recognition, ctx) => {
    addDuplicateStringIssues(ctx, recognition.sourceRoots, ['sourceRoots'], 'source root');
    addDuplicateStringIssues(ctx, recognition.excludedPaths, ['excludedPaths'], 'excluded path');
    addDuplicateStringIssues(ctx, recognition.adapters, ['adapters'], 'adapter');
  });

export const projectBenchmarkRuntimeSchema = z
  .object({
    workingDirectory: absoluteProjectProfilePathSchema,
    command: z.string().min(1).nullable(),
    scenario: z.string().min(1).nullable(),
    warmupRuns: z.number().int().nonnegative(),
    repetitions: z.number().int().positive(),
    timeoutSeconds: z.number().int().positive(),
    targetUrl: z.string().url().nullable(),
    browserProfile: absoluteProjectProfilePathSchema.nullable(),
    resolution: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict()
      .nullable(),
    additionalRuntimeArgs: z.array(z.string()),
  })
  .strict();

export const projectPowerShellIntegrationSchema = z
  .object({
    executable: inheritedPathSettingSchema,
    hostScript: absoluteProjectProfilePathSchema,
    hostRootAuthority: z.literal('project-profile'),
    projectRoot: absoluteProjectProfilePathSchema,
    workspaceRoot: absoluteProjectProfilePathSchema,
    shadowRoot: absoluteProjectProfilePathSchema,
    autonomousProfile: z.enum(['restricted', 'maintenance', 'disabled']),
  })
  .strict();

/** Git object identity; repositories may use SHA-1 (40 hex) or SHA-256 (64 hex). */
export const gitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, 'expected a lowercase Git object ID');

export const projectGitIntegrationSchema = z
  .object({
    repositoryRoot: absoluteProjectProfilePathSchema,
    remote: gitRemoteSchema.nullable(),
    provider: z.enum(['github', 'gitlab', 'azure-devops', 'other']).nullable(),
    defaultBranch: z.string().min(1),
    protectedLandingPolicy: absoluteProjectProfilePathSchema.nullable(),
    currentBasePin: gitObjectIdSchema.nullable(),
    publicationMode: z.enum(['NO_REMOTE_YET', 'LOCAL_ONLY', 'REMOTE_REGISTERED']),
  })
  .strict()
  .superRefine((git, ctx) => {
    if (git.publicationMode === 'NO_REMOTE_YET' && git.remote !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remote'],
        message: 'NO_REMOTE_YET requires remote = null',
      });
    }
    if (git.publicationMode === 'REMOTE_REGISTERED' && git.remote === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remote'],
        message: 'REMOTE_REGISTERED requires a remote',
      });
    }
  });

export const projectChromeIntegrationSchema = z
  .object({
    executable: inheritedPathSettingSchema,
    launchMode: z.enum(['CLUE_MANAGED', 'ATTACH_TO_EXISTING']),
    dedicatedProfileDirectory: absoluteProjectProfilePathSchema,
    remoteDebuggingPort: z.number().int().min(1).max(65535),
    allowedOrigins: z.array(z.string().min(1)).min(1),
    targetUrl: z.string().url().nullable(),
    targetSelectionRule: z.enum(['EXACT_PAGE_ID_THEN_URL_THEN_UNIQUE_ORIGIN']),
  })
  .strict()
  .superRefine((chrome, ctx) => {
    addDuplicateStringIssues(ctx, chrome.allowedOrigins, ['allowedOrigins'], 'allowed origin');
  });

export const projectGptIntegrationSchema = z
  .object({
    provider: z.literal('openai'),
    modelId: z.string().min(1).max(128).nullable(),
    credential: inheritedCredentialSettingSchema,
    enabled: z.boolean(),
    fallbackPolicy: z.literal('FORBID'),
  })
  .strict()
  .superRefine((gpt, ctx) => {
    if (gpt.enabled && gpt.modelId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelId'],
        message: 'enabled GPT integration requires an exact modelId',
      });
    }
  });

export const projectStateBindingSchema = z
  .object({
    databasePath: absoluteProjectProfilePathSchema,
    eventLogRoot: absoluteProjectProfilePathSchema,
    artifactStoreRoot: absoluteProjectProfilePathSchema,
    greatBookScope: projectIdSchema,
    recognitionRoot: absoluteProjectProfilePathSchema,
    proofRoot: absoluteProjectProfilePathSchema,
    cycleRoot: absoluteProjectProfilePathSchema,
    snapshotRoot: absoluteProjectProfilePathSchema,
  })
  .strict();

export const projectProfileProvenanceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('native') }).strict(),
  z
    .object({
      source: z.literal('legacy-target-profile'),
      legacyConfigPath: absoluteProjectProfilePathSchema,
      legacyConfigSha256: sha256Schema,
      legacyProfilePath: absoluteProjectProfilePathSchema,
      legacyProfileSha256: sha256Schema,
    })
    .strict(),
]);

/**
 * Behavior-bearing Project Profile. Store generation/timestamps/hash live in the record envelope
 * below and therefore cannot accidentally change the governed profile hash.
 */
export const projectProfileSchema = z
  .object({
    profileVersion: z.literal(PROJECT_PROFILE_VERSION),
    projectId: projectIdSchema,
    displayName: z.string().min(1).max(256).nullable(),
    targetRoot: absoluteProjectProfilePathSchema,
    targetRootIdentity: targetRootIdentitySchema,
    workspaceRoot: absoluteProjectProfilePathSchema,
    shadowRoot: absoluteProjectProfilePathSchema,
    authority: projectAuthoritySchema,
    recognition: projectRecognitionSchema,
    benchmarkRuntime: projectBenchmarkRuntimeSchema,
    integrations: z
      .object({
        powershell: projectPowerShellIntegrationSchema,
        git: projectGitIntegrationSchema,
        chrome: projectChromeIntegrationSchema,
        gpt: projectGptIntegrationSchema,
      })
      .strict(),
    state: projectStateBindingSchema,
    provenance: projectProfileProvenanceSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    const sameTextPath = (left: string, right: string): boolean =>
      toComparable(left) === toComparable(right);

    if (!sameTextPath(profile.integrations.powershell.projectRoot, profile.targetRoot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['integrations', 'powershell', 'projectRoot'],
        message: 'PowerShell projectRoot must equal targetRoot',
      });
    }
    if (!sameTextPath(profile.integrations.powershell.workspaceRoot, profile.workspaceRoot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['integrations', 'powershell', 'workspaceRoot'],
        message: 'PowerShell workspaceRoot must equal workspaceRoot',
      });
    }
    if (!sameTextPath(profile.integrations.powershell.shadowRoot, profile.shadowRoot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['integrations', 'powershell', 'shadowRoot'],
        message: 'PowerShell shadowRoot must equal shadowRoot',
      });
    }
    if (!sameTextPath(profile.integrations.git.repositoryRoot, profile.targetRoot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['integrations', 'git', 'repositoryRoot'],
        message: 'Git repositoryRoot must equal targetRoot',
      });
    }
    if (profile.state.greatBookScope !== profile.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state', 'greatBookScope'],
        message: 'Great Book scope must equal projectId',
      });
    }

    const zones = [
      ['targetRoot', profile.targetRoot],
      ['workspaceRoot', profile.workspaceRoot],
      ['shadowRoot', profile.shadowRoot],
      ['integrations.chrome.dedicatedProfileDirectory', profile.integrations.chrome.dedicatedProfileDirectory],
    ] as const;
    for (let i = 0; i < zones.length; i += 1) {
      for (let j = i + 1; j < zones.length; j += 1) {
        const left = zones[i];
        const right = zones[j];
        if (left === undefined || right === undefined) continue;
        const overlap = pathsOverlap(left[1], right[1]);
        if (overlap !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: right[0].split('.'),
            message: `${right[0]} must not ${overlap} ${left[0]}`,
          });
        }
      }
    }

    const workspaceComparable = toComparable(profile.workspaceRoot);
    const statePaths = Object.entries(profile.state).filter(
      (entry): entry is [string, string] => entry[0] !== 'greatBookScope' && typeof entry[1] === 'string',
    );
    for (const [field, path] of statePaths) {
      if (!contains(workspaceComparable, toComparable(path))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['state', field],
          message: `${field} must remain inside workspaceRoot`,
        });
      }
    }

    const secret = findSecretMaterial(profile);
    if (secret !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: secret.path === '<root>' ? [] : secret.path.split('.'),
        message: `secret material is forbidden (${secret.reason})`,
      });
    }
  });

export type ProjectProfile = z.infer<typeof projectProfileSchema>;

/** Durable profile file envelope with optimistic-concurrency generation. */
export const projectProfileRecordSchema = z
  .object({
    recordVersion: z.literal(PROJECT_PROFILE_RECORD_VERSION),
    generation: z.number().int().positive(),
    projectProfileHash: projectProfileHashSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    profile: projectProfileSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.updatedAt < record.createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'updatedAt must not precede createdAt',
      });
    }
  });

export type ProjectProfileRecord = z.infer<typeof projectProfileRecordSchema>;

/** Shared governed-operation basis for one exact Project Profile generation. */
export const projectGovernanceBasisSchema = z
  .object({
    basisVersion: z.literal('clue-project-governance-basis/1'),
    operationIdentity: z
      .object({
        projectId: projectIdSchema,
        targetRootIdentity: targetRootIdentitySchema,
        projectProfileHash: projectProfileHashSchema,
      })
      .strict(),
    profileGeneration: z.number().int().positive(),
    authorityHash: sha256Schema,
    masterBenchmarkHash: sha256Schema,
    recognitionConfigHash: sha256Schema,
    benchmarkRuntimeHash: sha256Schema,
  })
  .strict();
export type ProjectGovernanceBasis = z.infer<typeof projectGovernanceBasisSchema>;

/* ------------------------------------------------------------------------- */
/* Project-owned workspace identity                                           */
/* ------------------------------------------------------------------------- */

export const WORKSPACE_PROJECT_IDENTITY_VERSION = 'workspace-project-identity/1' as const;

/**
 * One durable ownership receipt for one project workspace. The initial profile hash is
 * historical: later valid profile generations do not rewrite the workspace's origin.
 */
export const workspaceProjectIdentitySchema = z
  .object({
    identityVersion: z.literal(WORKSPACE_PROJECT_IDENTITY_VERSION),
    projectId: projectIdSchema,
    targetRootIdentity: targetRootIdentitySchema,
    profileVersion: z.literal(PROJECT_PROFILE_VERSION),
    initialProfileHash: projectProfileHashSchema,
    createdAt: isoTimestampSchema,
    origin: z.enum(['new-workspace', 'legacy-adoption']),
    legacyProjectionHeadHash: sha256Schema.nullable(),
    legacyIndexedEvents: z.number().int().nonnegative(),
  })
  .strict();
export type WorkspaceProjectIdentity = z.infer<typeof workspaceProjectIdentitySchema>;

export const projectConfigSchema = z
  .object({
    id: z.string().min(1),
    /** Human-readable target name shown in graph/status labels; defaults to `id`. */
    name: z.string().min(1).optional(),
    root: pathSchema,
    main_branch: z.string().min(1).default('main'),
    source_roots: z.array(relativePathSchema).min(1),
    document_roots: z.array(relativePathSchema).min(1),
    exclude: z.array(z.string().min(1)).default([]),
    /**
     * Where a proven improvement is published (ADR-0005). Null means this target does not
     * publish — a decision, distinguishable from an absent key, which would read as an oversight.
     */
    remote: gitRemoteSchema.nullable().default(null),
    /** See `targetProfileSchema.credential_env` — a name, never a secret (D4). */
    credential_env: envVarNameSchema.nullable().default(null),
    /** See `targetProfileSchema.remote_decision` — a Creator-owned publication decision. */
    remote_decision: targetRemoteDecisionRecordSchema.default(
      UNRECORDED_TARGET_REMOTE_DECISION,
    ),
    inputs: projectInputsSchema.default({ description: null, benchmark: null }),
    /**
     * The profile whose values fill this block, or null for a self-contained configuration
     * (D1). Named here rather than in a separate section because the resolved shape and its
     * provenance belong together: a reader that has `config.project` in hand can always ask
     * where it came from.
     */
    active_target: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const problem = targetPublicationProblem(
      value.remote,
      value.credential_env,
      value.remote_decision,
    );
    if (problem !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remote_decision'],
        message: problem,
      });
    }
  });

export const workspaceConfigSchema = z
  .object({
    root: pathSchema,
  })
  .strict();

export const shadowConfigSchema = z
  .object({
    root: pathSchema,
    clone_mode: z.enum(['local', 'copy']).default('local'),
    persistent: z.boolean().default(true),
    install_on_lockfile_change: z.boolean().default(true),
    install_command: z.string().min(1).default('npm ci'),
  })
  .strict();

export const constitutionConfigSchema = z
  .object({
    file: relativePathSchema,
    tracked_documents: z.array(relativePathSchema).min(1),
  })
  .strict()
  .refine((value) => value.tracked_documents.includes(value.file), {
    message: 'constitution.file must also appear in constitution.tracked_documents',
  });

export const runtimeConfigSchema = z
  .object({
    package_manager: z.enum(['npm', 'pnpm', 'yarn']),
    scripts: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

export const browserConfigSchema = z
  .object({
    executable: pathSchema,
    remote_debugging_port: z.number().int().min(1024).max(65535),
    profile_dir: pathSchema,
    allowed_origins: z.array(z.string().min(1)).min(1),
    require_webgpu: z.boolean().default(true),
  })
  .strict();

export const powershellConfigSchema = z
  .object({
    executable: z.string().min(1),
    autonomous_profile: z.enum(['restricted', 'maintenance']).default('restricted'),
  })
  .strict();

export const analysisConfigSchema = z
  .object({
    max_context_tokens: z.number().int().positive(),
    reserve_output_tokens: z.number().int().positive(),
    dynamic_edge_confidence_threshold: z.number().min(0).max(1),
    monodependency_percentile: z.number().min(0).max(1),
  })
  .strict()
  .refine((value) => value.reserve_output_tokens < value.max_context_tokens, {
    message: 'analysis.reserve_output_tokens must be smaller than analysis.max_context_tokens',
  });

export const proofConfigSchema = z
  .object({
    /** Literal: a proof engine without a frozen contract is not a proof engine. */
    require_frozen_contract: z.literal(true),
    /** Literal: an inconclusive result is never an improvement (spec §71). */
    inconclusive_counts_as_improvement: z.literal(false),
    require_baseline: z.boolean().default(true),
    require_guardrails: z.boolean().default(true),
  })
  .strict();

export const certificationConfigSchema = z
  .object({
    clean_passes: z.number().int().min(1),
    invalidate_on_dependency_change: z.boolean().default(true),
  })
  .strict();

export const equilibriumConfigSchema = z
  .object({
    evaluation_cycles: z.number().int().min(1),
    policy_file: pathSchema,
  })
  .strict();

/** Landing modes (strategy Part VIII §30). Shadow apply is automatic in all three. */
export const patchingModeSchema = z.enum(['AUTO', 'NOTIFY', 'OUTBOX']);
export type PatchingMode = z.infer<typeof patchingModeSchema>;

export const patchingConfigSchema = z
  .object({
    mode: patchingModeSchema,
    policy_file: pathSchema,
    landing_branch_prefix: z.string().min(1),
    /** Literal: the Custodian is forbidden to resolve conflicts (strategy §32). */
    merge_strategy: z.literal('fast_forward_only'),
    post_land_verify: z.array(z.enum(['typecheck', 'build', 'regression_suite'])).min(1),
    /** Literal: an unattended landing without an armed undo is not permitted. */
    auto_revert_on_post_land_failure: z.literal(true),
  })
  .strict();

export const notificationsConfigSchema = z
  .object({
    status_document: z.boolean().default(true),
    windows_toast: z.boolean().default(false),
    webhook_url_env: envVarNameSchema.nullable().default(null),
  })
  .strict();

export const promptCacheConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    stable_prefix_sections: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const gatewayConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Amendment A1: OpenAI exclusively. The adapter interface stays provider-neutral. */
    provider: z.literal('openai'),
    api_key_env: envVarNameSchema,
    default_mode: z.enum(['batch', 'interactive']).default('batch'),
    batch_poll_interval_seconds: z.number().int().min(30).max(3600),
    prompt_cache: promptCacheConfigSchema,
    budget_policy_file: pathSchema,
    routing_file: pathSchema,
  })
  .strict();

export const backupConfigSchema = z
  .object({
    remote: z.string().min(1),
    push_on_verdict: z.boolean().default(true),
    push_on_landing: z.boolean().default(true),
    max_remote_staleness_hours: z.number().int().positive(),
  })
  .strict();

export const securityConfigSchema = z
  .object({
    /**
     * `denied` is the unamended constitution; `custodian_only` is amendment A2.
     * No third value exists: there is no configuration in which an arbitrary
     * component may write to the canonical tree.
     */
    canonical_source_writes: z.enum(['denied', 'custodian_only']),
    real_settlement: z.literal('denied'),
    redact_environment: z.boolean().default(true),
  })
  .strict();

export const loggingConfigSchema = z
  .object({
    level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .strict();

/** The whole installation configuration. */
export const clueConfigSchema = z
  .object({
    version: z.literal(CONFIG_SCHEMA_VERSION),
    project: projectConfigSchema,
    workspace: workspaceConfigSchema,
    shadow: shadowConfigSchema,
    constitution: constitutionConfigSchema,
    runtime: runtimeConfigSchema,
    browser: browserConfigSchema,
    powershell: powershellConfigSchema,
    analysis: analysisConfigSchema,
    proof: proofConfigSchema,
    certification: certificationConfigSchema,
    equilibrium: equilibriumConfigSchema,
    patching: patchingConfigSchema,
    notifications: notificationsConfigSchema,
    gateway: gatewayConfigSchema,
    backup: backupConfigSchema,
    security: securityConfigSchema,
    logging: loggingConfigSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    // Cross-field invariants that no single field can express.

    // 1. The four operating zones must be pairwise disjoint. Any overlap — equal roots, one
    //    nested in another, or the same directory reached by a different spelling — lets one
    //    role's writes land in another's tree: CLUE dirtying the canonical source, recognizing
    //    its own workspace as target code, or a shadow build overwriting saved evidence. Paths
    //    are resolved (`.`/`..` collapsed) and case-folded before comparison, so a traversal or
    //    a case-variant spelling cannot slip an overlap past the check.
    const zones: ReadonlyArray<{ readonly label: string; readonly path: readonly string[]; readonly value: string }> = [
      { label: 'project.root', path: ['project', 'root'], value: value.project.root },
      { label: 'workspace.root', path: ['workspace', 'root'], value: value.workspace.root },
      { label: 'shadow.root', path: ['shadow', 'root'], value: value.shadow.root },
      { label: 'browser.profile_dir', path: ['browser', 'profile_dir'], value: value.browser.profile_dir },
    ];

    for (let i = 0; i < zones.length; i += 1) {
      for (let j = i + 1; j < zones.length; j += 1) {
        const a = zones[i];
        const b = zones[j];
        if (a === undefined || b === undefined) continue;
        const overlap = pathsOverlap(a.value, b.value);
        if (overlap !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...b.path],
            message: `${b.label} must not ${overlap} ${a.label}`,
          });
        }
      }
    }

    // 2. Source roots must not nest inside one another: a file under two roots would be
    //    recognized and measured twice, and every comparison built on those counts would be
    //    wrong. They are resolved against project.root before comparison.
    const resolvedRoots = value.project.source_roots.map((root) => ({
      root,
      resolved: toComparable(`${value.project.root}/${root}`),
    }));
    for (let i = 0; i < resolvedRoots.length; i += 1) {
      for (let j = 0; j < resolvedRoots.length; j += 1) {
        if (i === j) continue;
        const outer = resolvedRoots[i];
        const inner = resolvedRoots[j];
        if (outer === undefined || inner === undefined) continue;
        if (contains(outer.resolved, inner.resolved)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['project', 'source_roots', j],
            message: `source_roots[${j}] "${inner.root}" is nested inside source_roots[${i}] "${outer.root}"`,
          });
        }
      }
    }

    // 3. AUTO landing requires the amended write authority to be enabled. Setting one
    //    without the other is the most likely dangerous configuration mistake, so it
    //    is refused at load rather than discovered at landing time.
    if (value.patching.mode === 'AUTO' && value.security.canonical_source_writes === 'denied') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patching', 'mode'],
        message:
          'patching.mode AUTO requires security.canonical_source_writes to be custodian_only',
      });
    }

    // 4. The proof engine depends on these scripts existing on the target side.
    for (const required of ['typecheck', 'build'] as const) {
      if (value.runtime.scripts[required] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runtime', 'scripts', required],
          message: `runtime.scripts.${required} is required`,
        });
      }
    }
  });

export type ClueConfig = z.infer<typeof clueConfigSchema>;

/* ------------------------------------------------------------------------- */
/* Path resolution                                                            */
/* ------------------------------------------------------------------------- */

/*
 * Containment checks compare RESOLVED, case-folded paths, never raw strings. Resolving
 * collapses `.` and `..` so a path written to look outside a zone but resolving inside it (or
 * the reverse) is judged by where it actually lands; case-folding so a case-variant spelling of
 * the same directory on a case-insensitive filesystem is treated as the same place. Both are
 * "fail closed": an equal or containing path is always caught, whichever way it was written.
 */

/** Resolves a path to the form used for comparison: `.`/`..` collapsed, case-folded. */
function toComparable(value: string): string {
  const { path } = normaliseSegments(value);
  const stripped = path === '/' ? '/' : path.replace(/\/+$/, '');
  return stripped.toLowerCase();
}

/**
 * Which platform's rules make a path absolute.
 *
 * `null` means the path is relative under every platform's rules.
 */
export type AbsolutePathForm = 'posix-root' | 'windows-drive' | 'windows-unc' | 'windows-rooted';

/**
 * Classifies an absolute path by the form that makes it absolute — the one portable answer.
 *
 * DEV-P1-41. The tree held two notions of "absolute" and only one of them was portable.
 *
 * `node:path`'s `isAbsolute` answers for the *running* platform, which is right for resolving a
 * path and wrong for judging one: on Linux `isAbsolute('F:/CLU')` is `false` — not "absolute
 * elsewhere", simply false. `DEV-P1-35` and `-40` were both that answer being trusted as a
 * judgement, and the second of them failed open on the protected-surface policy.
 *
 * The fix for those introduced a compensating predicate in `control/runtime.ts`, written to agree
 * with the rules here. Two implementations that agree because someone made them agree are the
 * arrangement that drifts — the next edit to either has no way of knowing about the other. This
 * is the single implementation both now use.
 *
 * Absoluteness is decided by `normaliseSegments` and nothing else, so this function cannot
 * disagree with `relativePathSchema`, `pathsOverlap` or anything else built on it. The form is
 * only a label applied afterwards, for callers that need to say *why* a path was refused.
 *
 * Note that `F:relative` is **not** absolute: `normaliseSegments` requires a separator or the end
 * of the string after the drive, matching Windows' own drive-relative semantics. A path like that
 * is genuinely relative, and refusing it would be over-reach.
 */
export function absolutePathForm(value: string): AbsolutePathForm | null {
  if (!normaliseSegments(value).absolute) return null;

  const forward = value.replace(/\\/gu, '/');
  if (/^[A-Za-z]:(?=\/|$)/u.test(forward)) return 'windows-drive';
  if (value.startsWith('\\\\')) return 'windows-unc';
  if (value.startsWith('\\')) return 'windows-rooted';
  return 'posix-root';
}

/**
 * Whether a path is absolute (POSIX root or a drive letter).
 *
 * Delegates rather than re-deciding, so the predicate and the classification cannot diverge.
 */
function isAbsolutePath(value: string): boolean {
  return absolutePathForm(value) !== null;
}

/** Whether a relative path resolves above its base (its first surviving segment is `..`). */
function pathEscapesBase(value: string): boolean {
  const { path, absolute } = normaliseSegments(value);
  if (absolute) return false;
  return path === '..' || path.startsWith('../');
}

/** Whether `parent` contains `child` (or they are equal), on already-resolved paths. */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  const boundary = parent === '/' ? '/' : `${parent}/`;
  return child.startsWith(boundary);
}

function addDuplicateStringIssues(
  ctx: z.RefinementCtx,
  values: readonly string[],
  path: readonly (string | number)[],
  label: string,
): void {
  const seen = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const comparable = value.replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();
    const previous = seen.get(comparable);
    if (previous !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `${label} duplicates entry ${previous}`,
      });
    } else {
      seen.set(comparable, index);
    }
  }
}

/**
 * Describes how two zones overlap, or null if they are disjoint. Comparison is on resolved,
 * case-folded paths, so it reports the real relationship regardless of spelling.
 */
function pathsOverlap(a: string, b: string): 'equal' | 'be inside' | 'contain' | null {
  const left = toComparable(a);
  const right = toComparable(b);
  if (left === right) return 'equal';
  if (contains(left, right)) return 'be inside';
  if (contains(right, left)) return 'contain';
  return null;
}

/** Raised when the four operating zones overlap once resolved to absolute paths. */
export class ConfigZoneError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigZoneError';
  }
}

/**
 * DEV-P0-08 — the definitive cross-zone disjointness check, run on RESOLVED absolute paths.
 *
 * The config schema's own `superRefine` check runs at parse time on the raw YAML, where a relative
 * zone root (for example `workspace: "workspace"`) has no base to resolve against and so cannot be
 * compared to an absolute `project.root`. Once `resolveConfigPaths` has made every zone
 * installation-absolute, this catches an overlap the raw check could not — most importantly a
 * workspace that resolves INSIDE the project root — and fails closed by throwing. It reuses the same
 * resolved, case-folded comparison, so a traversal or case-variant spelling cannot slip past it
 * either. Callers pass the already-resolved configuration.
 */
export function assertZonesDisjoint(config: ClueConfig): void {
  const zones: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
    { label: 'project.root', value: config.project.root },
    { label: 'workspace.root', value: config.workspace.root },
    { label: 'shadow.root', value: config.shadow.root },
    { label: 'browser.profile_dir', value: config.browser.profile_dir },
  ];
  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      const a = zones[i];
      const b = zones[j];
      if (a === undefined || b === undefined) continue;
      const overlap = pathsOverlap(a.value, b.value);
      if (overlap !== null) {
        throw new ConfigZoneError(
          `${b.label} must not ${overlap} ${a.label} once resolved ` +
            `(${b.label}=${b.value}, ${a.label}=${a.value})`,
        );
      }
    }
  }
}

/**
 * Splits a path into resolved segments, collapsing `.` and `..`.
 *
 * An absolute path clamps at its root — `..` above root is dropped, never allowed to escape. A
 * relative path keeps leading `..`, which is how `pathEscapesBase` detects a traversal.
 */
function normaliseSegments(value: string): { path: string; absolute: boolean } {
  const forward = value.replace(/\\/g, '/');
  const driveMatch = /^([A-Za-z]:)(?=\/|$)/.exec(forward);
  const drive = driveMatch === null ? '' : driveMatch[1] ?? '';
  const afterDrive = drive === '' ? forward : forward.slice(drive.length);
  const rooted = afterDrive.startsWith('/');
  const absolute = rooted || drive !== '';

  const out: string[] = [];
  for (const segment of afterDrive.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const top = out[out.length - 1];
      if (out.length > 0 && top !== '..') out.pop();
      else if (!absolute) out.push('..');
      // absolute at root: drop, so a traversal can never climb above the root.
    } else {
      out.push(segment);
    }
  }

  const body = out.join('/');
  let path: string;
  if (drive !== '') path = body === '' ? drive : `${drive}/${body}`;
  else if (rooted) path = `/${body}`;
  else path = body;
  return { path, absolute };
}

/* ------------------------------------------------------------------------- */
/* Kernel records                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Event log record (spec §14.2).
 *
 * `previous_hash` chains the log; `hash` covers the canonical JSON of every field
 * except `hash` itself. A replay that cannot reproduce the chain is a corrupted log,
 * and CLUE must say so rather than proceed on a plausible-looking history.
 */
export const eventRecordSchema = z
  .object({
    id: entityIdSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: isoTimestampSchema,
    type: z.string().min(1),
    mission_version: z.string().min(1),
    actor: actorSchema,
    subject_id: entityIdSchema.nullable().default(null),
    payload: z.unknown(),
    previous_hash: sha256Schema.nullable(),
    hash: sha256Schema,
  })
  .strict();

export type EventRecord = z.infer<typeof eventRecordSchema>;

/** Reference to a stored artifact in the content-addressed blob store (spec §14.1). */
export const artifactRefSchema = z
  .object({
    hash: sha256Schema,
    bytes: z.number().int().nonnegative(),
    media_type: z.string().min(1),
    /** Original or logical name; informational only, never used for lookup. */
    label: z.string().min(1).nullable().default(null),
    created_at: isoTimestampSchema,
  })
  .strict();

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

/** One tracked founding document and its content hash at registration time. */
export const trackedDocumentSchema = z
  .object({
    path: pathSchema,
    hash: sha256Schema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export type TrackedDocument = z.infer<typeof trackedDocumentSchema>;

/** A deliberate override of a founding boundary, recorded rather than assumed. */
export const amendmentSchema = z
  .object({
    code: z.string().regex(/^A[0-9]+$/, 'expected an amendment code such as A2'),
    directive: z.string().min(1),
    affects: z.array(z.string().min(1)).min(1),
    recorded_at: isoTimestampSchema,
  })
  .strict();

export type Amendment = z.infer<typeof amendmentSchema>;

/**
 * Mission version (spec §11.1).
 *
 * `constitution_hash` is the binding identity: a changed CLUE.md is a new mission,
 * never a silent edit. `amendments` records deliberate overrides of founding
 * boundaries — amendment A2 (Custodian) is the first entry.
 */
export const missionVersionSchema = z
  .object({
    id: entityIdSchema,
    version: z.number().int().positive(),
    created_at: isoTimestampSchema,
    constitution_hash: sha256Schema,
    documents: z.array(trackedDocumentSchema).min(1),
    amendments: z.array(amendmentSchema).default([]),
    superseded_by: entityIdSchema.nullable().default(null),
  })
  .strict();

export type MissionVersion = z.infer<typeof missionVersionSchema>;

/**
 * Pack ratification (DEV-P2-01 / DEV-P2-05, Gate 7).
 *
 * The durable payload of the Creator's act that makes the installed documentation pack the
 * ratified authority — the act `DOCUMENTATION_GOVERNANCE_v9.md` §14 requires for the
 * reconstructed Constitution, recorded as an `authority.pack_ratified` event owned by the
 * mission service (`src/control/mission.ts` registers authority before authoritative work;
 * Directory §8).
 *
 * ## What the record binds, and why each field
 *
 * The seal hash binds the entire pack transitively — `SHA256SUMS_v9.txt` declares every
 * file's hash, so one hash pins seventeen. The manifest hash pins the descriptive state
 * (document revisions, amendment records, the `reconstructed-pending-ratification` status
 * this act discharges). The constitution hash is redundant with the seal on purpose: it is
 * the named item requiring the act, and naming it lets a reader verify the specific thing
 * ratified without re-deriving it from the seal. `declared_file_count` is a cheap census so
 * a truncated seal cannot masquerade as the ratified one.
 *
 * `ratified_by` duplicates the event's `actor` inside the payload so the payload is
 * self-contained evidence when exported without its envelope. `statement` is the exact
 * confirmation phrase typed at the prompt — the act is deliberate, and the record keeps the
 * words of the deliberation, not a boolean summary of them.
 *
 * ## What this schema deliberately does not do
 *
 * It does not validate that the hashes are *current* — that is the ratification service's
 * job at write time and doctor's at read time. A schema that reached out to disk would make
 * historical events unparseable the moment the pack legitimately moved on; the record is
 * true about the moment of ratification, permanently.
 */
export const packRatificationSchema = z
  .object({
    pack_release: z.string().min(1),
    release_version: z.string().min(1),
    seal_path: relativePathSchema,
    seal_sha256: sha256Schema,
    manifest_path: relativePathSchema,
    manifest_sha256: sha256Schema,
    constitution_path: relativePathSchema,
    constitution_sha256: sha256Schema,
    declared_file_count: z.number().int().positive(),
    ratified_by: z.literal('creator'),
    statement: z.string().min(1),
    ratified_at: isoTimestampSchema,
  })
  .strict();

export type PackRatification = z.infer<typeof packRatificationSchema>;

/**
 * Evidence-epoch seal (ADR-0006, accepted 2026-08-10).
 *
 * The durable payload of the Creator's act that draws the boundary: everything at or before
 * `legacy_head_sequence` is bootstrap-era history; everything after was produced under the
 * ratified authority. The head is bound only after a full chain verification, the blob
 * manifest pins every artifact as `{hash, bytes}` sorted by hash, and the ratification event
 * id names the authority the epoch stands on — with its seal hash copied in so the payload
 * remains self-contained evidence outside its envelope. As with ratification, the schema
 * deliberately does not check currency; the sealing service does at write time, and the
 * record stays true about its moment forever.
 */
export const epochSealSchema = z
  .object({
    epoch_name: z.string().min(1),
    legacy_head_sequence: z.number().int().nonnegative(),
    legacy_head_hash: sha256Schema,
    blob_manifest_sha256: sha256Schema,
    blob_count: z.number().int().nonnegative(),
    ratification_event_id: entityIdSchema,
    ratified_seal_sha256: sha256Schema,
    sealed_by: z.literal('creator'),
    statement: z.string().min(1),
    sealed_at: isoTimestampSchema,
  })
  .strict();

export type EpochSeal = z.infer<typeof epochSealSchema>;

/* ------------------------------------------------------------------------- */
/* Cycle (DEV-P2-08 S1; cycle-implementation-plan v1, accepted 2026-08-10)    */
/* ------------------------------------------------------------------------- */

/**
 * The stage machine's vocabulary. Every arrow between these is an event, and the legality
 * of arrows lives in one table in the cycle registry — these names are the only thing the
 * schema layer fixes. `SUSPENDED` is a real stage, not a flag: a suspended cycle remembers
 * where it was (`suspended_from` on the record) and resumes there through the resume
 * planner's verification, per Execution Model §21.
 */
export const cycleStageSchema = z.enum([
  'OPENED',
  'INPUTS_LOCKED',
  'OPENING_EVIDENCE',
  'RECOGNIZED',
  'SCREENED',
  'CANDIDATES',
  'CLOSING_EVIDENCE',
  'HANDOFF',
  'CLOSED',
  'SUSPENDED',
]);
export type CycleStage = z.infer<typeof cycleStageSchema>;

/**
 * Execution Model §2's honesty made a value: `proof-authoritative` may only be claimed when
 * every required input is locked; anything less is `diagnostic`, and the lock says so.
 */
export const cycleGradeSchema = z.enum(['diagnostic', 'proof-authoritative']);
export type CycleGrade = z.infer<typeof cycleGradeSchema>;

/** A locked input: where it was read and exactly what it contained. */
const lockedInputSchema = z
  // Legacy target inputs are project-relative; Project Profile authority may intentionally
  // bind a fully-qualified canonical document path. The lock records identity and never
  // resolves this value for writes, so accepting either governed form is safe and necessary.
  .object({ path: pathSchema, sha256: sha256Schema })
  .strict();

/**
 * The input lock (Execution Model §2/§3.3 made computable).
 *
 * The lock enumerates what it locked and — just as loudly — what it could not: `absent`
 * names every §2 input that was missing, and the refinement below makes the grade honest by
 * construction: a lock naming any absence cannot call itself proof-authoritative. The
 * digest is the canonical hash over the locked set; two cycles with equal digests locked
 * identical worlds.
 */
export const cycleInputLockSchema = z
  .object({
    digest: sha256Schema,
    grade: cycleGradeSchema,
    computed_at: isoTimestampSchema,
    project_basis: projectGovernanceBasisSchema.optional(),
    target_description: lockedInputSchema.nullable(),
    master_benchmark: lockedInputSchema.nullable(),
    tracked_documents: z.array(lockedInputSchema).min(1),
    catalogue_version: z.string().min(1).nullable(),
    policy_files: z.array(lockedInputSchema),
    environment_fingerprint: z
      .object({ node_version: z.string().min(1), platform: z.string().min(1), arch: z.string().min(1) })
      .strict(),
    ratification_event_id: entityIdSchema.nullable(),
    epoch_name: z.string().min(1).nullable(),
    absent: z.array(z.string().min(1)),
  })
  .strict()
  .refine((value) => value.grade !== 'proof-authoritative' || value.absent.length === 0, {
    message: 'a lock naming absent inputs cannot be proof-authoritative',
  });

export type CycleInputLock = z.infer<typeof cycleInputLockSchema>;

/** The projection row: one cycle's current truth, rebuildable from its events. */
export const cycleRecordSchema = z
  .object({
    id: entityIdSchema,
    mission_version: z.string().min(1),
    stage: cycleStageSchema,
    suspended_from: cycleStageSchema.nullable(),
    grade: cycleGradeSchema.nullable(),
    lock_digest: sha256Schema.nullable(),
    opened_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    closed_at: isoTimestampSchema.nullable(),
    /**
     * The §24 verdict, projected (ADR-0007). Null until closure. Log-free surfaces read
     * these instead of replaying the log — Status opens without one — while the reasons
     * themselves stay in the closure event and the §19 handoff, where they are complete.
     * SQLite has no boolean, so the row carries 0/1 and the schema coerces.
     */
    criteria_met: z
      .union([z.boolean(), z.number().int().min(0).max(1)])
      .nullable()
      .transform((value) => (value === null ? null : value === true || value === 1)),
    unmet_count: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type CycleRecord = z.infer<typeof cycleRecordSchema>;

/* Event payloads — one per arrow; the registry owns the `cycle.*` types that carry them. */

export const cycleOpenedSchema = z
  .object({
    cycle_id: entityIdSchema,
    mission_version: z.string().min(1),
    opened_by: actorSchema,
    opened_at: isoTimestampSchema,
  })
  .strict();
export type CycleOpened = z.infer<typeof cycleOpenedSchema>;

export const cycleInputsLockedSchema = z
  .object({ cycle_id: entityIdSchema, lock: cycleInputLockSchema })
  .strict();
export type CycleInputsLocked = z.infer<typeof cycleInputsLockedSchema>;

export const cycleStageAdvancedSchema = z
  .object({
    cycle_id: entityIdSchema,
    from: cycleStageSchema,
    to: cycleStageSchema,
    advanced_at: isoTimestampSchema,
    evidence: artifactRefSchema.nullable(),
  })
  .strict();
export type CycleStageAdvanced = z.infer<typeof cycleStageAdvancedSchema>;

export const cycleSuspendedSchema = z
  .object({
    cycle_id: entityIdSchema,
    from: cycleStageSchema,
    suspended_at: isoTimestampSchema,
    reason: z.string().min(1),
  })
  .strict();
export type CycleSuspended = z.infer<typeof cycleSuspendedSchema>;

export const cycleResumedSchema = z
  .object({
    cycle_id: entityIdSchema,
    to: cycleStageSchema,
    resumed_at: isoTimestampSchema,
    verification: artifactRefSchema.nullable(),
  })
  .strict();
export type CycleResumed = z.infer<typeof cycleResumedSchema>;

/**
 * Closure records §24 as evaluated, met or honestly unmet: `criteria_met` with the unmet
 * criteria enumerated. A diagnostic cycle CLOSED with reasons is a designed success (§1).
 */
/**
 * Next-cycle vital input — Execution Model §19's compact handoff (DEV-P2-08 deferred
 * slice). Every §19 bullet is a field; absence-capable fields are nullable and every null
 * is explained in `statedAbsences`, so the record can be honest before the domains that
 * fill it exist. `stageEvidence` exceeds §19 deliberately: per-stage artifact refs are
 * lineage the next cycle can follow, additive to the prescription, never replacing it.
 */
export const nextCycleVitalInputSchema = z
  .object({
    cycle_id: entityIdSchema,
    produced_at: isoTimestampSchema,
    accepted_identity: z
      .object({
        project_id: z.string().min(1),
        git_remote: z.string().min(1).nullable(),
        branch: z.string().min(1),
        closing_snapshot_id: z.string().min(1).nullable(),
      })
      .strict(),
    master_benchmark: z
      .object({ version: z.string().min(1), closing_run: sha256Schema })
      .strict()
      .nullable(),
    environment_fingerprint: z
      .object({ node_version: z.string().min(1), platform: z.string().min(1), arch: z.string().min(1) })
      .strict(),
    intent_model_version: z.string().min(1).nullable(),
    coverage: z
      .array(
        z
          .object({
            subsystem: z.string().min(1),
            units: z.number().int().nonnegative(),
            coverage: z.number().min(0).max(1),
          })
          .strict(),
      )
      .nullable(),
    vital_signs: z
      .object({
        metric_values: z.number().int().nonnegative(),
        corpus_size: z.number().int().nonnegative(),
        trends: z.null(),
      })
      .strict()
      .nullable(),
    anomalies: z.array(z.object({ kind: z.string().min(1), detail: z.string().min(1) }).strict()),
    unresolved_uncertainty: z.array(z.string().min(1)),
    benchmark_maturity: z.enum(['absent', 'placeholder', 'locked']),
    negative_knowledge: z.array(z.string().min(1)),
    candidate_seeds: z
      .object({ seeds: z.array(z.string().min(1)), source: z.string().min(1) })
      .strict(),
    freshness: z
      .object({
        lock_digest: sha256Schema,
        mission_version: z.string().min(1),
        valid_while: z.string().min(1),
      })
      .strict(),
    stage_evidence: z.record(z.string(), sha256Schema.nullable()),
    stated_absences: z.array(z.object({ field: z.string().min(1), reason: z.string().min(1) }).strict()),
  })
  .strict();
export type NextCycleVitalInput = z.infer<typeof nextCycleVitalInputSchema>;

export const cycleClosedSchema = z
  .object({
    cycle_id: entityIdSchema,
    closed_at: isoTimestampSchema,
    stage_reached: cycleStageSchema,
    grade: cycleGradeSchema,
    criteria_met: z.boolean(),
    unmet: z.array(z.string().min(1)),
  })
  .strict()
  .refine((value) => value.criteria_met === (value.unmet.length === 0), {
    message: 'criteria_met must agree with the unmet list',
  });
export type CycleClosed = z.infer<typeof cycleClosedSchema>;

/**
 * Audit entry (spec §100). Written for every dispatched command, allowed or denied.
 *
 * `arguments_digest` stores a hash rather than raw arguments, so a command carrying
 * sensitive content still leaves a verifiable trace without persisting the content.
 */
export const auditEntrySchema = z
  .object({
    id: entityIdSchema,
    timestamp: isoTimestampSchema,
    actor: actorSchema,
    command: z.string().min(1),
    capability: z.string().min(1),
    target: z.string().min(1).nullable().default(null),
    arguments_digest: sha256Schema,
    decision: z.enum(['allowed', 'denied']),
    reason: z.string().min(1).nullable().default(null),
    mission_version: z.string().min(1),
    duration_ms: z.number().nonnegative().nullable().default(null),
  })
  .strict();

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/* ------------------------------------------------------------------------- */
/* Recognition and graph identity                                             */
/* ------------------------------------------------------------------------- */

/**
 * The identity grammar in force. A stored graph declares which one produced it.
 *
 * DEV-P1-31: this read `identity-v3` while `RECOGNITION_IDENTITY_ALGORITHM` in
 * `src/analysis/source/recognizer.ts` emitted `identity-v4`, so the governed schema rejected the
 * producer's own output. Every recognition artifact this build wrote was unreadable by this build:
 * `resultOf` threw on the enum, which broke `rehydrate`, `rehydrateAll`, the incremental merge's
 * full-oracle parity gate, and the property `graph.ts` states in its own header — that the graph
 * survives losing the database. Fifteen self-tests reported it correctly and continuously.
 *
 * The two constants must move together. They are deliberately in different files — the producer
 * names the algorithm it implements, the record schema names the grammar it will accept — and that
 * separation is right, but it means a bump to one without the other is silent until something reads
 * an artifact back. `selftest/graph-identity-parity.test.ts` closes that: it asserts the schema
 * accepts exactly what the recognizer emits, so the pair can never diverge again unnoticed.
 */
export const GRAPH_IDENTITY_VERSION = 'identity-v4';

/**
 * Accepted graph identity versions.
 *
 * A graph produced under a different identity grammar cannot be compared to one produced under
 * this grammar — unit ids mean different things — so reading a graph whose identity version is
 * not recognized must fail closed rather than silently compare across grammars.
 *
 * DEV-P1-31 — why this stays a single value rather than widening to accept `identity-v3` as
 * history. The catalogue migration (DEV-P1-19/20) set the opposite precedent deliberately: v3
 * catalogues still *load* so history remains readable, while a production-readiness gate stops them
 * governing a run. That precedent does not transfer here, and the reason is empirical rather than
 * stylistic: the workspace holds nine durable recognition artifacts and **none of them declares an
 * identity grammar at all** — they are pre-DEV-P0-05 records of the form `{ units, edges,
 * unresolved }`, read through the explicit legacy branch in `GraphRegistry.resultOf` that never
 * reaches this schema. There is no `identity-v3` history to preserve. Widening the enum would
 * therefore admit a grammar nothing ever wrote, and admitting it is not free: unit ids mean
 * different things between grammars, so a v3 result accepted here could be silently compared
 * against a v4 one by every consumer downstream. A single value fails closed, which is what the
 * paragraph above requires.
 */
export const graphIdentityVersionSchema = z.enum([GRAPH_IDENTITY_VERSION]);
export type GraphIdentityVersion = z.infer<typeof graphIdentityVersionSchema>;

/** How much of the program a recognition covered. */
export const recognitionExtractionScopeSchema = z.union([
  z.object({ mode: z.literal('full') }).strict(),
  z
    .object({ mode: z.literal('restricted'), files: z.array(relativePathSchema).min(1) })
    .strict(),
]);
export type RecognitionExtractionScope = z.infer<typeof recognitionExtractionScopeSchema>;

/**
 * The exact, versioned basis a recognition result was produced from (DEV-P0-03/08).
 *
 * Binding it is what lets a result hash prove which bytes and settings the recognizer analysed.
 * Every hash is a strict sha256, so a malformed digest — a truncated hash, an uppercase one, a
 * placeholder — is rejected here rather than trusted as identity. The scope and version fields
 * are required so a basis can never be partially specified.
 */
export const recognitionBasisSchema = z
  .object({
    identityAlgorithm: graphIdentityVersionSchema,
    recognizerVersion: z.string().min(1),
    tsconfigPath: z.string().min(1),
    compilerOptionsHash: sha256Schema,
    // DEV-P0-03: the exact compiler build (`ts.version`) and a hash of the raw tsconfig bytes the
    // result was drawn from. The recognizer always emits both, so they are required here — a basis
    // missing them is partially specified, which is exactly what this schema exists to reject.
    tsCompilerVersion: z.string().min(1),
    tsconfigHash: sha256Schema,
    programFileCount: z.number().int().nonnegative(),
    programFilesHash: sha256Schema,
    extractionScope: recognitionExtractionScopeSchema,
    snapshotId: z.string().min(1).optional(),
    captureId: z.string().min(1).optional(),
    lockfileHash: sha256Schema.optional(),
    projectRecognition: z
      .object({
        identityVersion: z.literal('clue-project-recognition-identity/1'),
        operationIdentity: z
          .object({
            projectId: projectIdSchema,
            targetRootIdentity: targetRootIdentitySchema,
            projectProfileHash: projectProfileHashSchema,
          })
          .strict(),
        profileGeneration: z.number().int().positive(),
        recognitionConfigHash: sha256Schema,
      })
      .strict()
      .optional(),
    // DEV-P0-03: whether the snapshot binding was byte-verified. Optional so a basis persisted before
    // this field existed still reads (as "unknown", which a recorder treats as unverified).
    snapshotParityVerified: z.boolean().optional(),
  })
  .strict();
export type RecognitionBasis = z.infer<typeof recognitionBasisSchema>;

/* ------------------------------------------------------------------------- */
/* Status document identity                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The identity header of a status document (Status Contract v5): its schema version, the moment
 * it was generated, and the named hashes that pin it to an exact mission, catalogue, snapshot,
 * and representation. Every hash is validated as a strict sha256 and the timestamp as a UTC
 * ISO-8601 instant, so a status document that carries a malformed hash or timestamp fails
 * closed instead of being published as a trustworthy account. Individual reports add their own
 * bodies; this is the header every one of them shares.
 */
export const statusHeaderSchema = z
  .object({
    schema_version: z.number().int().positive(),
    generated_at: isoTimestampSchema,
    hashes: z.record(z.string().min(1), sha256Schema),
  })
  .strict();
export type StatusHeader = z.infer<typeof statusHeaderSchema>;

/* ------------------------------------------------------------------------- */
/* Host responses                                                             */
/* ------------------------------------------------------------------------- */

/*
 * Results returned by the host process. The host runs outside CLUE's trust boundary, so its
 * replies are validated on arrival: every hash a host reports (a build-output digest, a file
 * hash) is a strict sha256, and every result is a closed shape. A malformed hash from the host
 * is rejected rather than recorded as evidence.
 */

export const shadowRefreshResultSchema = z
  .object({ head: z.string().min(1), refreshedAt: z.string().min(1) })
  .strict();
export type ShadowRefreshResult = z.infer<typeof shadowRefreshResultSchema>;

export const shadowRunResultSchema = z
  .object({
    script: z.string().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    stdoutSha256: sha256Schema,
    stderrSha256: sha256Schema,
    stdoutPath: z.string().min(1).nullable(),
    stderrPath: z.string().min(1).nullable(),
  })
  .strict();
export type ShadowRunResult = z.infer<typeof shadowRunResultSchema>;

export const gitResultSchema = z
  .object({
    verb: z.string().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    stdout: z.string(),
  })
  .strict();
export type GitResult = z.infer<typeof gitResultSchema>;

export const fsHashResultSchema = z
  .object({ sha256: sha256Schema, bytes: z.number().int().nonnegative() })
  .strict();
export type FsHashResult = z.infer<typeof fsHashResultSchema>;

export const fsStatResultSchema = z
  .object({
    exists: z.boolean(),
    isFile: z.boolean(),
    isDirectory: z.boolean(),
    bytes: z.number().int().nonnegative().nullable(),
    mtimeMs: z.number().nonnegative().nullable(),
  })
  .strict();
export type FsStatResult = z.infer<typeof fsStatResultSchema>;

export const browserLaunchResultSchema = z
  .object({
    started: z.boolean(),
    endpoint: z.string().min(1).nullable(),
    pid: z.number().int().nullable(),
  })
  .strict();
export type BrowserLaunchResult = z.infer<typeof browserLaunchResultSchema>;

export const browserStatusResultSchema = z
  .object({ running: z.boolean(), endpoint: z.string().min(1).nullable() })
  .strict();
export type BrowserStatusResult = z.infer<typeof browserStatusResultSchema>;

export const browserStopResultSchema = z.object({ stopped: z.boolean() }).strict();
export type BrowserStopResult = z.infer<typeof browserStopResultSchema>;

/**
 * The envelope every host reply arrives in: a correlation id, whether it succeeded, the result
 * payload, and an error code and message when it did not. The payload is validated against the
 * specific result schema for the verb that was sent; this shape guards the envelope itself.
 */
export const hostResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown(),
    code: z.string().min(1).nullable(),
    message: z.string().min(1).nullable(),
  })
  .strict();
export type HostResponse = z.infer<typeof hostResponseSchema>;

/* ------------------------------------------------------------------------- */
/* Validation helper                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Parses a value against a schema and, on failure, throws with every issue listed and
 * path-qualified.
 *
 * Generic over the SCHEMA, not over a value type. That distinction is the whole point:
 * a zod schema has two type parameters, an input and an output, and `.default(...)`
 * makes them differ — the input treats the field as optional, the output guarantees it.
 * Declaring the parameter as `z.ZodType<T>` collapses both onto one type variable, so
 * TypeScript resolves it to the input shape and every caller receives optional
 * properties it then cannot assign anywhere. Taking the schema type itself and
 * returning `z.infer<TSchema>` keeps the output type intact, which is what callers
 * actually hold after parsing.
 *
 * Boundary code uses this rather than a bare `.parse`, so a bad config file reports all
 * of its problems at once instead of one per run.
 */
export function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  context: string,
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');

  throw new Error(`Validation failed for ${context}:\n${issues}`);
}
