import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';

const password = 'Approval-access-test-only-82';
const privateContent = /PRIVATE_(?:NOTICE|PROFILE|WEEKLY|DYNAMIC|TOPIC|FILE|PHOTO)_SENTINEL/;
const internalNavigation = /workspace-shell|class="workspace-(?:page|sidebar)"|home-desk--student|data-student-dynamics-feed|src="\/student-dynamics\.js|href="\/student\/(?:profile|homepage|weekly|notices|dynamics|calendar|topics|guide)/;

function application(email, overrides = {}) {
  return { name: '测试申请人', email, password, phone: '', level: 'graduate',
    studentStatus: 'active', studentNumber: '20260882', major: '测试专业',
    relationship: 'direct', ...overrides };
}

function isolated(page) {
  assert.doesNotMatch(page.text, privateContent);
  assert.doesNotMatch(page.text, internalNavigation);
}

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const teacher = await accounts.createTeacher({ name: '测试教师', email: 'teacher@approval.example', password });
  const author = await accounts.register(application('author@approval.example', { name: '已审核测试成员' }));
  accounts.reviewStudent(teacher.id, author.id, 'approved');
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
        const init = { redirect: 'manual', headers: {
          Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ')
        } };
        if (form) {
          init.method = 'POST';
          if (form instanceof FormData) { form.set('csrf', csrf); init.body = form; }
          else init.body = new URLSearchParams({ csrf, ...form });
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
      },
      async register(email) {
        await this.go('/register');
        const result = await this.go('/register', application(email));
        assert.equal(result.response.status, 303);
        assert.equal(result.response.headers.get('location'), '/student?done=registered');
        return accounts.listStudents().find(student => student.email === email);
      }
    };
  }

  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO member_notices(title,body,published_at,updated_at) VALUES (?,?,?,?)')
    .run('PRIVATE_NOTICE_SENTINEL', '内部测试通知正文', stamp, stamp);
  db.prepare('INSERT INTO portal_profile(id,content) VALUES (1,?)')
    .run(JSON.stringify({ name: '测试团队', intro: 'PUBLIC_PORTAL_SENTINEL' }));
  db.prepare('INSERT INTO student_photos(studentId,mime,bytes) VALUES (?,?,?)')
    .run(author.id, 'image/png', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('PRIVATE_PHOTO_SENTINEL')]));

  const publisher = client();
  await publisher.login(author);
  const dynamics = await publisher.go('/student/dynamics');
  const week = dynamics.text.match(/name="week" value="([^"]+)"/)[1];
  const weekly = new FormData();
  for (const [key, value] of Object.entries({ week, revision: '0', action: 'submit',
    plan: '本周测试计划', reading: 'PRIVATE_DYNAMIC_SENTINEL', experiments: 'PRIVATE_WEEKLY_SENTINEL' })) {
    weekly.set(key, value);
  }
  weekly.set('attachments', new File(['%PDF-1.7\nPRIVATE_FILE_SENTINEL\n%%EOF\n'], 'test-private.pdf', { type: 'application/pdf' }));
  assert.equal((await publisher.go('/student/weekly', weekly)).response.status, 303);
  assert.equal((await publisher.go('/student/dynamics/visibility', { kind: 'reading', week, published: '1' })).response.status, 303);
  assert.equal((await publisher.go('/student/topics', {
    title: 'PRIVATE_TOPIC_SENTINEL', abstract: '仅用于访问边界测试的课题', stage: '0'
  })).response.status, 303);
  assert.equal((await publisher.go('/student/homepage', { revision: '0', bio: 'PUBLIC_PERSON_SENTINEL' })).response.status, 303);
  assert.equal((await publisher.go('/student/homepage/publish', { revision: '1', confirmPublic: '1' })).response.status, 303);
  assert.equal((await publisher.go('/student/homepage', { revision: '1', bio: 'PRIVATE_PROFILE_SENTINEL' })).response.status, 303);

  return { db, accounts, teacher, author, publisher, client, week,
    publicationId: db.prepare('SELECT id FROM weekly_publications').get().id,
    topicId: db.prepare('SELECT id FROM paper_topics').get().id,
    attachmentId: db.prepare('SELECT id FROM weekly_attachments').get().id };
}

test('待审核和驳回账号的内部页面、直接详情、附件及合法 CSRF 写入均被拒绝', async t => {
  const { db, accounts, teacher, author, client, week, publicationId, topicId, attachmentId } = await fixture(t);
  for (const reviewStatus of ['pending', 'rejected']) {
    const user = await accounts.register(application(`${reviewStatus}@approval.example`));
    if (reviewStatus === 'rejected') accounts.reviewStudent(teacher.id, user.id, 'rejected', '请补全申请资料');
    const applicant = client();
    await applicant.login(user);
    const statusPage = await applicant.go('/student');
    assert.equal(statusPage.response.status, 200);
    assert.match(statusPage.text, /name="csrf"\s+value="[^"]+"/);
    isolated(statusPage);

    const getPaths = ['/student/profile', `/student/profile?studentId=${author.id}`,
      '/student/homepage', '/student/resume.pdf', '/student/resume.docx',
      `/student/photo/${user.id}`, `/student/photo/${author.id}`, '/student/notices',
      '/student/dynamics', '/student/dynamics/feed', `/student/dynamics/${publicationId}`,
      '/student/calendar', '/student/topics', `/student/topics/${topicId}`, '/student/guide',
      '/student/weekly', `/student/weekly?studentId=${author.id}&week=${week}`,
      `/student/weekly/attachments/${attachmentId}`, '/student/graduation', '/student/internships',
      `/teacher/weekly/${author.id}`];
    for (const path of getPaths) {
      const page = await applicant.go(path);
      assert.equal(page.response.status, 403, `${reviewStatus}: GET ${path}`);
      isolated(page);
    }
    const postPaths = ['/student/profile', '/student/photo', '/student/photo/remove',
      '/student/homepage', '/student/homepage/publish', '/student/homepage/unpublish',
      '/student/weekly', '/student/weekly/tasks', '/student/weekly/leave',
      '/student/dynamics/publish', '/student/dynamics/visibility', `/student/dynamics/${publicationId}/withdraw`,
      '/student/topics', `/student/topics/${topicId}/join`, `/student/topics/${topicId}/edit`,
      `/student/topics/${topicId}/points`, '/student/welcome/dismiss'];
    for (const path of postPaths) {
      let form = { ...application(user.email), week, revision: '0', action: 'submit',
        kind: 'reading', published: '1', title: 'unauthorized change', bio: 'unauthorized change' };
      if (path === '/student/photo') {
        form = new FormData();
        form.set('photo', new File([Buffer.from('89504e470d0a1a0a', 'hex')], 'test.png', { type: 'image/png' }));
      }
      const result = await applicant.go(path, form);
      assert.equal(result.response.status, 403, `${reviewStatus}: POST ${path}`);
      assert.doesNotMatch(result.text, /页面已过期/, '本请求使用有效 CSRF，必须由审核权限拒绝');
      isolated(result);
    }
    assert.equal(accounts.getUser(user.id).reviewStatus, reviewStatus);
    assert.equal(db.prepare('SELECT count(*) AS n FROM weekly_reports WHERE student_id=?').get(user.id).n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM student_sites WHERE student_id=?').get(user.id).n, 0);
  }
  assert.equal(db.prepare('SELECT title FROM paper_topics WHERE id=?').get(topicId).title, 'PRIVATE_TOPIC_SENTINEL');
  assert.equal(db.prepare('SELECT count(*) AS n FROM weekly_publications WHERE revoked_at IS NULL').get().n, 1);
});

test('注册会话只显示审核进度，教师批准后同一会话才能看到内部通知及工作台', async t => {
  const { accounts, teacher, client } = await fixture(t);
  const applicant = client();
  const student = await applicant.register('new-student@approval.example');
  assert.equal(student.reviewStatus, 'pending');
  for (const path of ['/student?done=registered', '/student?tour=1', '/student?done=profile']) {
    const page = await applicant.go(path);
    assert.equal(page.response.status, 200);
    assert.match(page.text, /等待教师审核|请等教师审核/);
    isolated(page);
  }
  assert.equal((await applicant.go('/student/reapply', application(student.email))).response.status, 403);
  const admin = client();
  await admin.login(teacher);
  assert.match((await admin.go('/teacher/notices')).text, /PRIVATE_NOTICE_SENTINEL/);
  assert.equal((await admin.go(`/teacher/students/${student.id}/review`, { decision: 'approved' })).response.status, 303);
  assert.equal(accounts.getUser(student.id).reviewStatus, 'approved');
  const workspace = await applicant.go('/student');
  assert.equal(workspace.response.status, 200);
  assert.match(workspace.text, /学生工作台/);
  assert.match(workspace.text, /PRIVATE_NOTICE_SENTINEL/);
  assert.match((await applicant.go('/student/notices')).text, /PRIVATE_NOTICE_SENTINEL/);
  assert.match((await applicant.go('/student/dynamics/feed')).text, /PRIVATE_DYNAMIC_SENTINEL/);
  assert.equal((await applicant.go('/student/profile')).response.status, 200);
  assert.equal((await applicant.go('/student/homepage')).response.status, 200);
});

test('驳回只允许重提申请，重提仍待审；公开内容和教师读取保持可用', async t => {
  const { accounts, teacher, author, publisher, client, attachmentId } = await fixture(t);
  const applicant = client();
  const student = await applicant.register('reapply@approval.example');
  const admin = client();
  await admin.login(teacher);
  assert.equal((await admin.go(`/teacher/students/${student.id}/review`, {
    decision: 'rejected', reason: '请补全测试专业名称'
  })).response.status, 303);
  const rejected = await applicant.go('/student');
  assert.equal(rejected.response.status, 200);
  assert.match(rejected.text, /请补全测试专业名称/);
  assert.match(rejected.text, /action="\/student\/reapply"/);
  isolated(rejected);
  const reapply = await applicant.go('/student/reapply', application(student.email, { major: '补充后的测试专业' }));
  assert.equal(reapply.response.status, 303);
  assert.equal(reapply.response.headers.get('location'), '/student?done=reapplied');
  assert.equal(accounts.getUser(student.id).reviewStatus, 'pending');
  assert.equal(accounts.getUser(student.id).major, '补充后的测试专业');
  const waiting = await applicant.go('/student?done=reapplied');
  assert.match(waiting.text, /等待教师审核|请等教师审核/);
  isolated(waiting);
  assert.equal((await applicant.go('/student/notices')).response.status, 403);
  assert.equal((await applicant.go('/student/profile', { email: student.email })).response.status, 403);
  assert.equal((await applicant.go('/student/reapply', application(student.email))).response.status, 403);

  for (const reader of [client(), applicant]) {
    for (const [path, marker] of [['/portal', /PUBLIC_PORTAL_SENTINEL/], [`/people/${author.id}`, /PUBLIC_PERSON_SENTINEL/]]) {
      const page = await reader.go(path);
      assert.equal(page.response.status, 200);
      assert.match(page.text, marker);
      assert.doesNotMatch(page.text, privateContent);
    }
  }
  assert.match((await publisher.go('/student/homepage')).text, /PRIVATE_PROFILE_SENTINEL/);
  const teacherReport = await admin.go(`/teacher/weekly/${author.id}`);
  assert.equal(teacherReport.response.status, 200);
  assert.match(teacherReport.text, /PRIVATE_WEEKLY_SENTINEL/);
  const attachment = await admin.go(`/student/weekly/attachments/${attachmentId}`);
  assert.equal(attachment.response.status, 200);
  assert.match(attachment.text, /PRIVATE_FILE_SENTINEL/);
});
