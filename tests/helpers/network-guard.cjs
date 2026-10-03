// Test-only transport boundary: loopback TCP/HTTP and local IPC only.
const blocked = () => { throw Error('TEST_NETWORK_BLOCKED'); };
const https = require('https');
https.request = https.get = blocked;
const net = require('net');
const connect = net.Socket.prototype.connect;
function normalize(args) {
  // net.connect() forwards Node's normalized [options, callback] array to Socket.
  if (Array.isArray(args[0])) {
    if (args.length !== 1) blocked();
    args = args[0];
  }
  const first = args[0];
  let options, callback;
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    if (args.length > 2) blocked();
    options = { ...first }; callback = args[1];
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    if (args.length > 3) blocked();
    options = { port: first };
    if (typeof args[1] === 'string') { options.host = args[1]; callback = args[2]; }
    else { if (args.length > 2) blocked(); callback = args[1]; }
  } else if (typeof first === 'string' && first.length > 0) {
    if (args.length > 2) blocked();
    options = { path: first }; callback = args[1];
  } else blocked();
  if (callback === null) callback = undefined; // Node's normalized no-callback form.
  if (callback !== undefined && typeof callback !== 'function') blocked();
  if (options.port === undefined || options.port === null) {
    if (typeof options.path !== 'string' || !options.path) blocked();
    return [options, callback]; // Local Unix/Windows IPC, no TCP destination.
  }
  if (!['number','string'].includes(typeof options.port) || !/^\d+$/.test(String(options.port)) || Number(options.port) > 65535) blocked();
  const host = options.host === undefined ? '127.0.0.1' : options.host;
  if (typeof host !== 'string' || !['127.0.0.1','::1','localhost'].includes(host)) blocked();
  // Pin localhost to an IP; DNS or a custom lookup cannot redirect it externally.
  options.host = host === 'localhost' ? '127.0.0.1' : host;
  return [options, callback];
}
net.Socket.prototype.connect = function (...args) {
  return connect.apply(this, normalize(args));
};
const tls = require('tls');
tls.connect = blocked;
