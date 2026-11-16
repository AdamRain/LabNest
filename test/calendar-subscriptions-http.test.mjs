import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';

const password = 'Calendar-subscription-test-password-63';
const sourceUrl = name => `https://ccfddl.com/conference/deadlines/${name}.ics`;
const calendarPath = '/teacher/calendar?month=2026-11';
const feed = (title = '共享会议', uid = 'shared-conference-id') => new Response([
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`,
  'DTSTART:20261120T080000Z', 'DESCRIPTION:CCF A, 人工智能', 'URL:https://example.org/conference',
  'END:VEVENT', 'END:VCALENDAR', ''
].join('\r\n'), { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });

async function fixture(t, fetcher = url => feed(new URL(url).pathname.split('/').at(-1))) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const teacher = await accounts.createTeacher({ name: '会议订阅测试教师', email: 'teacher@calendar.example', password });
  const application = (name, email, number) => ({ name, email, password, major: '计算机', level: 'graduate',
    studentStatus: 'active', studentNumber: number, relationship: 'direct' });
  const student = await accounts.register(application('已审核学生', 'student@calendar.example', '20260063'));
  accounts.reviewStudent(teacher.id, student.id, 'approved');
  const pending = await accounts.register(application('待审核学生', 'pending@calendar.example', '20260064'));
  const calls = [];
  const calendarFetch = async (url, options) => { calls.push(String(url)); return fetcher(String(url), options); };
  let server, base;
  async function start() {
    server = createLabServer({ db, calendarFetch });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await setImmediate();
    if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
  await start();
  t.after(async () => { await stop(); db.close(); });

  function client() {
    const cookies = new Map(); let csrf = '';
    return {
      async go(path, form = null) {
        const init = { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: {
          Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
        } };
        if (form) { init.method = 'POST'; init.body = new URLSearchParams({ csrf, ...form }); }
        const response = await fetch(base + path, init);
        const text = await response.text();
        for (const cookie of response.headers.getSetCookie()) {
          const [name, value] = cookie.split(';')[0].split('=');
          if (value) cookies.set(name, value); else cookies.delete(name);
        }
        csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
        return { response, text };
      },
      async login(user) {
        await this.go('/');
        assert.equal((await this.go('/login', { identifier: user.email, password })).response.status, 303);
        await this.go('/' + user.role);
        return this;
      }
    };
  }
  const subscriptions = () => db.prepare('SELECT * FROM conference_subscriptions ORDER BY id').all();
  const byName = name => db.prepare('SELECT * FROM conference_subscriptions WHERE name=?').get(name);
  const cached = id => db.prepare('SELECT * FROM conference_deadlines WHERE category=? ORDER BY uid').all(id);
  return { db, accounts, teacher, student, pending, calls, client, subscriptions, byName, cached,
    restart: async () => { await stop(); await start(); } };
}

test('教师可增删改订阅，CCFDDL 提示可见；更名保留日程、更换链接清旧缓存，学生日历同步使用新配置', async t => {
  const f = await fixture(t);
  const admin = await f.client().login(f.teacher);
  const page = await admin.go(calendarPath);
  assert.equal(page.response.status, 200);
  assert.match(page.text, /href="https:\/\/ccfddl\.com\/?"/);
  assert.match(page.text, /会议订阅/);
  assert.equal(f.subscriptions().length, 4);

  const initialName = '订阅 <img src=x onerror=alert(1)>';
  const create = await admin.go('/teacher/calendar/subscriptions', { name: initialName, url: sourceUrl('custom-first') });
  assert.equal(create.response.status, 303);
  const source = f.byName(initialName); assert.ok(source?.id);
  const view = await admin.go(calendarPath);
  assert.match(view.text, /订阅 &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(view.text, /<img src=x onerror=alert\(1\)>/);
  assert.equal((await admin.go('/teacher/calendar/sync', { source: source.id })).response.status, 303);
  assert.deepEqual(f.calls, [sourceUrl('custom-first')]);
  assert.equal(f.cached(source.id)[0].title, 'custom-first.ics');

  assert.equal((await admin.go(`/teacher/calendar/subscriptions/${source.id}`,
    { name: '更名后的订阅', url: source.url, revision: source.revision })).response.status, 303);
  assert.equal(f.cached(source.id).length, 1);
  assert.equal((await admin.go(`/teacher/calendar/subscriptions/${source.id}`,
    { name: '旧页面不应覆盖', url: source.url, revision: source.revision })).response.status, 409);
  assert.equal((await admin.go(`/teacher/calendar/subscriptions/${source.id}/delete`,
    { revision: source.revision })).response.status, 409);
  assert.ok(f.byName('更名后的订阅')); assert.equal(f.cached(source.id).length, 1);
  const member = await f.client().login(f.student);
  const before = await member.go(`/student/calendar?month=2026-11&rank=all&category=${source.id}`);
  assert.match(before.text, /更名后的订阅/);
  assert.match(before.text, /custom-first\.ics/);

  assert.equal((await admin.go(`/teacher/calendar/subscriptions/${source.id}`,
    { name: '新的会议日程', url: sourceUrl('custom-second'), revision: f.byName('更名后的订阅').revision })).response.status, 303);
  assert.equal(f.cached(source.id).length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conference_sync WHERE category=?').get(source.id).n, 0);
  assert.equal((await admin.go('/teacher/calendar/sync', { source: source.id })).response.status, 303);
  assert.equal(f.cached(source.id)[0].title, 'custom-second.ics');
  const after = await member.go(`/student/calendar?month=2026-11&rank=all&category=${source.id}`);
  assert.match(after.text, /custom-second\.ics/); assert.doesNotMatch(after.text, /custom-first\.ics/);
  assert.match(after.text, /新的会议日程/);

  assert.equal((await admin.go(`/teacher/calendar/subscriptions/${source.id}/delete`, {})).response.status, 303);
  assert.equal(f.byName('新的会议日程'), undefined);
  assert.equal(f.cached(source.id).length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conference_sync WHERE category=?').get(source.id).n, 0);
  assert.doesNotMatch((await member.go('/student/calendar?month=2026-11&rank=all')).text, /custom-second\.ics/);
});

test('订阅管理与同步仅限教师，所有写入校验 CSRF，学生及待审核账号不能更改配置', async t => {
  const f = await fixture(t);
  const actions = [
    ['/teacher/calendar/subscriptions', { name: '不应保存', url: sourceUrl('denied') }],
    ['/teacher/calendar/subscriptions/AI', { name: '不应修改', url: sourceUrl('denied') }],
    ['/teacher/calendar/subscriptions/AI/delete', {}], ['/teacher/calendar/sync', { source: 'AI' }]
  ];
  for (const user of [null, f.student, f.pending]) {
    const client = f.client();
    if (user) await client.login(user); else await client.go('/');
    const deniedPage = await client.go('/teacher/calendar');
    assert.equal(deniedPage.response.status, user ? 403 : 303);
    for (const [path, form] of actions) assert.equal((await client.go(path, form)).response.status, 403);
  }
  const admin = await f.client().login(f.teacher);
  await admin.go(calendarPath);
  for (const [path, form] of actions) assert.equal((await admin.go(path, { ...form, csrf: 'wrong' })).response.status, 403);
  assert.equal(f.subscriptions().length, 4); assert.equal(f.calls.length, 0);
});

test('无效订阅与重复链接不落库，未知订阅不能误触发全量同步', async t => {
  const f = await fixture(t); const admin = await f.client().login(f.teacher);
  for (const url of ['http://ccfddl.com/test.ics', 'https://127.0.0.1/test.ics', 'https://localhost/test.ics',
    'https://10.1.2.3/test.ics', 'https://[::1]/test.ics', 'https://name:secret@ccfddl.com/test.ics',
    'https://ccfddl.com:444/test.ics', 'https://ccfddl.com/test.ics#part']) {
    assert.equal((await admin.go('/teacher/calendar/subscriptions', { name: '无效的订阅', url })).response.status, 400);
  }
  for (const name of ['', '名'.repeat(61)]) {
    assert.equal((await admin.go('/teacher/calendar/subscriptions', { name, url: sourceUrl('valid-name') })).response.status, 400);
  }
  const current = f.subscriptions()[0];
  assert.equal((await admin.go('/teacher/calendar/subscriptions', { name: '重复订阅', url: current.url })).response.status, 409);
  const missing = '00000000-0000-4000-8000-000000000000';
  assert.equal((await admin.go(`/teacher/calendar/subscriptions/${missing}`,
    { name: '不存在', url: sourceUrl('missing') })).response.status, 404);
  assert.equal((await admin.go(`/teacher/calendar/subscriptions/${missing}/delete`, {})).response.status, 404);
  assert.equal((await admin.go('/teacher/calendar/sync', { source: missing })).response.status, 404);
  assert.equal(f.subscriptions().length, 4); assert.equal(f.calls.length, 0);
});

test('默认订阅删光后重启不恢复，仍可重新添加并同步；不同订阅的相同 UID 相互独立', async t => {
  const f = await fixture(t);
  let admin = await f.client().login(f.teacher);
  assert.equal((await admin.go('/teacher/calendar/sync', {})).response.status, 303);
  for (const source of f.subscriptions()) {
    assert.equal(f.cached(source.id).length, 1);
    assert.equal((await admin.go(`/teacher/calendar/subscriptions/${source.id}/delete`, {})).response.status, 303);
  }
  assert.equal(f.subscriptions().length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conference_deadlines').get().n, 0);
  await f.restart(); admin = await f.client().login(f.teacher);
  const empty = await admin.go(calendarPath); assert.equal(empty.response.status, 200);
  assert.equal(f.subscriptions().length, 0);
  const priorCalls = f.calls.length;
  assert.equal((await admin.go('/teacher/calendar/sync', {})).response.status, 303);
  assert.equal(f.calls.length, priorCalls);
  for (const name of ['研究方向甲', '研究方向乙']) {
    assert.equal((await admin.go('/teacher/calendar/subscriptions', { name, url: sourceUrl(encodeURIComponent(name)) })).response.status, 303);
  }
  assert.equal((await admin.go('/teacher/calendar/sync', {})).response.status, 303);
  const [first, second] = f.subscriptions();
  assert.equal(f.cached(first.id).length, 1); assert.equal(f.cached(second.id).length, 1);
  assert.equal(f.cached(first.id)[0].uid, f.cached(second.id)[0].uid);
  assert.equal((await admin.go(`/teacher/calendar/subscriptions/${first.id}/delete`, {})).response.status, 303);
  assert.equal(f.cached(first.id).length, 0); assert.equal(f.cached(second.id).length, 1);
});

test('订阅同步失败保留上次成功日程，不将无效内容替换进日历', async t => {
  let invalid = false;
  const f = await fixture(t, () => invalid ? new Response('<html>not a calendar</html>') : feed('保留的成功日程'));
  const admin = await f.client().login(f.teacher);
  assert.equal((await admin.go('/teacher/calendar/sync', { source: 'AI' })).response.status, 303);
  const original = f.cached('AI'); assert.equal(original.length, 1);
  const success = f.db.prepare('SELECT successfulAt FROM conference_sync WHERE category=?').get('AI').successfulAt;
  invalid = true;
  assert.equal((await admin.go('/teacher/calendar/sync', { source: 'AI' })).response.status, 303);
  assert.deepEqual(f.cached('AI'), original);
  const state = f.db.prepare('SELECT * FROM conference_sync WHERE category=?').get('AI');
  assert.equal(state.successfulAt, success); assert.ok(state.error);
  assert.match((await admin.go(calendarPath)).text, /保留的成功日程/);
});

test('同步过程中删除或修改订阅时，旧响应不能恢复已删除的缓存或覆盖新链接', async t => {
  let release, started;
  let slowUrl = '';
  const f = await fixture(t, async url => {
    if (url === slowUrl) {
      started();
      return new Promise(resolve => { release = () => resolve(feed('不应写回的旧日程')); });
    }
    return feed('新链接的会议日程');
  });
  const admin = await f.client().login(f.teacher);
  for (const action of ['delete', 'edit']) {
    const name = `同步竞态-${action}`;
    slowUrl = sourceUrl('slow-' + action);
    assert.equal((await admin.go('/teacher/calendar/subscriptions', { name, url: slowUrl })).response.status, 303);
    const source = f.byName(name);
    const began = new Promise(resolve => { started = resolve; });
    const syncing = admin.go('/teacher/calendar/sync', { source: source.id });
    await Promise.race([began, syncing.then(() => { throw new Error('同步未进入指定订阅的读取阶段。'); })]);
    try {
      const path = `/teacher/calendar/subscriptions/${source.id}${action === 'delete' ? '/delete' : ''}`;
      const form = action === 'delete' ? {} : { name, url: sourceUrl('replacement-' + action) };
      assert.equal((await admin.go(path, form)).response.status, 303);
    } finally {
      release(); assert.equal((await syncing).response.status, 303);
    }
    assert.equal(f.cached(source.id).length, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM conference_sync WHERE category=?').get(source.id).n, 0);
    if (action === 'edit') {
      assert.equal((await admin.go('/teacher/calendar/sync', { source: source.id })).response.status, 303);
      assert.equal(f.cached(source.id)[0].title, '新链接的会议日程');
    } else assert.equal(f.byName(name), undefined);
  }
});
