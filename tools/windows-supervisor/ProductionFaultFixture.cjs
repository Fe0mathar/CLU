'use strict';

// Only this byte-pinned, synthetic program can enter the native owner-loss lane.
async function runProductionFaultProbe() {
  const fs = require('node:fs');
  const path = require('node:path');
  const net = require('node:net');
  const dgram = require('node:dgram');
  const { randomBytes } = require('node:crypto');
  const { setTimeout: pause } = require('node:timers/promises');
  const [gate, scope, hostPort, peer, peerPort, nonce] = process.argv.slice(1);
  if (process.argv.length !== 7 || scope !== 'clue-production-fault/1' || !net.isIPv4(peer) ||
      !/^[a-f0-9]{64}$/u.test(nonce) || ![hostPort, peerPort].every((port) =>
        /^[1-9][0-9]{0,4}$/u.test(port) && Number(port) <= 65535)) {
    throw new Error('FAULT_FIXTURE_ARGUMENTS_INVALID');
  }

  function publish(name, value) {
    const target = path.join(gate, name);
    const temporary = target + '.' + randomBytes(8).toString('hex') + '.tmp';
    if (fs.existsSync(target)) throw new Error('FAULT_FIXTURE_MARKER_EXISTS');
    try {
      fs.writeFileSync(temporary, String(value), { encoding: 'ascii', flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async function waitFor(name) {
    const file = path.join(gate, name);
    const deadline = performance.now() + 12000;
    do {
      const info = fs.lstatSync(file, { throwIfNoEntry: false });
      if (info) {
        if (!info.isFile() || info.nlink !== 1 || info.size !== 2 ||
            path.relative(file, fs.realpathSync.native(file)) !== '' || fs.readFileSync(file, 'ascii') !== 'GO') {
          throw new Error('FAULT_FIXTURE_GATE_INVALID');
        }
        return;
      }
      await pause(20);
    } while (performance.now() < deadline);
    throw new Error('FAULT_FIXTURE_GATE_TIMEOUT');
  }

  function bind(address, type) {
    const tcp = type === 'tcp';
    const ipv6 = address === '::1';
    return new Promise((resolve) => {
      const socket = tcp ? net.createServer((client) => client.destroy()) : dgram.createSocket(ipv6 ? 'udp6' : 'udp4');
      let finished = false;
      const timer = setTimeout(() => finish(10060), 1200);
      function finish(code) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const closed = () => { clearTimeout(closeTimer); resolve(code); };
        const closeTimer = setTimeout(() => resolve(10060), 800);
        try { socket.close(closed); } catch { closed(); }
      }
      socket.on('error', (error) => finish(error.code === 'EACCES' ? 10013 : 10022));
      socket.once('listening', () => finish(0));
      try {
        if (tcp) socket.listen({ host: address, port: 0, ipv6Only: ipv6, exclusive: true, backlog: 1 });
        else socket.bind({ address, port: 0, exclusive: true });
      } catch { finish(10022); }
    });
  }

  function dial(host, port, sequence) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port: Number(port), family: 4 });
      let connected = false;
      let finished = false;
      const timer = setTimeout(() => finish(connected ? 0 : 10060), 1200);
      function finish(code) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(code);
      }
      socket.on('error', (error) => {
        const codes = { EACCES: 10013, EPERM: 10013, ENETUNREACH: 10051, EHOSTUNREACH: 10051, ECONNREFUSED: 10061 };
        finish(connected ? 0 : codes[error.code] ?? 10022);
      });
      socket.once('connect', () => {
        connected = true;
        const frame = 'CLU-E-PEER/2 L ' + sequence + ' ' + nonce + '\n';
        socket.write(frame, () => finish(0));
      });
    });
  }

  const binds = () => Promise.all([bind('127.0.0.1', 'tcp'), bind('::1', 'tcp'),
    bind('127.0.0.1', 'udp'), bind('::1', 'udp')]);
  publish('wfp-start.txt', process.pid);
  for (const phase of ['control', 'armed']) {
    await waitFor('wfp-' + phase + '-go.txt');
    publish('wfp-' + phase + '-result.txt', (await binds()).join(' '));
  }
  for (const phase of ['active', 'fault']) {
    await waitFor('wfp-' + phase + '-go.txt');
    await waitFor('wfp-peer-' + phase + '-ready.txt');
    if (fs.existsSync(path.join(gate, 'wfp-release-go.txt'))) throw new Error('FAULT_FIXTURE_RELEASE_UNEXPECTED');
    const sequence = phase === 'active' ? '000002' : '000003';
    const [loopback, host, virtualPeer] = await Promise.all([
      binds(), dial('127.0.0.1', hostPort, sequence), dial(peer, peerPort, sequence),
    ]);
    publish('wfp-' + phase + '-result.txt', [...loopback, host, virtualPeer].join(' '));
  }
  // The native guardian owns cancellation. A natural fixture exit cannot count as fault evidence.
  await pause(12000);
  throw new Error('FAULT_FIXTURE_CANCEL_TIMEOUT');
}
