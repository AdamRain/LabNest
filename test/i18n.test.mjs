import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { createLabServer } from '../src/server.mjs';
import { h, locale, t as translate, withLocale, languageControl } from '../src/i18n.mjs';

const password = 'I18n-only-test-password-93';
const application = (teacher, overrides = {}) => ({
  name: 'Demo Student', email: 'student@i18n.example.test', phone: '', password,
  major: 'Computer Science', level: 'graduate', studentStatus: 'active',
  studentNumber: '20260093', relationship: 'direct', primaryTeacherId: teacher.id,
  activities: ['竞赛', '小论文'], ...overrides
});

async function fixture(testContext) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const accounts = openAccounts(db);
  const admin = await accounts.createAdmin({ name: 'Demo Admin', email: 'admin@i18n.example.test', password });
  const teacher = await accounts.createTeacher({ name: 'Demo Teacher', email: 'teacher@i18n.example.test', password });
  let student = await accounts.register(application(teacher));
  accounts.reviewStudent(teacher.id, student.id, 'approved');
  student = accounts.getUser(student.id);
  const server = createLabServer({ db });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  testContext.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client(language) {
    const cookies = new Map(language ? [['lab_language', language]] : []);
    let csrf = '';
    return {
      cookies,
      async go(path, form = null) {
        const init = { redirect: 'manual', headers: { Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') } };
        if (form) {
          init.method = 'POST';
          if (form instanceof FormData) { form.set('csrf', csrf); init.body = form; }
          else {
            const body = new URLSearchParams({ csrf });
            for (const [key, value] of Object.entries(form)) {
              if (Array.isArray(value)) value.forEach(item => body.append(key, String(item)));
              else body.set(key, String(value));
            }
            init.body = body;
          }
        }
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
        const result = await this.go('/login', { identifier: user.email, password });
        assert.equal(result.response.status, 303);
        return this.go('/' + user.role);
      }
    };
  }
  return { db, accounts, admin, teacher, student, client };
}

function visibleText(html) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}
function englishPage(result, path) {
  assert.equal(result.response.status, 200, path);
  assert.equal(result.response.headers.get('content-language'), 'en', path);
  assert.match(result.text, /<html lang="en">/, path);
  assert.match(result.text, /data-language-switch/, path);
  assert.match(result.text, />中文<\/span>/, path);
  // With ASCII fixture data, the only intentional Chinese is the language switch.
  assert.deepEqual(visibleText(result.text).replaceAll('中文', '').match(/[\u3400-\u9fff]+/g) ?? [], [], path);
  const displayAttributes = [...result.text.matchAll(/\b(?:title|aria-label|aria-description|placeholder|alt|label)="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(displayAttributes.filter(value => /[\u3400-\u9fff]/.test(value)), [], path + ' display attributes');
}

test('i18n translates literal text and accessible attributes while preserving interpolated content and machine values', () => {
  const userText = '登录';
  withLocale('en', () => {
    const page = h`<label title="登录" aria-label="密码">登录 ${userText}<input name="登录" value="登录" data-note="登录" data-label="登录" placeholder="邮箱"></label>`;
    assert.match(page, /title="Sign in"/);
    assert.match(page, /aria-label="Password"/);
    assert.match(page, />Sign in 登录<input/);
    assert.match(page, /placeholder="Email"/);
    assert.match(page, /name="登录" value="登录" data-note="登录" data-label="登录"/);
    assert.equal(h`<p>${'<em>登录</em>'}</p>`, '<p><em>登录</em></p>');
    assert.equal(h`<p>保存并启用</p>`, '<p>Save &amp; enable</p>');
  });
  withLocale('zh-CN', () => {
    assert.equal(h`<button title="登录">登录 ${userText}</button>`, '<button title="登录">登录 登录</button>');
  });
});

test('concurrent asynchronous locale contexts remain isolated and return to the Chinese default', async () => {
  await Promise.all(Array.from({ length: 16 }, (_, index) => {
    const language = index % 2 ? 'zh-CN' : 'en';
    return withLocale(language, async () => {
      await setImmediate();
      assert.equal(locale(), language);
      assert.equal(translate('登录'), language === 'en' ? 'Sign in' : '登录');
      await withLocale(language === 'en' ? 'zh-CN' : 'en', async () => { await setImmediate(); });
      assert.equal(locale(), language);
    });
  }));
  assert.equal(locale(), 'zh-CN');
  assert.equal(translate('登录'), '登录');
});

test('language switch persists a bounded preference and keeps local query and fragment without accepting an external redirect', async context => {
  const f = await fixture(context), guest = f.client();
  const destination = '/student/calendar?view=list&month=2026-11#day-16';
  const change = await guest.go('/language?' + new URLSearchParams({ lang: 'en', returnTo: destination }));
  assert.equal(change.response.status, 303);
  assert.equal(change.response.headers.get('location'), destination);
  const cookie = change.response.headers.getSetCookie().find(value => value.startsWith('lab_language='));
  assert.match(cookie, /^lab_language=en;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  englishPage(await guest.go('/login'), '/login after switch');
  for (const returnTo of ['https://external.example/', '//external.example/path', '/\\external.example/', '/login\r\nLocation: https://external.example/', '/language?lang=en']) {
    const result = await guest.go('/language?' + new URLSearchParams({ lang: 'en', returnTo }));
    assert.equal(result.response.status, 303);
    assert.equal(result.response.headers.get('location'), '/', returnTo);
  }
  for (const lang of ['fr', '', 'EN', '<script>']) {
    const invalid = await guest.go('/language?' + new URLSearchParams({ lang, returnTo: '/login' }));
    assert.equal(invalid.response.status, 400, lang);
    assert.equal(invalid.response.headers.getSetCookie().length, 0, lang);
    assert.equal(guest.cookies.get('lab_language'), 'en');
  }
  const chinese = await guest.go('/language?lang=zh-CN&returnTo=%2Flogin');
  assert.equal(chinese.response.headers.get('location'), '/login');
  const login = await guest.go('/login');
  assert.match(login.text, /<html lang="zh-CN">/);
  assert.match(login.text, />English<\/span>/);
  assert.match(login.text, /邮箱或手机号/);
  withLocale('en', () => assert.match(languageControl(), /hreflang="zh-CN"/));
});

test('guest pages, public portal, and role workspaces provide English navigation and controls over real HTTP', async context => {
  const f = await fixture(context), guest = f.client('en');
  const failures = [];
  async function check(browser, path) {
    try { englishPage(await browser.go(path), path); }
    catch (error) { failures.push({ path, actual: error.actual, expected: error.expected }); }
  }
  for (const path of ['/', '/login', '/register', '/register/teacher', '/forgot-password', '/reset-password', '/portal', '/about', '/research', '/publications', '/news', '/contact']) {
    await check(guest, path);
  }
  const student = f.client('en'); await student.login(f.student);
  for (const path of ['/student', '/student/weekly', '/student/profile', '/student/calendar', '/student/dynamics', '/student/notices', '/student/topics', '/student/graduation', '/student/internships', '/student/guide', '/student/homepage']) {
    await check(student, path);
  }
  const teacher = f.client('en'); await teacher.login(f.teacher);
  for (const path of ['/teacher', '/teacher/weekly', '/teacher/dynamics', '/teacher/calendar', '/teacher/notices', '/teacher/topics', '/teacher/graduation', '/teacher/internships', '/teacher/results', '/teacher/portal', '/teacher/news/new']) {
    await check(teacher, path);
  }
  const admin = f.client('en'); await admin.login(f.admin);
  for (const path of ['/admin', '/admin/mail']) await check(admin, path);
  assert.deepEqual(failures, []);
});

test('opposite-language browsers can authenticate concurrently without leaking one request’s preference into another', async context => {
  const f = await fixture(context), english = f.client('en'), chinese = f.client('zh-CN');
  await Promise.all([english.login(f.student), chinese.login(f.teacher)]);
  for (let round = 0; round < 4; round++) {
    const [en, zh] = await Promise.all([english.go('/student/profile'), chinese.go('/teacher')]);
    assert.equal(en.response.headers.get('content-language'), 'en');
    assert.match(en.text, /<h1>Personal information<\/h1>/);
    assert.equal(zh.response.headers.get('content-language'), 'zh-CN');
    assert.match(zh.text, /学生管理/);
    assert.match(zh.text, /<html lang="zh-CN">/);
  }
});

test('English registration submits the original Chinese activity values and preserves names, majors and report content', async context => {
  const f = await fixture(context), applicant = f.client('en');
  const registration = await applicant.go('/register');
  assert.match(registration.text, /value="竞赛"[^>]*>[\s\S]*?Competitions<\/label>/);
  assert.match(registration.text, /value="小论文"/);
  const form = application(f.teacher, { name: '登录', major: '个人信息', email: 'second@i18n.example.test' });
  const submitted = await applicant.go('/register', form);
  assert.equal(submitted.response.status, 303);
  const user = f.accounts.listStudents().find(item => item.email === form.email);
  assert.equal(user.name, '登录');
  assert.equal(user.major, '个人信息');
  assert.deepEqual(user.activities, ['竞赛', '小论文']);
  const waiting = await applicant.go('/student');
  assert.match(waiting.text, /Awaiting teacher review/);
  assert.doesNotMatch(waiting.text, /workspace-shell/);
  f.accounts.reviewStudent(f.teacher.id, user.id, 'approved');
  const profile = await applicant.go('/student/profile');
  assert.match(profile.text, /id="student-name">登录<\/h2>/);
  assert.match(profile.text, /<dt>Major<\/dt><dd>个人信息<\/dd>/);
  assert.match(profile.text, /value="竞赛"/);
  const weekly = await applicant.go('/student/weekly');
  const week = weekly.text.match(/name="week" value="([^"]+)"/)[1];
  const report = new FormData();
  const values = { week, revision: '0', action: 'submit', plan: '登录\n个人信息', reading: '论文学习', experiments: '实验进展', difficulties: '遇到的困难与需要的帮助' };
  for (const [key, value] of Object.entries(values)) report.set(key, value);
  assert.equal((await applicant.go('/student/weekly', report)).response.status, 303);
  const saved = JSON.parse(f.db.prepare('SELECT content FROM weekly_versions ORDER BY id DESC LIMIT 1').get().content);
  assert.deepEqual(saved.plan, ['登录', '个人信息']);
  for (const field of ['reading', 'experiments', 'difficulties']) assert.equal(saved[field], values[field]);
  const reread = await applicant.go('/student/weekly?week=' + week);
  assert.match(reread.text, /name="reading"[^>]*>论文学习<\/textarea>/);
  assert.match(reread.text, /name="experiments"[^>]*>实验进展<\/textarea>/);
  assert.match(reread.text, /name="difficulties"[^>]*>遇到的困难与需要的帮助<\/textarea>/);
  const teacher = f.client('en'); await teacher.login(f.teacher);
  const readByTeacher = await teacher.go(`/teacher/weekly/${user.id}?week=${week}`);
  assert.equal(readByTeacher.response.status, 200);
  assert.match(readByTeacher.text, /<li>登录<\/li>/);
  assert.match(readByTeacher.text, /class="article-body">论文学习<\/p>/);
});

test('calendar details and dynamic teacher, student and task-template choices preserve catalog-shaped user text', async context => {
  const f = await fixture(context);
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  f.db.prepare('UPDATE accounts SET name=?,birthday=? WHERE id=?').run('登录', '2000' + today.slice(4), f.student.id);
  const additionalTeacher = await f.accounts.createTeacher({ name: '个人信息', email: 'original-name@i18n.example.test', password });
  const author = f.client('en'); await author.login(f.accounts.getUser(f.student.id));
  assert.equal((await author.go('/student/topics', {
    title: '个人信息', abstract: 'Original topic abstract', stage: '1', deadline: today
  })).response.status, 303);
  const teacher = f.client('en'); await teacher.login(f.teacher);
  assert.equal((await teacher.go('/teacher/graduation/templates', { level: 'graduate', title: '个人信息' })).response.status, 303);
  assert.equal((await teacher.go('/teacher/graduation/assign', {
    student: f.student.id, title: '登录', due: today
  })).response.status, 303);

  const paperCalendar = await teacher.go('/teacher/calendar?view=list&kind=paper');
  assert.equal(paperCalendar.response.status, 200);
  assert.match(paperCalendar.text, /<strong>Research topic deadline<\/strong>/);
  assert.match(paperCalendar.text, new RegExp('<p>' + today + ' · 个人信息<\\/p>'));
  assert.doesNotMatch(paperCalendar.text, /课题目标截稿/);
  const taskCalendar = await teacher.go('/teacher/calendar?view=list&kind=graduation');
  assert.equal(taskCalendar.response.status, 200);
  assert.match(taskCalendar.text, /<strong>登录<\/strong>/);
  assert.match(taskCalendar.text, new RegExp('<p>' + today + ' · 登录<\\/p>'));
  const birthdayCalendar = await teacher.go('/teacher/calendar?view=list&kind=birthday');
  assert.match(birthdayCalendar.text, /<strong>登录&#39;s birthday<\/strong>/);

  const admin = f.client('en'); await admin.login(f.admin);
  const allUsers = await admin.go('/admin');
  const primaryTeacherChoices = [...allUsers.text.matchAll(/<select name="primaryTeacherId">([\s\S]*?)<\/select>/g)];
  assert.ok(primaryTeacherChoices.length > 0);
  for (const [, options] of primaryTeacherChoices) {
    assert.match(options, new RegExp('value="' + additionalTeacher.id + '"[^>]*>个人信息 · original-name@i18n\\.example\\.test<\\/option>'));
  }
  const tasks = await teacher.go('/teacher/graduation');
  const studentChoices = tasks.text.match(/<select name="student">([\s\S]*?)<\/select>/)[1];
  const templateChoices = tasks.text.match(/<select name="template">([\s\S]*?)<\/select>/)[1];
  assert.match(studentChoices, /登录（Graduate student）<\/option>/);
  assert.match(templateChoices, /Graduate student · 个人信息<\/option>/);
});
