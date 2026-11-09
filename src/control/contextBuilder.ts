/**
 * CLUE context builder.
 *
 * Architecture: CLUE_Architecture_v9.md (context budgets, decomposition over truncation; trust classes).
 * Execution: CLUE_Execution_Model_v9.md (deterministic assembly; counter-evidence; negative-result memory).
 * Directory: CLUE_Project_Directory_v9.md §8 — `contextBuilder.ts` constructs typed, minimal,
 *   evidence-linked context packets from immutable inputs.
 * Backlog: DEV-P0-15 — source is read as the snapshot vouches for it, current claims/conflicts/prior
 *   results are bound by version and scoped to the subject, and a missing essential section blocks
 *   export rather than shipping silently. The same fully bound input set yields byte-identical context.
 *
 *   DEV-P1-28 (phase 5) — the context stage of the evidence spine. This phase was specified,
 *   its `ContextLink` type and schema were added to `src/shared/evidenceIdentity.ts`, and
 *   `selftest/kernel.test.ts` was written to assert it — but the implementation was never
 *   installed here, so the five-stage chain had a hole in the middle and the suite could not
 *   compile. The stage is implemented below.
 *
 *   Its verification style is deliberately different from every other stage. Snapshot,
 *   recognition, task, packet and accepted-result all verify against a registry that holds a
 *   durable record: the link is checked against what was written down. A context has no
 *   registry — it is assembled on demand and never persisted as a row — so there is nothing
 *   to look it up in. What it has instead is determinism, which the module already guarantees
 *   and which DEV-P0-15 exists to protect: the same task, options and durable inputs produce
 *   byte-identical context. {@link ContextBuilder.verifyContextLink} therefore re-derives the
 *   basis and compares. That is a real check and not a weaker substitute for one — a
 *   registry proves a record was stored, whereas re-derivation proves the context *is what it
 *   claims to be*, which is the stronger property. It holds only for as long as assembly stays
 *   deterministic, so the determinism rule above is now load-bearing for the spine as well as
 *   for prompt caching.
 *
 * Assembles what a worker sees. Every section carries a trust label and a provenance
 * record, and the whole set is deterministic: the same task against the same snapshot
 * produces byte-identical context, which is what makes prompt caching work and what
 * makes a packet re-runnable months later.
 *
 * Four rules shape the assembly.
 *
 * **Source is taken only as the snapshot vouches for it.** A slice is read and verified against the
 * snapshot's immutable content hash; a file that has changed since the snapshot is refused, not
 * silently taken from the newer bytes. A conclusion attributed to code that no longer exists is worse
 * than no conclusion, and it is indistinguishable from a good one afterwards.
 *
 * **A missing essential blocks export.** An essential section whose data source cannot be reached is
 * not a mere omission — the packet cannot prove what it must, so `fits` is false and the task is
 * decomposed or deferred, never shipped as if whole. This is distinct from an essential section that
 * is legitimately empty: those are built and state their absence explicitly.
 *
 * **Essentials never shrink; enrichment does, and says so.** Widening a neighbourhood
 * from five units to twenty is scoping. Dropping a proof contract or a conflicting
 * claim to make room is not, and no budget pressure permits it.
 *
 * **Counter-evidence is essential by construction, and scoped to the subject.** Conflicting claims,
 * prior rejected results, and the graph's known blind spots are marked essential precisely because
 * they are what a worker would benefit from not seeing if it wanted to look productive, and they are
 * scoped to this task's subject so the set is the same every time the same subject is built. A context
 * pack that quietly omits the awkward part produces confident work and useless evidence.
 *
 * A note on trust labels: the specification's six classes have no exact slot for CLUE's
 * own deterministic analysis — the recognizer's graph is neither source, nor a document
 * claim, nor model output. `RUNTIME_OUTPUT_UNTRUSTED` is used as the nearest fit, since
 * the relevant instruction to a worker is the same one: this is observation, not
 * direction. Each such section states plainly what produced it. The mismatch is recorded
 * rather than papered over, and belongs in the founding documents to resolve properly.
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';

import { hashBytes, hashCanonicalJson, normalisePath } from '../shared/ids.js';
import { relativePathSchema } from '../shared/schemas.js';
import {
  EvidenceChainError,
  requireSpineHash,
  sealLink as sealEvidenceLink,
  verifyLink as verifyEvidenceLink,
  type BindingHash,
  type ContextBasisHash,
  type ContextLink,
  type TaskLink,
} from '../shared/evidenceIdentity.js';
import type { ClaimRecord, ClaimRegistry } from '../analysis/documents/claimRegistry.js';
import type { GraphRegistry, UnitClassification } from '../analysis/source/graph.js';
import type { SnapshotRegistry } from '../analysis/source/snapshot.js';
import { decodeSourceByteRange, sourceTextLayout } from '../analysis/source/sourceEncoding.js';
import type { MissionRegistry } from './mission.js';
import {
  estimateTokens,
  makeSection,
  sectionsBindingHash,
  type ContextSection,
  type TrustClass,
} from './sessionPackets.js';
import type { TaskRecord } from './tasks.js';

/* ------------------------------------------------------------------------- */
/* Section kinds and recipes                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The kinds of section a context pack can contain.
 *
 * Listing them as a closed set makes "what does a patch designer actually see" a
 * question answerable by reading one table, rather than by tracing what happened to be
 * appended where.
 */
export type SectionKind =
  | 'missionRules'
  | 'projectAuthority'
  | 'taskDirective'
  | 'outputRequirements'
  | 'subjectSource'
  | 'subjectClassification'
  | 'graphNeighbourhood'
  | 'dependencySource'
  | 'relatedClaims'
  | 'conflictingClaims'
  | 'priorResults'
  | 'knownGaps';

interface SectionSpec {
  readonly kind: SectionKind;
  readonly essential: boolean;
  /** Higher is included first when the optional sections compete for room. */
  readonly priority: number;
}

const SPEC: Readonly<Record<SectionKind, Omit<SectionSpec, 'kind'>>> = {
  missionRules: { essential: true, priority: 100 },
  projectAuthority: { essential: true, priority: 100 },
  taskDirective: { essential: true, priority: 100 },
  outputRequirements: { essential: true, priority: 100 },
  // The thing being reasoned about. A task about a unit without that unit's source is
  // not a smaller task; it is a different and unanswerable one.
  subjectSource: { essential: true, priority: 95 },
  // Counter-evidence. Essential by construction, never negotiable against budget.
  conflictingClaims: { essential: true, priority: 90 },
  priorResults: { essential: true, priority: 90 },
  knownGaps: { essential: true, priority: 85 },
  // Enrichment. More is better and less is still workable.
  subjectClassification: { essential: false, priority: 70 },
  graphNeighbourhood: { essential: false, priority: 60 },
  relatedClaims: { essential: false, priority: 50 },
  dependencySource: { essential: false, priority: 40 },
};

/** What each task type is given. Unlisted types fall back to `DEFAULT_RECIPE`. */
export const RECIPES: Readonly<Record<string, readonly SectionKind[]>> = {
  DOC_EXTRACT: ['missionRules', 'taskDirective', 'outputRequirements', 'relatedClaims'],

  UNIT_SUMMARIZE: [
    'missionRules',
    'taskDirective',
    'outputRequirements',
    'subjectSource',
    'subjectClassification',
  ],

  EDGE_RESOLVE: [
    'missionRules',
    'taskDirective',
    'outputRequirements',
    'subjectSource',
    'graphNeighbourhood',
    'knownGaps',
  ],

  METRIC_ANALYZE: [
    'missionRules',
    'taskDirective',
    'outputRequirements',
    'subjectSource',
    'subjectClassification',
    'graphNeighbourhood',
    'relatedClaims',
    'knownGaps',
  ],

  CANDIDATE_REVIEW: [
    'missionRules',
    'taskDirective',
    'outputRequirements',
    'subjectSource',
    'subjectClassification',
    'conflictingClaims',
    'priorResults',
    'knownGaps',
  ],

  PATCH_DESIGN: [
    'missionRules',
    'taskDirective',
    'outputRequirements',
    'subjectSource',
    'subjectClassification',
    'graphNeighbourhood',
    'dependencySource',
    'relatedClaims',
    'conflictingClaims',
    'priorResults',
    'knownGaps',
  ],

  // The refuter is given the claim and the evidence and NOT the designer's reasoning.
  // Withholding the narrative is the strongest independence mechanism available under
  // single-vendor operation, and it costs nothing.
  REFUTATION: [
    'missionRules',
    'taskDirective',
    'outputRequirements',
    'subjectSource',
    'subjectClassification',
    'conflictingClaims',
    'priorResults',
    'knownGaps',
  ],
};

export const DEFAULT_RECIPE: readonly SectionKind[] = [
  'missionRules',
  'taskDirective',
  'outputRequirements',
  'subjectSource',
  'knownGaps',
];

/* ------------------------------------------------------------------------- */
/* Results                                                                    */
/* ------------------------------------------------------------------------- */

export interface DroppedSection {
  readonly kind: SectionKind;
  readonly estimatedTokens: number;
  readonly reason: string;
}

export type DecompositionStrategy =
  | 'by-module'
  | 'by-unit'
  | 'by-claim-group'
  | 'by-dependency-layer';

export interface SubtaskProposal {
  readonly label: string;
  readonly subjectIds: readonly string[];
  readonly estimatedTokens: number;
}

export interface DecompositionProposal {
  readonly reason: string;
  readonly strategy: DecompositionStrategy;
  readonly subtasks: readonly SubtaskProposal[];
}

export interface BuildResult {
  readonly sections: readonly ContextSection[];
  readonly dropped: readonly DroppedSection[];
  readonly estimatedTokens: number;
  readonly budget: number;
  /** False when the essentials alone exceed the budget; see `decomposition`. */
  readonly fits: boolean;
  /** Present only when the task must be split rather than trimmed. */
  readonly decomposition: DecompositionProposal | null;
  /** Sections that could not be built, with the reason. Visible, never silent. */
  readonly unavailable: readonly DroppedSection[];
}

/* ------------------------------------------------------------------------- */
/* Builder                                                                    */
/* ------------------------------------------------------------------------- */

export interface ContextBuilderDeps {
  /** Absolute path of the canonical project root. Read-only. */
  readonly projectRoot: string;
  readonly mission: MissionRegistry;
  readonly graph?: GraphRegistry;
  readonly claims?: ClaimRegistry;
  readonly snapshots?: SnapshotRegistry;
  readonly tokenBudget?: number;
  /** How many neighbouring units to include before trimming. */
  readonly neighbourhoodLimit?: number;
}

export interface BuildOptions {
  /** Snapshot the task is anchored to. Required for any source-bearing section. */
  readonly snapshotId?: string | null;
  /** Logical id of the unit under examination, when the subject is a unit. */
  readonly subjectUnitId?: string | null;
  /** Free-form directive for this task, written by the scheduler, not by a worker. */
  readonly directive: string;
  /** Name of the output schema, echoed into the requirements section. */
  readonly outputSchemaName: string;
  readonly outputNotes?: readonly string[];
  readonly recipe?: readonly SectionKind[];
}

const DEFAULT_BUDGET = 100_000;
const DEFAULT_NEIGHBOURHOOD = 40;

export class ContextBuilder {
  private readonly projectRoot: string;
  private readonly mission: MissionRegistry;
  private readonly graph: GraphRegistry | null;
  private readonly claims: ClaimRegistry | null;
  private readonly snapshots: SnapshotRegistry | null;
  private readonly budget: number;
  private readonly neighbourhoodLimit: number;

  public constructor(deps: ContextBuilderDeps) {
    this.projectRoot = deps.projectRoot;
    this.mission = deps.mission;
    this.graph = deps.graph ?? null;
    this.claims = deps.claims ?? null;
    this.snapshots = deps.snapshots ?? null;
    this.budget = deps.tokenBudget ?? DEFAULT_BUDGET;
    this.neighbourhoodLimit = deps.neighbourhoodLimit ?? DEFAULT_NEIGHBOURHOOD;
  }

  private shouldIncludeProjectAuthority(missionVersion: string): boolean {
    const candidate = this.mission as MissionRegistry & {
      projectAuthorityContext?: MissionRegistry['projectAuthorityContext'];
    };
    if (typeof candidate.projectAuthorityContext !== 'function') return false;
    try {
      return candidate.projectAuthorityContext(missionVersion) !== null;
    } catch {
      // Include the essential section when the registry advertises Project Authority but
      // the exact historical artifact cannot be read. buildSection() will then report the
      // unavailability through the normal fail-closed context contract instead of silently
      // dropping policy from the recipe.
      return true;
    }
  }

  private recipeFor(task: TaskRecord, options: BuildOptions): readonly SectionKind[] {
    const configured = options.recipe ?? RECIPES[task.type] ?? DEFAULT_RECIPE;
    if (configured.includes('projectAuthority')) return configured;
    if (!this.shouldIncludeProjectAuthority(task.mission_version)) return configured;
    const copy = [...configured];
    const missionIndex = copy.indexOf('missionRules');
    copy.splice(missionIndex < 0 ? 0 : missionIndex + 1, 0, 'projectAuthority');
    return copy;
  }

  /**
   * Builds the context for a task.
   *
   * Essentials are gathered first and checked against the budget on their own. If they
   * do not fit, the result carries a decomposition proposal instead of a shortened pack:
   * the honest response to "this does not fit" is a smaller question, not a smaller
   * answer to the same one.
   */
  public build(task: TaskRecord, options: BuildOptions): BuildResult {
    const recipe = this.recipeFor(task, options);
    const unavailable: DroppedSection[] = [];

    const built = new Map<SectionKind, ContextSection>();
    for (const kind of recipe) {
      const section = this.buildSection(kind, task, options, unavailable);
      if (section !== null) built.set(kind, section);
    }

    const essentials: ContextSection[] = [];
    const optional: { kind: SectionKind; section: ContextSection }[] = [];

    for (const kind of recipe) {
      const section = built.get(kind);
      if (section === undefined) continue;
      if (SPEC[kind].essential) essentials.push(section);
      else optional.push({ kind, section });
    }

    const essentialTokens = essentials.reduce((total, section) => total + section.estimated_tokens, 0);

    // An essential section that could not be built is not a mere omission — the packet cannot prove
    // what it must, so it must never ship as if complete. Unavailable essential evidence blocks
    // export exactly as an over-budget packet does. This is distinct from an essential section that
    // is legitimately empty (no conflicts for this subject): those are built and state their absence,
    // and only a section whose data source could not be reached lands in `unavailable`.
    const missingEssentials = recipe.filter((kind) => SPEC[kind].essential && !built.has(kind));
    if (missingEssentials.length > 0) {
      return {
        sections: essentials,
        dropped: [],
        estimatedTokens: essentialTokens,
        budget: this.budget,
        fits: false,
        decomposition: null,
        unavailable,
      };
    }

    if (essentialTokens > this.budget) {
      return {
        sections: essentials,
        dropped: [],
        estimatedTokens: essentialTokens,
        budget: this.budget,
        fits: false,
        decomposition: this.proposeDecomposition(task, options, essentialTokens),
        unavailable,
      };
    }

    optional.sort((a, b) => SPEC[b.kind].priority - SPEC[a.kind].priority);

    const selected: ContextSection[] = [...essentials];
    const dropped: DroppedSection[] = [];
    let total = essentialTokens;

    for (const candidate of optional) {
      if (total + candidate.section.estimated_tokens <= this.budget) {
        selected.push(candidate.section);
        total += candidate.section.estimated_tokens;
      } else {
        dropped.push({
          kind: candidate.kind,
          estimatedTokens: candidate.section.estimated_tokens,
          reason: 'enrichment omitted for budget; essentials were unaffected',
        });
      }
    }

    // Restored to recipe order so the pack reads in a stable sequence regardless of
    // which optional sections survived.
    const order = new Map(recipe.map((kind, index) => [kind, index]));
    selected.sort((a, b) => (order.get(kindOf(a)) ?? 0) - (order.get(kindOf(b)) ?? 0));

    return {
      sections: selected,
      dropped,
      estimatedTokens: total,
      budget: this.budget,
      fits: true,
      decomposition: null,
      unavailable,
    };
  }

  /* --------------------------- section builders ----------------------- */

  /* --------------------------------------------------------------------- */
  /* Evidence spine — context stage (DEV-P1-28, phase 5)                     */
  /* --------------------------------------------------------------------- */

  /**
   * The deterministic identity of one assembled context.
   *
   * Everything that changes what a worker sees is folded in, and nothing that does not.
   * The sections are digested through `sectionsBindingHash` — the same function the packet
   * stage uses — so one definition of "these are the sections" serves both stages and the
   * two cannot drift apart.
   *
   * `dropped` and `unavailable` are included deliberately. A context that omitted a
   * conflicting claim for budget reasons is a materially different context from one that
   * included it, even when every surviving section is identical; a basis that ignored them
   * would let two genuinely different packs share an identity. What a worker was *not*
   * shown is part of the evidence.
   *
   * The recipe is resolved here exactly as `build` resolves it, rather than recording the
   * caller's possibly-undefined `options.recipe`, so the basis names the sections that were
   * actually requested rather than the argument that implied them.
   */
  public contextBasisHash(
    result: BuildResult,
    task: TaskRecord,
    options: BuildOptions,
  ): ContextBasisHash {
    const recipe = this.recipeFor(task, options);
    return requireSpineHash(
      hashCanonicalJson({
        task: { id: task.id, type: task.type },
        options: {
          snapshotId: options.snapshotId ?? null,
          subjectUnitId: options.subjectUnitId ?? null,
          directive: options.directive,
          outputSchemaName: options.outputSchemaName,
          outputNotes: options.outputNotes ?? [],
          recipe: [...recipe],
        },
        sections: sectionsBindingHash(result.sections),
        dropped: result.dropped,
        unavailable: result.unavailable,
        budget: result.budget,
        estimatedTokens: result.estimatedTokens,
        fits: result.fits,
        decomposition: result.decomposition,
      }),
      'ContextBasisHash',
    );
  }

  /**
   * The context link for an assembled context, bound to the task seal (DEV-P1-28, phase 5).
   *
   * `taskSeal` is the task queue's `spineSeal(...)` — the predecessor seal is passed per
   * call rather than injected through the constructor, matching every other stage, which
   * keeps this file free of a dependency on the queue and keeps the chain assembled by the
   * caller who actually holds both ends of it.
   */
  public spineLink(
    result: BuildResult,
    task: TaskRecord,
    options: BuildOptions,
    taskSeal: BindingHash,
  ): ContextLink {
    return {
      stage: 'context',
      boundTo: taskSeal,
      contextBasisHash: this.contextBasisHash(result, task, options),
    };
  }

  /** The sealed binding hash of the context link — the value the packet stage binds to. */
  public spineSeal(
    result: BuildResult,
    task: TaskRecord,
    options: BuildOptions,
    taskSeal: BindingHash,
  ): BindingHash {
    return sealEvidenceLink(this.spineLink(result, task, options, taskSeal));
  }

  /**
   * Verifies a presented context link against its task predecessor and against the context
   * itself (DEV-P1-28, phase 5).
   *
   * Two independent checks, as at every other stage. The link must bind to the given task
   * lease — recomputed from the predecessor as it is now, so a task altered after the fact
   * is caught — and the basis must re-derive from the context, task and options supplied
   * here. The second check is what a registry lookup does at the other stages: it refuses a
   * link that describes a context other than the one in hand.
   *
   * The caller must supply the same durable inputs the context was built from. That is the
   * honest limitation of re-derivation and is stated rather than hidden: this proves the
   * link matches *this* context, and it is the caller's chain — mission, snapshot,
   * recognition, task — that proves this context was the right one to build.
   */
  public verifyContextLink(
    link: ContextLink,
    taskLink: TaskLink,
    result: BuildResult,
    task: TaskRecord,
    options: BuildOptions,
  ): void {
    verifyEvidenceLink(link, taskLink);
    const rederived = this.contextBasisHash(result, task, options);
    if (rederived !== link.contextBasisHash) {
      throw new EvidenceChainError(
        `context link basis ${link.contextBasisHash} does not match the context supplied for ` +
          `verification, which derives ${rederived}`,
      );
    }
  }

  private buildSection(
    kind: SectionKind,
    task: TaskRecord,
    options: BuildOptions,
    unavailable: DroppedSection[],
  ): ContextSection | null {
    const record = (reason: string): null => {
      unavailable.push({ kind, estimatedTokens: 0, reason });
      return null;
    };

    switch (kind) {
      case 'missionRules':
        return this.missionRules(task, record);
      case 'projectAuthority':
        return this.projectAuthority(task, record);
      case 'taskDirective':
        return this.taskDirective(task, options);
      case 'outputRequirements':
        return this.outputRequirements(options);
      case 'subjectSource':
        return this.subjectSource(options, record);
      case 'subjectClassification':
        return this.subjectClassification(options, record);
      case 'graphNeighbourhood':
        return this.graphNeighbourhood(options, record);
      case 'dependencySource':
        return this.dependencySource(options, record);
      case 'relatedClaims':
        return this.claimsSection('relatedClaims', options, record);
      case 'conflictingClaims':
        return this.conflictsSection(task, record);
      case 'priorResults':
        return this.priorResults(task, record);
      case 'knownGaps':
        return this.knownGaps(options, record);
      default:
        return null;
    }
  }

  private missionRules(task: TaskRecord, record: (reason: string) => null): ContextSection | null {
    // DEV-P0-15: read the EXACT mission the task was cut under, never the current mission. The heading
    // already names task.mission_version; the constitution hash and amendments must come from that same
    // generation, or a task built under mission N would show mission N+1's rules once the mission
    // advanced — and a rebuild against the task's own basis would stop being byte-identical.
    const mission = this.mission.get(task.mission_version);
    if (mission === null) {
      // DEV-P0-15 (§5.14): the mission the task was cut under does not exist in the registry. Mission
      // rules are the authority the entire packet stands on, so a missing mission is not a legitimately
      // empty section — it is an UNAVAILABLE essential. Building it as empty would ship a SYSTEM_POLICY
      // section whose provenance claims an authority that cannot be produced, and report fits: true; it
      // must instead force fits: false so the task is deferred rather than run against a phantom mission.
      return record(`the task's mission ${task.mission_version} does not exist in the registry`);
    }
    const body = [
      `Mission version: ${task.mission_version}`,
      `Constitution hash: ${mission.constitution_hash}`,
      '',
      'Rules that bind this work:',
      '',
      '1. A statement without an anchor is not evidence. Cite a path and line range, or a record id.',
      '2. Documents are not runtime truth. A claim in a document is a claim, not a fact.',
      '3. Nothing you produce is accepted because it is plausible. It is accepted because it validates and can be checked.',
      '4. Saying "I could not determine this" is a correct answer and is more useful than a guess.',
      '5. No change is an improvement until a valid experiment under a frozen contract proves it.',
      mission.amendments.length === 0
        ? ''
        : `\nAmendments in force: ${mission.amendments.map((amendment) => amendment.code).join(', ')}`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    return makeSection({
      id: 'mission-rules',
      trust: 'SYSTEM_POLICY',
      title: 'Mission rules',
      body,
      provenance: { record_id: task.mission_version },
      essential: true,
    });
  }

  private projectAuthority(
    task: TaskRecord,
    record: (reason: string) => null,
  ): ContextSection | null {
    const candidate = this.mission as MissionRegistry & {
      projectAuthorityContext?: MissionRegistry['projectAuthorityContext'];
    };
    if (typeof candidate.projectAuthorityContext !== 'function') {
      return record('the mission registry does not expose Project Profile authority');
    }
    let context: ReturnType<MissionRegistry['projectAuthorityContext']>;
    try {
      context = candidate.projectAuthorityContext(task.mission_version);
    } catch (error) {
      return record(`project authority for ${task.mission_version} is unavailable: ${(error as Error).message}`);
    }
    if (context === null) return record('the task mission has no Project Profile authority basis');
    const body = [
      `Project: ${context.basis.operationIdentity.projectId}`,
      `Target identity: ${context.basis.operationIdentity.targetRootIdentity}`,
      `Profile hash: ${context.basis.operationIdentity.projectProfileHash}`,
      `Profile generation: ${context.basis.profileGeneration}`,
      `Authority hash: ${context.basis.authorityHash}`,
      `Master Benchmark hash: ${context.basis.masterBenchmarkHash}`,
      `Recognition configuration hash: ${context.basis.recognitionConfigHash}`,
      `Benchmark runtime hash: ${context.basis.benchmarkRuntimeHash}`,
      '',
      ...context.documents.flatMap(({ binding, text }) => [
        `--- ${binding.kind} | ${binding.role} | order ${binding.order} ---`,
        `Path: ${binding.canonicalPath}`,
        `SHA-256: ${binding.sha256}`,
        text,
        '',
      ]),
    ].join('\n');
    return makeSection({
      id: 'project-authority',
      trust: 'SYSTEM_POLICY',
      title: 'Project authority',
      body,
      provenance: { record_id: task.mission_version },
      essential: true,
    });
  }

  private taskDirective(task: TaskRecord, options: BuildOptions): ContextSection {
    const body = [
      `Task: ${task.id}`,
      `Type: ${task.type}`,
      `Lane: ${task.lane}`,
      task.subject_id === null ? '' : `Subject: ${task.subject_id}`,
      options.snapshotId === undefined || options.snapshotId === null
        ? ''
        : `Snapshot: ${options.snapshotId}`,
      '',
      options.directive,
    ]
      .filter((line) => line !== '')
      .join('\n');

    return makeSection({
      id: 'task-directive',
      trust: 'CREATOR_DIRECTIVE',
      title: 'What this task asks',
      body,
      provenance: { record_id: task.id },
      essential: true,
    });
  }

  private outputRequirements(options: BuildOptions): ContextSection {
    const body = [
      `Return a result conforming to the schema "${options.outputSchemaName}".`,
      'See output-schema.json for the shape and a worked example.',
      '',
      ...(options.outputNotes ?? []).map((note) => `- ${note}`),
      '',
      'Anything you could not determine belongs in `limitations`, not in a confident field.',
    ].join('\n');

    return makeSection({
      id: 'output-requirements',
      trust: 'SYSTEM_POLICY',
      title: 'Output requirements',
      body,
      essential: true,
    });
  }

  /**
   * The subject's own source, read from disk and verified against the snapshot.
   *
   * The verification is the point. Building a pack from a tree that has moved would
   * attribute the worker's conclusions to bytes that were never examined, and nothing
   * downstream would ever notice.
   */
  private subjectSource(
    options: BuildOptions,
    unavailable: (reason: string) => null,
  ): ContextSection | null {
    const unitId = options.subjectUnitId ?? null;
    const snapshotId = options.snapshotId ?? null;
    if (unitId === null || snapshotId === null) return unavailable('no unit subject or snapshot');
    if (this.graph === null) return unavailable('graph registry unavailable');

    const stored = this.graph.resultOf(snapshotId);
    if (stored === null) return unavailable('no stored recognition for this snapshot');

    const unit = stored.units.find((candidate) => candidate.logicalId === unitId);
    if (unit === undefined) return unavailable(`unit ${unitId} is not in this snapshot`);

    const slice = this.readVerifiedSlice(snapshotId, unit.anchor.path, unit.anchor.startByte, unit.anchor.endByte);
    if (slice === null) {
      return unavailable(
        `source for ${unit.anchor.path} no longer matches the snapshot; refusing to use newer bytes`,
      );
    }

    return makeSection({
      id: 'subject-source',
      trust: 'SOURCE_CODE_UNTRUSTED',
      title: `Source of ${unitId}`,
      body: [`\`\`\`${fenceLanguageFor(unit.anchor.path)}`, slice.text, '```'].join('\n'),
      provenance: {
        path: unit.anchor.path,
        start_line: unit.anchor.startLine,
        end_line: unit.anchor.endLine,
        hash: slice.fileHash,
        record_id: unitId,
      },
      essential: true,
    });
  }

  private subjectClassification(
    options: BuildOptions,
    unavailable: (reason: string) => null,
  ): ContextSection | null {
    const unitId = options.subjectUnitId ?? null;
    const snapshotId = options.snapshotId ?? null;
    if (unitId === null || snapshotId === null || this.graph === null) {
      return unavailable('no unit subject, snapshot, or graph');
    }

    const classification = this.graph.classificationOf(snapshotId, unitId);
    if (classification === null) return unavailable('unit is not classified in this snapshot');

    return makeSection({
      id: 'subject-classification',
      trust: 'RUNTIME_OUTPUT_UNTRUSTED',
      title: 'Structural classification',
      body: renderClassification(classification),
      provenance: { record_id: unitId },
      essential: false,
    });
  }

  private graphNeighbourhood(
    options: BuildOptions,
    unavailable: (reason: string) => null,
  ): ContextSection | null {
    const unitId = options.subjectUnitId ?? null;
    const snapshotId = options.snapshotId ?? null;
    if (unitId === null || snapshotId === null || this.graph === null) {
      return unavailable('no unit subject, snapshot, or graph');
    }

    const body = this.graph.exportCompact(snapshotId, {
      around: unitId,
      radius: 2,
      limit: this.neighbourhoodLimit,
    });

    return makeSection({
      id: 'graph-neighbourhood',
      trust: 'RUNTIME_OUTPUT_UNTRUSTED',
      title: 'Graph neighbourhood',
      body: [
        "CLUE's own static analysis of the codebase at this snapshot. Structure is measured,",
        'not asserted, but the graph has gaps — see the known-gaps section.',
        '',
        '```',
        body,
        '```',
      ].join('\n'),
      provenance: { record_id: snapshotId },
      essential: false,
    });
  }

  private dependencySource(
    options: BuildOptions,
    unavailable: (reason: string) => null,
  ): ContextSection | null {
    const unitId = options.subjectUnitId ?? null;
    const snapshotId = options.snapshotId ?? null;
    if (unitId === null || snapshotId === null || this.graph === null) {
      return unavailable('no unit subject, snapshot, or graph');
    }

    const stored = this.graph.resultOf(snapshotId);
    if (stored === null) return unavailable('no stored recognition for this snapshot');

    const dependencies = this.graph.dependenciesOf(snapshotId, unitId, 1).slice(0, 5);
    if (dependencies.length === 0) return unavailable('the subject has no internal dependencies');

    const parts: string[] = [];
    for (const dependencyId of dependencies) {
      const unit = stored.units.find((candidate) => candidate.logicalId === dependencyId);
      if (unit === undefined || unit.kind === 'module') continue;

      const slice = this.readVerifiedSlice(
        snapshotId,
        unit.anchor.path,
        unit.anchor.startByte,
        unit.anchor.endByte,
      );
      if (slice === null) continue;

      parts.push(`### ${dependencyId}\n\n\`${unit.anchor.path}:${unit.anchor.startLine}\`\n`);
      parts.push([`\`\`\`${fenceLanguageFor(unit.anchor.path)}`, slice.text, '```'].join('\n'));
    }

    if (parts.length === 0) return unavailable('no dependency source could be verified');

    return makeSection({
      id: 'dependency-source',
      trust: 'SOURCE_CODE_UNTRUSTED',
      title: 'Direct dependencies',
      body: parts.join('\n\n'),
      provenance: { record_id: unitId },
      essential: false,
    });
  }

  private claimsSection(
    id: string,
    options: BuildOptions,
    unavailable: (reason: string) => null,
  ): ContextSection | null {
    if (this.claims === null) return unavailable('claim registry unavailable');

    const subject = options.subjectUnitId ?? null;
    const records =
      subject === null
        ? this.claims.claims({ minimumStrength: 0.5, limit: 40 })
        : this.claims.claims({ limit: 40 }).filter((claim) => mentions(claim, subject));

    if (records.length === 0) return unavailable('no related claims');

    return makeSection({
      id,
      trust: 'DOCUMENT_CLAIM',
      title: 'What the documents say',
      body: records.map(renderClaim).join('\n\n'),
      essential: false,
    });
  }

  /**
   * Contradictions in the corpus that touch this work.
   *
   * Essential. A worker shown only the agreeing half of a contradiction will produce a
   * confident answer built on a premise the project itself disputes, and the confidence
   * will be indistinguishable from the justified kind.
   */
  private conflictsSection(
    task: TaskRecord,
    unavailable: (reason: string) => null,
  ): ContextSection | null {
    // Only the claim registry being unreachable is a genuine unavailability — that blocks export,
    // because counter-evidence is required and cannot be confirmed absent. A registry that is present
    // but holds no contradiction for this subject is a real, provable "none", and is stated as such.
    if (this.claims === null) return unavailable('claim registry unavailable');

    const subjectKey = task.subject_id;
    // Counter-evidence is scoped to the subject: only contradictions that actually involve this
    // task's subject are shown, not every open conflict in the project. The registry already returns
    // conflicts in a deterministic order (severity, then id), so the same registry state and the same
    // subject yield byte-identical output.
    const scoped =
      subjectKey === null
        ? []
        : this.claims.conflicts(true).filter((conflict) => conflict.subject_key === subjectKey);

    const preamble = [
      'The project contradicts itself on these points. Both sides are given. Do not pick one',
      'silently — if your answer depends on which is true, say so.',
    ];

    let body: string;
    if (scoped.length === 0) {
      body = [
        ...preamble,
        '',
        subjectKey === null
          ? 'This task has no subject, so there are no subject-scoped contradictions to weigh.'
          : `No unresolved contradiction involves ${subjectKey}. Treat this as a proven "none", not "not checked".`,
      ].join('\n');
    } else {
      const parts = scoped.slice(0, 10).map((conflict) => {
        const sides = conflict.claim_ids
          .map((claimId) => this.claims?.getClaim(claimId) ?? null)
          .filter((claim): claim is ClaimRecord => claim !== null)
          .map((claim) => `  - ${claim.document_path}:${claim.start_line} — ${claim.raw_text}`)
          .join('\n');
        return `**${conflict.id}** (${conflict.severity}, ${conflict.kind})\n${conflict.summary}\n${sides}`;
      });
      body = [...preamble, '', ...parts].join('\n');
    }

    return makeSection({
      id: 'conflicting-claims',
      trust: 'DOCUMENT_CLAIM',
      title: 'Unresolved contradictions',
      body,
      provenance: { record_id: subjectKey },
      essential: true,
    });
  }

  /**
   * What was already tried on this subject.
   *
   * Negative-result memory, and essential for the same reason as conflicts: a worker who
   * does not know a hypothesis was tested and rejected will propose it again, and CLUE
   * will pay to learn the same thing twice.
   */
  private priorResults(task: TaskRecord, unavailable: (reason: string) => null): ContextSection | null {
    if (task.subject_id === null) return unavailable('no subject to look up prior work for');

    // The ledger arrives at Stage I. Until then the section states its own absence
    // rather than being silently omitted, so a reader can tell "nothing was tried" from
    // "CLUE cannot yet tell you what was tried".
    return makeSection({
      id: 'prior-results',
      trust: 'PRIOR_SESSION_RESULT_PROVISIONAL',
      title: 'Prior work on this subject',
      body: [
        'No experiment ledger exists yet (Stage I). This section will carry previously',
        'rejected hypotheses and their verdicts once it does.',
        '',
        'Treat the absence as "unknown", not as "nothing was tried".',
      ].join('\n'),
      provenance: { record_id: task.subject_id },
      essential: true,
    });
  }

  /**
   * Where the graph is blind.
   *
   * A worker reasoning over a dependency graph should know which edges could not be
   * resolved. Presenting an incomplete graph as complete invites conclusions whose only
   * flaw is invisible.
   */
  private knownGaps(
    options: BuildOptions,
    unavailable: (reason: string) => null,
  ): ContextSection | null {
    const snapshotId = options.snapshotId ?? null;
    if (snapshotId === null || this.graph === null) return unavailable('no snapshot or graph');

    const stored = this.graph.resultOf(snapshotId);
    if (stored === null) return unavailable('no stored recognition for this snapshot');

    const relevant =
      options.subjectUnitId === null || options.subjectUnitId === undefined
        ? stored.unresolved.slice(0, 20)
        : stored.unresolved
            .filter((entry) => entry.fromLogicalId === options.subjectUnitId)
            .slice(0, 20);

    const coverage = this.graph.coverage(snapshotId);
    const weakest = [...coverage].sort((a, b) => a.coverage - b.coverage).slice(0, 3);

    const lines = [
      'The structural analysis is incomplete in the following places. Any conclusion that',
      'depends on an edge CLUE could not resolve should say so.',
      '',
      relevant.length === 0
        ? 'No unresolved references recorded for this subject.'
        : relevant.map((entry) => `- ${entry.kind} at ${entry.anchor.path}:${entry.anchor.startLine} — ${entry.detail}`).join('\n'),
      '',
      'Weakest coverage by subsystem:',
      ...weakest.map((entry) => `- ${entry.subsystem}: ${(entry.coverage * 100).toFixed(1)}% (${entry.unresolved} gaps over ${entry.units} units)`),
    ];

    return makeSection({
      id: 'known-gaps',
      trust: 'RUNTIME_OUTPUT_UNTRUSTED',
      title: 'Known gaps in the analysis',
      body: lines.join('\n'),
      provenance: { record_id: snapshotId },
      essential: true,
    });
  }

  /* ------------------------------ internals --------------------------- */

  /**
   * Reads a byte range from the canonical tree, verified against the snapshot.
   *
   * Returns null when the file's hash no longer matches what the snapshot recorded. The
   * caller reports the absence; it never falls back to current bytes, because a slice
   * from a moved file looks exactly like a correct one and would silently misattribute
   * every conclusion drawn from it.
   */
  private readVerifiedSlice(
    snapshotId: string,
    modulePath: string,
    startByte: number,
    endByte: number,
  ): { text: string; fileHash: string } | null {
    if (
      this.snapshots === null ||
      !relativePathSchema.safeParse(modulePath).success ||
      modulePath.includes('\\') ||
      modulePath.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
    ) {
      return null;
    }

    const expected = this.snapshots
      .files(snapshotId)
      .find((file) => file.path === modulePath);
    if (expected === undefined) return null;

    try {
      if (!lstatSync(this.projectRoot).isDirectory()) return null;
      const root = realpathSync.native(this.projectRoot);
      const physical = realpathSync.native(join(root, modulePath));
      const found = normalisePath(relative(root, physical));
      const samePath = process.platform === 'win32'
        ? found.toLowerCase() === modulePath.toLowerCase()
        : found === modulePath;
      if (!samePath) return null;
      const bytes = readFileSync(physical);
      if (hashBytes(bytes) !== expected.hash) return null;
      if (startByte < 0 || endByte > bytes.byteLength || startByte >= endByte) return null;
      return {
        text: decodeSourceByteRange(bytes, sourceTextLayout(bytes), startByte, endByte),
        fileHash: expected.hash,
      };
    } catch {
      return null;
    }
  }

  /**
   * Suggests how to split a task whose essentials do not fit.
   *
   * A proposal rather than an error, because "too big" is nearly always answerable and
   * the shape of the answer is usually obvious from the subject. Handing back a
   * strategy and a list of subjects is the difference between a blocked queue and a
   * scheduler that can act.
   */
  private proposeDecomposition(
    task: TaskRecord,
    options: BuildOptions,
    essentialTokens: number,
  ): DecompositionProposal {
    const reason =
      `Essential context needs ~${essentialTokens} tokens against a budget of ${this.budget}. ` +
      'Essentials are not reducible; the question must be smaller.';

    const snapshotId = options.snapshotId ?? null;
    const unitId = options.subjectUnitId ?? null;

    if (snapshotId !== null && unitId !== null && this.graph !== null) {
      const stored = this.graph.resultOf(snapshotId);
      const subject = stored?.units.find((unit) => unit.logicalId === unitId);

      if (subject !== undefined && subject.kind === 'module') {
        const members = (stored?.units ?? [])
          .filter((unit) => unit.modulePath === subject.modulePath && unit.kind !== 'module')
          .map((unit) => unit.logicalId);

        if (members.length > 1) {
          return {
            reason,
            strategy: 'by-unit',
            subtasks: members.map((memberId) => ({
              label: `${task.type} for ${memberId}`,
              subjectIds: [memberId],
              estimatedTokens: Math.ceil(essentialTokens / members.length),
            })),
          };
        }
      }
    }

    return {
      reason,
      strategy: 'by-module',
      subtasks: [],
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* ------------------------------------------------------------------------- */

/** The Markdown code-fence language for a source file, derived from its extension (DEV-P0-15).
 * Empty (a bare fence) when the extension is unknown, so the fence is never wrong about the language. */
function fenceLanguageFor(path: string): string {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  const byExtension: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', sh: 'bash', sql: 'sql', html: 'html', css: 'css',
  };
  return byExtension[ext] ?? '';
}

function renderClassification(classification: UnitClassification): string {
  return [
    `Class: **${classification.unitClass}** (confidence ${classification.confidence.toFixed(2)})`,
    `Impact: ${classification.impactSize} unit(s) across ${classification.impactModules} module(s), ` +
      `${classification.impactSubsystems} subsystem(s)`,
    `Direct dependents: ${classification.directDependents}`,
    `Impact percentile: ${classification.percentile.toFixed(3)}`,
    classification.truncated
      ? 'The impact traversal hit its depth limit, so the size above is a lower bound.'
      : '',
    '',
    'Why:',
    ...classification.reasons.map((reason) => `- ${reason}`),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function renderClaim(claim: ClaimRecord): string {
  return [
    `**${claim.id}** · ${claim.modality} · ${claim.document_path}:${claim.start_line}`,
    claim.raw_text,
    `_status: ${claim.status}_`,
  ].join('\n');
}

function mentions(claim: ClaimRecord, subject: string): boolean {
  const needle = subject.toLowerCase();
  if (claim.subject_key !== null && needle.includes(claim.subject_key)) return true;
  return claim.subjects.some((term) => needle.includes(term.toLowerCase()));
}

/** Recovers a section's kind from its id, for stable ordering after selection. */
function kindOf(section: ContextSection): SectionKind {
  const byId: Readonly<Record<string, SectionKind>> = {
    'mission-rules': 'missionRules',
    'project-authority': 'projectAuthority',
    'task-directive': 'taskDirective',
    'output-requirements': 'outputRequirements',
    'subject-source': 'subjectSource',
    'subject-classification': 'subjectClassification',
    'graph-neighbourhood': 'graphNeighbourhood',
    'dependency-source': 'dependencySource',
    relatedClaims: 'relatedClaims',
    'conflicting-claims': 'conflictingClaims',
    'prior-results': 'priorResults',
    'known-gaps': 'knownGaps',
  };
  return byId[section.id] ?? 'relatedClaims';
}

export { estimateTokens };
export type { ContextSection, TrustClass };
