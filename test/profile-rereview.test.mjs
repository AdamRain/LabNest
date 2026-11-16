import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';

const password = 'Profile-review-test-only-53';
const privateNotice = 'PRIVATE_REREVIEW_NOTICE_SENTINEL';
const privateFile = 'PRIVATE_REREVIEW_FILE_SENTINEL';
const internalPage = /workspace-shell|home-desk--student|data-student-dynamics-feed|PRIVATE_REREVIEW_(?:NOTICE|FILE)_SENTINEL/;

function application(email, overrides = {}) {
  return { name: '原资料测试学生', email, phone: '13900008801', password,
    level: 'graduate', studentStatus: 'active', studentNumber: '20260001', major: '计算机技术',
    relationship: 'direct', advisor: '', activities: ['竞赛', '小论文'], ...overrides };
}

function profile(user, overrides = {}) {
  return Object.fromEntries(Object.entries({ profileFields: '1',
    name: user.name, email: user.email, phone: user.phone ?? '', level: user.level,
    studentStatus: user.studentStatus, studentNumber: user.studentNumber ?? '', major: user.major,
    relationship: user.relationship, advisor: user.advisor ?? '', activities: user.activities, ...overrides }));
}

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const options = { undergradIdLength: 10, gradIdLength: 8 };
  const accounts = openAccounts(db, options);
  const teacher = await accounts.createTeacher({ name: '审核测试教师', email: 'teacher@rereview.example', password });
  const author = await accounts.register(application('author@rereview.example'));
  const peer = await accounts.register(application('peer@rereview.example', { name: '另一位测试学生', phone: '13900008803' }));
  for (const user of [author, peer]) accounts.reviewStudent(teacher.id, user.id, 'approved');
  const server = createLabServer({ db, options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO member_notices(title,body,published_at,updated_at) VALUES (?,?,?,?)')
    .run(privateNotice, '仅用于验证审核隔离', stamp, stamp);

  function client() {
    const cookies = new Map();
    let csrf = '';
    return {
      async go(path, values = null) {
        const init = { redirect: 'manual', headers: {
          Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ')
        } };
        if (values) {
          init.method = 'POST';
          if (values instanceof FormData) {
            if (!values.has('csrf')) values.set('csrf', csrf);
            init.body = values;
          } else {
            const form = new URLSearchParams();
            for (const [key, value] of Object.entries({ csrf, ...values })) {
              for (const item of Array.isArray(value) ? value : [value]) {
                if (item !== undefined) form.append(key, String(item ?? ''));
              }
            }
            init.body = form;
          }
        }
        const response = await fetch(base + path, init);
        const bytes = Buffer.from(await response.arrayBuffer());
        const text = bytes.toString();
        for (const cookie of response.headers.getSetCookie()) {
          const [key, value] = cookie.split(';')[0].split('=');
          if (value) cookies.set(key, value); else cookies.delete(key);
        }
        csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? csrf;
        return { response, text, bytes };
      },
      async login(user) {
        await this.go('/login');
        assert.equal((await this.go('/login', { identifier: user.email, password })).response.status, 303);
        assert.equal((await this.go(user.role === 'teacher' ? '/teacher' : '/student')).response.status, 200);
      }
    };
  }
  const owner = client();
  const secondSession = client();
  const admin = client();
  await owner.login(author);
  await secondSession.login(author);
  await admin.login(teacher);
  return { db, accounts, teacher, author: accounts.getUser(author.id), peer: accounts.getUser(peer.id),
    client, owner, secondSession, admin };
}

test('修改注册资料重新审核，既有会话立即隔离，教师处理后可恢复且历史周报附件保留', async t => {
  const f = await fixture(t);
  const page = await f.owner.go('/student/profile');
  for (const name of ['name', 'major', 'level', 'studentStatus', 'studentNumber', 'relationship', 'advisor', 'activities']) {
    assert.match(page.text, new RegExp(`name="${name}"`), `个人信息应提供 ${name} 编辑入口`);
  }
  const weeklyPage = await f.owner.go('/student/weekly');
  const week = weeklyPage.text.match(/name="week"[^>]*value="([^"]+)"/)[1];
  const weeklyForm = new FormData();
  for (const [key, value] of Object.entries({ week, revision: '0', action: 'submit', plan: '审核前的历史计划' })) {
    weeklyForm.set(key, value);
  }
  weeklyForm.set('attachments', new File(['%PDF-1.7\n' + privateFile + '\n%%EOF'], '历史实验记录.pdf', { type: 'application/pdf' }));
  assert.equal((await f.owner.go('/student/weekly', weeklyForm)).response.status, 303);
  const report = f.db.prepare('SELECT * FROM weekly_reports WHERE student_id=?').get(f.author.id);
  const attachment = f.db.prepare('SELECT * FROM weekly_attachments WHERE student_id=?').get(f.author.id);
  const filePath = '/student/weekly/attachments/' + attachment.id;
  await f.owner.go('/student/homepage');
  assert.equal((await f.owner.go('/student/homepage', { revision: '0', bio: '用于验证审核期间的公开状态' })).response.status, 303);
  assert.equal((await f.owner.go('/student/homepage/publish', { revision: '1', confirmPublic: '1' })).response.status, 303);
  assert.equal((await f.client().go('/people/' + f.author.id)).response.status, 200);

  const auditId = f.db.prepare('SELECT coalesce(max(id),0) AS id FROM account_audit').get().id;
  const changed = await f.owner.go('/student/profile', profile(f.accounts.getUser(f.author.id), {
    name: '更正后的学生', email: ' Updated.Author@Rereview.Example ', phone: '+86 13900008802',
    major: '智能科学与技术', level: 'undergraduate', studentNumber: '2026000001',
    relationship: 'assisted', advisor: '协助指导导师', activities: ['小论文', '研究生毕业论文'],
    studentId: String(f.peer.id), id: String(f.peer.id), role: 'teacher', reviewStatus: 'approved'
  }));
  assert.equal(changed.response.status, 303);
  assert.equal(changed.response.headers.get('location'), '/student?done=profileReview');
  const updated = f.accounts.getUser(f.author.id);
  assert.equal(updated.reviewStatus, 'pending');
  assert.equal(updated.role, 'student');
  assert.equal(updated.name, '更正后的学生');
  assert.equal(updated.email, 'updated.author@rereview.example');
  assert.equal(updated.phone, '13900008802');
  assert.equal(updated.major, '智能科学与技术');
  assert.equal(updated.level, 'undergraduate');
  assert.equal(updated.studentNumber, '2026000001');
  assert.equal(updated.relationship, 'assisted');
  assert.equal(updated.advisor, '协助指导导师');
  assert.deepEqual(updated.activities, ['小论文', '研究生毕业论文']);
  assert.deepEqual(f.accounts.getUser(f.peer.id), f.peer);
  const audit = f.db.prepare('SELECT * FROM account_audit WHERE id>? AND actor_id=? AND student_id=?').all(auditId, f.author.id, f.author.id);
  assert.ok(audit.length > 0, '资料变动须有审计记录');
  assert.match(audit.map(row => row.previous_value).join('\n'), /原资料测试学生/);
  assert.match(audit.map(row => row.new_value).join('\n'), /更正后的学生/);

  for (const session of [f.owner, f.secondSession]) {
    const waiting = await session.go('/student?done=profileReview');
    assert.equal(waiting.response.status, 200);
    assert.match(waiting.text, /等待教师审核/);
    assert.doesNotMatch(waiting.text, internalPage);
    for (const path of ['/student/profile', '/student/notices', '/student/weekly', filePath, '/student/resume.pdf']) {
      const blocked = await session.go(path);
      assert.equal(blocked.response.status, 403, path);
      assert.doesNotMatch(blocked.text, internalPage);
    }
    assert.equal((await session.go('/student/profile/birthday', { birthday: '2000-02-03' })).response.status, 403);
    assert.equal((await session.go('/student/profile', { name: '绕过审核的修改' })).response.status, 403);
  }
  assert.equal((await f.client().go('/people/' + f.author.id)).response.status, 404);
  assert.deepEqual(f.db.prepare('SELECT * FROM weekly_reports WHERE student_id=?').get(f.author.id), report);
  assert.deepEqual(f.db.prepare('SELECT * FROM weekly_attachments WHERE id=?').get(attachment.id), attachment);
  const teacherReview = await f.admin.go('/teacher');
  assert.match(teacherReview.text, /本次资料修改/);
  assert.match(teacherReview.text, /修改前：[\s\S]*原资料测试学生/);
  assert.match(teacherReview.text, /修改后：[\s\S]*更正后的学生/);
  assert.match(teacherReview.text, /智能科学与技术/);
  assert.equal((await f.admin.go(`/teacher/students/${f.author.id}/review`, { decision: 'approved' })).response.status, 303);
  for (const session of [f.owner, f.secondSession]) {
    assert.match((await session.go('/student/notices')).text, new RegExp(privateNotice));
    assert.equal((await session.go('/student/profile')).response.status, 200);
    assert.equal((await session.go(filePath)).text.includes(privateFile), true);
  }
  assert.equal((await f.client().go('/people/' + f.author.id)).response.status, 200);

  assert.equal((await f.owner.go('/student/profile', { name: '再次更正姓名' })).response.status, 303);
  assert.equal((await f.admin.go(`/teacher/students/${f.author.id}/review`, { decision: 'rejected', reason: '请核对专业名称' })).response.status, 303);
  const rejected = await f.owner.go('/student');
  assert.match(rejected.text, /请核对专业名称/);
  assert.match(rejected.text, /action="\/student\/reapply"/);
  assert.doesNotMatch(rejected.text, internalPage);
  assert.equal((await f.owner.go('/student/profile', { major: '不能直接修改' })).response.status, 403);
  const resubmitted = await f.owner.go('/student/reapply', profile(f.accounts.getUser(f.author.id), { major: '核对后的专业' }));
  assert.equal(resubmitted.response.status, 303);
  assert.equal(f.accounts.getUser(f.author.id).reviewStatus, 'pending');
  assert.deepEqual(f.accounts.getUser(f.author.id).activities, ['小论文', '研究生毕业论文'], '部分资料修改和重提不能意外清空参与事项');
  assert.equal((await f.admin.go(`/teacher/students/${f.author.id}/review`, { decision: 'approved' })).response.status, 303);
  assert.equal((await f.secondSession.go('/student/profile')).response.status, 200);
});

test('注册资料校验及CSRF失败不更改档案，教师、访客和毕业生不能调用学生修改接口', async t => {
  const f = await fixture(t);
  const before = f.accounts.getUser(f.author.id);
  const auditCount = f.db.prepare('SELECT count(*) AS n FROM account_audit').get().n;
  for (const [form, status] of [[{ name: '' }, 400], [{ email: f.teacher.email }, 409],
    [{ relationship: 'assisted', advisor: '' }, 400], [{ level: 'undergraduate', studentNumber: '123' }, 400]]) {
    assert.equal((await f.owner.go('/student/profile', form)).response.status, status);
    assert.deepEqual(f.accounts.getUser(f.author.id), before);
  }
  assert.equal((await f.owner.go('/student/profile', { csrf: 'invalid-token', name: '不该保存的姓名' })).response.status, 403);
  assert.deepEqual(f.accounts.getUser(f.author.id), before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM account_audit').get().n, auditCount);
  assert.equal((await f.admin.go('/student/profile', { name: '不该保存的姓名' })).response.status, 403);
  assert.equal((await f.admin.go('/student/profile/birthday', { birthday: '2000-02-03' })).response.status, 403);
  const guest = f.client();
  await guest.go('/login');
  assert.equal((await guest.go('/student/profile', { name: '不该保存的姓名' })).response.status, 403);
  f.accounts.setStudentStatus(f.teacher.id, f.author.id, 'graduated', before.studentNumber);
  const graduated = f.accounts.getUser(f.author.id);
  assert.equal((await f.owner.go('/student/profile', { name: '毕业后修改' })).response.status, 403);
  assert.equal((await f.owner.go('/student/profile/birthday', { birthday: '2000-02-03' })).response.status, 403);
  assert.deepEqual(f.accounts.getUser(f.author.id), graduated);
});

test('无实际变更不重审，生日和生活照可直接更新，完整表单可以清空全部参与事项', async t => {
  const f = await fixture(t);
  const normalized = await f.owner.go('/student/profile', profile(f.accounts.getUser(f.author.id), {
    name: ' 原资料测试学生 ', email: ' AUTHOR@REREVIEW.EXAMPLE ', phone: '+86 13900008801'
  }));
  assert.equal(normalized.response.status, 303);
  assert.equal(f.accounts.getUser(f.author.id).reviewStatus, 'approved');
  assert.deepEqual(f.accounts.getUser(f.author.id).activities, ['竞赛', '小论文']);
  const birthday = await f.owner.go('/student/profile/birthday', { birthday: '2000-02-03', studentId: String(f.peer.id) });
  assert.equal(birthday.response.status, 303);
  assert.equal(f.accounts.getUser(f.author.id).birthday, '2000-02-03');
  assert.equal(f.accounts.getUser(f.author.id).reviewStatus, 'approved');
  assert.equal(f.accounts.getUser(f.peer.id).birthday, null);
  assert.equal((await f.owner.go('/student/profile/birthday', { birthday: '2000-02-31' })).response.status, 400);
  assert.equal(f.accounts.getUser(f.author.id).birthday, '2000-02-03');
  const photo = new FormData();
  // Generated 1x1 RGBA PNG with valid chunk CRCs; the previous fixture had a bad IDAT CRC.
  photo.set('photo', new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIaMr7DwAEpgJAnLuvYQAAAABJRU5ErkJggg==', 'base64')], 'test-photo.png', { type: 'image/png' }));
  assert.equal((await f.owner.go('/student/photo', photo)).response.status, 303);
  assert.equal(f.accounts.getUser(f.author.id).reviewStatus, 'approved');
  assert.equal((await f.owner.go('/student/photo/' + f.author.id)).response.status, 200);
  assert.equal((await f.owner.go('/student/photo/remove', {})).response.status, 303);
  assert.equal(f.accounts.getUser(f.author.id).reviewStatus, 'approved');
  assert.equal((await f.owner.go('/student/photo/' + f.author.id)).response.status, 404);
  const cleared = await f.owner.go('/student/profile', profile(f.accounts.getUser(f.author.id), { activities: [], birthday: '2001-01-01' }));
  assert.equal(cleared.response.status, 303);
  assert.equal(f.accounts.getUser(f.author.id).reviewStatus, 'pending');
  assert.deepEqual(f.accounts.getUser(f.author.id).activities, []);
  assert.equal(f.accounts.getUser(f.author.id).birthday, '2000-02-03', '生日只能通过独立生日接口更新');
});
