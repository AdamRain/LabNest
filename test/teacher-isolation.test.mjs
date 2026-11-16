import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';

const password = 'Isolated-local-role-test-83';
const sentinels = /SECRET_(?:STUDENT|REPORT|TOPIC|TASK|INTERNSHIP|PHOTO|FILE)/;
const application = (email, teacher) => ({ name: 'SECRET_STUDENT', email, password, major: '计算机',
  level: 'graduate', relationship: 'direct', studentStatus: 'active', studentNumber: '20260002', primaryTeacherId: teacher.id });

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const accounts = openAccounts(db);
  const admin = await accounts.createAdmin({ name: '管理员', email: 'admin@isolation.example', password });
  const main = await accounts.createTeacher({ name: '主导师', email: 'main@isolation.example', password });
  const secondary = await accounts.createTeacher({ name: '副导师', email: 'second@isolation.example', password });
  const unrelated = await accounts.createTeacher({ name: '无关教师', email: 'other@isolation.example', password });
  let student = await accounts.register(application('student@isolation.example', main));
  accounts.assignTeachers(admin.id, student.id, { primaryTeacherId: main.id, secondaryTeacherId: secondary.id });
  accounts.reviewStudent(main.id, student.id, 'approved');
  student = accounts.getUser(student.id);
  const server = createLabServer({ db });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    const cookies = new Map(); let csrf = '';
    return {
      async go(path, form = null) {
        const init = { redirect: 'manual', headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } };
        if (form) {
          init.method = 'POST';
          if (form instanceof FormData) { form.set('csrf', csrf); init.body = form; }
          else init.body = new URLSearchParams({ csrf, ...form });
        }
        const response = await fetch(base + path, init); const text = await response.text();
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
        await this.go(user.role === 'admin' ? '/admin' : user.role === 'teacher' ? '/teacher' : '/student');
      }
    };
  }
  const author = client(); await author.login(student);
  const weekly = await author.go('/student/weekly');
  const week = weekly.text.match(/name="week" value="([^"]+)"/)[1];
  const report = new FormData();
  for (const [key, value] of Object.entries({ week, revision: '0', action: 'submit', plan: 'SECRET_REPORT', reading: '阅读', experiments: '实验' })) report.set(key, value);
  report.set('attachments', new File(['%PDF-1.7\nSECRET_FILE\n%%EOF\n'], 'private.pdf', { type: 'application/pdf' }));
  assert.equal((await author.go('/student/weekly', report)).response.status, 303);
  assert.equal((await author.go('/student/topics', { title: 'SECRET_TOPIC', abstract: '私有课题摘要', stage: '0' })).response.status, 303);
  const taskId = Number(db.prepare("INSERT INTO graduation_tasks(student_id,title,due_date) VALUES (?,'SECRET_TASK',?)").run(student.id, week).lastInsertRowid);
  const internshipId = Number(db.prepare(`INSERT INTO internships(student_id,organization,position,location,start_date,end_date,notes,submitted_at)
    VALUES (?,'SECRET_INTERNSHIP','研究','西安',?,?,'备注',?)`).run(student.id, week, week, new Date().toISOString()).lastInsertRowid);
  db.prepare('INSERT INTO student_photos(studentId,mime,bytes) VALUES (?,?,?)').run(student.id, 'image/png', Buffer.from('SECRET_PHOTO'));
  return { db, accounts, admin, main, secondary, unrelated, student, client, week, taskId, internshipId,
    attachmentId: db.prepare('SELECT id FROM weekly_attachments').get().id,
    topicId: db.prepare('SELECT id FROM paper_topics').get().id };
}

test('主、副指导教师均可查看名下学生；无关教师列表、日历、详情和下载不能泄露资料', async t => {
  const f = await fixture(t);
  for (const teacher of [f.main, f.secondary]) {
    const reader = f.client(); await reader.login(teacher);
    for (const path of ['/teacher', '/teacher/weekly', '/teacher/graduation', '/teacher/internships', '/teacher/topics']) {
      assert.match((await reader.go(path)).text, sentinels, path);
    }
    assert.match((await reader.go(`/teacher/weekly/${f.student.id}?week=${f.week}`)).text, /SECRET_REPORT/);
    assert.equal((await reader.go(`/teacher/weekly/attachments/${f.attachmentId}`)).response.status, 200);
    assert.equal((await reader.go(`/student/photo/${f.student.id}`)).response.status, 200);
  }
  const outsider = f.client(); await outsider.login(f.unrelated);
  for (const path of ['/teacher', '/teacher/weekly', '/teacher/graduation', '/teacher/internships', '/teacher/topics', '/teacher/calendar']) {
    const page = await outsider.go(path); assert.equal(page.response.status, 200, path); assert.doesNotMatch(page.text, sentinels, path);
  }
  for (const path of [`/teacher/weekly/${f.student.id}`, `/teacher/topics/${f.topicId}`, `/teacher/weekly/attachments/${f.attachmentId}`, `/student/weekly/attachments/${f.attachmentId}`, `/student/photo/${f.student.id}`]) {
    const denied = await outsider.go(path); assert.ok([403, 404].includes(denied.response.status), path); assert.doesNotMatch(denied.text, sentinels, path);
  }
  for (const [path, form] of [
    [`/teacher/students/${f.student.id}/status`, { studentStatus: 'graduated', studentNumber: '' }],
    [`/teacher/weekly/${f.student.id}/policy`, { week: f.week, scope: 'week', required: '0', weekday: '6', time: '23:59' }],
    [`/teacher/graduation/tasks/${f.taskId}/due`, { due: '2027-01-01' }],
    [`/teacher/internships/${f.internshipId}/review`, { decision: 'approved', note: '' }],
    ['/teacher/graduation/assign', { student: String(f.student.id), title: '越权任务', due: '2027-01-01' }]
  ]) assert.equal((await outsider.go(path, form)).response.status, 403, path);
  assert.equal(f.accounts.getUser(f.student.id).studentStatus, 'active');
  assert.equal(f.db.prepare('SELECT status FROM internships WHERE id=?').get(f.internshipId).status, 'pending');
  // Guidance changes take effect immediately, including in an already-open session.
  f.accounts.assignTeachers(f.admin.id, f.student.id, { primaryTeacherId: f.unrelated.id });
  assert.match((await outsider.go('/teacher')).text, /SECRET_STUDENT/);
  const previous = f.client(); await previous.login(f.main);
  assert.equal((await previous.go(`/teacher/weekly/${f.student.id}`)).response.status, 403);
});

test('教师注册需管理员审核；待审核教师的首页和合法请求都不能进入内部功能', async t => {
  const f = await fixture(t), applicant = f.client();
  const entry = await applicant.go('/register/teacher'); assert.equal(entry.response.status, 200);
  const submit = await applicant.go('/register/teacher', { name: '待审核教师', email: 'pending@isolation.example', password });
  assert.equal(submit.response.status, 303); assert.equal(submit.response.headers.get('location'), '/teacher/pending');
  const user = f.accounts.listUsers().find(user => user.email === 'pending@isolation.example');
  const progress = await applicant.go('/teacher/pending');
  assert.match(progress.text, /请等待管理员审核/); assert.doesNotMatch(progress.text, /workspace-shell|SECRET_/);
  for (const path of ['/teacher/weekly', '/teacher/mail', '/teacher/calendar', `/teacher/weekly/attachments/${f.attachmentId}`, '/admin']) {
    const denied = await applicant.go(path); assert.equal(denied.response.status, 403, path); assert.doesNotMatch(denied.text, sentinels);
  }
  assert.equal((await applicant.go(`/teacher/students/${f.student.id}/status`, { studentStatus: 'graduated' })).response.status, 403);
  assert.throws(() => f.accounts.reviewTeacher(f.main.id, user.id, 'approved'), { statusCode: 403 });
  f.accounts.reviewTeacher(f.admin.id, user.id, 'approved');
  const approved = await applicant.go('/teacher'); assert.equal(approved.response.status, 200); assert.doesNotMatch(approved.text, sentinels);
  f.accounts.assignTeachers(f.admin.id, f.student.id, { primaryTeacherId: f.main.id, secondaryTeacherId: user.id });
  assert.match((await applicant.go('/teacher')).text, /SECRET_STUDENT/);
});

test('教师可通过合法HTTP请求回复名下学生，保留CSRF与角色隔离，学生可继续回复教师', async t => {
  const f = await fixture(t);
  const postId = Number(f.db.prepare(`INSERT INTO weekly_publications(student_id,week,kind,body,published_at)
    VALUES (?,?,'difficulties','PUBLIC_HELP_FOR_TEACHER',?)`).run(f.student.id, f.week, new Date().toISOString()).lastInsertRowid);
  const main = f.client(), second = f.client(), outsider = f.client(), student = f.client();
  await main.login(f.main); await second.login(f.secondary); await outsider.login(f.unrelated); await student.login(f.student);
  const path = `/teacher/dynamics/${postId}/comments`;
  const page = await main.go(`/teacher/dynamics/${postId}`);
  assert.equal(page.response.status, 200); assert.match(page.text, new RegExp(`action="${path}"`));
  assert.equal((await main.go(path, { body: '错误CSRF不会保存', csrf: 'wrong-token' })).response.status, 403);
  assert.equal((await outsider.go(path, { body: '其他导师越权' })).response.status, 404);
  assert.equal((await student.go(path, { body: '学生借教师入口' })).response.status, 403);
  assert.equal((await main.go(`/student/dynamics/${postId}/comments`, { body: '教师借学生入口' })).response.status, 403);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM weekly_publication_comments').get().n, 0);
  const posted = await main.go(path, { body: '导师建议 <script>notExecutable</script>' });
  assert.equal(posted.response.status, 303); assert.match(posted.response.headers.get('location'), new RegExp(`/teacher/dynamics/${postId}\\?page=1#comment-`));
  const teacherComment = f.db.prepare('SELECT id,student_id FROM weekly_publication_comments').get();
  assert.equal(teacherComment.student_id, f.main.id);
  const studentView = await student.go(`/student/dynamics/${postId}`);
  assert.match(studentView.text, /主导师/); assert.match(studentView.text, /导师建议 &lt;script&gt;notExecutable&lt;\/script&gt;/);
  assert.doesNotMatch(studentView.text, /<script>notExecutable/);
  assert.equal((await student.go(`/student/dynamics/${postId}/comments`, { body: '学生继续询问', parentId: String(teacherComment.id) })).response.status, 303);
  assert.equal((await second.go(path, { body: '副导师补充建议', parentId: String(teacherComment.id) })).response.status, 303);
  const replied = await main.go(`/teacher/dynamics/${postId}`); assert.match(replied.text, /学生继续询问|副导师补充建议/);
  const studentComment = f.db.prepare('SELECT id FROM weekly_publication_comments WHERE student_id=?').get(f.student.id);
  assert.equal((await main.go(`/teacher/dynamics/comments/${studentComment.id}/delete`, {})).response.status, 404);
  assert.equal((await student.go(`/student/dynamics/comments/${teacherComment.id}/delete`, {})).response.status, 404);
  assert.equal((await main.go(`/teacher/dynamics/comments/${teacherComment.id}/delete`, {})).response.status, 303);
  assert.equal(f.db.prepare('SELECT body,deleted_at FROM weekly_publication_comments WHERE id=?').get(teacherComment.id).body, '[已删除]');
  assert.match((await student.go(`/student/dynamics/${postId}`)).text, /学生继续询问/);
  f.accounts.assignTeachers(f.admin.id, f.student.id, { primaryTeacherId: f.unrelated.id });
  assert.equal((await second.go(path, { body: '旧导师页面失效' })).response.status, 404);
  assert.equal((await outsider.go(path, { body: '新导师可以回复' })).response.status, 303);
  f.db.prepare('UPDATE weekly_publications SET revoked_at=? WHERE id=?').run(new Date().toISOString(), postId);
  assert.equal((await outsider.go(path, { body: '已撤回不可回复' })).response.status, 404);
});
