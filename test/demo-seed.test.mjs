import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAccounts } from '../src/accounts.mjs';
import { seedDemo, demoPassword, demoDates, demoCalendar, demoResumeTimeline } from '../scripts/seed-demo.mjs';
import { demoOptions } from '../scripts/demo.mjs';
import { parseCalendar } from '../src/calendar.mjs';
import { openWeekly } from '../src/weekly.mjs';

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'labmanager-public-demo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('演示原始生成11个虚构账号及完整关联；重复生成保留使用者编辑', async t => {
  const root = temporary(t), now = Date.parse('2026-11-18T08:00:00Z');
  const seeded = await seedDemo({ root, now });
  assert.equal(seeded.created, true);
  assert.equal(seeded.week, '2026-11-16');
  const db = new DatabaseSync(seeded.path), accounts = openAccounts(db);
  assert.equal(db.prepare('SELECT count(*) n FROM accounts').get().n, 11);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const student = await accounts.authenticate('student@demo.example.test', demoPassword);
  const teacher = await accounts.authenticate('teacher@demo.example.test', demoPassword);
  const secondary = await accounts.authenticate('mentor@demo.example.test', demoPassword);
  assert.equal(student.role, 'student'); assert.equal(teacher.role, 'teacher');
  assert.equal(accounts.canManageStudent(teacher, student.id), true);
  assert.equal(accounts.canManageStudent(secondary, student.id), true);
  assert.equal(accounts.getUser(seeded.ids.pending).reviewStatus, 'pending');
  assert.equal(accounts.getUser(seeded.ids.alumni).studentStatus, 'graduated');
  assert.equal(accounts.getUser(seeded.ids.admitted).studentStatus, 'admitted');
  assert.ok(accounts.getUser(seeded.ids.chen).activities.includes('毕业设计'));
  const weekly = openWeekly({ db, accounts, now: () => now, ui: {
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    escapeHtml: value => String(value), token: () => '', layout: (_state, _title, body) => body,
    html() {}, redirect() {}
  } });
  for (const week of [demoDates(now).earlier, demoDates(now).prior, seeded.week]) {
    const overview = weekly.overview(student.id, week);
    assert.equal(overview.obligation, 'required', '已批准演示学生在历史周应交周报：' + week);
    assert.equal(overview.submission, 'submitted');
    assert.equal(overview.report.versions.length, 2);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM weekly_attachments').get().n, 2);
  assert.ok(db.prepare('SELECT count(*) n FROM weekly_versions').get().n > 15);
  assert.ok(db.prepare('SELECT count(*) n FROM weekly_publication_comments WHERE parent_id IS NOT NULL').get().n > 0);
  assert.ok(db.prepare('SELECT count(*) n FROM student_sites WHERE published IS NOT NULL').get().n > 0);
  const site = db.prepare('SELECT draft,published FROM student_sites WHERE student_id=?').get(student.id);
  const introduction = JSON.parse(site.draft), published = JSON.parse(site.published);
  assert.match(introduction.education, /^2024—至今/);
  assert.match(introduction.awards, /^2025 年/);
  assert.equal(published.education, introduction.education);
  assert.equal(published.awards, introduction.awards);
  assert.doesNotMatch(introduction.education + introduction.awards, /2099/);
  assert.ok(db.prepare("SELECT count(*) n FROM conference_deadlines WHERE title LIKE '%演示%'").get().n >= 5);
  assert.equal(db.prepare('SELECT count(*) n FROM account_sessions').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM password_reset_tokens').get().n, 0);
  const secretHash = db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(student.id).password_hash;
  assert.notEqual(secretHash, demoPassword);
  db.prepare('UPDATE portal_profile SET content=? WHERE id=1').run(JSON.stringify({ name: '使用者试改的标题' }));
  db.close();
  const before = readFileSync(seeded.path);
  const again = await seedDemo({ root, now: now + 30 * 86_400_000 });
  assert.equal(again.created, false); assert.equal(again.week, seeded.week);
  assert.deepEqual(readFileSync(seeded.path), before);
});

test('演示库保护拒绝覆盖同名未知数据，输出路径不能由调用参数指定', async t => {
  const root = temporary(t), directory = join(root, 'data'); mkdirSync(directory);
  const target = join(directory, 'demo.sqlite');
  const db = new DatabaseSync(target); db.exec('CREATE TABLE valuable_notes(body TEXT); INSERT INTO valuable_notes VALUES (\'原有内容\')'); db.close();
  const before = readFileSync(target);
  await assert.rejects(seedDemo({ root }), /不是本工具创建的演示库/);
  assert.deepEqual(readFileSync(target), before);
});

test('演示启动不接受生产库、环境文件、公网绑定或生产模式，只允许显式本机端口', () => {
  assert.deepEqual(demoOptions([], {}), { host: '127.0.0.1', port: 4180 });
  assert.deepEqual(demoOptions(['--port', '4181'], {}), { host: '127.0.0.1', port: 4181 });
  for (const env of [{ LAB_DB_PATH: 'data/lab.sqlite' }, { LAB_ENV_FILE: '.env' }, { LAB_HOST: '0.0.0.0' }, { NODE_ENV: 'production' }]) {
    assert.throws(() => demoOptions([], env));
  }
  for (const args of [['--host', '0.0.0.0'], ['--port', '80'], ['--port', '65536'], ['data/lab.sqlite'], ['--port', '4180;bad']]) assert.throws(() => demoOptions(args, {}));
});

test('演示会议缓存可离线解析，名称明确虚构，日期相对生成时间', () => {
  const now = Date.parse('2026-11-18T08:00:00Z'), events = parseCalendar(demoCalendar(now));
  assert.equal(events.length, 5);
  assert.ok(events.every(event => event.title.includes('演示')));
  assert.ok(events.every(event => event.localDate > '2026-11-18'));
  assert.equal(demoDates(now).prior, '2026-11-09');
  const nextYear = demoResumeTimeline({ level: 'graduate', studentStatus: 'active' }, Date.parse('2026-12-31T17:00:00Z'));
  assert.match(nextYear.education, /^2025—至今/, '按北京时间跨年生成教育经历');
  assert.match(nextYear.awards, /^2026 年/);
});
