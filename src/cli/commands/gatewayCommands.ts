/** `clue gateway` — governed Model Gateway surface (DEV-P2-09). */

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import {
  invokeGateway,
  loadGatewayRequest,
  readGatewayStatus,
  reconcileGatewayBatch,
  resumeGatewayProvider,
  type GatewayInvocationResult,
} from '../../ai/gateway/modelGateway.js';
import { printChecks, short, write } from '../output/formatter.js';

function money(value: number | null): string {
  return value === null ? 'N/A' : `$${value.toFixed(6)}`;
}

function printInvocation(result: GatewayInvocationResult): number {
  switch (result.state) {
    case 'refused':
      printChecks([
        { level: 'warn', label: 'gateway', detail: `REFUSED · ${result.code}` },
        { level: 'info', label: 'call', detail: result.callId },
        { level: 'info', label: 'reason', detail: result.reason },
      ]);
      return 1;
    case 'failed':
      printChecks([
        { level: 'fail', label: 'gateway', detail: `FAILED · ${result.code}` },
        { level: 'info', label: 'call', detail: result.callId },
        { level: 'info', label: 'retryable', detail: String(result.retryable) },
        { level: 'info', label: 'reason', detail: result.reason },
      ]);
      return 1;
    case 'batch_pending':
      printChecks([
        { level: 'ok', label: 'gateway', detail: 'BATCH SUBMITTED' },
        { level: 'ok', label: 'call', detail: result.callId },
        { level: 'ok', label: 'provider batch', detail: result.providerBatchId },
        { level: 'info', label: 'provider status', detail: result.providerStatus },
        { level: 'info', label: 'reserved', detail: money(result.record.estimatedUsd) },
      ]);
      return 0;
    case 'completed':
      printChecks([
        { level: 'ok', label: 'gateway', detail: 'COMPLETED' },
        { level: 'ok', label: 'call', detail: result.callId },
        { level: 'ok', label: 'response artifact', detail: short(result.record.responseArtifactHash ?? '') },
        { level: 'info', label: 'actual cost', detail: money(result.record.actualUsd ?? 0) },
      ]);
      write('');
      write(result.outputText);
      return 0;
  }
}

function commandGatewayStatus(): number {
  return withRuntime({ withLog: false, readOnly: true }, (runtime) => {
    const status = readGatewayStatus(runtime);
    printChecks([
      {
        level: status.enabled ? (status.operationallyReady ? 'ok' : 'fail') : 'info',
        label: 'gateway',
        detail: status.enabled
          ? status.operationallyReady
            ? 'enabled and operationally ready'
            : 'enabled but policy is not ready'
          : 'implemented and disabled by installation policy',
      },
      { level: 'info', label: 'provider', detail: `${status.provider} · ${status.model ?? 'no model'}` },
      { level: 'info', label: 'budget authority', detail: status.budgetAuthority },
      { level: status.providerPaused ? 'fail' : 'ok', label: 'provider state', detail: status.providerPaused ? `LACK OF $ · ${status.providerPauseReason ?? 'provider budget exhausted'}` : status.providerState },
      { level: status.apiKeyPresent ? 'ok' : 'info', label: 'credential env', detail: `${status.apiKeyEnv} · ${status.apiKeyPresent ? 'present' : 'absent'}` },
      { level: status.enabledRouteCount > 0 ? 'ok' : 'info', label: 'routes', detail: `${status.enabledRouteCount} enabled` },
      { level: 'info', label: 'budget policy', detail: short(status.budgetHash) },
      { level: 'info', label: 'routing policy', detail: short(status.routingHash) },
      { level: 'info', label: 'calls', detail: `${status.submitted} submitted · ${status.completed} complete · ${status.pending} pending · ${status.failed} failed · ${status.refused} refused` },
      { level: 'info', label: 'token usage', detail: `${status.usage.totalTokens} total · ${status.usage.inputTokens} input · ${status.usage.outputTokens} output` },
      { level: 'info', label: 'observed cost', detail: `${money(status.todayActualUsd)} today · ${money(status.monthActualUsd)} month · OpenAI Platform owns limits` },
      ...status.policyProblems.map((problem) => ({ level: 'info' as const, label: 'policy', detail: problem })),
    ]);
    return status.enabled && !status.operationallyReady ? 1 : 0;
  });
}

export function registerGatewayCommands(program: Command): void {
  const gateway = program.command('gateway').description('governed OpenAI Model Gateway');
  gateway
    .command('status')
    .description('show governed gateway policy and event-backed accounting')
    .action(() => {
      process.exitCode = commandGatewayStatus();
    });
  gateway
    .command('invoke')
    .description('submit one strict versioned request through the governed gateway')
    .requiredOption('--request <path>', 'strict gateway request JSON')
    .action(async (options: { request: string }) => {
      try {
        process.exitCode = printInvocation(await invokeGateway(loadGatewayRequest(options.request)));
      } catch (error) {
        write(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
  gateway
    .command('resume')
    .description('probe the approved OpenAI model and clear a controlled provider-budget pause')
    .action(async () => {
      try {
        const resumed = await resumeGatewayProvider();
        printChecks([
          { level: 'ok', label: 'gateway', detail: 'PROVIDER RESUMED' },
          { level: 'ok', label: 'model', detail: resumed.model },
          { level: 'ok', label: 'event', detail: resumed.eventId },
        ]);
        process.exitCode = 0;
      } catch (error) {
        write(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
  gateway
    .command('reconcile')
    .description('poll and durably reconcile one pending provider batch')
    .argument('<call-id>', 'GWCALL-… identity')
    .action(async (callId: string) => {
      try {
        process.exitCode = printInvocation(await reconcileGatewayBatch(callId));
      } catch (error) {
        write(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
