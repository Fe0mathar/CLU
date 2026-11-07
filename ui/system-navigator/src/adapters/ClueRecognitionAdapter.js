/**
 * Adapter for CLUE's current Stage C `RecognitionResult` shape.
 *
 * Use `load()` for an already completed scan or call the incremental methods from the
 * recognizer as each file, unit, and edge becomes known.
 */
export class ClueRecognitionAdapter {
  constructor(navigatorTarget, options = {}) {
    this.target = navigatorTarget;
    this.options = {
      projectName: options.projectName ?? 'Murugan',
      cinematic: options.cinematic ?? true,
      ...options,
    };
    this.processedFiles = 0;
    this.totalFiles = 0;
    this.units = 0;
    this.edges = 0;
  }

  async load(result, options = {}) {
    const target = await this.#resolveTarget();
    return target.loadRecognitionResult(result, {
      projectName: options.projectName ?? this.options.projectName,
      snapshotId: options.snapshotId ?? null,
      cinematic: options.cinematic ?? false,
    });
  }

  async begin({ totalFiles = 0, snapshotId = null, projectName = this.options.projectName } = {}) {
    this.processedFiles = 0;
    this.totalFiles = totalFiles;
    this.units = 0;
    this.edges = 0;
    const target = await this.#resolveTarget();
    return target.beginScan({ projectName, totalFiles, snapshotId, status: 'SCANNING SOURCE TREE' });
  }

  async fileStarted(path, index = this.processedFiles) {
    const target = await this.#resolveTarget();
    return target.updateProgress({
      processedFiles: index,
      totalFiles: this.totalFiles,
      currentPath: path,
      status: `READING FILE · ${path}`,
    });
  }

  async unit(unit, details = null, options = {}) {
    const target = await this.#resolveTarget();
    this.units += 1;
    const node = await target.addUnit(unit, {
      cinematic: options.cinematic ?? this.options.cinematic,
      purpose: details?.purpose,
    });
    if (details) await target.setNodeDetails(unit.logicalId, details);
    return node;
  }

  async edge(edge) {
    const target = await this.#resolveTarget();
    this.edges += 1;
    return target.addEdge(edge);
  }

  async fileCompleted(path, index = this.processedFiles + 1) {
    this.processedFiles = index;
    const target = await this.#resolveTarget();
    return target.updateProgress({
      processedFiles: this.processedFiles,
      totalFiles: this.totalFiles,
      currentPath: path,
      status: 'RESOLVING DEPENDENCIES',
    });
  }

  async complete(extra = {}) {
    const target = await this.#resolveTarget();
    return target.completeScan({
      status: 'RECOGNITION COMPLETE',
      units: this.units,
      edges: this.edges,
      ...extra,
    });
  }

  async phase(logicalId, phase, metadata = {}) {
    const target = await this.#resolveTarget();
    return target.setNodePhase(logicalId, phase, metadata);
  }

  async details(logicalId, details) {
    const target = await this.#resolveTarget();
    return target.setNodeDetails(logicalId, details);
  }

  async #resolveTarget() {
    if (this.target?.ready) await this.target.ready;
    return this.target?.navigator ?? this.target;
  }
}
