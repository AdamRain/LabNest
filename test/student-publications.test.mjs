import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const password = 'Isolated-publications-42';
  const teacher = await accounts.createTeacher({ name: '测试教师', email: 'teacher@share.example', password });
  async function makeStudent(name, email, approved = true) {
    const user = await accounts.register({ name, email, password, level: 'graduate', studentStatus: 'active',
      studentNumber: '20260001', major: '计算机', relationship: 'direct' });
    if (approved) accounts.reviewStudent(teacher.id, user.id, 'approved');
    return accounts.getUser(user.id);
  }
  const author = await makeStudent('发布者', 'author@share.example');
  const reader = await makeStudent('阅读者', 'reader@share.example');
  const pending = await makeStudent('待审核', 'pending@share.example', false);
  const server = createLabServer({ db });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    const cookies = new Map();
    let csrf = '';
    return {
      async go(path, form = null) {
        const init = { redirect: 'manual', headers: { Cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; ') } };
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
      async login(user) {
        await this.go('/login');
        assert.equal((await this.go('/login', { identifier: user.email, password })).response.status, 303);
      }
    };
  }
  const publisher = client(), peer = client();
  await publisher.login(author);
  await peer.login(reader);
  const page = await publisher.go('/student/dynamics');
  const week = page.text.match(/name="week" value="([^"]+)"/)[1];
  const report = { week, revision: '0', action: 'submit', plan: '本周计划',
    reading: '可以分享的论文学习', experiments: '不能泄露的私密实验' };
  assert.equal((await publisher.go('/student/weekly', report)).response.status, 303);
  const active = (user = author, kind = 'reading') => db.prepare(
    'SELECT * FROM weekly_publications WHERE student_id=? AND week=? AND kind=? AND revoked_at IS NULL'
  ).get(user.id, week, kind);
  return { db, accounts, teacher, author, reader, pending, publisher, peer, client, week, report, active };
}

test('勾选后只共享所选分项，其他学生右侧和动态详情可读，取消后全部撤下', async t => {
  const { publisher, peer, week, active } = await fixture(t);
  const initial = (await publisher.go('/student/dynamics')).text;
  assert.equal((initial.match(/data-publication-toggle/g) ?? []).length, 4);
  assert.match(initial, /<details class="social-publication-manager">\s*<summary>管理动态与发布摘要<\/summary>/);
  assert.match(initial, /href="\/student\/weekly">写周报并分享<\/a>/);
  assert.doesNotMatch(initial, /type="checkbox" name="published" value="1" checked/);
  const posted = await publisher.go('/student/dynamics/visibility', { kind: 'reading', week, published: '1' });
  assert.equal(posted.response.status, 303);
  assert.equal(posted.response.headers.get('location'), '/student/dynamics?manage=1#publication-reading');
  assert.match((await publisher.go('/student/dynamics?manage=1')).text, /<details class="social-publication-manager" open>/);
  const item = active();
  assert.equal(item.body, '可以分享的论文学习');
  const feed = (await peer.go('/student/dynamics/feed')).text;
  assert.match(feed, /data-student-dynamics-feed/);
  assert.match(feed, /可以分享的论文学习/);
  assert.doesNotMatch(feed, /不能泄露的私密实验|本周计划/);
  assert.match((await peer.go('/student')).text, /可以分享的论文学习/);
  const detail = await peer.go('/student/dynamics/' + item.id);
  assert.equal(detail.response.status, 200);
  assert.doesNotMatch(detail.text, /不能泄露的私密实验/);
  assert.match((await publisher.go('/student/dynamics')).text, /type="checkbox" name="published" value="1" checked/);
  assert.equal((await publisher.go('/student/dynamics/visibility', { kind: 'reading', week })).response.status, 303);
  assert.equal(active(), undefined);
  assert.doesNotMatch((await peer.go('/student/dynamics/feed')).text, /可以分享的论文学习/);
  assert.equal((await peer.go('/student/dynamics/' + item.id)).response.status, 404);
  assert.equal((await publisher.go('/student/dynamics/visibility', { kind: 'reading', week })).response.status, 303);
});

test('重复勾选保持快照，明确更新沿用帖子ID并保留已有回复', async t => {
  const { publisher, peer, week, report, active, db } = await fixture(t);
  await publisher.go('/student/dynamics/visibility', { kind: 'reading', week, published: '1' });
  const first = active();
  await peer.go('/student/dynamics/' + first.id);
  assert.equal((await peer.go('/student/dynamics/' + first.id + '/comments', { body: '讨论保留：推荐阅读相关方法' })).response.status, 303);
  assert.equal((await publisher.go('/student/weekly', { ...report, revision: '1', reading: '更新后的论文学习', experiments: '另一项私密实验' })).response.status, 303);
  await publisher.go('/student/dynamics/visibility', { kind: 'reading', week, published: '1' });
  assert.equal(active().id, first.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM weekly_publications').get().n, 1);
  assert.match((await peer.go('/student/dynamics/feed')).text, /可以分享的论文学习/);
  assert.doesNotMatch((await peer.go('/student/dynamics/feed')).text, /更新后的论文学习|另一项私密实验/);
  await publisher.go('/student/dynamics/visibility', { kind: 'reading', week, published: '1', intent: 'update' });
  assert.equal(active().id, first.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM weekly_publications').get().n, 1);
  assert.match((await peer.go('/student/dynamics/feed')).text, /更新后的论文学习/);
  const updated = await peer.go('/student/dynamics/' + first.id);
  assert.equal(updated.response.status, 200);
  assert.match(updated.text, /更新后的论文学习/);
  assert.match(updated.text, /讨论保留：推荐阅读相关方法/);
});

test('摘要可勾选发布、空白时可撤回；拒绝无正文的新发布和跨周旧表单', async t => {
  const { publisher, week, active } = await fixture(t);
  assert.equal((await publisher.go('/student/dynamics/visibility', { kind: 'summary', week, published: '1', summary: '' })).response.status, 400);
  assert.equal(active(undefined, 'summary'), undefined);
  await publisher.go('/student/dynamics/visibility', { kind: 'summary', week, published: '1', summary: '主动分享的简短摘要' });
  assert.equal(active(undefined, 'summary').body, '主动分享的简短摘要');
  const row = (await publisher.go('/student/dynamics')).text.match(/<div class="topics-publication" id="publication-summary">([\s\S]*?)<\/form>/)[1];
  assert.doesNotMatch(row, /<textarea[^>]*required/);
  await publisher.go('/student/dynamics/visibility', { kind: 'summary', week, summary: '' });
  assert.equal(active(undefined, 'summary'), undefined);
  assert.equal((await publisher.go('/student/dynamics/visibility', { kind: 'reading', week: '2000-01-03', published: '1' })).response.status, 409);
  assert.equal(active(), undefined);
});

test('所有动态读取和写入保留身份限制，不能修改他人发布项，CSRF 和类型均校验', async t => {
  const { accounts, teacher, author, pending, publisher, peer, client, week, active } = await fixture(t);
  const guest = client();
  assert.equal((await guest.go('/student/dynamics/feed')).response.status, 303);
  const admin = client(); await admin.login(teacher);
  assert.equal((await admin.go('/student/dynamics/feed')).response.status, 403);
  const waiting = client(); await waiting.login(pending);
  assert.equal((await waiting.go('/student/dynamics/feed')).response.status, 403);
  assert.equal((await waiting.go('/student/dynamics/visibility', { week, kind: 'reading', published: '1' })).response.status, 403);
  assert.equal((await publisher.go('/student/dynamics/visibility', { csrf: 'bad', week, kind: 'reading', published: '1' })).response.status, 403);
  assert.equal((await publisher.go('/student/dynamics/visibility', { week, kind: 'private', published: '1' })).response.status, 400);
  assert.equal((await publisher.go('/student/dynamics/visibility', { week, kind: 'reading', published: 'yes' })).response.status, 400);
  await publisher.go('/student/dynamics/visibility', { week, kind: 'reading', published: '1' });
  const id = active().id;
  await peer.go('/student/dynamics/visibility', { week, kind: 'reading', studentId: String(author.id) });
  assert.equal(active().id, id);
  assert.equal((await peer.go('/student/dynamics/' + id + '/withdraw', {})).response.status, 404);
  accounts.setStudentStatus(teacher.id, author.id, 'graduated');
  assert.equal((await publisher.go('/student/dynamics/visibility', { week, kind: 'reading' })).response.status, 403);
  assert.doesNotMatch((await publisher.go('/student/dynamics')).text, /data-publication-toggle/);
  assert.equal((await publisher.go('/student/dynamics/feed')).response.status, 200);
  assert.doesNotMatch((await peer.go('/student/dynamics/feed')).text, /可以分享的论文学习/);
});
