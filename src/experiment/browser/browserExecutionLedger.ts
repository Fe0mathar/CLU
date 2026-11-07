/**
 * Immutable request/response evidence for governed browser executions.
 *
 * Command text is never persisted. The request binds its SHA-256 identity to one exact Project
 * Profile generation, Chrome instance, browser session and page. A terminal response may be
 * written exactly once and contains only a bounded, secret-free summary plus governed references.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import {
  fsyncDir,
  placeFileNoReplaceSync,
  replaceFileSync,
  writeAllSync,
} from '../../shared/durableFs.js';
import { canonicalJson, hashBytes, hashCanonicalJson, nowIso } from '../../shared/ids.js';
import {
  assertProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import {
  projectProfileRecordSchema,
  type ProjectProfileRecord,
} from '../../shared/schemas.js';
import { assertNoSecretMaterial } from '../../shared/secretSafety.js';
import { assertProjectProfileHash } from '../../control/projectProfiles/profileHash.js';
import type { BrowserSessionIdentity } from './browserAgent.js';
import type { GovernedBrowserTargetIdentity } from './browserTargetResolver.js';

export const BROWSER_EXECUTION_LEDGER_VERSION = 'clue-browser-execution-ledger/1' as const;
const MAX_RESULT_SUMMARY_BYTES = 512 * 1024;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const executionIdSchema = z.string().regex(/^BEXEC-[0-9a-f]{32}$/u);
const projectIdentitySchema = z
  .object({
    projectId: z.string().min(1),
    targetRootIdentity: z.string().min(1),
    projectProfileHash: z.string().min(1),
  })
  .strict();

export const browserExecutionRequestSchema = z
  .object({
    ledgerVersion: z.literal(BROWSER_EXECUTION_LEDGER_VERSION),
    browserExecutionId: executionIdSchema,
    projectIdentity: projectIdentitySchema,
    profileGeneration: z.number().int().positive(),
    missionBinding: z.string().min(1).nullable(),
    scenarioBinding: z.string().min(1).nullable(),
    proofBinding: z.string().min(1).nullable(),
    chromeInstanceId: z.string().min(1),
    browserSessionId: z.string().min(1),
    targetPageId: z.string().min(1),
    targetUrl: z.string().url(),
    targetOrigin: z.string().url(),
    chromeVersion: z.string().min(1),
    debugEndpoint: z.string().min(1),
    commandSha256: sha256Schema,
    timeoutMs: z.number().int().positive(),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserExecutionRequest = z.infer<typeof browserExecutionRequestSchema>;

export const browserExecutionResponseSchema = z
  .object({
    ledgerVersion: z.literal(BROWSER_EXECUTION_LEDGER_VERSION),
    browserExecutionId: executionIdSchema,
    projectIdentity: projectIdentitySchema,
    requestSha256: sha256Schema,
    status: z.enum(['COMPLETED', 'FAILED', 'TIMED_OUT']),
    resultSha256: sha256Schema.nullable(),
    resultSummary: z.unknown().nullable(),
    consoleEvidenceReferences: z.array(z.string().min(1).max(512)).max(1_024),
    performanceEvidenceReferences: z.array(z.string().min(1).max(512)).max(1_024),
    artifactReferences: z.array(z.string().min(1).max(512)).max(1_024),
    errorCode: z.string().min(1).max(128).nullable(),
    errorDetail: z.string().min(1).max(4096).nullable(),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'COMPLETED' && value.errorCode !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: 'COMPLETED response cannot carry an errorCode',
      });
    }
    if (value.status !== 'COMPLETED' && value.errorCode === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: 'FAILED/TIMED_OUT response requires an errorCode',
      });
    }
  });
export type BrowserExecutionResponse = z.infer<typeof browserExecutionResponseSchema>;

export const browserExecutionReceiptFileSchema = z
  .object({
    ledgerVersion: z.literal(BROWSER_EXECUTION_LEDGER_VERSION),
    browserExecutionId: executionIdSchema,
    projectIdentity: projectIdentitySchema,
    profileGeneration: z.number().int().positive(),
    requestSha256: sha256Schema,
    responseSha256: sha256Schema.nullable(),
  })
  .strict();
export type BrowserExecutionReceiptFile = z.infer<typeof browserExecutionReceiptFileSchema>;

export interface BrowserExecutionReceipt {
  readonly browserExecutionId: string;
  readonly request: BrowserExecutionRequest;
  readonly requestSha256: string;
  readonly response: BrowserExecutionResponse | null;
  readonly responseSha256: string | null;
  readonly directory: string;
}

export interface BeginBrowserExecutionInput {
  readonly target: GovernedBrowserTargetIdentity;
  readonly session: BrowserSessionIdentity;
  readonly command: string;
  readonly timeoutMs: number;
  readonly missionBinding?: string | null;
  readonly scenarioBinding?: string | null;
  readonly proofBinding?: string | null;
  readonly startedAt?: string;
}

export interface CompleteBrowserExecutionInput {
  readonly projectIdentity: ProjectOperationIdentity;
  readonly browserExecutionId: string;
  readonly status: 'COMPLETED' | 'FAILED' | 'TIMED_OUT';
  readonly resultSummary?: unknown;
  readonly consoleEvidenceReferences?: readonly string[];
  readonly performanceEvidenceReferences?: readonly string[];
  readonly artifactReferences?: readonly string[];
  readonly errorCode?: string | null;
  readonly errorDetail?: string | null;
  readonly completedAt?: string;
}

export class BrowserExecutionLedgerError extends Error {
  public constructor(
    public readonly code:
      | 'BROWSER_EXECUTION_NOT_FOUND'
      | 'BROWSER_EXECUTION_ALREADY_TERMINAL'
      | 'BROWSER_EXECUTION_IDENTITY_MISMATCH'
      | 'BROWSER_EXECUTION_EVIDENCE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserExecutionLedgerError';
  }
}

export class BrowserExecutionLedger {
  public readonly root: string;
  private readonly record: ProjectProfileRecord;
  private readonly identity: ProjectOperationIdentity;

  public constructor(
    recordInput: ProjectProfileRecord,
    options: { readonly root?: string } = {},
  ) {
    this.record = projectProfileRecordSchema.parse(recordInput);
    assertProjectProfileHash(this.record, `Project Profile ${this.record.profile.projectId}`);
    this.identity = operationIdentityFromProfileRecord(this.record);
    this.root = options.root ?? join(this.record.profile.state.artifactStoreRoot, 'browser-executions');
    mkdirSync(this.root, { recursive: true });
  }

  public begin(input: BeginBrowserExecutionInput): BrowserExecutionReceipt {
    assertProjectOperationIdentity(this.identity, input.target.projectIdentity, 'browser execution target');
    if (input.target.profileGeneration !== this.record.generation) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_IDENTITY_MISMATCH',
        `target profile generation ${String(input.target.profileGeneration)} does not match active generation ${String(this.record.generation)}`,
      );
    }
    if (input.session.projectIdentity === null) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_IDENTITY_MISMATCH',
        'browser session omitted Project Profile identity',
      );
    }
    assertProjectOperationIdentity(
      this.identity,
      input.session.projectIdentity,
      'browser execution session',
    );
    if (input.session.profileGeneration !== this.record.generation) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_IDENTITY_MISMATCH',
        `browser session generation ${String(input.session.profileGeneration)} does not match active generation ${String(this.record.generation)}`,
      );
    }
    if (
      input.session.chromeInstanceId !== input.target.chromeInstanceId ||
      input.session.targetId !== input.target.targetPageId ||
      input.session.targetUrl !== input.target.targetUrl ||
      input.session.endpoint !== input.target.debugEndpoint
    ) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_IDENTITY_MISMATCH',
        'browser session does not match the resolved Chrome instance, endpoint, page id, or target URL',
      );
    }
    if (input.session.product === null) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_EVIDENCE_INVALID',
        'browser session has no captured Chrome product/version identity',
      );
    }
    assertNoSecretMaterial(input.command, 'browser execution command');
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_EVIDENCE_INVALID',
        'browser execution timeout must be a positive integer',
      );
    }

    const browserExecutionId = `BEXEC-${randomBytes(16).toString('hex')}`;
    const request = browserExecutionRequestSchema.parse({
      ledgerVersion: BROWSER_EXECUTION_LEDGER_VERSION,
      browserExecutionId,
      projectIdentity: this.identity,
      profileGeneration: this.record.generation,
      missionBinding: input.missionBinding ?? null,
      scenarioBinding: input.scenarioBinding ?? null,
      proofBinding: input.proofBinding ?? null,
      chromeInstanceId: input.target.chromeInstanceId,
      browserSessionId: input.session.sessionId,
      targetPageId: input.target.targetPageId,
      targetUrl: input.target.targetUrl,
      targetOrigin: input.target.targetOrigin,
      chromeVersion: input.session.product,
      debugEndpoint: input.target.debugEndpoint,
      commandSha256: hashBytes(Buffer.from(input.command, 'utf8')),
      timeoutMs: input.timeoutMs,
      startedAt: input.startedAt ?? nowIso(),
    });
    assertNoSecretMaterial(request, 'browser execution request evidence');

    const directory = this.directoryFor(browserExecutionId);
    if (existsSync(directory)) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_EVIDENCE_INVALID',
        `browser execution directory already exists: ${directory}`,
      );
    }
    mkdirSync(directory, { recursive: false });
    fsyncDir(this.root);
    const requestBody = `${canonicalJson(request)}\n`;
    writeImmutable(join(directory, 'request.json'), requestBody);
    const requestSha256 = hashBytes(Buffer.from(requestBody, 'utf8'));
    writeReceipt(directory, {
      ledgerVersion: BROWSER_EXECUTION_LEDGER_VERSION,
      browserExecutionId,
      projectIdentity: this.identity,
      profileGeneration: this.record.generation,
      requestSha256,
      responseSha256: null,
    });
    return {
      browserExecutionId,
      request,
      requestSha256,
      response: null,
      responseSha256: null,
      directory,
    };
  }

  public complete(input: CompleteBrowserExecutionInput): BrowserExecutionReceipt {
    try {
      assertProjectOperationIdentity(this.identity, input.projectIdentity, 'browser execution completion');
    } catch (error) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_IDENTITY_MISMATCH',
        error instanceof Error ? error.message : String(error),
      );
    }
    const current = this.read(input.browserExecutionId);
    if (current.response !== null) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_ALREADY_TERMINAL',
        `browser execution ${input.browserExecutionId} already has a terminal response`,
      );
    }

    const resultSummary = input.resultSummary ?? null;
    assertNoSecretMaterial(resultSummary, 'browser execution result summary');
    if (Buffer.byteLength(canonicalJson(resultSummary), 'utf8') > MAX_RESULT_SUMMARY_BYTES) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_EVIDENCE_INVALID',
        `browser result summary exceeds ${String(MAX_RESULT_SUMMARY_BYTES)} bytes`,
      );
    }
    const errorDetail = input.errorDetail ?? null;
    if (errorDetail !== null) assertNoSecretMaterial(errorDetail, 'browser execution error detail');
    const references = {
      consoleEvidenceReferences: normalizeReferences(input.consoleEvidenceReferences ?? []),
      performanceEvidenceReferences: normalizeReferences(input.performanceEvidenceReferences ?? []),
      artifactReferences: normalizeReferences(input.artifactReferences ?? []),
    };
    assertNoSecretMaterial(references, 'browser execution evidence references');

    const response = browserExecutionResponseSchema.parse({
      ledgerVersion: BROWSER_EXECUTION_LEDGER_VERSION,
      browserExecutionId: input.browserExecutionId,
      projectIdentity: this.identity,
      requestSha256: current.requestSha256,
      status: input.status,
      resultSha256: resultSummary === null ? null : hashCanonicalJson(resultSummary),
      resultSummary,
      ...references,
      errorCode:
        input.status === 'COMPLETED'
          ? null
          : (input.errorCode ?? 'BROWSER_EXECUTION_FAILED'),
      errorDetail:
        input.status === 'COMPLETED'
          ? null
          : (errorDetail ?? 'Browser execution did not complete.'),
      completedAt: input.completedAt ?? nowIso(),
    });
    assertNoSecretMaterial(response, 'browser execution response evidence');

    const responseBody = `${canonicalJson(response)}\n`;
    writeImmutable(join(current.directory, 'response.json'), responseBody);
    const responseSha256 = hashBytes(Buffer.from(responseBody, 'utf8'));
    writeReceipt(current.directory, {
      ledgerVersion: BROWSER_EXECUTION_LEDGER_VERSION,
      browserExecutionId: input.browserExecutionId,
      projectIdentity: this.identity,
      profileGeneration: this.record.generation,
      requestSha256: current.requestSha256,
      responseSha256,
    });
    return { ...current, response, responseSha256 };
  }

  public read(browserExecutionIdInput: string): BrowserExecutionReceipt {
    const browserExecutionId = executionIdSchema.parse(browserExecutionIdInput);
    const directory = this.directoryFor(browserExecutionId);
    const requestPath = join(directory, 'request.json');
    const receiptPath = join(directory, 'receipt.json');
    if (!existsSync(requestPath)) {
      throw new BrowserExecutionLedgerError(
        'BROWSER_EXECUTION_NOT_FOUND',
        `browser execution ${browserExecutionId} does not exist`,
      );
    }
    if (!existsSync(receiptPath)) {
      throw evidenceInvalid(browserExecutionId, 'durable receipt.json is missing');
    }

    const requestBody = readFileSync(requestPath, 'utf8');
    const request = parseEvidence(
      browserExecutionRequestSchema,
      requestBody,
      browserExecutionId,
      'request.json',
    );
    if (request.browserExecutionId !== browserExecutionId) {
      throw evidenceInvalid(browserExecutionId, 'request.json carries another execution id');
    }
    assertIdentityOrInvalid(this.identity, request.projectIdentity, browserExecutionId, 'request');
    if (request.profileGeneration !== this.record.generation) {
      throw evidenceInvalid(
        browserExecutionId,
        `request generation ${String(request.profileGeneration)} does not match active generation ${String(this.record.generation)}`,
      );
    }
    const requestSha256 = hashBytes(Buffer.from(requestBody, 'utf8'));

    const receiptBody = readFileSync(receiptPath, 'utf8');
    const receipt = parseEvidence(
      browserExecutionReceiptFileSchema,
      receiptBody,
      browserExecutionId,
      'receipt.json',
    );
    if (receipt.browserExecutionId !== browserExecutionId) {
      throw evidenceInvalid(browserExecutionId, 'receipt.json carries another execution id');
    }
    assertIdentityOrInvalid(this.identity, receipt.projectIdentity, browserExecutionId, 'receipt');
    if (receipt.profileGeneration !== this.record.generation) {
      throw evidenceInvalid(
        browserExecutionId,
        `receipt generation ${String(receipt.profileGeneration)} does not match active generation ${String(this.record.generation)}`,
      );
    }
    if (receipt.requestSha256 !== requestSha256) {
      throw evidenceInvalid(browserExecutionId, 'receipt.json request hash does not match request.json');
    }

    const responsePath = join(directory, 'response.json');
    if (!existsSync(responsePath)) {
      if (receipt.responseSha256 !== null) {
        throw evidenceInvalid(browserExecutionId, 'receipt claims a terminal response that is missing');
      }
      return {
        browserExecutionId,
        request,
        requestSha256,
        response: null,
        responseSha256: null,
        directory,
      };
    }

    const responseBody = readFileSync(responsePath, 'utf8');
    const response = parseEvidence(
      browserExecutionResponseSchema,
      responseBody,
      browserExecutionId,
      'response.json',
    );
    if (response.browserExecutionId !== browserExecutionId) {
      throw evidenceInvalid(browserExecutionId, 'response.json carries another execution id');
    }
    assertIdentityOrInvalid(this.identity, response.projectIdentity, browserExecutionId, 'response');
    if (response.requestSha256 !== requestSha256) {
      throw evidenceInvalid(browserExecutionId, 'response is bound to another request');
    }
    const responseSha256 = hashBytes(Buffer.from(responseBody, 'utf8'));
    if (receipt.responseSha256 !== responseSha256) {
      throw evidenceInvalid(browserExecutionId, 'receipt.json response hash does not match response.json');
    }
    return {
      browserExecutionId,
      request,
      requestSha256,
      response,
      responseSha256,
      directory,
    };
  }

  public readAll(): readonly BrowserExecutionReceipt[] {
    if (!existsSync(this.root)) return [];
    const receipts = readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^BEXEC-[0-9a-f]{32}$/u.test(entry.name))
      .map((entry) => this.read(entry.name))
      .sort((left, right) =>
        left.request.startedAt.localeCompare(right.request.startedAt) ||
        left.browserExecutionId.localeCompare(right.browserExecutionId),
      );
    return Object.freeze(receipts);
  }

  private directoryFor(browserExecutionId: string): string {
    return join(this.root, browserExecutionId);
  }
}

function normalizeReferences(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))],
  );
}

function writeImmutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const descriptor = openSync(temp, 'wx', 0o600);
  try {
    writeAllSync(descriptor, Buffer.from(body, 'utf8'));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const placed = placeFileNoReplaceSync(temp, path);
  if (placed === 'exists') {
    throw new BrowserExecutionLedgerError(
      'BROWSER_EXECUTION_ALREADY_TERMINAL',
      `immutable browser evidence already exists at ${path}`,
    );
  }
}

function evidenceInvalid(browserExecutionId: string, detail: string): BrowserExecutionLedgerError {
  return new BrowserExecutionLedgerError(
    'BROWSER_EXECUTION_EVIDENCE_INVALID',
    `browser execution ${browserExecutionId}: ${detail}`,
  );
}

function assertIdentityOrInvalid(
  expected: ProjectOperationIdentity,
  actual: ProjectOperationIdentity,
  browserExecutionId: string,
  source: string,
): void {
  try {
    assertProjectOperationIdentity(expected, actual, `browser execution ${source}`);
  } catch (error) {
    throw evidenceInvalid(
      browserExecutionId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseEvidence<T>(
  schema: z.ZodType<T>,
  body: string,
  browserExecutionId: string,
  source: string,
): T {
  try {
    return schema.parse(JSON.parse(body) as unknown);
  } catch (error) {
    throw evidenceInvalid(
      browserExecutionId,
      `${source} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeReceipt(directory: string, receiptInput: BrowserExecutionReceiptFile): void {
  const receipt = browserExecutionReceiptFileSchema.parse(receiptInput);
  assertNoSecretMaterial(receipt, 'browser execution receipt evidence');
  const path = join(directory, 'receipt.json');
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const descriptor = openSync(temp, 'wx', 0o600);
  try {
    writeAllSync(descriptor, Buffer.from(`${canonicalJson(receipt)}
`, 'utf8'));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  replaceFileSync(temp, path);
}
