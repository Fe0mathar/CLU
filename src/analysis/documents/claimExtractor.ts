/**
 * CLUE claim extractor.
 *
 * Spec: CLUE_implementation.md §21 (document bootstrap), §22 (claims and anchors),
 *       §41 (the deterministic recognizer owns structure; model output is provisional).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.2, Part V Stage B.
 *
 * Turns document structure into claim candidates: individual statements about Murugan
 * that could in principle be checked against source or runtime, each carrying the exact
 * anchor it came from.
 *
 * The division of labour matters more than any heuristic in this file. Extraction is
 * deterministic and owns *what was said and where*. Interpretation — whether a claim is
 * true, whether two claims really contradict, what a claim implies for a patch — is a
 * later task, done by workers whose output is schema-validated and provisional until
 * integrated. A model that hallucinated a claim would poison the registry permanently;
 * a scanner that misjudges a sentence's modality costs one review.
 *
 * Nothing here is persisted. This module is pure: bytes in, candidates out, same answer
 * every time. The registry that assigns CLAIM ids, writes events, and maintains the
 * conflict and missing-source registries consumes these candidates.
 *
 * Deliberate bias throughout: **report rather than resolve**. A candidate that might be
 * a claim is emitted with a low strength score; a sentence that might be normative is
 * marked normative. The ranker downstream can ignore weak candidates cheaply. It cannot
 * recover a statement this scanner decided to swallow.
 */

import { hashText, type Sha256 } from '../../shared/ids.js';
import type { BlockKind, DocumentStructure, Section, SourceAnchor } from './markdownStructure.js';

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * What kind of force a statement carries.
 *
 * The distinction earns its keep at proof time: a prohibition becomes a guardrail, a
 * requirement becomes an assertion, an invariant becomes a regression test, and a plan
 * becomes nothing at all until it stops being a plan.
 */
export type ClaimModality =
  | 'prohibition'
  | 'requirement'
  | 'invariant'
  | 'recommendation'
  | 'definition'
  | 'plan'
  | 'description';

export type ClaimPolarity = 'affirmative' | 'negative';

/** Lifecycle of a claim's relationship to reality. Documents are never runtime truth. */
export type ClaimStatus = 'declared' | 'source-confirmed' | 'runtime-observed' | 'contradicted';

/** Domain packs, per the specification's grouping of Murugan subsystems. */
export type DomainPack =
  | 'diagnostics'
  | 'rendering'
  | 'gaussian'
  | 'worldAuthority'
  | 'scripting'
  | 'npcAi'
  | 'interaction'
  | 'voice'
  | 'economy'
  | 'settlement'
  | 'general';

/** A number found in a claim, kept for numeric contradiction detection. */
export interface ClaimNumber {
  readonly value: number;
  readonly unit: string | null;
  readonly raw: string;
}

export interface ClaimCandidate {
  /**
   * Stable identity of this claim within this document, across re-extraction and
   * across edits that only touch whitespace, casing, or trailing punctuation.
   */
  readonly fingerprint: Sha256;
  /**
   * Identity of the statement itself, independent of which document made it. Two
   * documents asserting the same thing share a textKey — which is how agreement and
   * duplication are told apart from contradiction.
   */
  readonly textKey: Sha256;
  readonly text: string;
  readonly rawText: string;
  readonly anchor: SourceAnchor;
  readonly blockKind: BlockKind;
  readonly sectionId: string | null;
  readonly sectionTitlePath: readonly string[];
  readonly modality: ClaimModality;
  readonly polarity: ClaimPolarity;
  readonly status: ClaimStatus;
  /** Terms the claim is about, strongest first. Code spans outrank prose terms. */
  readonly subjects: readonly string[];
  /** Normalised primary subject; the grouping key for contradiction detection. */
  readonly subjectKey: string | null;
  readonly domains: readonly DomainPack[];
  /** True when the claim mentions something an instrument could actually measure. */
  readonly measurable: boolean;
  readonly numbers: readonly ClaimNumber[];
  /**
   * 0-1 estimate that this is a claim worth spending tokens on. Not a truth estimate —
   * a triage score, so weak candidates can be filtered without being lost.
   */
  readonly strength: number;
}

export interface DomainRule {
  readonly domain: DomainPack;
  readonly patterns: readonly RegExp[];
}

export interface ClaimExtractionOptions {
  /** Shortest text accepted as a claim. Below this, statements carry no checkable content. */
  readonly minimumLength?: number;
  /** Domain classification rules. Defaults to the Murugan subsystem packs. */
  readonly domainRules?: readonly DomainRule[];
  /** Extra project vocabulary treated as strong subject terms. */
  readonly lexicon?: readonly string[];
}

/* ------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Domain packs for Murugan.
 *
 * Injectable rather than hard-wired: CLUE is a general instrument pointed at one
 * project, and the day it is pointed at another, these rules are configuration rather
 * than a rewrite.
 */
export const MURUGAN_DOMAIN_RULES: readonly DomainRule[] = [
  {
    domain: 'gaussian',
    patterns: [/\bgaussian\b/i, /\bsplat/i, /\bsogs\b/i, /\b\.ply\b/i, /\bsupersplat\b/i, /\baholo\b/i],
  },
  {
    domain: 'rendering',
    patterns: [
      /\bwebgpu\b/i,
      /\bwgsl\b/i,
      /\brender(er|ing|-module)?\b/i,
      /\bshader\b/i,
      /\bframe\b/i,
      /\bgame view\b/i,
      /\btilepack\b/i,
      /\bocean\b/i,
      /\bdevice[- ]loss\b/i,
      /\bbuffer ring\b/i,
    ],
  },
  {
    domain: 'diagnostics',
    patterns: [
      /\bprobe\b/i,
      /\bdiagnostic/i,
      /\bframedoctor\b/i,
      /\bhud\b/i,
      /\btelemetry\b/i,
      /\bwindow\.__murugan/i,
    ],
  },
  {
    domain: 'worldAuthority',
    patterns: [/\bworld authority\b/i, /\bbiome/i, /\bweather\b/i, /\bwather\b/i, /\bterrain\b/i, /\bplot\b/i],
  },
  { domain: 'scripting', patterns: [/\bscript(ing)?\b/i, /\bgrammar\b/i, /\bsandbox\b/i] },
  {
    domain: 'npcAi',
    patterns: [/\bnpc\b/i, /\butility ai\b/i, /\bslow brain\b/i, /\btransformers\.js\b/i, /\bollama\b/i, /\bllm\b/i],
  },
  { domain: 'interaction', patterns: [/\binteraction\b/i, /\binput\b/i, /\bcamera\b/i, /\bcontrols?\b/i] },
  { domain: 'voice', patterns: [/\bvoice\b/i, /\bspeech\b/i, /\btts\b/i, /\basr\b/i] },
  { domain: 'economy', patterns: [/\beconomy\b/i, /\bitem\b/i, /\btrade\b/i, /\bescrow\b/i, /\breward\b/i, /\bcurrency\b/i] },
  { domain: 'settlement', patterns: [/\bneo\b/i, /\bwallet\b/i, /\bsettlement\b/i, /\bchain\b/i, /\bon-chain\b/i] },
];

const DEFAULT_MINIMUM_LENGTH = 24;

/* ------------------------------------------------------------------------- */
/* Modality vocabulary                                                        */
/* ------------------------------------------------------------------------- */
/* Order is load-bearing: "must not" must be tested before "must", or every prohibition
 * in the corpus would be filed as a requirement — which is the single most damaging
 * misclassification this module could make, because it inverts a guardrail. */

const PROHIBITION_PATTERNS: readonly RegExp[] = [
  /\bmust not\b/i,
  /\bmay not\b/i,
  /\bshall not\b/i,
  /\bcannot\b/i,
  /\bcan not\b/i,
  /\bnever\b/i,
  /\bis (?:strictly )?forbidden\b/i,
  /\bis not permitted\b/i,
  /\bare not permitted\b/i,
  /\bdo(?:es)? not\b/i,
  /\bdon't\b/i,
  /\bavoid\b/i,
  /\brefus(?:e|es|ed)\b/i,
  /\bprohibit(?:ed|s)?\b/i,
  /\bno\s+\w+\s+(?:may|shall|is allowed)\b/i,
];

const REQUIREMENT_PATTERNS: readonly RegExp[] = [
  /\bmust\b/i,
  /\bshall\b/i,
  /\bis required\b/i,
  /\bare required\b/i,
  /\brequires?\b/i,
  /\balways\b/i,
  /\bhas to\b/i,
  /\bneeds? to\b/i,
  /\bmandatory\b/i,
];

const INVARIANT_PATTERNS: readonly RegExp[] = [
  /\binvariant\b/i,
  /\bguarantee(?:s|d)?\b/i,
  /\bensures?\b/i,
  /\bholds?\b(?!\s+(?:a|the)\b)/i,
  /\bonly\b.*\b(?:may|can)\b/i,
  /\bexactly one\b/i,
  /\bnever\b.*\bwithout\b/i,
];

const RECOMMENDATION_PATTERNS: readonly RegExp[] = [
  /\bshould\b/i,
  /\bprefer(?:red|s)?\b/i,
  /\brecommended\b/i,
  /\bconsider\b/i,
  /\bought to\b/i,
];

const DEFINITION_PATTERNS: readonly RegExp[] = [
  /\bis defined as\b/i,
  /\bmeans\b/i,
  /\brefers to\b/i,
  /\bis the\b/i,
  /\bare the\b/i,
  /\bconsists of\b/i,
  /\bis a\b/i,
];

const PLAN_PATTERNS: readonly RegExp[] = [
  /\bwill be\b/i,
  /\bplanned\b/i,
  /\bdeferred\b/i,
  /\bscheduled\b/i,
  /\blater stage\b/i,
  /\bnot yet\b/i,
  /\bfuture\b/i,
  /\btodo\b/i,
  /\bstage [a-z]\b/i,
];

const MEASURABLE_PATTERNS: readonly RegExp[] = [
  /\bms\b/i,
  /\bmilliseconds?\b/i,
  /\bfps\b/i,
  /\bframe (?:time|budget|rate)\b/i,
  /\ballocation/i,
  /\bmemory\b/i,
  /\bbudget\b/i,
  /\bthreshold\b/i,
  /\bpercent|%/i,
  /\bbytes?\b/i,
  /\bmb\b|\bgb\b|\bkb\b/i,
  /\bcount\b/i,
  /\bexceeds?\b/i,
  /\bat most\b|\bat least\b/i,
  /\bp9[59]\b/i,
  /\bmedian\b/i,
  /\bper (?:frame|second|tile|draw)\b/i,
];

const NEGATION_TOKENS = /\b(?:not|never|no|without|neither|nor)\b/i;

/* ------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Extracts claim candidates from a parsed document.
 *
 * Headings and code blocks are excluded. Headings are context, not assertions — they
 * carry no verb and would flood the registry with unfalsifiable fragments. Code blocks
 * are samples; a claim anchored to an illustrative snippet points at something the
 * project never promised.
 */
export function extractClaims(
  structure: DocumentStructure,
  options: ClaimExtractionOptions = {},
): ClaimCandidate[] {
  const minimumLength = options.minimumLength ?? DEFAULT_MINIMUM_LENGTH;
  const domainRules = options.domainRules ?? MURUGAN_DOMAIN_RULES;
  const lexicon = options.lexicon ?? [];
  const sectionIndex = indexSectionsByBlock(structure.sections);
  const candidates: ClaimCandidate[] = [];

  for (const block of structure.blocks) {
    if (block.kind === 'heading' || block.kind === 'code' || block.kind === 'frontmatter') continue;
    if (block.kind === 'thematicBreak' || block.kind === 'html') continue;

    const section = sectionIndex.get(block.index) ?? null;
    const units = collectUnits(block);

    for (const unit of units) {
      const raw = unit.trim();
      if (raw.length < minimumLength) continue;
      if (isStructuralNoise(raw)) continue;

      candidates.push(
        buildCandidate({
          raw,
          anchor: block.anchor,
          blockKind: block.kind,
          section,
          documentPath: structure.path,
          domainRules,
          lexicon,
        }),
      );
    }
  }

  // One normative sentence stated twice in a document is ONE claim, not two. The
  // fingerprint is the claim's normative identity and the registry's natural key is
  // (fingerprint, document_hash), so a within-document repeat is the document
  // *emphasising* a norm, never multiplying it. The first occurrence anchors the claim;
  // without this dedupe the ingest batch violates its own natural key — found live when
  // the real constitution repeated its core axiom (“jeżeli poprawy nie da się udowodnić,
  // poprawa nie istnieje”) and the projection crashed on the second occurrence.
  const seenFingerprints = new Set<string>();
  const deduplicated: ClaimCandidate[] = [];
  for (const candidate of candidates) {
    if (seenFingerprints.has(candidate.fingerprint)) continue;
    seenFingerprints.add(candidate.fingerprint);
    deduplicated.push(candidate);
  }
  return deduplicated;
}

interface CandidateInput {
  readonly raw: string;
  readonly anchor: SourceAnchor;
  readonly blockKind: BlockKind;
  readonly section: Section | null;
  readonly documentPath: string;
  readonly domainRules: readonly DomainRule[];
  readonly lexicon: readonly string[];
}

function buildCandidate(input: CandidateInput): ClaimCandidate {
  const normalised = normaliseClaimText(input.raw);
  const modality = classifyModality(input.raw);
  const polarity: ClaimPolarity =
    modality === 'prohibition' || NEGATION_TOKENS.test(input.raw) ? 'negative' : 'affirmative';

  const subjects = extractSubjects(input.raw, input.lexicon);
  const numbers = extractNumbers(input.raw);
  const measurable = numbers.length > 0 || MEASURABLE_PATTERNS.some((pattern) => pattern.test(input.raw));
  const domains = classifyDomains(input.raw, input.domainRules);

  return {
    fingerprint: hashText(`${input.documentPath}\0${normalised}`),
    textKey: hashText(normalised),
    text: normalised,
    rawText: input.raw,
    anchor: input.anchor,
    blockKind: input.blockKind,
    sectionId: input.section?.id ?? null,
    sectionTitlePath: input.section?.titlePath ?? [],
    modality,
    polarity,
    status: 'declared',
    subjects,
    subjectKey: subjects[0] === undefined ? null : normaliseSubject(subjects[0]),
    domains,
    measurable,
    numbers,
    strength: scoreStrength({ modality, subjects, measurable, length: normalised.length }),
  };
}

/* ------------------------------------------------------------------------- */
/* Unit collection                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Splits a block into the units that become individual claims.
 *
 * List items and table rows stay whole. Both are already authored as one statement
 * apiece, and splitting them on punctuation produces fragments whose subject lives in
 * a sibling fragment — a claim that cannot be understood alone cannot be checked alone.
 */
function collectUnits(block: DocumentStructure['blocks'][number]): string[] {
  switch (block.kind) {
    case 'list':
      return block.items.map((item) => stripListMarker(item.text));
    case 'table':
      return block.rows
        .filter((row) => row.some((cell) => cell.length > 0))
        .map((row) => describeTableRow(block.columns, row));
    case 'blockquote':
      return splitSentences(block.content);
    case 'paragraph':
      return splitSentences(block.text);
    default:
      return [];
  }
}

function stripListMarker(text: string): string {
  return text.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Renders a table row as a sentence-like statement.
 *
 * The first cell is almost always the subject in these documents, so it leads, and the
 * remaining cells are attributed to their column headers. The result reads awkwardly but
 * carries the row's full meaning into a single anchorable unit.
 */
function describeTableRow(columns: readonly string[], row: readonly string[]): string {
  const subject = row[0] ?? '';
  const rest: string[] = [];

  for (let index = 1; index < row.length; index += 1) {
    const value = row[index];
    if (value === undefined || value.length === 0) continue;
    const column = columns[index];
    rest.push(column === undefined || column.length === 0 ? value : `${column}: ${value}`);
  }

  return rest.length === 0 ? subject : `${subject} — ${rest.join('; ')}`;
}

/**
 * Conservative sentence splitting.
 *
 * Inline code is masked first so that a period inside `window.__murugan` or a version
 * string never becomes a sentence boundary, and a short list of abbreviations is
 * protected. Anything ambiguous stays joined: an over-long claim is still checkable,
 * while a claim severed from its subject is not.
 */
export function splitSentences(text: string): string[] {
  const spans: string[] = [];
  const masked = text.replace(/`[^`]*`/g, (span) => {
    spans.push(span);
    return `\u0000${spans.length - 1}\u0000`;
  });

  const guarded = masked
    .replace(/\b(e\.g|i\.e|etc|vs|cf|approx|fig|no|vol|ch|sec|ref)\./gi, '$1\u0001')
    .replace(/(\d)\.(\d)/g, '$1\u0001$2')
    .replace(/§\s*(\d+)\./g, '§$1\u0001');

  return guarded
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`"'\u00AB])/)
    .map((sentence) =>
      sentence
        .replace(/\u0001/g, '.')
        .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => spans[Number(index)] ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((sentence) => sentence.length > 0);
}

/**
 * Rejects fragments that look like structure rather than assertion.
 *
 * Bare paths, pure identifiers, and cross-references carry no predicate. Keeping them
 * would inflate the registry with entries no instrument could ever confirm or refute.
 */
function isStructuralNoise(text: string): boolean {
  if (!/[a-z]{3}/i.test(text)) return true;
  if (/^[`'"]?[\w./\\-]+[`'"]?$/.test(text)) return true;
  if (/^(?:see|per|source|spec|strategy|ref(?:erence)?)\b[^.]{0,60}$/i.test(text)) return true;
  if (/^\s*[|+-]+\s*$/.test(text)) return true;
  return false;
}

/* ------------------------------------------------------------------------- */
/* Classification                                                             */
/* ------------------------------------------------------------------------- */

export function classifyModality(text: string): ClaimModality {
  if (PROHIBITION_PATTERNS.some((pattern) => pattern.test(text))) return 'prohibition';
  if (REQUIREMENT_PATTERNS.some((pattern) => pattern.test(text))) return 'requirement';
  if (INVARIANT_PATTERNS.some((pattern) => pattern.test(text))) return 'invariant';
  if (RECOMMENDATION_PATTERNS.some((pattern) => pattern.test(text))) return 'recommendation';
  if (PLAN_PATTERNS.some((pattern) => pattern.test(text))) return 'plan';
  if (DEFINITION_PATTERNS.some((pattern) => pattern.test(text))) return 'definition';
  return 'description';
}

function classifyDomains(text: string, rules: readonly DomainRule[]): DomainPack[] {
  const domains = rules
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(text)))
    .map((rule) => rule.domain);
  return domains.length === 0 ? ['general'] : domains;
}

/**
 * Pulls out the terms a claim is about.
 *
 * Code spans first, because an identifier is unambiguous in a way prose never is; then
 * project vocabulary; then capitalised multi-word terms. Order is the ranking, and the
 * first entry becomes the grouping key for contradiction detection.
 */
export function extractSubjects(text: string, lexicon: readonly string[]): string[] {
  const subjects: string[] = [];
  const seen = new Set<string>();

  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    const key = normaliseSubject(trimmed);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    subjects.push(trimmed);
  };

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const span = match[1];
    if (span !== undefined) add(span);
  }

  for (const term of lexicon) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text)) add(term);
  }

  for (const match of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    const term = match[1];
    if (term !== undefined && !isSentenceOpener(text, match.index ?? 0)) add(term);
  }

  for (const match of text.matchAll(/\b([a-z]+[A-Z]\w*|\w+_\w+|\w+\.(?:ts|tsx|js|wgsl|glb|ply|md))\b/g)) {
    const term = match[1];
    if (term !== undefined) add(term);
  }

  return subjects;
}

/** A capitalised word at position 0 is probably just a sentence start, not a term. */
function isSentenceOpener(text: string, index: number): boolean {
  if (index !== 0) return false;
  const word = text.slice(0, text.indexOf(' ') === -1 ? text.length : text.indexOf(' '));
  return !/[A-Z]{2,}|[a-z][A-Z]/.test(word);
}

export function normaliseSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[`'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNumbers(text: string): ClaimNumber[] {
  const numbers: ClaimNumber[] = [];
  for (const match of text.matchAll(/(-?\d+(?:\.\d+)?)\s*(%|ms|s\b|fps|mb|gb|kb|bytes?|px)?/gi)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) continue;
    numbers.push({ value, unit: match[2]?.toLowerCase() ?? null, raw: match[0].trim() });
  }
  return numbers;
}

/**
 * Triage score, not a truth estimate.
 *
 * A claim that is normative, names something specific, and mentions a measurable
 * quantity is worth a worker's attention. Loose prose scores low and is filtered by the
 * ranker rather than discarded here, because the threshold belongs to the consumer.
 */
function scoreStrength(input: {
  modality: ClaimModality;
  subjects: readonly string[];
  measurable: boolean;
  length: number;
}): number {
  let score = 0.2;

  switch (input.modality) {
    case 'prohibition':
    case 'requirement':
    case 'invariant':
      score += 0.35;
      break;
    case 'recommendation':
    case 'definition':
      score += 0.15;
      break;
    case 'plan':
      score -= 0.1;
      break;
    default:
      break;
  }

  if (input.subjects.length > 0) score += 0.2;
  if (input.subjects.length > 2) score += 0.05;
  if (input.measurable) score += 0.2;
  if (input.length > 400) score -= 0.1;

  return Math.min(1, Math.max(0, Number(score.toFixed(3))));
}

/* ------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Canonical form used for claim identity.
 *
 * Collapses whitespace, unifies quote and dash characters, lowercases, and drops
 * trailing punctuation. The result is that re-formatting a document — rewrapping a
 * paragraph, changing a hyphen to an em dash — does not invent new claims or orphan
 * the findings attached to the old ones.
 */
export function normaliseClaimText(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.;,:]+$/, '')
    .trim()
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------------- */
/* Section index                                                              */
/* ------------------------------------------------------------------------- */

/** Maps every block index to its innermost enclosing section. */
function indexSectionsByBlock(sections: readonly Section[]): Map<number, Section> {
  const index = new Map<number, Section>();

  const walk = (section: Section): void => {
    const [start, end] = section.blockRange;
    for (let blockIndex = start; blockIndex <= end; blockIndex += 1) {
      index.set(blockIndex, section);
    }
    for (const child of section.children) walk(child);
  };

  for (const section of sections) walk(section);
  return index;
}
