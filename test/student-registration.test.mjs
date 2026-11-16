import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';

const password = 'Registration-test-password-71';

function application(overrides = {}) {
  return {
    name: '注册测试学生', email: 'student@registration.example', phone: '',
    level: 'graduate', studentStatus: 'active', studentNumber: '20260571',
    major: '计算机', relationship: 'direct', password, ...overrides
  };
}

async function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const teacher = await accounts.createTeacher({
    name: '注册测试教师', email: 'teacher@registration.example', password
  });
  const inbox = [];
  const resetMailer = {
    configured: true, publicOrigin: 'https://lab.registration.example',
    async sendPasswordReset(message) { inbox.push(message); return { accepted: true }; }
  };
  const server = createLabServer({ db, resetMailer, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await setImmediate();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  function client() {
    const cookies = new Map();
    let csrf = '';
    return {
      async go(path, form = null) {
        const init = {
          redirect: 'manual',
          headers: { Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') }
        };
        if (form) {
          init.method = 'POST';
          init.body = new URLSearchParams({ csrf, ...form });
        }
        const response = await fetch(base + path, init);
        const text = await response.text();
        for (const cookie of response.headers.getSetCookie()) {
          const [key, value] = cookie.split(';')[0].split('=');
          if (value) cookies.set(key, value); else cookies.delete(key);
        }
        csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
        return { response, text };
      }
    };
  }
  return { accounts, teacher, inbox, client };
}

test('两种首页模式的登录页均有学生注册入口，注册邮箱必填且说明找回用途', async t => {
  for (const publicHome of [false, true]) {
    const { client } = await fixture(t, publicHome ? { publicHome: true } : {});
    const guest = client();
    for (const path of publicHome ? ['/login'] : ['/', '/login']) {
      const page = await guest.go(path);
      assert.equal(page.response.status, 200);
      assert.match(page.text, /href="\/register"/);
      assert.match(page.text, /学生注册/);
    }
    const registration = await guest.go('/register');
    assert.equal(registration.response.status, 200);
    const emailInput = registration.text.match(/<input\b[^>]*\bname="email"[^>]*>/)?.[0];
    assert.ok(emailInput);
    assert.match(emailInput, /\btype="email"/);
    assert.match(emailInput, /\brequired(?:\s|>)/);
    assert.match(registration.text, /邮箱用于登录和找回密码/);
    const phoneInput = registration.text.match(/<input\b[^>]*\bname="phone"[^>]*>/)?.[0];
    assert.ok(phoneInput);
    assert.doesNotMatch(phoneInput, /\brequired(?:\s|>)/);
  }
});

test('仅手机号或非法邮箱不建号；成功注册绑定规范化邮箱、待审核且无教师权限，邮箱不可重复', async t => {
  const { accounts, teacher, client } = await fixture(t);
  const applicant = client();
  await applicant.go('/register');
  for (const email of [undefined, '  ', 'invalid-email']) {
    const form = application({ email, phone: '13800005701' });
    if (email === undefined) delete form.email;
    const failed = await applicant.go('/register', form);
    assert.equal(failed.response.status, 400);
    assert.equal(accounts.listStudents().length, 0);
    assert.doesNotMatch(failed.text, /Registration-test-password-71/);
  }

  const registered = await applicant.go('/register', application({
    email: '  New.Student@Registration.Example  ', role: 'teacher', reviewStatus: 'approved'
  }));
  assert.equal(registered.response.status, 303);
  assert.equal(registered.response.headers.get('location'), '/student?done=registered');
  const [student] = accounts.listStudents();
  assert.equal(student.email, 'new.student@registration.example');
  assert.equal(student.role, 'student');
  assert.equal(student.reviewStatus, 'pending');
  assert.equal((await accounts.authenticate(student.email, password)).id, student.id);
  const progress = await applicant.go('/student?done=registered');
  assert.equal(progress.response.status, 200);
  assert.match(progress.text, /等待教师审核|请等教师审核/);
  assert.equal((await applicant.go('/teacher')).response.status, 403);
  assert.equal((await applicant.go('/teacher/students/' + student.id + '/review', {
    decision: 'approved'
  })).response.status, 403);
  assert.equal(accounts.getUser(teacher.id).role, 'teacher');
  assert.equal(accounts.getUser(student.id).reviewStatus, 'pending');

  const duplicate = client();
  await duplicate.go('/register');
  assert.equal((await duplicate.go('/register', application({
    email: 'NEW.STUDENT@REGISTRATION.EXAMPLE'
  }))).response.status, 409);
  assert.equal(accounts.listStudents().length, 1);
});

test('学生重提申请和保存资料时不能清空、损坏或重复绑定邮箱', async t => {
  const { accounts, teacher, client } = await fixture(t);
  const applicant = client();
  await applicant.go('/register');
  assert.equal((await applicant.go('/register', application())).response.status, 303);
  const [student] = accounts.listStudents();
  accounts.reviewStudent(teacher.id, student.id, 'rejected', '请补全资料');
  const reapply = await applicant.go('/student');
  assert.match(reapply.text, /name="email"[^>]*\brequired(?:\s|>)/);
  for (const [email, status] of [['', 400], ['student@localhost', 400], [teacher.email, 409]]) {
    assert.equal((await applicant.go('/student/reapply', application({
      email, phone: '13800005702'
    }))).response.status, status);
    const unchanged = accounts.getUser(student.id);
    assert.equal(unchanged.email, student.email);
    assert.equal(unchanged.phone, student.phone);
    assert.equal(unchanged.reviewStatus, 'rejected');
  }
  assert.equal((await applicant.go('/student/reapply', application({
    email: ' STUDENT@REGISTRATION.EXAMPLE '
  }))).response.status, 303);
  assert.equal(accounts.getUser(student.id).reviewStatus, 'pending');
  accounts.reviewStudent(teacher.id, student.id, 'approved');

  const profile = await applicant.go('/student/profile');
  assert.equal(profile.response.status, 200);
  assert.match(profile.text, /name="email"[^>]*\brequired(?:\s|>)/);
  for (const [email, status] of [['  ', 400], ['invalid-email', 400], [teacher.email, 409]]) {
    assert.equal((await applicant.go('/student/profile', {
      email, phone: '13800005702'
    })).response.status, status);
    assert.equal(accounts.getUser(student.id).email, student.email);
    assert.equal(accounts.getUser(student.id).phone, student.phone);
  }
  const saved = await applicant.go('/student/profile', {
    email: ' Updated.Student@Registration.Example ', phone: ''
  });
  assert.equal(saved.response.status, 303);
  assert.equal(saved.response.headers.get('location'), '/student?done=profileReview');
  assert.equal(accounts.getUser(student.id).email, 'updated.student@registration.example');
  assert.equal(accounts.getUser(student.id).reviewStatus, 'pending');
});

test('新注册的待审核学生可以通过绑定邮箱找回，模拟邮件只发往该邮箱', async t => {
  const { accounts, inbox, client } = await fixture(t);
  const applicant = client();
  await applicant.go('/register');
  assert.equal((await applicant.go('/register', application({
    email: ' Recover.Student@Registration.Example ', phone: '13800005703'
  }))).response.status, 303);
  const [student] = accounts.listStudents();
  assert.equal(student.reviewStatus, 'pending');

  const recovery = client();
  const forgot = await recovery.go('/forgot-password');
  assert.match(forgot.text, /账号绑定的邮箱/);
  const requested = await recovery.go('/forgot-password', {
    email: ' RECOVER.STUDENT@REGISTRATION.EXAMPLE '
  });
  assert.equal(requested.response.status, 303);
  assert.equal(requested.response.headers.get('location'), '/forgot-password?sent=1');
  await setImmediate();
  assert.deepEqual(inbox.map(message => message.to), [student.email]);
  const resetUrl = new URL(inbox[0].resetUrl);
  assert.equal(resetUrl.origin, 'https://lab.registration.example');
  assert.equal(accounts.getPasswordReset(resetUrl.searchParams.get('token')).id, student.id);

  assert.equal((await recovery.go('/forgot-password', {
    email: 'unbound@registration.example'
  })).response.status, 303);
  await setImmediate();
  assert.deepEqual(inbox.map(message => message.to), [student.email]);
});
