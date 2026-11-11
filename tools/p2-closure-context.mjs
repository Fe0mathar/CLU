/** Read the active target and exact P2 policy without initializing a workspace or contacting providers. */
export async function readP2ClosureContext(repoRoot) {
  const [runtime, startup, binding, closure, gateway, target] = await Promise.all([
    import('../dist/src/control/runtime.js'),
    import('../dist/src/control/projectProfiles/projectProfileStartup.js'),
    import('../dist/src/control/projectProfiles/projectRuntimeBinding.js'),
    import('../dist/src/control/p2ClosurePolicy.js'),
    import('../dist/src/ai/gateway/policy.js'),
    import('../dist/src/shared/targetPublication.js'),
  ]);
  const legacy = runtime.loadLegacyConfig(repoRoot);
  // Read the active generation without registry recovery or workspace initialization.
  const profile = startup.readActiveProjectProfileForBenchmark(repoRoot);
  const config = profile === null ? legacy : binding.resolveProjectRuntimeBinding(legacy, profile).config;
  const { policy, sha256: policySha256 } = closure.readP2ClosurePolicy(repoRoot);

  const installed = gateway.loadGatewayPolicies(repoRoot, config);
  const profileGpt = profile?.profile.integrations.gpt;
  const modelId = profileGpt?.modelId;
  const policies = modelId ? gateway.bindProjectGatewayModel(installed, modelId) : installed;
  const enabledRoutes = Object.values(policies.routing.routes).filter((route) => route.enabled);
  const approvedModel = policy.gateway.model;
  const exactModelPolicy = policy.gateway.decision === 'OPERATIONAL' &&
    closure.P2_EXACT_OPENAI_MODELS.includes(approvedModel) && config.gateway.enabled &&
    enabledRoutes.length > 0 && enabledRoutes.every((route) => route.model === approvedModel) &&
    (profile === null || (modelId === approvedModel && profileGpt.fallbackPolicy === 'FORBID'));

  const credentialReference = profileGpt?.credential.source === 'project-override'
    ? profileGpt.credential.value : `env:${config.gateway.api_key_env}`;
  const environmentKey = credentialReference.startsWith('env:') ? credentialReference.slice(4) : null;
  const publication = target.describeTargetPublication(
    config.project.remote, config.project.credential_env, config.project.remote_decision,
  );
  const intendedPublication = policy.publication?.decision ?? 'NO_REMOTE_YET';

  return {
    config,
    profile,
    policySha256,
    gateway: {
      provider: config.gateway.provider,
      requestedModels: [...new Set(enabledRoutes.map((route) => route.model).filter(Boolean))],
      approvedModel,
      exactModelPolicy,
      apiKeyReference: credentialReference,
      apiKeyPresent: environmentKey !== null && Boolean(process.env[environmentKey]?.trim()),
      credentialReferenceConfigured: Boolean(credentialReference),
      credentialCheck: profile === null ? 'ENVIRONMENT_PRESENCE_ONLY' : 'LIVE_PROFILE_CHECK_REQUIRED',
      spendAuthority: policies.budget.spend_authority,
    },
    publication: {
      intendedState: intendedPublication,
      observedState: publication.decision,
      localOnly: publication.localOnly,
      publicationPermitted: publication.publicationPermitted,
      matchesPolicy: closure.matchesP2Publication(intendedPublication, publication),
    },
  };
}
