import { randomUUID } from 'node:crypto';
import { normalizeFeedUrl } from './conference-feed.mjs';

const maximum = 20;
const initialSources = [
  ['AI', '人工智能'], ['CG', '图形学与多媒体'], ['HI', '人机交互'], ['MX', '交叉领域']
];

function failure(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function subscriptionName(value) {
  if (typeof value !== 'string') throw failure(400, '请填写订阅名称，最多 60 字。');
  const name = value.trim();
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw failure(400, '请填写订阅名称，最多 60 字，不要包含换行或控制字符。');
  }
  return name;
}

function checkRevision(value, row) {
  if (value === undefined) return;
  const revision = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(revision) || revision < 1) throw failure(400, '订阅版本无效，请刷新页面后重试。');
  if (revision !== row.revision) throw failure(409, '这条订阅已被修改，请刷新页面后再操作。');
}

export function openCalendarSubscriptions({ db }) {
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const tableExists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
  transaction(() => {
    const existed = Boolean(tableExists.get('conference_subscriptions'));
    db.exec(`CREATE TABLE IF NOT EXISTS conference_subscriptions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL CHECK (revision >= 1)
    ) STRICT`);
    // The existing category keys preserve legacy events and sync status. An intentionally empty list stays empty.
    if (!existed) {
      const seed = db.prepare('INSERT INTO conference_subscriptions(id,name,url,revision) VALUES(?,?,?,1)');
      for (const [id, name] of initialSources) {
        seed.run(id, name, `https://ccfddl.com/conference/deadlines/deadlines_zh_${id}.ics`);
      }
    }
  });

  const list = db.prepare('SELECT id,name,url,revision FROM conference_subscriptions ORDER BY rowid');
  const get = db.prepare('SELECT id,name,url,revision FROM conference_subscriptions WHERE id=?');
  const byUrl = db.prepare('SELECT id FROM conference_subscriptions WHERE url=?');
  const count = db.prepare('SELECT count(*) AS total FROM conference_subscriptions');
  const insert = db.prepare('INSERT INTO conference_subscriptions(id,name,url,revision) VALUES(?,?,?,1)');
  const update = db.prepare('UPDATE conference_subscriptions SET name=?,url=?,revision=revision+1 WHERE id=?');
  const remove = db.prepare('DELETE FROM conference_subscriptions WHERE id=?');

  function existing(id) {
    const row = typeof id === 'string' ? get.get(id) : null;
    if (!row) throw failure(404, '这条订阅已删除或不存在。');
    return row;
  }

  function clearCache(id) {
    for (const table of ['conference_deadlines', 'conference_sync']) {
      if (tableExists.get(table)) db.prepare(`DELETE FROM ${table} WHERE category=?`).run(id);
    }
  }

  return {
    list: () => list.all().map(row => ({ ...row })),
    get: id => {
      const row = typeof id === 'string' ? get.get(id) : null;
      return row ? { ...row } : null;
    },
    save(input, id = null) {
      const name = subscriptionName(input?.name);
      const url = normalizeFeedUrl(input?.url);
      return transaction(() => {
        const current = id === null ? null : existing(id);
        if (current) checkRevision(input?.revision, current);
        const duplicate = byUrl.get(url);
        if (duplicate && duplicate.id !== id) throw failure(409, '这个订阅链接已添加，请编辑已有订阅。');
        if (!current) {
          if (count.get().total >= maximum) throw failure(409, '最多可以添加 20 个会议订阅，请先删除不需要的订阅。');
          const createdId = randomUUID();
          insert.run(createdId, name, url);
          return { ...get.get(createdId) };
        }
        if (current.url !== url) clearCache(id);
        update.run(name, url, id);
        return { ...get.get(id) };
      });
    },
    remove(id, revision) {
      return transaction(() => {
        const current = existing(id);
        checkRevision(revision, current);
        clearCache(id);
        remove.run(id);
      });
    }
  };
}
