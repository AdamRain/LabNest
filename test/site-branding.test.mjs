import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { crc32, deflateSync } from 'node:zlib';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';
import { inspectPhoto, photoLimit } from '../src/photo-validation.mjs';

const password = 'Branding-roles-only-test-43';
const original = readFileSync(new URL('../public/lab-logo.png', import.meta.url));
const pngChunk = (type, bytes) => {
  const body = Buffer.concat([Buffer.from(type), bytes]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(body)); return Buffer.concat([size, body, checksum]);
};
const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(1, 0); pngHeader.writeUInt32BE(1, 4); pngHeader[8] = 8; pngHeader[9] = 6;
const sampleLogo = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', pngHeader),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 16, 120, 90, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
const application = email => ({ name: '演示学生', email, password, level: 'graduate',
  major: '计算机', relationship: 'direct', studentStatus: 'active', studentNumber: '20260001' });

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const teacher = await accounts.createTeacher({ name: '教师', email: 'teacher@branding.example', password });
  const pending = await accounts.registerTeacher({ name: '待审教师', email: 'pending@branding.example', password });
  const student = await accounts.register(application('student@branding.example'));
  accounts.reviewStudent(teacher.id, student.id, 'approved');
  const server = createLabServer({ db }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    const cookies = new Map(); let csrf = '';
    return {
      async go(path, form = null) {
        const init = { redirect: 'manual', headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } };
        if (form) { init.method = 'POST'; if (form instanceof FormData) { form.set('csrf', form.get('csrf') ?? csrf); init.body = form; }
          else init.body = new URLSearchParams({ csrf, ...form }); }
        const response = await fetch(base + path, init); const bytes = Buffer.from(await response.arrayBuffer()); const text = bytes.toString();
        for (const cookie of response.headers.getSetCookie()) {
          const [key, value] = cookie.split(';')[0].split('='); if (value) cookies.set(key, value); else cookies.delete(key);
        }
        csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
        return { response, text, bytes };
      },
      async login(user) { await this.go('/login'); assert.equal((await this.go('/login', { identifier: user.email, password })).response.status, 303);
        await this.go(user.role === 'teacher' ? user.reviewStatus === 'approved' ? '/teacher/portal' : '/teacher/pending' : '/student'); }
    };
  }
  return { db, accounts, teacher, pending, student, base, client };
}
function upload(bytes = sampleLogo, name = 'logo.png', field = 'logo') {
  const form = new FormData(); form.set(field, new File([bytes], name, { type: 'image/png' })); return form;
}

test('门户可替换系统Logo，全站图片入口和预览立即使用新图，重开服务器保留并可恢复原图', async t => {
  const f = await fixture(t), editor = f.client(), visitor = f.client(); await editor.login(f.teacher);
  assert.match((await editor.go('/teacher/portal')).text, /系统 Logo|保存 Logo/);
  assert.deepEqual((await visitor.go('/lab-logo.png')).bytes, original);
  const stored = inspectPhoto(sampleLogo).data; assert.notDeepEqual(stored, original);
  const saved = await editor.go('/teacher/portal/logo', upload()); assert.equal(saved.response.status, 303);
  assert.equal(saved.response.headers.get('location'), '/teacher/portal?done=logo');
  assert.equal(f.db.prepare('SELECT updated_by FROM site_logo').get().updated_by, f.teacher.id);
  const logo = await visitor.go('/lab-logo.png'); assert.deepEqual(logo.bytes, stored);
  assert.equal(logo.response.headers.get('content-type'), 'image/png'); assert.equal(logo.response.headers.get('cache-control'), 'no-cache');
  assert.equal(logo.response.headers.get('x-content-type-options'), 'nosniff');
  const head = await fetch(f.base + '/lab-logo.png', { method: 'HEAD' }); assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(stored.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.match((await editor.go('/teacher/portal')).text, /恢复默认 Logo/);
  const restarted = createLabServer({ db: f.db }); restarted.listen(0, '127.0.0.1'); await once(restarted, 'listening');
  try { const r = await fetch(`http://127.0.0.1:${restarted.address().port}/lab-logo.png`); assert.deepEqual(Buffer.from(await r.arrayBuffer()), stored); }
  finally { await new Promise(resolve => restarted.close(resolve)); }
  assert.equal((await editor.go('/teacher/portal/logo/restore', {})).response.status, 303);
  assert.deepEqual((await visitor.go('/lab-logo.png')).bytes, original);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM site_logo').get().n, 0);
});

test('Logo修改校验身份、审核与CSRF，学生和待审教师不能修改或恢复', async t => {
  const f = await fixture(t);
  for (const user of [null, f.pending, f.student]) {
    const client = f.client(); if (user) await client.login(user); else await client.go('/login');
    assert.equal((await client.go('/teacher/portal/logo', upload())).response.status, 403);
    assert.equal((await client.go('/teacher/portal/logo/restore', {})).response.status, 403);
  }
  const editor = f.client(); await editor.login(f.teacher); const bad = upload(); bad.set('csrf', 'invalid');
  assert.equal((await editor.go('/teacher/portal/logo', bad)).response.status, 403);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM site_logo').get().n, 0);
});

test('Logo拒绝SVG、损坏图片、超限及多文件，错误不覆盖已保存Logo', async t => {
  const f = await fixture(t), editor = f.client(); await editor.login(f.teacher);
  assert.equal((await editor.go('/teacher/portal/logo', upload())).response.status, 303);
  const checks = [
    [upload(Buffer.from('<svg onload="alert(1)"></svg>'), 'fake.png'), 422],
    [upload(Buffer.from('not an image'), 'bad.png'), 422],
    [upload(Buffer.alloc(photoLimit + 1)), 413],
    [upload(Buffer.alloc(0)), 422],
    [upload(original, 'logo.png', 'attachments'), 422]
  ];
  const duplicate = upload(); duplicate.append('logo', new File([original], 'duplicate.png')); checks.push([duplicate, 422]);
  for (const [form, status] of checks) assert.equal((await editor.go('/teacher/portal/logo', form)).response.status, status);
  assert.deepEqual((await editor.go('/lab-logo.png')).bytes, inspectPhoto(sampleLogo).data);
});
