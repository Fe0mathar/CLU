/**
 * Closed, typed dashboard action registry.
 *
 * Every browser operation is declared here with method, route shape and mutation authority. Project
 * Profile routes carry explicit Project ID parameters; no operation trusts the visible dropdown as
 * runtime identity. Request bodies are scanned before transport and may contain credential
 * references only — never secret bytes.
 */

const action = (value) => Object.freeze(value);

export const DASHBOARD_ACTIONS = Object.freeze({
  start: action({ method: 'POST', path: '/api/control/start', mutating: true, payload: 'none', description: 'Drive the governed cycle through recognition and screening.' }),
  refresh: action({ method: 'POST', path: '/api/control/refresh', mutating: true, payload: 'none', description: 'Re-derive the sealed frame from durable state.' }),
  syncGit: action({ method: 'POST', path: '/api/control/git-sync', mutating: true, payload: 'none', description: 'Run one explicit local-first Git sync; never coupled to Start or proof.' }),
  checkCapability: action({ method: 'POST', path: '/api/control/readiness', mutating: true, payload: 'json', description: 'Explicitly check one live capability. AI checks can consume provider usage.' }),
  runChromeTest: action({ method: 'POST', path: '/api/control/chrome-test', mutating: true, payload: 'json', description: 'Run the scripted Chrome canary for the active saved Project Profile generation.' }),
  runConsoleTest: action({ method: 'POST', path: '/api/control/console-test', mutating: true, payload: 'json', description: 'Run the scripted PowerShell host test for the active saved Project Profile generation.' }),
  readReadinessReceipts: action({ method: 'GET', path: '/api/control/readiness', mutating: false, payload: 'none', description: 'Read the previous AI and Git check timestamps for the active installation profile.' }),
  readLegacyOpenAiKey: action({ method: 'GET', path: '/api/control/legacy-openai-key', mutating: false, payload: 'none', description: 'Check whether the active legacy target has a saved credential.' }),
  setLegacyOpenAiKey: action({ method: 'POST', path: '/api/control/legacy-openai-key', mutating: true, payload: 'none', description: 'Open the native key prompt for the active legacy target.' }),
  signInLegacyGitHub: action({ method: 'POST', path: '/api/control/legacy-github-sign-in', mutating: true, payload: 'none', description: 'Open GitHub CLI sign-in for the local legacy dashboard.' }),
  talkToAgent: action({ method: 'POST', path: '/api/control/agent', mutating: true, payload: 'json', description: 'Ask the Master Agent about the active CLU-E runtime through the configured model gateway.' }),
  publishCatalogue: action({ method: 'POST', path: '/api/catalogues', mutating: true, payload: 'json', description: 'Publish a measurement catalogue to the server library.' }),
  readConfig: action({ method: 'GET', path: '/api/config', mutating: false, payload: 'none', description: 'Read operational configuration health.' }),
  readRun: action({ method: 'GET', path: '/api/run', mutating: false, payload: 'none', description: 'Read current run state.' }),
  listProjects: action({ method: 'GET', path: '/api/projects', mutating: false, payload: 'none', description: 'List registered Project Profiles and the active pointer.' }),
  readProject: action({ method: 'GET', path: '/api/projects/:projectId', params: ['projectId'], mutating: false, payload: 'request', body: false, description: 'Read one exact Project Profile record.' }),
  prepareProjectDraft: action({ method: 'POST', path: '/api/projects/prepare-draft', mutating: false, payload: 'json', description: 'Ask the backend to resolve physical identity and prepare a non-persistent strict profile draft.' }),
  prepareGovernedDocument: action({ method: 'POST', path: '/api/projects/prepare-document', mutating: false, payload: 'json', description: 'Ask the backend to resolve and SHA-256 bind one governed Markdown document.' }),
  createProject: action({ method: 'POST', path: '/api/projects', mutating: true, payload: 'json', description: 'Persist a new server-validated Project Profile.' }),
  updateProject: action({ method: 'PUT', path: '/api/projects/:projectId', params: ['projectId'], mutating: true, payload: 'request', body: true, description: 'Persist one successor Project Profile generation under an optimistic precondition.' }),
  deleteProject: action({ method: 'DELETE', path: '/api/projects/:projectId', params: ['projectId'], mutating: true, payload: 'request', body: true, description: 'Delete CLU-E profile/state metadata only; never the target repository.' }),
  activateProject: action({ method: 'POST', path: '/api/projects/:projectId/activate', params: ['projectId'], mutating: true, payload: 'request', body: true, description: 'Request an atomic runtime activation of one exact saved generation.' }),
  validateProject: action({ method: 'POST', path: '/api/projects/:projectId/validate', params: ['projectId'], mutating: false, payload: 'request', body: false, description: 'Validate the saved profile generation and live authority basis.' }),
  readProjectReadiness: action({ method: 'GET', path: '/api/projects/:projectId/readiness', params: ['projectId'], mutating: false, payload: 'request', body: false, description: 'Read operation-specific readiness for one exact Project Profile.' }),
  testProjectGit: action({ method: 'POST', path: '/api/projects/:projectId/test-git', params: ['projectId'], mutating: false, payload: 'request', body: false, description: 'Validate local Git repository and publication posture.' }),
  signInProjectGitHub: action({ method: 'POST', path: '/api/projects/:projectId/github-sign-in', params: ['projectId'], mutating: true, payload: 'request', body: false, description: 'Open GitHub CLI sign-in on the host.' }),
  listProjectGitHubRepositories: action({ method: 'GET', path: '/api/projects/:projectId/github-repositories', params: ['projectId'], mutating: false, payload: 'request', body: false, description: 'List repositories accessible to the authenticated GitHub account.' }),
  connectProjectGitHub: action({ method: 'POST', path: '/api/projects/:projectId/github-connect', params: ['projectId'], mutating: true, payload: 'request', body: true, description: 'Verify and register the selected GitHub checkout without synchronizing.' }),
  testProjectGpt: action({ method: 'POST', path: '/api/projects/:projectId/test-gpt', params: ['projectId'], mutating: false, payload: 'request', body: false, description: 'Test exact OpenAI provider/model readiness without exposing secret bytes.' }),
  listProjectGptModels: action({ method: 'GET', path: '/api/projects/:projectId/gpt/models', params: ['projectId'], mutating: false, payload: 'request', body: false, description: 'List model IDs available to the saved Project Profile credential.' }),
  readProjectOpenAiKey: action({ method: 'GET', path: '/api/projects/:projectId/openai-key', params: ['projectId'], mutating: false, payload: 'request', body: false, description: 'Check whether a project-scoped Windows credential is stored.' }),
  setProjectOpenAiKey: action({ method: 'POST', path: '/api/projects/:projectId/openai-key', params: ['projectId'], mutating: true, payload: 'request', body: true, description: 'Open a native Windows API key prompt without sending secret bytes from the browser.' }),
});

const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|authorization|bearer|cookie|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/iu;
const CREDENTIAL_REFERENCE = /^(?:env:[A-Z][A-Z0-9_]{0,63}|credential-store:[A-Za-z0-9][A-Za-z0-9._:/-]{0,191})$/u;
const SECRET_VALUE = /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|\b(?:api[_-]?key|authorization|password|passwd|secret|token)\s*[:=]\s*[^\s,;]+)/iu;

export function isCredentialReference(value) {
  return typeof value === 'string' && CREDENTIAL_REFERENCE.test(value);
}

function safeCredentialSetting(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.source === 'global-default') return typeof value.defaultKey === 'string' && value.value === null;
  return value.source === 'project-override' && typeof value.defaultKey === 'string' && isCredentialReference(value.value);
}

export function findCredentialLeak(value, path = '<root>') {
  if (typeof value === 'string') {
    if (isCredentialReference(value)) return null;
    return SECRET_VALUE.test(value) ? path : null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const leak = findCredentialLeak(value[index], `${path}.${index}`);
      if (leak !== null) return leak;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const here = path === '<root>' ? key : `${path}.${key}`;
    if (key === 'credential') {
      if (safeCredentialSetting(child)) continue;
      return here;
    }
    if (key === 'credentialReference') {
      if (isCredentialReference(child)) continue;
      return here;
    }
    if (SECRET_KEY.test(key) && child !== null && child !== undefined && child !== false && child !== '') return here;
    const leak = findCredentialLeak(child, here);
    if (leak !== null) return leak;
  }
  return null;
}

function asRequestInput(input) {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null;
}

function buildPath(actionSpec, params = {}) {
  let path = actionSpec.path;
  for (const name of actionSpec.params ?? []) {
    const raw = params[name];
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, reason: `route parameter ${name} is required` };
    }
    path = path.replace(`:${name}`, encodeURIComponent(raw));
  }
  return { ok: true, path };
}

function appendQuery(path, query) {
  if (!query || typeof query !== 'object') return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? path : `${path}?${encoded}`;
}

export function createActionClient(options) {
  const request = options.request;
  const allowMutating = options.allowMutating !== false;

  function actions() {
    return DASHBOARD_ACTIONS;
  }

  async function invoke(name, input, { signal } = {}) {
    const key = String(name);
    const actionSpec = Object.prototype.hasOwnProperty.call(DASHBOARD_ACTIONS, key)
      ? DASHBOARD_ACTIONS[key]
      : undefined;
    if (actionSpec === undefined) return { ok: false, refused: 'undeclared-action', reason: `"${key}" is not a declared dashboard action` };
    if (actionSpec.mutating && !allowMutating) return { ok: false, refused: 'read-only-client', reason: `"${key}" changes the workspace and this client is read-only` };
    if (actionSpec.payload === 'none' && input !== undefined) return { ok: false, refused: 'unexpected-payload', reason: `"${key}" declares no payload` };

    let params = {};
    let query = {};
    let payload;
    if (actionSpec.payload === 'json') {
      payload = input;
    } else if (actionSpec.payload === 'request') {
      const requestInput = asRequestInput(input);
      if (requestInput === null) return { ok: false, refused: 'invalid-request', reason: `"${key}" requires a request object` };
      params = requestInput.params ?? {};
      query = requestInput.query ?? {};
      payload = requestInput.payload;
      if (actionSpec.body === true && payload === undefined) return { ok: false, refused: 'missing-payload', reason: `"${key}" requires a JSON request body` };
      if (actionSpec.body === false && payload !== undefined) return { ok: false, refused: 'unexpected-payload', reason: `"${key}" declares no request body` };
    }

    const route = buildPath(actionSpec, params);
    if (!route.ok) return { ok: false, refused: 'invalid-route-parameters', reason: route.reason };
    const leak = findCredentialLeak({ params, query, payload });
    if (leak !== null) return { ok: false, refused: 'credential-in-payload', reason: `"${leak}" looks like secret material; only credential references may leave the Configuration UI` };

    try {
      const result = await request({
        method: actionSpec.method,
        path: appendQuery(route.path, query),
        ...(signal === undefined ? {} : { signal }),
        ...(payload === undefined ? {} : { payload }),
      });
      return { ok: true, action: key, result };
    } catch (error) {
      return {
        ok: false,
        refused: 'transport-failed',
        reason: error instanceof Error ? error.message : String(error),
        serverCode: typeof error?.code === 'string' ? error.code : null,
        serverDetails: error?.details && typeof error.details === 'object' ? error.details : null,
        error,
      };
    }
  }

  return Object.freeze({ invoke, actions, allowMutating });
}
