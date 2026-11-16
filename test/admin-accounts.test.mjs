import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { openAdmin } from '../src/admin.mjs';

const password = 'Local-admin-test-only-846';
const application = (overrides = {}) => ({
  name: '测试学生', email: 'student@admin.example', password,
  level: 'graduate', studentStatus: 'active', studentNumber: '20261001',
  major: '计算机技术', relationship: 'direct', activities: ['小论文'], ...overrides
});

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const accounts = openAccounts(db);
  const admin = await accounts.createAdmin({ name: '管理员', email: 'admin@admin.example', password });
  const teacher = await accounts.createTeacher({ name: '主导师', email: 'teacher@admin.example', password });
  return { db, accounts, admin, teacher };
}

function mockUi() {
  return {
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value])),
    token: () => '<input type="hidden" name="csrf" value="test-token">',
    layout: (state, title, body) => `${state.error || ''}${state.notice || ''}<title>${title}</title>${body}`,
    html: (response, body, status = 200) => Object.assign(response, { body, status }),
    redirect: (response, path) => Object.assign(response, { path }),
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode })
  };
}

test('多教师注册需管理员审核，主副导师合法且每名学生必须有主导师', async t => {
  const { db, accounts, admin, teacher } = await fixture(t);
  const student = await accounts.register(application());
  assert.equal(student.primaryTeacherId, teacher.id);
  assert.equal(student.secondaryTeacherId, null);
  const pending = await accounts.registerTeacher({ name: '申请教师', email: ' new@admin.example ', phone: '13800001234', password, role: 'admin', reviewStatus: 'approved' });
  assert.equal(pending.role, 'teacher');
  assert.equal(pending.reviewStatus, 'pending');
  assert.equal(pending.phone, '13800001234');
  assert.deepEqual(accounts.listTeachers().map(user => user.id), [teacher.id]);
  assert.equal(accounts.listTeachers({ approvedOnly: false }).length, 2);
  assert.throws(() => accounts.reviewTeacher(teacher.id, pending.id, 'approved'), { statusCode: 403 });
  assert.throws(() => accounts.assignTeachers(teacher.id, student.id, { primaryTeacherId: teacher.id }), { statusCode: 403 });
  await assert.rejects(accounts.register(application({ email: 'pending@admin.example', primaryTeacherId: pending.id })), /主指导教师/);
  accounts.reviewTeacher(admin.id, pending.id, 'approved');
  assert.equal(accounts.listTeachers().length, 2);
  await assert.rejects(accounts.register(application({ email: 'missing@admin.example' })), /主指导教师/);
  for (const primaryTeacherId of [admin.id, student.id, -1, 1.5, 'bad']) {
    await assert.rejects(accounts.register(application({ email: 'invalid@admin.example', primaryTeacherId })), /主指导教师/);
  }
  assert.throws(() => accounts.assignTeachers(admin.id, student.id, { primaryTeacherId: teacher.id, secondaryTeacherId: teacher.id }), /不能是同一人/);
  const noSelfAssignedSecondary = await accounts.register(application({ email: 'no-secondary@admin.example', primaryTeacherId: teacher.id, secondaryTeacherId: pending.id }));
  assert.equal(noSelfAssignedSecondary.secondaryTeacherId, null);
  const next = accounts.assignTeachers(admin.id, student.id, { primaryTeacherId: teacher.id, secondaryTeacherId: pending.id });
  assert.equal(next.secondaryTeacherName, '申请教师');
  assert.equal(next.primaryTeacherName, '主导师');
  const raw = db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(teacher.id);
  assert.ok(raw.password_hash.includes(':'));
  for (const user of accounts.listUsers()) {
    assert.equal(user.password_hash, undefined);
    assert.equal(user.passwordHash, undefined);
    assert.equal(user.password, undefined);
  }
});

test('主副指导教师只见自己学生，伪造角色与学生自行修改导师不能绕过隔离', async t => {
  const { accounts, admin, teacher } = await fixture(t);
  const secondary = await accounts.createTeacher({ name: '副导师', email: 'secondary@admin.example', password });
  const unrelated = await accounts.createTeacher({ name: '其他导师', email: 'other@admin.example', password });
  const student = await accounts.register(application({ primaryTeacherId: teacher.id, secondaryTeacherId: secondary.id }));
  accounts.assignTeachers(admin.id, student.id, { primaryTeacherId: teacher.id, secondaryTeacherId: secondary.id });
  const otherStudent = await accounts.register(application({ email: 'other-student@admin.example', primaryTeacherId: unrelated.id }));
  assert.equal(accounts.canManageStudent(teacher, student.id), true);
  assert.equal(accounts.canManageStudent(secondary.id, student.id), true);
  assert.equal(accounts.canManageStudent(admin, student.id), true);
  assert.equal(accounts.canManageStudent(unrelated, student.id), false);
  assert.equal(accounts.canManageStudent({ ...unrelated, role: 'admin' }, student.id), false);
  assert.equal(accounts.canManageStudent(undefined, student.id), false);
  assert.deepEqual(accounts.visibleStudentIds(teacher), [student.id]);
  assert.deepEqual(accounts.teacherStudents(unrelated).map(user => user.id), [otherStudent.id]);
  assert.throws(() => accounts.reviewStudent(unrelated.id, student.id, 'approved'), { statusCode: 403 });
  accounts.reviewStudent(secondary.id, student.id, 'approved');
  assert.throws(() => accounts.setStudentStatus(unrelated.id, student.id, 'graduated'), { statusCode: 403 });
  accounts.updateProfile(student.id, { name: '修改后的姓名', primaryTeacherId: unrelated.id, secondaryTeacherId: null, role: 'teacher' });
  const revised = accounts.getUser(student.id);
  assert.equal(revised.primaryTeacherId, teacher.id);
  assert.equal(revised.secondaryTeacherId, secondary.id);
  assert.equal(revised.role, 'student');
  assert.equal(revised.reviewStatus, 'pending');
  assert.equal(accounts.pendingProfileChanges(unrelated).size, 0);
  assert.equal(accounts.pendingProfileChanges(teacher).size, 1);
  assert.equal(accounts.pendingProfileChanges(admin).size, 1);
});

test('移除教师前须转移全部指导学生；软移除保留历史并撤销登录和重置链接', async t => {
  const { db, accounts, admin, teacher } = await fixture(t);
  const other = await accounts.createTeacher({ name: '接任导师', email: 'next@admin.example', password });
  const student = await accounts.register(application({ primaryTeacherId: teacher.id, secondaryTeacherId: other.id }));
  accounts.assignTeachers(admin.id, student.id, { primaryTeacherId: teacher.id, secondaryTeacherId: other.id });
  assert.throws(() => accounts.disableUser(admin.id, admin.id), { statusCode: 409 });
  assert.throws(() => accounts.disableUser(teacher.id, other.id), { statusCode: 403 });
  assert.throws(() => accounts.disableUser(admin.id, teacher.id), /重新分配/);
  assert.throws(() => accounts.disableUser(admin.id, other.id), /重新分配/);
  accounts.disableUser(admin.id, student.id);
  assert.throws(() => accounts.disableUser(admin.id, teacher.id), /重新分配/);
  accounts.assignTeachers(admin.id, student.id, { primaryTeacherId: other.id });
  const session = accounts.createSession(teacher.id);
  const reset = accounts.issuePasswordReset(teacher.email);
  assert.ok(reset);
  accounts.removeUser(admin.id, teacher.id);
  assert.equal(accounts.getUser(teacher.id).disabled, true);
  assert.equal(accounts.findSession(session), null);
  assert.equal(accounts.getPasswordReset(reset.token), null);
  assert.equal(await accounts.authenticate(teacher.email, password), null);
  assert.throws(() => accounts.createSession(teacher.id), { statusCode: 404 });
  assert.equal(accounts.listTeachers().some(user => user.id === teacher.id), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM accounts WHERE id=?').get(teacher.id).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM account_audit WHERE action='account_enabled'").get().n, 2);
  accounts.setUserEnabled(admin.id, teacher.id, true);
  assert.equal((await accounts.authenticate(teacher.email, password)).id, teacher.id);
  assert.equal(accounts.findSession(session), null);
  const secondAdmin = await accounts.createAdmin({ name: '第二管理员', email: 'admin2@admin.example', password });
  accounts.disableUser(admin.id, secondAdmin.id);
  assert.throws(() => accounts.disableUser(admin.id, admin.id), /至少须保留/);
});

test('待审教师没有学生权限，教师注册上限在异步哈希后事务复核', async t => {
  const { db, accounts, admin, teacher } = await fixture(t);
  const student = await accounts.register(application());
  const results = await Promise.allSettled(['a', 'b', 'c'].map(suffix => accounts.registerTeacher({
    name: '申请教师' + suffix, email: suffix + '@capacity.example', password
  }, { maxPendingTeachers: 1 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'AUTH_CAPACITY').length, 2);
  const pending = results.find(result => result.status === 'fulfilled').value;
  assert.equal(accounts.canManageStudent({ ...pending, role: 'admin', reviewStatus: 'approved' }, student.id), false);
  assert.throws(() => accounts.teacherStudents(pending), { statusCode: 403 });
  assert.throws(() => accounts.reviewTeacher(teacher.id, pending.id, 'approved'), { statusCode: 403 });
  accounts.reviewTeacher(admin.id, pending.id, 'rejected', '非本实验室教师');
  assert.equal(accounts.getUser(pending.id).reviewReason, '非本实验室教师');
  assert.throws(() => accounts.assignTeachers(admin.id, student.id, { primaryTeacherId: pending.id }), /主指导教师/);
  assert.throws(() => accounts.reviewTeacher(admin.id, pending.id, 'rejected'), { statusCode: 409 });
  assert.throws(() => accounts.reviewTeacher(teacher.id, pending.id, 'approved'), { statusCode: 403 });
  const { routes } = openAdmin({ accounts, ui: mockUi() });
  const response = {};
  routes.find(([method]) => method === 'GET')[3]({ response, state: { user: admin }, url: new URL('http://localhost/admin') });
  assert.match(response.body, /重新审核教师申请/);
  accounts.reviewTeacher(admin.id, pending.id, 'approved', '已核实教师身份，纠正审核结果');
  assert.equal(accounts.getUser(pending.id).reviewStatus, 'approved');
  const audit = db.prepare("SELECT previous_value,new_value FROM account_audit WHERE student_id=? AND action='teacher_review' ORDER BY id DESC LIMIT 1").get(pending.id);
  assert.equal(audit.previous_value, 'rejected');
  assert.equal(audit.new_value, 'approved');
  assert.throws(() => accounts.reviewTeacher(admin.id, pending.id, 'approved'), { statusCode: 409 });
  assert.throws(() => accounts.reviewTeacher(admin.id, pending.id, 'rejected'), { statusCode: 409 });
});

test('旧单教师数据库迁移保留账号、密码、会话与所有历史外键，重复打开不改指导关系', async t => {
  const source = new DatabaseSync(':memory:');
  const sourceAccounts = openAccounts(source);
  const seed = await sourceAccounts.createTeacher({ name: '原教师', email: 'seed@old.example', password });
  const hash = source.prepare('SELECT password_hash FROM accounts WHERE id=?').get(seed.id).password_hash;
  source.close();
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('teacher','student')),
      name TEXT NOT NULL, email TEXT UNIQUE, phone TEXT UNIQUE, password_hash TEXT NOT NULL,
      level TEXT, student_status TEXT, relationship TEXT, student_number TEXT, major TEXT, advisor TEXT, birthday TEXT,
      activities TEXT NOT NULL DEFAULT '[]', review_status TEXT NOT NULL CHECK(review_status IN ('pending','approved','rejected')),
      review_reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX accounts_one_teacher ON accounts(role) WHERE role='teacher';
    CREATE INDEX legacy_email_lookup ON accounts(email);
    CREATE TABLE legacy_reports(id INTEGER PRIMARY KEY, student_id INTEGER REFERENCES accounts(id), teacher_id INTEGER REFERENCES accounts(id), body TEXT);
    CREATE TABLE account_sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  `);
  const insert = db.prepare('INSERT INTO accounts(id,role,name,email,password_hash,review_status,level,student_status,relationship,student_number,major,activities) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run(40, 'teacher', '原教师', 'teacher@old.example', hash, 'approved', null, null, null, null, null, '[]');
  insert.run(75, 'student', '原学生', 'student@old.example', hash, 'approved', 'graduate', 'active', 'direct', '20260075', '计算机', '["小论文"]');
  db.prepare('INSERT INTO legacy_reports VALUES(1,75,40,?)').run('历史周报');
  const token = 'a'.repeat(43);
  db.prepare('INSERT INTO account_sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'), 75, Date.now() + 60000);
  const accounts = openAccounts(db);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.ok(db.prepare('PRAGMA foreign_key_list(legacy_reports)').all().every(row => row.table === 'accounts'));
  assert.equal((await accounts.authenticate('teacher@old.example', password)).id, 40);
  assert.equal(accounts.findSession(token).id, 75);
  assert.equal(accounts.getUser(75).primaryTeacherId, 40);
  assert.equal(accounts.getUser(75).secondaryTeacherId, null);
  assert.equal(db.prepare('SELECT password_hash FROM accounts WHERE id=40').get().password_hash, hash);
  assert.equal(db.prepare('SELECT body FROM legacy_reports WHERE id=1').get().body, '历史周报');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='legacy_email_lookup'").get());
  const next = await accounts.createTeacher({ name: '新增教师', email: 'new@old.example', password });
  const admin = await accounts.createAdmin({ name: '管理员', email: 'admin@old.example', password });
  accounts.assignTeachers(admin.id, 75, { primaryTeacherId: next.id, secondaryTeacherId: 40 });
  const reopened = openAccounts(db);
  assert.equal(reopened.getUser(75).primaryTeacherId, next.id);
  assert.equal(reopened.getUser(75).secondaryTeacherId, 40);
  assert.equal(reopened.findSession(token).id, 75);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='accounts_one_teacher'").get(), undefined);
});

test('管理员页面只允许真正的管理员访问，输出转义用户资料且不显示密码哈希', async t => {
  const { accounts, admin, teacher } = await fixture(t);
  const student = await accounts.register(application({ name: '<script>alert(1)</script>' }));
  const { routes } = openAdmin({ accounts, ui: mockUi() });
  const handler = routes.find(([method]) => method === 'GET')[3];
  for (const user of [teacher, student, { ...teacher, role: 'admin' }]) {
    assert.throws(() => handler({ response: {}, state: { user }, url: new URL('http://localhost/admin') }), { statusCode: 403 });
  }
  const response = {};
  handler({ response, state: { user: admin }, url: new URL('http://localhost/admin') });
  assert.equal(response.status, 200);
  assert.match(response.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(response.body, /<script>alert\(1\)<\/script>|password_hash|Local-admin-test-only/);
  assert.match(response.body, /主指导教师|副指导教师/);
});

test('管理员可审核学生和修改学籍学号，普通教师不能调用管理员学生管理入口', async t => {
  const { accounts, admin, teacher } = await fixture(t);
  const student = await accounts.register(application());
  const { routes } = openAdmin({ accounts, ui: mockUi() });
  const reviewPath = `/admin/students/${student.id}/review`;
  const statusPath = `/admin/students/${student.id}/status`;
  const handler = path => routes.find(([method, pattern]) => method === 'POST' && pattern.test(path))[3];
  const get = routes.find(([method]) => method === 'GET')[3];
  const initial = {};
  get({ response: initial, state: { user: admin }, url: new URL('http://localhost/admin') });
  assert.ok(initial.body.includes(`action="${reviewPath}"`));
  assert.ok(!initial.body.includes(`action="${statusPath}"`));
  for (const user of [teacher, { ...teacher, role: 'admin' }, student]) {
    await assert.rejects(handler(reviewPath)({ response: {}, state: { user }, id: student.id,
      form: { decision: 'approved' } }), { statusCode: 403 });
    await assert.rejects(handler(statusPath)({ response: {}, state: { user }, id: student.id,
      form: { studentStatus: 'graduated', studentNumber: '' } }), { statusCode: 403 });
  }
  assert.equal(accounts.getUser(student.id).reviewStatus, 'pending');
  const approved = {};
  await handler(reviewPath)({ response: approved, state: { user: admin }, id: student.id,
    form: { decision: 'approved', reason: '管理员确认信息' } });
  assert.equal(approved.path, '/admin?done=studentReviewed');
  assert.equal(accounts.getUser(student.id).reviewStatus, 'approved');
  const page = {};
  get({ response: page, state: { user: admin }, url: new URL('http://localhost/admin') });
  assert.ok(page.body.includes(`action="${statusPath}"`));
  assert.ok(!page.body.includes(`action="${reviewPath}"`));
  const graduated = {};
  await handler(statusPath)({ response: graduated, state: { user: admin }, id: student.id,
    form: { studentStatus: 'graduated', studentNumber: '' } });
  assert.equal(graduated.path, '/admin?done=studentStatus');
  assert.equal(accounts.getUser(student.id).studentStatus, 'graduated');
  assert.equal(accounts.getUser(student.id).studentNumber, null);
  const missingNumber = {};
  await handler(statusPath)({ response: missingNumber, state: { user: admin }, id: student.id,
    form: { studentStatus: 'active', studentNumber: '' } });
  assert.equal(missingNumber.status, 400);
  assert.equal(accounts.getUser(student.id).studentStatus, 'graduated');
  const restored = {};
  await handler(statusPath)({ response: restored, state: { user: admin }, id: student.id,
    form: { studentStatus: 'active', studentNumber: '20269999' } });
  assert.equal(accounts.getUser(student.id).studentStatus, 'active');
  assert.equal(accounts.getUser(student.id).studentNumber, '20269999');
});
