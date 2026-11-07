import { GraphModel, GRANULARITY_LEVEL, LEVEL_GRANULARITY } from './core/GraphModel.js';
import { resolveSemanticFileNode } from './core/FileDiveResolver.js';
import { CLUE_JADE_DRAGON_ANIMATED_SVG } from './vendor/ClueDragonSvg.js';
import { LayoutEngine } from './core/LayoutEngine.js';
import { NavigatorCamera } from './core/Camera.js';
import { DiscoveryDirector } from './core/DiscoveryDirector.js';
import { WebGPUScene } from './render/WebGPUScene.js';
import { NavigatorControls } from './input/NavigatorControls.js';
import { DiscoveryAudio } from './audio/DiscoveryAudio.js';
import { CinematicInspector } from './ui/Inspector.js';
import { NavigatorBreadcrumb, ScanBadge, QuickLabel } from './ui/Hud.js';
import {
  assertNavigatorEvent,
  DEFAULT_PHASE_COLORS,
} from './protocol.js';
import {
  clamp,
  hash01,
  hexToRgb,
  projectToScreen,
  smoothstep,
} from './core/Math3D.js';

const NODE_RADIUS = Object.freeze({
  project: 3.8,
  domain: 2.35,
  subsystem: 1.75,
  module: 1.34,
  file: 1.0,
  class: 0.78,
  function: 0.51,
});

const PHASE_CODE = Object.freeze({
  stable: 0,
  discovered: 1,
  diagnosing: 2,
  testing: 3,
  patching: 4,
  verified: 5,
  blocked: 6,
});

function normalizeRepositoryPath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

// Level → presence in the OVERVIEW constellation. The constellation renders only the STRUCTURAL
// tiers (project→file, ≤ overviewMaxLevel); class/function leaves collapse onto their parents at
// whole-program scale and only wash out additively (measured 22× overdraw), so they are folded
// into their container's SIZE (structural reach) instead of drawn. Opacity layers depth so the
// architecture reads through; domains dominate, files recede. Indexed by GRANULARITY_LEVEL.
const OVERVIEW_LOD = Object.freeze({
  0: { opacity: 0.55, scale: 0.90 },
  1: { opacity: 1.00, scale: 1.25 },
  2: { opacity: 0.95, scale: 1.08 },
  3: { opacity: 0.90, scale: 0.98 },
  4: { opacity: 0.42, scale: 0.72 },
  5: { opacity: 0.30, scale: 0.55 },
  6: { opacity: 0.20, scale: 0.44 },
});

/**
 * Orchestrates the CLUE System Navigator WebGPU scene and its cinematic HUD.
 */
export class SystemNavigator extends EventTarget {
  #uiErrorLogged = false;
  #transitionCooldownUntil = 0;
  constructor(elements, options = {}) {
    super();
    this.elements = elements;
    this.options = {
      projectName: options.projectName ?? 'Murugan',
      autoStart: options.autoStart ?? true,
      discoveryCinematics: options.discoveryCinematics ?? true,
      hoverDelayMs: options.hoverDelayMs ?? 1650,
      audioEnabled: options.audioEnabled ?? true,
      phaseColors: { ...DEFAULT_PHASE_COLORS, ...(options.phaseColors ?? {}) },
      ...options,
    };

    this.model = new GraphModel({
      projectName: this.options.projectName,
      sourceRoots: options.sourceRoots,
      moduleDepth: options.moduleDepth,
    });
    this.layout = new LayoutEngine(this.model, options.layout);
    this.camera = new NavigatorCamera(options.camera);
    this.discovery = new DiscoveryDirector({
      enabled: this.options.discoveryCinematics,
      ...(options.discovery ?? {}),
    });
    this.audio = new DiscoveryAudio({ enabled: this.options.audioEnabled });
    this.scene = null;
    this.controls = null;
    this.scanBadge = new ScanBadge(elements.scanBadge);
    this.breadcrumb = new NavigatorBreadcrumb(elements.breadcrumb);
    // Clicking a directory segment reframes the graph to that node's level (moving "higher"
    // when it is an ancestor). Routes through frameScope — the one method that keeps activeDepth,
    // focusScopeId AND focusRootId in agreement — so the rendered scope never desyncs from the
    // breadcrumb. Inert in ALL mode (that's a dive; ALL is left only via the toggle). Navigation
    // is a camera/scope move only, never a graph mutation (Zasada 17).
    this.breadcrumb.onNavigate = (id) => { if (!this.overviewMode) this.frameScope(id, { cinematic: true }); };
    this.quickLabel = new QuickLabel(elements.quickLabel);
    // Cinematic discovery pacing: live-discovered units are buffered and revealed on a
    // randomized human cadence while the real scan runs at full speed underneath.
    this.revealOptions = {
      enabled: options.revealPacing !== false,
      minDelayMs: 1000,
      maxDelayMs: 4000,
      // Whole-reveal budget: for big runs the per-element delay compresses so the entire
      // cinematic finishes within ~this, uniformly — small runs still savour each at 1–4s.
      maxTotalMs: options.revealMaxTotalMs ?? 26000,
      // A commit landing this soon after scan start means a replay / degenerate fast run:
      // flush instantly and settle (the protected settle-on-commit behaviour) instead of
      // re-theatricalising history on every dashboard refresh.
      replayFlushMs: 2500,
    };
    this._reveal = {
      active: false, buffer: [], nextAt: 0, revealed: 0,
      scanStartedAt: 0, pendingComplete: null, pendingCommitted: null, visualPercent: 0,
    };
    this.#mountModeToggle();
    this.inspector = new CinematicInspector(elements.inspectorLayer, options.inspector);

    this.running = false;
    this.destroyed = false;
    this.frameHandle = 0;
    this.lastTime = performance.now();
    this.startTime = this.lastTime;
    this.selectedNodeId = this.model.rootId;
    this.hoveredNodeId = null;
    this.inspectedNodeId = null;
    this.focusRootId = this.model.rootId;
    this.previousFocusRootId = this.model.rootId;
    // The node whose CONTENTS are currently framed. This — not raw zoom — decides which
    // granularity is shown. Diving sets it to a child; ascending to the parent.
    this.focusScopeId = this.model.rootId;
    this.#uiErrorLogged = false;
    this.labelPool = [];
    if (this.elements.dragonOverlay) {
      this.elements.dragonOverlay.innerHTML = CLUE_JADE_DRAGON_ANIMATED_SVG;
    }
    this.activeDepth = 0;
    this.previousDepth = 0;
    this.depthTransitionStartedAt = this.lastTime;
    this.depthTransitionDuration = 420;
    this.lastVisibleNodes = [];
    this.lastRenderNodes = [];
    this.lastNodeScreen = new Map();
    this.streamSequences = new Map();
    this.pendingCinematicStatus = null;
    this._countsVersion = -1;
    this._countsCache = null;
    this.overviewMode = false;
    this.overviewStartedAt = 0;
    this._overviewFit = 0;
    this._overviewPrevMaxDistance = null;
    this._overviewAgg = null;
    this._overviewAggVersion = -1;
    // Constellation shows structure down to this granularity; deeper leaves fold into container
    // size. File (4) by default — the whole program's files with their dependency trunks.
    this.overviewMaxLevel = Math.max(1, Math.min(6, options.overviewMaxLevel ?? GRANULARITY_LEVEL.file));
    this.overviewSpread = Math.max(0, Math.min(1.2, options.overviewSpread ?? 0.45));
    this.overviewDragonScale = Math.max(1, Math.min(10, options.overviewDragonScale ?? 3.5));
    this._overviewPos = null;
    this._overviewPosKey = '';
    this._reachCache = null;
    this._reachVersion = -1;

    this.#bindModelEvents();
    this.#bindDiscoveryEvents();
  }

  static async create(elements, options = {}) {
    const navigatorInstance = new SystemNavigator(elements, options);
    try {
      navigatorInstance.scene = await WebGPUScene.create(elements.canvas, options.webgpu);
      navigatorInstance.controls = new NavigatorControls(
        elements.canvas,
        navigatorInstance.camera,
        navigatorInstance.#controlCallbacks(),
        { hoverDelayMs: navigatorInstance.options.hoverDelayMs, ...(options.controls ?? {}) },
      );
      navigatorInstance.camera.frameProject([0, 0, 0]);
      navigatorInstance.layout.rebuild();
      navigatorInstance.#updateBreadcrumb();
      if (navigatorInstance.options.autoStart) navigatorInstance.start();
      navigatorInstance.dispatchEvent(new CustomEvent('ready', {
        detail: { navigator: navigatorInstance },
      }));
      return navigatorInstance;
    } catch (error) {
      elements.errorPanel.textContent = error instanceof Error ? error.message : String(error);
      elements.errorPanel.classList.add('visible');
      navigatorInstance.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }

  start() {
    if (this.destroyed || this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.frameHandle = requestAnimationFrame(this.#frame);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.controls?.destroy();
    this.scene?.destroy();
    this.audio.destroy();
  }

  beginScan(payload = {}) {
    this.#leaveOverviewState();
    this._reveal = {
      active: false, buffer: [], nextAt: 0, revealed: 0,
      scanStartedAt: performance.now(), pendingComplete: null, pendingCommitted: null, visualPercent: 0,
    };
    this.discovery.clear();
    this.model.beginScan(payload);
    this.selectedNodeId = this.model.rootId;
    this.focusRootId = this.model.rootId;
    this.focusScopeId = this.model.rootId;
    this.camera.frameProject([0, 0, 0]);
    this.#updateBreadcrumb();
  }

  updateProgress(payload = {}) {
    this.model.updateProgress(payload);
  }

  addUnit(unit, options = {}) {
    return this.model.addUnit(unit, options);
  }

  addEdge(edge) {
    return this.model.addEdge(edge);
  }

  completeScan(payload = {}) {
    this.model.completeScan(payload);
  }

  /**
   * The recognition is now committed knowledge: the durable graph for this snapshot has
   * been persisted and verified (CLUE_Implementation_v3.md §24.3). This is the only path
   * that marks recognition complete — scan.completed alone is provisional. Emits
   * `recognition-committed` so the host can react to a durable, not merely visual, result
   * (CLUE_v3.md Zasada 17 / A4: the Navigator renders committed knowledge; it is not the
   * commit authority).
   */
  graphCommitted(payload = {}) {
    this.model.completeScan({
      ...payload,
      status: payload.status ?? 'RECOGNITION COMMITTED',
    });
    // The durable seal has arrived: recognition is complete. Every node is already in the
    // graph (the director gates only camera ceremony, not node application), so drain the
    // fly-in backlog now instead of letting it replay for minutes after a fast run. This
    // is what settles the resting view: with no active acquisition the HUD falls through
    // from per-unit "ACQUIRING …" to the committed status, the per-frame node pop-in
    // ("blinking") stops, and the camera holds a stable framing of the committed graph.
    this.discovery.clear();
    this.layout.ensureCurrent();
    // Land on a coherent whole-program view: reset selection so the breadcrumb reads the
    // target (not a deep node left highlighted by the discovery fly-ins), and frame the
    // singularity so activeDepth, scope, camera and breadcrumb all agree.
    this.selectedNodeId = this.model.rootId;
    this.camera.focusNodeId = this.model.rootId;
    this.collapseToSingularity();
    this.dispatchEvent(new CustomEvent('recognition-committed', { detail: payload }));
  }

  loadRecognitionResult(result, options = {}) {
    this.model.replaceGraph(result, options);
    this.layout.rebuild();
    this.camera.frameProject([0, 0, 0]);
  }

  setNodePhase(idOrLogicalId, phase, metadata = {}) {
    return this.model.setNodePhase(idOrLogicalId, phase, metadata);
  }

  setNodeDetails(idOrLogicalId, details = {}) {
    return this.model.setNodeDetails(idOrLogicalId, details);
  }

  focusNode(idOrLogicalId, options = {}) {
    const node = this.model.getNode(idOrLogicalId);
    if (!node) return false;
    this.layout.ensureCurrent();
    this.selectedNodeId = node.id;
    // The render scope (focusRootId) must stay STRICTLY shallower than the view depth, or
    // displaySetForDepth reverts to the whole project — a leaf class clicked at class depth would
    // otherwise show all project classes (the H3 scope-fallback the probe caught). A node that is
    // not a valid deeper scope keeps the CURRENT level: scope to its nearest ancestor above
    // activeDepth and simply centre + inspect the node in context.
    let scope = node;
    if (node.level >= this.activeDepth) {
      let up = node;
      while (up && up.level >= this.activeDepth) up = up.parentId ? this.model.getNode(up.parentId) : null;
      scope = up ?? this.model.nodes.get(this.model.rootId);
    }
    this.focusRootId = scope.id;
    this.focusScopeId = scope.id;
    this.camera.focus(
      this.model.worldPosition(node),
      options.distance ?? this.camera.distanceForLevel(Math.min(6, node.level + (node.children.length > 0 ? 1 : 0))),
      node.id,
      { cinematic: options.cinematic ?? true },
    );
    this.#showInspector(node, options.pinInspector ?? false);
    this.#updateBreadcrumb();
    this.dispatchEvent(new CustomEvent('node-focus', { detail: { node, options } }));
    return true;
  }

  /** Deterministic Q1 SURF → semantic DIVE handoff. */
  enterDiveForFile(context = {}) {
    const resolution = resolveSemanticFileNode(this.model, context);
    if (!resolution.ok || !resolution.node) {
      this.dispatchEvent(new CustomEvent('file-dive-unavailable', {
        detail: { context: resolution.context ?? context, reason: resolution.reason },
      }));
      return false;
    }

    const fileNode = resolution.node;
    this.#leaveOverviewState();
    const framed = this.frameScope(fileNode.id, { cinematic: true });
    if (!framed) return false;
    this.selectedNodeId = fileNode.id;
    this.dispatchEvent(new CustomEvent('file-dive-entered', {
      detail: { context: resolution.context, semanticNodeId: fileNode.id },
    }));
    return true;
  }

  frameProject() {
    this.inspector.hide(true);
    // Whole-program view = frame the root's contents, centred and fully in view.
    if (!this.frameScope(this.model.rootId)) {
      this.selectedNodeId = this.model.rootId;
      this.focusRootId = this.model.rootId;
      this.focusScopeId = this.model.rootId;
      this.camera.frameProject([0, 0, 0]);
      this.#updateBreadcrumb();
    }
  }

  enableAudio() {
    return this.audio.enable();
  }

  setAudioPlayer(player) {
    this.audio.setCustomPlayer(player);
  }

  applyEvent(eventInput) {
    const event = assertNavigatorEvent(eventInput);
    const lastSequence = this.streamSequences.get(event.streamId) ?? -Infinity;
    if (event.sequence <= lastSequence) return false;
    this.streamSequences.set(event.streamId, event.sequence);

    switch (event.type) {
      case 'navigator.reset':
        this.beginScan({ projectName: event.payload.projectName ?? this.options.projectName, reset: true });
        break;
      case 'inventory.started':
      case 'inventory.taxonomy':
      case 'files.upserted':
      case 'files.removed':
      case 'inventory.completed':
      case 'dependency.discovered':
      case 'file.semantic-summary':
        // Physical inventory is a separate Q1 projection. The adapter forwards the
        // versioned envelope unchanged to SURF; semantic graph membership is untouched.
        break;
      case 'recognition.started':
        this.updateProgress({
          status: event.payload.status ?? 'SEMANTIC RECOGNITION STARTING',
          snapshotId: event.snapshotId,
        });
        break;
      case 'scan.started':
        this.beginScan({ ...event.payload, snapshotId: event.snapshotId });
        break;
      case 'scan.progress':
        this.updateProgress(event.payload);
        break;
      case 'unit.discovered': {
        const unit = event.payload.unit ?? event.payload;
        const cinematic = event.payload.cinematic !== false;
        if (this.revealOptions.enabled && cinematic) {
          // Buffer for the paced reveal. The model receives the unit only at reveal time;
          // edges referencing it are already deferred by the model (pendingEdges) and resolve
          // the moment the unit lands, so no relation is ever lost.
          this._reveal.buffer.push({ unit, purpose: event.payload.purpose, details: event.payload.details });
          this._reveal.active = true;
        } else {
          this.addUnit(unit, { cinematic, purpose: event.payload.purpose });
          if (event.payload.details) this.setNodeDetails(unit.logicalId, event.payload.details);
        }
        break;
      }
      case 'edge.discovered':
        this.addEdge(event.payload.edge ?? event.payload);
        break;
      case 'reference.unresolved':
        this.model.updateProgress({
          unresolved: Number(this.model.progress.unresolved ?? 0) + 1,
          status: 'MAPPING GRAPH GAPS',
        });
        break;
      case 'unit.phase':
        this.setNodePhase(event.payload.id ?? event.payload.logicalId, event.payload.phase, event.payload.metadata);
        break;
      case 'unit.details':
        this.setNodeDetails(event.payload.id ?? event.payload.logicalId, event.payload.details ?? event.payload);
        break;
      case 'scan.completed': {
        // Provisional: the scan finished, but the graph is not yet durable. Do not claim
        // recognition complete here — wait for graph.committed. When the stream carries
        // no commit step (older producers), this remains the terminal event, so the
        // status still reflects a finished scan.
        const completePayload = {
          ...event.payload,
          status: event.payload.status ?? 'SCAN COMPLETE · COMMITTING GRAPH',
        };
        if (this._reveal.active && this._reveal.buffer.length > 0) {
          // The real scan is done; the paced reveal is still playing. Hold the visual
          // completion (it hard-sets percent 100) until the reveal drains.
          this._reveal.pendingComplete = completePayload;
        } else {
          this.completeScan(completePayload);
        }
        break;
      }
      case 'graph.committing':
        // Persistence has started; keep the graph as-is and reflect the state.
        this.updateProgress({ status: event.payload.status ?? 'COMMITTING GRAPH' });
        break;
      case 'graph.committed': {
        // The durable graph is written and verified — recognition is now committed.
        if (this._reveal.active && this._reveal.buffer.length > 0) {
          const sinceStart = performance.now() - this._reveal.scanStartedAt;
          if (sinceStart < this.revealOptions.replayFlushMs) {
            // Replay / degenerate fast run: land everything instantly and settle now —
            // the protected settle-on-commit behaviour, never minutes of ceremony.
            this.flushReveal();
            this.graphCommitted(event.payload);
          } else {
            // Live run: the truth is committed underneath; the paced reveal finishes the
            // cinematic, then the visual commit (settle + collapse) is applied.
            this._reveal.pendingCommitted = event.payload;
          }
        } else {
          this._reveal.active = false;
          this.graphCommitted(event.payload);
        }
        break;
      }
      case 'graph.replace':
        this.loadRecognitionResult(event.payload.result ?? event.payload, {
          snapshotId: event.snapshotId,
          cinematic: event.payload.cinematic,
        });
        break;
      case 'observer.error':
        // Known, diagnostic-only event (CLUE_Implementation_v3.md §24.3): the recognizer's
        // observer seam reported a failure, already redacted by the writer. It must never
        // mutate the graph — surface it for the HUD/console to display.
        this.dispatchEvent(new CustomEvent('observer-error', { detail: event.payload }));
        break;
      default:
        return false;
    }
    return true;
  }

  exportViewState() {
    return {
      v: 1,
      selectedNodeId: this.selectedNodeId,
      focusRootId: this.focusRootId,
      camera: {
        target: [...this.camera.target],
        desiredTarget: [...this.camera.desiredTarget],
        yaw: this.camera.yaw,
        pitch: this.camera.pitch,
        distance: this.camera.distance,
      },
      manualOffsets: [...this.model.nodes.values()]
        .filter((node) => node.manualOffset.some((value) => Math.abs(value) > 1e-6))
        .map((node) => ({ id: node.id, offset: [...node.manualOffset] })),
    };
  }

  importViewState(state) {
    if (!state || state.v !== 1) throw new TypeError('Unsupported System Navigator view state.');
    for (const entry of state.manualOffsets ?? []) {
      const node = this.model.nodes.get(entry.id);
      if (node && Array.isArray(entry.offset) && entry.offset.length === 3) node.manualOffset = [...entry.offset];
    }
    if (state.camera) {
      this.camera.target = [...(state.camera.target ?? this.camera.target)];
      this.camera.desiredTarget = [...(state.camera.desiredTarget ?? this.camera.target)];
      this.camera.yaw = this.camera.desiredYaw = state.camera.yaw ?? this.camera.yaw;
      this.camera.pitch = this.camera.desiredPitch = state.camera.pitch ?? this.camera.pitch;
      this.camera.distance = this.camera.desiredDistance = state.camera.distance ?? this.camera.distance;
    }
    if (state.selectedNodeId && this.model.nodes.has(state.selectedNodeId)) this.selectedNodeId = state.selectedNodeId;
    if (state.focusRootId && this.model.nodes.has(state.focusRootId)) {
      this.focusRootId = state.focusRootId;
      this.focusScopeId = state.focusRootId;
    }
    this.#updateBreadcrumb();
  }

  #frame = (now) => {
    if (!this.running || this.destroyed) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    this.layout.ensureCurrent();
    this.discovery.update(now);
    this.#updateReveal(now);
    this.controls?.update(now);
    this.camera.update(dt, this.scene.width, this.scene.height);
    this.#checkZoomTransitions(now);
    const frameData = this.#buildFrameData(now);
    this.scene.render({
      ...frameData,
      camera: this.camera,
      timeSeconds: (now - this.startTime) / 1000,
      semanticDepth: this.activeDepth,
    });
    this.#updateScreenProjection(frameData.nodes);
    this.#updateUi();
    this.frameHandle = requestAnimationFrame(this.#frame);
  };

  #buildFrameData(now) {
    if (this.overviewMode) return this.#buildOverviewFrame(now);
    const transition = smoothstep(0, 1, (now - this.depthTransitionStartedAt) / this.depthTransitionDuration);
    const currentFocus = this.focusRootId ?? this.model.rootId;
    const currentNodes = this.model.displaySetForDepth(this.activeDepth, currentFocus);
    const previousFocus = this.previousFocusRootId ?? currentFocus;
    const previousNodes = this.previousDepth === this.activeDepth
      ? []
      : this.model.displaySetForDepth(this.previousDepth, previousFocus);

    const renderMap = new Map();
    for (const node of previousNodes) renderMap.set(node.id, this.#renderNode(node, 1 - transition, now));
    for (const node of currentNodes) {
      const candidate = this.#renderNode(node, transition, now);
      const existing = renderMap.get(node.id);
      if (!existing || candidate.opacity > existing.opacity) renderMap.set(node.id, candidate);
    }
    const renderNodes = [...renderMap.values()].filter((node) => node.opacity > 0.006);
    const currentVisibleIds = new Set(currentNodes.map((node) => node.id));
    const nodeIndex = new Map(renderNodes.map((node, index) => [node.id, index]));
    const aggregated = this.model.aggregatedEdgesFor(currentNodes);
    const highlightId = this.hoveredNodeId ?? this.selectedNodeId;
    const renderEdges = [];
    for (const edge of aggregated) {
      if (!currentVisibleIds.has(edge.from) || !currentVisibleIds.has(edge.to)) continue;
      const fromIndex = nodeIndex.get(edge.from);
      const toIndex = nodeIndex.get(edge.to);
      if (fromIndex == null || toIndex == null) continue;
      const fromNode = this.model.nodes.get(edge.from);
      const toNode = this.model.nodes.get(edge.to);
      const active = [fromNode?.phase, toNode?.phase].some((phase) => ['diagnosing', 'testing', 'patching', 'discovered'].includes(phase));
      const phase = fromNode?.phase === 'patching' || toNode?.phase === 'patching'
        ? 'patching'
        : active ? 'diagnosing' : 'stable';
      const connected = highlightId != null && (edge.from === highlightId || edge.to === highlightId);
      const baseOpacity = clamp(0.13 + Math.log2(1 + edge.weight) * 0.075, 0.13, 0.62);
      renderEdges.push({
        fromIndex,
        toIndex,
        weight: edge.weight,
        highlight: connected ? 1 : (active ? 1 : 0),
        color: connected ? hexToRgb('#f4af2d') : hexToRgb(this.options.phaseColors[phase]),
        opacity: connected ? Math.max(0.85, baseOpacity) : baseOpacity,
      });
    }
    this.lastVisibleNodes = currentNodes;
    this.lastRenderNodes = renderNodes;
    return { nodes: renderNodes, edges: renderEdges };
  }

  #renderNode(node, opacity, now) {
    const phaseElapsed = (now - node.phaseStartedAt) / 1000;
    const discoveryAge = (now - node.discoveredAt) / 1000;
    const immediateDiscovery = node.discoveryVisual && node.phase === 'stable' && discoveryAge < 1.45;
    let pulse = 0;
    if (node.phase === 'discovered') {
      const flash = Math.max(0, Math.sin(phaseElapsed * Math.PI * 3.2));
      pulse = flash * Math.max(0, 1 - phaseElapsed / 2.4);
    } else if (node.phase === 'diagnosing' || node.phase === 'testing') {
      pulse = 0.35 + 0.32 * (Math.sin(phaseElapsed * 4.6) * 0.5 + 0.5);
    } else if (node.phase === 'patching') {
      pulse = 0.30 + 0.24 * (Math.sin(phaseElapsed * 3.0) * 0.5 + 0.5);
    } else if (node.phase === 'blocked') {
      pulse = 0.50 + 0.40 * (Math.sin(phaseElapsed * 7.0) * 0.5 + 0.5);
    } else if (immediateDiscovery) {
      pulse = Math.max(0, Math.sin(discoveryAge * Math.PI * 4.15)) * (1 - discoveryAge / 1.45);
    }
    const selected = node.id === this.selectedNodeId || node.id === this.hoveredNodeId;
    const displayPhase = immediateDiscovery ? 'discovered' : node.phase;
    const colorHex = this.options.phaseColors[displayPhase] ?? this.options.phaseColors.stable;
    const degreeScale = 1 + Math.min(0.34, Math.log2(1 + node.metrics.inbound + node.metrics.outbound) * 0.035);
    return {
      id: node.id,
      sourceNode: node,
      position: this.model.worldPosition(node),
      radius: NODE_RADIUS[node.granularity] * node.radiusJitter * degreeScale,
      color: hexToRgb(colorHex),
      opacity: opacity * (node.phase === 'blocked' ? 0.92 : 1),
      shape: node.shape,
      pulse,
      selected,
      phaseCode: PHASE_CODE[node.phase] ?? 0,
      seed: node.seed % 100000,
      discovery: node.phase === 'discovered' ? 1 : 0,
      optimized: node.details.optimized === 'verified' || node.details.optimized === true,
      level: node.level,
    };
  }

  /**
   * Frame a granularity: centre and fit the CONTENTS of `scopeId` (its immediate children)
   * so the whole level sits in front of the operator. This is the single method every
   * granularity change routes through — default view, dive, and ascend all call it — so the
   * camera is always pointed at what the current level is supposed to show.
   */
  frameScope(scopeId, options = {}) {
    const scope = this.model.getNode(scopeId) ?? this.model.getNode(this.model.rootId);
    if (!scope) return false;
    this.#leaveOverviewState();
    this.layout.ensureCurrent();
    const children = scope.children
      .map((id) => this.model.getNode(id))
      .filter((node) => node !== null && node !== undefined);
    const framed = children.length > 0 ? children : [scope];
    const positions = framed.map((node) => this.model.worldPosition(node));
    const centroid = positions
      .reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0])
      .map((v) => v / positions.length);
    let radius = 0;
    for (const p of positions) {
      radius = Math.max(radius, Math.hypot(p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]));
    }
    radius = Math.max(radius + 2.2, 4.5); // pad for node radius and breathing room

    // Drive the semantic depth from the scope (show its children), reusing the existing
    // cross-fade machinery so the level change is a smooth dissolve, not a jump.
    const targetDepth = clamp(scope.level + (children.length > 0 ? 1 : 0), 0, 6);
    if (targetDepth !== this.activeDepth || scope.id !== this.focusScopeId) {
      this.previousDepth = this.activeDepth;
      this.previousFocusRootId = this.focusRootId;
      this.activeDepth = targetDepth;
      this.depthTransitionStartedAt = performance.now();
    }
    this.focusScopeId = scope.id;
    this.focusRootId = scope.id;
    this.selectedNodeId = scope.id;
    this.camera.frameContents(centroid, radius, {
      nodeId: scope.id,
      cinematic: options.cinematic ?? true,
    });
    this.#updateBreadcrumb();
    this.dispatchEvent(new CustomEvent('semantic-depth', {
      detail: { current: this.activeDepth, granularity: LEVEL_GRANULARITY[this.activeDepth], scope: scope.id },
    }));
    return true;
  }

  /** Dive one granularity deeper into a node (double-click, or zoom in very close). */
  diveInto(nodeId, options = {}) {
    const node = this.model.getNode(nodeId);
    if (!node || node.children.length === 0) return false; // a leaf has nothing deeper
    this.frameScope(node.id, options);
    this.dispatchEvent(new CustomEvent('granularity-dive', { detail: { scope: node.id } }));
    return true;
  }

  /** Ascend one granularity, back out to the current scope's parent (zoom out to the edge). */
  ascend(options = {}) {
    const scope = this.model.getNode(this.focusScopeId ?? this.model.rootId);
    if (!scope || !scope.parentId) {
      this.frameScope(this.model.rootId, options);
      return false;
    }
    this.frameScope(scope.parentId, options);
    this.dispatchEvent(new CustomEvent('granularity-ascend', { detail: { scope: scope.parentId } }));
    return true;
  }

  /**
   * A zoom gesture past the edges of the framed level changes granularity: pushing in close
   * enough dives into the node under focus; pulling out past the scope's frame ascends. Zoom
   * between those bounds just moves the camera within the current level (free orbit/zoom).
   */
  #checkZoomTransitions(_now) {
    const framed = this.camera.scopeDistance;
    if (!Number.isFinite(framed) || framed <= 0) return;
    const ratio = this.camera.desiredDistance / framed;
    if (this.#depthTransitioning()) return;                    // don't retrigger mid-dissolve
    if (performance.now() < this.#transitionCooldownUntil) return; // debounce after a change

    if (this.overviewMode) {
      // ALL is a locked whole-program view: zooming NEVER dives or exits, however deep the
      // operator zooms in. Orbit and zoom freely to inspect the constellation. The only way
      // in or out of ALL is the Dive/All toggle (or a click on a node in DIVE mode).
      return;
    }

    const scope = this.model.getNode(this.focusScopeId ?? this.model.rootId);
    const atRoot = !scope || !scope.parentId;

    if (ratio < 0.55) {
      // DESCEND. From the whole-program singularity, zooming in re-enters the program's
      // contents (its domains). Otherwise step into the node being zoomed toward.
      if (this.#isSingularity()) {
        this.#transitionCooldownUntil = performance.now() + 650;
        this.#enterFromSingularity();
        return;
      }
      const target = this.#descendTargetUnderScope();
      if (target) {
        this.#transitionCooldownUntil = performance.now() + 650;
        this.frameScope(target.id);
        this.dispatchEvent(new CustomEvent('granularity-dive', { detail: { scope: target.id } }));
      }
    } else if (!atRoot && ratio > 1.9) {
      // ASCEND a normal scope to its parent (reachable: deeper scopes are well under maxDistance).
      this.#transitionCooldownUntil = performance.now() + 650;
      this.ascend();
    } else if (atRoot && !this.#isSingularity() && ratio > 1.35) {
      // COLLAPSE the program-contents view to the whole-program singularity. The threshold is
      // deliberately lower than a normal ascend because at the root the fit distance is already
      // near maxDistance, so a full 1.9x zoom-out is not reachable — 1.35x is.
      this.#transitionCooldownUntil = performance.now() + 650;
      this.collapseToSingularity();
    } else if (this.#isSingularity() && this.camera.desiredDistance >= this.camera.maximumDistance * 0.985) {
      // OVERVIEW. The singularity fit sits near maxDistance, so a ratio test is unreachable
      // here; pegging the zoom at the ceiling is the deliberate "keep going" gesture that
      // expands the single icon into the whole-program constellation.
      this.#transitionCooldownUntil = performance.now() + 650;
      this.enterOverview();
    }
  }

  /** True when the view is the whole-program singularity (root node alone, framed as a point). */
  #isSingularity() {
    return this.activeDepth === 0 && this.focusScopeId === this.model.rootId;
  }

  /**
   * OVERVIEW — the whole program at once. Every recognized node renders simultaneously as a
   * constellation: children cluster around their ancestors (the deterministic layout already
   * builds this shape), opacity and size encode depth so structure reads *through* the deeper
   * strata, and relations show as bright module-level trunks over faint leaf threads. This is
   * the ag-kit whole-system-map idea (its Mermaid subgraph clustering) fused with the
   * Navigator's dive: zoom out past the singularity to enter; zoom in, click any node, or use
   * the breadcrumb to leave. Projection only — no layout physics, no new graph state
   * (Zasada 17); the LayoutEngine's deterministic positions are used exactly as-is.
   */
  enterOverview(options = {}) {
    if (this.overviewMode) return true;
    if (this.model.nodes.size <= 1) return false;
    this.layout.ensureCurrent();
    const positions = this.#overviewPositions(); // level-graduated spread (gaps survive framing)
    let cx = 0, cy = 0, cz = 0, count = 0;
    for (const node of this.model.nodes.values()) {
      if (node.level > this.overviewMaxLevel) continue; // frame the shown structure, not hidden leaves
      const p = positions.get(node.id) ?? this.model.worldPosition(node);
      cx += p[0]; cy += p[1]; cz += p[2]; count += 1;
    }
    count = Math.max(1, count);
    const centre = [cx / count, cy / count, cz / count];
    let radius = 6;
    for (const node of this.model.nodes.values()) {
      if (node.level > this.overviewMaxLevel) continue;
      const p = positions.get(node.id) ?? this.model.worldPosition(node);
      radius = Math.max(radius, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]));
    }
    this.overviewMode = true;
    this.overviewStartedAt = performance.now();
    this.activeDepth = 0;
    this.previousDepth = 0;
    this.focusScopeId = this.model.rootId;
    this.focusRootId = this.model.rootId;
    this.selectedNodeId = this.model.rootId;
    // The constellation is larger than any single scope: widen the camera ceiling for the
    // duration of the overview (restored on leave) and frame the whole cloud.
    this._overviewPrevMaxDistance = this.camera.maximumDistance;
    this.camera.maximumDistance = Math.max(this._overviewPrevMaxDistance, radius * 3.4);
    this.camera.frameContents(centre, radius, { nodeId: this.model.rootId, cinematic: options.cinematic !== false });
    this._overviewFit = this.camera.scopeDistance || this.camera.desiredDistance;
    this.#updateBreadcrumb();
    this.dispatchEvent(new CustomEvent('overview-changed', { detail: { active: true } }));
    return true;
  }

  exitOverview() {
    if (!this.overviewMode) return false;
    this.#leaveOverviewState();
    this.collapseToSingularity();
    return true;
  }

  toggleOverview() {
    return this.overviewMode ? this.exitOverview() : this.enterOverview();
  }

  // Internal: drop the overview flag and restore the camera ceiling. Callers reframe
  // afterwards — frameScope and collapseToSingularity are the funnels every granularity
  // change routes through, so any dive, click, or breadcrumb jump exits the overview cleanly.
  #leaveOverviewState() {
    if (!this.overviewMode) return;
    this.overviewMode = false;
    if (this._overviewPrevMaxDistance != null) {
      this.camera.maximumDistance = this._overviewPrevMaxDistance;
      this._overviewPrevMaxDistance = null;
    }
    this.dispatchEvent(new CustomEvent('overview-changed', { detail: { active: false } }));
  }

  // The overview frame: the union of every node, LOD-layered, with two edge tiers.
  #buildOverviewFrame(now) {
    const blend = smoothstep(0, 1, (now - this.overviewStartedAt) / 700);
    const reach = this.#descendantCounts();
    const positions = this.#overviewPositions();
    const highlightId = this.hoveredNodeId ?? this.selectedNodeId;
    const renderNodes = [];
    const nodeIndex = new Map();
    const union = [];
    for (const node of this.model.nodes.values()) {
      // Structural tiers only — leaves below overviewMaxLevel are represented by their
      // container's SIZE (reach), not drawn, so nothing collapses into an additive blob.
      if (node.level > this.overviewMaxLevel) continue;
      const tier = OVERVIEW_LOD[node.level] ?? OVERVIEW_LOD[6];
      const rendered = this.#renderNode(node, blend * tier.opacity, now);
      if (rendered.opacity <= 0.006) continue;
      // size = structural reach (CLUE_v3 §28C.3): a file with 40 functions reads bigger than
      // one with 2, so the whole program's mass is still legible without drawing every leaf.
      const descendants = reach.get(node.id) ?? 0;
      const reachScale = 1 + Math.min(1.05, Math.log2(1 + descendants) * 0.12);
      rendered.radius *= tier.scale * reachScale;
      rendered.position = (positions.get(node.id) ?? rendered.position).slice(); // spread layout
      nodeIndex.set(node.id, renderNodes.length);
      renderNodes.push(rendered);
      union.push(node);
    }
    const { trunk, leaf } = this.#overviewAggregates();
    const renderEdges = [];
    const pushEdge = (edge, floorOpacity, ceilOpacity, gain) => {
      const fromIndex = nodeIndex.get(edge.from);
      const toIndex = nodeIndex.get(edge.to);
      if (fromIndex == null || toIndex == null || edge.from === edge.to) return;
      const fromNode = this.model.nodes.get(edge.from);
      const toNode = this.model.nodes.get(edge.to);
      const active = [fromNode?.phase, toNode?.phase].some((phase) => ['diagnosing', 'testing', 'patching', 'discovered'].includes(phase));
      const phase = fromNode?.phase === 'patching' || toNode?.phase === 'patching'
        ? 'patching'
        : active ? 'diagnosing' : 'stable';
      const connected = highlightId != null && (edge.from === highlightId || edge.to === highlightId);
      const baseOpacity = blend * clamp(floorOpacity + Math.log2(1 + edge.weight) * gain, floorOpacity, ceilOpacity);
      renderEdges.push({
        fromIndex,
        toIndex,
        weight: edge.weight,
        highlight: connected ? 1 : (active ? 1 : 0),
        color: connected ? hexToRgb('#f4af2d') : hexToRgb(this.options.phaseColors[phase]),
        opacity: connected ? Math.max(0.9 * blend, baseOpacity) : baseOpacity,
      });
    };
    for (const edge of trunk) pushEdge(edge, 0.16, 0.60, 0.09);  // module trunks — the architecture
    for (const edge of leaf) pushEdge(edge, 0.05, 0.24, 0.03);   // file-level relations
    this.lastVisibleNodes = union;
    this.lastRenderNodes = renderNodes;
    return { nodes: renderNodes, edges: renderEdges };
  }

  // Descendant count per node (all levels below), cached against graph version — the "reach"
  // that sizes container nodes so hidden leaves are represented. Single post-order pass.
  #descendantCounts() {
    if (this._reachVersion === this.model.version && this._reachCache) return this._reachCache;
    const counts = new Map();
    const visit = (node) => {
      let total = 0;
      for (const childId of node.children ?? []) {
        const child = this.model.nodes.get(childId);
        if (!child) continue;
        total += 1 + visit(child);
      }
      counts.set(node.id, total);
      return total;
    };
    const root = this.model.nodes.get(this.model.rootId);
    if (root) visit(root);
    this._reachCache = counts;
    this._reachVersion = this.model.version;
    return counts;
  }

  /** Set how deep the constellation renders (1 domain … 6 function). Re-enters overview to apply. */
  setOverviewMaxLevel(level) {
    this.overviewMaxLevel = Math.max(1, Math.min(6, Math.round(level)));
    this._overviewAggVersion = -1;
    this._overviewPosKey = '';
    if (this.overviewMode) { this.#leaveOverviewState(); this.enterOverview(); }
    return this.overviewMaxLevel;
  }

  // Overview layout: spread each node from its parent by a LEVEL-GRADUATED factor. A uniform
  // scale is invisible after the camera reframes to fit, so deeper levels must spread MORE —
  // that opens the crowded inner clusters while preserving the hierarchy (root stays put at
  // factor 1). enterOverview reframes to the resulting extent so nothing clips. Deterministic
  // and projection-only (no force solver, no new graph state); cached against version+spread+depth.
  #overviewPositions() {
    const key = `${this.model.version}:${this.overviewSpread}:${this.overviewMaxLevel}`;
    if (this._overviewPosKey === key && this._overviewPos) return this._overviewPos;
    const positions = new Map();
    const compute = (node) => {
      const cached = positions.get(node.id);
      if (cached) return cached;
      const base = this.model.worldPosition(node);
      const parent = node.parentId ? this.model.nodes.get(node.parentId) : null;
      if (!parent) { const p = base.slice(); positions.set(node.id, p); return p; }
      const parentPos = compute(parent);
      const parentBase = this.model.worldPosition(parent);
      const factor = 1 + this.overviewSpread * node.level;
      const p = [
        parentPos[0] + (base[0] - parentBase[0]) * factor,
        parentPos[1] + (base[1] - parentBase[1]) * factor,
        parentPos[2] + (base[2] - parentBase[2]) * factor,
      ];
      positions.set(node.id, p);
      return p;
    };
    for (const node of this.model.nodes.values()) {
      if (node.level <= this.overviewMaxLevel) compute(node);
    }
    this._overviewPos = positions;
    this._overviewPosKey = key;
    return positions;
  }

  /** Spacing of the ALL constellation (0 = layout as-is, higher = more distance between elements). */
  setOverviewSpread(strength) {
    this.overviewSpread = Math.max(0, Math.min(1.2, Number(strength) || 0));
    this._overviewPosKey = '';
    if (this.overviewMode) { this.#leaveOverviewState(); this.enterOverview(); }
    return this.overviewSpread;
  }

  /** Dragon size in ALL, as a multiple of the root node's shape (typical shape ≈ 3–4). */
  setDragonScale(multiple) {
    this.overviewDragonScale = Math.max(1, Math.min(10, Number(multiple) || 3.5));
    return this.overviewDragonScale;
  }

  // Aggregated edge sets for the overview, cached against the graph version: trunks at module
  // granularity (the ag-kit "subgraph" relations) plus every leaf relation. Aggregation walks
  // all raw edges, so it must not run per frame — only when the graph actually changes.
  #overviewAggregates() {
    if (this._overviewAggVersion === this.model.version && this._overviewAgg) return this._overviewAgg;
    const trunkSet = this.model.displaySetForDepth(GRANULARITY_LEVEL.module, this.model.rootId);
    // Leaf tier aggregates raw relations up to the shown granularity (file-file), collapsing
    // the ~5000 function threads into readable inter-file dependencies.
    const shownSet = [...this.model.nodes.values()].filter((node) => node.level <= this.overviewMaxLevel);
    this._overviewAgg = {
      trunk: this.model.aggregatedEdgesFor(trunkSet),
      leaf: this.model.aggregatedEdgesFor(shownSet),
    };
    this._overviewAggVersion = this.model.version;
    return this._overviewAgg;
  }

  /**
   * Paced cinematic reveal. Live-discovered units wait here and land one at a time on a
   * randomized 1–4s cadence (frame-driven — no timers to leak), each landing running the
   * existing DiscoveryDirector ceremony with the neighbour-showing camera. The cadence
   * accelerates as the backlog grows so a large run stays bounded, and the visual scan bar
   * tracks the reveal, not the real (already finished) scan. Truth is never invented or lost:
   * the model receives every unit, edges defer until their endpoints land, and the durable
   * commit is applied the moment the cinematic drains (or instantly for replays).
   */
  #updateReveal(now) {
    const state = this._reveal;
    if (!state.active) return;
    if (state.buffer.length === 0) {
      if (state.pendingComplete || state.pendingCommitted) this.#finishReveal();
      return; // scan still producing — wait for more discoveries
    }
    if (now < state.nextAt) return;
    const { minDelayMs, maxDelayMs, maxTotalMs } = this.revealOptions;
    // Pace by the TOTAL for this run (revealed + still buffered), which is stable once the scan
    // completes — NOT the shrinking backlog. The old backlog-based acceleration decelerated as
    // the buffer emptied, so the last 2% reverted to the full 1–4s delay and trickled in (the
    // reported "last 2% not appearing"). A whole-reveal time budget keeps the pace uniform to
    // the very end and bounds large runs, while small runs still get the full 1–4s per element.
    const total = Math.max(1, state.revealed + state.buffer.length);
    const perUnitBudget = maxTotalMs / total;
    const base = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
    const delay = Math.max(45, Math.min(base, perUnitBudget));
    // If the budget is below a frame-friendly delay, reveal several per tick instead of stalling
    // at the frame rate — this is the ONLY place grouping happens, and it's uniform (no tail dump).
    const group = perUnitBudget < 55 ? Math.max(1, Math.round(55 / perUnitBudget)) : 1;
    for (let index = 0; index < group && state.buffer.length > 0; index += 1) this.#revealNext();
    state.nextAt = now + delay;
  }

  #revealNext() {
    const entry = this._reveal.buffer.shift();
    if (!entry) return;
    this.addUnit(entry.unit, { cinematic: true, purpose: entry.purpose });
    if (entry.details) this.setNodeDetails(entry.unit.logicalId, entry.details);
    this._reveal.revealed += 1;
  }

  #finishReveal() {
    const state = this._reveal;
    state.active = false;
    state.visualPercent = 100;
    if (state.pendingComplete) {
      const payload = state.pendingComplete;
      state.pendingComplete = null;
      this.completeScan(payload);
    }
    if (state.pendingCommitted) {
      const payload = state.pendingCommitted;
      state.pendingCommitted = null;
      this.graphCommitted(payload);
    }
  }

  /** Land every buffered unit instantly (no per-unit ceremony) and apply any held terminal state. */
  flushReveal() {
    const state = this._reveal;
    while (state.buffer.length > 0) {
      const entry = state.buffer.shift();
      this.addUnit(entry.unit, { cinematic: false, purpose: entry.purpose });
      if (entry.details) this.setNodeDetails(entry.unit.logicalId, entry.details);
      state.revealed += 1;
    }
    if (state.pendingComplete || state.pendingCommitted) this.#finishReveal();
    else state.active = false;
  }

  /** Tune the reveal cadence live, e.g. setRevealPacing({ minDelayMs: 500, maxDelayMs: 2000 }). */
  setRevealPacing(partial = {}) {
    this.revealOptions = { ...this.revealOptions, ...partial };
    return this.revealOptions;
  }

  // Visual (paced) scan percent while the cinematic plays; null when pacing is idle so the
  // badge falls back to the model's real progress. Monotonic so the bar never runs backwards
  // when a burst of discoveries deepens the backlog.
  #revealVisualProgress() {
    const state = this._reveal;
    if (!state.active) return null;
    const scanDone = !!(state.pendingComplete || state.pendingCommitted);
    const denominator = Math.max(1, state.revealed + state.buffer.length + (scanDone ? 0 : 1));
    const raw = (100 * state.revealed) / denominator;
    state.visualPercent = Math.max(state.visualPercent, Math.min(scanDone ? 100 : 96, raw));
    return state.visualPercent;
  }

  /**
   * Top-right DIVE/ALL mode switch: one tap between the semantic dive and the whole-program
   * constellation. Mounted programmatically with its own injected style block so this feature
   * ships in a single file; consolidating the CSS into styles.js is a later cleanup, not a
   * behaviour change. Feature-detected — a host template without the expected structure
   * simply gets no toggle.
   */
  #mountModeToggle() {
    const host = this.elements.breadcrumb?.parentElement;
    if (!host || host.querySelector('.mode-toggle')) return;
    const root = this.elements.breadcrumb.getRootNode?.();
    if (root && typeof root.querySelector === 'function' && !root.querySelector('#clue-mode-toggle-style')) {
      const style = document.createElement('style');
      style.id = 'clue-mode-toggle-style';
      style.textContent = `
        .mode-toggle { position: absolute; top: 22px; right: 25px; z-index: 12; display: inline-flex;
          padding: 3px; gap: 2px; cursor: pointer; user-select: none; pointer-events: auto;
          background: rgba(0, 8, 12, 0.34); border: 1px solid rgba(0, 163, 224, 0.22);
          clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
          backdrop-filter: blur(14px) saturate(1.25); }
        .mode-toggle .mt-opt { padding: 3px 9px; font-size: 8px; letter-spacing: 0.14em;
          text-transform: uppercase; color: rgba(0, 163, 224, 0.55); transition: color 200ms ease, background 200ms ease, text-shadow 200ms ease; }
        .mode-toggle[data-mode="dive"] .mt-dive, .mode-toggle[data-mode="all"] .mt-all {
          color: #eafaff; background: rgba(0, 163, 224, 0.20); text-shadow: 0 0 8px rgba(0, 163, 224, 0.8); }
        .mode-toggle:hover { border-color: rgba(0, 163, 224, 0.5); }
      `;
      root.appendChild(style);
    }
    const toggle = document.createElement('div');
    toggle.className = 'mode-toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('tabindex', '0');
    toggle.title = 'Graph mode: semantic dive ↔ whole-program constellation';
    toggle.innerHTML = '<span class="mt-opt mt-dive">Dive</span><span class="mt-opt mt-all">All</span>';
    toggle.dataset.mode = this.overviewMode ? 'all' : 'dive';
    // Segmented SELECTOR, not a flip: clicking a side SELECTS that mode; clicking the already
    // active side is a no-op. Fixes "clicking Dive while in Dive pushes me to ALL".
    const selectMode = (wantAll) => {
      if (wantAll && !this.overviewMode) this.enterOverview();
      else if (!wantAll && this.overviewMode) this.exitOverview();
    };
    toggle.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && target.closest('.mt-all')) selectMode(true);
      else if (target && target.closest('.mt-dive')) selectMode(false);
      else selectMode(!this.overviewMode); // click on the frame between labels toggles
    });
    toggle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectMode(!this.overviewMode); }
    });
    this.addEventListener('overview-changed', (event) => {
      toggle.dataset.mode = event.detail?.active ? 'all' : 'dive';
      toggle.setAttribute('aria-checked', event.detail?.active ? 'true' : 'false');
    });
    host.appendChild(toggle);
    this.modeToggleElement = toggle;
  }

  /**
   * Collapse the view to the whole program as a single point: show only the root node,
   * centred, pulled well back so the operator sees the program as one icon they can orbit.
   * Zooming in (or double-clicking) from here re-enters the program's contents.
   */
  collapseToSingularity() {
    const root = this.model.getNode(this.model.rootId);
    if (!root) return false;
    this.#leaveOverviewState();
    this.layout.ensureCurrent();
    this.previousDepth = this.activeDepth;
    this.previousFocusRootId = this.focusRootId;
    this.activeDepth = 0;                 // displaySetForDepth(0) renders the root node alone
    this.focusScopeId = root.id;
    this.focusRootId = root.id;
    this.selectedNodeId = root.id;
    this.depthTransitionStartedAt = performance.now();
    const centre = this.model.worldPosition(root);
    // A generous radius pulls the camera back toward its far framing, so the single icon sits
    // small and centred — the "whole program at a glance" view.
    this.camera.frameContents(centre, 52, { nodeId: root.id, cinematic: true });
    this.#updateBreadcrumb();
    this.dispatchEvent(new CustomEvent('semantic-depth', {
      detail: { current: 0, granularity: LEVEL_GRANULARITY[0], scope: root.id, singularity: true },
    }));
    this.dispatchEvent(new CustomEvent('granularity-ascend', { detail: { scope: root.id, singularity: true } }));
    return true;
  }

  #enterFromSingularity() {
    this.frameScope(this.model.rootId);   // back to the program's contents (its domains)
    this.dispatchEvent(new CustomEvent('granularity-dive', { detail: { scope: this.model.rootId } }));
  }

  /**
   * The node to dive into: the visible node closest to SCREEN CENTRE that is a strict
   * descendant of the current scope and can itself be opened (has children). Falls back to
   * the nearest openable visible node. Never returns the current scope, so a dive always
   * descends the hierarchy instead of reframing in place (which caused the zoom "bounce").
   */
  #descendTargetUnderScope() {
    const width = this.elements.canvas.clientWidth;
    const height = this.elements.canvas.clientHeight;
    const cx = width / 2;
    const cy = height / 2;
    const scopeId = this.focusScopeId ?? this.model.rootId;
    let best = null;
    let bestScore = Infinity;
    for (const entry of this.lastNodeScreen.values()) {
      const node = entry.node ? this.model.getNode(entry.node.id) : null;
      if (!node || node.id === scopeId) continue;
      if (!node.children || node.children.length === 0) continue;   // must be openable
      if (!this.#isDescendantOf(node, scopeId)) continue;           // must be inside current scope
      const score = Math.hypot(cx - entry.x, cy - entry.y);
      if (score < bestScore) { bestScore = score; best = node; }
    }
    return best;
  }

  #isDescendantOf(node, ancestorId) {
    let current = node;
    let guard = 0;
    while (current && guard < 64) {
      if (current.parentId === ancestorId) return true;
      current = current.parentId ? this.model.nodes.get(current.parentId) : null;
      guard += 1;
    }
    return false;
  }

  #depthTransitioning() {
    return performance.now() - this.depthTransitionStartedAt < this.depthTransitionDuration;
  }

  #scopeForDepth(depth) {
    if (depth <= 3) return this.model.rootId;
    const selected = this.model.getNode(this.camera.focusNodeId ?? this.selectedNodeId);
    if (!selected) return this.model.rootId;
    const scopeLevel = depth === 4 ? 2 : depth === 5 ? 3 : 4;
    return this.model.ancestorAtLevel(selected, scopeLevel)?.id ?? this.model.rootId;
  }

  #updateScreenProjection(renderNodes) {
    this.lastNodeScreen.clear();
    const width = this.elements.canvas.clientWidth;
    const height = this.elements.canvas.clientHeight;
    const focal = height / (2 * Math.tan(this.camera.fov / 2));
    for (const renderNode of renderNodes) {
      const projected = projectToScreen(renderNode.position, this.camera.viewProjection, width, height);
      if (!projected) continue;
      const radiusPx = clamp((renderNode.radius * focal) / Math.max(0.1, projected.clipW), 8, 72);
      this.lastNodeScreen.set(renderNode.id, { ...projected, radiusPx, node: renderNode.sourceNode });
    }
    if (this.hoveredNodeId) {
      const projected = this.lastNodeScreen.get(this.hoveredNodeId);
      if (projected) this.quickLabel.move(projected);
    }
    if (this.inspectedNodeId) {
      const projected = this.lastNodeScreen.get(this.inspectedNodeId);
      if (projected) this.inspector.updateAnchor(projected, this.elements.root.getBoundingClientRect());
    }
    this.#syncLabels();
    this.#syncDragon();
  }

  /**
   * Per-node name labels, rendered as DOM text (always pixel-crisp, unlike canvas text) and
   * positioned from the same screen projection the renderer uses. Every element carries its
   * own name INSIDE its shape; labels scale with the node and fade out below legibility so
   * dense deep levels stay clean while every readable level is fully distinguishable.
   */
  #syncLabels() {
    const layer = this.elements.labelLayer;
    if (!layer) return;
    const entries = [];
    for (const entry of this.lastNodeScreen.values()) {
      // In ALL the dragon is the centre — hide the root's own "CLU" label under it.
      if (this.overviewMode && entry.node && entry.node.id === this.model.rootId) continue;
      if (entry.radiusPx >= 13 && entry.node) entries.push(entry);
      if (entries.length >= 160) break; // hard cap keeps the DOM bounded
    }
    while (this.labelPool.length < entries.length) {
      const el = document.createElement('div');
      el.className = 'node-label';
      layer.appendChild(el);
      this.labelPool.push(el);
    }
    for (let i = 0; i < this.labelPool.length; i += 1) {
      const el = this.labelPool[i];
      const entry = entries[i];
      if (!entry) { el.classList.remove('visible'); continue; }
      const name = entry.node.label ?? entry.node.name ?? '';
      if (el.textContent !== name) el.textContent = name;
      const fontPx = Math.max(9, Math.min(21, entry.radiusPx * 0.34));
      el.style.left = `${entry.x}px`;
      el.style.top = `${entry.y}px`;
      el.style.fontSize = `${fontPx}px`;
      el.style.setProperty('--label-glow', this.options.phaseColors[entry.node.phase] ?? 'rgba(33,199,255,.55)');
      // keep the name INSIDE the shape: clip to the node's width with a small margin
      el.style.maxWidth = `${Math.max(34, entry.radiusPx * 2.4)}px`;
      el.style.overflow = 'hidden';
      el.style.textOverflow = 'ellipsis';
      el.classList.add('visible');
    }
  }

  /**
   * The whole-program identity: at the singularity the jade holographic dragon (vector SVG,
   * sharp at any zoom) is shown coiling the root — CLU as the dragon. It tracks the root's
   * projected position and scales with it; entering the program fades it out.
   */
  #syncDragon() {
    const overlay = this.elements.dragonOverlay;
    if (!overlay) return;
    // The dragon marks the whole program: on the DIVE singularity, AND at the centre of the ALL
    // constellation (replacing the root "CLU" dot — its label is suppressed in #syncLabels).
    const onSingularity = this.#isSingularity() && !this.overviewMode;
    if (!onSingularity && !this.overviewMode) {
      overlay.classList.remove('visible');
      overlay.style.opacity = '';
      return;
    }
    const root = this.model.nodes.get(this.model.rootId);
    const projected = this.lastNodeScreen.get(this.model.rootId)
      ?? (root ? projectToScreen(this.model.worldPosition(root), this.camera.viewProjection, this.elements.canvas.clientWidth, this.elements.canvas.clientHeight) : null);
    if (!projected) { overlay.classList.remove('visible'); overlay.style.opacity = ''; return; }
    let size;
    if (this.overviewMode) {
      // Sized as a small multiple of the ROOT NODE's own on-screen size, so the dragon is a
      // "typical shape" — it scales WITH the constellation on zoom (radiusPx grows with it) but
      // never balloons to a fraction of the whole diagram. The cap contains it at deep zoom.
      size = Math.max(24, Math.min(300, projected.radiusPx * this.overviewDragonScale));
    } else {
      size = Math.max(220, Math.min(640, projected.radiusPx * 6.4));
    }
    overlay.style.left = `${projected.x}px`;
    overlay.style.top = `${projected.y}px`;
    overlay.style.width = `${size}px`;
    overlay.style.height = `${size}px`;
    // Slightly translucent as the constellation centrepiece so the central domains read through;
    // full-strength on the lone DIVE singularity.
    overlay.style.opacity = this.overviewMode ? '0.85' : '';
    overlay.classList.add('visible');
  }

  #pick(x, y) {
    let best = null;
    let bestScore = Infinity;
    for (const entry of this.lastNodeScreen.values()) {
      const distance = Math.hypot(x - entry.x, y - entry.y);
      const threshold = Math.max(10, entry.radiusPx * 1.15);
      if (distance > threshold) continue;
      const score = distance / threshold + entry.depth * 0.12;
      if (score < bestScore) {
        bestScore = score;
        best = entry.node;
      }
    }
    return best;
  }

  #showInspector(node, pinned = false) {
    const projected = this.lastNodeScreen.get(node.id)
      ?? projectToScreen(this.model.worldPosition(node), this.camera.viewProjection, this.elements.canvas.clientWidth, this.elements.canvas.clientHeight);
    if (!projected) return;
    const color = this.options.phaseColors[node.phase] ?? this.options.phaseColors.stable;
    this.inspectedNodeId = node.id;
    this.inspector.pin(pinned);
    this.inspector.show(node, projected, this.elements.root.getBoundingClientRect(), color, { pinned });
    this.dispatchEvent(new CustomEvent('node-inspect', { detail: { node, pinned } }));
  }

  #updateUi() {
    // The HUD/overlay is presentation only. A missing element or a transient render error
    // must never propagate into the frame loop — that would stop rendering AND input
    // handling (the loop drives camera damping and pointer/scroll processing).
    try {
      const vis = this.#revealVisualProgress();
      this.scanBadge.update({
        now: performance.now(),
        percent: vis ?? this.model.progress.percent,
        status: this.model.progress.status,
        counts: this.#recognizedCountsByGranularity(),
      });
    } catch (error) {
      if (!this.#uiErrorLogged) {
        this.#uiErrorLogged = true;
        console.warn('navigator badge update skipped (non-fatal):', error?.message ?? error);
      }
    }
  }

  // Recognized-unit totals per category across the committed graph, ordered domain → function,
  // dropping empty levels. Cached against model.version so the node walk runs only when the
  // graph changes, not every frame.
  #recognizedCountsByGranularity() {
    if (this._countsVersion === this.model.version && this._countsCache) return this._countsCache;
    const counts = new Map();
    for (const node of this.model.nodes.values()) {
      counts.set(node.granularity, (counts.get(node.granularity) ?? 0) + 1);
    }
    const order = ['domain', 'subsystem', 'module', 'file', 'class', 'function'];
    this._countsCache = order
      .map((granularity) => ({ granularity, count: counts.get(granularity) ?? 0 }))
      .filter((entry) => entry.count > 0);
    this._countsVersion = this.model.version;
    return this._countsCache;
  }

  #updateBreadcrumb() {
    const node = this.model.getNode(this.selectedNodeId) ?? this.model.nodes.get(this.model.rootId);
    this.breadcrumb.update(
      this.model.getAncestors(node),
      this.activeDepth,
      LEVEL_GRANULARITY[this.activeDepth] ?? 'project',
    );
  }

  #bindModelEvents() {
    this.model.addEventListener('node-added', (event) => {
      const { node, cinematic } = event.detail;
      if (cinematic) this.discovery.enqueue(node);
      this.dispatchEvent(new CustomEvent('node-added', { detail: event.detail }));
    });
    this.model.addEventListener('progress', (event) => {
      this.dispatchEvent(new CustomEvent('recognition-progress', { detail: event.detail }));
    });
    this.model.addEventListener('phase', (event) => {
      this.audio.playPhase(event.detail.phase);
      if (this.inspectedNodeId === event.detail.node.id) this.#showInspector(event.detail.node, this.inspector.pinned);
      this.dispatchEvent(new CustomEvent('node-phase', { detail: event.detail }));
    });
  }

  #bindDiscoveryEvents() {
    this.discovery.addEventListener('start', (event) => {
      const node = event.detail.node;
      if (!['diagnosing', 'testing', 'patching', 'blocked'].includes(node.phase)) {
        this.model.setNodePhase(node.id, 'discovered', { reason: 'recognition' });
      }
      this.selectedNodeId = node.id;
      this.focusRootId = node.id;
      this.camera.focus(
        this.model.worldPosition(node),
        // Acquire from the PARENT level's distance: the new element lands centred but among
        // its siblings/neighbours instead of filling the frame alone.
        this.camera.distanceForLevel(Math.max(0, node.level - 1)) * 1.08,
        node.id,
        { cinematic: true, yaw: this.camera.desiredYaw + (hash01(node.id) - 0.5) * 0.28 },
      );
      this.audio.playDiscovery(node);
      this.#updateBreadcrumb();
      this.pendingCinematicStatus = this.model.progress.status;
      this.model.updateProgress({ status: `ACQUIRING ${node.granularity.toUpperCase()} · ${node.label}` });
      this.dispatchEvent(new CustomEvent('discovery-start', { detail: { node } }));
    });
    this.discovery.addEventListener('complete', (event) => {
      const node = event.detail.node;
      if (node.phase === 'discovered') this.model.setNodePhase(node.id, 'stable', { reason: 'acquisition-complete' });
      this.model.updateProgress({ status: this.pendingCinematicStatus ?? 'SCANNING DEPENDENCIES' });
      this.pendingCinematicStatus = null;
      this.dispatchEvent(new CustomEvent('discovery-complete', { detail: { node } }));
    });
  }

  #controlCallbacks() {
    return {
      pick: (x, y) => this.#pick(x, y),
      worldPosition: (node) => this.model.worldPosition(node),
      hoverChange: (node) => {
        this.hoveredNodeId = node?.id ?? null;
        if (!node) {
          this.quickLabel.hide();
          if (!this.inspector.pinned) {
            this.inspectedNodeId = null;
            this.inspector.hide();
          }
          return;
        }
        const projected = this.lastNodeScreen.get(node.id);
        if (projected) {
          const color = this.options.phaseColors[node.phase] ?? this.options.phaseColors.stable;
          this.quickLabel.show(node, projected, color);
        }
      },
      dwell: (node) => this.#showInspector(node, false),
      backgroundClick: () => {
        // Click on empty space dismisses a pinned detail panel (force past the pin).
        if (this.inspector.pinned || this.inspectedNodeId) {
          this.inspector.hide(true);
          this.inspectedNodeId = null;
        }
      },
      select: (node) => {
        if (!node) return;
        this.selectedNodeId = node.id;
        this.#updateBreadcrumb();
        this.dispatchEvent(new CustomEvent('node-select', { detail: { node } }));
      },
      activate: (node) => {
        if (!node) return;
        // Double-click dives in. In ALL this switches to DIVE focused on the element; exit the
        // constellation first so leaves (the focusNode path, which doesn't self-exit) also land
        // in DIVE. Single-click still just selects/inspects; zoom still never dives in ALL.
        if (this.overviewMode) this.#leaveOverviewState();
        if (!this.diveInto(node.id)) this.focusNode(node.id, { pinInspector: true });
      },
      nodeMoved: (node) => {
        this.dispatchEvent(new CustomEvent('node-moved', { detail: { node, offset: [...node.manualOffset] } }));
      },
      userGesture: () => void this.audio.enable(),
      zoom: () => {},
      escape: () => {
        // Escape first dismisses an open detail panel; only if none is open does it ascend a
        // level — so closing a panel never doubles as an unintended navigation.
        const hadPanel = this.inspector.pinned || this.inspectedNodeId !== null;
        this.inspector.hide(true);
        this.inspectedNodeId = null;
        if (!hadPanel) this.ascend();
      },
      frame: () => this.frameProject(),
      resetLayout: () => {
        for (const node of this.model.nodes.values()) node.manualOffset = [0, 0, 0];
        this.layout.rebuild();
      },
    };
  }
}