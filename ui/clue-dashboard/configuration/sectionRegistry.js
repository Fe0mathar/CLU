/**
 * The Configuration information architecture: one list of sections, one list of fields.
 *
 * Navigation, search, the unsaved-changes review and the overview checklist all read this file, so
 * a section has one name and one description everywhere it appears. It is data only — it renders
 * nothing and reads no state.
 *
 * `id` is the `data-section` value of the card that renders the section. The ribbon focuses those
 * ids (see CAPABILITY_SECTIONS), so they are a contract and are never renamed here.
 */

export const SECTION_GROUPS = Object.freeze([
  Object.freeze({ id: 'profile', label: 'This profile' }),
  Object.freeze({ id: 'connections', label: 'Connections' }),
  Object.freeze({ id: 'checks', label: 'Checks' }),
  Object.freeze({ id: 'installation', label: 'Dashboard & installation' }),
]);

const section = (value) => Object.freeze({ legacyOnly: false, keywords: Object.freeze([]), ...value });

export const SECTIONS = Object.freeze([
  section({
    id: 'overview', group: 'profile', label: 'Overview',
    summary: 'Health of the profile you are editing, the next step, and its lifecycle actions.',
    keywords: Object.freeze(['summary', 'status', 'validate', 'activate', 'delete', 'checklist', 'next step']),
  }),
  section({
    id: 'project', group: 'profile', label: 'Project & paths',
    summary: 'The name of the target and the three folders CLU-E works in.',
    keywords: Object.freeze(['name', 'folder', 'directory', 'target', 'workspace', 'shadow', 'identity', 'new profile', 'create']),
  }),
  section({
    id: 'project-authority', group: 'profile', label: 'Governing documents',
    summary: 'The Markdown files that define what the target is for and how it is measured.',
    keywords: Object.freeze(['authority', 'markdown', 'target description', 'master benchmark', 'intent', 'hash', 'drift', 'conflict']),
  }),
  section({
    id: 'recognition', group: 'profile', label: 'Code recognition',
    summary: 'Which folders CLU-E scans, what it skips, and how it reads the code.',
    keywords: Object.freeze(['scan', 'source', 'exclude', 'tsconfig', 'compiler', 'adapter', 'symlink', 'snapshot']),
  }),
  section({
    id: 'benchmark-runtime', group: 'profile', label: 'Benchmark runtime',
    summary: 'How the Master Benchmark is executed: command, repetitions and timeouts.',
    keywords: Object.freeze(['command', 'scenario', 'warm-up', 'repetitions', 'timeout', 'resolution', 'arguments']),
  }),
  section({
    id: 'powershell-host', group: 'connections', label: 'Console host',
    summary: 'The PowerShell host that runs commands for this profile.',
    keywords: Object.freeze(['powershell', 'pwsh', 'console', 'host script', 'executable', 'autonomous']),
  }),
  section({
    id: 'git', group: 'connections', label: 'Git & GitHub',
    summary: 'The local checkout and, optionally, the GitHub repository it publishes to.',
    keywords: Object.freeze(['repository', 'remote', 'branch', 'github', 'sign in', 'publication', 'sync', 'origin']),
  }),
  section({
    id: 'browser', group: 'connections', label: 'Test browser',
    summary: 'The dedicated Chrome window CLU-E drives for browser benchmarks.',
    keywords: Object.freeze(['chrome', 'webgpu', 'debugging port', 'origin', 'url', 'profile directory', 'canary']),
  }),
  section({
    id: 'gpt-gateway', group: 'connections', label: 'AI model',
    summary: 'The OpenAI key and the exact model this profile is allowed to use.',
    keywords: Object.freeze(['openai', 'gpt', 'api key', 'credential', 'model', 'gateway', 'provider']),
  }),
  section({
    id: 'project-readiness', group: 'checks', label: 'Readiness',
    summary: 'Whether this profile can run a specific kind of work, capability by capability.',
    keywords: Object.freeze(['ready', 'blockers', 'local proof', 'publication', 'capability', 'assess']),
  }),
  section({
    id: 'profiles', group: 'installation', label: 'All profiles',
    summary: 'Every registered profile and which one CLU-E is running.',
    keywords: Object.freeze(['list', 'registry', 'switch', 'running', 'active']),
  }),
  section({
    id: 'agents', group: 'installation', label: 'Agents',
    summary: 'Inspect and configure the CLUE operator agent used by the running dashboard.',
    keywords: Object.freeze(['operator agent', 'identity document', 'brain', 'model', 'conversation', 'halt', 'resume']),
  }),
  section({
    id: 'metric-catalogue', group: 'installation', label: 'Metric catalogue',
    summary: 'The measurement catalogue shared by every profile on this installation.',
    keywords: Object.freeze(['metrics', 'measurements', 'catalogue', 'import', 'json']),
  }),
  section({
    id: 'dashboard-layout', group: 'installation', label: 'Dashboard layout',
    summary: 'How the four quadrants are arranged in this browser window.',
    keywords: Object.freeze(['window', 'composition', 'fixed', 'dynamic', 'quadrants', 'drag', 'resize', 'arrange', 'panels']),
  }),
  section({
    id: 'installation', group: 'installation', label: 'Installation health',
    summary: 'Facts the running dashboard reports about itself.',
    keywords: Object.freeze(['workspace', 'tracked documents', 'graph', 'startable', 'runtime mode', 'registry root']),
  }),
  section({
    id: 'startup', group: 'installation', label: 'Startup mode', legacyOnly: true,
    summary: 'The dashboard is running a legacy target rather than a registry profile.',
    keywords: Object.freeze(['legacy', 'launcher', 'binding', 'CLUE-Dashboard.bat']),
  }),
]);

export const DEFAULT_SECTION = 'overview';

/** Ribbon capability → the section that configures it. A contract shared with the ribbon. */
export const CAPABILITY_SECTIONS = Object.freeze({
  git: 'git', ai: 'gpt-gateway', chrome: 'browser', console: 'powershell-host',
});

const field = (path, sectionId, label, keywords = []) => Object.freeze({ path, section: sectionId, label, keywords: Object.freeze(keywords) });

/** Every profile field an operator can see, with the label used for it everywhere. */
export const FIELD_CATALOGUE = Object.freeze([
  field('projectId', 'project', 'Project ID'),
  field('displayName', 'project', 'Display Name'),
  field('targetRoot', 'project', 'Target Root', ['repository folder']),
  field('targetRootIdentity', 'project', 'Target Root Identity'),
  field('workspaceRoot', 'project', 'Workspace Root', ['events', 'database']),
  field('shadowRoot', 'project', 'Shadow Root', ['clone', 'isolated copy']),

  field('authority.targetDescription', 'project-authority', 'Target Description'),
  field('authority.masterBenchmark', 'project-authority', 'Master Benchmark'),
  field('authority.projectIntent', 'project-authority', 'Project Intent'),
  field('authority.additionalDocuments', 'project-authority', 'Additional Governed Documents'),

  field('recognition.sourceRoots', 'recognition', 'Source Roots'),
  field('recognition.excludedPaths', 'recognition', 'Excluded Paths', ['ignore', 'skip']),
  field('recognition.buildConfig', 'recognition', 'Build / Compiler Config', ['tsconfig']),
  field('recognition.adapters', 'recognition', 'Adapters', ['typescript', 'javascript', 'wgsl']),
  field('recognition.policy.fullScanOnActivation', 'recognition', 'Full Scan on Activation'),
  field('recognition.policy.reuseUnchangedSnapshot', 'recognition', 'Reuse Unchanged Snapshot'),
  field('recognition.policy.followSymlinks', 'recognition', 'Follow Symlinks'),

  field('benchmarkRuntime.workingDirectory', 'benchmark-runtime', 'Working Directory'),
  field('benchmarkRuntime.command', 'benchmark-runtime', 'Benchmark Command'),
  field('benchmarkRuntime.scenario', 'benchmark-runtime', 'Scenario'),
  field('benchmarkRuntime.warmupRuns', 'benchmark-runtime', 'Warm-up Runs'),
  field('benchmarkRuntime.repetitions', 'benchmark-runtime', 'Repetitions'),
  field('benchmarkRuntime.timeoutSeconds', 'benchmark-runtime', 'Timeout Seconds'),
  field('benchmarkRuntime.targetUrl', 'benchmark-runtime', 'Target URL'),
  field('benchmarkRuntime.browserProfile', 'benchmark-runtime', 'Browser Profile'),
  field('benchmarkRuntime.resolution', 'benchmark-runtime', 'Resolution', ['width', 'height']),
  field('benchmarkRuntime.additionalRuntimeArgs', 'benchmark-runtime', 'Additional Runtime Args', ['flags']),

  field('integrations.powershell.executable', 'powershell-host', 'PowerShell Executable'),
  field('integrations.powershell.hostScript', 'powershell-host', 'Host Script'),
  field('integrations.powershell.autonomousProfile', 'powershell-host', 'Autonomous Profile', ['restricted', 'maintenance', 'disabled']),

  field('integrations.git.repositoryRoot', 'git', 'Local Checkout Path'),
  field('integrations.git.publicationMode', 'git', 'Publication Mode', ['NO_REMOTE_YET', 'LOCAL_ONLY', 'REMOTE_REGISTERED']),
  field('integrations.git.provider', 'git', 'Provider', ['github', 'gitlab', 'azure-devops']),
  field('integrations.git.remote', 'git', 'Remote', ['origin', 'url']),
  field('integrations.git.defaultBranch', 'git', 'Default Branch', ['main']),
  field('integrations.git.currentBasePin', 'git', 'Current Base Pin', ['commit']),
  field('integrations.git.protectedLandingPolicy', 'git', 'Protected / Landing Policy'),

  field('integrations.chrome.executable', 'browser', 'Chrome Executable'),
  field('integrations.chrome.launchMode', 'browser', 'Launch Mode', ['CLUE_MANAGED', 'ATTACH_TO_EXISTING']),
  field('integrations.chrome.remoteDebuggingPort', 'browser', 'Remote Debugging Port', ['9222']),
  field('integrations.chrome.dedicatedProfileDirectory', 'browser', 'Dedicated Profile Directory'),
  field('integrations.chrome.allowedOrigins', 'browser', 'Allowed Origins'),
  field('integrations.chrome.targetUrl', 'browser', 'Target URL'),
  field('integrations.chrome.targetSelectionRule', 'browser', 'Selection Rule'),

  field('integrations.gpt.enabled', 'gpt-gateway', 'AI Gateway Enabled'),
  field('integrations.gpt.modelId', 'gpt-gateway', 'Model ID'),
  field('integrations.gpt.credential', 'gpt-gateway', 'Credential Reference', ['api key', 'env', 'credential-store']),
  field('integrations.gpt.provider', 'gpt-gateway', 'Provider', ['openai']),
  field('integrations.gpt.fallbackPolicy', 'gpt-gateway', 'Fallback Policy', ['FORBID']),
]);

export function sectionById(id) {
  return SECTIONS.find((entry) => entry.id === id) ?? null;
}

/** The sections that exist for this snapshot: the legacy startup section appears only in legacy mode. */
export function visibleSections(snapshot) {
  const legacy = snapshot?.legacyConfiguration?.projectProfiles?.runtimeMode === 'legacy-v2';
  return SECTIONS.filter((entry) => !entry.legacyOnly || legacy);
}

function tokens(query) {
  return String(query ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token !== '');
}

function words(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word !== '');
}

/** A token matches text when some word of the text starts with it: "port" finds "Port", not "import". */
function matches(token, wordList) {
  return wordList.some((word) => word.startsWith(token));
}

/**
 * Finds the sections a search query refers to, with the field names that matched.
 *
 * An empty query matches every section and names no fields. Every token must match somewhere in
 * one section (its name, summary, keywords, or a field in it) for that section to be returned.
 *
 * @returns {{id:string, fields:string[]}[]}
 */
export function searchSections(query, sections = SECTIONS) {
  const wanted = tokens(query);
  if (wanted.length === 0) return sections.map((entry) => ({ id: entry.id, fields: [] }));
  const results = [];
  for (const entry of sections) {
    const own = words([entry.label, entry.summary, ...entry.keywords].join(' '));
    const fields = FIELD_CATALOGUE
      .filter((candidate) => candidate.section === entry.id)
      .map((candidate) => ({ label: candidate.label, words: words([candidate.label, candidate.path.replace(/([a-z])([A-Z])/gu, '$1 $2'), ...candidate.keywords].join(' ')) }));
    const matchedFields = new Set();
    let all = true;
    for (const token of wanted) {
      let hit = matches(token, own);
      for (const candidate of fields) {
        if (matches(token, candidate.words)) {
          hit = true;
          matchedFields.add(candidate.label);
        }
      }
      if (!hit) {
        all = false;
        break;
      }
    }
    if (all) results.push({ id: entry.id, fields: [...matchedFields] });
  }
  return results;
}
