import { inspectPhoto, photoLimit } from './photo-validation.mjs';
export { photoLimit } from './photo-validation.mjs';

export function openPhotos(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS student_photos (
      studentId INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL
    ) STRICT
  `);
  const photo = db.prepare('SELECT mime, bytes FROM student_photos WHERE studentId = ?');
  const hasPhoto = db.prepare('SELECT 1 FROM student_photos WHERE studentId = ?');
  const list = db.prepare('SELECT studentId FROM student_photos');
  const save = db.prepare(`
    INSERT INTO student_photos VALUES (?, ?, ?)
    ON CONFLICT(studentId) DO UPDATE SET mime=excluded.mime, bytes=excluded.bytes
  `);
  const remove = db.prepare('DELETE FROM student_photos WHERE studentId = ?');

  return {
    get: id => photo.get(id),
    has: id => Boolean(hasPhoto.get(id)),
    owners: () => new Set(list.all().map(row => row.studentId)),
    remove: id => remove.run(id),
    async readUpload(file, httpError) {
      if (!(file instanceof File) || !file.size) throw httpError(422, '请先选择一张生活照。');
      if (file.size > photoLimit) throw httpError(413, '生活照须小于或等于 2 MB。');
      const bytes = Buffer.from(await file.arrayBuffer());
      let image;
      try { image = inspectPhoto(bytes); }
      catch (error) {
        throw httpError(422, error.code === 'PHOTO_DIMENSIONS'
          ? '照片尺寸过大，请压缩后重新上传。'
          : '照片无法读取，请另存为 JPG 或 PNG 后重新上传。');
      }
      return { mime: image.mime, bytes };
    },
    save: (id, { mime, bytes }) => save.run(id, mime, bytes)
  };
}
