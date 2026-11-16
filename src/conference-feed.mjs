import { lookup as systemLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const feedLimit = 2 * 1024 * 1024;
const deadlineMs = 12_000;
const redirects = new Set([301, 302, 303, 307, 308]);

function feedError(message, code = 'FEED_INVALID_URL') {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function ipv4Number(address) {
  return address.split('.').reduce((number, part) => number * 256 + Number(part), 0);
}

function ipv6Number(address) {
  // isIP() has already validated the address. Translate a dotted tail before expanding ::.
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const value = ipv4Number(dotted[1]);
    address = address.slice(0, -dotted[1].length) + (value >>> 16).toString(16) + ':' + (value & 0xffff).toString(16);
  }
  const [left, right] = address.split('::');
  const first = left ? left.split(':') : [];
  const last = right ? right.split(':') : [];
  const parts = right === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
  return parts.reduce((number, part) => (number << 16n) + BigInt('0x' + part), 0n);
}

// Conservative public-address policy. IANA special-use space is not an acceptable feed target.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const blockedV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([address, bits]) => [Math.floor(ipv4Number(address) / 2 ** (32 - bits)), bits]);
const blockedV6 = [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3fff::', 20]
].map(([address, bits]) => [ipv6Number(address) >> BigInt(128 - bits), bits]);

export function isPublicFeedAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !blockedV4.some(([prefix, bits]) => Math.floor(value / 2 ** (32 - bits)) === prefix);
  }
  if (family === 6) {
    const value = ipv6Number(address);
    return value >> 125n === 1n && !blockedV6.some(([prefix, bits]) => value >> BigInt(128 - bits) === prefix);
  }
  return false;
}

/** Syntax validation is synchronous; DNS targets are checked again immediately before each connection. */
export function normalizeFeedUrl(raw) {
  const message = '请填写标准 HTTPS 公网订阅链接，可从 CCFDDL 复制。';
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) throw feedError(message);
  const value = raw.trim().replace(/^webcal:\/\//i, 'https://');
  let url;
  try { url = new URL(value); } catch { throw feedError(message); }
  const authority = /^[a-z]+:\/\/([^/?#]*)/i.exec(value)?.[1] ?? '';
  if (url.protocol !== 'https:' || url.port || url.username || url.password || value.includes('#') || authority.includes('@')) {
    throw feedError(message);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.includes('%') || hostname.length > 253) throw feedError(message);
  if (isIP(hostname)) {
    if (!isPublicFeedAddress(hostname)) throw feedError('订阅链接不能访问本机、内网或保留地址。');
  } else {
    const plain = hostname.replace(/\.$/, '');
    if (!plain.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(plain) || /(?:^|\.)home\.arpa$/.test(plain)
      || !plain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw feedError(message);
    }
  }
  if (url.href.length > 2048) throw feedError(message);
  return url.href;
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('订阅同步已取消。', 'AbortError');
}

function untilAborted(operation, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(abortReason(signal));
    signal.addEventListener('abort', cancelled, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
}

export function createConferenceFeedFetcher({ lookup = systemLookup, request = httpsRequest,
  timeoutMs = deadlineMs, maxBytes = feedLimit } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > deadlineMs
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > feedLimit) throw new TypeError('Invalid feed resource limits');

  async function targetAddresses(url, signal) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
    const addresses = await untilAborted(lookup(hostname, { all: true, verbatim: true }), signal);
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 128
      || addresses.some(item => !item || isIP(item.address) !== item.family || !isPublicFeedAddress(item.address))) {
      throw feedError('订阅链接不能访问本机、内网或保留地址。', 'FEED_UNSAFE_ADDRESS');
    }
    return addresses.map(({ address, family }) => ({ address, family }));
  }

  function download(url, addresses, signal) {
    return new Promise((resolve, reject) => {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const options = {
        method: 'GET', agent: false, signal, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16_384,
        headers: { Accept: 'text/calendar, text/plain;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'LabCalendar/1.0' },
        // Never ask DNS a second time: TLS still checks the original hostname, not the selected IP.
        lookup(name, settings, callback) {
          queueMicrotask(() => {
            if (name !== hostname) return callback(feedError('订阅目标发生变化。', 'FEED_UNSAFE_ADDRESS'));
            if (settings?.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          });
        }
      };
      const req = request(url, options, async response => {
        const status = response.statusCode;
        if (redirects.has(status) || status < 200 || status >= 300) {
          const location = response.headers.location;
          response.destroy();
          resolve({ status, location });
          return;
        }
        try {
          if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity') {
            throw feedError('订阅源使用了不支持的压缩格式。', 'FEED_ENCODING');
          }
          const sizeHeader = response.headers['content-length'];
          if (sizeHeader && (!/^\d+$/.test(sizeHeader) || Number(sizeHeader) > maxBytes)) {
            throw feedError('订阅文件超过 2 MB 大小限制。', 'FEED_TOO_LARGE');
          }
          const chunks = []; let size = 0;
          for await (const chunk of response) {
            size += chunk.byteLength;
            if (size > maxBytes) throw feedError('订阅文件超过 2 MB 大小限制。', 'FEED_TOO_LARGE');
            chunks.push(chunk);
          }
          signal.throwIfAborted();
          resolve({ status, bytes: Buffer.concat(chunks), type: response.headers['content-type'] });
        } catch (error) { response.destroy(); reject(error); }
      });
      req.on('error', reject);
      req.end();
    });
  }

  return async function fetchConferenceFeed(raw, { signal } = {}) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      let url = new URL(normalizeFeedUrl(raw));
      for (let hop = 0; ; hop++) {
        bounded.throwIfAborted();
        const addresses = await targetAddresses(url, bounded);
        bounded.throwIfAborted();
        const result = await download(url, addresses, bounded);
        if (redirects.has(result.status)) {
          if (hop >= 3 || !result.location) throw feedError('订阅链接跳转次数过多或缺少目标地址。', 'FEED_REDIRECT');
          let next;
          try { next = new URL(result.location, url); } catch { throw feedError('订阅跳转地址无效。', 'FEED_REDIRECT'); }
          url = new URL(normalizeFeedUrl(next.href));
          continue;
        }
        if (result.status < 200 || result.status >= 300) throw feedError(`订阅源返回 HTTP ${result.status}。`, 'FEED_HTTP');
        return new Response([204, 205].includes(result.status) ? null : result.bytes,
          { status: result.status, headers: { 'Content-Type': result.type || 'text/calendar; charset=utf-8' } });
      }
    } catch (error) {
      if (bounded.aborted) throw abortReason(bounded);
      if (error?.code?.startsWith('FEED_')) throw error;
      throw feedError('暂时无法连接订阅源，请检查链接或稍后重试。', 'FEED_CONNECTION');
    }
  };
}

export const fetchConferenceFeed = createConferenceFeedFetcher();
