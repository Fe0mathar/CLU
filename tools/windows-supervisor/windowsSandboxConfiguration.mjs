import { win32 } from 'node:path';

const guestInput = String.raw`C:\CLU-E-Fixture\Input`;
const guestOutput = String.raw`C:\CLU-E-Fixture\Output`;
const guestPowerShell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const logonCommand = `${guestPowerShell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${guestInput}\\fixture.ps1`;
const reservedName = /^(?:con(?:in\$|out\$)?|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

function checkedMountPath(path) {
  if (typeof path !== 'string' || !path.isWellFormed() || !/^[A-Za-z]:\\[^\\]/u.test(path) ||
      path !== win32.normalize(path)) {
    throw new Error('Sandbox mount requires a canonical absolute Windows path.');
  }
  const components = path.slice(3).split('\\');
  if (components.some((part) => part === '' || /[<>:"/|?*%\u0000-\u001f\u007f\ufffe\uffff]|[ .]$/u.test(part) ||
      reservedName.test(part.split('.')[0].trimEnd()) || /~[0-9]+(?:\.|$)/u.test(part))) {
    throw new Error('Sandbox mount contains an unsafe Windows path component.');
  }
  return path;
}

function xmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** Builds configuration for a physically verified, disposable fixture stage. */
export function buildWindowsSandboxConfiguration(inputRoot, outputRoot) {
  const input = checkedMountPath(inputRoot);
  const output = checkedMountPath(outputRoot);
  const parent = win32.dirname(input);
  if (parent === win32.parse(input).root || parent.toUpperCase() !== win32.dirname(output).toUpperCase() ||
      input.toUpperCase() === output.toUpperCase()) {
    throw new Error('Sandbox input and output must be distinct siblings within the fixture stage.');
  }

  return [
    '<Configuration>',
    '<vGPU>Disable</vGPU>',
    '<Networking>Disable</Networking>',
    '<AudioInput>Disable</AudioInput>',
    '<VideoInput>Disable</VideoInput>',
    '<PrinterRedirection>Disable</PrinterRedirection>',
    '<ClipboardRedirection>Disable</ClipboardRedirection>',
    '<ProtectedClient>Enable</ProtectedClient>',
    '<MappedFolders>',
    '<MappedFolder>',
    `<HostFolder>${xmlText(input)}</HostFolder>`,
    `<SandboxFolder>${guestInput}</SandboxFolder>`,
    '<ReadOnly>true</ReadOnly>',
    '</MappedFolder>',
    '<MappedFolder>',
    `<HostFolder>${xmlText(output)}</HostFolder>`,
    `<SandboxFolder>${guestOutput}</SandboxFolder>`,
    '<ReadOnly>false</ReadOnly>',
    '</MappedFolder>',
    '</MappedFolders>',
    `<LogonCommand><Command>${logonCommand}</Command></LogonCommand>`,
    '</Configuration>',
  ].join('');
}
