/**
 * Atomic owner of the one active Project Profile runtime generation.
 *
 * A target runtime is fully opened and identity-checked before the registry active pointer moves.
 * While switching, all leases are refused. If publication fails after the pointer move, the manager
 * rolls the registry back to the previous project; a failed rollback enters BLOCKED rather than
 * exposing a mixed A/B generation.
 */

import {
  openRuntime,
  type Runtime,
  type RuntimeOptions,
} from '../runtime.js';
import {
  assertProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  projectOperationIdentityEquals,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import type { Actor, ProjectProfileRecord } from '../../shared/schemas.js';
import type { WorkspaceIdentityMissingPolicy } from '../../memory/db.js';
import { hashCanonicalJson } from '../../shared/ids.js';
import {
  ProjectProfileRegistry,
  type ActiveProjectPointer,
} from './profileRegistry.js';
import type {
  ProjectBrowserSessionCoordinator,
  ProjectBrowserSessionPublication,
  ProjectBrowserSwitchTransaction,
} from './projectBrowserSessions.js';

export type ProjectRuntimeManagerState =
  | 'INACTIVE'
  | 'STARTING'
  | 'ACTIVE'
  | 'SWITCHING'
  | 'BLOCKED'
  | 'DISPOSED';

export type ProjectRuntimeSwitchFaultPoint =
  | 'after-target-profile-load'
  | 'after-target-runtime-open'
  | 'before-registry-activation'
  | 'after-registry-activation'
  | 'before-browser-publication'
  | 'after-browser-publication'
  | 'before-runtime-publication';

export type ProjectRuntimeManagerErrorCode =
  | 'PROJECT_RUNTIME_INACTIVE'
  | 'PROJECT_RUNTIME_BUSY'
  | 'PROJECT_RUNTIME_SWITCH_IN_PROGRESS'
  | 'PROJECT_RUNTIME_BLOCKED'
  | 'PROJECT_RUNTIME_DISPOSED'
  | 'PROJECT_RUNTIME_IDENTITY_CONTRADICTION'
  | 'PROJECT_RUNTIME_POINTER_CONTRADICTION'
  | 'PROJECT_RUNTIME_ROLLBACK_FAILED';

export class ProjectRuntimeManagerError extends Error {
  public readonly code: ProjectRuntimeManagerErrorCode;
  public readonly causeError: unknown;

  public constructor(
    code: ProjectRuntimeManagerErrorCode,
    message: string,
    causeError: unknown = null,
  ) {
    super(message);
    this.name = 'ProjectRuntimeManagerError';
    this.code = code;
    this.causeError = causeError;
  }
}

export interface ProjectRuntimePublication {
  readonly runtimeGeneration: number;
  readonly projectId: string;
  readonly targetRootIdentity: string;
  readonly projectProfileHash: string;
  readonly profileGeneration: number;
  readonly registryGeneration: number;
  readonly databaseIdentity: string;
  readonly greatBookIdentity: string;
  readonly targetRoot: string;
  readonly inventorySnapshotIdentity: string;
  readonly workspaceRoot: string;
  readonly activatedAt: string;
  /** Browser target published in the same project generation, or explicit absence. */
  readonly browserSession: ProjectBrowserSessionPublication;
}

export interface ProjectRuntimeLease {
  readonly runtimeGeneration: number;
  readonly identity: ProjectOperationIdentity;
  readonly runtime: Runtime;
  release(): void;
}

export interface ProjectRuntimeActivationRequest {
  readonly projectId: string;
  readonly actor: Actor;
  readonly reason?: string;
  /** Optional stale-controller guard. */
  readonly expectedCurrentIdentity?: ProjectOperationIdentity | null;
}

export interface ProjectRuntimeManagerOptions {
  readonly repoRoot?: string;
  readonly verifyLog?: RuntimeOptions['verifyLog'];
  readonly checkpointEveryAppends?: number;
  readonly browserSessions?: ProjectBrowserSessionCoordinator;
  readonly openRuntime?: (input: {
    readonly record: ProjectProfileRecord;
    readonly workspaceIdentityOnMissing: WorkspaceIdentityMissingPolicy;
  }) => Runtime;
  readonly faultInjector?: (
    point: ProjectRuntimeSwitchFaultPoint,
    target: ProjectProfileRecord,
  ) => void;
}

type ProjectRuntimeOpener = (input: {
  readonly record: ProjectProfileRecord;
  readonly workspaceIdentityOnMissing: WorkspaceIdentityMissingPolicy;
}) => Runtime;

interface ActiveGeneration {
  readonly record: ProjectProfileRecord;
  readonly pointer: ActiveProjectPointer;
  readonly identity: ProjectOperationIdentity;
  readonly runtime: Runtime;
  readonly publication: ProjectRuntimePublication;
}

export class ProjectRuntimeManager {
  private readonly registry: ProjectProfileRegistry;
  private readonly options: ProjectRuntimeManagerOptions;
  private readonly runtimeOpener: ProjectRuntimeOpener;

  private managerState: ProjectRuntimeManagerState = 'INACTIVE';
  private activeGeneration: ActiveGeneration | null = null;
  private generation = 0;
  private leases = 0;
  private blockedReason: string | null = null;

  public constructor(
    registry: ProjectProfileRegistry,
    options: ProjectRuntimeManagerOptions = {},
  ) {
    this.registry = registry;
    this.options = options;
    this.runtimeOpener =
      options.openRuntime ??
      ((input) =>
        openRuntime({
          withLog: true,
          ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
          ...(options.verifyLog === undefined ? {} : { verifyLog: options.verifyLog }),
          ...(options.checkpointEveryAppends === undefined
            ? {}
            : { checkpointEveryAppends: options.checkpointEveryAppends }),
          projectProfile: input.record,
          workspaceIdentityOnMissing: input.workspaceIdentityOnMissing,
        }));
  }

  public get state(): ProjectRuntimeManagerState {
    return this.managerState;
  }

  public get publication(): ProjectRuntimePublication | null {
    return this.activeGeneration?.publication ?? null;
  }

  public get activeIdentity(): ProjectOperationIdentity | null {
    return this.activeGeneration?.identity ?? null;
  }

  public get activeRuntime(): Runtime | null {
    return this.managerState === 'ACTIVE' ? this.activeGeneration?.runtime ?? null : null;
  }

  public get activeLeaseCount(): number {
    return this.leases;
  }

  public get blockReason(): string | null {
    return this.blockedReason;
  }

  /** Opens the registry's already-active profile without mutating the active pointer. */
  public start(): ProjectRuntimePublication | null {
    this.assertUsable();
    if (this.managerState === 'ACTIVE') return this.activeGeneration?.publication ?? null;
    if (this.managerState !== 'INACTIVE') {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_SWITCH_IN_PROGRESS',
        `cannot start Project Runtime Manager while state is ${this.managerState}`,
      );
    }

    const pointer = this.registry.active();
    if (pointer === null) return null;

    this.managerState = 'STARTING';
    let runtime: Runtime | null = null;
    let browserSwitch: ProjectBrowserSwitchTransaction | null = null;
    try {
      const record = this.registry.getProfile(pointer.projectId);
      this.assertPointerMatchesRecord(pointer, record);
      runtime = this.openTargetRuntime(record);
      browserSwitch = this.options.browserSessions?.begin(record) ?? null;
      browserSwitch?.commit();
      this.assertRegistryPointerUnchanged(pointer);
      const next = this.buildActiveGeneration(
        record,
        pointer,
        runtime,
        browserSwitch?.publication ?? browserAbsent(operationIdentityFromProfileRecord(record), record.generation),
      );
      this.activeGeneration = next;
      this.managerState = 'ACTIVE';
      return next.publication;
    } catch (error) {
      try {
        browserSwitch?.rollback();
      } catch {
        // The manager enters BLOCKED below; no mixed generation is published.
      }
      safeDispose(runtime);
      this.activeGeneration = null;
      this.managerState = 'BLOCKED';
      this.blockedReason = errorMessage(error);
      throw error;
    }
  }

  /**
   * Fully opens B, then moves the durable active pointer, then publishes B in memory. No project
   * operation may hold a lease during this transition.
   */
  public activate(request: ProjectRuntimeActivationRequest): ProjectRuntimePublication {
    this.assertUsable();
    if (this.managerState === 'SWITCHING' || this.managerState === 'STARTING') {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_SWITCH_IN_PROGRESS',
        `project switch already in progress (${this.managerState})`,
      );
    }
    if (this.managerState === 'BLOCKED') {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_BLOCKED',
        `Project Runtime Manager is blocked: ${this.blockedReason ?? 'unknown reason'}`,
      );
    }
    this.reconcileActiveGenerationWithRegistry();
    if (this.leases > 0) {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_BUSY',
        `cannot switch projects while ${this.leases} project operation lease(s) are active`,
      );
    }

    this.assertExpectedCurrentIdentity(request.expectedCurrentIdentity);
    const previous = this.activeGeneration;
    if (previous?.record.profile.projectId === request.projectId) {
      const current = this.registry.getProfile(request.projectId);
      if (current.projectProfileHash === previous.record.projectProfileHash) {
        return previous.publication;
      }
    }

    const originalRegistry = this.registry.readState();
    if (previous !== null && originalRegistry.generation !== previous.pointer.registryGeneration) {
      this.blockContradictoryRegistry('registry changed before the project transition began');
    }
    this.managerState = 'SWITCHING';
    let stagedRuntime: Runtime | null = null;
    let activationAttempted = false;
    let activatedPointer: ActiveProjectPointer | null = null;
    let targetRecord: ProjectProfileRecord | null = null;
    let browserSwitch: ProjectBrowserSwitchTransaction | null = null;
    let browserCommitted = false;

    try {
      targetRecord = this.registry.getProfile(request.projectId);
      this.inject('after-target-profile-load', targetRecord);

      stagedRuntime = this.openTargetRuntime(targetRecord);
      this.validateRuntime(targetRecord, stagedRuntime);
      browserSwitch = this.options.browserSessions?.begin(targetRecord) ?? null;
      this.inject('after-target-runtime-open', targetRecord);
      this.inject('before-registry-activation', targetRecord);

      activationAttempted = true;
      const pointer = this.registry.activate(request.projectId, {
        actor: request.actor,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }, {
        generation: targetRecord.generation,
        projectProfileHash: targetRecord.projectProfileHash,
        registryGeneration: originalRegistry.generation,
      });
      activatedPointer = pointer;
      this.assertPointerMatchesRecord(pointer, targetRecord);
      this.inject('after-registry-activation', targetRecord);
      this.inject('before-browser-publication', targetRecord);
      browserSwitch?.commit();
      browserCommitted = browserSwitch !== null;
      this.inject('after-browser-publication', targetRecord);
      this.inject('before-runtime-publication', targetRecord);
      this.assertRegistryPointerUnchanged(pointer);

      const next = this.buildActiveGeneration(
        targetRecord,
        pointer,
        stagedRuntime,
        browserSwitch?.publication ?? browserAbsent(operationIdentityFromProfileRecord(targetRecord), targetRecord.generation),
      );
      stagedRuntime = null;
      this.activeGeneration = next;
      this.managerState = 'ACTIVE';
      this.blockedReason = null;
      safeDispose(previous?.runtime ?? null);
      return next.publication;
    } catch (error) {
      safeDispose(stagedRuntime);
      if (browserCommitted) {
        try {
          browserSwitch?.rollback();
          browserCommitted = false;
        } catch (browserRollbackError) {
          safeDispose(previous?.runtime ?? null);
          this.activeGeneration = null;
          this.managerState = 'BLOCKED';
          this.blockedReason =
            `activation failed (${errorMessage(error)}); browser rollback failed (${errorMessage(browserRollbackError)})`;
          throw new ProjectRuntimeManagerError(
            'PROJECT_RUNTIME_ROLLBACK_FAILED',
            this.blockedReason,
            browserRollbackError,
          );
        }
      }

      try {
        if (activatedPointer === null) {
          // A filesystem or event-log error can occur after the registry journal or pointer
          // was placed. Settle recovery before deciding whether the old runtime is still safe.
          if (activationAttempted) this.registry.recover();
          if (previous !== null) {
            const current = this.requirePointerFor(previous.record);
            this.restorePreviousGeneration(previous, current);
          } else {
            if (this.registry.activeProjectId() !== originalRegistry.activeProjectId) {
              throw new Error('registry selected a project during the failed transition');
            }
            this.managerState = 'INACTIVE';
          }
        } else if (previous === null) {
          // There is no previous coherent target to restore. The durable pointer identifies a
          // fully validated target runtime, so reopen/publish that target rather than inventing an
          // inactive state that contradicts the registry.
          if (targetRecord === null) throw new Error('target record unavailable during recovery');
          this.assertRegistryPointerUnchanged(activatedPointer);
          this.activeGeneration = this.recoverFirstGeneration(targetRecord, activatedPointer);
          this.managerState = 'ACTIVE';
        } else {
          this.assertRegistryPointerUnchanged(activatedPointer);
          const rollbackPointer = this.registry.activate(previous.record.profile.projectId, {
            actor: 'daemon',
            reason: `automatic rollback after failed activation of ${request.projectId}`,
          }, {
            generation: previous.record.generation,
            projectProfileHash: previous.record.projectProfileHash,
            registryGeneration: activatedPointer.registryGeneration,
          });
          this.restorePreviousGeneration(previous, rollbackPointer);
        }
      } catch (rollbackError) {
        safeDispose(previous?.runtime ?? null);
        this.activeGeneration = null;
        this.managerState = 'BLOCKED';
        this.blockedReason =
          `activation failed (${errorMessage(error)}); rollback failed (${errorMessage(rollbackError)})`;
        throw new ProjectRuntimeManagerError(
          'PROJECT_RUNTIME_ROLLBACK_FAILED',
          this.blockedReason,
          rollbackError,
        );
      }

      throw error;
    }
  }

  /** Acquires a stable generation; switches are refused until release. */
  public lease(expectedIdentity?: ProjectOperationIdentity): ProjectRuntimeLease {
    this.assertUsable();
    if (this.managerState === 'SWITCHING' || this.managerState === 'STARTING') {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_SWITCH_IN_PROGRESS',
        'project runtime is switching; no operation lease can begin',
      );
    }
    if (this.managerState === 'BLOCKED') {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_BLOCKED',
        `Project Runtime Manager is blocked: ${this.blockedReason ?? 'unknown reason'}`,
      );
    }
    this.reconcileActiveGenerationWithRegistry();
    const active = this.activeGeneration;
    if (active === null || this.managerState !== 'ACTIVE') {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_INACTIVE',
        'no Project Profile runtime is active',
      );
    }
    if (expectedIdentity !== undefined) {
      assertProjectOperationIdentity(active.identity, expectedIdentity, 'project runtime lease');
    }

    this.leases += 1;
    let released = false;
    return {
      runtimeGeneration: active.publication.runtimeGeneration,
      identity: active.identity,
      runtime: active.runtime,
      release: () => {
        if (released) return;
        released = true;
        this.leases -= 1;
      },
    };
  }

  public withLease<T>(
    expectedIdentity: ProjectOperationIdentity | undefined,
    work: (lease: ProjectRuntimeLease) => PromiseLike<T>,
  ): Promise<T>;
  public withLease<T>(
    expectedIdentity: ProjectOperationIdentity | undefined,
    work: (lease: ProjectRuntimeLease) => T,
  ): T;
  public withLease(
    expectedIdentity: ProjectOperationIdentity | undefined,
    work: (lease: ProjectRuntimeLease) => unknown,
  ): unknown {
    const lease = this.lease(expectedIdentity);
    try {
      const result = work(lease);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          'then' in result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(lease.release);
      }
      lease.release();
      return result;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  public dispose(): void {
    if (this.managerState === 'DISPOSED') return;
    if (this.leases > 0) {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_BUSY',
        `cannot dispose while ${this.leases} project operation lease(s) are active`,
      );
    }
    safeDispose(this.activeGeneration?.runtime ?? null);
    this.options.browserSessions?.dispose();
    this.activeGeneration = null;
    this.managerState = 'DISPOSED';
    this.blockedReason = null;
  }

  private openTargetRuntime(record: ProjectProfileRecord): Runtime {
    const missingPolicy: WorkspaceIdentityMissingPolicy =
      record.profile.provenance.source === 'native' ? 'initialize-new' : 'reject';
    return this.runtimeOpener({ record, workspaceIdentityOnMissing: missingPolicy });
  }

  private buildActiveGeneration(
    record: ProjectProfileRecord,
    pointer: ActiveProjectPointer,
    runtime: Runtime,
    browserSession: ProjectBrowserSessionPublication,
  ): ActiveGeneration {
    this.validateRuntime(record, runtime);
    this.assertPointerMatchesRecord(pointer, record);
    const identity = operationIdentityFromProfileRecord(record);
    const workspaceIdentity = runtime.projections.assertWorkspaceIdentity({
      projectId: identity.projectId,
      targetRootIdentity: identity.targetRootIdentity,
      profileVersion: record.profile.profileVersion,
      initialProfileHash: identity.projectProfileHash,
    });
    const state = runtime.projectState;
    if (state === null) {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_IDENTITY_CONTRADICTION',
        'profile-bound runtime did not expose projectState',
      );
    }

    const runtimeGeneration = this.generation + 1;
    this.generation = runtimeGeneration;
    const publication: ProjectRuntimePublication = Object.freeze({
      runtimeGeneration,
      projectId: identity.projectId,
      targetRootIdentity: identity.targetRootIdentity,
      projectProfileHash: identity.projectProfileHash,
      profileGeneration: record.generation,
      registryGeneration: pointer.registryGeneration,
      databaseIdentity: hashCanonicalJson({
        identityVersion: 'clue-project-database-identity/1',
        workspaceIdentity,
        databasePath: state.databasePath,
      }),
      greatBookIdentity: hashCanonicalJson({
        identityVersion: 'clue-project-great-book-identity/1',
        projectId: identity.projectId,
        targetRootIdentity: identity.targetRootIdentity,
        greatBookScope: state.greatBookScope,
        proofRoot: state.proofRoot,
      }),
      targetRoot: record.profile.targetRoot,
      inventorySnapshotIdentity: hashCanonicalJson({
        identityVersion: 'clue-project-inventory-snapshot-identity/1',
        projectId: identity.projectId,
        targetRootIdentity: identity.targetRootIdentity,
        recognitionRoot: state.recognitionRoot,
        snapshotRoot: state.snapshotRoot,
      }),
      workspaceRoot: record.profile.workspaceRoot,
      activatedAt: pointer.activatedAt,
      browserSession,
    });
    return { record, pointer, identity, runtime, publication };
  }

  private validateRuntime(record: ProjectProfileRecord, runtime: Runtime): void {
    const expected = operationIdentityFromProfileRecord(record);
    if (runtime.projectProfile === null || runtime.projectIdentity === null) {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_IDENTITY_CONTRADICTION',
        'runtime opened without Project Profile identity',
      );
    }
    assertProjectOperationIdentity(expected, runtime.projectIdentity, 'opened project runtime');
    if (runtime.projectProfile.projectProfileHash !== record.projectProfileHash) {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_IDENTITY_CONTRADICTION',
        'opened runtime profile hash differs from requested profile record',
      );
    }
    runtime.artifacts.assertProjectIdentity(expected, 'opened project artifact store');
    runtime.log?.assertProjectIdentity(expected, 'opened project event log');
  }

  private assertPointerMatchesRecord(
    pointer: ActiveProjectPointer,
    record: ProjectProfileRecord,
  ): void {
    const mismatches: string[] = [];
    if (pointer.projectId !== record.profile.projectId) mismatches.push('projectId');
    if (pointer.targetRootIdentity !== record.profile.targetRootIdentity) {
      mismatches.push('targetRootIdentity');
    }
    if (pointer.projectProfileHash !== record.projectProfileHash) {
      mismatches.push('projectProfileHash');
    }
    if (pointer.profileGeneration !== record.generation) mismatches.push('profileGeneration');
    if (mismatches.length > 0) {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_POINTER_CONTRADICTION',
        `active pointer disagrees with Project Profile in ${mismatches.join(', ')}`,
      );
    }
  }

  private requirePointerFor(record: ProjectProfileRecord): ActiveProjectPointer {
    const pointer = this.registry.active();
    if (pointer === null) {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_POINTER_CONTRADICTION',
        'registry active pointer disappeared during activation recovery',
      );
    }
    this.assertPointerMatchesRecord(pointer, record);
    return pointer;
  }

  private assertRegistryPointerUnchanged(expected: ActiveProjectPointer): void {
    const current = this.registry.active();
    if (current === null || current.registryGeneration !== expected.registryGeneration ||
        current.projectId !== expected.projectId || current.projectProfileHash !== expected.projectProfileHash ||
        current.targetRootIdentity !== expected.targetRootIdentity || current.profileGeneration !== expected.profileGeneration) {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_POINTER_CONTRADICTION',
        'registry active pointer changed during runtime publication',
      );
    }
  }

  private restorePreviousGeneration(previous: ActiveGeneration, pointer: ActiveProjectPointer): void {
    this.assertPointerMatchesRecord(pointer, previous.record);
    this.activeGeneration = {
      ...previous,
      pointer,
      publication: Object.freeze({
        ...previous.publication,
        registryGeneration: pointer.registryGeneration,
        activatedAt: pointer.activatedAt,
      }),
    };
    this.managerState = 'ACTIVE';
    this.blockedReason = null;
  }

  private recoverFirstGeneration(record: ProjectProfileRecord, pointer: ActiveProjectPointer): ActiveGeneration {
    const runtime = this.openTargetRuntime(record);
    let browserSwitch: ProjectBrowserSwitchTransaction | null = null;
    try {
      browserSwitch = this.options.browserSessions?.begin(record) ?? null;
      browserSwitch?.commit();
      this.assertRegistryPointerUnchanged(pointer);
      return this.buildActiveGeneration(
        record,
        pointer,
        runtime,
        browserSwitch?.publication ?? browserAbsent(operationIdentityFromProfileRecord(record), record.generation),
      );
    } catch (error) {
      try {
        browserSwitch?.rollback();
      } finally {
        safeDispose(runtime);
      }
      throw error;
    }
  }

  /**
   * Detects out-of-band registry mutation before another operation begins. Metadata-only profile
   * updates (same governed hash) refresh the publication receipt without reopening the writer.
   * A behavior-bearing hash/target/project change blocks the manager: continuing would expose a
   * registry/runtime split generation.
   */
  private reconcileActiveGenerationWithRegistry(): void {
    const active = this.activeGeneration;
    if (active === null || this.managerState !== 'ACTIVE') return;

    let pointer: ActiveProjectPointer | null;
    let record: ProjectProfileRecord;
    try {
      pointer = this.registry.active();
      if (pointer === null) {
        this.blockContradictoryRegistry('registry active pointer disappeared while a runtime remained active');
      }
      if (pointer.projectId !== active.identity.projectId) {
        this.blockContradictoryRegistry(
          `registry names ${pointer.projectId} while runtime generation ${active.publication.runtimeGeneration} owns ${active.identity.projectId}`,
        );
      }
      record = this.registry.getProfile(pointer.projectId);
      this.assertPointerMatchesRecord(pointer, record);
    } catch (error) {
      if (error instanceof ProjectRuntimeManagerError) throw error;
      this.blockContradictoryRegistry(`could not reconcile active Project Profile registry: ${errorMessage(error)}`, error);
    }

    const currentIdentity = operationIdentityFromProfileRecord(record);
    if (!projectOperationIdentityEquals(active.identity, currentIdentity)) {
      this.blockContradictoryRegistry(
        `active Project Profile changed from ${active.identity.projectProfileHash} to ${currentIdentity.projectProfileHash} without an atomic runtime transition`,
      );
    }

    if (
      record.generation === active.record.generation &&
      pointer.registryGeneration === active.pointer.registryGeneration
    ) {
      return;
    }

    this.activeGeneration = {
      ...active,
      record,
      pointer,
      publication: Object.freeze({
        ...active.publication,
        profileGeneration: record.generation,
        registryGeneration: pointer.registryGeneration,
        activatedAt: pointer.activatedAt,
      }),
    };
  }

  private blockContradictoryRegistry(message: string, causeError: unknown = null): never {
    this.managerState = 'BLOCKED';
    this.blockedReason = message;
    throw new ProjectRuntimeManagerError(
      'PROJECT_RUNTIME_POINTER_CONTRADICTION',
      message,
      causeError,
    );
  }

  private assertExpectedCurrentIdentity(
    expected: ProjectOperationIdentity | null | undefined,
  ): void {
    if (expected === undefined) return;
    const actual = this.activeGeneration?.identity ?? null;
    if (expected === null && actual === null) return;
    if (expected !== null && actual !== null && projectOperationIdentityEquals(expected, actual)) {
      return;
    }
    throw new ProjectRuntimeManagerError(
      'PROJECT_RUNTIME_IDENTITY_CONTRADICTION',
      'activation request was created for a stale active Project Profile identity',
    );
  }

  private inject(point: ProjectRuntimeSwitchFaultPoint, target: ProjectProfileRecord): void {
    this.options.faultInjector?.(point, target);
  }

  private assertUsable(): void {
    if (this.managerState === 'DISPOSED') {
      throw new ProjectRuntimeManagerError(
        'PROJECT_RUNTIME_DISPOSED',
        'Project Runtime Manager is disposed',
      );
    }
  }
}

function safeDispose(runtime: Runtime | null): void {
  if (runtime === null) return;
  try {
    runtime.dispose();
  } catch {
    // The target being published or rolled back remains authoritative. Cleanup failure is not
    // allowed to mutate that identity decision; callers can surface it through host diagnostics.
  }
}

function browserAbsent(
  identity: ProjectOperationIdentity,
  profileGeneration: number,
): ProjectBrowserSessionPublication {
  return Object.freeze({
    state: 'NOT_ESTABLISHED',
    projectIdentity: identity,
    profileGeneration,
    chromeInstanceId: null,
    browserSessionId: null,
    targetPageId: null,
    targetUrl: null,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
