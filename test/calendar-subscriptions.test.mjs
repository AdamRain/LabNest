import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openCalendarSubscriptions } from '../src/calendar-subscriptions.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE conference_deadlines(category TEXT,uid TEXT,title TEXT);
    CREATE TABLE conference_sync(category TEXT PRIMARY KEY, checkedAt TEXT,successfulAt TEXT,error TEXT);`);
  for (const category of ['AI', 'CG', 'HI', 'MX']) {
    db.prepare('INSERT INTO conference_deadlines VALUES(?,?,?)').run(category, 'legacy-' + category, '原有会议');
    db.prepare('INSERT INTO conference_sync VALUES(?,?,?,?)').run(category, 'checked', 'successful', '');
  }
  const sources = openCalendarSubscriptions({ db });
  const cached = id => db.prepare('SELECT count(*) AS total FROM conference_deadlines WHERE category=?').get(id).total;
  const status = id => db.prepare('SELECT * FROM conference_sync WHERE category=?').get(id);
  return { db, sources, cached, status };
}

test('首次初始化沿用原4类会议ID和缓存，重新打开不覆盖订阅修改', t => {
  const { db, sources, cached, status } = fixture(t);
  assert.deepEqual(sources.list().map(row => row.id), ['AI', 'CG', 'HI', 'MX']);
  assert.equal(sources.get('AI').name, '人工智能');
  for (const id of ['AI', 'CG', 'HI', 'MX']) { assert.equal(cached(id), 1); assert.equal(status(id).successfulAt, 'successful'); }
  const edited = sources.save({ ...sources.get('AI'), name: '人工智能与机器学习' }, 'AI');
  assert.equal(edited.revision, 2);
  assert.equal(openCalendarSubscriptions({ db }).get('AI').name, '人工智能与机器学习');
  assert.equal(cached('AI'), 1);
  assert.equal(status('AI').successfulAt, 'successful');
});

test('新增持久化唯一订阅；webcal规范化，名称作为纯文本保留', t => {
  const { db, sources } = fixture(t);
  const row = sources.save({ name: '  <研究订阅>  ', url: 'webcal://ccfddl.com/custom/conferences.ics' });
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  assert.equal(row.name, '<研究订阅>');
  assert.equal(row.url, 'https://ccfddl.com/custom/conferences.ics');
  assert.equal(row.revision, 1);
  assert.deepEqual(openCalendarSubscriptions({ db }).get(row.id), row);
  assert.throws(() => sources.save({ name: '重复链接', url: row.url }), { statusCode: 409 });
  assert.throws(() => sources.save({ name: '重复链接', url: row.url }, 'AI'), { statusCode: 409 });
  assert.equal(sources.list().length, 5);
  assert.equal(sources.get('AI').revision, 1);
});

test('改名字保留缓存，改链接立即清旧事件和状态，旧版本不能覆盖或删除', t => {
  const { sources, cached, status } = fixture(t);
  const original = sources.get('AI');
  const renamed = sources.save({ ...original, name: '新名称', revision: String(original.revision) }, original.id);
  assert.equal(cached('AI'), 1); assert.ok(status('AI'));
  const changed = sources.save({ ...renamed, url: 'https://ccfddl.com/custom/ai.ics' }, renamed.id);
  assert.equal(changed.revision, 3); assert.equal(cached('AI'), 0); assert.equal(status('AI'), undefined);
  assert.equal(cached('CG'), 1); assert.ok(status('CG'));
  assert.throws(() => sources.save({ ...original, name: '过期编辑' }, original.id), { statusCode: 409 });
  assert.throws(() => sources.remove(original.id, original.revision), { statusCode: 409 });
  assert.deepEqual(sources.get('AI'), changed);
  for (const revision of ['', '1x', 0, -1, NaN, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => sources.save({ ...changed, revision }, 'AI'), { statusCode: 400 });
  }
});

test('删除清理关联事件和状态，删空后重新打开仍不恢复默认项', t => {
  const { db, sources, cached, status } = fixture(t);
  sources.remove('AI', '1');
  assert.equal(sources.get('AI'), null); assert.equal(cached('AI'), 0); assert.equal(status('AI'), undefined);
  assert.equal(cached('CG'), 1);
  assert.throws(() => sources.remove('AI'), { statusCode: 404 });
  for (const row of sources.list()) sources.remove(row.id, row.revision);
  assert.deepEqual(openCalendarSubscriptions({ db }).list(), []);
  assert.equal(db.prepare('SELECT count(*) AS total FROM conference_deadlines').get().total, 0);
  assert.equal(db.prepare('SELECT count(*) AS total FROM conference_sync').get().total, 0);
});

test('拒绝无效名称和链接，数量达20后仅阻止新增，失败不改变缓存或记录', t => {
  const { sources, cached } = fixture(t);
  const current = sources.get('AI');
  for (const name of ['', '   ', '字'.repeat(61), '换\n行', 42]) {
    assert.throws(() => sources.save({ name, url: 'https://ccfddl.com/custom.ics' }, 'AI'), { statusCode: 400 });
  }
  for (const url of ['http://ccfddl.com/file.ics', 'https://127.0.0.1/file.ics', 'https://user:password@ccfddl.com/file.ics', 'https://ccfddl.com/file.ics#fragment']) {
    assert.throws(() => sources.save({ name: '无效链接', url }, 'AI'));
  }
  assert.deepEqual(sources.get('AI'), current); assert.equal(cached('AI'), 1);
  for (let index = 0; index < 16; index++) sources.save({ name: `订阅 ${index}`, url: `https://ccfddl.com/custom/${index}.ics` });
  assert.equal(sources.list().length, 20);
  assert.throws(() => sources.save({ name: '超过上限', url: 'https://ccfddl.com/custom/last.ics' }), { statusCode: 409 });
  assert.equal(sources.save({ ...current, name: '容量满时仍能改名' }, 'AI').name, '容量满时仍能改名');
  sources.remove('AI');
  assert.equal(sources.save({ name: '删除后可新增', url: 'https://ccfddl.com/custom/last.ics' }).revision, 1);
  assert.throws(() => sources.save({ name: '缺失记录', url: 'https://ccfddl.com/custom/missing.ics' }, 'missing'), { statusCode: 404 });
});

test('清理缓存中途失败时，订阅编辑和删除全部回滚，不留下部分状态', t => {
  const { db, sources, cached, status } = fixture(t);
  const original = sources.get('AI');
  db.exec(`CREATE TRIGGER reject_sync_cleanup BEFORE DELETE ON conference_sync
    BEGIN SELECT RAISE(ABORT, 'isolated cleanup failure'); END;`);
  assert.throws(() => sources.save({ ...original, url: 'https://ccfddl.com/custom/changed.ics' }, 'AI'));
  assert.deepEqual(sources.get('AI'), original); assert.equal(cached('AI'), 1); assert.ok(status('AI'));
  assert.throws(() => sources.remove('AI', original.revision));
  assert.deepEqual(sources.get('AI'), original); assert.equal(cached('AI'), 1); assert.ok(status('AI'));
  db.exec('DROP TRIGGER reject_sync_cleanup');
  sources.remove('AI', original.revision);
  assert.equal(sources.get('AI'), null); assert.equal(cached('AI'), 0); assert.equal(status('AI'), undefined);
});
