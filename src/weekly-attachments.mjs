import { inflateRawSync } from 'node:zlib';

export const attachmentLimit = 5 * 1024 * 1024;
export const maxWeeklyAttachments = 5;

const officeDocumentMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const allowedExtensions = new Map([
  ['pdf', 'application/pdf'], ['doc', 'application/msword'], ['docx', officeDocumentMime],
  ['md', 'text/markdown; charset=utf-8'], ['markdown', 'text/markdown; charset=utf-8'],
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'], ['webp', 'image/webp']
]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function checksum(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  const leaf = value.toWellFormed().split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!leaf || leaf === '.' || leaf === '..') return '';
  if (Array.from(leaf).length <= 180) return leaf;
  const extension = leaf.match(/\.[^.]+$/)?.[0] ?? '';
  if (Array.from(extension).length >= 180) return '';
  const stem = extension ? leaf.slice(0, -extension.length) : leaf;
  return Array.from(stem).slice(0, 180 - Array.from(extension).length).join('') + extension;
}

// Inspect the OLE directory rather than accepting every compound file as a Word document.
function isLegacyWord(bytes) {
  if (bytes.length < 1536 || bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') return false;
  const version = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30);
  if (bytes.readUInt16LE(28) !== 0xfffe || !((version === 3 && shift === 9) || (version === 4 && shift === 12))) return false;
  const sectorSize = 2 ** shift, sectorCount = Math.floor(bytes.length / sectorSize) - 1;
  const fatCount = bytes.readUInt32LE(44), firstDirectory = bytes.readUInt32LE(48);
  if (sectorCount < 2 || fatCount < 1 || fatCount > sectorCount || firstDirectory >= sectorCount) return false;
  const sector = id => id < sectorCount ? bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize) : null;
  const fatSectors = [];
  for (let index = 0; index < 109; index++) {
    const id = bytes.readUInt32LE(76 + index * 4);
    if (id !== 0xffffffff) fatSectors.push(id);
  }
  let difatId = bytes.readUInt32LE(68);
  const difatCount = bytes.readUInt32LE(72), seenDifat = new Set();
  if (difatCount > sectorCount) return false;
  for (let index = 0; index < difatCount; index++) {
    if (seenDifat.has(difatId)) return false;
    seenDifat.add(difatId);
    const block = sector(difatId);
    if (!block) return false;
    for (let offset = 0; offset < sectorSize - 4; offset += 4) {
      const id = block.readUInt32LE(offset);
      if (id !== 0xffffffff) fatSectors.push(id);
    }
    difatId = block.readUInt32LE(sectorSize - 4);
  }
  if (fatSectors.length !== fatCount || new Set(fatSectors).size !== fatCount || fatSectors.some(id => !sector(id))) return false;
  const nextSector = id => {
    const entry = id * 4, fat = sector(fatSectors[Math.floor(entry / sectorSize)]);
    return fat ? fat.readUInt32LE(entry % sectorSize) : 0xffffffff;
  };
  let directoryId = firstDirectory, foundWord = false;
  const seenDirectory = new Set();
  while (directoryId !== 0xfffffffe) {
    if (seenDirectory.has(directoryId) || seenDirectory.size >= sectorCount) return false;
    seenDirectory.add(directoryId);
    const directory = sector(directoryId);
    if (!directory) return false;
    for (let offset = 0; offset < sectorSize; offset += 128) {
      const type = directory[offset + 66];
      if (!type) continue;
      const length = directory.readUInt16LE(offset + 64);
      if (length < 2 || length > 64 || length % 2) return false;
      const name = directory.subarray(offset, offset + length - 2).toString('utf16le');
      if (/vba|macro|\.(?:exe|dll|com|scr|bat|cmd|js|vbs|ps1)$/i.test(name)) return false;
      if (type === 2 && name === 'WordDocument') foundWord = true;
    }
    directoryId = nextSector(directoryId);
  }
  return foundWord;
}

// DOCX is a ZIP package. Bound both the directory and the XML we decompress.
function isDocx(bytes) {
  try {
    if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
      if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
        end = offset;
        break;
      }
    }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return false;
    const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
    if (!count || count > 2048 || bytes.readUInt16LE(end + 8) !== count || centralStart + centralSize !== end) return false;
    const entries = new Map(), ranges = [];
    let offset = centralStart, expandedSize = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
      const crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24);
      const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
      const localOffset = bytes.readUInt32LE(offset + 42), next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > end || !nameLength || bytes.readUInt16LE(offset + 34) || flags & 0x2041 || ![0, 8].includes(method)) return false;
      if (compressed === 0xffffffff || expanded > 32 * 1024 * 1024 || (expandedSize += expanded) > 64 * 1024 * 1024) return false;
      const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength), name = rawName.toString('utf8');
      if (/[\u0000-\u001f\u007f\\\ufffd]/.test(name) || name.startsWith('/') || name.includes(':') || name.split('/').some(part => part === '..' || part === '.')) return false;
      const key = name.toLowerCase();
      if (entries.has(key) || /(?:^|\/)(?:vbaproject\.bin|activex|embeddings)(?:\/|$)/.test(key)
        || /\.(?:exe|dll|com|scr|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|msi|msp|hta|jar)$/.test(key)) return false;
      if (localOffset + 30 > centralStart || bytes.readUInt32LE(localOffset) !== 0x04034b50) return false;
      const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed;
      if (dataEnd > centralStart || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method
        || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(rawName)) return false;
      ranges.push([localOffset, dataEnd]);
      entries.set(key, { name, method, crc, expanded, bytes: bytes.subarray(dataStart, dataEnd) });
      offset = next;
    }
    if (offset !== end) return false;
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, index) => index && range[0] < ranges[index - 1][1])) return false;
    function xml(name) {
      const entry = entries.get(name.toLowerCase());
      if (!entry || entry.name !== name || entry.expanded > 8 * 1024 * 1024) return '';
      const content = entry.method === 0 ? entry.bytes : inflateRawSync(entry.bytes, { maxOutputLength: 8 * 1024 * 1024 });
      if (content.length !== entry.expanded || checksum(content) !== entry.crc) return '';
      const text = content.toString('utf8');
      return /<!DOCTYPE|<!ENTITY/i.test(text) ? '' : text;
    }
    const typeXml = xml('[Content_Types].xml'), document = xml('word/document.xml');
    return !/<!DOCTYPE|<!ENTITY|macroEnabled|vbaProject|activeX|oleObject/i.test(typeXml)
      && typeXml.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
      && /<(?:[\w.-]+:)?Types(?:\s|>)/.test(typeXml)
      && /<(?:[\w.-]+:)?document(?:\s|>)/.test(document);
  } catch {
    return false;
  }
}

function matchesType(extension, bytes) {
  if (extension === 'md' || extension === 'markdown') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text);
    } catch {
      return false;
    }
  }
  if (extension === 'pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (extension === 'doc') return isLegacyWord(bytes);
  if (extension === 'docx') return isDocx(bytes);
  if (extension === 'png') return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (extension === 'jpg' || extension === 'jpeg') return bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (extension === 'gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  return extension === 'webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function metadata(row) {
  return row ? { id: row.id, name: row.name, mime: row.mime, size: row.size, createdAt: row.created_at } : undefined;
}

export function openWeeklyAttachments({ db, accounts, httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode }) }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      week TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0 AND size <= ${attachmentLimit} AND length(bytes) = size),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS weekly_attachments_owner_week ON weekly_attachments (student_id, week, id);
  `);
  const find = db.prepare('SELECT * FROM weekly_attachments WHERE id = ?');
  const findMetadata = db.prepare('SELECT id, name, mime, size, created_at FROM weekly_attachments WHERE id = ?');
  const findOwned = db.prepare('SELECT id, name, mime, size, created_at FROM weekly_attachments WHERE id = ? AND student_id = ? AND week = ?');
  const findList = db.prepare('SELECT id, name, mime, size, created_at FROM weekly_attachments WHERE student_id = ? AND week = ? ORDER BY id');
  const insert = db.prepare('INSERT INTO weekly_attachments (student_id, week, name, mime, bytes, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  function positiveId(value) {
    return (typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  }
  function owner(studentId) {
    const id = positiveId(studentId);
    if (!id || accounts.getUser(id)?.role !== 'student') throw httpError(404, '未找到学生账号。');
    return id;
  }
  function validWeek(week) {
    if (typeof week !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw httpError(422, '请选择有效的周次。');
    const date = new Date(week + 'T00:00:00Z');
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== week || date.getUTCDay() !== 1) throw httpError(422, '请选择周一作为周次。');
    return week;
  }
  function normalize(upload) {
    const name = cleanName(upload?.name), extension = name.split('.').at(-1).toLowerCase();
    if (!name || !allowedExtensions.has(extension)) throw httpError(422, '附件支持 PDF、Word、Markdown（MD、MARKDOWN）及 JPG、PNG、GIF、WebP 图片。');
    const bytes = Buffer.isBuffer(upload?.bytes) ? upload.bytes : upload?.bytes instanceof Uint8Array ? Buffer.from(upload.bytes) : null;
    if (!bytes?.length) throw httpError(422, '附件不能为空，请重新选择文件。');
    if (bytes.length > attachmentLimit) throw httpError(413, '每个附件不能超过 5 MB。');
    if (!matchesType(extension, bytes)) throw httpError(422, extension === 'md' || extension === 'markdown'
      ? 'Markdown 附件须为 UTF-8 文本，请检查编码后重新上传。'
      : '附件内容与格式不符，或包含不支持的宏、嵌入对象。请重新导出为 PDF、Word 或图片。');
    return { name, mime: allowedExtensions.get(extension), bytes, size: bytes.length };
  }
  function checkCount(values) {
    if (!Array.isArray(values) || values.length > maxWeeklyAttachments) throw httpError(422, '每份周报最多添加 5 个附件。');
  }

  return {
    async readUploads(files = []) {
      const uploads = Array.from(files).filter(file => !(file instanceof File && file.name === '' && file.size === 0));
      checkCount(uploads);
      for (const file of uploads) {
        if (!(file instanceof File)) throw httpError(422, '请选择有效的附件。');
        if (file.size > attachmentLimit) throw httpError(413, '每个附件不能超过 5 MB。');
      }
      return Promise.all(uploads.map(async file => normalize({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })));
    },
    saveMany(studentId, week, uploads) {
      const id = owner(studentId), weekKey = validWeek(week);
      checkCount(uploads);
      const normalized = uploads.map(normalize), createdAt = new Date().toISOString();
      return normalized.map(upload => {
        const result = insert.run(id, weekKey, upload.name, upload.mime, upload.bytes, upload.size, createdAt);
        return { id: Number(result.lastInsertRowid), name: upload.name, mime: upload.mime, size: upload.size, createdAt };
      });
    },
    metadataForIds(studentId, week, ids = []) {
      const id = owner(studentId), weekKey = validWeek(week);
      checkCount(ids);
      const parsed = ids.map(positiveId);
      if (parsed.some(value => !value) || new Set(parsed).size !== parsed.length) throw httpError(422, '附件选择无效，请刷新后重试。');
      return parsed.map(attachmentId => {
        const row = findOwned.get(attachmentId, id, weekKey);
        if (!row) throw httpError(404, '未找到附件。');
        return metadata(row);
      });
    },
    list(studentId, week) {
      return findList.all(owner(studentId), validWeek(week)).map(metadata);
    },
    getMetadata(id) {
      const value = positiveId(id);
      return value ? metadata(findMetadata.get(value)) : undefined;
    },
    download({ response, state, id, inline = false }) {
      const value = positiveId(id), viewer = state?.user && accounts.getUser(state.user.id);
      if (!value || !viewer || viewer.disabled || !['admin', 'teacher', 'student'].includes(viewer.role)) throw httpError(404, '未找到附件。');
      if (viewer.role === 'student' && (viewer.reviewStatus !== 'approved' || viewer.studentStatus === 'graduated')) throw httpError(404, '未找到附件。');
      const row = find.get(value);
      if (!row || (viewer.role === 'student' && viewer.id !== row.student_id)) throw httpError(404, '未找到附件。');
      if (viewer.role !== 'student') accounts.assertManageStudent(viewer, row.student_id);
      if (inline && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(row.mime)) throw httpError(404, '未找到插图。');
      const encodedName = encodeURIComponent(row.name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
      const fallbackName = row.name.replace(/[^A-Za-z0-9._-]/g, '_');
      response.writeHead(200, {
        'Content-Type': row.mime,
        'Content-Length': row.size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "sandbox; default-src 'none'"
      });
      response.end(row.bytes);
    }
  };
}
