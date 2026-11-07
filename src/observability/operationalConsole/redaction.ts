/** Mandatory redaction before operational traffic reaches persistence or the UI. */

const SENSITIVE_FIELD =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|private[-_]?key|mnemonic|wallet[-_]?key)/i;

const INLINE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /(--(?:api[-_]?key|token|password|secret)\s+)("[^"]*"|'[^']*'|\S+)/gi,
  /("(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|private[-_]?key|mnemonic|wallet[-_]?key)"\s*:\s*)"[^"]*"/gi,
];

export interface RedactionResult {
  readonly text: string;
  readonly count: number;
}

export function redactOperationalText(
  input: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RedactionResult {
  let text = input;
  let count = 0;

  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value.length < 8 || !SENSITIVE_FIELD.test(name)) continue;
    const parts = text.split(value);
    if (parts.length > 1) {
      count += parts.length - 1;
      text = parts.join(`«REDACTED:${name}»`);
    }
  }

  for (const pattern of INLINE_PATTERNS) {
    text = text.replace(pattern, (_match: string, prefix?: string) => {
      count += 1;
      return prefix === undefined ? '«REDACTED»' : `${prefix}"«REDACTED»"`;
    });
  }

  return { text, count };
}
