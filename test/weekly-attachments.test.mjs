import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync, crc32 } from 'node:zlib';
import { openAccounts } from '../src/accounts.mjs';
import { attachmentLimit, maxWeeklyAttachments, openWeeklyAttachments } from '../src/weekly-attachments.mjs';

const week = '2026-11-09';
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const contentTypes = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const documentXml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>周报附件</w:t></w:r></w:p></w:body></w:document>';

function zip(entries) {
  const localParts = [], centralParts = [];
  let localOffset = 0;
  for (const [name, value, options = {}] of entries) {
    const nameBytes = Buffer.from(name), bytes = Buffer.from(value);
    const method = options.method ?? 8, compressed = method === 0 ? bytes : deflateRawSync(bytes), crc = crc32(bytes);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.flags ?? 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(options.flags ?? 0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(options.expandedSize ?? bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, nameBytes, compressed);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const central = Buffer.concat(centralParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function docx(extra = [], types = contentTypes, body = documentXml) {
  return zip([['[Content_Types].xml', types], ['word/document.xml', body], ...extra]);
}

function legacyWord({ macro = false, word = true } = {}) {
  const bytes = Buffer.alloc(11 * 512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
  bytes.writeUInt16LE(0x3e, 24);
  bytes.writeUInt16LE(3, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(9, 30);
  bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(1, 44);
  bytes.writeUInt32LE(1, 48);
  bytes.writeUInt32LE(4096, 56);
  bytes.writeUInt32LE(0xfffffffe, 60);
  bytes.writeUInt32LE(0xfffffffe, 68);
  bytes.fill(0xff, 76, 512);
  bytes.writeUInt32LE(0, 76);
  bytes.fill(0xff, 512, 1024);
  bytes.writeUInt32LE(0xfffffffd, 512);
  bytes.writeUInt32LE(0xfffffffe, 516);
  for (let id = 2; id <= 9; id++) bytes.writeUInt32LE(id === 9 ? 0xfffffffe : id + 1, 512 + id * 4);
  function entry(index, name, type, start, size = 0) {
    const offset = 1024 + index * 128, encoded = Buffer.from(name + '\0', 'utf16le');
    encoded.copy(bytes, offset);
    bytes.writeUInt16LE(encoded.length, offset + 64);
    bytes[offset + 66] = type;
    bytes.writeUInt32LE(start, offset + 116);
    bytes.writeBigUInt64LE(BigInt(size), offset + 120);
  }
  entry(0, 'Root Entry', 5, 0xfffffffe);
  entry(1, word ? 'WordDocument' : 'Workbook', 2, 2, 4096);
  if (macro) entry(2, 'VBA', 1, 0xfffffffe);
  bytes.writeUInt16LE(0xa5ec, 1536);
  return bytes;
}

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const accounts = openAccounts(db), password = 'Attachment-test-only-91';
  const teacher = await accounts.createTeacher({ name: '教师', email: 'teacher@attachments.example', password });
  async function student(name, email) {
    const user = await accounts.register({ name, email, password, level: 'graduate', studentStatus: 'active',
      studentNumber: '20260001', major: '计算机', relationship: 'direct' });
    accounts.reviewStudent(teacher.id, user.id, 'approved');
    return accounts.getUser(user.id);
  }
  const author = await student('作者', 'author@attachments.example'), peer = await student('同学', 'peer@attachments.example');
  const attachments = openWeeklyAttachments({ db, accounts });
  t.after(() => db.close());
  return { db, accounts, attachments, author, peer, teacher };
}

const failsWith = status => error => error.statusCode === status;
const file = (name, bytes, type = '') => new File([bytes], name, { type });

test('附件接受 PDF、无宏 Word、Markdown 和四类图片，根据内容确定类型', async t => {
  const { attachments, author } = await fixture(t);
  const examples = [
    ['实验.PDF', pdf, 'application/pdf'],
    ['周报.doc', legacyWord(), 'application/msword'],
    ['周报.docx', docx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['周报.MD', Buffer.from('# 本周工作\r\n\n- 完成实验\n'), 'text/markdown; charset=utf-8'],
    ['记录.markdown', Buffer.from('\ufeff# 实验记录\n\t中文、English、公式 $x^2$\n'), 'text/markdown; charset=utf-8'],
    ['图.png', Buffer.from('89504e470d0a1a0a00000000', 'hex'), 'image/png'],
    ['图.jpg', Buffer.from('ffd8ffe00010ffd9', 'hex'), 'image/jpeg'],
    ['图.jpeg', Buffer.from('ffd8ffe10010ffd9', 'hex'), 'image/jpeg'],
    ['图.gif', Buffer.from('GIF89a\x01\0\x01\0'), 'image/gif'],
    ['图.webp', Buffer.from('RIFF\x04\0\0\0WEBP'), 'image/webp']
  ];
  for (const [name, bytes, mime] of examples) {
    const [upload] = await attachments.readUploads([file(name, bytes, 'application/octet-stream')]);
    assert.equal(upload.mime, mime);
    assert.equal(upload.size, bytes.length);
    const [saved] = attachments.saveMany(author.id, week, [upload]);
    assert.equal(saved.mime, mime);
    assert.equal(saved.name, name);
  }
  assert.equal(attachments.list(author.id, week).length, examples.length);
});

test('Markdown 仅接受 UTF-8 文本，拒绝二进制和无效编码，直接保存也使用相同校验', async t => {
  const { attachments, author, db } = await fixture(t);
  const invalid = [
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('周报', 'utf16le'),
    Buffer.from('# 标题\n\0binary'),
    Buffer.from('# 标题\n\x01binary'),
    Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    docx()
  ];
  for (const bytes of invalid) {
    await assert.rejects(attachments.readUploads([file('伪装.md', bytes, 'text/markdown')]), failsWith(422));
    assert.throws(() => attachments.saveMany(author.id, week, [{ name: '伪装.markdown', bytes }]), failsWith(422));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM weekly_attachments').get().n, 0);
});

test('5 MB 边界、每次最多五个附件、空附件和无文件选择均有明确处理', async t => {
  const { attachments, author } = await fixture(t);
  assert.equal(attachmentLimit, 5 * 1024 * 1024);
  assert.equal(maxWeeklyAttachments, 5);
  const maximum = Buffer.alloc(attachmentLimit, 32);
  pdf.copy(maximum);
  const uploads = await attachments.readUploads([file('边界.pdf', maximum)]);
  const [saved] = attachments.saveMany(author.id, week, uploads);
  assert.equal(saved.size, attachmentLimit);
  const stored = attachments.getMetadata(saved.id);
  assert.equal(stored.size, attachmentLimit);
  const markdownMaximum = Buffer.alloc(attachmentLimit, 0x61);
  const [markdownUpload] = await attachments.readUploads([file('边界.md', markdownMaximum)]);
  assert.equal(markdownUpload.size, attachmentLimit);
  await assert.rejects(attachments.readUploads([file('超限.markdown', Buffer.concat([markdownMaximum, Buffer.from('x')]))]), failsWith(413));
  await assert.rejects(attachments.readUploads([file('超限.pdf', Buffer.concat([maximum, Buffer.from('x')]))]), failsWith(413));
  assert.throws(() => attachments.saveMany(author.id, week, [{ name: '超限.pdf', bytes: Buffer.concat([maximum, Buffer.from('x')]) }]), failsWith(413));
  await assert.rejects(attachments.readUploads(Array.from({ length: 6 }, () => file('附件.pdf', pdf))), failsWith(422));
  assert.throws(() => attachments.metadataForIds(author.id, week, [1, 2, 3, 4, 5, 6]), failsWith(422));
  assert.deepEqual(await attachments.readUploads([file('', Buffer.alloc(0))]), []);
  assert.deepEqual(await attachments.readUploads([]), []);
  await assert.rejects(attachments.readUploads([file('空.pdf', Buffer.alloc(0))]), failsWith(422));
  await assert.rejects(attachments.readUploads(['不是文件']), failsWith(422));
});

test('禁止扩展名伪装、SVG、其他 OLE 文件以及宏文件', async t => {
  const { attachments, author, db } = await fixture(t);
  const rejected = [
    ['伪装.pdf', '<html><script>alert(1)</script></html>'],
    ['伪装.png', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['实际是PDF.jpg', pdf],
    ['脚本.svg', '<svg/>'],
    ['程序.exe', Buffer.from('MZ\0\0')],
    ['旧格式.xls.doc', legacyWord({ word: false })],
    ['宏.doc', legacyWord({ macro: true })],
    ['签名.doc', Buffer.from('d0cf11e0a1b11ae1', 'hex')],
    ['宏.docm', docx()],
    ['宏.docx', docx([['word/vbaProject.bin', 'macro']])],
    ['控件.docx', docx([['word/activeX/activeX1.bin', 'control']])],
    ['嵌入程序.docx', docx([['word/embeddings/oleObject1.bin', 'MZ']])],
    ['程序.docx', docx([['custom/run.exe', 'MZ']])],
    ['宏类型.docx', docx([], contentTypes.replace('wordprocessingml.document.main+xml', 'ms-word.document.macroEnabled.main+xml'))]
  ];
  for (const [name, bytes] of rejected) await assert.rejects(attachments.readUploads([file(name, bytes)]), failsWith(422), name);
  assert.throws(() => attachments.saveMany(author.id, week, [
    { name: '有效.pdf', bytes: pdf }, { name: '伪装.pdf', bytes: Buffer.from('<html/>') }
  ]), failsWith(422));
  assert.equal(db.prepare('SELECT count(*) AS n FROM weekly_attachments').get().n, 0, '整批验证完成后才保存，不留下半批附件');
});

test('DOCX 验证完整 ZIP 目录、必要文件、XML 与解压上限', async t => {
  const { attachments } = await fixture(t);
  const encrypted = zip([['[Content_Types].xml', contentTypes, { flags: 0x801 }], ['word/document.xml', documentXml]]);
  const oversized = zip([['[Content_Types].xml', contentTypes], ['word/document.xml', documentXml, { expandedSize: 33 * 1024 * 1024 }]]);
  const invalidCrc = Buffer.from(docx());
  const centralOffset = invalidCrc.indexOf(Buffer.from('504b0102', 'hex'));
  invalidCrc.writeUInt32LE(0, centralOffset + 16);
  const zipBomb = docx([], contentTypes, '<w:document>' + 'x'.repeat(8 * 1024 * 1024) + '</w:document>');
  const invalid = [
    zip([['普通.txt', '不是 Word']]),
    zip([['[Content_Types].xml', contentTypes]]),
    docx([['../evil.txt', 'path traversal']]),
    docx([['word/document.xml', documentXml]]),
    docx([], contentTypes, '<!DOCTYPE document [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document>&x;</w:document>'),
    docx([], contentTypes, '<html>wrong document root</html>'),
    encrypted, oversized, invalidCrc, zipBomb,
    docx().subarray(0, -5), Buffer.concat([docx(), Buffer.from('MZ')])
  ];
  for (let index = 0; index < invalid.length; index++) {
    await assert.rejects(attachments.readUploads([file('损坏.docx', invalid[index])]), failsWith(422), 'case ' + index);
  }
  assert.equal((await attachments.readUploads([file('未压缩.docx', zip([
    ['[Content_Types].xml', contentTypes, { method: 0 }], ['word/document.xml', documentXml, { method: 0 }]
  ]))])).length, 1);
});

test('附件元数据不含内容，只能选取本人同一周次的附件，版本引用长期保留', async t => {
  const { attachments, author, peer, teacher, db } = await fixture(t);
  const [first, second] = attachments.saveMany(author.id, week, await attachments.readUploads([file('首稿.pdf', pdf), file('修改稿.pdf', pdf)]));
  const historicalVersion = JSON.stringify([first, second]);
  const latest = attachments.metadataForIds(author.id, week, [String(second.id)]);
  assert.deepEqual(latest, [second]);
  assert.deepEqual(attachments.getMetadata(first.id), first);
  assert.deepEqual(JSON.parse(historicalVersion), [first, second]);
  assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'id', 'mime', 'name', 'size']);
  assert.doesNotMatch(JSON.stringify(attachments.list(author.id, week)), /%PDF|bytes|student_id/);
  assert.throws(() => attachments.metadataForIds(peer.id, week, [first.id]), failsWith(404));
  assert.throws(() => attachments.metadataForIds(author.id, '2026-11-16', [first.id]), failsWith(404));
  assert.throws(() => attachments.metadataForIds(author.id, week, [first.id, first.id]), failsWith(422));
  assert.throws(() => attachments.metadataForIds(author.id, week, ['1 OR 1=1']), failsWith(422));
  assert.throws(() => attachments.saveMany(teacher.id, week, [{ name: '教师.pdf', bytes: pdf }]), failsWith(404));
  assert.throws(() => attachments.saveMany(author.id, '2026-11-10', [{ name: '错误周次.pdf', bytes: pdf }]), failsWith(422));
  assert.throws(() => attachments.saveMany(author.id, '2026-02-30', []), failsWith(422));
  assert.equal(attachments.getMetadata('错误'), undefined);
  assert.equal(attachments.getMetadata(999999), undefined);
  const row = db.prepare('SELECT bytes, size FROM weekly_attachments WHERE id = ?').get(first.id);
  assert.equal(row.size, pdf.length);
  assert.deepEqual(Buffer.from(row.bytes), pdf, '附件内容存入 SQLite，可随数据库一并备份');
});

test('下载仅限本人和教师，强制附件下载并防止文件名注入', async t => {
  const { attachments, author, peer, teacher } = await fixture(t);
  const [saved] = attachments.saveMany(author.id, week, await attachments.readUploads([file('../子目录\\研究\r\n结果".PDF', pdf)]));
  assert.equal(saved.name, '研究结果".PDF');
  function response() {
    return { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(bytes) { this.body = Buffer.from(bytes); } };
  }
  for (const user of [author, teacher]) {
    const res = response();
    attachments.download({ response: res, state: { user }, id: String(saved.id) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, pdf);
    assert.equal(res.headers['Content-Type'], 'application/pdf');
    assert.equal(res.headers['Content-Length'], pdf.length);
    assert.match(res.headers['Content-Disposition'], /^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/);
    assert.ok(res.headers['Content-Disposition'].endsWith(encodeURIComponent(saved.name)));
    assert.doesNotMatch(res.headers['Content-Disposition'], /\r|\n/);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(res.headers['Cache-Control'], /no-store/);
    assert.match(res.headers['Content-Security-Policy'], /sandbox/);
  }
  for (const state of [{}, { user: peer }, { user: { id: 999999, role: 'teacher' } }]) {
    const res = response();
    assert.throws(() => attachments.download({ response: res, state, id: saved.id }), failsWith(404));
    assert.equal(res.status, undefined);
    assert.equal(res.body, undefined);
  }
  assert.throws(() => attachments.download({ response: response(), state: { user: teacher }, id: '0' }), failsWith(404));
  assert.throws(() => attachments.download({ response: response(), state: { user: author }, id: 999999 }), failsWith(404));
});

test('保存附件服从调用者的事务，失败时不会在数据库留下附件', async t => {
  const { attachments, author, db } = await fixture(t);
  const uploads = await attachments.readUploads([file('暂存.pdf', pdf)]);
  db.exec('BEGIN');
  attachments.saveMany(author.id, week, uploads);
  assert.equal(attachments.list(author.id, week).length, 1);
  db.exec('ROLLBACK');
  assert.deepEqual(attachments.list(author.id, week), []);
});

test('审核或学籍状态变化后，即使旧页面仍然打开也不能下载原始周报附件', async t => {
  const { attachments, author, teacher, accounts, db } = await fixture(t);
  const [saved] = attachments.saveMany(author.id, week, await attachments.readUploads([file('内部周报.pdf', pdf)]));
  function download(user) {
    const response = { writeHead(status) { this.status = status; }, end() {} };
    attachments.download({ response, state: { user }, id: saved.id });
    return response.status;
  }
  accounts.setStudentStatus(teacher.id, author.id, 'graduated');
  assert.throws(() => download(author), failsWith(404), '不能依靠已打开页面中的旧账号状态绕过毕业限制');
  assert.equal(download(teacher), 200, '教师仍可读取历史附件');
  db.prepare("UPDATE accounts SET student_status = 'active', review_status = 'pending' WHERE id = ?").run(author.id);
  assert.throws(() => download(author), failsWith(404), '未通过审核的账号不得读取附件');
  db.prepare("UPDATE accounts SET review_status = 'rejected' WHERE id = ?").run(author.id);
  assert.throws(() => download(author), failsWith(404));
});
