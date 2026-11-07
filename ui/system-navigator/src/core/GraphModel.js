import { hash01, hashString, v3add } from './Math3D.js';
import { GRANULARITIES, NODE_PHASES } from '../protocol.js';

export const GRANULARITY_LEVEL = Object.freeze({
  project: 0,
  domain: 1,
  subsystem: 2,
  module: 3,
  file: 4,
  class: 5,
  function: 6,
});

export const LEVEL_GRANULARITY = Object.freeze(
  Object.fromEntries(Object.entries(GRANULARITY_LEVEL).map(([key, value]) => [value, key])),
);

export const SHAPE_BY_GRANULARITY = Object.freeze({
  project: 0,
  domain: 1,
  subsystem: 2,
  module: 3,
  file: 4,
  class: 5,
  function: 6,
});

const DEFAULT_DETAILS = Object.freeze({
  purpose: 'Purpose has not yet been supplied by CLUE.',
  classification: 'UNCLASSIFIED',
  optimized: 'unknown',
  confidence: null,
  blastRadius: 'unknown',
  fileSpan: 'unknown',
  dependencySurface: 'unknown',
  history: [],
  lastEvidence: null,
  lastPatch: null,
});

function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function stripExtension(name) {
  return name.replace(/\.(tsx?|mts|cts|jsx?|mjs|cjs|wgsl)$/i, '');
}

function humanize(value) {
  return String(value ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function childId(parentId, granularity, key) {
  return `${parentId}/${granularity}:${encodeURIComponent(key)}`;
}

/**
 * Provenance of a hierarchy assignment (CLUE_Milestone_Review_and_Forward_Plan_v3.md §5.5).
 * A directory name is evidence, not automatic architectural truth: Domains and Subsystems
 * inferred from paths are `path_derived` and must never be shown as authoritative without
 * this label. The ladder runs from strongest to weakest evidence.
 */
export const HIERARCHY_PROVENANCE = Object.freeze([
  'creator_declared',
  'document_declared',
  'source_confirmed',
  'path_derived',
  'graph_inferred',
  'unknown',
]);

/** Whether a provenance value denotes inference rather than confirmed observation. */
export function isProvisionalProvenance(provenance) {
  return provenance === 'path_derived' || provenance === 'graph_inferred' || provenance === 'unknown';
}

function sourceKindToGranularity(kind) {
  if (kind === 'module') return 'file';
  if (kind === 'class' || kind === 'interface' || kind === 'typeAlias' || kind === 'enum') return 'class';
  if (kind === 'function' || kind === 'method') return 'function';
  return null;
}

/**
 * Durable in-browser projection of the CLUE recognition graph.
 *
 * It stores the original source units and edges but also creates a display hierarchy:
 * project → domain → subsystem → module → file → class → function/method.
 * Aggregation is therefore reversible: zooming out never discards leaf identity.
 */
export class GraphModel extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = {
      ...options,
      projectName: options.projectName ?? 'Murugan',
      sourceRoots: options.sourceRoots ?? ['src', 'app'],
      moduleDepth: options.moduleDepth ?? 3,
      includeTypeNodes: options.includeTypeNodes ?? true,
    };

    this.nodes = new Map();
    this.rawUnits = new Map();
    this.rawEdges = new Map();
    this.sourceToDisplay = new Map();
    this.pendingEdges = [];
    this.appliedMetricEdges = new Set();
    this.edgeCounter = 0;
    this.version = 0;
    this.progress = {
      percent: 0,
      status: 'IDLE',
      processedFiles: 0,
      totalFiles: 0,
      currentPath: '',
      currentUnit: '',
      snapshotId: null,
      startedAt: null,
      completedAt: null,
    };

    this.reset(this.options.projectName);
  }

  reset(projectName = this.options.projectName) {
    this.nodes.clear();
    this.rawUnits.clear();
    this.rawEdges.clear();
    this.sourceToDisplay.clear();
    this.pendingEdges.length = 0;
    this.appliedMetricEdges.clear();
    this.edgeCounter = 0;
    this.version += 1;
    this.options.projectName = projectName;

    const root = this.#createNode({
      id: `project:${projectName}`,
      label: projectName,
      granularity: 'project',
      parentId: null,
      sourceLogicalId: null,
      sourceKind: 'project',
      purpose: `The complete ${projectName} system recognized by CLUE.`,
    });
    root.phase = 'stable';
    this.rootId = root.id;
    this.progress = {
      percent: 0,
      status: 'IDLE',
      processedFiles: 0,
      totalFiles: 0,
      currentPath: '',
      currentUnit: '',
      snapshotId: null,
      startedAt: null,
      completedAt: null,
    };
    this.#emit('reset', { projectName, rootId: root.id });
  }

  beginScan(payload = {}) {
    const projectName = payload.projectName ?? this.options.projectName;
    if (projectName !== this.options.projectName || payload.reset !== false) this.reset(projectName);
    this.progress = {
      ...this.progress,
      percent: 0,
      status: payload.status ?? 'INITIALIZING RECOGNITION',
      processedFiles: 0,
      totalFiles: Math.max(0, Number(payload.totalFiles ?? 0)),
      currentPath: '',
      currentUnit: '',
      snapshotId: payload.snapshotId ?? null,
      startedAt: payload.startedAt ?? new Date().toISOString(),
      completedAt: null,
    };
    this.#emit('progress', { ...this.progress });
  }

  updateProgress(payload = {}) {
    const processedFiles = Number.isFinite(payload.processedFiles)
      ? Math.max(0, payload.processedFiles)
      : this.progress.processedFiles;
    const totalFiles = Number.isFinite(payload.totalFiles)
      ? Math.max(0, payload.totalFiles)
      : this.progress.totalFiles;
    const calculated = totalFiles > 0 ? (processedFiles / totalFiles) * 100 : this.progress.percent;
    const percent = Number.isFinite(payload.percent) ? payload.percent : calculated;

    this.progress = {
      ...this.progress,
      ...payload,
      processedFiles,
      totalFiles,
      percent: Math.max(0, Math.min(100, percent)),
    };
    this.#emit('progress', { ...this.progress });
  }

  completeScan(payload = {}) {
    this.#resolvePendingEdges();
    this.#recalculateDegrees();
    this.progress = {
      ...this.progress,
      percent: 100,
      status: payload.status ?? 'RECOGNITION COMPLETE',
      completedAt: payload.completedAt ?? new Date().toISOString(),
      ...payload,
    };
    this.version += 1;
    this.#emit('progress', { ...this.progress });
    this.#emit('complete', {
      nodeCount: this.nodes.size,
      sourceUnitCount: this.rawUnits.size,
      edgeCount: this.rawEdges.size,
      progress: { ...this.progress },
    });
  }

  addUnit(unit, options = {}) {
    if (!unit || typeof unit.logicalId !== 'string') {
      throw new TypeError('A recognized unit requires logicalId.');
    }
    if (this.rawUnits.has(unit.logicalId)) return this.nodes.get(this.sourceToDisplay.get(unit.logicalId));

    const normalized = {
      ...unit,
      modulePath: normalizePath(unit.modulePath ?? unit.anchor?.path ?? ''),
      kind: unit.kind ?? 'function',
      name: unit.name ?? unit.qualifiedName ?? unit.logicalId,
    };
    this.rawUnits.set(normalized.logicalId, normalized);

    const displayNode = this.#projectSourceUnit(normalized, options);
    this.sourceToDisplay.set(normalized.logicalId, displayNode.id);
    displayNode.sourceLogicalIds.add(normalized.logicalId);
    displayNode.byteLength += Number(normalized.byteLength ?? 0);
    displayNode.lineCount += Number(normalized.lineCount ?? 0);
    displayNode.exported ||= Boolean(normalized.exported);
    displayNode.metrics.sourceUnits = displayNode.sourceLogicalIds.size;
    displayNode.details = {
      ...displayNode.details,
      purpose: options.purpose ?? displayNode.details.purpose,
    };
    if (displayNode.level === 6 && options.cinematic !== false) {
      displayNode.discoveryVisual = true;
      displayNode.discoveredAt = performance.now();
    }

    this.progress.currentPath = normalized.modulePath;
    this.progress.currentUnit = normalized.logicalId;
    this.version += 1;
    this.#emit('node-added', { node: displayNode, unit: normalized, cinematic: options.cinematic !== false });
    this.#resolvePendingEdges();
    return displayNode;
  }

  addEdge(edge) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      throw new TypeError('A recognized edge requires from and to logical ids.');
    }
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind ?? 'references'}\u0000${this.edgeCounter++}`;
    const normalized = {
      kind: 'references',
      confidence: 1,
      external: false,
      ...edge,
      id: edge.id ?? key,
    };
    this.rawEdges.set(normalized.id, normalized);
    if (!this.sourceToDisplay.has(normalized.from) || (!normalized.external && !this.sourceToDisplay.has(normalized.to))) {
      this.pendingEdges.push(normalized.id);
    } else {
      this.#applyEdgeMetrics(normalized);
    }
    this.version += 1;
    this.#emit('edge-added', { edge: normalized });
    return normalized;
  }

  replaceGraph(result, options = {}) {
    this.beginScan({
      projectName: options.projectName ?? this.options.projectName,
      totalFiles: result?.stats?.filesRecognised ?? result?.stats?.filesInProgram ?? 0,
      snapshotId: options.snapshotId ?? null,
      status: 'LOADING RECOGNITION RESULT',
    });
    for (const unit of result?.units ?? []) this.addUnit(unit, { cinematic: options.cinematic === true });
    for (const edge of result?.edges ?? []) this.addEdge(edge);
    this.updateProgress({
      processedFiles: result?.stats?.filesRecognised ?? result?.stats?.filesInProgram ?? 0,
      totalFiles: result?.stats?.filesRecognised ?? result?.stats?.filesInProgram ?? 0,
      status: 'BUILDING DEPENDENCY HIVE',
    });
    this.completeScan({
      status: 'RECOGNITION COMPLETE',
      unresolved: result?.unresolved?.length ?? 0,
    });
  }

  setNodePhase(idOrLogicalId, phase, metadata = {}) {
    if (!NODE_PHASES.includes(phase)) throw new TypeError(`Unknown node phase: ${phase}`);
    const node = this.getNode(idOrLogicalId);
    if (!node) return false;
    const previous = node.phase;
    node.phase = phase;
    node.phaseStartedAt = performance.now();
    node.phaseMetadata = { ...metadata };
    if (phase === 'verified') node.details.optimized = 'verified';
    this.version += 1;
    this.#emit('phase', { node, previous, phase, metadata });
    return true;
  }

  setNodeDetails(idOrLogicalId, details = {}) {
    const node = this.getNode(idOrLogicalId);
    if (!node) return false;
    node.details = {
      ...node.details,
      ...details,
      history: Array.isArray(details.history) ? [...details.history] : node.details.history,
    };
    if (details.classification) node.details.classification = details.classification;
    this.version += 1;
    this.#emit('details', { node, details: node.details });
    return true;
  }

  getNode(idOrLogicalId) {
    if (this.nodes.has(idOrLogicalId)) return this.nodes.get(idOrLogicalId);
    const displayId = this.sourceToDisplay.get(idOrLogicalId);
    return displayId ? this.nodes.get(displayId) : undefined;
  }

  getAncestors(nodeOrId) {
    const node = typeof nodeOrId === 'string' ? this.nodes.get(nodeOrId) : nodeOrId;
    if (!node) return [];
    const result = [];
    let current = node;
    while (current) {
      result.push(current);
      current = current.parentId ? this.nodes.get(current.parentId) : null;
    }
    return result;
  }

  getDescendants(nodeOrId, maxDepth = Infinity) {
    const node = typeof nodeOrId === 'string' ? this.nodes.get(nodeOrId) : nodeOrId;
    if (!node) return [];
    const result = [];
    const queue = node.children.map((id) => ({ id, depth: 1 }));
    while (queue.length > 0) {
      const entry = queue.shift();
      const child = this.nodes.get(entry.id);
      if (!child) continue;
      result.push(child);
      if (entry.depth < maxDepth) {
        for (const childIdValue of child.children) queue.push({ id: childIdValue, depth: entry.depth + 1 });
      }
    }
    return result;
  }

  ancestorAtLevel(nodeOrId, level) {
    let node = typeof nodeOrId === 'string' ? this.nodes.get(nodeOrId) : nodeOrId;
    while (node && node.level > level) node = node.parentId ? this.nodes.get(node.parentId) : null;
    return node ?? this.nodes.get(this.rootId);
  }

  displaySetForDepth(depth, focusRootId = null) {
    const targetLevel = Math.max(0, Math.min(6, Math.round(depth)));
    const focusRoot = focusRootId ? this.nodes.get(focusRootId) : null;
    const root = focusRoot && focusRoot.level < targetLevel ? focusRoot : this.nodes.get(this.rootId);
    if (!root) return [];
    if (targetLevel <= root.level) return [root];

    const result = [];
    const queue = [...root.children];
    while (queue.length > 0) {
      const id = queue.shift();
      const node = this.nodes.get(id);
      if (!node) continue;
      if (node.level >= targetLevel || node.children.length === 0) result.push(node);
      else queue.push(...node.children);
    }
    return result;
  }

  /**
   * Aggregates raw leaf edges up to the visible node set, **preserving dependency
   * direction**. A→B and B→A are distinct aggregates with distinct keys: direction is
   * semantic truth (reverse impact, blast radius, coupling analysis all depend on it),
   * so a mutual dependency is reported as two directed aggregates, never merged into
   * one undirected edge whose recorded direction is whichever raw edge arrived first.
   * `directedFrom`/`directedTo` are retained for shape stability and are always equal
   * to `from`/`to`.
   */
  aggregatedEdgesFor(nodes) {
    const visible = new Map(nodes.map((node) => [node.id, node]));
    const visibleIds = new Set(visible.keys());
    const leafToVisible = new Map();

    for (const [sourceId, displayId] of this.sourceToDisplay) {
      let node = this.nodes.get(displayId);
      while (node && !visibleIds.has(node.id)) node = node.parentId ? this.nodes.get(node.parentId) : null;
      if (node) leafToVisible.set(sourceId, node.id);
    }

    const aggregates = new Map();
    for (const edge of this.rawEdges.values()) {
      const from = leafToVisible.get(edge.from);
      const to = edge.external ? null : leafToVisible.get(edge.to);
      if (!from || !to || from === to) continue;
      const key = `${from}\u0000${to}`;
      const existing = aggregates.get(key) ?? {
        id: key,
        from,
        to,
        directedFrom: from,
        directedTo: to,
        weight: 0,
        confidence: 0,
        kinds: new Set(),
      };
      existing.weight += 1;
      existing.confidence += Number(edge.confidence ?? 1);
      existing.kinds.add(edge.kind ?? 'references');
      aggregates.set(key, existing);
    }

    return [...aggregates.values()].map((edge) => ({
      ...edge,
      confidence: edge.weight > 0 ? edge.confidence / edge.weight : 0,
      kinds: [...edge.kinds],
    }));
  }

  worldPosition(nodeOrId) {
    const node = typeof nodeOrId === 'string' ? this.nodes.get(nodeOrId) : nodeOrId;
    if (!node) return [0, 0, 0];
    let position = [...node.basePosition];
    let current = node;
    while (current) {
      position = v3add(position, current.manualOffset);
      current = current.parentId ? this.nodes.get(current.parentId) : null;
    }
    return position;
  }

  #projectSourceUnit(unit, options) {
    const modulePath = normalizePath(unit.modulePath);
    const fileParts = modulePath.split('/').filter(Boolean);
    const filename = fileParts.pop() ?? unit.name;
    const directories = this.#trimSourceRoot(fileParts);

    const domainKey = directories[0] ?? '(root)';
    const subsystemKey = directories[1] ?? 'core';
    const moduleTail = directories.slice(2, Math.max(3, this.options.moduleDepth));
    const moduleKey = moduleTail.length > 0 ? moduleTail.join('/') : `${subsystemKey}.root`;

    const domain = this.#ensureHierarchy(this.rootId, 'domain', domainKey, {
      purpose: `Architectural domain derived from ${domainKey}.`,
      // A top-level directory name is a hypothesis about a domain, not a confirmed one.
      provenance: 'path_derived',
    });
    const subsystem = this.#ensureHierarchy(domain.id, 'subsystem', subsystemKey, {
      purpose: `${humanize(subsystemKey)} subsystem inside ${domain.label}.`,
      provenance: 'path_derived',
    });
    const moduleNode = this.#ensureHierarchy(subsystem.id, 'module', moduleKey, {
      purpose: `Module cluster containing source under ${directories.join('/') || '(root)'}.`,
      provenance: 'path_derived',
    });
    const fileNode = this.#ensureHierarchy(moduleNode.id, 'file', modulePath, {
      label: filename,
      purpose: `Source file ${modulePath}.`,
      modulePath,
      // The file itself is confirmed to exist in the snapshot; only its grouping above is inferred.
      provenance: 'source_confirmed',
    });

    if (unit.kind === 'module') return fileNode;

    const granularity = sourceKindToGranularity(unit.kind);
    if (!granularity) {
      fileNode.metrics.hiddenSymbols += 1;
      return fileNode;
    }

    if (granularity === 'class') {
      if (!this.options.includeTypeNodes && unit.kind !== 'class') return fileNode;
      return this.#ensureHierarchy(fileNode.id, 'class', unit.logicalId, {
        label: unit.name,
        sourceLogicalId: unit.logicalId,
        sourceKind: unit.kind,
        modulePath,
        purpose: options.purpose ?? `${humanize(unit.kind)} ${unit.name} declared in ${modulePath}.`,
        provenance: 'source_confirmed',
      });
    }

    let parent = fileNode;
    if (unit.parentLogicalId) {
      const parentDisplayId = this.sourceToDisplay.get(unit.parentLogicalId);
      const parentNode = parentDisplayId ? this.nodes.get(parentDisplayId) : null;
      if (parentNode?.granularity === 'class') parent = parentNode;
    }
    return this.#ensureHierarchy(parent.id, 'function', unit.logicalId, {
      label: unit.name,
      sourceLogicalId: unit.logicalId,
      sourceKind: unit.kind,
      modulePath,
      purpose: options.purpose ?? `${humanize(unit.kind)} ${unit.name} declared in ${modulePath}.`,
      provenance: 'source_confirmed',
    });
  }

  #trimSourceRoot(parts) {
    const copy = [...parts];
    if (copy[0] === 'packages' && copy.length >= 3) {
      copy.splice(0, 2);
    }
    if (this.options.sourceRoots.includes(copy[0])) copy.shift();
    return copy;
  }

  #ensureHierarchy(parentId, granularity, key, extras = {}) {
    const id = childId(parentId, granularity, key);
    const existing = this.nodes.get(id);
    if (existing) return existing;
    return this.#createNode({
      id,
      label: extras.label ?? humanize(stripExtension(key.split('/').at(-1) ?? key)),
      granularity,
      parentId,
      sourceLogicalId: extras.sourceLogicalId ?? null,
      sourceKind: extras.sourceKind ?? granularity,
      purpose: extras.purpose,
      modulePath: extras.modulePath ?? null,
      provenance: extras.provenance ?? 'unknown',
    });
  }

  #createNode({ id, label, granularity, parentId, sourceLogicalId, sourceKind, purpose, modulePath = null, provenance = 'unknown' }) {
    if (!GRANULARITIES.includes(granularity)) throw new TypeError(`Unknown granularity: ${granularity}`);
    const safeProvenance = HIERARCHY_PROVENANCE.includes(provenance) ? provenance : 'unknown';
    const node = {
      id,
      label,
      granularity,
      level: GRANULARITY_LEVEL[granularity],
      shape: SHAPE_BY_GRANULARITY[granularity],
      parentId,
      children: [],
      // Where this hierarchy assignment came from, and whether it is inference rather than
      // confirmed observation (§5.5). The Inspector reads these to mark provisional nodes.
      provenance: safeProvenance,
      provisional: isProvisionalProvenance(safeProvenance),
      sourceLogicalIds: new Set(sourceLogicalId ? [sourceLogicalId] : []),
      sourceKind,
      modulePath,
      phase: 'stable',
      phaseStartedAt: performance.now(),
      phaseMetadata: {},
      discoveredAt: performance.now(),
      discoveryVisual: false,
      basePosition: [0, 0, 0],
      manualOffset: [0, 0, 0],
      seed: hashString(id),
      radiusJitter: 0.84 + hash01(`${id}:radius`) * 0.32,
      byteLength: 0,
      lineCount: 0,
      exported: false,
      metrics: {
        inbound: 0,
        outbound: 0,
        sourceUnits: sourceLogicalId ? 1 : 0,
        hiddenSymbols: 0,
        directChildren: 0,
        totalDescendants: 0,
        edgeKinds: {},
      },
      details: {
        ...DEFAULT_DETAILS,
        purpose: purpose ?? DEFAULT_DETAILS.purpose,
        history: [],
      },
    };
    this.nodes.set(id, node);
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent && !parent.children.includes(id)) {
        parent.children.push(id);
        parent.metrics.directChildren = parent.children.length;
      }
    }
    this.#refreshAncestorCounts(node);
    return node;
  }

  #resolvePendingEdges() {
    if (this.pendingEdges.length === 0) return;
    const unresolved = [];
    for (const id of this.pendingEdges) {
      const edge = this.rawEdges.get(id);
      if (!edge) continue;
      if (!this.sourceToDisplay.has(edge.from) || (!edge.external && !this.sourceToDisplay.has(edge.to))) {
        unresolved.push(id);
      } else {
        this.#applyEdgeMetrics(edge);
      }
    }
    this.pendingEdges = unresolved;
  }

  #recalculateDegrees() {
    for (const node of this.nodes.values()) {
      node.metrics.inbound = 0;
      node.metrics.outbound = 0;
      node.metrics.edgeKinds = {};
    }
    this.appliedMetricEdges.clear();
    for (const edge of this.rawEdges.values()) this.#applyEdgeMetrics(edge);
  }

  #applyEdgeMetrics(edge) {
    if (this.appliedMetricEdges.has(edge.id)) return;
    const fromId = this.sourceToDisplay.get(edge.from);
    const toId = edge.external ? null : this.sourceToDisplay.get(edge.to);
    const from = fromId ? this.nodes.get(fromId) : null;
    const to = toId ? this.nodes.get(toId) : null;
    if (!from || (!edge.external && !to)) return;

    const apply = (node, direction) => {
      let current = node;
      while (current) {
        current.metrics[direction] += 1;
        current.metrics.edgeKinds[edge.kind] = (current.metrics.edgeKinds[edge.kind] ?? 0) + 1;
        current = current.parentId ? this.nodes.get(current.parentId) : null;
      }
    };
    apply(from, 'outbound');
    if (to) apply(to, 'inbound');
    this.appliedMetricEdges.add(edge.id);
  }

  #refreshAncestorCounts(node) {
    let parent = node.parentId ? this.nodes.get(node.parentId) : null;
    while (parent) {
      parent.metrics.totalDescendants += 1;
      parent = parent.parentId ? this.nodes.get(parent.parentId) : null;
    }
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}