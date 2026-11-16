export function openNews(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('lab', 'reading')),
      body TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    ) STRICT
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(news)').all().map(column => column.name));
    if (!columns.has('eventDate')) db.exec("ALTER TABLE news ADD COLUMN eventDate TEXT NOT NULL DEFAULT ''");
    if (!columns.has('sourceUrl')) db.exec("ALTER TABLE news ADD COLUMN sourceUrl TEXT NOT NULL DEFAULT ''");
    if (!columns.has('visibility')) db.exec("ALTER TABLE news ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','draft'))");
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const order = "ORDER BY COALESCE(NULLIF(eventDate,''),date(createdAt,'+8 hours')) DESC, createdAt DESC, id DESC";
  const listQuery = db.prepare('SELECT * FROM news ' + order);
  const publicQuery = db.prepare("SELECT * FROM news WHERE visibility = 'public' " + order);
  const select = db.prepare('SELECT * FROM news WHERE id = ?');
  const insert = db.prepare('INSERT INTO news (title, category, body, createdAt, updatedAt, eventDate, sourceUrl, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE news SET title = ?, category = ?, body = ?, updatedAt = ?, eventDate = ?, sourceUrl = ?, visibility = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM news WHERE id = ?');

  function save(fields, id = null) {
    const title = (fields.title ?? '').trim();
    const category = fields.category;
    const body = fields.body ?? '';
    const eventDate = fields.eventDate ?? '';
    const sourceUrl = (fields.sourceUrl ?? '').trim();
    const visibility = fields.visibility ?? 'public';
    const now = new Date().toISOString();

    if (!title || title.length > 120) throw invalid('请填写新闻标题，最多 120 字。');
    if (!['lab', 'reading'].includes(category)) throw invalid('请选择新闻类别。');
    if (!body.trim() || body.length > 8000) throw invalid('请填写新闻正文，最多 8000 字。');
    if (eventDate) {
      const parsed = new Date(eventDate + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !Number.isFinite(+parsed)
        || parsed.toISOString().slice(0,10) !== eventDate) throw invalid('请选择有效的动态日期。');
    }
    if (sourceUrl) {
      const parsed = URL.parse(sourceUrl);
      if (sourceUrl.length > 500 || !parsed || !['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password) throw invalid('来源链接须是有效的 HTTP 或 HTTPS 地址。');
    }
    if (!['public','draft'].includes(visibility)) throw invalid('请选择发布范围。');

    if (id === null) return Number(insert.run(title, category, body, now, now, eventDate, sourceUrl, visibility).lastInsertRowid);
    if (!update.run(title, category, body, now, eventDate, sourceUrl, visibility, id).changes) throw missing();
    return id;
  }

  return {
    list: () => listQuery.all(),
    publicList: () => publicQuery.all(),
    get: (id) => select.get(id) ?? null,
    save,
    delete(id) {
      if (!remove.run(id).changes) throw missing();
    }
  };
}

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 422 });
}

function missing() {
  return Object.assign(new Error('这条新闻已删除或不存在。'), { statusCode: 404 });
}
