/** Lists provider-visible GPT text model IDs. This metadata call never sends an inference request. */

import { z } from 'zod';

import { readOpenAiJson, type GatewayFetch } from './openaiAdapter.js';

export const OPENAI_OFFICIAL_API_BASE = 'https://api.openai.com/v1';

const catalogueSchema = z.object({
  object: z.literal('list'),
  data: z.array(z.object({ id: z.string() })).max(4096),
});

// The models list supplies identity and availability, not inference compatibility.
// Only recognize general GPT text families here, including dated snapshots.
const generalGptModels = new Set([
  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro', 'gpt-5.1',
  'gpt-5.2', 'gpt-5.2-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4-pro',
  'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra',
]);

export type OpenAiModelCatalogueState =
  | 'READY'
  | 'EMPTY'
  | 'AUTH_REFUSED'
  | 'RATE_LIMITED'
  | 'PROVIDER_REFUSED'
  | 'PROVIDER_UNREACHABLE'
  | 'CATALOGUE_INVALID';

export interface OpenAiModelCatalogue {
  readonly state: OpenAiModelCatalogueState;
  readonly models: readonly string[];
}

function unavailable(state: Exclude<OpenAiModelCatalogueState, 'READY'>): OpenAiModelCatalogue {
  return { state, models: [] };
}

export async function listOpenAiModels(
  credential: string,
  fetchImpl: GatewayFetch = fetch,
): Promise<OpenAiModelCatalogue> {
  const url = `${OPENAI_OFFICIAL_API_BASE}/models`;
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
  } catch {
    return unavailable('PROVIDER_UNREACHABLE');
  }
  if (response.redirected || (response.url !== '' && response.url !== url) || !response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) return unavailable('AUTH_REFUSED');
    if (response.status === 429) return unavailable('RATE_LIMITED');
    return unavailable(response.status >= 500 ? 'PROVIDER_UNREACHABLE' : 'PROVIDER_REFUSED');
  }
  try {
    const body = catalogueSchema.safeParse(await readOpenAiJson(response, 1024 * 1024));
    if (!body.success) return unavailable('CATALOGUE_INVALID');
    const models = [...new Set(
      body.data.data
        .map(({ id }) => id)
        .filter((id) => !id.includes(credential) && generalGptModels.has(id.replace(/-\d{4}-\d{2}-\d{2}$/u, ''))),
    )].sort();
    if (models.length > 256) return unavailable('CATALOGUE_INVALID');
    return { state: models.length === 0 ? 'EMPTY' : 'READY', models };
  } catch {
    void response.body?.cancel().catch(() => {});
    return unavailable(signal.aborted ? 'PROVIDER_UNREACHABLE' : 'CATALOGUE_INVALID');
  }
}
