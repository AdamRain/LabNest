import { inspectPhoto, photoLimit } from './photo-validation.mjs';

export const logoLimit = photoLimit;

export function openSiteBranding({ db, accounts, httpError }) {
  db.exec(`CREATE TABLE IF NOT EXISTS site_logo (
    id INTEGER PRIMARY KEY CHECK (id=1),
    mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg')),
    bytes BLOB NOT NULL,
    updated_by INTEGER NOT NULL REFERENCES accounts(id),
    updated_at TEXT NOT NULL
  ) STRICT;`);
  const read = db.prepare('SELECT mime,bytes,updated_at AS updatedAt FROM site_logo WHERE id=1');
  const write = db.prepare(`INSERT INTO site_logo(id,mime,bytes,updated_by,updated_at) VALUES(1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET mime=excluded.mime,bytes=excluded.bytes,
      updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
  const remove = db.prepare('DELETE FROM site_logo WHERE id=1');

  function editor(actor) {
    const user = actor && accounts.getUser(actor.id);
    if (!user || user.disabled || user.reviewStatus !== 'approved' || !['teacher', 'admin'].includes(user.role)) {
      throw httpError(403, '审核通过的教师或管理员才可修改系统 Logo。');
    }
    return user;
  }

  return {
    current: () => read.get() ?? null,
    async upload(actor, file) {
      editor(actor);
      if (!(file instanceof File) || !file.size) throw httpError(422, '请先选择一张 Logo 图片。');
      if (file.size > logoLimit) throw httpError(413, 'Logo 图片不能超过 2 MB。');
      let image;
      try { image = inspectPhoto(Buffer.from(await file.arrayBuffer())); }
      catch (error) {
        throw httpError(422, error.code === 'PHOTO_DIMENSIONS'
          ? 'Logo 尺寸过大，请压缩后重新上传。'
          : 'Logo 图片无法读取，请另存为 PNG 或 JPG 后上传。');
      }
      // Recheck after reading the upload, in case the account was disabled meanwhile.
      const user = editor(actor);
      write.run(image.mime, image.data, user.id, new Date().toISOString());
    },
    restore(actor) { editor(actor); remove.run(); }
  };
}
