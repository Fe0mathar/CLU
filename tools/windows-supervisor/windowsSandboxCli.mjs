const MAX_OUTPUT_BYTES = 16_384;
const MAX_SESSIONS = 128;
const GUID_PATTERN = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const GUID = new RegExp('^' + GUID_PATTERN + '$', 'iu');
const START_LINE = new RegExp(
  '^(?:Windows Sandbox environment started successfully:\\r?\\n)?Id:[ \\t]+(' + GUID_PATTERN + ')$',
  'iu',
);

function boundedText(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_OUTPUT_BYTES
    ? value.trim()
    : null;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sandboxId(value) {
  if (typeof value !== 'string' || !GUID.test(value)) return null;
  return value.toLowerCase();
}

export function parseWindowsSandboxInventory(text) {
  const raw = boundedText(text);
  if (!raw) throw new Error('WSB_INVENTORY_INVALID');

  let response;
  try {
    response = JSON.parse(raw);
  } catch {
    throw new Error('WSB_INVENTORY_INVALID');
  }
  const environments = response?.WindowsSandboxEnvironments;
  if (!record(response) || !Array.isArray(environments) || environments.length > MAX_SESSIONS) {
    throw new Error('WSB_INVENTORY_INVALID');
  }

  const ids = new Set();
  for (const environment of environments) {
    const id = record(environment) ? sandboxId(environment.Id) : null;
    if (id === null || ids.has(id)) throw new Error('WSB_INVENTORY_INVALID');
    ids.add(id);
  }
  return [...ids];
}

// The start text is corroboration. The caller still confirms ownership in the inventory.
export function parseWindowsSandboxStartId(text) {
  const raw = boundedText(text);
  if (!raw) return null;

  const plain = START_LINE.exec(raw);
  if (plain !== null) return sandboxId(plain[1]);

  try {
    const response = JSON.parse(raw);
    if (!record(response)) return null;
    if (Object.hasOwn(response, 'Id')) {
      return Object.hasOwn(response, 'WindowsSandboxEnvironment') ? null : sandboxId(response.Id);
    }
    const environment = response.WindowsSandboxEnvironment;
    return record(environment) ? sandboxId(environment.Id) : null;
  } catch {
    return null;
  }
}
