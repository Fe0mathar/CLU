import { createConnection, createServer, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export function privateProbeAddresses(interfaces = networkInterfaces()) {
  const addresses = new Set();
  for (const entry of Object.values(interfaces).flat()) {
    if (!entry || entry.internal || !isIPv4(entry.address)) continue;
    const [first, second] = entry.address.split('.').map(Number);
    if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
      addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function checkListener(address, port) {
  return new Promise((resolve) => {
    const client = createConnection({ host: address, port });
    client.setTimeout(1000);
    function finish(connected) {
      client.destroy();
      resolve(connected);
    }
    client.once('connect', () => finish(true));
    client.once('timeout', () => finish(false));
    client.once('error', () => finish(false));
  });
}

export async function startWindowsSandboxHostEndpoint(nonce) {
  const addresses = privateProbeAddresses();
  if (addresses.length !== 1) {
    return { endpoint: null, state: addresses.length === 0 ? 'NO_PRIVATE_ADDRESS' : 'PRIVATE_ADDRESS_AMBIGUOUS' };
  }
  const [address] = addresses;
  let nonceReceived = false;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let received = '';
    socket.setTimeout(1000);
    socket.once('timeout', () => socket.destroy());
    socket.once('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      if (received.length + chunk.length > nonce.length) {
        socket.destroy();
        return;
      }
      received += chunk.toString('latin1');
      if (received.length === nonce.length) {
        if (received === nonce) nonceReceived = true;
        socket.destroy();
      }
    });
  });
  server.maxConnections = 8;
  const close = () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
  };
  let listenerError = false;
  const listening = await new Promise((resolve) => {
    server.on('error', () => {
      listenerError = true;
      resolve(false);
    });
    server.listen({ host: address, port: 0, exclusive: true }, () => resolve(true));
  });
  const binding = server.address();
  if (!listening || binding === null || !await checkListener(address, binding.port)) {
    close();
    return { endpoint: null, state: 'HOST_CONTROL_UNAVAILABLE' };
  }
  return {
    endpoint: { address, port: binding.port },
    state: 'HOST_CONTROL_CONNECTED',
    nonceReceived: () => nonceReceived,
    control: async () => !listenerError && await checkListener(address, binding.port),
    close,
  };
}
