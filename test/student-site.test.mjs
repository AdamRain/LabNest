import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { crc32, deflateSync, inflateRawSync } from 'node:zlib';
import { openAccounts } from '../src/accounts.mjs';
import { openPhotos } from '../src/photos.mjs';
import { openStudentSite } from '../src/student-site.mjs';
import { escapeHtml, studentProfilePage, token } from '../src/views.mjs';

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const accounts = openAccounts(db);
  const photos = openPhotos(db);
  const password = 'Isolated-CV-password-42';
  const teacher = await accounts.createTeacher({ name: '测试教师', email: 'teacher@cv.example', password });
  let phoneSequence = 0;
  async function student(name, email, approved = true) {
    const user = await accounts.register({ name, email, password, phone: String(13800001234 + phoneSequence++), level: 'graduate',
      studentStatus: 'active', studentNumber: '20260001', major: '计算机技术', relationship: 'direct' });
    if (approved) accounts.reviewStudent(teacher.id, user.id, 'approved');
    db.prepare('UPDATE accounts SET birthday=? WHERE id=?').run('2000-01-02', user.id);
    return accounts.getUser(user.id);
  }
  const author = await student('测试学生', 'private-author@cv.example');
  const peer = await student('另一学生', 'private-peer@cv.example');
  const pending = await student('待审核学生', 'pending@cv.example', false);
  const ui = { escapeHtml, token, httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    html(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'text/html' }); response.end(value); },
    redirect(response, location) { response.writeHead(303, { Location: location }); response.end(''); } };
  const { routes } = openStudentSite({ db, accounts, photos, ui });
  async function go(path, user = author, form = null) {
    const url = new URL(path, 'http://test.local');
    const method = form ? 'POST' : 'GET';
    const route = routes.find(([verb, pattern]) => verb === method && pattern.test(url.pathname));
    assert.ok(route, `${method} ${path}`);
    const match = route[1].exec(url.pathname);
    const result = { status: 200, headers: {}, bytes: Buffer.alloc(0) };
    const response = { writeHead(status, headers) { result.status = status; result.headers = headers; },
      end(value = '') { result.bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); } };
    const state = { user, csrf: 'test-token', siteName: '研栖 · LabNest', path: url.pathname };
    try { await route[3]({ response, state, form, id: match[1] ? Number(match[1]) : null, url }); }
    catch (error) { if (!error.statusCode) throw error; result.status = error.statusCode; result.bytes = Buffer.from(error.message); }
    result.text = result.bytes.toString();
    return result;
  }
  const draft = { revision: '0', title: '硕士研究生', bio: '研究智能信息服务与多模态检索。',
    research: '多模态检索\n文化资源分析', education: '2024 至今｜西北大学｜计算机技术 硕士',
    projects: '文化资源检索实验\n负责模型训练与数据分析。', publications: '公开论文甲',
    awards: '研究生学业奖学金', skills: 'Python、PyTorch', links: 'GitHub｜https://github.com/example',
    publicEmail: 'public-contact@cv.example', publishEmail: '1' };
  t.after(() => db.close());
  return { db, accounts, photos, teacher, author, peer, pending, go, draft };
}

function zipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while ((offset = bytes.indexOf(Buffer.from('504b0102', 'hex'), offset)) !== -1) {
    const method = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30);
    const comment = bytes.readUInt16LE(offset + 32), localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
    const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const content = bytes.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(content) : content);
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

function zipText(bytes, name) {
  const content = zipEntries(bytes).get(name);
  assert.ok(content, `缺少 DOCX 项 ${name}`);
  return content.toString();
}

function embeddedPhotos(bytes) {
  return [...zipEntries(bytes)].filter(([name]) => /^word\/media\/.*\.(?:png|jpe?g)$/i.test(name)).map(([, value]) => value);
}

// Synthetic images keep the checks independent of real students' photos and external files.
function samplePhoto(width, height, color, { alpha = false, corruptIDAT = false, filter = 0 } = {}) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  const channels = alpha ? 4 : 3;
  const rows = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y++) {
    rows[y * (1 + width * channels)] = filter;
    for (let x = 0; x < width; x++) rows.set(alpha ? [...color, 255] : color, y * (1 + width * channels) + 1 + x * channels);
  }
  return { mime: 'image/png', bytes: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', corruptIDAT ? Buffer.from([1, 2, 3]) : deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]) };
}

test('个人主页必须主动发布，公开快照与草稿分开，撤下后匿名不能读取', async t => {
  const { db, photos, author, go, draft } = await fixture(t);
  photos.save(author.id, samplePhoto(24, 32, [180, 60, 40]));
  assert.equal((await go(`/people/${author.id}`, null)).status, 404);
  assert.equal((await go('/student/homepage', author, draft)).status, 303);
  assert.equal((await go(`/people/${author.id}`, null)).status, 404);
  assert.equal((await go('/student/homepage/publish', author, { revision: '1' })).status, 400);
  assert.equal((await go('/student/homepage/publish', author, { revision: '1', confirmPublic: '1' })).status, 303);
  const live = await go(`/people/${author.id}`, null);
  assert.equal(live.status, 200);
  assert.match(live.text, /研究智能信息服务与多模态检索/);
  assert.match(live.text, /public-contact@cv.example/);
  assert.doesNotMatch(live.text, /private-author|13800001234|2000-01-02|\/portal|\/student\/photo|周报/);
  const saved = db.prepare('SELECT draft, published FROM student_sites WHERE student_id=?').get(author.id);
  for (const value of [saved.draft, saved.published]) {
    assert.doesNotMatch(value, /"(?:photo|photoUrl|photoBytes|photoData)"|data:image\//);
  }
  assert.doesNotMatch(live.text, /编辑我的主页/);
  assert.match((await go(`/people/${author.id}`, author)).text, /编辑我的主页/);
  await go('/student/homepage', author, { ...draft, revision: '1', bio: '修改后的草稿介绍。' });
  assert.doesNotMatch((await go(`/people/${author.id}`, null)).text, /修改后的草稿介绍/);
  assert.match((await go('/student/homepage')).text, /草稿已有修改/);
  await go('/student/homepage/publish', author, { revision: '2', confirmPublic: '1' });
  assert.match((await go(`/people/${author.id}`, null)).text, /修改后的草稿介绍/);
  await go('/student/homepage/unpublish', author, {});
  assert.equal((await go(`/people/${author.id}`, null)).status, 404);
  assert.match((await go('/student/homepage')).text, /修改后的草稿介绍/);
});

test('待审核账号不能进入个人主页管理、编辑发布或导出；毕业学生可继续维护，失去审核资格立即隐藏', async t => {
  const { db, accounts, author, pending, peer, teacher, go, draft } = await fixture(t);
  assert.equal((await go('/student/homepage', pending)).status, 403);
  for (const path of ['/student/homepage', '/student/homepage/publish', '/student/homepage/unpublish']) {
    assert.equal((await go(path, pending, draft)).status, 403);
  }
  for (const path of ['/student/resume.pdf', '/student/resume.docx']) {
    for (const user of [null, pending, teacher]) assert.equal((await go(path, user)).status, 403);
  }
  accounts.setStudentStatus(teacher.id, author.id, 'graduated', author.studentNumber);
  await go('/student/homepage', author, { ...draft, studentId: peer.id });
  assert.equal(db.prepare('SELECT student_id FROM student_sites').get().student_id, author.id);
  await go('/student/homepage/publish', author, { revision: '1', confirmPublic: '1' });
  assert.equal((await go(`/people/${author.id}`, null)).status, 200);
  db.prepare("UPDATE accounts SET review_status='rejected' WHERE id=?").run(author.id);
  assert.equal((await go(`/people/${author.id}`, null)).status, 404);
});

test('公开邮箱须明确勾选、外链只允许安全协议，文本转义，过期编辑不会覆盖新草稿', async t => {
  const { go, author, draft } = await fixture(t);
  assert.equal((await go('/student/homepage', author, { ...draft, links: '危险｜javascript:alert(1)' })).status, 400);
  assert.equal((await go('/student/homepage', author, { ...draft, publicEmail: '错误邮箱' })).status, 400);
  assert.equal((await go('/student/homepage', author, { ...draft, publishEmail: '', bio: '<script>alert(1)</script>介绍' })).status, 303);
  assert.equal((await go('/student/homepage', author, draft)).status, 409);
  await go('/student/homepage/publish', author, { revision: '1', confirmPublic: '1' });
  const live = (await go(`/people/${author.id}`, null)).text;
  assert.match(live, /&lt;script&gt;/);
  assert.doesNotMatch(live, /<script>|public-contact@cv.example|private-author/);
  assert.match((await go('/student/homepage?saved=1')).text, /草稿已保存/);
  assert.match((await go('/student/homepage?published=1')).text, /个人主页已发布/);
  assert.match((await go('/student/homepage?unpublished=1')).text, /个人主页已撤下/);
});

test('PDF 与 Word 均为真实下载且使用自己的已保存内容，无需公开且不会夹带账户隐私', async t => {
  const { go, author, peer, draft, db } = await fixture(t);
  await go('/student/homepage', author, draft);
  const pdf = await go('/student/resume.pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['Content-Type'], 'application/pdf');
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.bytes.length > 10000);
  assert.match(pdf.text, /\/FontFile3|\/FontFile2/);
  assert.match(pdf.text, /\/ToUnicode/);
  assert.equal((pdf.text.match(/\/Type \/Page\b/g) ?? []).length, 1, '短简历不能因页脚生成空白页');
  assert.equal(pdf.headers['Cache-Control'], 'no-store');
  assert.equal(/\/Subtype \/Image\b/.test(pdf.text), false, '未上传照片时不嵌入图片');
  assert.match(pdf.headers['Content-Disposition'], /attachment; filename="resume-\d+\.pdf"/);
  const docx = await go('/student/resume.docx');
  assert.equal(docx.status, 200);
  assert.equal(docx.bytes.subarray(0, 2).toString(), 'PK');
  assert.match(docx.headers['Content-Type'], /wordprocessingml.document/);
  assert.match(zipText(docx.bytes, '[Content_Types].xml'), /wordprocessingml.document.main\+xml/);
  assert.match(zipText(docx.bytes, 'word/fontTable.xml'), /FandolHei/);
  assert.match(zipText(docx.bytes, 'word/fontTable.xml'), /w:embedRegular/);
  const xml = zipText(docx.bytes, 'word/document.xml');
  assert.match(xml, /测试学生|研究智能信息服务与多模态检索/);
  assert.match(xml, /public-contact@cv.example/);
  assert.doesNotMatch(xml, /private-author|13800001234|2000-01-02/);
  assert.equal(embeddedPhotos(docx.bytes).length, 0);
  const peerXml = zipText((await go('/student/resume.docx', peer)).bytes, 'word/document.xml');
  assert.doesNotMatch(peerXml, /研究智能信息服务与多模态检索|public-contact@cv.example|private-peer/);
  assert.equal(db.prepare('SELECT published FROM student_sites WHERE student_id=?').get(author.id).published, null);
});

test('简历仅嵌入本人当前生活照，替换和移除立即生效，旧坏图片不阻断导出', async t => {
  const { photos, author, peer, go, draft } = await fixture(t);
  const portrait = samplePhoto(24, 32, [180, 60, 40]);
  const landscape = samplePhoto(40, 24, [40, 100, 170]);
  const peerPhoto = samplePhoto(32, 32, [30, 150, 80]);
  photos.save(author.id, portrait);
  photos.save(peer.id, peerPhoto);
  await go('/student/homepage', author, { ...draft, studentId: String(peer.id) });
  const queriedPath = format => `/student/resume.${format}?studentId=${peer.id}&id=${peer.id}`;
  const pdf = await go(queriedPath('pdf'));
  assert.equal(pdf.status, 200);
  assert.equal(/\/Subtype \/Image\b/.test(pdf.text), true, 'PDF 应嵌入本人生活照');
  assert.equal((pdf.text.match(/\/Type \/Page\b/g) ?? []).length, 1);
  const docx = await go(queriedPath('docx'));
  assert.equal(docx.status, 200);
  assert.deepEqual(embeddedPhotos(docx.bytes), [portrait.bytes]);
  assert.match(zipText(docx.bytes, 'word/document.xml'), /<w:drawing>/);
  assert.deepEqual(embeddedPhotos((await go('/student/resume.docx', peer)).bytes), [peerPhoto.bytes]);

  photos.save(author.id, landscape);
  assert.deepEqual(embeddedPhotos((await go('/student/resume.docx')).bytes), [landscape.bytes]);
  assert.equal(/\/Subtype \/Image\b/.test((await go('/student/resume.pdf')).text), true);
  photos.remove(author.id);
  assert.equal(embeddedPhotos((await go('/student/resume.docx')).bytes).length, 0);
  assert.equal(/\/Subtype \/Image\b/.test((await go('/student/resume.pdf')).text), false);

  const invalidPhotos = [
    { mime: 'image/png', bytes: Buffer.from('89504e470d0a1a0a', 'hex') },
    samplePhoto(1, 1, [10, 20, 30], { alpha: true, corruptIDAT: true }),
    samplePhoto(1, 1, [10, 20, 30], { alpha: true, filter: 5 })
  ];
  for (const invalidPhoto of invalidPhotos) {
    photos.save(author.id, invalidPhoto);
    for (const format of ['pdf', 'docx']) {
      const result = await go(`/student/resume.${format}`);
      assert.equal(result.status, 200);
      if (format === 'pdf') assert.equal(/\/Subtype \/Image\b/.test(result.text), false);
      else assert.equal(embeddedPhotos(result.bytes).length, 0);
    }
  }
});

test('个人信息档案卡展示已有生活照，毕业生仍可查看，无照片时不生成失效图片', async t => {
  const { accounts, photos, teacher, author } = await fixture(t);
  photos.save(author.id, samplePhoto(24, 32, [180, 60, 40]));
  const render = user => studentProfilePage({ user, csrf: 'test-token', path: '/student/profile',
    hasPhoto: photos.has(user.id) });
  const photo = new RegExp(`<img\\b[^>]*class="[^"]*student-photo--portrait[^"]*"[^>]*src="/student/photo/${author.id}"`);
  assert.equal(photo.test(render(author)), true, '本人档案卡应展示已有生活照');
  accounts.setStudentStatus(teacher.id, author.id, 'graduated', author.studentNumber);
  const graduate = accounts.getUser(author.id);
  assert.equal(photo.test(render(graduate)), true, '毕业生档案卡仍应展示已有生活照');
  assert.doesNotMatch(render(graduate), /action="\/student\/photo(?:\/remove)?"/);
  photos.remove(author.id);
  assert.doesNotMatch(render(graduate), /<img\b[^>]*src="\/student\/photo\//);
});
