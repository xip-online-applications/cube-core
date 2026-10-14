#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Checks that a Cube API terminates a half-open WebSocket connection.
 *
 * The script connects, authenticates, subscribes to a query, then freezes its own TCP socket (it stops
 * reading, so it never answers the server's pings, while the connection stays open: what a sleeping
 * laptop or a dropped NAT mapping looks like to the server). After --freeze-seconds it resumes the
 * socket and reports PASS if the server closed the connection meanwhile, FAIL if it is still open
 * (keepalive disabled, or its interval is longer than the freeze).
 *
 *   node ws-half-open-check.js --url ws://localhost:4000/ --token <jwt> --query '{"measures":["Orders.count"]}' \
 *     [--freeze-seconds 90] [--message-id 2571]
 *
 * Exit code: 0 PASS, 1 FAIL, 2 error (could not connect or authenticate, bad arguments).
 */
const WebSocket = require('ws');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves when the promise does or after ms, without leaving the timer running
function orTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const USAGE = 'Usage: node ws-half-open-check.js --url <ws-url> --token <jwt> --query <json> [--freeze-seconds 90] [--message-id 2571]';

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }

  return args;
}

/**
 * @param {{ url: string, token: string, query: object, freezeSeconds?: number, closeWaitSeconds?: number,
 *   messageId?: number, log?: (line: string) => void }} options
 * @returns {Promise<{ result: 'PASS' | 'FAIL', closeCode?: number }>}
 */
async function run({
  url,
  token,
  query,
  freezeSeconds = 90,
  closeWaitSeconds = 5,
  messageId = 2571,
  log = console.log,
}) {
  if (!query || typeof query !== 'object') {
    throw new Error('A query object is required');
  }

  const ws = new WebSocket(url);
  let closeCode;
  let closed = false;
  ws.on('close', (code) => {
    closed = true;
    closeCode = code;
  });

  let onFirstResult = () => undefined;
  const firstResult = new Promise((resolve) => { onFirstResult = resolve; });

  await new Promise((resolve, reject) => {
    const failTimer = setTimeout(() => reject(new Error('Timed out waiting for the handshake')), 10000);
    ws.on('error', (err) => {
      clearTimeout(failTimer);
      reject(new Error(`Connection failed: ${err.message}`));
    });
    ws.on('close', () => {
      clearTimeout(failTimer);
      reject(new Error('Connection closed before the handshake'));
    });
    ws.on('open', () => ws.send(JSON.stringify({ authorization: token })));
    ws.on('message', (data) => {
      let message;

      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (message.handshake) {
        clearTimeout(failTimer);
        ws.send(JSON.stringify({ messageId, method: 'subscribe', params: { query } }));
        resolve();
      } else if (message.messageId === messageId) {
        onFirstResult();
      }
    });
  });

  log(`Connected and subscribed (message id ${messageId}); waiting up to 5 s for the first result`);
  await orTimeout(firstResult, 5000);

  log(`Freezing the TCP socket for ${freezeSeconds} s (no pongs will be sent)`);
  ws._socket.pause();
  await sleep(freezeSeconds * 1000);
  ws._socket.resume();

  const deadline = Date.now() + closeWaitSeconds * 1000;
  while (!closed && Date.now() < deadline) {
    await sleep(50);
  }

  if (closed) {
    log(`PASS: the server closed the half-open connection (close code ${closeCode})`);
    log('Server side, check: ws.connections_terminated incremented, a cube.ws.connection_terminated log line, '
      + 'the subscriptions gauge / cube.ws.summary dropped, and no further queries for this subscription.');

    return { result: 'PASS', closeCode };
  }

  ws.terminate();
  log('FAIL: the connection is still open; the keepalive is disabled or its interval is longer than the freeze');

  return { result: 'FAIL' };
}

module.exports = { run };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  let query;

  try {
    query = args.query ? JSON.parse(args.query) : undefined;
  } catch {
    query = undefined;
  }

  if (!args.url || !args.token || !query) {
    console.error(USAGE);
    process.exit(2);
  }

  run({
    url: args.url,
    token: args.token,
    query,
    freezeSeconds: args['freeze-seconds'] ? Number(args['freeze-seconds']) : undefined,
    messageId: args['message-id'] ? Number(args['message-id']) : undefined,
  })
    .then(({ result }) => process.exit(result === 'PASS' ? 0 : 1))
    .catch((err) => {
      console.error(err.message);
      process.exit(2);
    });
}
