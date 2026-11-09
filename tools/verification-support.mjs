import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, toNamespacedPath } from 'node:path';

export function resolveNpmInvocation(args, {
  platform = process.platform,
  nodePath = process.execPath,
  env = process.env,
} = {}) {
  const fromNpm = env.npm_execpath;
  const adjacent = join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCli = [fromNpm, adjacent].find((path) =>
    typeof path === 'string' && isAbsolute(path) && basename(path).toLowerCase() === 'npm-cli.js' &&
    statSync(path, { throwIfNoEntry: false })?.isFile() === true,
  );
  if (npmCli !== undefined) return { command: nodePath, args: [npmCli, ...args] };
  if (platform !== 'win32') return { command: 'npm', args };
  throw new Error('npm CLI was not found. Install Node.js with npm, then launch this check with npm.cmd run from the CLU-E root.');
}

/** Capture failed TAP cases from sanitized output before a report takes its log tail. */
export function collectTapFailures(...outputs) {
  const maxBlockLength = 2500;
  const maxDetailsLength = 16000;
  const shortened = '\n[diagnostic shortened]';
  const blocks = [];
  let remaining = maxDetailsLength - 100; // Reserve space for an omitted-case notice.
  let omitted = 0;
  for (const output of outputs) {
    const lines = output.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const header = lines[index];
      const match = /^([ \t]*)not ok \d+(?:[ \t]|$)/u.exec(header);
      if (!match) continue;
      const first = index;
      const diagnostic = /^([ \t]+)---[ \t]*$/u.exec(lines[index + 1] ?? '');
      if (diagnostic?.[1].startsWith(match[1]) && diagnostic[1].length > match[1].length) {
        const indent = diagnostic[1];
        index += 1;
        while (lines[index + 1]?.startsWith(indent)) {
          index += 1;
          if (lines[index].slice(indent.length).trimEnd() === '...') break;
        }
      }
      if (/[ \t]#[ \t]*(?:SKIP|TODO)(?:[ \t]|$)/iu.test(header)) continue;
      if (blocks.length >= 16 || remaining < 256) {
        omitted += 1;
        continue;
      }
      const limit = Math.min(maxBlockLength, remaining - 2);
      const block = lines.slice(first, index + 1).join('\n');
      const bounded = block.length > limit ? `${block.slice(0, limit - shortened.length)}${shortened}` : block;
      blocks.push(bounded);
      remaining -= bounded.length + 2;
    }
  }
  if (omitted > 0) blocks.push(`[${omitted} additional TAP failures omitted]`);
  return blocks;
}

function isInside(root, path) {
  const delta = relative(toNamespacedPath(root), toNamespacedPath(path));
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

function resolveExistingAncestor(path) {
  const missing = [];
  let ancestor = path;
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Cannot resolve the report output directory.');
    ancestor = parent;
  }
  return join(realpathSync.native(ancestor), ...missing);
}

export function externalReportPath(repoRoot, requestedPath) {
  const output = resolve(repoRoot, requestedPath);
  if (process.platform === 'win32') {
    const { root } = parse(output);
    const segments = output.slice(root.length).split(sep);
    if (segments.some((part) => part.includes(':') || /[. ]$/u.test(part))) {
      throw new Error('Report output must use an ordinary Windows file path without alternate streams or trailing dots or spaces.');
    }
  }
  const realRoot = realpathSync.native(repoRoot);
  const realParent = resolveExistingAncestor(dirname(output));
  if (isInside(repoRoot, output) || isInside(realRoot, join(realParent, basename(output)))) {
    throw new Error('Report output must be outside the CLU-E project directory. Use --output with a path in the external evidence directory.');
  }
  const physicalOutput = join(realParent, basename(output));
  const existing = lstatSync(physicalOutput, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isFile()) {
    throw new Error('Report output must be a regular file path.');
  }
  return physicalOutput;
}

export function writeExternalReport(repoRoot, requestedPath, report) {
  const planned = externalReportPath(repoRoot, requestedPath);
  mkdirSync(dirname(planned), { recursive: true });
  const output = externalReportPath(repoRoot, planned);
  const staging = mkdtempSync(join(dirname(output), '.clue-report-'));
  try {
    const temporary = join(staging, 'report.json');
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return output;
}
