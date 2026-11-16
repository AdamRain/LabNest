import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { openWeekly } from '../src/weekly.mjs';
import { normalizePlanRich, planRichText, renderPlanRich } from '../src/rich-text.mjs';

const document = blocks => JSON.stringify({ version: 1, blocks });
const paragraph = text => ({ type: 'paragraph', runs: [{ text }] });
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

test('富文本只导出受限标签，文本转义，禁止危险链接及外部图片', () => {
  const normalized = normalizePlanRich(document([{ type: 'bullet', runs: [{ text: '<script>alert(1)</script>', bold: true, italic: true, href: 'https://example.org/paper?x=1&y=2', onclick: 'bad()' }] }]));
  assert.deepEqual(planRichText(normalized), ['<script>alert(1)</script>']);
  const html = renderPlanRich(normalized);
  assert.match(html, /<strong>&lt;script&gt;/); assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<script>|onclick/);
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'https://x.test/\nscript', 'https://name:password@x.test/']) {
    assert.throws(() => normalizePlanRich(document([{ type: 'paragraph', runs: [{ text: '链接', href }] }])), { statusCode: 422 });
  }
  for (const src of ['https://remote.test/a.png', 'data:image/svg+xml,xxx', 'blob:x']) {
    assert.throws(() => normalizePlanRich(document([{ type: 'image', src }])), { statusCode: 422 });
  }
  assert.throws(() => normalizePlanRich(document(Array.from({ length: 16 }, () => paragraph('任务')))), { statusCode: 422 });
  assert.throws(() => normalizePlanRich(document([paragraph('x'.repeat(2001))])), { statusCode: 422 });
});

async function fixture(t) {
  const db = new DatabaseSync(':memory:'); const accounts = openAccounts(db);
  const password = 'Rich-weekly-test-password-42';
  const teacher = await accounts.createTeacher({ name: '主导师', email: 'teacher@rich.example', password });
  const outsider = await accounts.createTeacher({ name: '其他导师', email: 'other@rich.example', password });
  async function student(email) {
    const result = await accounts.register({ name: '学生', email, password, level: 'graduate', studentStatus: 'active', studentNumber: '20260001', major: '计算机', relationship: 'direct', primaryTeacherId: teacher.id });
    accounts.reviewStudent(teacher.id, result.id, 'approved'); return accounts.getUser(result.id);
  }
  const author = await student('author@rich.example'), peer = await student('peer@rich.example');
  const ui = {
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    html(response, text, status = 200) { response.status = status; response.body = text; },
    redirect(response, path) { response.status = 303; response.location = path; },
    escapeHtml, token: () => '', layout: (_state, _title, body) => body
  };
  const weekly = openWeekly({ db, accounts, ui });
  const week = weekly.currentWeek(); const visibility = [];
  weekly.setTopics({ weeklyProgress: () => null, weeklyChoices: () => [], publicationState: () => ({}),
    saveWeeklyVisibility(user, input) { assert.ok(weekly.getReport(user.id, input.week)?.latestVersion); visibility.push(input); } });
  function route(method, path) { return weekly.routes.find(([verb, pattern]) => verb === method && pattern.test(path))[3]; }
  async function post(values, uploads = [], retained = [], shares = []) {
    const fields = new FormData(); uploads.forEach(file => fields.append('attachments', file)); retained.forEach(id => fields.append('retainedAttachment', String(id))); shares.forEach(kind => fields.append('shareKind', kind));
    const form = { week, revision: String(weekly.getReport(author.id, week)?.revision ?? 0), action: 'submit', ...values };
    const response = {}; await route('POST', '/student/weekly')({ state: { user: author }, response, form, fields }); return response;
  }
  t.after(() => db.close()); return { db, accounts, teacher, outsider, author, peer, weekly, week, route, post, visibility };
}

const png = new File([Buffer.from('89504e470d0a1a0a00000000', 'hex')], '工作计划.png', { type: 'image/png' });

test('图文周报保存安全文档与任务数组，版本和首次提交时间保留，教师可读', async t => {
  const f = await fixture(t);
  const rich = document([{ type: 'bullet', runs: [{ text: '完成实验', bold: true }] }, { type: 'image', uploadIndex: 0 }]);
  assert.equal((await f.post({ richEditor: '1', planRich: rich, plan: '伪造的投影', difficulties: '请帮忙检查', publicationControls: '1' }, [png], [], ['difficulties'])).status, 303);
  const first = f.weekly.getReport(f.author.id, f.week), attachment = first.latestVersion.attachments[0];
  assert.deepEqual(first.latestVersion.plan, ['完成实验']);
  assert.deepEqual(first.latestVersion.planRich.blocks[1], { type: 'image', attachmentId: attachment.id });
  assert.equal(f.visibility.length, 1); assert.deepEqual(f.visibility[0].kinds, ['difficulties']);
  const html = renderPlanRich(first.latestVersion.planRich, { imagePrefix: '/teacher' });
  assert.match(html, new RegExp('/teacher/weekly/images/' + attachment.id));
  const response = {}; f.route('GET', '/teacher/weekly/1')({ state: { user: f.teacher }, response, url: new URL('http://localhost/teacher/weekly/1'), id: f.author.id });
  assert.match(response.body, /<strong>完成实验<\/strong>/); assert.match(response.body, /工作计划插图/);
  const secondRich = document([{ type: 'bullet', runs: [{ text: '完成实验', italic: true }] }, { type: 'image', attachmentId: attachment.id }]);
  assert.equal((await f.post({ richEditor: '1', planRich: secondRich }, [], [attachment.id])).status, 303);
  const second = f.weekly.getReport(f.author.id, f.week);
  assert.equal(second.versions.length, 2); assert.equal(second.firstSubmittedAt, first.firstSubmittedAt);
  assert.equal(second.versions[1].planRich.blocks[0].runs[0].bold, true);
  // Publication controls synchronize even if the text itself did not change.
  assert.equal((await f.post({ richEditor: '1', planRich: secondRich, publicationControls: '1' }, [], [attachment.id], [])).status, 303);
  assert.equal(f.weekly.getReport(f.author.id, f.week).versions.length, 2); assert.equal(f.visibility.length, 2);
});

test('插图拒绝其他学生、其他周次及未保留的附件，失败完整回滚', async t => {
  const f = await fixture(t);
  const badDoc = document([paragraph('任务'), { type: 'image', attachmentId: 99999 }]);
  assert.equal((await f.post({ richEditor: '1', planRich: badDoc }, [png])).status, 422);
  assert.equal(f.db.prepare('SELECT count(*) n FROM weekly_attachments').get().n, 0);
  assert.equal(f.weekly.getReport(f.author.id, f.week), null);
  assert.equal((await f.post({ richEditor: '1', planRich: document([paragraph('任务'), { type: 'image', uploadIndex: 0 }]) }, [new File(['%PDF-1.7\n%%EOF'], '记录.pdf')])).status, 422);
  assert.equal(f.db.prepare('SELECT count(*) n FROM weekly_attachments').get().n, 0);
  await f.post({ richEditor: '1', planRich: document([paragraph('任务'), { type: 'image', uploadIndex: 0 }]) }, [png]);
  const id = f.weekly.getReport(f.author.id, f.week).latestVersion.attachments[0].id;
  assert.equal((await f.post({ richEditor: '1', planRich: document([paragraph('任务'), { type: 'image', attachmentId: id }]) })).status, 422);
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} };
  const preview = f.route('GET', '/student/weekly/images/' + id);
  preview({ state: { user: f.author }, response, id }); assert.equal(response.status, 200); assert.match(response.headers['Content-Disposition'], /^inline;/);
  assert.throws(() => preview({ state: { user: f.peer }, response, id }), { statusCode: 404 });
  assert.throws(() => preview({ state: { user: f.outsider }, response, id }), { statusCode: 403 });
  preview({ state: { user: f.teacher }, response, id }); assert.equal(response.status, 200);
  assert.throws(() => f.route('GET', '/teacher/weekly/1')({ state: { user: f.outsider }, response, url: new URL('http://localhost/teacher/weekly/1'), id: f.author.id }), { statusCode: 403 });
});

test('旧纯文字提交无需富文本字段，草稿不会发布动态', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ plan: '旧表单任务', action: 'draft', publicationControls: '1' }, [], [], ['plan'])).status, 303);
  assert.equal(f.visibility.length, 0);
  assert.equal((await f.post({ plan: '旧表单任务', action: 'submit' })).status, 303);
  assert.deepEqual(f.weekly.getReport(f.author.id, f.week).latestVersion.plan, ['旧表单任务']);
  assert.equal(f.weekly.getReport(f.author.id, f.week).latestVersion.planRich, undefined);
  assert.equal(f.visibility.length, 0);
});

test('失败回显保留文字与原有附件选择，说明新文件需要重新选择', async t => {
  const f = await fixture(t);
  await f.post({ plan: '原任务' }, [png]);
  const original = f.weekly.getReport(f.author.id, f.week), id = original.latestVersion.attachments[0].id;
  const result = await f.post({ plan: '修改后保留的文字', reading: '本周阅读笔记', richEditor: '1',
    planRich: document([paragraph('修改后保留的文字'), { type: 'image', attachmentId: 99999 }]) }, [png], [id]);
  assert.equal(result.status, 422);
  assert.match(result.body, /本次新选择的附件尚未保存，请重新选择/);
  assert.match(result.body, /修改后保留的文字/); assert.match(result.body, /本周阅读笔记/);
  assert.match(result.body, new RegExp('name="retainedAttachment" value="' + id + '" checked'));
  assert.equal(f.weekly.getReport(f.author.id, f.week).versions.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM weekly_attachments').get().n, 1);
});

test('不能把其他学生或其他周次图片作为本周插图保留', async t => {
  const f = await fixture(t);
  await f.post({ plan: '任务' }, [png]);
  const originalId = f.weekly.getReport(f.author.id, f.week).latestVersion.attachments[0].id;
  const copy = f.db.prepare(`INSERT INTO weekly_attachments(student_id,week,name,mime,bytes,size,created_at)
    SELECT ?,?,name,mime,bytes,size,created_at FROM weekly_attachments WHERE id=?`);
  const peerId = Number(copy.run(f.peer.id, f.week, originalId).lastInsertRowid);
  const anotherWeek = new Date(Date.parse(f.week + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  const oldId = Number(copy.run(f.author.id, anotherWeek, originalId).lastInsertRowid);
  for (const id of [peerId, oldId]) {
    await assert.rejects(() => f.post({ richEditor: '1', planRich: document([paragraph('任务'), { type: 'image', attachmentId: id }]) }, [], [id]), { statusCode: 404 });
  }
  assert.equal(f.weekly.getReport(f.author.id, f.week).versions.length, 1);
});

test('旧计划改为图文并重排时，保留原任务的完成映射', async t => {
  const f = await fixture(t);
  const prior = new Date(Date.parse(f.week + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  const reportId = Number(f.db.prepare('INSERT INTO weekly_reports(student_id,week,first_submitted_at,first_cutoff_at,revision) VALUES(?,?,?,?,1)').run(f.author.id, prior, Date.now(), Date.now()).lastInsertRowid);
  const content = { plan: ['任务A', '任务B'], reading: '', experiments: '', difficulties: '', relatedTopic: null, attachments: [] };
  const versionId = Number(f.db.prepare('INSERT INTO weekly_versions(report_id,content,created_at) VALUES(?,?,?)').run(reportId, JSON.stringify(content), Date.now()).lastInsertRowid);
  f.db.prepare('INSERT INTO weekly_task_changes(student_id,week,origin_version_id,task_index,done,changed_at) VALUES(?,?,?,?,?,?)').run(f.author.id, f.week, versionId, 0, 1, Date.now());
  const response = await f.post({ week: prior, revision: '1', richEditor: '1', planRich: document([
    { type: 'bullet', runs: [{ text: '任务B', bold: true }] },
    { type: 'bullet', runs: [{ text: '任务A', italic: true }] }, { type: 'image', uploadIndex: 0 }
  ]) }, [png]);
  assert.equal(response.status, 303);
  assert.deepEqual(f.weekly.taskProgress(f.author.id, prior).map(task => [task.text, task.done]), [['任务B', false], ['任务A', true]]);
});
