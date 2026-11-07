/**
 * Pure resolver for Q1 SURF physical identity → semantic Navigator file scope.
 * It never classifies or guesses from a basename. Resolution is limited to explicit
 * semantic ids and the exact repository-relative path carried by the physical record.
 */

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function toFileAncestor(model, node) {
  let current = node;
  while (current && current.granularity !== 'file' && current.parentId) {
    current = model.getNode(current.parentId);
  }
  return current?.granularity === 'file' ? current : null;
}

function nodeBelongsToPath(model, node, expectedPath) {
  if (!node) return false;
  for (const logicalId of node.sourceLogicalIds ?? []) {
    const unit = model.rawUnits.get(logicalId);
    if (unit && normalizePath(unit.modulePath ?? unit.anchor?.path ?? '') === expectedPath) {
      return true;
    }
  }
  return false;
}

export function validateFileDiveContext(context = {}) {
  const fileLocationId = typeof context.fileLocationId === 'string'
    ? context.fileLocationId.trim() : '';
  const fileVersionId = typeof context.fileVersionId === 'string'
    ? context.fileVersionId.trim() : '';
  const path = typeof context.path === 'string' ? normalizePath(context.path) : '';
  if (fileLocationId === '' || fileVersionId === '' || path === '') {
    return {
      ok: false,
      reason: 'fileLocationId, fileVersionId and path are required',
      context: { ...context, fileLocationId, fileVersionId, path },
    };
  }
  return { ok: true, context: { ...context, fileLocationId, fileVersionId, path } };
}

export function resolveSemanticFileNode(model, context = {}) {
  const validation = validateFileDiveContext(context);
  if (!validation.ok) return { ...validation, node: null };
  const normalized = validation.context;
  const requestedIds = [
    normalized.preferredSemanticRootId,
    ...(Array.isArray(normalized.semanticMembershipIds)
      ? normalized.semanticMembershipIds : []),
  ].filter((value) => typeof value === 'string' && value.length > 0);

  let node = null;
  for (const id of requestedIds) {
    const candidate = model.getNode(id) ?? model.getNode(model.sourceToDisplay.get(id));
    const fileCandidate = toFileAncestor(model, candidate);
    if (fileCandidate && nodeBelongsToPath(model, fileCandidate, normalized.path)) {
      node = fileCandidate;
      break;
    }
  }

  if (!node) {
    const matchingUnits = [...model.rawUnits.values()]
      .filter((unit) => normalizePath(unit.modulePath ?? unit.anchor?.path ?? '') === normalized.path)
      .sort((left, right) => {
        const leftModule = left.kind === 'module' ? 0 : 1;
        const rightModule = right.kind === 'module' ? 0 : 1;
        return leftModule - rightModule || left.logicalId.localeCompare(right.logicalId);
      });
    const logicalId = matchingUnits[0]?.logicalId;
    const candidate = logicalId === undefined ? null : model.getNode(model.sourceToDisplay.get(logicalId));
    node = toFileAncestor(model, candidate);
  }

  if (!node || !nodeBelongsToPath(model, node, normalized.path)) {
    return { ok: false, context: normalized, node: null, reason: `no semantic source anchor for ${normalized.path}` };
  }
  return { ok: true, context: normalized, node, reason: null };
}
