const PROOF_TESTS = [
  ['proof-cli.test.js', 'governed-proof-command', 'DEV-P2-11 CLI: real command records ACCEPT,'],
  ['proof.test.js', 'candidate-coordinator', 'proof §12–§13: the coordinator collects on a real tree'],
  ['proof.test.js', 'durable-verdict-and-great-book', 'proof arm: the durable chain'],
  ['self-target-proof-relocation.test.js', 'self-target-relocation', 'P2-CLOSURE-02: self-target proof'],
  ['windows-execution-supervisor.test.js', 'supervisor-pin', 'native Windows supervisor resolves only the exact pinned file'],
];

/** A successful exit must still report a complete, nonempty TAP summary. */
export function readTapCounts(text) {
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gmu'))];
    if (matches.length !== 1) return null;
    const value = Number(matches[0][1]);
    if (!Number.isSafeInteger(value)) return null;
    counts[name] = value;
  }
  const { tests, pass, fail, cancelled, skipped, todo } = counts;
  return tests > 0 && tests === pass + fail + cancelled + skipped + todo ? counts : null;
}

export function nativeProofTapCoverage(file, stdout) {
  const resultLines = [...stdout.matchAll(/^(ok|not ok) \d+ - (.+)$/gmu)];
  return PROOF_TESTS.filter(([expectedFile]) => expectedFile === file).map(([, id, prefix]) => {
    const matches = resultLines.filter(([, , title]) => title.startsWith(prefix));
    if (matches.length !== 1) return { id, state: 'MISSING_OR_AMBIGUOUS' };
    const [, result, title] = matches[0];
    if (/\s# (?:SKIP|TODO)(?:\s|$)/iu.test(title)) return { id, state: 'NOT_EXECUTED' };
    return { id, state: result === 'ok' ? 'PASS' : 'FAIL' };
  });
}

export function assessNativeProofIntegration(platform, pin, files) {
  const tests = PROOF_TESTS.map(([file, id]) => ({
    file,
    id,
    state: files.find((item) => item.file === file)?.proofTests?.find((item) => item.id === id)?.state ?? 'MISSING_OR_AMBIGUOUS',
  }));
  const pinVerified = pin?.kind === 'windows-supervisor' && /^[0-9a-f]{64}$/u.test(pin.sha256);
  const pass = platform === 'win32' && pinVerified && tests.every((test) => test.state === 'PASS');
  return {
    pass,
    state: pass ? 'INTEGRATION_PASS' : platform !== 'win32' ? 'WINDOWS_REQUIRED' : 'INTEGRATION_PENDING',
    supervisorSha256: pinVerified ? pin.sha256 : null,
    tests,
    operatorQualification: 'SEPARATE_NATIVE_HOST_CHECK_REQUIRED',
  };
}
