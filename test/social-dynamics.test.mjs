import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openTopics } from '../src/topics.mjs';

const week = '2026-11-16';
const oldWeek = '2026-11-09';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function fixture(t, { legacy = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, role TEXT, name TEXT, review_status TEXT,
      student_status TEXT, disabled INTEGER NOT NULL DEFAULT 0, primary_teacher_id INTEGER);
    INSERT INTO accounts VALUES
      (1,'student','发布者','approved','active',0,10),
      (2,'student','同学','approved','active',0,11),
      (3,'student','待审核','pending','active',0,10),
      (4,'student','已毕业','approved','graduated',0,10),
      (10,'teacher','教师甲','approved','active',0,NULL),
      (11,'teacher','教师乙','approved','active',0,NULL);`);
  if (legacy) db.exec(`CREATE TABLE weekly_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL REFERENCES accounts(id), week TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('plan','reading','experiments','summary')), body TEXT NOT NULL,
      published_at TEXT NOT NULL, revoked_at TEXT) STRICT;
    INSERT INTO weekly_publications VALUES(41,1,'${oldWeek}','reading','旧学习记录','2026-11-10T00:00:00.000Z',NULL);`);
  const user = id => {
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    return row && { ...row, reviewStatus: row.review_status, studentStatus: row.student_status };
  };
  const accounts = { getUser: user,
    canManageStudent: (actor, id) => db.prepare('SELECT primary_teacher_id FROM accounts WHERE id=?').get(id)?.primary_teacher_id === actor.id };
  let report = { status: 'submitted', latestVersion: { plan: ['工作计划'], reading: '可分享论文笔记', experiments: '私有实验', difficulties: '需要帮助 <script>alert(1)</script>' } };
  const weekly = { currentWeek: () => week, getReport: () => report, taskProgress: () => [], progressForTopic: () => [] };
  const ui = { escapeHtml, token: () => '<input name="csrf" value="test">', layout: (_state, _title, body) => body,
    html: (response, body) => { response.body = body; }, redirect: (response, location) => { response.location = location; },
    httpError: (status, message) => Object.assign(new Error(message), { status }) };
  const topics = openTopics({ db, accounts, weekly, ui });
  t.after(() => db.close());
  function call(method, path, actor = user(2), form = {}) {
    const url = new URL(path, 'http://lab.test');
    const route = topics.routes.find(([verb, pattern]) => verb === method && pattern.test(url.pathname));
    assert.ok(route, 'route exists: ' + path);
    const match = url.pathname.match(route[1]);
    const response = {};
    route[3]({ response, state: { user: actor }, id: Number(match[1]), form, url });
    return response;
  }
  const save = (kinds, targetWeek = week) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = topics.saveWeeklyVisibility(user(1), { week: targetWeek, kinds }); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, topics, call, user, save, report: value => { report = value; } };
}

test('旧动态表升级保留ID与历史，新增困难求助且更新沿用ID与讨论', t => {
  const f = fixture(t, { legacy: true });
  assert.equal(f.db.prepare('SELECT body FROM weekly_publications WHERE id=41').get().body, '旧学习记录');
  const state = f.save(['difficulties']);
  const id = state.difficulties.id;
  assert.ok(id > 41);
  assert.equal(f.topics.publicationState(f.user(1), week).difficulties.id, id);
  f.call('POST', `/student/dynamics/${id}/comments`, f.user(2), { body: '我来帮忙' });
  f.report({ status: 'submitted', latestVersion: { plan: [], difficulties: '更新后的问题' } });
  assert.equal(f.save(['difficulties']).difficulties.id, id);
  assert.match(f.call('GET', `/student/dynamics/${id}`).body, /更新后的问题/);
  assert.match(f.call('GET', `/student/dynamics/${id}`).body, /我来帮忙/);
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('旧发布入口和独立摘要更新也沿用ID，讨论与回复链接不变', t => {
  const f = fixture(t);
  f.call('POST', '/student/dynamics/publish', f.user(1), { kind: 'summary', summary: '摘要第一稿' });
  const first = f.topics.publicationState(f.user(1), week).summary;
  f.call('POST', `/student/dynamics/${first.id}/comments`, f.user(2), { body: '针对第一稿的建议' });
  f.call('POST', '/student/dynamics/publish', f.user(1), { kind: 'summary', summary: '摘要第二稿' });
  assert.equal(f.topics.publicationState(f.user(1), week).summary.id, first.id);
  f.call('POST', '/student/dynamics/visibility', f.user(1), { kind: 'summary', week, published: '1', intent: 'update', summary: '摘要第三稿' });
  assert.equal(f.topics.publicationState(f.user(1), week).summary.id, first.id);
  const body = f.call('GET', `/student/dynamics/${first.id}`).body;
  assert.match(body, /摘要第三稿/);
  assert.match(body, /针对第一稿的建议/);
  assert.match(body, /id="comment-1"/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM weekly_publications').get().n, 1);
});

test('草稿及无效分项不能发布，未选分项撤下且详情和讨论立即禁读', t => {
  const f = fixture(t);
  const id = f.save(['reading']).reading.id;
  f.call('POST', `/student/dynamics/${id}/comments`, f.user(2), { body: '内部讨论' });
  assert.throws(() => f.save(['private']), error => error.status === 400);
  assert.equal(f.topics.publicationState(f.user(1), week).reading.id, id);
  f.report({ status: 'draft', latestVersion: { reading: '草稿' } });
  assert.throws(() => f.save(['reading']), error => error.status === 400);
  f.report({ status: 'submitted', latestVersion: { reading: '保留私密' } });
  f.save([]);
  assert.throws(() => f.call('GET', `/student/dynamics/${id}`), error => error.status === 404);
  assert.throws(() => f.call('POST', `/student/dynamics/${id}/comments`, f.user(2), { body: '不能回复' }), error => error.status === 404);
  assert.throws(() => f.call('POST', '/student/dynamics/comments/1/delete', f.user(2)), error => error.status === 404);
});

test('成员可以回复自己与他人动态，层级及同帖约束生效，正文安全转义', t => {
  const f = fixture(t);
  const state = f.save(['reading', 'difficulties']);
  const id = state.difficulties.id;
  const detail = f.call('GET', `/student/dynamics/${id}`, f.user(1)).body;
  assert.match(detail, /&lt;script&gt;/);
  assert.doesNotMatch(detail, /<script>alert/);
  const first = f.call('POST', `/student/dynamics/${id}/comments`, f.user(1), { body: '<img src=x onerror=alert(1)>' });
  assert.match(first.location, /#comment-1$/);
  for (let parentId = 1; parentId < 5; parentId++) f.call('POST', `/student/dynamics/${id}/comments`, f.user(2), { body: '层级 ' + parentId, parentId: String(parentId) });
  assert.throws(() => f.call('POST', `/student/dynamics/${id}/comments`, f.user(1), { body: '第六层', parentId: '5' }), error => error.status === 400);
  assert.throws(() => f.call('POST', `/student/dynamics/${state.reading.id}/comments`, f.user(1), { body: '跨帖', parentId: '1' }), error => error.status === 400);
  assert.throws(() => f.call('POST', `/student/dynamics/${id}/comments`, f.user(1), { body: '字'.repeat(2001) }), error => error.status === 400);
  assert.match(f.call('GET', `/student/dynamics/${id}`).body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.throws(() => f.call('POST', '/student/dynamics/comments/1/delete', f.user(2)), error => error.status === 404);
  f.call('POST', '/student/dynamics/comments/1/delete', f.user(1));
  const removed = f.call('GET', `/student/dynamics/${id}`).body;
  assert.match(removed, /该回复已删除/);
  assert.match(removed, /层级 4/);
  assert.doesNotMatch(removed, /&lt;img src=x/);
});

test('待审核不可读，毕业只读，作者失效后历史与回复都不暴露', t => {
  const f = fixture(t);
  const id = f.save(['reading']).reading.id;
  assert.throws(() => f.call('GET', `/student/dynamics/${id}`, f.user(3)), error => error.status === 403);
  const graduated = f.call('GET', `/student/dynamics/${id}`, f.user(4)).body;
  assert.match(graduated, /毕业账号可浏览/);
  assert.doesNotMatch(graduated, /name="body"/);
  assert.throws(() => f.call('POST', `/student/dynamics/${id}/comments`, f.user(4), { body: '毕业回复' }), error => error.status === 403);
  for (const update of ["review_status='pending'", "review_status='approved',disabled=1", "disabled=0,student_status='graduated'"]) {
    f.db.exec('UPDATE accounts SET ' + update + ' WHERE id=1');
    assert.throws(() => f.call('GET', `/student/dynamics/${id}`), error => error.status === 404);
    assert.doesNotMatch(f.call('GET', '/student/dynamics?scope=all').body, /可分享论文笔记/);
  }
});

test('全部动态包含历史和自己的发布，侧栏仅本周其他学生，评论频率受限', t => {
  const f = fixture(t, { legacy: true });
  const id = f.save(['reading']).reading.id;
  assert.doesNotMatch(f.call('GET', '/student/dynamics', f.user(1)).body, /旧学习记录/);
  assert.match(f.call('GET', '/student/dynamics?scope=all', f.user(1)).body, /旧学习记录/);
  assert.match(f.call('GET', '/student/dynamics', f.user(1)).body, /social-discuss/);
  assert.doesNotMatch(f.call('GET', '/student/dynamics/feed', f.user(1)).body, /可分享论文笔记/);
  assert.match(f.call('GET', '/student/dynamics/feed', f.user(2)).body, /可分享论文笔记/);
  assert.equal(f.call('GET', '/student/dynamics/41').body.includes('旧学习记录'), true);
  for (let i = 0; i < 5; i++) f.call('POST', `/student/dynamics/${id}/comments`, f.user(2), { body: '回复 ' + i });
  assert.throws(() => f.call('POST', `/student/dynamics/${id}/comments`, f.user(2), { body: '太快了' }), error => error.status === 429);
});

test('教师只管理有关课题，合作课题私人周报仅展示名下学生', t => {
  const f = fixture(t);
  f.db.exec(`INSERT INTO paper_topics (owner_id,title,abstract,stage,created_at,updated_at) VALUES
    (1,'课题甲','共享摘要',1,'2026-11-16','2026-11-16'),
    (2,'课题乙','乙的摘要',1,'2026-11-16','2026-11-16');
    INSERT INTO paper_topic_members VALUES (1,1,'2026-11-16'),(2,2,'2026-11-16');`);
  assert.match(f.call('GET', '/teacher/topics', f.user(10)).body, /课题甲/);
  assert.doesNotMatch(f.call('GET', '/teacher/topics', f.user(10)).body, /课题乙/);
  assert.throws(() => f.call('GET', '/teacher/topics/2', f.user(10)), error => error.status === 404);
  assert.throws(() => f.call('POST', '/teacher/topics/2/review', f.user(10)), error => error.status === 404);
  assert.throws(() => f.call('POST', '/teacher/topics/2/edit', f.user(10), {}), error => error.status === 403);
  f.db.exec("INSERT INTO paper_topic_members VALUES (2,1,'2026-11-16')");
  assert.match(f.call('GET', '/teacher/topics/2', f.user(10)).body, /课题乙/);
  assert.throws(() => f.call('POST', '/teacher/topics/2/transfer', f.user(10), { studentId: '2' }), error => error.status === 400);
});
