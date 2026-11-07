/**
 * Source-faithful Operational Console recorder.
 *
 * A transport boundary calls beginExchange with the exact outgoing text. The matching
 * response is recorded verbatim after policy redaction, then CLU-E may append a separate
 * interpretation. The recorder never rewrites the request into a prettier story.
 *
 * Owners: Directory §19.1 (`src/observability/` — the operational console store preserves
 * source-faithful exchanges; redaction is explicit and auditable), contract.ts (the wire
 * schema and its identity fields), store.ts (the append-only hash chain this writes into).
 *
 * Backlog: DEV-P1-23 — "require source channel, run/execution correlation, request/response
 * hashes, redaction decision, payload artifact for each exchange." Two clauses were not
 * enforced when this item was opened:
 *
 *   - `redactionApplied` was a caller-supplied claim, and one caller's expression was wrong
 *     in a way that wrote a false statement into the durable record. Now derived in
 *     `append()`; see the note there.
 *   - **Correlation was optional at every identity.** All four of `runId`, `physicalCallId`,
 *     `logicalSessionId` and `taskId` were `?: … | undefined`, so an exchange could be
 *     appended with no identity at all and nothing downstream could ever attach it to the
 *     execution that produced it. That is closed by `assertExchangeCorrelation` below.
 */

import { randomUUID } from 'node:crypto';

import { ArtifactStore } from '../../memory/artifactStore.js';
import { nowIso, type Sha256 } from '../../shared/ids.js';
import {
  type CurrentWorkContract,
  type OperationalConsoleChannel,
  type OperationalConsoleCinematicCue,
  type OperationalConsoleKind,
  type OperationalConsolePayload,
  type OperationalConsolePayloadFormat,
  type OperationalConsoleValidationState,
} from './contract.js';
import { redactOperationalText } from './redaction.js';
import { OperationalConsoleEventStore } from './store.js';

export interface OperationalConsoleRecorderOptions {
  readonly previewBytes?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface CommonEventContext {
  readonly sourceIds?: readonly string[] | undefined;
  readonly taskId?: string | null | undefined;
  readonly logicalSessionId?: string | null | undefined;
  readonly physicalCallId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly benchmarkId?: string | null | undefined;
  readonly proofContractId?: string | null | undefined;
  readonly patchId?: string | null | undefined;
  readonly landingId?: string | null | undefined;
}

export interface BeginExchangeInput extends CommonEventContext {
  readonly channel: OperationalConsoleChannel;
  readonly kind: Extract<OperationalConsoleKind, 'command' | 'request' | 'code'>;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly status: string;
  readonly nextAction?: string | null;
  readonly exactPayload: string;
  readonly payloadFormat: OperationalConsolePayloadFormat;
  readonly cinematicCue?: OperationalConsoleCinematicCue | null;
  readonly currentWork?: CurrentWorkContract | null;
}

export interface ReceiveExchangeInput extends CommonEventContext {
  readonly kind?: Extract<OperationalConsoleKind, 'response' | 'result' | 'error'>;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly status: string;
  readonly nextAction?: string | null;
  readonly exactPayload: string;
  readonly payloadFormat: OperationalConsolePayloadFormat;
  readonly durationMs?: number | null;
  readonly validationState?: OperationalConsoleValidationState;
  readonly cinematicCue?: OperationalConsoleCinematicCue | null;
  readonly currentWork?: CurrentWorkContract | null;
}

export interface SummaryInput extends CommonEventContext {
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly status: string;
  readonly nextAction?: string | null;
  readonly validationState: OperationalConsoleValidationState;
  readonly cinematicCue?: OperationalConsoleCinematicCue | null;
  readonly currentWork?: CurrentWorkContract | null;
  readonly payloadText?: string | null | undefined;
}

interface EventDraft {
  readonly channel: OperationalConsoleChannel;
  readonly direction: 'OUTBOUND' | 'INBOUND' | 'INTERNAL';
  readonly kind: OperationalConsoleKind;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly status: string;
  readonly payload: OperationalConsolePayload | null;
  readonly validationState: OperationalConsoleValidationState;
  readonly sourceIds?: readonly string[] | undefined;
  readonly taskId?: string | null | undefined;
  readonly logicalSessionId?: string | null | undefined;
  readonly physicalCallId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly benchmarkId?: string | null | undefined;
  readonly proofContractId?: string | null | undefined;
  readonly patchId?: string | null | undefined;
  readonly landingId?: string | null | undefined;
  readonly requestId?: string | null | undefined;
  readonly exchangeId?: string | null | undefined;
  readonly durationMs?: number | null | undefined;
  readonly nextAction?: string | null | undefined;
  readonly currentWork?: CurrentWorkContract | null | undefined;
  readonly cinematicCue?: OperationalConsoleCinematicCue | null | undefined;
}

export interface OperationalConsoleExchange {
  readonly exchangeId: string;
  readonly requestId: string;
  receive(input: ReceiveExchangeInput): void;
  summarize(input: SummaryInput): void;
  fail(error: unknown, context?: Omit<SummaryInput, 'validationState' | 'status'>): void;
}

export class OperationalConsoleRecorderError extends Error {
  public constructor(
    public readonly code: 'UNCORRELATED_EXCHANGE',
    message: string,
  ) {
    super(message);
    this.name = 'OperationalConsoleRecorderError';
  }
}

/**
 * The identities that can attach an exchange to the execution that produced it, in the
 * order the contract lists them (contract.ts:130-133). Any one of the four is sufficient:
 * they are not a hierarchy, they are four different true answers to "which execution was
 * this?" depending on which plane opened the exchange. The host client knows its call id
 * before it knows a run; a cycle would know its run before it knows a physical call.
 */
const CORRELATION_IDENTITIES = [
  'runId',
  'physicalCallId',
  'logicalSessionId',
  'taskId',
] as const;

function correlationIdentitiesOf(draft: EventDraft): readonly string[] {
  return CORRELATION_IDENTITIES.filter((field) => {
    const value = draft[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function mediaType(format: OperationalConsolePayloadFormat): string {
  switch (format) {
    case 'json':
      return 'application/json; charset=utf-8';
    case 'typescript':
    case 'javascript':
      return 'text/javascript; charset=utf-8';
    case 'wgsl':
      return 'text/wgsl; charset=utf-8';
    case 'markdown':
      return 'text/markdown; charset=utf-8';
    case 'powershell':
    case 'shell':
    case 'http':
    case 'text':
      return 'text/plain; charset=utf-8';
  }
}

export class OperationalConsoleRecorder {
  private readonly previewBytes: number;
  private readonly environment: Readonly<Record<string, string | undefined>>;

  public constructor(
    private readonly store: OperationalConsoleEventStore,
    private readonly artifacts: ArtifactStore,
    options: OperationalConsoleRecorderOptions = {},
  ) {
    this.previewBytes = Math.max(1024, options.previewBytes ?? 32 * 1024);
    this.environment = options.environment ?? process.env;
  }

  public beginExchange(input: BeginExchangeInput): OperationalConsoleExchange {
    const exchangeId = `EXC-${randomUUID()}`;
    const requestId = `REQ-${randomUUID()}`;
    this.append({
      ...input,
      direction: 'OUTBOUND',
      payload: this.persistPayload(input.exactPayload, input.payloadFormat, input.title),
      requestId,
      exchangeId,
      validationState: 'pending',
    });

    return {
      exchangeId,
      requestId,
      receive: (receiveInput) => {
        this.append({
          ...receiveInput,
          channel: input.channel,
          direction: 'INBOUND',
          kind: receiveInput.kind ?? 'response',
          payload: this.persistPayload(
            receiveInput.exactPayload,
            receiveInput.payloadFormat,
            receiveInput.title,
          ),
          requestId,
          exchangeId,
          validationState: receiveInput.validationState ?? 'received',
              sourceIds: receiveInput.sourceIds ?? input.sourceIds,
          taskId: receiveInput.taskId ?? input.taskId,
          logicalSessionId: receiveInput.logicalSessionId ?? input.logicalSessionId,
          physicalCallId: receiveInput.physicalCallId ?? input.physicalCallId,
          runId: receiveInput.runId ?? input.runId,
          benchmarkId: receiveInput.benchmarkId ?? input.benchmarkId,
          proofContractId: receiveInput.proofContractId ?? input.proofContractId,
          patchId: receiveInput.patchId ?? input.patchId,
          landingId: receiveInput.landingId ?? input.landingId,
        });
      },
      summarize: (summaryInput) => {
        this.append({
          ...summaryInput,
          channel: input.channel,
          direction: 'INTERNAL',
          kind: 'summary',
          payload:
            summaryInput.payloadText === undefined || summaryInput.payloadText === null
              ? null
              : this.persistPayload(summaryInput.payloadText, 'markdown', summaryInput.title),
          requestId,
          exchangeId,
          sourceIds: summaryInput.sourceIds ?? input.sourceIds,
          taskId: summaryInput.taskId ?? input.taskId,
          logicalSessionId: summaryInput.logicalSessionId ?? input.logicalSessionId,
          physicalCallId: summaryInput.physicalCallId ?? input.physicalCallId,
          runId: summaryInput.runId ?? input.runId,
          benchmarkId: summaryInput.benchmarkId ?? input.benchmarkId,
          proofContractId: summaryInput.proofContractId ?? input.proofContractId,
          patchId: summaryInput.patchId ?? input.patchId,
          landingId: summaryInput.landingId ?? input.landingId,
        });
      },
      fail: (error, context) => {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.append({
          channel: input.channel,
          direction: 'INBOUND',
          kind: 'error',
          title: context?.title ?? `${input.title} failed`,
          what: context?.what ?? input.what,
          why: context?.why ?? input.why,
          status: 'FAILED',
          nextAction: context?.nextAction ?? 'Inspect the returned error and decide whether to retry.',
          payload: this.persistPayload(message, 'text', `${input.title} error`),
          requestId,
          exchangeId,
          validationState: 'evidence_rejected',
              cinematicCue: context?.cinematicCue ?? 'error_fracture',
          currentWork: context?.currentWork ?? input.currentWork ?? null,
          sourceIds: context?.sourceIds ?? input.sourceIds ?? [],
          taskId: context?.taskId ?? input.taskId ?? null,
          logicalSessionId: context?.logicalSessionId ?? input.logicalSessionId ?? null,
          physicalCallId: context?.physicalCallId ?? input.physicalCallId ?? null,
          runId: context?.runId ?? input.runId ?? null,
          benchmarkId: context?.benchmarkId ?? input.benchmarkId ?? null,
          proofContractId: context?.proofContractId ?? input.proofContractId ?? null,
          patchId: context?.patchId ?? input.patchId ?? null,
          landingId: context?.landingId ?? input.landingId ?? null,
          durationMs: null,
        });
      },
    };
  }

  public recordState(input: {
    readonly channel: OperationalConsoleChannel;
    readonly title: string;
    readonly what: string;
    readonly why: string;
    readonly status: string;
    readonly nextAction?: string | null;
    readonly currentWork?: CurrentWorkContract | null;
    readonly cinematicCue?: OperationalConsoleCinematicCue | null;
    readonly context?: CommonEventContext;
  }): void {
    this.append({
      channel: input.channel,
      direction: 'INTERNAL',
      kind: 'state',
      title: input.title,
      what: input.what,
      why: input.why,
      status: input.status,
      nextAction: input.nextAction ?? null,
      payload: null,
      validationState: 'policy_accepted',
      cinematicCue: input.cinematicCue ?? 'checkpoint',
      currentWork: input.currentWork ?? null,
      sourceIds: input.context?.sourceIds ?? [],
      taskId: input.context?.taskId ?? null,
      logicalSessionId: input.context?.logicalSessionId ?? null,
      physicalCallId: input.context?.physicalCallId ?? null,
      runId: input.context?.runId ?? null,
      benchmarkId: input.context?.benchmarkId ?? null,
      proofContractId: input.context?.proofContractId ?? null,
      patchId: input.context?.patchId ?? null,
      landingId: input.context?.landingId ?? null,
      requestId: null,
      exchangeId: null,
      durationMs: null,
    });
  }

  private persistPayload(
    exactText: string,
    format: OperationalConsolePayloadFormat,
    label: string,
  ): OperationalConsolePayload {
    const redacted = redactOperationalText(exactText, this.environment);
    const artifact = this.artifacts.putText(redacted.text, {
      mediaType: mediaType(format),
      label: `Operational Console · ${label}`,
    });
    const encoded = Buffer.from(redacted.text, 'utf8');
    const complete = encoded.byteLength <= this.previewBytes;
    const preview = complete
      ? redacted.text
      : encoded.subarray(0, this.previewBytes).toString('utf8');
    return {
      preview,
      format,
      complete,
      byteLength: encoded.byteLength,
      artifactHash: artifact.hash as Sha256,
      redactionCount: redacted.count,
    };
  }

  /**
   * DEV-P1-23: an exchange must be correlatable, or it is not written.
   *
   * The rule is scoped to events carrying an `exchangeId`, and `recordState` is exempt by
   * construction because it passes `exchangeId: null`. A blanket requirement would have been
   * the wrong rule: `recordState` at daemon startup genuinely has no run, no call and no
   * task, and a rule that needs an exemption on its first day is a rule that was not thought
   * through. An exchange is different — it exists because some execution opened it, so an
   * exchange that cannot name that execution is recording an effect with no cause.
   *
   * All three production sites that open exchanges satisfy this without amendment, measured
   * before it was written rather than assumed: `hostClient.ts:1270` passes `physicalCallId:
   * id` unconditionally, `browserAgent.ts:233` passes `physicalCallId: CDP-${id}`
   * unconditionally, and `adapters.ts:41` forwards whatever its caller supplied. The
   * inheritance chain in `beginExchange` carries the identity onto every `receive`,
   * `summarize` and `fail` that follows, so satisfying it once at the open satisfies it for
   * the whole exchange.
   *
   * This throws rather than degrading, which is a deliberate cost. Refusing to append is
   * loud and recoverable; appending an orphan into an append-only hash-chained record is
   * silent and permanent. Nothing downstream can repair a durable event that names no
   * execution, so the only place the problem can be fixed is here, before the write.
   *
   * Residue, stated rather than hidden: this proves an exchange is *correlatable*, not that
   * `runId` is bound. `runId` is null on every event observed on the running daemon, and it
   * will stay null until `src/cycle/` exists to issue a run — there is no run to name. When
   * that lands, the stricter reading of "run correlation" becomes reachable and this
   * predicate is where it tightens.
   */
  private assertExchangeCorrelation(input: EventDraft): void {
    const exchangeId = input.exchangeId ?? null;
    if (exchangeId === null) return;
    if (correlationIdentitiesOf(input).length > 0) return;
    throw new OperationalConsoleRecorderError(
      'UNCORRELATED_EXCHANGE',
      `Operational Console exchange ${exchangeId} (${input.channel} ${input.kind}) carries no ` +
        `correlation identity. At least one of ${CORRELATION_IDENTITIES.join(', ')} must be a ` +
        `non-empty string on an event bearing an exchangeId.`,
    );
  }

  private append(input: EventDraft): void {
    this.assertExchangeCorrelation(input);
    this.store.append({
      occurredAt: nowIso(),
      sourceIds: input.sourceIds ?? [],
      taskId: input.taskId ?? null,
      logicalSessionId: input.logicalSessionId ?? null,
      physicalCallId: input.physicalCallId ?? null,
      runId: input.runId ?? null,
      benchmarkId: input.benchmarkId ?? null,
      proofContractId: input.proofContractId ?? null,
      patchId: input.patchId ?? null,
      landingId: input.landingId ?? null,
      requestId: input.requestId ?? null,
      exchangeId: input.exchangeId ?? null,
      durationMs: input.durationMs ?? null,
      nextAction: input.nextAction ?? null,
      currentWork: input.currentWork ?? null,
      cinematicCue: input.cinematicCue ?? null,
      channel: input.channel,
      direction: input.direction,
      kind: input.kind,
      title: input.title,
      what: input.what,
      why: input.why,
      status: input.status,
      payload: input.payload,
      validationState: input.validationState,
      // DEV-P1-23: derived, never asserted.
      //
      // `redactionApplied` used to be passed in by each call site: `true` at three of them,
      // `false` at one, and `summaryInput.payloadText !== undefined` at the fifth. That last
      // expression is true for `payloadText: null` — `null !== undefined` — while the same
      // condition sends `payload: null` a few lines above, so a summary with no payload recorded
      // "redaction was applied" over nothing. Reproduced before this change: kind `summary`,
      // `payload=null`, `redactionApplied=true`, in a hash-chained append-only record.
      //
      // A false statement in a durable record is worse than a missing one, because nothing
      // downstream can tell it from a true one. The condition is not a caller's to know anyway:
      // `persistPayload` is the only producer of a payload and it always runs the text through
      // `redactOperationalText`, so a payload existing IS redaction having been applied. Deriving
      // it here makes the field unfalsifiable by construction rather than correct by convention —
      // and the four call sites that previously had to get it right no longer can get it wrong.
      //
      // `redactionCount` inside the payload remains the separate and finer fact: whether anything
      // actually matched. Applied-and-matched-nothing and never-applied are different states and
      // stay distinguishable.
      redactionApplied: input.payload !== null,
    });
  }
}