'use strict';

async function runGovernedWfpBindPrelude(workspace) {
  const fs = require('node:fs');
  const path = require('node:path');
  const net = require('node:net');
  const dgram = require('node:dgram');
  const { randomBytes } = require('node:crypto');
  const gateTimeoutMs = 20_000;
  const socketTimeoutMs = 1500;
  const lanes = [
    ['127.0.0.1', true, false],
    ['::1', true, true],
    ['127.0.0.1', false, false],
    ['::1', false, true],
  ];

  function publish(name, value) {
    const target = path.join(workspace, name);
    const temporary = target + '.' + randomBytes(8).toString('hex') + '.tmp';
    if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new Error('WFP marker already exists');
    try {
      fs.writeFileSync(temporary, value, { encoding: 'ascii', flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async function waitForGate(name) {
    const file = path.join(workspace, name);
    const deadline = performance.now() + gateTimeoutMs;
    while (performance.now() < deadline) {
      const entry = fs.lstatSync(file, { throwIfNoEntry: false });
      if (entry) {
        if (!entry.isFile() || entry.nlink !== 1 || entry.size !== 2 ||
            path.relative(file, fs.realpathSync.native(file)) !== '' ||
            !fs.readFileSync(file).equals(Buffer.from('GO'))) throw new Error('Invalid WFP gate');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('WFP gate deadline');
  }

  function attempt(address, tcp, ipv6) {
    return new Promise((resolve) => {
      const socket = tcp
        ? net.createServer((unexpected) => unexpected.destroy())
        : dgram.createSocket({ type: ipv6 ? 'udp6' : 'udp4', ipv6Only: ipv6 });
      let finished = false;
      const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        const complete = () => {
          clearTimeout(closeDeadline);
          resolve(code);
        };
        const closeDeadline = setTimeout(() => resolve(null), socketTimeoutMs);
        try {
          socket.unref();
          socket.close(complete);
        } catch {
          complete();
        }
      };
      const deadline = setTimeout(() => finish(null), socketTimeoutMs);
      socket.on('error', (error) => {
        // On Windows libuv maps Winsock WSAEACCES (10013) to EACCES.
        finish(error.code === 'EACCES' ? 10013 : null);
      });
      socket.once('listening', () => {
        if (finished) {
          try { socket.close(); } catch { /* A timed-out socket may be closing already. */ }
          return;
        }
        finish(0);
      });
      try {
        // TCP tests bind plus listen. No connection is initiated or served.
        if (tcp) socket.listen({ host: address, port: 0, ipv6Only: ipv6, exclusive: true, backlog: 1 });
        else socket.bind({ address, port: 0, exclusive: true });
      } catch {
        finish(null);
      }
    });
  }

  function requireReleaseAbsent() {
    if (fs.lstatSync(path.join(workspace, 'wfp-release-go.txt'), { throwIfNoEntry: false })) {
      throw new Error('Unexpected npm release gate');
    }
  }

  publish('wfp-start.txt', String(process.pid));
  let samplesMatch = true;
  for (const phase of ['control', 'armed']) {
    await waitForGate('wfp-' + phase + '-go.txt');
    const codes = await Promise.all(lanes.map(([address, tcp, ipv6]) => attempt(address, tcp, ipv6)));
    if (!codes.every((code) => code === 0 || code === 10013)) throw new Error('WFP socket result unavailable');
    publish('wfp-' + phase + '-result.txt', codes.join(' '));
    samplesMatch = samplesMatch && codes.every((code) => code === (phase === 'control' ? 0 : 10013));
  }
  if (typeof governedWfpActiveLoss !== 'undefined' && governedWfpActiveLoss === true) {
    if (!samplesMatch) throw new Error('WFP socket result mismatch');
    for (const phase of ['active', 'fault']) {
      requireReleaseAbsent();
      await waitForGate('wfp-' + phase + '-go.txt');
      requireReleaseAbsent();
      const codes = await Promise.all(lanes.map(([address, tcp, ipv6]) => attempt(address, tcp, ipv6)));
      if (!codes.every((code) => code === 10013)) throw new Error('WFP active-loss denial unverified');
      publish('wfp-' + phase + '-result.txt', codes.join(' '));
    }
    await new Promise((resolve) => setTimeout(resolve, gateTimeoutMs));
    throw new Error('WFP active-loss cancellation deadline');
  }
  await waitForGate('wfp-release-go.txt');
  if (!samplesMatch) throw new Error('WFP socket result mismatch');
}
