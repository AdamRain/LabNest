import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';
import { loadTransportConfig } from '../src/transport-config.mjs';
import { transportSecurity } from '../src/transport-security.mjs';

const password = 'Isolated-campus-transport-41!';
const transport = {
  mode: 'legacy-http', allowInsecureHttp: true, bindHost: '10.0.0.10', bindPort: 4173,
  publicOrigin: 'http://10.0.0.10:4173'
};
const environment = {
  NODE_ENV: 'production', LAB_TRANSPORT_MODE: 'legacy-http', LAB_ALLOW_INSECURE_HTTP: '1',
  LAB_HOST: '10.0.0.10', LAB_PORT: '4173', LAB_CANONICAL_URL: 'http://10.0.0.10:4173'
};

async function fixture(t, authLimits = {}) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const teacher = await accounts.createTeacher({ name: '兼容入口测试教师', email: 'teacher@campus.example', password });
  // The actual network fixture remains loopback-only; bind metadata models the independently validated startup configuration.
  const server = createLabServer({ db, transport, options: { authLimits } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client(initial = {}) {
    const cookies = new Map(Object.entries(initial)); let csrf = '';
    return {
      async go(path, form, extraHeaders = {}) {
        const init = { redirect: 'manual', headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extraHeaders } };
        if (form) { init.method = 'POST'; init.body = new URLSearchParams({ csrf, ...form }); }
        const response = await fetch(base + path, init); const text = await response.text();
        for (const cookie of response.headers.getSetCookie()) {
          assert.match(cookie, /^lab_(?:form|session)=/);
          assert.doesNotMatch(cookie, /__Host-|;\s*Secure\b/);
          assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Lax/);
          const [key, value] = cookie.split(';')[0].split('=');
          if (value) cookies.set(key, value); else cookies.delete(key);
        }
        csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
        return { response, text };
      },
      cookies
    };
  }
  return { accounts, teacher, client };
}

test('临时校园 HTTP 必须显式授权并绑定同一私网 IPv4 和端口，不能成为默认生产回退', () => {
  const config = loadTransportConfig(environment);
  assert.equal(config.host, '10.0.0.10'); assert.equal(config.port, 4173);
  assert.equal(config.canonicalUrl, 'http://10.0.0.10:4173');
  assert.deepEqual(config.transport, { ...transport, trustedProxies: [] });
  assert.equal(config.tls, null); assert.equal(config.redirectPort, null);
  for (const overrides of [
    { LAB_ALLOW_INSECURE_HTTP: undefined }, { LAB_ALLOW_INSECURE_HTTP: '0' }, { LAB_ALLOW_INSECURE_HTTP: 'true' },
    { LAB_TRANSPORT_MODE: undefined }, { LAB_HOST: '0.0.0.0' }, { LAB_HOST: '127.0.0.1' },
    { LAB_HOST: 'localhost' }, { LAB_HOST: '8.8.8.8' }, { LAB_HOST: '::' },
    { LAB_CANONICAL_URL: undefined }, { LAB_CANONICAL_URL: 'http://10.0.0.11:4173' },
    { LAB_CANONICAL_URL: 'http://10.0.0.10:4174' }, { LAB_CANONICAL_URL: 'https://10.0.0.10:4173' },
    { LAB_CANONICAL_URL: 'http://name.example:4173' }, { LAB_CANONICAL_URL: 'http://10.0.0.10:4173/login' },
    { LAB_CANONICAL_URL: 'http://user:secret@10.0.0.10:4173' },
    { LAB_TRUSTED_PROXIES: '127.0.0.1' }, { LAB_HTTP_REDIRECT_PORT: '4174' },
    { LAB_TLS_KEY_FILE: '/not-read/key.pem', LAB_TLS_CERT_FILE: '/not-read/cert.pem' }
  ]) assert.throws(() => loadTransportConfig({ ...environment, ...overrides }));
  for (const env of [{ NODE_ENV: 'production' }, { LAB_HOST: '0.0.0.0' },
    { NODE_ENV: 'production', LAB_ALLOW_INSECURE_HTTP: '1', LAB_HOST: '10.0.0.10' }]) {
    assert.throws(() => loadTransportConfig(env));
  }
  const validDefault = loadTransportConfig({}); assert.equal(validDefault.transport.mode, 'development');
});

test('HTTP 兼容策略不信任转发头，factory 缺少明确授权或混用 TLS 仍拒绝', () => {
  const connection = transportSecurity(transport);
  assert.equal(connection.secureCookies, false);
  const request = { socket: { remoteAddress: '::ffff:10.0.0.20' },
    headers: { 'x-forwarded-for': '8.8.8.8', 'x-forwarded-proto': 'https', forwarded: 'for=8.8.8.8;proto=https' } };
  assert.equal(connection.clientAddress(request), '10.0.0.20');
  const direct = transportSecurity();
  assert.throws(() => direct.assert(request), { statusCode: 426 });
  assert.throws(() => transportSecurity({ mode: 'tls' }).assert(request), { statusCode: 426 });
  assert.throws(() => connection.assert({ ...request, socket: { remoteAddress: undefined } }), { statusCode: 426 });
  for (const overrides of [{ allowInsecureHttp: false }, { allowInsecureHttp: '1' }, { bindHost: undefined },
    { bindPort: undefined }, { bindHost: '0.0.0.0' }, { bindHost: '192.168.1.1' }, { bindPort: 4174 },
    { publicOrigin: 'http://8.8.8.8:4173' }, { trustedProxies: ['127.0.0.1'] }]) {
    assert.throws(() => transportSecurity({ ...transport, ...overrides }));
  }
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => createLabServer({ db, transport: { mode: 'legacy-http' } }));
    assert.throws(() => createLabServer({ db, transport, tls: { key: 'not-a-key', cert: 'not-a-cert' } }), /TLS/);
  } finally { db.close(); }
});

test('已授权 HTTP 入口保留旧会话 Cookie，正常登录退出和 CSRF 保护保持可用', async t => {
  const { accounts, teacher, client } = await fixture(t);
  const oldSession = accounts.createSession(teacher.id);
  const existing = client({ lab_session: oldSession });
  assert.equal((await existing.go('/teacher')).response.status, 200);
  assert.equal((await existing.go('/logout', { csrf: 'wrong-token' })).response.status, 403);
  assert.ok(accounts.findSession(oldSession));
  assert.equal((await existing.go('/logout', {})).response.status, 303);
  assert.equal(accounts.findSession(oldSession), null);
  assert.equal((await existing.go('/teacher')).response.headers.get('location'), '/login');

  const guest = client(); assert.equal((await guest.go('/login')).response.status, 200);
  assert.equal((await guest.go('/login', { identifier: teacher.email, password, csrf: 'wrong-token' })).response.status, 403);
  assert.equal(guest.cookies.has('lab_session'), false);
  const signed = await guest.go('/login', { identifier: teacher.email, password });
  assert.equal(signed.response.status, 303); assert.equal(signed.response.headers.get('location'), '/teacher');
  assert.ok(guest.cookies.has('lab_session')); assert.equal((await guest.go('/teacher')).response.status, 200);
  assert.equal((await guest.go('/logout', {})).response.status, 303);
  assert.equal((await guest.go('/teacher')).response.headers.get('location'), '/login');
});

test('HTTP 兼容入口的来源预算始终按 socket 计数，变化转发 IP 不能绕过 S02', async t => {
  const { client } = await fixture(t, { loginIpLimit: 1, loginAccountLimit: 10 });
  const guest = client(); await guest.go('/login');
  const first = await guest.go('/login', { identifier: 'first@campus.example', password },
    { 'x-forwarded-for': '1.1.1.1', 'x-forwarded-proto': 'https' });
  assert.equal(first.response.status, 401);
  const second = await guest.go('/login', { identifier: 'second@campus.example', password },
    { 'x-forwarded-for': '8.8.8.8', 'x-forwarded-proto': 'https', forwarded: 'for=8.8.8.8' });
  assert.equal(second.response.status, 429);
  assert.ok(Number(second.response.headers.get('retry-after')) >= 1);
});
