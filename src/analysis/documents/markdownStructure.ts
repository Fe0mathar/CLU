/**
 * CLUE Markdown structural extractor.
 *
 * Spec: CLUE_implementation.md §21 (document bootstrap), §22 (claims and anchors),
 *       §23.2 (a conservative grammar-backed scanner before a heavy parser).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.2, Part V Stage B.
 *
 * Turns a Markdown document into blocks, a section tree, and outbound document
 * references — every one of them carrying an anchor precise enough to re-read the exact
 * bytes it came from. That precision is the point. A claim that cites "somewhere in the
 * economy section" cannot be checked later; a claim that cites bytes 41102-41288 of a
 * document with a known hash can be checked forever, including after the document moves
 * on and the claim has to be re-examined against what it actually said.
 *
 * Written rather than taken from a library, for three reasons:
 *   1. Anchors must be byte-exact against the file as stored, which a general AST's
 *      character positions do not give on non-ASCII content — and these documents are
 *      full of §, —, and «».
 *   2. The dependency budget is deliberately small, and a Markdown parser is a large
 *      surface to maintain for a scanner this project can fully audit.
 *   3. §23.2 already establishes the pattern: a conservative scanner first, a real
 *      parser only when evidence shows the scanner is missing something that matters.
 *
 * The scanner is conservative by design. It recognises the constructs these documents
 * actually use — ATX headings, fenced code, pipe tables, lists, blockquotes, front
 * matter — and classifies anything it does not recognise as a paragraph rather than
 * guessing. A misclassified paragraph costs a little context; a confidently wrong parse
 * costs a claim anchored to the wrong place.
 */

import { requireSha256, type Sha256 } from '../../shared/ids.js';

/* ------------------------------------------------------------------------- */
/* Anchors                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * An exact, re-resolvable location inside a document.
 *
 * Lines are 1-based and inclusive because that is how a human reads an error message.
 * Byte offsets are 0-based, `startByte` inclusive and `endByte` exclusive, measured in
 * UTF-8 bytes against the file exactly as stored — including CRLF, which Windows hosts
 * will produce and which must not be normalised away or every offset shifts.
 */
export interface SourceAnchor {
  readonly documentPath: string;
  readonly documentHash: Sha256;
  readonly startLine: number;
  readonly endLine: number;
  readonly startByte: number;
  readonly endByte: number;
}

/** Human-readable form for reports and context packs: `path:12-34`. */
export function formatAnchor(anchor: SourceAnchor): string {
  return anchor.startLine === anchor.endLine
    ? `${anchor.documentPath}:${anchor.startLine}`
    : `${anchor.documentPath}:${anchor.startLine}-${anchor.endLine}`;
}

/**
 * Re-reads the bytes an anchor points at.
 *
 * Takes the raw file bytes rather than a decoded string so that the offsets mean what
 * they claim. A caller holding only text should decode the slice, not slice the text.
 */
export function sliceAnchor(bytes: Uint8Array, anchor: SourceAnchor): string {
  if (anchor.endByte > bytes.byteLength) {
    throw new Error(
      `Anchor ${formatAnchor(anchor)} runs past the end of the document ` +
        `(${anchor.endByte} > ${bytes.byteLength})`,
    );
  }
  return Buffer.from(bytes.subarray(anchor.startByte, anchor.endByte)).toString('utf8');
}

/* ------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* ------------------------------------------------------------------------- */

export type BlockKind =
  | 'frontmatter'
  | 'heading'
  | 'paragraph'
  | 'code'
  | 'list'
  | 'table'
  | 'blockquote'
  | 'thematicBreak'
  | 'html';

interface BlockBase {
  readonly index: number;
  readonly anchor: SourceAnchor;
  /** The raw text of the block, exactly as written. */
  readonly text: string;
}

export interface HeadingBlock extends BlockBase {
  readonly kind: 'heading';
  /** 1-6 for ATX; setext headings resolve to 1 or 2. */
  readonly level: number;
  readonly title: string;
  readonly slug: string;
}

export interface ParagraphBlock extends BlockBase {
  readonly kind: 'paragraph';
}

export interface CodeBlock extends BlockBase {
  readonly kind: 'code';
  readonly language: string | null;
  /** Fence contents without the delimiter lines. */
  readonly content: string;
  /** False when the document ends before the closing fence. */
  readonly closed: boolean;
}

export interface ListItem {
  readonly anchor: SourceAnchor;
  readonly marker: string;
  readonly indent: number;
  readonly text: string;
}

export interface ListBlock extends BlockBase {
  readonly kind: 'list';
  readonly ordered: boolean;
  readonly items: readonly ListItem[];
}

export interface TableBlock extends BlockBase {
  readonly kind: 'table';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface BlockquoteBlock extends BlockBase {
  readonly kind: 'blockquote';
  readonly content: string;
}

export interface ThematicBreakBlock extends BlockBase {
  readonly kind: 'thematicBreak';
}

export interface HtmlBlock extends BlockBase {
  readonly kind: 'html';
}

export interface FrontmatterBlock extends BlockBase {
  readonly kind: 'frontmatter';
  readonly content: string;
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | CodeBlock
  | ListBlock
  | TableBlock
  | BlockquoteBlock
  | ThematicBreakBlock
  | HtmlBlock
  | FrontmatterBlock;

/* ------------------------------------------------------------------------- */
/* Sections and references                                                    */
/* ------------------------------------------------------------------------- */

/** A heading and everything beneath it, up to the next heading of the same or higher level. */
export interface Section {
  /** Stable within a document: the slug path from the root, joined by '/'. */
  readonly id: string;
  readonly level: number;
  readonly title: string;
  /** Ancestor titles, own title last. The trail a context pack shows a worker. */
  readonly titlePath: readonly string[];
  readonly headingIndex: number;
  /** Covers the heading line through the last line of the section. */
  readonly anchor: SourceAnchor;
  /** Inclusive block index range, heading included. */
  readonly blockRange: readonly [number, number];
  readonly children: readonly Section[];
}

export type ReferenceKind = 'link' | 'inlineCode' | 'bareMention';

/**
 * A mention of another document.
 *
 * Feeds the missing-source registry: a reference whose target is absent from the
 * ingested set is a visible gap, not a silent one. Reconstructing what a missing
 * document probably said is exactly the failure this exists to prevent.
 */
export interface DocumentReference {
  readonly target: string;
  readonly kind: ReferenceKind;
  readonly anchor: SourceAnchor;
  /** The surrounding line, for judging whether the mention is substantive. */
  readonly context: string;
}

export interface DocumentStructure {
  readonly path: string;
  readonly hash: Sha256;
  readonly byteLength: number;
  readonly lineCount: number;
  /** True when the file uses CRLF anywhere; recorded because it changes every offset. */
  readonly hasCrlf: boolean;
  readonly blocks: readonly Block[];
  readonly sections: readonly Section[];
  readonly references: readonly DocumentReference[];
}

export interface ExtractInput {
  readonly path: string;
  readonly hash: string;
  /** Raw file bytes. Decoding happens here so offsets stay honest. */
  readonly bytes: Uint8Array;
}

/* ------------------------------------------------------------------------- */
/* Line model                                                                 */
/* ------------------------------------------------------------------------- */

interface Line {
  /** 1-based. */
  readonly number: number;
  /** Content without the line terminator. */
  readonly text: string;
  /** Byte offset of the first character. */
  readonly startByte: number;
  /** Byte offset just past the content, before the terminator. */
  readonly contentEndByte: number;
  /** Byte offset just past the terminator; equals contentEndByte on the final line. */
  readonly endByte: number;
}

function splitLines(text: string): { lines: Line[]; hasCrlf: boolean } {
  const lines: Line[] = [];
  let hasCrlf = false;
  let offset = 0;
  let number = 1;
  let cursor = 0;

  while (cursor <= text.length) {
    const newlineIndex = text.indexOf('\n', cursor);
    const isLast = newlineIndex === -1;
    const rawEnd = isLast ? text.length : newlineIndex;

    let content = text.slice(cursor, rawEnd);
    let terminatorBytes = isLast ? 0 : 1;
    if (content.endsWith('\r')) {
      content = content.slice(0, -1);
      terminatorBytes += 1;
      hasCrlf = true;
    }

    const contentBytes = Buffer.byteLength(content, 'utf8');
    lines.push({
      number,
      text: content,
      startByte: offset,
      contentEndByte: offset + contentBytes,
      endByte: offset + contentBytes + terminatorBytes,
    });

    offset += contentBytes + terminatorBytes;
    number += 1;
    if (isLast) break;
    cursor = newlineIndex + 1;
  }

  return { lines, hasCrlf };
}

/* ------------------------------------------------------------------------- */
/* Patterns                                                                   */
/* ------------------------------------------------------------------------- */

const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const CLOSING_HASHES = /\s+#+\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*(\S.*?)?\s*$/;
const THEMATIC_BREAK = /^ {0,3}((?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/;
const UNORDERED_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_ITEM = /^(\s*)(\d{1,9}[.)])\s+(.*)$/;
const BLOCKQUOTE = /^ {0,3}>\s?(.*)$/;
const HTML_OPEN = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*|!--)/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\s]+)[^)]*\)/g;
const INLINE_CODE_DOCUMENT = /`([A-Za-z0-9._/\\-]+\.(?:md|markdown|txt|json|ya?ml))`/g;
const BARE_DOCUMENT = /(?<![`/\w.-])([A-Za-z][A-Za-z0-9._-]*\.(?:md|markdown))(?![`\w])/g;

/* ------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Parses a Markdown document into blocks, sections, and references.
 *
 * Deterministic and side-effect free: the same bytes always produce the same structure,
 * which is what lets a snapshot of the analysis be compared across runs.
 */
export function extractDocumentStructure(input: ExtractInput): DocumentStructure {
  const hash = requireSha256(input.hash, `document ${input.path}`);
  const text = Buffer.from(input.bytes).toString('utf8');
  const { lines, hasCrlf } = splitLines(text);

  const context: ScanContext = {
    path: input.path,
    hash,
    lines,
    blocks: [],
    slugs: new Map<string, number>(),
  };

  let cursor = scanFrontmatter(context);
  while (cursor < lines.length) {
    cursor = scanBlock(context, cursor);
  }

  const sections = buildSections(context);
  const references = collectReferences(context);

  return {
    path: input.path,
    hash,
    byteLength: input.bytes.byteLength,
    lineCount: lines.length,
    hasCrlf,
    blocks: context.blocks,
    sections,
    references,
  };
}

interface ScanContext {
  readonly path: string;
  readonly hash: Sha256;
  readonly lines: readonly Line[];
  readonly blocks: Block[];
  readonly slugs: Map<string, number>;
}

function anchorFor(context: ScanContext, startIndex: number, endIndex: number): SourceAnchor {
  const start = context.lines[startIndex];
  const end = context.lines[endIndex];
  if (start === undefined || end === undefined) {
    throw new Error(`Invalid anchor range ${startIndex}-${endIndex} in ${context.path}`);
  }
  return {
    documentPath: context.path,
    documentHash: context.hash,
    startLine: start.number,
    endLine: end.number,
    startByte: start.startByte,
    endByte: end.contentEndByte,
  };
}

function rawText(context: ScanContext, startIndex: number, endIndex: number): string {
  const slice: string[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = context.lines[index];
    if (line !== undefined) slice.push(line.text);
  }
  return slice.join('\n');
}

/** YAML front matter, recognised only when `---` opens line 1. */
function scanFrontmatter(context: ScanContext): number {
  const first = context.lines[0];
  if (first === undefined || first.text.trim() !== '---') return 0;

  for (let index = 1; index < context.lines.length; index += 1) {
    const line = context.lines[index];
    if (line === undefined) break;
    if (line.text.trim() === '---') {
      push(context, {
        kind: 'frontmatter',
        index: context.blocks.length,
        anchor: anchorFor(context, 0, index),
        text: rawText(context, 0, index),
        content: rawText(context, 1, index - 1),
      });
      return index + 1;
    }
  }
  // No closing delimiter: it was a thematic break, not front matter. Rescan normally.
  return 0;
}

/** Consumes one block starting at `start` and returns the next unconsumed index. */
function scanBlock(context: ScanContext, start: number): number {
  const line = context.lines[start];
  if (line === undefined) return start + 1;

  if (line.text.trim().length === 0) return start + 1;

  const fence = FENCE_OPEN.exec(line.text);
  if (fence !== null) return scanCode(context, start, fence);

  const heading = ATX_HEADING.exec(line.text);
  if (heading !== null) return scanAtxHeading(context, start, heading);

  if (THEMATIC_BREAK.test(line.text)) {
    push(context, {
      kind: 'thematicBreak',
      index: context.blocks.length,
      anchor: anchorFor(context, start, start),
      text: line.text,
    });
    return start + 1;
  }

  if (BLOCKQUOTE.test(line.text)) return scanBlockquote(context, start);
  if (UNORDERED_ITEM.test(line.text) || ORDERED_ITEM.test(line.text)) return scanList(context, start);
  if (isTableStart(context, start)) return scanTable(context, start);
  if (HTML_OPEN.test(line.text)) return scanHtml(context, start);

  return scanParagraph(context, start);
}

/**
 * A fenced code block.
 *
 * Scanned before every other construct on purpose: a `#` or `|` inside a fence is
 * content, and a scanner that reads it as structure will anchor claims to code samples.
 */
function scanCode(context: ScanContext, start: number, fence: RegExpExecArray): number {
  const delimiter = fence[1] ?? '```';
  const info = fence[2] ?? '';
  const fenceChar = delimiter.charAt(0);
  const closer = new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${delimiter.length},}\\s*$`);

  let end = context.lines.length - 1;
  let closed = false;
  for (let index = start + 1; index < context.lines.length; index += 1) {
    const line = context.lines[index];
    if (line === undefined) break;
    if (closer.test(line.text)) {
      end = index;
      closed = true;
      break;
    }
  }

  push(context, {
    kind: 'code',
    index: context.blocks.length,
    anchor: anchorFor(context, start, end),
    text: rawText(context, start, end),
    language: info.length === 0 ? null : (info.split(/\s+/)[0] ?? null),
    content: closed && end > start + 1 ? rawText(context, start + 1, end - 1) : '',
    closed,
  });
  return end + 1;
}

function scanAtxHeading(context: ScanContext, start: number, match: RegExpExecArray): number {
  const level = (match[1] ?? '#').length;
  const rawTitle = (match[2] ?? '').replace(CLOSING_HASHES, '').trim();

  push(context, {
    kind: 'heading',
    index: context.blocks.length,
    anchor: anchorFor(context, start, start),
    text: context.lines[start]?.text ?? '',
    level,
    title: rawTitle,
    slug: uniqueSlug(context, rawTitle),
  });
  return start + 1;
}

function scanBlockquote(context: ScanContext, start: number): number {
  const content: string[] = [];
  let end = start;

  for (let index = start; index < context.lines.length; index += 1) {
    const line = context.lines[index];
    if (line === undefined) break;
    const match = BLOCKQUOTE.exec(line.text);
    if (match === null) {
      if (line.text.trim().length === 0) break;
      // Lazy continuation: a plain line directly under a quote stays in the quote.
      content.push(line.text);
      end = index;
      continue;
    }
    content.push(match[1] ?? '');
    end = index;
  }

  push(context, {
    kind: 'blockquote',
    index: context.blocks.length,
    anchor: anchorFor(context, start, end),
    text: rawText(context, start, end),
    content: content.join('\n'),
  });
  return end + 1;
}

function scanList(context: ScanContext, start: number): number {
  const first = context.lines[start];
  if (first === undefined) return start + 1;
  const ordered = ORDERED_ITEM.test(first.text);

  const items: ListItem[] = [];
  let end = start;
  let itemStart = -1;
  let itemMarker = '';
  let itemIndent = 0;

  const flush = (lastIndex: number): void => {
    if (itemStart < 0) return;
    items.push({
      anchor: anchorFor(context, itemStart, lastIndex),
      marker: itemMarker,
      indent: itemIndent,
      text: rawText(context, itemStart, lastIndex),
    });
    itemStart = -1;
  };

  for (let index = start; index < context.lines.length; index += 1) {
    const line = context.lines[index];
    if (line === undefined) break;

    if (line.text.trim().length === 0) {
      // A single blank line may separate loose items; two ends the list.
      const next = context.lines[index + 1];
      if (next === undefined || next.text.trim().length === 0) break;
      if (!UNORDERED_ITEM.test(next.text) && !ORDERED_ITEM.test(next.text) && !/^\s{2,}\S/.test(next.text)) {
        break;
      }
      continue;
    }

    const match = (ordered ? ORDERED_ITEM : UNORDERED_ITEM).exec(line.text)
      ?? (ordered ? UNORDERED_ITEM : ORDERED_ITEM).exec(line.text);

    if (match !== null) {
      flush(index - 1);
      itemStart = index;
      itemIndent = (match[1] ?? '').length;
      itemMarker = match[2] ?? '';
      end = index;
      continue;
    }

    if (/^\s{2,}\S/.test(line.text) && itemStart >= 0) {
      end = index;
      continue;
    }
    break;
  }

  flush(end);

  push(context, {
    kind: 'list',
    index: context.blocks.length,
    anchor: anchorFor(context, start, end),
    text: rawText(context, start, end),
    ordered,
    items,
  });
  return end + 1;
}

function isTableStart(context: ScanContext, start: number): boolean {
  const header = context.lines[start];
  const delimiter = context.lines[start + 1];
  if (header === undefined || delimiter === undefined) return false;
  return header.text.includes('|') && TABLE_DELIMITER.test(delimiter.text);
}

function scanTable(context: ScanContext, start: number): number {
  const header = context.lines[start];
  if (header === undefined) return start + 1;

  const columns = splitTableRow(header.text);
  const rows: string[][] = [];
  let end = start + 1;

  for (let index = start + 2; index < context.lines.length; index += 1) {
    const line = context.lines[index];
    if (line === undefined) break;
    if (!line.text.includes('|') || line.text.trim().length === 0) break;
    rows.push(splitTableRow(line.text));
    end = index;
  }

  push(context, {
    kind: 'table',
    index: context.blocks.length,
    anchor: anchorFor(context, start, end),
    text: rawText(context, start, end),
    columns,
    rows,
  });
  return end + 1;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function scanHtml(context: ScanContext, start: number): number {
  let end = start;
  for (let index = start; index < context.lines.length; index += 1) {
    const line = context.lines[index];
    if (line === undefined || line.text.trim().length === 0) break;
    end = index;
  }
  push(context, {
    kind: 'html',
    index: context.blocks.length,
    anchor: anchorFor(context, start, end),
    text: rawText(context, start, end),
  });
  return end + 1;
}

/**
 * A paragraph, ending at a blank line or at any line that opens another construct.
 *
 * A setext underline directly beneath the paragraph converts it into a heading, which
 * is why paragraphs are scanned last: everything else has already had its chance.
 */
function scanParagraph(context: ScanContext, start: number): number {
  let end = start;

  for (let index = start; index < context.lines.length; index += 1) {
    const line = context.lines[index];
    if (line === undefined) break;
    if (line.text.trim().length === 0) break;

    if (index > start) {
      if (
        ATX_HEADING.test(line.text) ||
        FENCE_OPEN.test(line.text) ||
        THEMATIC_BREAK.test(line.text) ||
        BLOCKQUOTE.test(line.text) ||
        UNORDERED_ITEM.test(line.text) ||
        ORDERED_ITEM.test(line.text)
      ) {
        break;
      }

      const setext = SETEXT_UNDERLINE.exec(line.text);
      if (setext !== null) {
        const title = rawText(context, start, index - 1).trim();
        push(context, {
          kind: 'heading',
          index: context.blocks.length,
          anchor: anchorFor(context, start, index),
          text: rawText(context, start, index),
          level: (setext[1] ?? '=').startsWith('=') ? 1 : 2,
          title,
          slug: uniqueSlug(context, title),
        });
        return index + 1;
      }
    }
    end = index;
  }

  push(context, {
    kind: 'paragraph',
    index: context.blocks.length,
    anchor: anchorFor(context, start, end),
    text: rawText(context, start, end),
  });
  return end + 1;
}

function push(context: ScanContext, block: Block): void {
  context.blocks.push(block);
}

/* ------------------------------------------------------------------------- */
/* Sections                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Builds the heading tree.
 *
 * Level jumps are tolerated rather than corrected: a document that goes from `#` to
 * `###` nests under the `#`, because reporting a structural complaint about someone's
 * heading levels is not this scanner's job and rejecting the document would be worse.
 */
function buildSections(context: ScanContext): Section[] {
  const headings = context.blocks.filter((block): block is HeadingBlock => block.kind === 'heading');
  if (headings.length === 0) return [];

  const roots: Section[] = [];
  const stack: { section: MutableSection; level: number }[] = [];

  for (let position = 0; position < headings.length; position += 1) {
    const heading = headings[position];
    if (heading === undefined) continue;

    const nextHeading = headings[position + 1];
    const lastBlockIndex = nextHeading === undefined ? context.blocks.length - 1 : nextHeading.index - 1;
    const lastBlock = context.blocks[Math.max(lastBlockIndex, heading.index)];

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.level >= heading.level) stack.pop();
      else break;
    }

    const parent = stack[stack.length - 1];
    const titlePath = [...(parent?.section.titlePath ?? []), heading.title];
    const idPath = [...(parent?.section.idPath ?? []), heading.slug];

    const section: MutableSection = {
      id: idPath.join('/'),
      idPath,
      level: heading.level,
      title: heading.title,
      titlePath,
      headingIndex: heading.index,
      anchor: {
        documentPath: heading.anchor.documentPath,
        documentHash: heading.anchor.documentHash,
        startLine: heading.anchor.startLine,
        endLine: lastBlock?.anchor.endLine ?? heading.anchor.endLine,
        startByte: heading.anchor.startByte,
        endByte: lastBlock?.anchor.endByte ?? heading.anchor.endByte,
      },
      blockRange: [heading.index, Math.max(lastBlockIndex, heading.index)],
      children: [],
    };

    if (parent === undefined) roots.push(section as Section);
    else parent.section.children.push(section as Section);

    stack.push({ section, level: heading.level });
  }

  return roots;
}

interface MutableSection {
  readonly id: string;
  readonly idPath: string[];
  readonly level: number;
  readonly title: string;
  readonly titlePath: string[];
  readonly headingIndex: number;
  readonly anchor: SourceAnchor;
  readonly blockRange: readonly [number, number];
  readonly children: Section[];
}

/* ------------------------------------------------------------------------- */
/* References                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Finds mentions of other documents.
 *
 * Code blocks are skipped: a path inside a sample command is an illustration, not a
 * dependency, and treating it as one fills the missing-source registry with noise that
 * teaches the operator to ignore it.
 */
function collectReferences(context: ScanContext): DocumentReference[] {
  const references: DocumentReference[] = [];
  const seen = new Set<string>();

  for (const block of context.blocks) {
    if (block.kind === 'code' || block.kind === 'frontmatter') continue;

    for (let offset = 0; offset <= block.anchor.endLine - block.anchor.startLine; offset += 1) {
      const lineIndex = block.anchor.startLine - 1 + offset;
      const line = context.lines[lineIndex];
      if (line === undefined) continue;

      const anchor: SourceAnchor = {
        documentPath: context.path,
        documentHash: context.hash,
        startLine: line.number,
        endLine: line.number,
        startByte: line.startByte,
        endByte: line.contentEndByte,
      };

      addMatches(references, seen, MARKDOWN_LINK, line.text, 'link', anchor);
      addMatches(references, seen, INLINE_CODE_DOCUMENT, line.text, 'inlineCode', anchor);
      addMatches(references, seen, BARE_DOCUMENT, line.text, 'bareMention', anchor);
    }
  }

  return references;
}

function addMatches(
  references: DocumentReference[],
  seen: Set<string>,
  pattern: RegExp,
  text: string,
  kind: ReferenceKind,
  anchor: SourceAnchor,
): void {
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) break;

    const target = match[1];
    if (target === undefined || target.startsWith('#') || /^[a-z]+:\/\//i.test(target)) continue;

    const key = `${target}@${anchor.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);

    references.push({ target, kind, anchor, context: text.trim() });
  }
}

/* ------------------------------------------------------------------------- */
/* Slugs                                                                      */
/* ------------------------------------------------------------------------- */

/** Stable, collision-free heading identifiers within one document. */
function uniqueSlug(context: ScanContext, title: string): string {
  const base = slugify(title);
  const used = context.slugs.get(base) ?? 0;
  context.slugs.set(base, used + 1);
  return used === 0 ? base : `${base}-${used}`;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? 'section' : slug;
}
