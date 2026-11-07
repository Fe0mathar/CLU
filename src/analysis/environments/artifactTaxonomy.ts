/**
 * Backend-owned physical artifact taxonomy for Q1 SURF.
 *
 * SURF renders repository truth; it is never allowed to infer technology families from
 * semantic recognition nodes. This module therefore owns the deterministic mapping from
 * one physical path to exactly one primary family and environment (or explicit unknown),
 * together with the presentation tokens the dashboard may render.
 */

import { extname } from 'node:path';
import { z } from 'zod';

import { hashCanonicalJson, type Sha256 } from '../../shared/ids.js';

export const ARTIFACT_TAXONOMY_VERSION = 'q1-artifact-taxonomy/1';
export const ARTIFACT_CLASSIFIER_VERSION = 'q1-artifact-classifier/1';

export const artifactFamilySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    order: z.number().int().nonnegative(),
    accentToken: z.string().min(1),
    patternToken: z.string().min(1),
    shapeToken: z.string().min(1),
    glyphId: z.string().min(1),
  })
  .strict();

export type ArtifactFamily = z.infer<typeof artifactFamilySchema>;

export const artifactEnvironmentSchema = z
  .object({
    id: z.string().min(1),
    familyId: z.string().min(1),
    label: z.string().min(1),
    shortLabel: z.string().min(1),
    glyphId: z.string().min(1),
    order: z.number().int().nonnegative(),
    adapterId: z.string().min(1).nullable(),
  })
  .strict();

export type ArtifactEnvironment = z.infer<typeof artifactEnvironmentSchema>;

export const artifactClassificationSchema = z
  .object({
    familyId: z.string().min(1),
    environmentId: z.string().min(1),
    physicalFormat: z.string().min(1),
    glyphId: z.string().min(1),
    facets: z.array(z.string().min(1)),
    source: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
    classifierVersion: z.string().min(1),
    adapterId: z.string().min(1).nullable(),
    adapterVersion: z.string().min(1).nullable(),
  })
  .strict();

export type ArtifactClassification = z.infer<typeof artifactClassificationSchema>;

export const artifactTaxonomySchema = z
  .object({
    taxonomyVersion: z.string().min(1),
    taxonomyHash: z.string().regex(/^[0-9a-f]{64}$/),
    classifierVersion: z.string().min(1),
    families: z.array(artifactFamilySchema).min(1),
    environments: z.array(artifactEnvironmentSchema).min(1),
  })
  .strict()
  .superRefine((taxonomy, context) => {
    const familyIds = new Set<string>();
    for (const [index, family] of taxonomy.families.entries()) {
      if (familyIds.has(family.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['families', index, 'id'],
          message: `duplicate artifact family id: ${family.id}`,
        });
      }
      familyIds.add(family.id);
    }
    const environmentIds = new Set<string>();
    for (const [index, environment] of taxonomy.environments.entries()) {
      if (environmentIds.has(environment.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['environments', index, 'id'],
          message: `duplicate artifact environment id: ${environment.id}`,
        });
      }
      environmentIds.add(environment.id);
      if (!familyIds.has(environment.familyId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['environments', index, 'familyId'],
          message: `unknown artifact family id: ${environment.familyId}`,
        });
      }
    }
    if (!familyIds.has('unknown') || !environmentIds.has('unknown')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'artifact taxonomy must declare explicit unknown family and environment',
      });
    }
  });

export type ArtifactTaxonomy = z.infer<typeof artifactTaxonomySchema>;

const FAMILIES: readonly ArtifactFamily[] = [
  { id: 'ecmascript', label: 'ECMASCRIPT / WEB RUNTIME', order: 0, accentToken: '#6677CC', patternToken: 'double', shapeToken: 'hex', glyphId: 'JS' },
  { id: 'python', label: 'PYTHON ECOSYSTEM', order: 1, accentToken: '#8BA6C9', patternToken: 'dotted', shapeToken: 'diamond', glyphId: 'PY' },
  { id: 'jvm', label: 'JVM ECOSYSTEM', order: 2, accentToken: '#B66A61', patternToken: 'ticks', shapeToken: 'triangle', glyphId: 'JVM' },
  { id: 'dotnet', label: '.NET ECOSYSTEM', order: 3, accentToken: '#8F70C9', patternToken: 'cross', shapeToken: 'square', glyphId: '.N' },
  { id: 'native-systems', label: 'NATIVE SYSTEMS', order: 4, accentToken: '#9AA5B1', patternToken: 'solid', shapeToken: 'octagon', glyphId: 'C' },
  { id: 'modern-systems', label: 'MODERN SYSTEMS', order: 5, accentToken: '#56AFA6', patternToken: 'chevron', shapeToken: 'chevron', glyphId: 'SYS' },
  { id: 'gpu-shader', label: 'GPU / SHADER', order: 6, accentToken: '#B56BD1', patternToken: 'wave', shapeToken: 'star', glyphId: 'GPU' },
  { id: 'shell-automation', label: 'SHELL / AUTOMATION', order: 7, accentToken: '#71A97C', patternToken: 'dashed', shapeToken: 'terminal', glyphId: '>_' },
  { id: 'data-query-bi', label: 'DATA / QUERY / BI', order: 8, accentToken: '#4BA6A0', patternToken: 'segmented', shapeToken: 'cylinder', glyphId: 'DB' },
  { id: 'web-presentation', label: 'WEB PRESENTATION', order: 9, accentToken: '#C98265', patternToken: 'angle', shapeToken: 'angle', glyphId: '</>' },
  { id: 'configuration', label: 'CONFIGURATION / SERIALIZATION', order: 10, accentToken: '#B8A15C', patternToken: 'braces', shapeToken: 'braces', glyphId: '{}' },
  { id: 'build-delivery-cloud', label: 'BUILD / DELIVERY / CLOUD', order: 11, accentToken: '#4F8F9E', patternToken: 'chain', shapeToken: 'cube', glyphId: 'CI' },
  { id: 'documentation', label: 'DOCUMENTATION / KNOWLEDGE', order: 12, accentToken: '#9A87B5', patternToken: 'ruled', shapeToken: 'page', glyphId: 'MD' },
  { id: 'binary-assets', label: 'BINARY / MEDIA / MODELS', order: 13, accentToken: '#737E8F', patternToken: 'square', shapeToken: 'diamond', glyphId: 'BIN' },
  { id: 'unknown', label: 'UNKNOWN / UNSUPPORTED', order: 14, accentToken: '#B95E70', patternToken: 'broken', shapeToken: 'broken', glyphId: '?' },
] as const;

const ENVIRONMENTS: readonly ArtifactEnvironment[] = [
  { id: 'typescript', familyId: 'ecmascript', label: 'TypeScript', shortLabel: 'TS', glyphId: 'TS', order: 0, adapterId: 'typescript-static' },
  { id: 'tsx', familyId: 'ecmascript', label: 'TypeScript JSX', shortLabel: 'TSX', glyphId: 'TSX', order: 1, adapterId: 'typescript-static' },
  { id: 'javascript', familyId: 'ecmascript', label: 'JavaScript', shortLabel: 'JS', glyphId: 'JS', order: 2, adapterId: 'typescript-static' },
  { id: 'jsx', familyId: 'ecmascript', label: 'JavaScript JSX', shortLabel: 'JSX', glyphId: 'JSX', order: 3, adapterId: 'typescript-static' },
  { id: 'python', familyId: 'python', label: 'Python', shortLabel: 'PY', glyphId: 'PY', order: 0, adapterId: null },
  { id: 'java', familyId: 'jvm', label: 'Java', shortLabel: 'JAVA', glyphId: 'JVM', order: 0, adapterId: null },
  { id: 'kotlin', familyId: 'jvm', label: 'Kotlin', shortLabel: 'KT', glyphId: 'KT', order: 1, adapterId: null },
  { id: 'scala', familyId: 'jvm', label: 'Scala', shortLabel: 'SCALA', glyphId: 'SC', order: 2, adapterId: null },
  { id: 'csharp', familyId: 'dotnet', label: 'C#', shortLabel: 'C#', glyphId: 'C#', order: 0, adapterId: null },
  { id: 'fsharp', familyId: 'dotnet', label: 'F#', shortLabel: 'F#', glyphId: 'F#', order: 1, adapterId: null },
  { id: 'visual-basic', familyId: 'dotnet', label: 'Visual Basic', shortLabel: 'VB', glyphId: 'VB', order: 2, adapterId: null },
  { id: 'c-cpp', familyId: 'native-systems', label: 'C / C++', shortLabel: 'C/C++', glyphId: 'C', order: 0, adapterId: null },
  { id: 'objective-c', familyId: 'native-systems', label: 'Objective-C', shortLabel: 'OBJC', glyphId: 'OC', order: 1, adapterId: null },
  { id: 'rust', familyId: 'modern-systems', label: 'Rust', shortLabel: 'RS', glyphId: 'RS', order: 0, adapterId: null },
  { id: 'go', familyId: 'modern-systems', label: 'Go', shortLabel: 'GO', glyphId: 'GO', order: 1, adapterId: null },
  { id: 'zig', familyId: 'modern-systems', label: 'Zig', shortLabel: 'ZIG', glyphId: 'ZIG', order: 2, adapterId: null },
  { id: 'swift', familyId: 'modern-systems', label: 'Swift', shortLabel: 'SWIFT', glyphId: 'SW', order: 3, adapterId: null },
  { id: 'wgsl', familyId: 'gpu-shader', label: 'WebGPU Shading Language', shortLabel: 'WGSL', glyphId: 'WGSL', order: 0, adapterId: null },
  { id: 'glsl', familyId: 'gpu-shader', label: 'OpenGL Shading Language', shortLabel: 'GLSL', glyphId: 'GLSL', order: 1, adapterId: null },
  { id: 'hlsl', familyId: 'gpu-shader', label: 'High-Level Shading Language', shortLabel: 'HLSL', glyphId: 'HLSL', order: 2, adapterId: null },
  { id: 'powershell', familyId: 'shell-automation', label: 'PowerShell', shortLabel: 'PS', glyphId: '>_', order: 0, adapterId: null },
  { id: 'shell', familyId: 'shell-automation', label: 'POSIX Shell', shortLabel: 'SH', glyphId: '$', order: 1, adapterId: null },
  { id: 'batch', familyId: 'shell-automation', label: 'Windows Batch', shortLabel: 'BAT', glyphId: 'BAT', order: 2, adapterId: null },
  { id: 'sql', familyId: 'data-query-bi', label: 'SQL', shortLabel: 'SQL', glyphId: 'SQL', order: 0, adapterId: null },
  { id: 'dax', familyId: 'data-query-bi', label: 'DAX', shortLabel: 'DAX', glyphId: 'DAX', order: 1, adapterId: null },
  { id: 'power-query', familyId: 'data-query-bi', label: 'Power Query M', shortLabel: 'M', glyphId: 'M', order: 2, adapterId: null },
  { id: 'kql', familyId: 'data-query-bi', label: 'Kusto Query Language', shortLabel: 'KQL', glyphId: 'KQL', order: 3, adapterId: null },
  { id: 'html', familyId: 'web-presentation', label: 'HTML', shortLabel: 'HTML', glyphId: '</>', order: 0, adapterId: null },
  { id: 'css', familyId: 'web-presentation', label: 'CSS', shortLabel: 'CSS', glyphId: 'CSS', order: 1, adapterId: null },
  { id: 'svg', familyId: 'web-presentation', label: 'SVG', shortLabel: 'SVG', glyphId: 'SVG', order: 2, adapterId: null },
  { id: 'json', familyId: 'configuration', label: 'JSON', shortLabel: 'JSON', glyphId: '{}', order: 0, adapterId: null },
  { id: 'yaml', familyId: 'configuration', label: 'YAML', shortLabel: 'YAML', glyphId: 'YML', order: 1, adapterId: null },
  { id: 'toml', familyId: 'configuration', label: 'TOML', shortLabel: 'TOML', glyphId: 'TOML', order: 2, adapterId: null },
  { id: 'xml', familyId: 'configuration', label: 'XML', shortLabel: 'XML', glyphId: 'XML', order: 3, adapterId: null },
  { id: 'ini', familyId: 'configuration', label: 'INI / Properties', shortLabel: 'INI', glyphId: 'INI', order: 4, adapterId: null },
  { id: 'docker', familyId: 'build-delivery-cloud', label: 'Docker', shortLabel: 'DOCKER', glyphId: 'BOX', order: 0, adapterId: null },
  { id: 'github-actions', familyId: 'build-delivery-cloud', label: 'GitHub Actions', shortLabel: 'GHA', glyphId: 'CI', order: 1, adapterId: null },
  { id: 'kubernetes', familyId: 'build-delivery-cloud', label: 'Kubernetes', shortLabel: 'K8S', glyphId: 'K8S', order: 2, adapterId: null },
  { id: 'terraform', familyId: 'build-delivery-cloud', label: 'Terraform', shortLabel: 'TF', glyphId: 'TF', order: 3, adapterId: null },
  { id: 'build-script', familyId: 'build-delivery-cloud', label: 'Build / Delivery Script', shortLabel: 'BUILD', glyphId: 'CI', order: 4, adapterId: null },
  { id: 'markdown', familyId: 'documentation', label: 'Markdown', shortLabel: 'MD', glyphId: 'MD', order: 0, adapterId: null },
  { id: 'text', familyId: 'documentation', label: 'Text / Knowledge', shortLabel: 'TXT', glyphId: 'TXT', order: 1, adapterId: null },
  { id: 'pdf', familyId: 'documentation', label: 'PDF Document', shortLabel: 'PDF', glyphId: 'PDF', order: 2, adapterId: null },
  { id: 'image', familyId: 'binary-assets', label: 'Image Asset', shortLabel: 'IMG', glyphId: 'IMG', order: 0, adapterId: null },
  { id: 'model-asset', familyId: 'binary-assets', label: '3D / Splat Asset', shortLabel: '3D', glyphId: '3D', order: 1, adapterId: null },
  { id: 'audio-video', familyId: 'binary-assets', label: 'Audio / Video Asset', shortLabel: 'AV', glyphId: 'AV', order: 2, adapterId: null },
  { id: 'archive', familyId: 'binary-assets', label: 'Archive', shortLabel: 'ZIP', glyphId: 'ZIP', order: 3, adapterId: null },
  { id: 'binary', familyId: 'binary-assets', label: 'Binary Artifact', shortLabel: 'BIN', glyphId: 'BIN', order: 4, adapterId: null },
  { id: 'unknown', familyId: 'unknown', label: 'Unknown / Unsupported', shortLabel: 'UNKNOWN', glyphId: '?', order: 0, adapterId: null },
] as const;

const ENVIRONMENT_BY_ID = new Map(ENVIRONMENTS.map((environment) => [environment.id, environment] as const));

const EXTENSION_TO_ENVIRONMENT: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.pyi': 'python', '.ipynb': 'python',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.cs': 'csharp', '.fs': 'fsharp', '.fsx': 'fsharp', '.vb': 'visual-basic',
  '.c': 'c-cpp', '.h': 'c-cpp', '.cc': 'c-cpp', '.cpp': 'c-cpp', '.cxx': 'c-cpp', '.hpp': 'c-cpp', '.hxx': 'c-cpp',
  '.m': 'objective-c', '.mm': 'objective-c',
  '.rs': 'rust', '.go': 'go', '.zig': 'zig', '.swift': 'swift',
  '.wgsl': 'wgsl', '.glsl': 'glsl', '.vert': 'glsl', '.frag': 'glsl', '.comp': 'glsl', '.hlsl': 'hlsl',
  '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.bat': 'batch', '.cmd': 'batch',
  '.sql': 'sql', '.dax': 'dax', '.pq': 'power-query', '.mquery': 'power-query', '.kql': 'kql',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css', '.svg': 'svg',
  '.json': 'json', '.json5': 'json', '.jsonc': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.ini': 'ini', '.properties': 'ini', '.cfg': 'ini', '.conf': 'ini',
  '.tf': 'terraform', '.tfvars': 'terraform',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown', '.txt': 'text', '.rst': 'text', '.adoc': 'text', '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.avif': 'image', '.bmp': 'image', '.ico': 'image', '.ktx': 'image', '.ktx2': 'image',
  '.glb': 'model-asset', '.gltf': 'model-asset', '.ply': 'model-asset', '.splat': 'model-asset', '.ksplat': 'model-asset', '.sogs': 'model-asset', '.obj': 'model-asset', '.fbx': 'model-asset',
  '.mp3': 'audio-video', '.wav': 'audio-video', '.ogg': 'audio-video', '.m4a': 'audio-video', '.mp4': 'audio-video', '.webm': 'audio-video',
  '.zip': 'archive', '.7z': 'archive', '.tar': 'archive', '.gz': 'archive', '.tgz': 'archive', '.rar': 'archive',
  '.wasm': 'binary', '.bin': 'binary', '.exe': 'binary', '.dll': 'binary', '.so': 'binary', '.dylib': 'binary', '.node': 'binary',
};

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+/gu, '/');
}

function basename(path: string): string {
  const parts = normalizePath(path).split('/');
  return parts.at(-1) ?? path;
}

function classifySpecialPath(path: string): string | null {
  const normalized = normalizePath(path).toLowerCase();
  const name = basename(normalized);
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'docker';
  if (name === 'makefile' || name === 'cmakelists.txt' || name === 'justfile') return 'build-script';
  if (name === 'package-lock.json' || name === 'pnpm-lock.yaml' || name === 'yarn.lock' || name === 'bun.lockb') return 'build-script';
  if (normalized.startsWith('.github/workflows/')) return 'github-actions';
  if (/(^|\/)(?:k8s|kubernetes|helm)(?:\/|$)/u.test(normalized) && /\.(?:ya?ml)$/u.test(normalized)) return 'kubernetes';
  if (/\.(?:csproj|fsproj|vbproj|sln)$/u.test(normalized)) return 'build-script';
  if (/\.(?:gradle|gradle\.kts)$/u.test(normalized) || name === 'pom.xml') return 'build-script';
  // Extension-bearing knowledge files keep their exact governed environment
  // (`README.md` is Markdown, not generic text). Extensionless conventional names
  // still receive an explicit documentation classification.
  if (/^(?:readme|license|changelog|contributing|notice)$/u.test(name)) return 'text';
  if (/^(?:\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|\.editorconfig)$/u.test(name)) return 'ini';
  return null;
}

function physicalFormat(path: string, environmentId: string): string {
  const extension = extname(path).toLowerCase();
  if (extension !== '') return extension.slice(1);
  return environmentId === 'unknown' ? 'extensionless' : environmentId;
}

export function artifactTaxonomy(): ArtifactTaxonomy {
  const content = {
    taxonomyVersion: ARTIFACT_TAXONOMY_VERSION,
    classifierVersion: ARTIFACT_CLASSIFIER_VERSION,
    families: FAMILIES,
    environments: ENVIRONMENTS,
  };
  return artifactTaxonomySchema.parse({
    ...content,
    taxonomyHash: hashCanonicalJson(content),
  });
}

export const ARTIFACT_TAXONOMY = artifactTaxonomy();
export const ARTIFACT_TAXONOMY_HASH: Sha256 = ARTIFACT_TAXONOMY.taxonomyHash as Sha256;

export function classifyArtifactPath(path: string): ArtifactClassification {
  const normalized = normalizePath(path);
  const special = classifySpecialPath(normalized);
  const extension = extname(normalized).toLowerCase();
  const environmentId = special ?? EXTENSION_TO_ENVIRONMENT[extension] ?? 'unknown';
  const environment = ENVIRONMENT_BY_ID.get(environmentId) ?? ENVIRONMENT_BY_ID.get('unknown');
  if (environment === undefined) throw new Error('artifact taxonomy has no unknown environment');

  const exact = special !== null || EXTENSION_TO_ENVIRONMENT[extension] !== undefined;
  const reason = special !== null
    ? `path convention matched ${special}`
    : exact
      ? `extension ${extension || '<none>'} matched ${environmentId}`
      : `no governed classifier matched ${normalized}; explicit unknown retained`;

  return artifactClassificationSchema.parse({
    familyId: environment.familyId,
    environmentId: environment.id,
    physicalFormat: physicalFormat(normalized, environment.id),
    glyphId: environment.glyphId,
    facets: [environment.familyId, environment.id, extension === '' ? 'extensionless' : `ext:${extension.slice(1)}`],
    source: 'backend-artifact-taxonomy',
    confidence: exact ? 1 : 0,
    reason,
    classifierVersion: ARTIFACT_CLASSIFIER_VERSION,
    adapterId: environment.adapterId,
    adapterVersion: environment.adapterId === 'typescript-static' ? 'clue-recognizer/4' : null,
  });
}

export function environmentById(id: string): ArtifactEnvironment | null {
  return ENVIRONMENT_BY_ID.get(id) ?? null;
}
