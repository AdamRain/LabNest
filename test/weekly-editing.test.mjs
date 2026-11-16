import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { openWeekly } from '../src/weekly.mjs';
import { createLabServer } from '../src/server.mjs';

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const password = 'Weekly-preview-password-42';
  const teacher = await accounts.createTeacher({ name: '教师', email: 'teacher@weekly.example', password });
  async function student(email) {
    const user = await accounts.register({ name: '测试学生', email, password, level: 'graduate', studentStatus: 'active',
      studentNumber: '20260001', major: '计算机', relationship: 'direct' });
    accounts.reviewStudent(teacher.id, user.id, 'approved');
    return user;
  }
  const author = await student('author@weekly.example');
  const peer = await student('peer@weekly.example');
  const server = createLabServer({ db });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    const cookies = new Map(); let csrf = '';
    return {
      async go(path, form) {
        const init = { redirect: 'manual', headers: { Cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; ') } };
        if (form) {
          init.method = 'POST';
          if (form instanceof FormData) { if (!form.has('csrf')) form.set('csrf', csrf); init.body = form; }
          else init.body = new URLSearchParams({ csrf, ...form });
        }
        const response = await fetch(base + path, init);
        const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
        for (const cookie of response.headers.getSetCookie()) {
          const [k, v] = cookie.split(';')[0].split('='); if (v) cookies.set(k, v); else cookies.delete(k);
        }
        csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
        return { response, text, bytes };
      },
      async login(user) { await this.go('/login'); assert.equal((await this.go('/login', { identifier: user.email, password })).response.status, 303); }
    };
  }
  const owner = client(); await owner.login(author);
  const page = await owner.go('/student/weekly');
  const week = page.text.match(/name="week"[^>]*value="([^"]+)"/)[1];
  function multipart(values, files = [], retained = []) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ week, revision: '0', action: 'submit', ...values })) form.set(key, value);
    for (const id of retained) form.append('retainedAttachment', String(id));
    for (const file of files) form.append('attachments', file);
    return form;
  }
  return { db, accounts, teacher, author, peer, owner, client, week, multipart };
}

const pdf = new File(['%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'], '实验记录.pdf', { type: 'application/pdf' });

test('截止后的历史周报可保存新版本，首次准时判定和原始内容保持，旧表单冲突不覆盖', async t => {
  const f = await fixture(t);
  const initial = { week: f.week, revision: '0', action: 'submit', plan: '第一项计划', difficulties: '需要帮助检查实验设置' };
  assert.equal((await f.owner.go('/student/weekly', initial)).response.status, 303);
  const original = f.db.prepare('SELECT * FROM weekly_reports WHERE student_id=?').get(f.author.id);
  const lateNow = new Date(f.week + 'T00:00:00+08:00').getTime() + 6 * 7 * 86400000;
  const weekly = openWeekly({ db: f.db, accounts: f.accounts, now: () => lateNow,
    ui: { httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }) } });
  assert.equal(weekly.overview(f.author.id, f.week).canEdit, true);
  const response = { writeHead(code, headers) { this.status = code; this.headers = headers; }, end() {} };
  // Exercise the same POST handler at a later week without changing the system clock.
  const route = weekly.routes.find(([verb, pattern]) => verb === 'POST' && pattern.test('/student/weekly'));
  const uiWeekly = openWeekly({ db: f.db, accounts: f.accounts, now: () => lateNow,
    ui: { httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
      redirect(res, location) { res.writeHead(303, { Location: location }); res.end(); } } });
  const post = uiWeekly.routes.find(([verb, pattern]) => verb === 'POST' && pattern.test('/student/weekly'))[3];
  assert.ok(route);
  await post({ state: { user: f.accounts.getUser(f.author.id) }, response,
    form: { ...initial, revision: '1', difficulties: '新增需要的支持' }, fields: new URLSearchParams() });
  assert.equal(response.status, 303);
  const report = uiWeekly.getReport(f.author.id, f.week);
  assert.equal(report.versions.length, 2);
  assert.equal(report.versions[1].difficulties, initial.difficulties);
  assert.equal(report.latestVersion.difficulties, '新增需要的支持');
  assert.equal(report.firstSubmittedAt, original.first_submitted_at);
  assert.equal(report.firstCutoffAt, original.first_cutoff_at);
  assert.equal(report.status, original.was_late ? 'late' : 'submitted');
  await assert.rejects(() => post({ state: { user: f.accounts.getUser(f.author.id) }, response,
    form: { ...initial, revision: '1', difficulties: '新增需要的支持' }, fields: new URLSearchParams() }), { statusCode: 409 });
  assert.equal(uiWeekly.getReport(f.author.id, f.week).versions.length, 2);
});

test('周报附件随版本保留，移除后历史仍可下载，只允许作者和教师读取', async t => {
  const f = await fixture(t);
  const markdown = new File(['# 实验记录\n\n- 本周进展\n<script>MARKDOWN_SCRIPT_SENTINEL</script>'], '实验笔记.md', { type: 'text/plain' });
  const first = await f.owner.go('/student/weekly', f.multipart({ plan: '附件测试', difficulties: '私密困难内容' }, [pdf, markdown]));
  assert.equal(first.response.status, 303, first.text);
  const attachment = f.db.prepare('SELECT * FROM weekly_attachments').get();
  assert.ok(attachment);
  const path = '/student/weekly/attachments/' + attachment.id;
  let downloaded = await f.owner.go(path);
  assert.equal(downloaded.response.status, 200);
  assert.equal(downloaded.bytes.toString(), await pdf.text());
  assert.match(downloaded.response.headers.get('content-disposition'), /^attachment;/);
  const markdownAttachment = f.db.prepare('SELECT * FROM weekly_attachments WHERE name=?').get(markdown.name);
  const markdownPath = '/student/weekly/attachments/' + markdownAttachment.id;
  const markdownDownload = await f.owner.go(markdownPath);
  assert.equal(markdownDownload.response.status, 200);
  assert.equal(markdownDownload.text, await markdown.text());
  assert.equal(markdownDownload.response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.match(markdownDownload.response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(markdownDownload.response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(markdownDownload.response.headers.get('content-security-policy'), /sandbox/);
  const second = await f.owner.go('/student/weekly', f.multipart({ revision: '1', plan: '附件已从当前版本移除' }));
  assert.equal(second.response.status, 303, second.text);
  const versions = f.db.prepare('SELECT content FROM weekly_versions ORDER BY id').all().map(row => JSON.parse(row.content));
  assert.equal(versions[0].attachments.length, 2); assert.equal(versions[1].attachments.length, 0);
  assert.equal((await f.owner.go(path)).response.status, 200);
  assert.equal((await f.owner.go(markdownPath)).response.status, 200);
  const history = (await f.owner.go('/student/weekly?tab=history')).text;
  assert.match(history, /私密困难内容/); assert.match(history, /实验记录.pdf/);
  assert.match(history, /实验笔记.md/);
  assert.doesNotMatch(history, /MARKDOWN_SCRIPT_SENTINEL/);
  const peer = f.client(); await peer.login(f.peer);
  assert.equal((await peer.go(path)).response.status, 404);
  assert.equal((await peer.go(markdownPath)).response.status, 404);
  assert.equal((await f.client().go(path)).response.status, 404);
  assert.equal((await f.client().go(markdownPath)).response.status, 404);
  const admin = f.client(); await admin.login(f.teacher);
  assert.equal((await admin.go('/teacher/weekly/attachments/' + attachment.id)).response.status, 200);
  assert.equal((await admin.go('/teacher/weekly/attachments/' + markdownAttachment.id)).response.status, 200);
  assert.match((await admin.go('/teacher/weekly/' + f.author.id)).text, /私密困难内容/);
  const leak = await peer.go('/student/dynamics/feed'); assert.doesNotMatch(leak.text, /私密困难内容|实验记录.pdf/);
  const peerForm = new FormData(); for (const [key, value] of Object.entries({ week: f.week, revision: '0', action: 'submit', plan: '盗用附件', retainedAttachment: String(attachment.id) })) peerForm.set(key, value);
  assert.equal((await peer.go('/student/weekly', peerForm)).response.status, 404);
});

test('拒绝超限和伪装附件且不留下版本，普通字段和照片限制不被放宽', async t => {
  const f = await fixture(t);
  const spoof = new File(['<html>script</html>'], '假的.pdf', { type: 'application/pdf' });
  assert.equal((await f.owner.go('/student/weekly', f.multipart({ plan: '失败上传' }, [spoof]))).response.status, 422);
  const over = new File([new Uint8Array(5 * 1024 * 1024 + 1)], '大文件.pdf', { type: 'application/pdf' });
  assert.equal((await f.owner.go('/student/weekly', f.multipart({ plan: '大文件' }, [over]))).response.status, 413);
  assert.equal((await f.owner.go('/student/weekly', f.multipart({ plan: '过多附件' }, Array(6).fill(pdf)))).response.status, 422);
  const photo = new FormData(); photo.append('photo', new File([Buffer.from('89504e470d0a1a0a','hex'), new Uint8Array(2 * 1024 * 1024)], '过大.png', { type: 'image/png' }));
  assert.equal((await f.owner.go('/student/photo', photo)).response.status, 413);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM weekly_versions').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM weekly_attachments').get().n, 0);
  const page = (await f.owner.go('/student/weekly')).text;
  assert.match(page, /enctype="multipart\/form-data"/); assert.match(page, /name="difficulties"/);
  assert.match(page, /accept="[^"]*\.md,\.markdown[^"]*"/);
  assert.match(page, /Markdown（UTF-8）/);
  assert.match(page, /tab=history/); assert.match(page, /tab=leave/);
});

test('历史周报修订与计划重排保留未改变任务的完成历史，旧任务表单不误勾选', async t => {
  const f = await fixture(t);
  const priorWeek = new Date(Date.parse(f.week + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  f.db.prepare('INSERT INTO weekly_reports(student_id,week,first_submitted_at,first_cutoff_at,revision) VALUES(?,?,?,?,1)')
    .run(f.author.id, priorWeek, Date.now() - 7 * 86400000, Date.now() - 86400000);
  const reportId = f.db.prepare('SELECT id FROM weekly_reports WHERE student_id=? AND week=?').get(f.author.id, priorWeek).id;
  const original = { plan: ['任务A', '任务B'], reading: '原内容', experiments: '', relatedTopic: null };
  const first = Number(f.db.prepare('INSERT INTO weekly_versions(report_id,content,created_at) VALUES(?,?,?)')
    .run(reportId, JSON.stringify(original), Date.now() - 7 * 86400000).lastInsertRowid);
  const tasks = { week: f.week, originVersionId: String(first), done: '0' };
  assert.equal((await f.owner.go('/student/weekly/tasks', tasks)).response.status, 303);
  let weekly = openWeekly({ db: f.db, accounts: f.accounts, ui: {} });
  assert.deepEqual(weekly.taskProgress(f.author.id, priorWeek).map(x => x.done), [true, false]);
  assert.equal((await f.owner.go('/student/weekly', { week: priorWeek, revision: '1', action: 'submit',
    plan: '任务A\n任务B', reading: '只改正文' })).response.status, 303);
  assert.deepEqual(weekly.taskProgress(f.author.id, priorWeek).map(x => x.done), [true, false]);
  assert.equal((await f.owner.go('/student/weekly', { week: priorWeek, revision: '2', action: 'submit',
    plan: '任务B\n任务A\n新增任务C', reading: '重排计划' })).response.status, 303);
  assert.deepEqual(weekly.taskProgress(f.author.id, priorWeek).map(x => [x.text, x.done]), [['任务B', false], ['任务A', true], ['新增任务C', false]]);
  const stale = { week: f.week, originVersionId: String(first), done: '0' };
  assert.equal((await f.owner.go('/student/weekly/tasks', stale)).response.status, 409);
  const rendered = (await f.owner.go('/student/weekly')).text;
  assert.match(rendered, /name="originVersionId"/);
  assert.match(rendered, /标记完成/);
});
