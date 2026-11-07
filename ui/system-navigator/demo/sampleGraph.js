const FILES = [
  ['src/core/render/BufferPool.ts', 'BufferPool', ['acquire', 'release', 'trim']],
  ['src/core/render/FramePipeline.ts', 'FramePipeline', ['prepare', 'upload', 'render']],
  ['src/core/world/World.ts', 'World', ['addObject', 'updateObject', 'toJSON']],
  ['src/core/npc/NpcSystem.ts', 'NpcSystem', ['tick', 'inform', 'setMovementConfig']],
  ['src/core/gameplay/InteractionSystem.ts', 'InteractionSystem', ['engage', 'request', 'complete']],
  ['src/core/render/gaussian/GaussianRenderer.ts', 'GaussianRenderer', ['load', 'sort', 'draw']],
];

export function buildSampleRecognition() {
  const units = [];
  const edges = [];
  for (const [path, className, methods] of FILES) {
    const moduleId = `${path}#${path}`;
    const classId = `${path}#${className}`;
    units.push(unit(moduleId, 'module', path.split('/').at(-1), path, null));
    units.push(unit(classId, 'class', className, path, moduleId));
    for (const method of methods) {
      units.push(unit(`${path}#${className}.${method}`, 'method', method, path, classId));
    }
  }
  const functions = units.filter((entry) => entry.kind === 'method');
  for (let index = 0; index < functions.length; index += 1) {
    const from = functions[index];
    const to = functions[(index * 5 + 3) % functions.length];
    if (from.logicalId !== to.logicalId) {
      edges.push({
        from: from.logicalId,
        to: to.logicalId,
        kind: index % 3 === 0 ? 'calls' : 'references',
        confidence: 1,
        external: false,
        anchor: from.anchor,
      });
    }
  }
  return {
    projectRoot: 'sample',
    tsconfigPath: 'sample/tsconfig.json',
    compilerOptionsHash: 'sample',
    units,
    edges,
    unresolved: [],
    stats: {
      filesInProgram: FILES.length,
      filesRecognised: FILES.length,
      unitsByKind: {},
      edgesByKind: {},
      unresolvedByKind: {},
      syntacticDiagnostics: 0,
      semanticDiagnostics: 0,
      elapsedMs: 23,
    },
  };
}

function unit(logicalId, kind, name, modulePath, parentLogicalId) {
  const qualifiedName = logicalId.split('#')[1] ?? name;
  return {
    logicalId,
    versionHash: 'sample',
    kind,
    name,
    qualifiedName,
    modulePath,
    exported: true,
    anchor: { path: modulePath, startLine: 1, endLine: 20, startByte: 0, endByte: 400 },
    parentLogicalId,
    lineCount: 20,
    byteLength: 400,
    isAsync: false,
    parameterCount: kind === 'method' ? 1 : null,
  };
}
