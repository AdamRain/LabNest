import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { openTopics } from '../src/topics.mjs';
import { openWeekly } from '../src/weekly.mjs';
import { openManagement } from '../src/management.mjs';
import { openTeacherDesk } from '../src/teacher-desk.mjs';

const week = '2026-11-16';
const oldWeek = '2026-11-09';
const password = 'Teacher-dynamics-only-test-67';
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const failure = status => error => error.statusCode === status;

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  const accounts = openAccounts(db);
  const admin = await accounts.createAdmin({ name: '管理员', email: 'admin@teacher-feed.example', password });
  const main = await accounts.createTeacher({ name: '主导师', email: 'main@teacher-feed.example', password });
  const secondary = await accounts.createTeacher({ name: '副导师', email: 'second@teacher-feed.example', password });
  const outsider = await accounts.createTeacher({ name: '其他导师', email: 'other@teacher-feed.example', password });
  const pending = await accounts.registerTeacher({ name: '待审教师', email: 'pending@teacher-feed.example', password });
  async function student(name, email, primary) {
    const user = await accounts.register({ name, email, password, level: 'graduate', major: '计算机',
      studentNumber: '20260001', studentStatus: 'active', relationship: 'direct', primaryTeacherId: primary.id });
    accounts.reviewStudent(primary.id, user.id, 'approved');
    return accounts.getUser(user.id);
  }
  const own = await student('名下学生', 'own@teacher-feed.example', main);
  const other = await student('别组同学', 'other-student@teacher-feed.example', outsider);
  accounts.assignTeachers(admin.id, own.id, { primaryTeacherId: main.id, secondaryTeacherId: secondary.id });
  const records = new Map();
  const weekly = { currentWeek: () => week, getReport: (id, targetWeek) => records.get(`${id}/${targetWeek}`),
    taskProgress: () => [], progressForTopic: () => [], overview: () => ({ required: false }) };
  const ui = { escapeHtml: e, token: () => '<input name="csrf" value="test">', layout: (_state, _title, body) => body,
    html: (response, body) => { response.body = body; }, redirect: (response, location) => { response.location = location; },
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }) };
  const topics = openTopics({ db, accounts, weekly, ui });
  function share(user, kinds, targetWeek = week) {
    records.set(`${user.id}/${targetWeek}`, { status: 'submitted', latestVersion: {
      plan: ['PRIVATE_UNSHARED_PLAN'], planRich: { image: 'PRIVATE_IMAGE_REFERENCE' },
      reading: 'PRIVATE_UNSHARED_READING', experiments: 'PRIVATE_UNSHARED_EXPERIMENT',
      difficulties: user.id === own.id ? 'SHARED_HELP_OWN <script>unsafe</script>' : 'SHARED_HELP_OTHER'
    } });
    return topics.saveWeeklyVisibility(user, { week: targetWeek, kinds });
  }
  const ownId = share(own, ['difficulties']).difficulties.id;
  const otherId = share(other, ['difficulties']).difficulties.id;
  const oldId = share(own, ['difficulties'], oldWeek).difficulties.id;
  function call(method, path, actor, form = {}) {
    const url = new URL(path, 'http://lab.test');
    const route = topics.routes.find(([verb, pattern]) => verb === method && pattern.test(url.pathname));
    assert.ok(route, 'route exists: ' + path);
    const response = {};
    route[3]({ response, state: { user: actor }, id: Number(url.pathname.match(route[1])[1]), url, form });
    return response;
  }
  return { db, accounts, admin, main, secondary, outsider, pending, own, other, topics, ui, weekly, call, ownId, otherId, oldId, share };
}

test('主副导师仅看到名下学生主动公开的本周内容，侧栏及列表不包含私有周报或历史帖子', async t => {
  const f = await fixture(t);
  for (const teacher of [f.main, f.secondary]) {
    assert.deepEqual(f.topics.teacherFeed(teacher).map(item => item.id), [f.ownId]);
    const sidebar = f.topics.teacherDashboard(teacher);
    assert.match(sidebar, /学生本周动态/);
    assert.match(sidebar, new RegExp(`href="/teacher/dynamics/${f.ownId}"`));
    assert.doesNotMatch(sidebar, /别组同学|SHARED_HELP_OTHER|PRIVATE_|script>unsafe/);
    const list = f.call('GET', '/teacher/dynamics?scope=all', teacher).body;
    assert.match(list, /SHARED_HELP_OWN/);
    assert.match(list, /&lt;script&gt;unsafe&lt;\/script&gt;/);
    assert.doesNotMatch(list, /SHARED_HELP_OTHER|PRIVATE_|name="summary"|href="\/student\/dynamics/);
    assert.equal((list.match(/class="social-post-link"/g) ?? []).length, 1);
    assert.throws(() => f.call('GET', `/teacher/dynamics/${f.oldId}`, teacher), failure(404));
  }
  assert.deepEqual(f.topics.teacherFeed(f.outsider).map(item => item.id), [f.otherId]);
  assert.throws(() => f.call('GET', `/teacher/dynamics/${f.otherId}`, f.main), failure(404));
  assert.throws(() => f.call('GET', `/teacher/dynamics/${f.ownId}`, f.outsider), failure(404));
});

test('主副导师可回复名下学生并继续楼中楼讨论，学生可看到教师身份和回复', async t => {
  const f = await fixture(t);
  f.call('POST', `/student/dynamics/${f.ownId}/comments`, f.other, { body: 'SHARED_PEER_ADVICE <img src=x>' });
  f.call('POST', `/student/dynamics/${f.ownId}/comments`, f.own, { body: 'SHARED_AUTHOR_REPLY', parentId: '1' });
  const before = f.call('GET', `/teacher/dynamics/${f.ownId}`, f.secondary).body;
  assert.match(before, /别组同学/);
  assert.match(before, /SHARED_PEER_ADVICE &lt;img src=x&gt;/);
  assert.match(before, /SHARED_AUTHOR_REPLY/);
  assert.match(before, /返回学生本周动态/);
  assert.match(before, new RegExp(`action="/teacher/dynamics/${f.ownId}/comments"`));
  assert.match(before, /name="body"|发表回复/);
  assert.doesNotMatch(before, /PRIVATE_|删除回复|毕业账号|action="\/student\/dynamics/);

  const root = f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.secondary, { body: 'TEACHER_ADVICE <script>unsafe</script>' });
  assert.match(root.location, new RegExp(`^/teacher/dynamics/${f.ownId}\\?page=1#comment-3$`));
  const nested = f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.main, { body: 'MAIN_TEACHER_FOLLOWUP', parentId: '1' });
  assert.match(nested.location, /#comment-4$/);
  f.call('POST', `/student/dynamics/${f.ownId}/comments`, f.other, { body: 'STUDENT_TO_TEACHER', parentId: '3' });
  const rows = f.db.prepare('SELECT student_id,parent_id,depth FROM weekly_publication_comments ORDER BY id').all();
  assert.deepEqual(rows.map(row => [row.student_id, row.parent_id, row.depth]), [
    [f.other.id, null, 1], [f.own.id, 1, 2], [f.secondary.id, null, 1], [f.main.id, 1, 2], [f.other.id, 3, 2]
  ]);
  const teacherView = f.call('GET', `/teacher/dynamics/${f.ownId}`, f.secondary).body;
  assert.match(teacherView, /TEACHER_ADVICE &lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(teacherView, /MAIN_TEACHER_FOLLOWUP/);
  assert.match(teacherView, /STUDENT_TO_TEACHER/);
  assert.match(teacherView, /<span class="badge">教师<\/span>/);
  assert.match(teacherView, /action="\/teacher\/dynamics\/comments\/3\/delete"/);
  assert.doesNotMatch(teacherView, /action="\/teacher\/dynamics\/comments\/[1245]\/delete"/);
  const studentView = f.call('GET', `/student/dynamics/${f.ownId}`, f.other).body;
  for (const expected of ['副导师', '主导师', 'TEACHER_ADVICE', 'MAIN_TEACHER_FOLLOWUP']) assert.ok(studentView.includes(expected));
  assert.match(studentView, /<span class="badge">教师<\/span>/);
  assert.match(studentView, /action="\/student\/dynamics\/comments\/1\/delete"/);
  assert.doesNotMatch(studentView, /action="\/teacher\/dynamics|action="\/student\/dynamics\/comments\/[34]\/delete"/);
  assert.throws(() => f.call('POST', `/student/dynamics/${f.ownId}/comments`, f.secondary, { body: '错误入口' }), failure(403));
  assert.throws(() => f.call('POST', '/student/dynamics/comments/3/delete', f.secondary), failure(403));
  assert.throws(() => f.call('POST', '/teacher/dynamics/comments/1/delete', f.secondary), failure(404));
  assert.throws(() => f.call('POST', '/teacher/dynamics/comments/3/delete', f.main), failure(404));
  f.call('POST', '/teacher/dynamics/comments/3/delete', f.secondary);
  const deleted = f.call('GET', `/student/dynamics/${f.ownId}`, f.own).body;
  assert.doesNotMatch(deleted, /TEACHER_ADVICE/);
  assert.match(deleted, /该回复已删除/);
  assert.match(deleted, /STUDENT_TO_TEACHER/);
});

test('教师不能回复非名下、历史或撤回动态，不能跨帖回复，指导变化立即撤销写入与删除权限', async t => {
  const f = await fixture(t);
  f.call('POST', `/student/dynamics/${f.otherId}/comments`, f.other, { body: 'OTHER_POST_COMMENT' });
  assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.main,
    { body: '跨帖回复', parentId: '1' }), failure(400));
  for (const [actor, post] of [[f.outsider, f.ownId], [f.main, f.otherId], [f.main, f.oldId]]) {
    assert.throws(() => f.call('POST', `/teacher/dynamics/${post}/comments`, actor, { body: '越权回复' }), failure(404));
  }
  f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.secondary, { body: 'RETAINED_TEACHER_ADVICE' });
  f.accounts.assignTeachers(f.admin.id, f.own.id, { primaryTeacherId: f.outsider.id });
  for (const actor of [f.main, f.secondary]) {
    assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, actor, { body: '旧页面回复' }), failure(404));
  }
  assert.throws(() => f.call('POST', '/teacher/dynamics/comments/2/delete', f.secondary), failure(404));
  // Public discussion remains meaningful after a guidance transfer; former teachers lose access, not authorship history.
  assert.match(f.call('GET', `/student/dynamics/${f.ownId}`, f.own).body, /RETAINED_TEACHER_ADVICE/);
  f.share(f.accounts.getUser(f.own.id), []);
  assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.outsider, { body: '撤回后回复' }), failure(404));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM weekly_publication_comments').get().n, 2);
});

test('教师回复沿用文字、频率及层级上限，停用或未审核教师的既有回复不再展示', async t => {
  const f = await fixture(t);
  for (const body of ['', 'a'.repeat(2001)]) {
    assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.main, { body }), failure(400));
  }
  for (const parentId of ['0', '2.5', 'missing', '9999']) {
    assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.main,
      { body: '错误回复对象', parentId }), failure(400));
  }
  for (let depth = 1; depth <= 5; depth++) f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.main,
    { body: 'TEACHER_CHAIN_' + depth, ...(depth > 1 ? { parentId: String(depth - 1) } : {}) });
  assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.secondary,
    { body: '超过层级', parentId: '5' }), failure(400));
  assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.main, { body: '超过频率' }), failure(429));
  f.db.prepare('UPDATE accounts SET disabled=1 WHERE id=?').run(f.main.id);
  const hidden = f.call('GET', `/student/dynamics/${f.ownId}`, f.own).body;
  assert.doesNotMatch(hidden, /主导师|TEACHER_CHAIN_/);
  assert.match(hidden, /该回复暂不可见/);
  assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, f.main, { body: '停用后' }), failure(403));
  f.db.prepare("UPDATE accounts SET disabled=0,review_status='pending' WHERE id=?").run(f.main.id);
  assert.doesNotMatch(f.call('GET', `/student/dynamics/${f.ownId}`, f.own).body, /TEACHER_CHAIN_/);
  assert.throws(() => f.call('POST', '/teacher/dynamics/comments/1/delete', f.main), failure(403));
});

test('重新分配导师、撤回动态及作者资格变化立即撤销旧页面访问', async t => {
  const f = await fixture(t);
  f.accounts.assignTeachers(f.admin.id, f.own.id, { primaryTeacherId: f.outsider.id });
  assert.deepEqual(f.topics.teacherFeed(f.main), []);
  assert.deepEqual(f.topics.teacherFeed(f.secondary), []);
  assert.throws(() => f.call('GET', `/teacher/dynamics/${f.ownId}`, f.main), failure(404));
  assert.match(f.call('GET', `/teacher/dynamics/${f.ownId}`, f.outsider).body, /SHARED_HELP_OWN/);
  f.share(f.accounts.getUser(f.own.id), []);
  assert.throws(() => f.call('GET', `/teacher/dynamics/${f.ownId}`, f.outsider), failure(404));
  const latest = f.share(f.accounts.getUser(f.own.id), ['difficulties']).difficulties.id;
  for (const update of ["review_status='pending'", "review_status='approved',disabled=1", "disabled=0,student_status='graduated'"]) {
    f.db.exec('UPDATE accounts SET ' + update + ' WHERE id=' + f.own.id);
    assert.throws(() => f.call('GET', `/teacher/dynamics/${latest}`, f.outsider), failure(404));
    assert.doesNotMatch(f.topics.teacherDashboard(f.outsider), /SHARED_HELP_OWN/);
  }
});

test('教师动态服务重新读取身份，待审、停用教师及伪造教师身份均被拒绝', async t => {
  const f = await fixture(t);
  for (const actor of [f.pending, f.own, { ...f.own, role: 'teacher', reviewStatus: 'approved' }, f.admin]) {
    assert.throws(() => f.topics.teacherFeed(actor), failure(403));
    assert.throws(() => f.call('GET', '/teacher/dynamics', actor), failure(403));
    assert.throws(() => f.call('GET', `/teacher/dynamics/${f.ownId}`, actor), failure(403));
    assert.throws(() => f.call('POST', `/teacher/dynamics/${f.ownId}/comments`, actor, { body: '不能以伪造身份回复' }), failure(403));
  }
  f.db.prepare('UPDATE accounts SET disabled=1 WHERE id=?').run(f.main.id);
  assert.throws(() => f.topics.teacherDashboard(f.main), failure(403));
  assert.throws(() => f.call('GET', `/teacher/dynamics/${f.ownId}`, f.main), failure(403));
  f.db.prepare("UPDATE accounts SET review_status='pending' WHERE id=?").run(f.secondary.id);
  assert.throws(() => f.topics.teacherFeed(f.secondary), failure(403));
});

test('教师首页包含可读的名下动态卡片，空范围有说明且保留独立全部入口', async t => {
  const f = await fixture(t);
  openWeekly({ db: f.db, accounts: f.accounts, ui: f.ui });
  openManagement({ db: f.db, accounts: f.accounts, ui: f.ui });
  const desk = openTeacherDesk({ db: f.db, accounts: f.accounts, weekly: f.weekly, topics: f.topics, ui: f.ui });
  const ownDesk = desk({ user: f.secondary });
  assert.match(ownDesk, /aria-label="学生本周动态"/);
  assert.match(ownDesk, /SHARED_HELP_OWN/);
  assert.doesNotMatch(ownDesk, /PRIVATE_|SHARED_HELP_OTHER/);
  f.accounts.assignTeachers(f.admin.id, f.own.id, { primaryTeacherId: f.main.id });
  const empty = desk({ user: f.secondary });
  assert.match(empty, /名下学生本周还没有发布动态/);
  assert.match(empty, /href="\/teacher\/dynamics">查看全部/);
  assert.throws(() => f.topics.teacherFeed(f.main, { limit: 9999 }), failure(400));
});
