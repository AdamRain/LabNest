import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';
import { createHttpsRedirect, transportSecurity, normalizeAddress } from '../src/transport-security.mjs';
import { loadTransportConfig } from '../src/transport-config.mjs';

const password = 'Transport-test-password-53';
let material;
function certificate(t) {
  if (!material) {
    const dir = mkdtempSync(join(tmpdir(), 'lab-tls-test-'));
    const keyFile = join(dir, 'key.pem'), certFile = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
      '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth'], { stdio: 'ignore' });
    material = { dir, keyFile, certFile, key: readFileSync(keyFile), cert: readFileSync(certFile) };
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return material;
}

function call(server, path, { secure = true, ca, body, headers = {}, method = body ? 'POST' : 'GET', ...rest } = {}) {
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)({ hostname: '127.0.0.1', port: server.address().port,
      path, method, ca, headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      timeout: 3000, agent: false, ...rest }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', data => { text += data; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('request deadline')));
    req.end(body);
  });
}

async function listening(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return server;
}

test('S01: HTTPS uses verified certificates, host-prefixed Secure cookies, CSRF and normal login/logout', async t => {
  const { key, cert } = certificate(t);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const accounts = openAccounts(db);
  const teacher = await accounts.createTeacher({ name: '传输测试教师', email: 'teacher@transport.example', password });
  const server = await listening(t, createLabServer({ db, tls: { key, cert } }));
  const jar = new Map(); let csrf = '';
  async function go(path, form) {
    const response = await call(server, path, { ca: cert,
      headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: form ? new URLSearchParams({ csrf, ...form }).toString() : undefined });
    for (const cookie of response.headers['set-cookie'] ?? []) {
      assert.match(cookie, /^__Host-lab_(form|session)=/);
      assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Lax; Secure/);
      assert.doesNotMatch(cookie, /; Domain=/i);
      const [name, value] = cookie.split(';')[0].split('=');
      if (value) jar.set(name, value); else jar.delete(name);
    }
    csrf = response.text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
    return response;
  }
  assert.equal((await go('/')).status, 200);
  assert.equal((await go('/login', { identifier: teacher.email, password, csrf: 'wrong' })).status, 403);
  const signed = await go('/login', { identifier: teacher.email, password });
  assert.equal(signed.status, 303); assert.equal(signed.headers.location, '/teacher');
  assert.equal((await go('/teacher')).status, 200);
  assert.equal((await go('/logout', {})).status, 303);
  assert.equal((await go('/teacher')).headers.location, '/login');
  await assert.rejects(call(server, '/'), error => /CERT|SELF_SIGNED/.test(error.code));
  await assert.rejects(call(server, '/', { ca: cert, servername: 'wrong.example' }),
    error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('S01: HTTP redirect has a fixed HTTPS destination and rejects sensitive POST before application access', async t => {
  const server = await listening(t, createHttpsRedirect('https://lab.example'));
  const response = await call(server, '/login?next=1', { secure: false, headers: { Host: 'attacker.example' } });
  assert.equal(response.status, 308); assert.equal(response.headers.location, 'https://lab.example/login?next=1');
  const absolute = await call(server, 'http://attacker.example/register?q=1', { secure: false });
  assert.equal(absolute.headers.location, 'https://lab.example/register?q=1');
  assert.equal((await call(server, 'javascript:evil.example', { secure: false })).status, 400);
  const slashes = await call(server, '//attacker.example/path', { secure: false });
  assert.equal(new URL(slashes.headers.location).origin, 'https://lab.example');
  assert.equal((await call(server, '/', { secure: false, method: 'HEAD' })).status, 308);
  const post = await call(server, '/register', { secure: false, body: 'password=never-replayed' });
  assert.equal(post.status, 426); assert.equal(post.headers.location, undefined);
  assert.equal(post.headers['set-cookie'], undefined); assert.equal(post.headers['cache-control'], 'no-store');
});

test('S01: direct transport ignores spoofed proxy headers; proxy trusts only exact peers and single validated addresses', () => {
  const req = (peer, headers = {}, encrypted = false) => ({ socket: { remoteAddress: peer, encrypted }, headers });
  const direct = transportSecurity({ mode: 'tls' });
  assert.equal(direct.clientAddress(req('::ffff:10.1.2.3', { 'x-forwarded-for': '8.8.8.8' }, true)), '10.1.2.3');
  assert.throws(() => direct.assert(req('127.0.0.1')), { statusCode: 426 });
  const development = transportSecurity();
  assert.equal(development.clientAddress(req('127.0.0.1')), '127.0.0.1');
  assert.throws(() => development.assert(req('10.1.2.3')), { statusCode: 426 });
  const proxy = transportSecurity({ mode: 'proxy', trustedProxies: ['127.0.0.1', '::1'], publicOrigin: 'https://lab.example' });
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.20.30.40' };
  assert.equal(proxy.clientAddress(req('127.0.0.1', headers)), '10.20.30.40');
  for (const [peer, values] of [['10.0.0.1', headers], ['127.0.0.1', {}],
    ['127.0.0.1', { ...headers, 'x-forwarded-proto': 'http' }],
    ['127.0.0.1', { ...headers, 'x-forwarded-for': '10.1.1.1, 10.2.2.2' }],
    ['127.0.0.1', { ...headers, 'x-forwarded-for': ['10.1.1.1', '10.2.2.2'] }]]) {
    assert.throws(() => proxy.assert(req(peer, values)), { statusCode: 426 });
  }
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('fe80::1%en0'), '');
});

test('S01: proxy distinguishes real client limits and rejects bypass before issuing cookies', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const server = await listening(t, createLabServer({ db, options: { authLimits: { loginIpLimit: 1 } },
    transport: { mode: 'proxy', trustedProxies: ['127.0.0.1'], publicOrigin: 'https://lab.example' } }));
  const denied = await call(server, '/', { secure: false });
  assert.equal(denied.status, 426); assert.equal(denied.headers['set-cookie'], undefined);
  async function fail(ip, name) {
    const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-for': ip };
    const page = await call(server, '/login', { secure: false, headers });
    const csrf = page.text.match(/name="csrf"\s+value="([^"]+)"/)[1];
    const Cookie = page.headers['set-cookie'].map(cookie => cookie.split(';')[0]).join('; ');
    assert.match(Cookie, /^__Host-/);
    return call(server, '/login', { secure: false, headers: { ...headers, Cookie },
      body: new URLSearchParams({ csrf, identifier: `${name}@transport.example`, password }).toString() });
  }
  assert.equal((await fail('10.1.1.1', 'first')).status, 401);
  assert.equal((await fail('10.1.1.1', 'second')).status, 429);
  assert.equal((await fail('10.2.2.2', 'third')).status, 401);
});

test('S01: unsafe production HTTP and incomplete TLS fail closed; invalid key never starts a fallback listener', () => {
  const material = certificate();
  assert.equal(loadTransportConfig({}).transport.mode, 'development');
  for (const env of [{ LAB_HOST: '0.0.0.0' }, { NODE_ENV: 'production' }, { LAB_TRANSPORT_MODE: 'tls' },
    { LAB_TLS_KEY_FILE: material.keyFile }, { LAB_TRANSPORT_MODE: 'proxy' },
    { LAB_TRANSPORT_MODE: 'proxy', LAB_HOST: '0.0.0.0', LAB_CANONICAL_URL: 'https://lab.example', LAB_TRUSTED_PROXIES: '127.0.0.1' },
    { LAB_TLS_KEY_FILE: material.keyFile, LAB_TLS_CERT_FILE: material.certFile, LAB_CANONICAL_URL: 'http://lab.example' }]) {
    assert.throws(() => loadTransportConfig(env));
  }
  const config = loadTransportConfig({ LAB_PORT: '18443', LAB_TLS_KEY_FILE: material.keyFile,
    LAB_TLS_CERT_FILE: material.certFile, LAB_HTTP_REDIRECT_PORT: '4173' });
  assert.equal(config.canonicalUrl, 'https://127.0.0.1:18443'); assert.equal(config.redirectPort, 4173);
  const db = new DatabaseSync(':memory:');
  try { assert.throws(() => createLabServer({ db, tls: { key: 'invalid-private-key', cert: material.cert } })); }
  finally { db.close(); }
});

test('S01: secure transport never sends HTTP reset links or saves a plaintext reset origin', async t => {
  const { key, cert } = certificate();
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const accounts = openAccounts(db);
  const teacher = await accounts.createAdmin({ name: '邮件传输测试', email: 'mail@transport.example', password });
  const inbox = []; let saved = 0;
  const mailer = { configured: true, publicOrigin: 'http://127.0.0.1:18443',
    async sendPasswordReset(message) { inbox.push(message); } };
  const settings = { mailer: () => mailer, publicView: () => ({ publicUrl: mailer.publicOrigin }), save: () => saved++ };
  const server = await listening(t, createLabServer({ db, tls: { key, cert }, mailSettings: settings,
    mailDefaultOrigin: 'https://127.0.0.1:18443' }));
  const jar = new Map(); let csrf = '';
  async function go(path, form) {
    const result = await call(server, path, { ca: cert,
      headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: form ? new URLSearchParams({ csrf, ...form }).toString() : undefined });
    for (const cookie of result.headers['set-cookie'] ?? []) {
      const [name, value] = cookie.split(';')[0].split('=');
      if (value) jar.set(name, value); else jar.delete(name);
    }
    csrf = result.text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
    return result;
  }
  await go('/');
  assert.equal((await go('/forgot-password', { email: teacher.email })).status, 503);
  assert.equal(inbox.length, 0);
  mailer.publicOrigin = 'https://127.0.0.1:18443';
  assert.equal((await go('/forgot-password', { email: teacher.email })).status, 303);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(new URL(inbox[0].resetUrl).protocol, 'https:');
  assert.equal((await go('/login', { identifier: teacher.email, password })).status, 303);
  await go('/admin/mail');
  assert.equal((await go('/admin/mail', { publicUrl: 'http://127.0.0.1:18443' })).status, 400);
  assert.equal(saved, 0);
});
