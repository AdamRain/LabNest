import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openAccounts } from '../src/accounts.mjs';

const oldPassword = 'Initial-test-password-42';
const newPassword = 'Replacement-test-password-42';

function application(email) {
  return {
    name: '安全测试学生', email, phone: '', level: 'graduate', studentStatus: 'active',
    studentNumber: '20260001', major: '计算机', relationship: 'direct', activities: [], password: oldPassword
  };
}

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const accounts = openAccounts(db);
  const teacher = await accounts.createTeacher({
    name: '安全测试教师', email: 'teacher@security.example', password: oldPassword
  });
  return { db, accounts, teacher };
}

function ageRequests(db, id) {
  db.prepare('UPDATE password_reset_requests SET created_at = created_at - 61000 WHERE user_id = ?').run(id);
}

function rejectsReset(promise) {
  return assert.rejects(promise, error => error.statusCode === 400);
}

test('reset links are opaque, hashed, expire, and only the latest link works', async t => {
  const { db, accounts, teacher } = await fixture(t);
  assert.equal(accounts.issuePasswordReset('missing@security.example'), null);
  assert.equal(accounts.issuePasswordReset('invalid'), null);
  assert.equal(accounts.issuePasswordReset(null), null);

  const first = accounts.issuePasswordReset('  TEACHER@SECURITY.EXAMPLE  ');
  assert.equal(first.user.id, teacher.id);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  const record = db.prepare('SELECT * FROM password_reset_tokens WHERE user_id = ?').get(teacher.id);
  assert.notEqual(record.token_hash, first.token);
  assert.equal(record.token_hash, createHash('sha256').update(first.token).digest('hex'));
  assert.equal(record.expires_at - record.created_at, 15 * 60 * 1000);
  assert.equal(accounts.getPasswordReset(first.token).id, teacher.id);
  assert.equal(accounts.getPasswordReset('invalid'), null);
  assert.equal(accounts.getPasswordReset('A'.repeat(43)), null);

  ageRequests(db, teacher.id);
  const latest = accounts.issuePasswordReset(teacher.email);
  assert.equal(accounts.getPasswordReset(first.token), null);
  await rejectsReset(accounts.completePasswordReset(first.token, newPassword));
  assert.equal(accounts.getPasswordReset(latest.token).id, teacher.id);

  db.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, teacher.id);
  assert.equal(accounts.getPasswordReset(latest.token), null);
  await rejectsReset(accounts.completePasswordReset(latest.token, newPassword));
  assert.equal((await accounts.authenticate(teacher.email, oldPassword)).id, teacher.id);
});

test('reset enforces password policy, permits one concurrent redemption, and revokes all old sessions', async t => {
  const { accounts, teacher } = await fixture(t);
  const issue = accounts.issuePasswordReset(teacher.email);
  const sessionA = accounts.createSession(teacher.id);
  const sessionB = accounts.createSession(teacher.id);

  await rejectsReset(accounts.completePasswordReset(issue.token, 'short'));
  assert.ok(accounts.getPasswordReset(issue.token));
  assert.ok(accounts.findSession(sessionA));
  assert.ok(accounts.findSession(sessionB));

  const results = await Promise.allSettled([
    accounts.completePasswordReset(issue.token, newPassword),
    accounts.completePasswordReset(issue.token, newPassword)
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 400);
  assert.equal(accounts.findSession(sessionA), null);
  assert.equal(accounts.findSession(sessionB), null);
  assert.equal(accounts.getPasswordReset(issue.token), null);
  assert.equal(await accounts.authenticate(teacher.email, oldPassword), null);
  assert.equal((await accounts.authenticate(teacher.email, newPassword)).id, teacher.id);
  await rejectsReset(accounts.completePasswordReset(issue.token, newPassword));
});

test('profile and resubmission email changes permanently invalidate prior reset links', async t => {
  const { accounts, teacher } = await fixture(t);
  const student = await accounts.register(application('student@security.example'));
  accounts.reviewStudent(teacher.id, student.id, 'approved', '');
  const issue = accounts.issuePasswordReset(student.email);

  accounts.updateProfile(student.id, { email: 'changed@security.example' });
  assert.equal(accounts.getPasswordReset(issue.token), null);
  accounts.reviewStudent(teacher.id, student.id, 'approved', '');
  accounts.updateProfile(student.id, { email: student.email });
  assert.equal(accounts.getPasswordReset(issue.token), null);
  await rejectsReset(accounts.completePasswordReset(issue.token, newPassword));

  const rejected = await accounts.register(application('rejected@security.example'));
  accounts.reviewStudent(teacher.id, rejected.id, 'rejected', '补全申请');
  const rejectedReset = accounts.issuePasswordReset(rejected.email);
  accounts.updateStudent(rejected.id, application('resubmitted@security.example'));
  assert.equal(accounts.getPasswordReset(rejectedReset.token), null);
  await rejectsReset(accounts.completePasswordReset(rejectedReset.token, newPassword));
});

test('request cooldown and hourly limits persist across reopen and delivery failure', async t => {
  const { db, teacher } = await fixture(t);
  let accounts = openAccounts(db);
  const issued = accounts.issuePasswordReset(teacher.email);
  assert.equal(accounts.issuePasswordReset(teacher.email), null);
  accounts = openAccounts(db);
  assert.equal(accounts.issuePasswordReset(teacher.email), null);

  accounts.discardPasswordReset(issued.token);
  assert.equal(accounts.getPasswordReset(issued.token), null);
  assert.equal(accounts.issuePasswordReset(teacher.email), null);
  ageRequests(db, teacher.id);
  assert.ok(accounts.issuePasswordReset(teacher.email));

  const capped = await accounts.register(application('capped@security.example'));
  for (let i = 0; i < 5; i++) {
    assert.ok(accounts.issuePasswordReset(capped.email));
    ageRequests(db, capped.id);
  }
  assert.equal(accounts.issuePasswordReset(capped.email), null);
  accounts = openAccounts(db);
  assert.equal(accounts.issuePasswordReset(capped.email), null);
  db.prepare('UPDATE password_reset_requests SET created_at = created_at - 3600001 WHERE user_id = ?').run(capped.id);
  assert.ok(accounts.issuePasswordReset(capped.email));
});
