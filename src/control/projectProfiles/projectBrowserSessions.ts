/**
 * Synchronous browser-session publication boundary for atomic Project Profile switching.
 *
 * Establishing a CDP session is asynchronous and therefore happens before this boundary. The
 * runtime manager uses this coordinator only to publish/park already-established identities in
 * the same atomic generation as the project database, Great Book and recognition state.
 */

import type { BrowserSessionIdentity } from '../../experiment/browser/browserAgent.js';
import {
  assertProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  projectOperationIdentityEquals,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import type { ProjectProfileRecord } from '../../shared/schemas.js';

export interface ProjectBrowserSessionRegistration {
  readonly session: BrowserSessionIdentity;
  readonly onActivate?: () => void;
  readonly onPark?: () => void;
  readonly onRelease?: () => void;
}

export interface ProjectBrowserSessionPublication {
  readonly state: 'ACTIVE' | 'NOT_ESTABLISHED';
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly chromeInstanceId: string | null;
  readonly browserSessionId: string | null;
  readonly targetPageId: string | null;
  readonly targetUrl: string | null;
}

export interface ProjectBrowserSwitchTransaction {
  readonly publication: ProjectBrowserSessionPublication;
  commit(): void;
  rollback(): void;
}

interface RegisteredSession {
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly registration: ProjectBrowserSessionRegistration;
}

export class ProjectBrowserSessionCoordinator {
  readonly #registrations = new Map<string, RegisteredSession>();
  #active: RegisteredSession | null = null;

  public get active(): ProjectBrowserSessionPublication | null {
    return this.#active === null
      ? null
      : publicationFor(
          this.#active.projectIdentity,
          this.#active.profileGeneration,
          this.#active,
        );
  }

  public register(
    record: ProjectProfileRecord,
    registration: ProjectBrowserSessionRegistration,
  ): ProjectBrowserSessionPublication {
    const expected = operationIdentityFromProfileRecord(record);
    if (registration.session.projectIdentity === null) {
      throw new Error('cannot register a browser session without Project Profile identity');
    }
    assertProjectOperationIdentity(
      expected,
      registration.session.projectIdentity,
      'project browser session registration',
    );
    if (registration.session.profileGeneration !== record.generation) {
      throw new Error(
        `cannot register browser session generation ${String(registration.session.profileGeneration)} for Project Profile generation ${String(record.generation)}`,
      );
    }
    if (registration.session.chromeInstanceId === null) {
      throw new Error('cannot register a browser session without Chrome instance identity');
    }
    const entry: RegisteredSession = {
      projectIdentity: expected,
      profileGeneration: record.generation,
      registration,
    };
    const key = identityKey(expected, record.generation);
    const previous = this.#registrations.get(key) ?? null;
    if (
      previous !== null &&
      previous === this.#active &&
      previous.registration.session.sessionId !== registration.session.sessionId
    ) {
      throw new Error(
        'cannot replace an active browser session registration; park or unregister the active generation first',
      );
    }
    if (previous !== null && previous !== this.#active) previous.registration.onRelease?.();
    this.#registrations.set(key, entry);
    if (previous !== null && previous === this.#active) this.#active = entry;
    return publicationFor(expected, record.generation, entry);
  }

  public unregister(identity: ProjectOperationIdentity, profileGeneration?: number): void {
    const entries = [...this.#registrations.entries()].filter(([, entry]) =>
      projectOperationIdentityEquals(entry.projectIdentity, identity) &&
      (profileGeneration === undefined || entry.profileGeneration === profileGeneration),
    );
    for (const [key, entry] of entries) {
      if (this.#active === entry) {
        entry.registration.onPark?.();
        this.#active = null;
      }
      this.#registrations.delete(key);
      entry.registration.onRelease?.();
    }
  }

  /** Begins a reversible publication transition. No callback is invoked until commit. */
  public begin(record: ProjectProfileRecord): ProjectBrowserSwitchTransaction {
    const targetIdentity = operationIdentityFromProfileRecord(record);
    const target = this.#registrations.get(identityKey(targetIdentity, record.generation)) ?? null;
    if (target !== null) {
      assertProjectOperationIdentity(
        targetIdentity,
        target.projectIdentity,
        'project browser switch target',
      );
    }
    const previous = this.#active;
    let committed = false;

    return {
      publication: publicationFor(targetIdentity, record.generation, target),
      commit: () => {
        if (committed) return;
        if (previous === target) {
          committed = true;
          return;
        }
        let previousParked = false;
        try {
          previous?.registration.onPark?.();
          previousParked = previous !== null;
          target?.registration.onActivate?.();
          this.#active = target;
          committed = true;
        } catch (error) {
          try {
            if (previousParked) previous?.registration.onActivate?.();
            this.#active = previous;
          } catch (rollbackError) {
            this.#active = null;
            throw new ProjectBrowserSessionSwitchError(
              'BROWSER_SESSION_ROLLBACK_FAILED',
              `Browser session activation failed (${errorMessage(error)}); rollback failed (${errorMessage(rollbackError)}).`,
              rollbackError,
            );
          }
          throw new ProjectBrowserSessionSwitchError(
            'BROWSER_SESSION_ACTIVATION_FAILED',
            errorMessage(error),
            error,
          );
        }
      },
      rollback: () => {
        if (!committed) return;
        if (this.#active === previous) return;
        try {
          target?.registration.onPark?.();
          previous?.registration.onActivate?.();
          this.#active = previous;
          committed = false;
        } catch (error) {
          this.#active = null;
          throw new ProjectBrowserSessionSwitchError(
            'BROWSER_SESSION_ROLLBACK_FAILED',
            errorMessage(error),
            error,
          );
        }
      },
    };
  }

  public assertActiveProject(
    identity: ProjectOperationIdentity,
    profileGeneration?: number,
  ): void {
    if (this.#active === null) {
      throw new Error('no governed browser session is active');
    }
    assertProjectOperationIdentity(identity, this.#active.projectIdentity, 'active browser session');
    if (
      profileGeneration !== undefined &&
      this.#active.profileGeneration !== profileGeneration
    ) {
      throw new Error(
        `active browser session belongs to profile generation ${String(this.#active.profileGeneration)}, not ${String(profileGeneration)}`,
      );
    }
  }

  public dispose(): void {
    const active = this.#active;
    if (active !== null) active.registration.onPark?.();
    this.#active = null;
    for (const entry of this.#registrations.values()) entry.registration.onRelease?.();
    this.#registrations.clear();
  }

  /** True only when one exact active browser generation belongs to the supplied project. */
  public isActiveFor(
    identity: ProjectOperationIdentity,
    profileGeneration?: number,
  ): boolean {
    return this.#active !== null &&
      projectOperationIdentityEquals(this.#active.projectIdentity, identity) &&
      (profileGeneration === undefined || this.#active.profileGeneration === profileGeneration);
  }
}

export class ProjectBrowserSessionSwitchError extends Error {
  public constructor(
    public readonly code:
      | 'BROWSER_SESSION_ACTIVATION_FAILED'
      | 'BROWSER_SESSION_ROLLBACK_FAILED',
    message: string,
    public readonly causeError: unknown,
  ) {
    super(message);
    this.name = 'ProjectBrowserSessionSwitchError';
  }
}

function publicationFor(
  projectIdentity: ProjectOperationIdentity,
  profileGeneration: number,
  entry: RegisteredSession | null,
): ProjectBrowserSessionPublication {
  return Object.freeze({
    state: entry === null ? 'NOT_ESTABLISHED' : 'ACTIVE',
    projectIdentity,
    profileGeneration,
    chromeInstanceId: entry?.registration.session.chromeInstanceId ?? null,
    browserSessionId: entry?.registration.session.sessionId ?? null,
    targetPageId: entry?.registration.session.targetId ?? null,
    targetUrl: entry?.registration.session.targetUrl ?? null,
  });
}

function identityKey(identity: ProjectOperationIdentity, profileGeneration: number): string {
  return `${identity.projectId}\u0000${identity.targetRootIdentity}\u0000${identity.projectProfileHash}\u0000${String(profileGeneration)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
