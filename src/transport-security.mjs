import { isIP } from 'node:net';
import { createServer } from 'node:http';

function denied(message = '请通过 HTTPS 地址访问。') {
  return Object.assign(new Error(message), { statusCode: 426 });
}

export function normalizeAddress(value = '') {
  if (typeof value !== 'string') return '';
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  if (isIP(value) === 6) {
    try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); }
    catch { return ''; }
  }
  return isIP(value) === 4 ? value : '';
}

export function isLoopback(value) {
  const address = normalizeAddress(value);
  return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));
}

export function httpsOrigin(value) {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请将 LAB_CANONICAL_URL 设置为 HTTPS 网站根地址。');
  }
  return url.origin;
}

export function isCampusAddress(value) {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function campusHttpOrigin(value) {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'http:' || !isCampusAddress(url.hostname) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('临时 HTTP 兼容模式须使用明确的私网 IPv4 网站根地址。');
  return url.origin;
}

export function transportSecurity({ mode = 'development', trustedProxies = [], publicOrigin = '',
  allowInsecureHttp = false, bindHost = '', bindPort } = {}) {
  if (!['development', 'tls', 'proxy', 'legacy-http'].includes(mode)) throw new Error('无效的网站传输模式。');
  if (mode === 'legacy-http') {
    const origin = new URL(campusHttpOrigin(publicOrigin));
    if (allowInsecureHttp !== true || !isCampusAddress(bindHost) || origin.hostname !== bindHost
      || !Number.isSafeInteger(bindPort) || bindPort < 1 || bindPort > 65535 || Number(origin.port || 80) !== bindPort
      || trustedProxies.length) throw new Error('临时 HTTP 兼容模式需要明确授权，并绑定与网站地址一致的私网 IPv4 和端口。');
  }
  const trusted = new Set(trustedProxies.map(value => {
    const address = normalizeAddress(value);
    if (!address) throw new Error('可信代理必须使用明确的 IP 地址。');
    return address;
  }));
  if (mode === 'proxy' && (!trusted.size || !publicOrigin)) throw new Error('代理模式需要配置可信代理和 HTTPS 网站地址。');
  if (publicOrigin && mode !== 'legacy-http') httpsOrigin(publicOrigin);
  function clientAddress(request) {
    const peer = normalizeAddress(request.socket.remoteAddress);
    if (!peer) throw denied('无法识别连接来源。');
    if (mode === 'proxy') {
      // Only an explicitly trusted proxy may assert TLS/client identity; it must overwrite these headers.
      if (!trusted.has(peer) || request.headers['x-forwarded-proto'] !== 'https') throw denied();
      const address = normalizeAddress(request.headers['x-forwarded-for']);
      if (!address) throw denied('代理来源信息无效。');
      return address;
    }
    if (request.socket.encrypted) return peer;
    // Explicitly approved transition only; this does not provide transport encryption or trust forwarded headers.
    if (mode === 'legacy-http') return peer;
    // Plain HTTP is a loopback-only development exception, never a production network fallback.
    if (mode === 'development' && isLoopback(peer)) return peer;
    throw denied();
  }
  return { mode, secureCookies: ['tls', 'proxy'].includes(mode), clientAddress, assert: request => { clientAddress(request); } };
}

export function createHttpsRedirect(origin) {
  const canonical = httpsOrigin(origin);
  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff', Connection: 'close' };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(426, headers);
      response.end('请刷新页面，通过 HTTPS 地址重新提交。');
      request.resume();
      return;
    }
    try {
      const target = new URL(request.url, canonical);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Invalid request target');
      // Neither Host nor an absolute request target can change the redirect destination.
      const destination = new URL(canonical);
      destination.pathname = target.pathname;
      destination.search = target.search;
      response.writeHead(308, { ...headers, Location: destination.href });
      response.end();
    } catch {
      response.writeHead(400, headers);
      response.end('网址无效。');
    }
  });
}
