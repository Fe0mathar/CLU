/** Transport-neutral helpers that mirror real requests and responses into the console. */

import type {
  OperationalConsoleChannel,
  OperationalConsoleCinematicCue,
  OperationalConsolePayloadFormat,
  OperationalConsoleValidationState,
} from './contract.js';
import { OperationalConsoleRecorder, type CommonEventContext } from './recorder.js';

export interface MirrorOperationSpec<T> extends CommonEventContext {
  readonly channel: OperationalConsoleChannel;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly nextAction: string;
  readonly exactRequest: string;
  readonly requestFormat: OperationalConsolePayloadFormat;
  readonly responseFormat: OperationalConsolePayloadFormat;
  readonly requestCue?: OperationalConsoleCinematicCue;
  readonly responseCue?: OperationalConsoleCinematicCue;
  readonly execute: () => Promise<T>;
  readonly exactResponse: (value: T) => string;
  readonly summarize: (value: T) => {
    readonly title: string;
    readonly what: string;
    readonly why: string;
    readonly status: string;
    readonly nextAction: string;
    readonly validationState: OperationalConsoleValidationState;
    readonly payloadText?: string;
    readonly cue?: OperationalConsoleCinematicCue;
  };
}

export async function mirrorOperation<T>(
  recorder: OperationalConsoleRecorder,
  spec: MirrorOperationSpec<T>,
): Promise<T> {
  const started = performance.now();
  const exchange = recorder.beginExchange({
    channel: spec.channel,
    kind: spec.channel === 'POWERSHELL' ? 'command' : 'request',
    title: spec.title,
    what: spec.what,
    why: spec.why,
    status: 'TRANSMITTING',
    nextAction: spec.nextAction,
    exactPayload: spec.exactRequest,
    payloadFormat: spec.requestFormat,
    cinematicCue: spec.requestCue ?? 'transmit',
    sourceIds: spec.sourceIds,
    taskId: spec.taskId,
    logicalSessionId: spec.logicalSessionId,
    physicalCallId: spec.physicalCallId,
    runId: spec.runId,
    benchmarkId: spec.benchmarkId,
    proofContractId: spec.proofContractId,
    patchId: spec.patchId,
    landingId: spec.landingId,
  });

  try {
    const value = await spec.execute();
    const durationMs = performance.now() - started;
    exchange.receive({
      title: `${spec.title} response`,
      what: spec.what,
      why: spec.why,
      status: 'RESPONSE RECEIVED',
      nextAction: 'Validate the response before treating it as evidence.',
      exactPayload: spec.exactResponse(value),
      payloadFormat: spec.responseFormat,
      durationMs,
      validationState: 'received',
      cinematicCue: spec.responseCue ?? 'receive',
    });
    const summary = spec.summarize(value);
    exchange.summarize({
      title: summary.title,
      what: summary.what,
      why: summary.why,
      status: summary.status,
      nextAction: summary.nextAction,
      validationState: summary.validationState,
      cinematicCue: summary.cue ?? 'checkpoint',
      payloadText: summary.payloadText,
    });
    return value;
  } catch (error) {
    exchange.fail(error);
    throw error;
  }
}
