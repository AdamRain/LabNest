import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { openPortal } from '../src/portal.mjs';

const password = 'Portal-isolation-test-only-42';
const editorPath = '/teacher/portal';

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const accounts = openAccounts(db);
  const admin = await accounts.createAdmin({ name: '管理员', email: 'admin@portal.example', password });
  const first = await accounts.createTeacher({ name: '甲导师', email: 'first@portal.example', password });
  const second = await accounts.createTeacher({ name: '乙导师', email: 'second@portal.example', password });
  const pending = await accounts.registerTeacher({ name: '待审教师', email: 'pending@portal.example', password });
  const student = async (name, primaryTeacherId, secondaryTeacherId = null) => {
    const user = await accounts.register({ name, primaryTeacherId, email: name + '@portal.example', password,
      level: 'graduate', studentStatus: 'active', studentNumber: '20261001', major: '计算机', relationship: 'direct' });
    if (secondaryTeacherId) accounts.assignTeachers(admin.id, user.id, { primaryTeacherId, secondaryTeacherId });
    return user;
  };
  const own = await student('first-student', first.id);
  const other = await student('second-student', second.id);
  const shared = await student('shared-student', first.id, second.id);
  db.exec(`
    CREATE TABLE lab_results (id INTEGER PRIMARY KEY, title TEXT, kind TEXT, result_date TEXT);
    CREATE TABLE lab_result_members (result_id INTEGER REFERENCES lab_results(id), student_id INTEGER REFERENCES accounts(id));
  `);
  const addResult = (title, members) => {
    const resultId = Number(db.prepare('INSERT INTO lab_results(title,kind,result_date) VALUES(?,?,?)').run(title, 'paper', '2026-11-16').lastInsertRowid);
    for (const member of members) db.prepare('INSERT INTO lab_result_members VALUES(?,?)').run(resultId, member.id);
    return resultId;
  };
  const ids = {
    own: addResult('FIRST_PRIVATE_RESULT_SENTINEL', [own]),
    other: addResult('SECOND_PRIVATE_RESULT_SENTINEL', [other]),
    shared: addResult('SHARED_RESULT_SENTINEL', [shared]),
    mixed: addResult('MIXED_RESULT_SENTINEL', [own, other]),
    global: addResult('GLOBAL_RESULT_SENTINEL', [])
  };
  const ui = {
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value])),
    token: () => '<input type="hidden" name="csrf" value="test-token">',
    layout: (_state, title, body) => `<title>${title}</title>${body}`,
    html: (response, body, status = 200) => Object.assign(response, { body, status }),
    redirect: (response, path) => Object.assign(response, { path, status: 303 }),
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode })
  };
  const portal = openPortal({ db, accounts, ui });
  const go = async (path, user, form = null) => {
    const url = new URL(path, 'http://portal.example');
    const route = portal.routes.find(([verb, pattern]) => verb === (form ? 'POST' : 'GET') && pattern.test(url.pathname));
    assert.ok(route);
    const match = route[1].exec(url.pathname);
    const response = {};
    await route[3]({ response, state: { user }, form, id: match[1] ? Number(match[1]) : null, url });
    return response;
  };
  return { db, accounts, admin, first, second, pending, own, other, shared, ids, portal, go };
}

test('门户编辑列表与发布撤下按成果全部关联学生隔离，副导师可操作，共享全局成果保留', async t => {
  const { db, first, second, pending, ids, go } = await fixture(t);
  const firstPage = (await go(editorPath, first)).body;
  assert.ok(firstPage.includes('FIRST_PRIVATE_RESULT_SENTINEL'));
  assert.ok(firstPage.includes('SHARED_RESULT_SENTINEL'));
  assert.ok(firstPage.includes('GLOBAL_RESULT_SENTINEL'));
  assert.doesNotMatch(firstPage, /SECOND_PRIVATE_RESULT_SENTINEL|MIXED_RESULT_SENTINEL/);
  const secondPage = (await go(editorPath, second)).body;
  assert.ok(secondPage.includes('SECOND_PRIVATE_RESULT_SENTINEL'));
  assert.ok(secondPage.includes('SHARED_RESULT_SENTINEL'));
  assert.ok(secondPage.includes('GLOBAL_RESULT_SENTINEL'));
  assert.doesNotMatch(secondPage, /FIRST_PRIVATE_RESULT_SENTINEL|MIXED_RESULT_SENTINEL/);
  for (const actor of [second, { ...second, role: 'admin' }, pending]) {
    await assert.rejects(go(`${editorPath}/results/${ids.own}`, actor, { summary: '越权修改', url: '' }), { statusCode: 403 });
    await assert.rejects(go(`${editorPath}/results/${ids.own}/hide`, actor, {}), { statusCode: 403 });
  }
  for (const actor of [first, second]) {
    await assert.rejects(go(`${editorPath}/results/${ids.mixed}`, actor, { summary: '', url: '' }), { statusCode: 403 });
  }
  await assert.rejects(go(`${editorPath}/results/${ids.global}`, pending, { summary: '', url: '' }), { statusCode: 403 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_results').get().n, 0);
  await go(`${editorPath}/results/${ids.own}`, first, { summary: '公开摘要', url: '' });
  await assert.rejects(go(`${editorPath}/results/${ids.own}/hide`, second, {}), { statusCode: 403 });
  assert.equal(db.prepare('SELECT summary FROM portal_results WHERE result_id=?').get(ids.own).summary, '公开摘要');
  await go(`${editorPath}/results/${ids.shared}`, second, { summary: '副导师发布', url: '' });
  await go(`${editorPath}/results/${ids.global}`, first, { summary: '全局成果', url: '' });
  await go(`${editorPath}/results/${ids.global}/hide`, second, {});
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_results').get().n, 2);
});

test('调整指导关系即时撤销门户管理权限，已公开的快照仍按原内容展示', async t => {
  const { accounts, admin, first, second, own, ids, portal, go } = await fixture(t);
  await go(`${editorPath}/results/${ids.own}`, first, { summary: '已经确认公开的快照', url: 'https://example.org/paper' });
  accounts.assignTeachers(admin.id, own.id, { primaryTeacherId: second.id });
  assert.ok(!(await go(editorPath, first)).body.includes('FIRST_PRIVATE_RESULT_SENTINEL'));
  await assert.rejects(go(`${editorPath}/results/${ids.own}`, first, { summary: '旧导师覆盖', url: '' }), { statusCode: 403 });
  await assert.rejects(go(`${editorPath}/results/${ids.own}/hide`, first, {}), { statusCode: 403 });
  const published = portal.publicContent().results.find(result => result.id === ids.own);
  assert.equal(published.title, 'FIRST_PRIVATE_RESULT_SENTINEL');
  assert.equal(published.summary, '已经确认公开的快照');
  assert.equal(published.url, 'https://example.org/paper');
  assert.ok((await go(editorPath, second)).body.includes('FIRST_PRIVATE_RESULT_SENTINEL'));
  await go(`${editorPath}/results/${ids.own}/hide`, second, {});
  assert.ok(!portal.publicContent().results.some(result => result.id === ids.own));
});
