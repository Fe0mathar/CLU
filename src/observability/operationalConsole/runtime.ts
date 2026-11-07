/**
 * Process-local owner of the Operational Console writer.
 *
 * The CLU-E daemon should construct exactly one runtime and pass its recorder to every
 * real transport boundary. Read-only console servers may run separately because they
 * never acquire the writer lock.
 */

import { join, resolve } from 'node:path';

import { ArtifactStore } from '../../memory/artifactStore.js';
import { OperationalConsoleRecorder, type OperationalConsoleRecorderOptions } from './recorder.js';
import { OperationalConsoleEventStore } from './store.js';

export interface OperationalConsoleRuntimeOptions extends OperationalConsoleRecorderOptions {
  readonly workspaceRoot: string;
}

export class OperationalConsoleRuntime {
  public readonly eventFile: string;
  public readonly blobsDir: string;
  public readonly recorder: OperationalConsoleRecorder;
  private readonly store: OperationalConsoleEventStore;

  public constructor(options: OperationalConsoleRuntimeOptions) {
    const workspace = resolve(options.workspaceRoot);
    this.eventFile = join(workspace, 'console', 'operational-console.ndjson');
    this.blobsDir = join(workspace, 'blobs');
    this.store = OperationalConsoleEventStore.open(this.eventFile);
    this.recorder = new OperationalConsoleRecorder(
      this.store,
      new ArtifactStore(this.blobsDir),
      options,
    );
  }

  public close(): void {
    this.store.close();
  }
}
