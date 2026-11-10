/**
 * What differs between the saved Project Profile generation and the draft being edited.
 *
 * The state store keeps one `dirty` flag, which is enough to guard requests but tells an operator
 * nothing about what would be saved. This module answers that question from the two documents
 * themselves: it never stores anything, and an empty result means the draft and the saved
 * generation are identical however the operator got there.
 */

import { FIELD_CATALOGUE } from './sectionRegistry.js';

const SECTION_PREFIXES = Object.freeze([
  ['authority', 'project-authority'],
  ['recognition', 'recognition'],
  ['benchmarkRuntime', 'benchmark-runtime'],
  ['integrations.powershell', 'powershell-host'],
  ['integrations.git', 'git'],
  ['integrations.chrome', 'browser'],
  ['integrations.gpt', 'gpt-gateway'],
]);

const LABELS = new Map(FIELD_CATALOGUE.map((entry) => [entry.path, entry.label]));

/** The Configuration section that owns one profile path. */
export function sectionOfPath(path) {
  const text = String(path ?? '');
  for (const [prefix, section] of SECTION_PREFIXES) {
    if (text === prefix || text.startsWith(`${prefix}.`)) return section;
  }
  return 'project';
}

/** A readable name for one profile path; an uncatalogued path is humanised, never hidden. */
export function labelOfPath(path) {
  const text = String(path ?? '');
  if (LABELS.has(text)) return LABELS.get(text);
  const last = text.split('.').at(-1) ?? text;
  const words = last.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[._-]+/gu, ' ').trim();
  return words === '' ? text : words.charAt(0).toUpperCase() + words.slice(1);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Values the operator edits as one thing are compared as one thing: lists, an inherited
 * setting (default or custom), a governed-document binding, and the benchmark resolution.
 */
function isLeaf(path, value) {
  if (!isPlainObject(value)) return true;
  if (typeof value.source === 'string' && Object.hasOwn(value, 'defaultKey')) return true;
  if (typeof value.bindingId === 'string') return true;
  return path === 'benchmarkRuntime.resolution';
}

function flatten(value, path, out) {
  if (path !== '' && isLeaf(path, value)) {
    out.set(path, value);
    return out;
  }
  if (!isPlainObject(value)) return out;
  for (const key of Object.keys(value)) flatten(value[key], path === '' ? key : `${path}.${key}`, out);
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Structural equality that ignores key order, so a re-serialised profile is not a change. */
export function sameValue(left, right) {
  return stable(left) === stable(right);
}

function clip(text, size = 96) {
  const value = String(text);
  return value.length > size ? `${value.slice(0, size - 1)}…` : value;
}

/** A short, honest rendering of one profile value for a before/after comparison. */
export function formatValue(value) {
  if (value === undefined) return 'not set';
  if (value === null || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    if (value.every((entry) => typeof entry === 'string')) return clip(value.join(', '));
    return `${value.length} item${value.length === 1 ? '' : 's'}`;
  }
  if (isPlainObject(value)) {
    if (typeof value.source === 'string' && Object.hasOwn(value, 'defaultKey')) {
      return value.source === 'project-override' ? `custom: ${clip(value.value ?? '', 80)}` : 'installation default';
    }
    if (typeof value.bindingId === 'string') {
      return `${clip(value.path ?? value.bindingId, 64)} · ${String(value.sha256 ?? '').slice(0, 12)}`;
    }
    if (Object.hasOwn(value, 'width') || Object.hasOwn(value, 'height')) {
      return `${value.width ?? '?'} × ${value.height ?? '?'}`;
    }
  }
  return clip(stable(value));
}

/**
 * Lists every difference between the saved profile and the draft.
 *
 * @param {object|null|undefined} saved  the durable generation's profile
 * @param {object|null|undefined} draft  the editable draft
 * @returns {{path:string, section:string, label:string, before:unknown, after:unknown, beforeText:string, afterText:string}[]}
 */
export function draftChanges(saved, draft) {
  if (!isPlainObject(saved) || !isPlainObject(draft)) return [];
  const before = flatten(saved, '', new Map());
  const after = flatten(draft, '', new Map());
  const changes = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(path);
    const right = after.get(path);
    if (sameValue(left, right)) continue;
    changes.push({
      path,
      section: sectionOfPath(path),
      label: labelOfPath(path),
      before: left,
      after: right,
      beforeText: formatValue(left),
      afterText: formatValue(right),
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

/** The sections that contain at least one unsaved change, in first-seen order. */
export function changedSections(changes) {
  return [...new Set((Array.isArray(changes) ? changes : []).map((change) => change.section))];
}
