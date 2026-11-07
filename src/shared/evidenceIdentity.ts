/**
 * The evidence spine.
 *
 * Many P0 defects are not independent: they arise because identities are passed piecemeal between
 * subsystems, so a stale snapshot, a relabelled packet, or a mismatched mission can slip through a
 * boundary that only checked one field. This module is the single shared spine the closure plan calls
 * for (progress recommendation v2, §7) — one set of branded identifiers and one chain mechanism, so
 * that two guarantees hold everywhere:
 *
 *   1. One identity never refers to two different governed things. Every spine identifier is branded
 *      per role, so the compiler refuses to pass a MissionBasisHash where a ContextBasisHash is
 *      required, even though both are lowercase-hex sha256 strings.
 *   2. One accepted state is exactly bound to everything before it. Each stage records the *binding
 *      hash* of the stage before it; sealing a stage is a canonical hash over all of its fields, so
 *      changing any ancestor changes every descendant's expected binding — and a consumer verifies the
 *      chain, link by link, before accepting the next state.
 *
 * The spine chain, root to leaf:
 *
 *   mission          MissionBasisHash
 *   snapshot         SnapshotContentId + ManifestHash + CaptureId
 *   recognition      RecognitionRunId + RecognitionStateKey + ResultHash + ArtifactHash
 *   task             TaskId + Attempt + LeaseTokenHash + LeaseExpiry
 *   context          ContextBasisHash
 *   packet           PacketBasisHash + BundleHash + OutputSchemaAuthorityHash
 *   accepted-result  AcceptedResultHash + AuditExecutionId + HostReceiptHash
 *
 * This is deliberately not a feature layer or a giant object. It is types, strict schemas, and two
 * pure functions — `sealLink` and `verifyLink` — that the truth, authority, packet, and context
 * kernels all build on.
 */

import { z } from 'zod';

import { hashCanonicalJson, type Sha256 } from './ids.js';

/* ------------------------------------------------------------------------- */
/* Branded identifiers                                                        */
/* ------------------------------------------------------------------------- */

/** A lowercase-hex sha256 digest, before it is branded to a specific spine role. */
const HEX64 = /^[0-9a-f]{64}$/u;

type Sha256Branded<Role extends string> = string & { readonly __evidence: Role };

export type MissionBasisHash = Sha256Branded<'MissionBasisHash'>;
export type SnapshotContentId = Sha256Branded<'SnapshotContentId'>;
export type ManifestHash = Sha256Branded<'ManifestHash'>;
export type RecognitionStateKey = Sha256Branded<'RecognitionStateKey'>;
export type ResultHash = Sha256Branded<'ResultHash'>;
export type ArtifactHash = Sha256Branded<'ArtifactHash'>;
export type LeaseTokenHash = Sha256Branded<'LeaseTokenHash'>;
export type ContextBasisHash = Sha256Branded<'ContextBasisHash'>;
export type PacketBasisHash = Sha256Branded<'PacketBasisHash'>;
export type BundleHash = Sha256Branded<'BundleHash'>;
export type OutputSchemaAuthorityHash = Sha256Branded<'OutputSchemaAuthorityHash'>;
export type HostReceiptHash = Sha256Branded<'HostReceiptHash'>;
export type AcceptedResultHash = Sha256Branded<'AcceptedResultHash'>;

/** The hash of a sealed spine link — what the next stage binds to. Branded so it cannot be confused
 * with a role hash above; a binding hash is a fingerprint of a whole stage, not of one artifact. */
export type BindingHash = Sha256Branded<'BindingHash'>;

type IdBranded<Role extends string> = string & { readonly __evidence: Role };

export type CaptureId = IdBranded<'CaptureId'>;
export type RecognitionRunId = IdBranded<'RecognitionRunId'>;
export type TaskId = IdBranded<'TaskId'>;
export type AuditExecutionId = IdBranded<'AuditExecutionId'>;

/** Raised when a value offered as a spine identifier is not the shape that role requires. */
export class EvidenceIdentityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EvidenceIdentityError';
  }
}

/** Raised when a spine link does not bind to the predecessor it is verified against. */
export class EvidenceChainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EvidenceChainError';
  }
}

/**
 * Validates that `value` is a lowercase-hex sha256 and brands it to `role`. The role is carried only
 * in the message and the phantom type; every hash-shaped spine identifier is validated through here,
 * so a malformed digest fails at the boundary rather than deep inside a consumer.
 */
export function requireSpineHash<Role extends string>(value: string, role: Role): Sha256Branded<Role> {
  if (!HEX64.test(value)) {
    throw new EvidenceIdentityError(`${role} must be a lowercase-hex sha256 digest, got ${JSON.stringify(value)}`);
  }
  return value as Sha256Branded<Role>;
}

/** Validates that `value` is a non-empty identifier and brands it to `role`. */
export function requireSpineId<Role extends string>(value: string, role: Role): IdBranded<Role> {
  if (value.length === 0) {
    throw new EvidenceIdentityError(`${role} must be a non-empty identifier`);
  }
  return value as IdBranded<Role>;
}

/** A plain Sha256 (from ids.ts) re-branded to a spine role, for callers that already hold a digest. */
export function asSpineHash<Role extends string>(hash: Sha256, role: Role): Sha256Branded<Role> {
  return requireSpineHash(hash, role);
}

/* ------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* ------------------------------------------------------------------------- */

/*
 * The schemas validate the *shape* of a link parsed from untrusted JSON — that every hash field is a
 * lowercase-hex sha256 and every id field is non-empty. Branding is a compile-time concern carried by
 * the interfaces and the `require*` constructors; `parseEvidenceLink` casts a validated link to its
 * branded interface. Keeping branding out of the schemas avoids fighting Zod's discriminated union.
 */
const hex64Field = (role: string): z.ZodString =>
  z.string().regex(HEX64, `${role} must be a lowercase-hex sha256 digest`);

const idField = (role: string): z.ZodString => z.string().min(1, `${role} must be a non-empty identifier`);

/* ------------------------------------------------------------------------- */
/* Spine links                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The ordered stages of the spine. The order is load-bearing: `verifyLink` uses it to refuse a link
 * whose predecessor is the wrong kind (a packet that claims to bind directly to a snapshot, say).
 */
export const EVIDENCE_STAGES = [
  'mission',
  'snapshot',
  'recognition',
  'task',
  'context',
  'packet',
  'accepted-result',
] as const;

export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

const PREDECESSOR: Readonly<Record<EvidenceStage, EvidenceStage | null>> = {
  mission: null,
  snapshot: 'mission',
  recognition: 'snapshot',
  task: 'recognition',
  context: 'task',
  packet: 'context',
  'accepted-result': 'packet',
};

export interface MissionLink {
  readonly stage: 'mission';
  /** The root of the chain binds to nothing before it. */
  readonly boundTo: null;
  readonly missionBasisHash: MissionBasisHash;
}

export interface SnapshotLink {
  readonly stage: 'snapshot';
  readonly boundTo: BindingHash;
  readonly snapshotContentId: SnapshotContentId;
  readonly manifestHash: ManifestHash;
  readonly captureId: CaptureId;
}

export interface RecognitionLink {
  readonly stage: 'recognition';
  readonly boundTo: BindingHash;
  readonly recognitionRunId: RecognitionRunId;
  readonly recognitionStateKey: RecognitionStateKey;
  readonly resultHash: ResultHash;
  readonly artifactHash: ArtifactHash;
}

export interface TaskLink {
  readonly stage: 'task';
  readonly boundTo: BindingHash;
  readonly taskId: TaskId;
  readonly attempt: number;
  readonly leaseTokenHash: LeaseTokenHash;
  /** ISO-8601 expiry of the lease this work was authorised under, or null for a lease with no expiry. */
  readonly leaseExpiry: string | null;
}

export interface ContextLink {
  readonly stage: 'context';
  readonly boundTo: BindingHash;
  readonly contextBasisHash: ContextBasisHash;
}

export interface PacketLink {
  readonly stage: 'packet';
  readonly boundTo: BindingHash;
  readonly packetBasisHash: PacketBasisHash;
  readonly bundleHash: BundleHash;
  readonly outputSchemaAuthorityHash: OutputSchemaAuthorityHash;
}

export interface AcceptedResultLink {
  readonly stage: 'accepted-result';
  readonly boundTo: BindingHash;
  readonly acceptedResultHash: AcceptedResultHash;
  readonly auditExecutionId: AuditExecutionId;
  readonly hostReceiptHash: HostReceiptHash;
}

export type EvidenceLink =
  | MissionLink
  | SnapshotLink
  | RecognitionLink
  | TaskLink
  | ContextLink
  | PacketLink
  | AcceptedResultLink;

export const missionLinkSchema = z
  .object({
    stage: z.literal('mission'),
    boundTo: z.null(),
    missionBasisHash: hex64Field('MissionBasisHash'),
  })
  .strict();

export const snapshotLinkSchema = z
  .object({
    stage: z.literal('snapshot'),
    boundTo: hex64Field('BindingHash'),
    snapshotContentId: hex64Field('SnapshotContentId'),
    manifestHash: hex64Field('ManifestHash'),
    captureId: idField('CaptureId'),
  })
  .strict();

export const recognitionLinkSchema = z
  .object({
    stage: z.literal('recognition'),
    boundTo: hex64Field('BindingHash'),
    recognitionRunId: idField('RecognitionRunId'),
    recognitionStateKey: hex64Field('RecognitionStateKey'),
    resultHash: hex64Field('ResultHash'),
    artifactHash: hex64Field('ArtifactHash'),
  })
  .strict();

export const taskLinkSchema = z
  .object({
    stage: z.literal('task'),
    boundTo: hex64Field('BindingHash'),
    taskId: idField('TaskId'),
    attempt: z.number().int().nonnegative(),
    leaseTokenHash: hex64Field('LeaseTokenHash'),
    leaseExpiry: z.string().min(1).nullable(),
  })
  .strict();

export const contextLinkSchema = z
  .object({
    stage: z.literal('context'),
    boundTo: hex64Field('BindingHash'),
    contextBasisHash: hex64Field('ContextBasisHash'),
  })
  .strict();

export const packetLinkSchema = z
  .object({
    stage: z.literal('packet'),
    boundTo: hex64Field('BindingHash'),
    packetBasisHash: hex64Field('PacketBasisHash'),
    bundleHash: hex64Field('BundleHash'),
    outputSchemaAuthorityHash: hex64Field('OutputSchemaAuthorityHash'),
  })
  .strict();

export const acceptedResultLinkSchema = z
  .object({
    stage: z.literal('accepted-result'),
    boundTo: hex64Field('BindingHash'),
    acceptedResultHash: hex64Field('AcceptedResultHash'),
    auditExecutionId: idField('AuditExecutionId'),
    hostReceiptHash: hex64Field('HostReceiptHash'),
  })
  .strict();

const evidenceLinkUnion = z.discriminatedUnion('stage', [
  missionLinkSchema,
  snapshotLinkSchema,
  recognitionLinkSchema,
  taskLinkSchema,
  contextLinkSchema,
  packetLinkSchema,
  acceptedResultLinkSchema,
]);

/** Validates the shape of a link parsed from untrusted JSON and returns it as a branded EvidenceLink.
 * The brand is a compile-time tag; the runtime guarantee is the format validation above. */
export function parseEvidenceLink(value: unknown): EvidenceLink {
  return evidenceLinkUnion.parse(value) as unknown as EvidenceLink;
}

/* ------------------------------------------------------------------------- */
/* Seal and verify                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Seals a link into its binding hash — a canonical hash over every field, including `boundTo`. Because
 * `boundTo` is part of the input, the binding hash of any stage transitively depends on every stage
 * before it: change a mission field and the snapshot, recognition, task, context, and packet binding
 * hashes all change. The next stage records this value in its own `boundTo`.
 */
export function sealLink(link: EvidenceLink): BindingHash {
  return hashCanonicalJson(link) as string as BindingHash;
}

/**
 * Verifies that `link` is the correct successor of `predecessor`: the stage order must be exact, and
 * `link.boundTo` must equal the freshly recomputed seal of `predecessor`. A stored `boundTo` is never
 * trusted on its own — it is checked against the predecessor as it actually is now, so a predecessor
 * that was altered after the fact is caught here. Throws `EvidenceChainError` on any mismatch.
 */
export function verifyLink(link: Exclude<EvidenceLink, MissionLink>, predecessor: EvidenceLink): void {
  const expectedPredecessorStage = PREDECESSOR[link.stage];
  if (predecessor.stage !== expectedPredecessorStage) {
    throw new EvidenceChainError(
      `a ${link.stage} link must bind to a ${String(expectedPredecessorStage)} link, not a ${predecessor.stage} link`,
    );
  }
  const expected = sealLink(predecessor);
  if (link.boundTo !== expected) {
    throw new EvidenceChainError(
      `${link.stage} link does not bind to its predecessor: bound to ${link.boundTo}, predecessor seals to ${expected}`,
    );
  }
}

/**
 * Verifies a whole chain from mission to its leaf in order. The first link must be the mission root
 * (bound to nothing); every later link must bind to the one before it. Returns the leaf's binding
 * hash, which a packet or accepted-result identity can fold in so tampering anywhere in the chain
 * invalidates the leaf. Throws `EvidenceChainError` on the first break.
 */
export function verifyChain(chain: readonly EvidenceLink[]): BindingHash {
  const head = chain[0];
  if (head === undefined || head.stage !== 'mission') {
    throw new EvidenceChainError('an evidence chain must begin with a mission link');
  }
  let previous: EvidenceLink = head;
  for (let index = 1; index < chain.length; index += 1) {
    const link = chain[index];
    if (link === undefined || link.stage === 'mission') {
      throw new EvidenceChainError(`link ${index} is missing or is a second mission root`);
    }
    verifyLink(link, previous);
    previous = link;
  }
  return sealLink(previous);
}
