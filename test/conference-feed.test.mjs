import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createConferenceFeedFetcher, isPublicFeedAddress, normalizeFeedUrl } from '../src/conference-feed.mjs';

const publicAddress = { address: '8.8.8.8', family: 4 };
const calendar = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';

function harness(entries = [{ body: calendar }], { lookup, ...limits } = {}) {
  const dnsCalls = [], requests = [];
  const fetcher = createConferenceFeedFetcher({
    ...limits,
    lookup: async (hostname, options) => {
      dnsCalls.push({ hostname, options });
      return lookup ? lookup(hostname, dnsCalls.length) : [publicAddress];
    },
    request(url, options, callback) {
      const result = entries[requests.length];
      const record = { url: url.href, options };
      requests.push(record);
      const req = new EventEmitter();
      req.end = () => {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        options.lookup(host, { all: true }, (error, addresses) => {
          if (error) return req.emit('error', error);
          record.addresses = addresses;
          options.lookup(host, {}, (error, address, family) => {
            if (error) return req.emit('error', error);
            record.singleAddress = { address, family };
            if (result.error) return req.emit('error', result.error);
            const response = Readable.from(result.chunks ?? [Buffer.from(result.body ?? '')]);
            response.statusCode = result.status ?? 200;
            response.headers = result.headers ?? {};
            const aborted = () => { response.destroy(options.signal.reason); req.emit('error', options.signal.reason); };
            options.signal.addEventListener('abort', aborted, { once: true });
            response.once('close', () => options.signal.removeEventListener('abort', aborted));
            callback(response);
          });
        });
      };
      return req;
    }
  });
  return { fetcher, dnsCalls, requests };
}

test('会议订阅 URL 规范化 HTTPS/webcal，拒绝不安全协议、凭据、端口和非公网字面地址', () => {
  assert.equal(normalizeFeedUrl(' webcal://CCFDDL.com/conference/deadlines/a.ics '), 'https://ccfddl.com/conference/deadlines/a.ics');
  assert.equal(normalizeFeedUrl('https://ccfddl.com:443/feed?group=AI'), 'https://ccfddl.com/feed?group=AI');
  assert.equal(normalizeFeedUrl('https://[2001:4860:4860::8888]/feed.ics'), 'https://[2001:4860:4860::8888]/feed.ics');
  for (const value of ['', null, 'http://feed.example/a.ics', 'file:///tmp/a.ics', 'https://feed.example:444/a.ics',
    'https://user:secret@feed.example/a.ics', 'https://@feed.example/a.ics', 'https://feed.example/a.ics#part',
    'https://feed.example/a.ics#', 'https://feed.\nexample/a.ics', 'https://feed.example/' + 'a'.repeat(2048),
    'https://localhost/a.ics', 'https://intranet/a.ics', 'https://server.local/a.ics', 'https://host.home.arpa/a.ics',
    'https://127.0.0.1/a.ics', 'https://127.1/a.ics', 'https://0x7f000001/a.ics', 'https://2130706433/a.ics',
    'https://10.1.2.3/a.ics', 'https://169.254.169.254/a.ics', 'https://[::1]/a.ics',
    'https://[::ffff:127.0.0.1]/a.ics', 'https://[fc00::1]/a.ics', 'https://[2002:7f00:1::]/a.ics']) {
    assert.throws(() => normalizeFeedUrl(value), error => error.statusCode === 400 && error.code === 'FEED_INVALID_URL');
  }
});

test('公网地址策略覆盖私网、共享地址、链路本地、保留、映射和 IPv6 特殊范围', () => {
  for (const value of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '128.0.0.1', '192.0.1.1', '198.20.0.1',
    '2001:4860:4860::8888', '2a00:1450:400e:80d::200e', '2606:4700:4700::1111']) assert.equal(isPublicFeedAddress(value), true, value);
  for (const value of ['0.1.2.3', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.100.1.2',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.168.10.1',
    '192.88.99.2', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:8.8.8.8', '64:ff9b::a00:1', 'fe80::1', 'fe80::1%en0', 'fc00::1', 'ff02::1',
    '2001::1', '2001:2::1', '2001:db8::1', '2002:808:808::1', '2620:4f:8000::1', '3fff::1', 'not-an-address']) {
    assert.equal(isPublicFeedAddress(value), false, value);
  }
});

test('DNS 只查询一次并固定所有已校验地址，HTTPS 保留原主机身份和证书验证', async () => {
  const fixture = harness(undefined, { lookup: (_, count) => count === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }] });
  const response = await fixture.fetcher('https://feeds.example/ai.ics');
  assert.equal(response.ok, true); assert.equal(await response.text(), calendar);
  assert.equal(fixture.dnsCalls.length, 1);
  assert.deepEqual(fixture.dnsCalls[0], { hostname: 'feeds.example', options: { all: true, verbatim: true } });
  const record = fixture.requests[0];
  assert.equal(record.url, 'https://feeds.example/ai.ics');
  assert.deepEqual(record.addresses, [publicAddress]); assert.deepEqual(record.singleAddress, publicAddress);
  assert.equal(record.options.rejectUnauthorized, true);
  assert.equal(record.options.minVersion, 'TLSv1.2'); assert.equal(record.options.agent, false);
  assert.equal(record.options.checkServerIdentity, undefined);
  assert.equal(record.options.headers['Accept-Encoding'], 'identity');
  assert.equal(record.options.headers.Authorization, undefined); assert.equal(record.options.headers.Cookie, undefined);
});

test('域名所有 DNS 结果必须为公网，混合结果、无结果和族不一致均不发起请求', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.1', family: 4 }, publicAddress],
    [publicAddress, { address: '::ffff:8.8.8.8', family: 6 }], [], [{ address: '8.8.8.8', family: 6 }]]) {
    const fixture = harness(undefined, { lookup: () => addresses });
    await assert.rejects(fixture.fetcher('https://feeds.example/ai.ics'), { code: 'FEED_UNSAFE_ADDRESS' });
    assert.equal(fixture.requests.length, 0);
  }
});

test('每次跳转重新验证协议、地址和 DNS，最多接受三次 HTTPS 跳转', async () => {
  const fixture = harness([{ status: 302, headers: { location: 'https://other.example/events.ics' } }, { body: calendar }]);
  assert.equal(await (await fixture.fetcher('https://feeds.example/ai.ics')).text(), calendar);
  assert.deepEqual(fixture.dnsCalls.map(call => call.hostname), ['feeds.example', 'other.example']);
  for (const location of ['http://feeds.example/a.ics', 'https://127.0.0.1/a.ics', 'https://user:secret@other.example/a.ics']) {
    const blocked = harness([{ status: 302, headers: { location } }]);
    await assert.rejects(blocked.fetcher('https://feeds.example/ai.ics'));
    assert.equal(blocked.requests.length, 1);
  }
  const rebound = harness([{ status: 302, headers: { location: '/next.ics' } }],
    { lookup: (_, count) => count === 1 ? [publicAddress] : [{ address: '169.254.169.254', family: 4 }] });
  await assert.rejects(rebound.fetcher('https://feeds.example/ai.ics'), { code: 'FEED_UNSAFE_ADDRESS' });
  assert.equal(rebound.dnsCalls.length, 2); assert.equal(rebound.requests.length, 1);
  const loop = harness(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/next.ics' } })));
  await assert.rejects(loop.fetcher('https://feeds.example/ai.ics'), { code: 'FEED_REDIRECT' });
  assert.equal(loop.requests.length, 4);
});

test('下载预算同时限制声明长度和实际流，拒绝压缩及非成功状态，错误不包含链接密钥', async () => {
  const exact = harness([{ chunks: [Buffer.from('1234'), Buffer.from('5678')] }], { maxBytes: 8 });
  assert.equal(await (await exact.fetcher('https://feeds.example/a.ics')).text(), '12345678');
  for (const entry of [{ headers: { 'content-length': '9' } }, { chunks: [Buffer.from('12345'), Buffer.from('6789')] }]) {
    const oversized = harness([entry], { maxBytes: 8 });
    await assert.rejects(oversized.fetcher('https://feeds.example/a.ics'), { code: 'FEED_TOO_LARGE' });
  }
  await assert.rejects(harness([{ headers: { 'content-encoding': 'gzip' } }]).fetcher('https://feeds.example/a.ics'), { code: 'FEED_ENCODING' });
  await assert.rejects(harness([{ status: 404 }]).fetcher('https://feeds.example/a.ics'), { code: 'FEED_HTTP', message: '订阅源返回 HTTP 404。' });
  await assert.rejects(harness([{ error: new Error('TLS invalid certificate for secret-query') }]).fetcher('https://feeds.example/a.ics?key=secret-query'),
    error => error.code === 'FEED_CONNECTION' && !error.message.includes('secret-query'));
});

test('超时覆盖 DNS 阶段，取消的订阅不会继续发起 HTTP 请求', async () => {
  const fixture = harness(undefined, { timeoutMs: 10, lookup: async () => { await delay(35); return [publicAddress]; } });
  await assert.rejects(fixture.fetcher('https://feeds.example/ai.ics'), error => error.name === 'TimeoutError');
  await delay(40); assert.equal(fixture.requests.length, 0);
  const controller = new AbortController(); controller.abort();
  const cancelled = harness();
  await assert.rejects(cancelled.fetcher('https://feeds.example/ai.ics', { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(cancelled.dnsCalls.length, 0); assert.equal(cancelled.requests.length, 0);
});
