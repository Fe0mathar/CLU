export type NavigatorPhase =
  | 'stable'
  | 'discovered'
  | 'diagnosing'
  | 'testing'
  | 'patching'
  | 'verified'
  | 'blocked';

export interface NavigatorEvent {
  v: 1;
  type: string;
  streamId: string;
  runId?: string | null;
  sequence: number;
  emittedAt: string;
  snapshotId: string | null;
  payload: Record<string, unknown>;
}

export interface NavigatorFileDiveContext {
  repositoryId: string | null;
  snapshotId: string | null;
  fileLocationId: string;
  fileVersionId: string;
  path: string;
  familyId: string;
  environmentId: string;
  semanticMembershipIds: string[];
  preferredSemanticRootId: string | null;
}

export interface ClueSystemNavigatorElement extends HTMLElement {
  readonly ready: Promise<unknown>;
  beginScan(payload?: Record<string, unknown>): Promise<unknown>;
  updateProgress(payload?: Record<string, unknown>): Promise<unknown>;
  addUnit(unit: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  addEdge(edge: Record<string, unknown>): Promise<unknown>;
  completeScan(payload?: Record<string, unknown>): Promise<unknown>;
  loadRecognitionResult(result: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  setNodePhase(id: string, phase: NavigatorPhase, metadata?: Record<string, unknown>): Promise<unknown>;
  setNodeDetails(id: string, details: Record<string, unknown>): Promise<unknown>;
  focusNode(id: string, options?: Record<string, unknown>): Promise<unknown>;
  enterDiveForFile(context: NavigatorFileDiveContext): Promise<boolean>;
  frameProject(): Promise<unknown>;
  applyEvent(event: NavigatorEvent): Promise<unknown>;
  enableAudio(): Promise<unknown>;
  exportViewState(): Promise<Record<string, unknown>>;
  importViewState(state: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface HTMLElementTagNameMap {
    'clue-system-navigator': ClueSystemNavigatorElement;
  }
}
