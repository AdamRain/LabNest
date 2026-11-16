import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { openMailSettings } from '../src/mail-settings.mjs';
import { createLabServer } from '../src/server.mjs';

const oldPassword = 'Original-password-42';
const newPassword = 'Replacement-password-42';

async function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const administrator = await accounts.createAdmin({ name: '测试管理员', email: 'admin@reset.example', password: oldPassword });
  const teacher = await accounts.createTeacher({ name: '测试教师', email: 'teacher@reset.example', password: oldPassword });
  const student = await accounts.register({ name: '测试学生', email: 'student@reset.example', level: 'graduate',
    studentStatus: 'active', studentNumber: '20260001', major: '计算机', relationship: 'direct', password: oldPassword });
  accounts.reviewStudent(teacher.id, student.id, 'approved');
  const inbox = [];
  const resetMailer = { configured: true, publicOrigin: 'https://lab.example',
    async sendPasswordReset(message) { inbox.push(message); return { accepted: true }; } };
  const server = createLabServer({ db, resetMailer, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await setImmediate(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    const cookies = new Map();
    let csrf = '';
    return {
      async go(path, form = null, extraHeaders = {}) {
        const init = { redirect: 'manual', headers: { Cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '), ...extraHeaders } };
        if (form) { init.method = 'POST'; init.body = new URLSearchParams({ csrf, ...form }); }
        const response = await fetch(base + path, init);
        const text = await response.text();
        for (const cookie of response.headers.getSetCookie()) {
          const [key, value] = cookie.split(';')[0].split('=');
          if (value) cookies.set(key, value); else cookies.delete(key);
        }
        csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
        return { response, text };
      },
      async login(identifier, password = oldPassword) {
        await this.go('/');
        return this.go('/login', { identifier, password });
      }
    };
  }
  return { db, accounts, administrator, teacher, student, inbox, client };
}

test('未配置时如实提示；眼睛与找回入口存在；失效链接不输出令牌', async t => {
  const { client, inbox } = await fixture(t, { resetMailer: null });
  const guest = client();
  const home = await guest.go('/');
  assert.match(home.text, /href="\/forgot-password"/);
  assert.match(home.text, /data-password-toggle aria-controls="login-password" aria-label="显示密码"/);
  const forgot = await guest.go('/forgot-password');
  assert.match(forgot.text, /邮件找回尚未启用/);
  assert.doesNotMatch(forgot.text, /action="\/forgot-password"/);
  assert.equal((await guest.go('/forgot-password', { email: 'student@reset.example' })).response.status, 503);
  const invalid = await guest.go('/reset-password?token=' + 'A'.repeat(43));
  assert.match(invalid.text, /链接已失效/);
  assert.doesNotMatch(invalid.text, /name="resetToken"/);
  assert.equal(invalid.response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(invalid.response.headers.get('cache-control'), 'no-store');
  assert.equal(inbox.length, 0);
});

test('申请结果一致，只寄给已绑定邮箱，邮件链接不信任请求的 Host', async t => {
  const { client, inbox, student } = await fixture(t);
  const guest = client();
  await guest.go('/forgot-password');
  const known = await guest.go('/forgot-password', { email: student.email }, { Host: 'attacker.example' });
  const unknown = await guest.go('/forgot-password', { email: 'unknown@reset.example' });
  assert.equal(known.response.status, 303);
  assert.equal(unknown.response.status, 303);
  assert.equal(known.response.headers.get('location'), unknown.response.headers.get('location'));
  await setImmediate();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].to, student.email);
  assert.equal(new URL(inbox[0].resetUrl).origin, 'https://lab.example');
  const sent = await guest.go('/forgot-password?sent=1');
  assert.doesNotMatch(sent.text, /student@reset.example|unknown@reset.example/);
});

test('师生完成重置后新密码可登录，旧密码、链接与所有旧会话失效', async t => {
  const { client, accounts, student, teacher, inbox } = await fixture(t);
  for (const user of [student, teacher]) {
    const oldSession = accounts.createSession(user.id);
    const oldBrowser = client();
    assert.equal((await oldBrowser.login(user.email)).response.status, 303);
    const guest = client();
    await guest.go('/forgot-password');
    assert.equal((await guest.go('/forgot-password', { email: user.email })).response.status, 303);
    await setImmediate();
    const url = new URL(inbox.at(-1).resetUrl);
    const resetToken = url.searchParams.get('token');
    const page = await guest.go(url.pathname + url.search);
    assert.match(page.text, /name="resetToken"/);
    assert.equal(page.response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await guest.go('/reset-password', { resetToken, password: newPassword, confirmPassword: newPassword, csrf: 'bad' })).response.status, 403);
    const mismatch = await guest.go('/reset-password', { resetToken, password: newPassword, confirmPassword: 'different-password' });
    assert.equal(mismatch.response.status, 400);
    assert.match(mismatch.text, /两次输入的密码不一致/);
    assert.doesNotMatch(mismatch.text, /Replacement-password-42|different-password/);
    const done = await guest.go('/reset-password', { resetToken, password: newPassword, confirmPassword: newPassword });
    assert.equal(done.response.status, 303);
    assert.equal(done.response.headers.get('location'), '/login?done=password-reset');
    assert.match((await guest.go(done.response.headers.get('location'))).text, /密码已更新/);
    assert.equal(accounts.findSession(oldSession), null);
    assert.equal((await oldBrowser.go('/' + user.role)).response.headers.get('location'), '/login');
    assert.equal(await accounts.authenticate(user.email, oldPassword), null);
    const newBrowser = client();
    const login = await newBrowser.login(user.email, newPassword);
    assert.equal(login.response.headers.get('location'), '/' + user.role);
    assert.equal((await guest.go('/reset-password', { resetToken, password: newPassword, confirmPassword: newPassword })).response.status, 400);
  }
});

test('申请具备 CSRF 与频率限制，重复申请不重复发信', async t => {
  const { client, student, inbox } = await fixture(t);
  const guest = client();
  await guest.go('/forgot-password');
  assert.equal((await guest.go('/forgot-password', { csrf: 'bad', email: student.email })).response.status, 403);
  assert.equal((await guest.go('/forgot-password', { email: 'invalid' })).response.status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await guest.go('/forgot-password', { email: student.email })).response.status, 303);
  await setImmediate();
  assert.equal(inbox.length, 1);
  const limited = await guest.go('/forgot-password', { email: student.email });
  assert.equal(limited.response.status, 429);
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
});

test('发信失败不保留可用链接，申请页不泄露邮箱或 SMTP 错误', async t => {
  const logs = [];
  t.mock.method(console, 'error', value => logs.push(value));
  const resetMailer = { configured: true, publicOrigin: 'https://lab.example',
    async sendPasswordReset() { throw new Error('SMTP secret must not appear'); } };
  const { client, student, db } = await fixture(t, { resetMailer });
  const guest = client();
  await guest.go('/forgot-password');
  assert.equal((await guest.go('/forgot-password', { email: student.email })).response.status, 303);
  await setImmediate();
  assert.equal(db.prepare('SELECT count(*) AS n FROM password_reset_tokens').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM password_reset_requests').get().n, 1);
  assert.doesNotMatch(logs.join(' '), /SMTP secret|student@reset.example/);
});

test('仅管理员能保存发件配置，教师不能改动找回渠道；授权码不回显、留空保留、可停用', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'lab-mail-settings-http.'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  const mailSettings = openMailSettings({ file, env: {} });
  const { client, teacher, student, administrator } = await fixture(t, { mailSettings, mailDefaultOrigin: 'http://127.0.0.1:4173' });
  const guest = client();
  assert.equal((await guest.go('/admin/mail')).response.headers.get('location'), '/login');
  const studentBrowser = client();
  await studentBrowser.login(student.email);
  assert.equal((await studentBrowser.go('/admin/mail')).response.status, 403);
  const admin = client();
  const teacherBrowser = client();
  await teacherBrowser.login(teacher.email);
  for (const path of ['/admin/mail', '/teacher/mail']) {
    assert.equal((await teacherBrowser.go(path)).response.status, 403);
    assert.equal((await teacherBrowser.go(path, { smtpHost: 'attacker.example' })).response.status, 403);
  }
  await admin.login(administrator.email);
  assert.match((await admin.go('/admin/mail')).text, /邮件找回尚未启用/);
  const settings = { smtpHost: 'smtp.example.test', smtpPort: '465', smtpUser: 'sender@example.test',
    smtpPassword: 'test-only-authorization', smtpFrom: '', publicUrl: 'http://127.0.0.1:4173' };
  assert.equal((await admin.go('/admin/mail', { ...settings, csrf: 'bad' })).response.status, 403);
  assert.equal((await admin.go('/admin/mail', settings)).response.status, 303);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = await admin.go('/admin/mail');
  assert.doesNotMatch(saved.text, /test-only-authorization/);
  assert.match(saved.text, /授权码已保存，保存后不再显示/);
  assert.match(saved.text, /placeholder="已保存，留空保留"/);
  assert.doesNotMatch(saved.text, /name="smtpPassword"[^>]*\bvalue=/);
  assert.match(saved.text, /留空保留/);
  assert.equal((await admin.go('/admin/mail', { ...settings, smtpPassword: '' })).response.status, 303);
  assert.ok(mailSettings.publicView().hasPassword);
  const invalid = await admin.go('/admin/mail', { ...settings, smtpHost: 'bad host', smtpPassword: 'must-not-echo' });
  assert.equal(invalid.response.status, 400);
  assert.doesNotMatch(invalid.text, /must-not-echo/);
  assert.match((await guest.go('/forgot-password')).text, /action="\/forgot-password"/);
  assert.equal((await admin.go('/admin/mail/disable', {})).response.status, 303);
  assert.match((await guest.go('/forgot-password')).text, /邮件找回尚未启用/);
});
