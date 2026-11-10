import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { looksLikeSecretValue } from '../shared/secretSafety.js';

export const COMMANDER_ID = 'clue';
export const OPERATOR_KEY_REFERENCE = 'env:CLUE_AGENT_OPENAI_API_KEY';
export const IDENTITY_MAX_BYTES = 64 * 1024;
const frontMatter = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u;

const schema = z.object({
  schema: z.literal('clue.agent.identity/1'),
  id: z.literal(COMMANDER_ID),
  name: z.string().trim().min(1).max(40),
  kind: z.literal('commander'),
  version: z.number().int().min(1).max(1_000_000),
  brain: z.object({
    provider: z.literal('openai'),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).nullable(),
    credential: z.string().max(200),
    fallback: z.literal('FORBID'),
  }).strict(),
  limits: z.object({ max_output_tokens_per_step: z.number().int().min(256).max(4096) }).strict(),
  commands: z.array(z.never()).max(0),
  knowledge: z.tuple([z.literal('dashboard_status')]),
}).strict();

export interface IdentityProblem {
  readonly path: string;
  readonly message: string;
}

export type AgentIdentity = z.infer<typeof schema> & {
  readonly body: string;
  readonly hash: string;
};

export type IdentityParse =
  | { readonly ok: true; readonly identity: AgentIdentity }
  | { readonly ok: false; readonly problems: readonly IdentityProblem[] };

export function identityRefused(path: string, message: string): Extract<IdentityParse, { ok: false }> {
  return { ok: false, problems: [{ path, message }] };
}

export function identityHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalise(text: string): string {
  return text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}

export function parseIdentity(text: string, profileCredential: string | null, redact: (text: string) => string): IdentityParse {
  if (Buffer.byteLength(text, 'utf8') > IDENTITY_MAX_BYTES) {
    return identityRefused('document', 'The identity exceeds 64 KiB.');
  }
  if (looksLikeSecretValue(text) || redact(text) !== text) {
    return identityRefused('document', 'Use a credential reference and remove secret material from the identity.');
  }
  const match = frontMatter.exec(normalise(text));
  if (match === null) return identityRefused('front matter', 'Start the document with a YAML block between --- lines.');
  let input: unknown;
  try {
    input = parseYaml(match[1] ?? '', { maxAliasCount: 0 });
  } catch {
    return identityRefused('front matter', 'The YAML header could not be parsed.');
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        path: ['front matter', ...issue.path.map(String)].join('.'),
        message: 'The field does not match the supported operator identity settings.',
      })),
    };
  }
  if (parsed.data.brain.credential !== OPERATOR_KEY_REFERENCE && parsed.data.brain.credential !== profileCredential) {
    return identityRefused('front matter.brain.credential', 'Use env:CLUE_AGENT_OPENAI_API_KEY or the active profile credential reference.');
  }
  const body = (match[2] ?? '').trim();
  if (body.length < 1 || body.length > 16_000) return identityRefused('body', 'Provide identity text of 1–16,000 characters.');
  if (!/^version:[ \t]*[0-9]+[ \t]*$/mu.test(match[1] ?? '')) {
    return identityRefused('front matter.version', 'Keep a top-level version line. CLU-E assigns the version when saving.');
  }
  return { ok: true, identity: { ...parsed.data, body, hash: identityHash(text) } };
}

export function stampIdentity(text: string, version: number): string {
  // The caller validates the YAML and version line before stamping. Preserve all body delimiters.
  const match = frontMatter.exec(normalise(text));
  if (match === null) throw new Error('Identity front matter is invalid.');
  const front = (match[1] ?? '').replace(/^version:[ \t]*[0-9]+[ \t]*$/mu, `version: ${version}`);
  return `---\n${front}\n---\n${(match[2] ?? '').trim()}\n`;
}
