import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { openAuthAbuse, createPasswordHashBudget } from '../src/auth-abuse.mjs';
import { createLabServer } from '../src/server.mjs';

const password = 'Isolated-auth-budget-test-83';
const application = email => ({ name: '限流测试学生', email, password, major: '计算机', level: 'graduate',
  studentStatus: 'active', studentNumber: '20260001', relationship: 'direct' });

async function fixture(t, authLimits = {}, { attacker = false } = {}) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const teacher = await accounts.createTeacher({ name: '限流测试教师', email: 'teacher@abuse.example', password });
  const own = attacker ? await accounts.register({ ...application('own@abuse.example'), phone: '13800008001' }) : null;
  const server = createLabServer({ db, options: { authLimits } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await setImmediate();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    const cookies = new Map();
    let csrf = '';
    return {
      async go(path, form = null) {
        const init = { redirect: 'manual', headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } };
        if (form) { init.method = 'POST'; init.body = new URLSearchParams({ csrf, ...form }); }
        const response = await fetch(base + path, init);
        const text = await response.text();
        for (const value of response.headers.getSetCookie()) {
          const [key, token] = value.split(';')[0].split('=');
          if (token) cookies.set(key, token); else cookies.delete(key);
        }
        csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
        return { response, text };
      }
    };
  }
  return { db, accounts, teacher, own, client };
}

test('登录自有待审核账号不重置其他目标的失败记录，额度到期后恢复', async t => {
  let now = 10_000;
  const { teacher, own, client, accounts } = await fixture(t,
    { loginAccountLimit: 3, loginIpLimit: 30, loginWindowMs: 1000, now: () => now }, { attacker: true });
  const guest = client();
  await guest.go('/');
  const fail = () => guest.go('/login', { identifier: teacher.email, password: 'Wrong-test-password-83' });
  assert.equal((await fail()).response.status, 401);
  for (let round = 0; round < 2; round++) {
    const signed = await guest.go('/login', { identifier: own.email, password });
    assert.equal(signed.response.status, 303);
    await guest.go('/student');
    assert.equal((await guest.go('/logout', {})).response.status, 303);
    await guest.go('/');
    assert.equal((await fail()).response.status, 401);
  }
  const blocked = await fail();
  assert.equal(blocked.response.status, 429);
  assert.ok(Number(blocked.response.headers.get('retry-after')) >= 1);
  assert.equal(accounts.getUser(own.id).reviewStatus, 'pending');
  now += 1001;
  assert.equal((await guest.go('/login', { identifier: teacher.email, password })).response.status, 303);
});

test('账号限额跨IP且持久化，邮箱/手机号使用同一目标，共享NAT正常登录不互相清零', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const accounts = openAccounts(db);
  await accounts.createTeacher({ name: '限流测试教师', email: 'teacher@abuse.example', password });
  const student = await accounts.register({ ...application('student@abuse.example'), phone: '13800008002' });
  const target = accounts.authenticationTarget(student.email);
  assert.equal(target, accounts.authenticationTarget('+86 13800008002'));
  assert.equal(target, accounts.authenticationTarget(' STUDENT@ABUSE.EXAMPLE '));
  let instant = 1000;
  const policy = { db, now: () => instant, loginAccountLimit: 2, loginWindowMs: 1000 };
  const first = openAuthAbuse(policy);
  first.login('ip-a', target); first.login('ip-b', target);
  first.login('ip-a', 'own'); first.loginSucceeded('own');
  const reopened = openAuthAbuse(policy);
  assert.throws(() => reopened.login('ip-c', target), error => error.statusCode === 429);
  for (let index = 0; index < 15; index++) {
    const name = `normal-member-${index}`;
    reopened.login('campus-shared-nat', name); reopened.loginSucceeded(name);
  }
  assert.equal(db.prepare('SELECT count(*) AS count FROM auth_rate_limits').get().count < 100, true);
  instant += 1001;
  assert.doesNotThrow(() => reopened.login('ip-c', target));
});

test('IP失败预算不会被成功登录清除；有界存储不淘汰仍有效的限流记录', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); openAccounts(db);
  let now = 1000;
  const limiter = openAuthAbuse({ db, now: () => now, loginIpLimit: 2, loginWindowMs: 1000 });
  limiter.login('same-ip', 'one'); limiter.loginSucceeded('one');
  limiter.login('same-ip', 'two'); limiter.loginSucceeded('two');
  assert.throws(() => limiter.login('same-ip', 'three'), error => error.statusCode === 429);
  const bounded = openAuthAbuse({ db, maxBuckets: 3, now: () => now, loginWindowMs: 1000 });
  assert.throws(() => bounded.login('new-ip', 'new-target'), error => error.statusCode === 503);
  assert.equal(db.prepare('SELECT count(*) AS total FROM auth_rate_limits').get().total <= 3, true);
  assert.throws(() => limiter.login('same-ip', 'three'), error => error.statusCode === 429);
  now += 1001;
  assert.doesNotThrow(() => bounded.login('new-ip', 'new-target'));
  assert.equal(db.prepare('SELECT count(*) AS total FROM auth_rate_limits').get().total, 3);
});

test('注册按来源和规范化邮箱在密码计算前限流，窗口后允许正常申请', async t => {
  let now = 1000;
  const f = await fixture(t, { registrationIpLimit: 2, registrationEmailLimit: 2,
    registrationWindowMs: 1000, now: () => now });
  async function register(email) {
    const user = f.client(); await user.go('/register');
    return user.go('/register', application(email));
  }
  assert.equal((await register('one@abuse.example')).response.status, 303);
  assert.equal((await register('two@abuse.example')).response.status, 303);
  const blocked = await register('three@abuse.example');
  assert.equal(blocked.response.status, 429);
  assert.ok(Number(blocked.response.headers.get('retry-after')) >= 1);
  assert.equal(f.accounts.listStudents().length, 2);
  now += 1001;
  assert.equal((await register('three@abuse.example')).response.status, 303);

  const limiter = openAuthAbuse({ db: f.db, registrationEmailLimit: 1, now: () => now });
  limiter.register('first-ip', ' CASE@ABUSE.EXAMPLE ');
  assert.throws(() => limiter.register('second-ip', 'case@abuse.example'), error => error.statusCode === 429);
});

test('待审上限在hash前检查且并发提交不能越过上限，审核后可释放名额', async t => {
  const f = await fixture(t, { maxPendingStudents: 1 });
  const results = await Promise.allSettled([
    f.accounts.register(application('first@abuse.example'), { maxPendingStudents: 1 }),
    f.accounts.register(application('second@abuse.example'), { maxPendingStudents: 1 })
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected' && row.reason.statusCode === 503).length, 1);
  await assert.rejects(f.accounts.register({ ...application('invalid@abuse.example'), password: 'x' },
    { maxPendingStudents: 1 }), error => error.statusCode === 503);
  const user = f.client(); await user.go('/register');
  const blocked = await user.go('/register', application('next@abuse.example'));
  assert.equal(blocked.response.status, 503);
  assert.equal(blocked.response.headers.get('retry-after'), '60');
  assert.match(blocked.text, /待审核申请较多/);
  assert.equal(f.accounts.listStudents().length, 1);
  f.accounts.reviewStudent(f.teacher.id, f.accounts.listStudents()[0].id, 'approved');
  assert.equal((await user.go('/register', application('next@abuse.example'))).response.status, 303);
});

test('哈希工作预算限制运行和等待数量，正常完成或失败都会释放容量', async () => {
  const budget = createPasswordHashBudget({ concurrency: 2, maxQueue: 1, waitMs: 1000 });
  const jobs = Array.from({ length: 3 }, () => Promise.withResolvers());
  const calls = jobs.map(job => budget.run(() => job.promise));
  await setImmediate();
  assert.deepEqual(budget.snapshot(), { active: 2, queued: 1 });
  await assert.rejects(budget.run(() => null), error => error.statusCode === 503 && error.code === 'AUTH_CAPACITY');
  jobs[0].resolve('first'); assert.equal(await calls[0], 'first');
  jobs[1].reject(new Error('isolated-operation-failed'));
  await assert.rejects(calls[1], /isolated-operation-failed/);
  jobs[2].resolve('last'); assert.equal(await calls[2], 'last');
  assert.deepEqual(budget.snapshot(), { active: 0, queued: 0 });
});

test('哈希等待超时不会继续排队或执行任务', async () => {
  const budget = createPasswordHashBudget({ concurrency: 1, maxQueue: 1, waitMs: 20 });
  const job = Promise.withResolvers(); let started = false;
  const active = budget.run(() => job.promise);
  const waiting = budget.run(() => { started = true; });
  await assert.rejects(waiting, error => error.statusCode === 503);
  assert.equal(started, false);
  assert.deepEqual(budget.snapshot(), { active: 1, queued: 0 });
  job.resolve(); await active;
  assert.deepEqual(budget.snapshot(), { active: 0, queued: 0 });
});
