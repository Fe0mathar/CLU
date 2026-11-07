/** Secret detection and redaction shared by Project Profiles, browser evidence and GPT readiness. */

const CREDENTIAL_REFERENCE = /^(?:env:[A-Z][A-Z0-9_]{0,63}|credential-store:[A-Za-z0-9][A-Za-z0-9._:/-]{0,191})$/u;
const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|authorization|bearer|cookie|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/iu;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/gu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu;
const ASSIGNMENT = /\b(?:api[_-]?key|authorization|password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/giu;
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u;

export interface SecretMaterialFinding {
  readonly path: string;
  readonly reason: string;
}

export class SecretMaterialError extends Error {
  public readonly code = 'SECRET_MATERIAL_FORBIDDEN' as const;
  public readonly path: string;

  public constructor(label: string, finding: SecretMaterialFinding) {
    super(`${label} contains forbidden secret material at ${finding.path}: ${finding.reason}.`);
    this.name = 'SecretMaterialError';
    this.path = finding.path;
  }
}

export function isCredentialReference(value: string): boolean {
  return CREDENTIAL_REFERENCE.test(value);
}

function matches(pattern: RegExp, value: string): boolean {
  // OPENAI_KEY/BEARER/ASSIGNMENT are global because redaction must replace every occurrence.
  // RegExp.test() on a global expression is stateful, so reset lastIndex on both sides to keep
  // repeated safety checks deterministic.
  pattern.lastIndex = 0;
  const found = pattern.test(value);
  pattern.lastIndex = 0;
  return found;
}

export function looksLikeSecretValue(value: string): boolean {
  if (isCredentialReference(value)) return false;
  return (
    matches(OPENAI_KEY, value) ||
    matches(BEARER, value) ||
    matches(ASSIGNMENT, value) ||
    matches(PRIVATE_KEY, value)
  );
}

function pathText(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join('.');
}

export function findSecretMaterial(
  value: unknown,
  path: readonly string[] = [],
): SecretMaterialFinding | null {
  if (typeof value === 'string') {
    return looksLikeSecretValue(value)
      ? { path: pathText(path), reason: 'secret-shaped value' }
      : null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const finding = findSecretMaterial(value[index], [...path, String(index)]);
      if (finding !== null) return finding;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (SECRET_KEY.test(key) && key !== 'credentialReference' && key !== 'credential') {
      if (typeof child === 'string' && isCredentialReference(child)) continue;
      if (child !== null && child !== undefined && child !== false && child !== '') {
        return { path: pathText(childPath), reason: 'secret-shaped field name' };
      }
    }
    const finding = findSecretMaterial(child, childPath);
    if (finding !== null) return finding;
  }
  return null;
}

export function assertNoSecretMaterial(value: unknown, label = 'value'): void {
  const finding = findSecretMaterial(value);
  if (finding !== null) throw new SecretMaterialError(label, finding);
}

export interface RedactedSecretText {
  readonly text: string;
  readonly redacted: boolean;
}

export function redactSecretText(input: string): RedactedSecretText {
  let text = input;
  text = text.replace(OPENAI_KEY, '[REDACTED]');
  text = text.replace(BEARER, 'Bearer [REDACTED]');
  text = text.replace(ASSIGNMENT, '[REDACTED CREDENTIAL]');
  if (PRIVATE_KEY.test(text)) text = '[REDACTED PRIVATE KEY MATERIAL]';
  return { text, redacted: text !== input };
}
