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
