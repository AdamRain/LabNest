import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
import { inspectPhoto, photoLimit } from '../src/photo-validation.mjs';
import { openPhotos } from '../src/photos.mjs';

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
function chunk(type, bytes = Buffer.alloc(0)) {
  const data = Buffer.concat([Buffer.from(type, 'latin1'), bytes]);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([length, data, checksum]);
}
function header(width = 2, height = 3, { bits = 8, color = 2, interlace = 0 } = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
  data[8] = bits; data[9] = color; data[12] = interlace;
  return chunk('IHDR', data);
}
function png({ width = 2, height = 3, alpha = false, filter = 0, metadata = false } = {}) {
  const channels = alpha ? 4 : 3, rows = Buffer.alloc(height * (1 + width * channels), 100);
  for (let y = 0; y < height; y++) rows[y * (1 + width * channels)] = filter;
  return Buffer.concat([signature, header(width, height, { color: alpha ? 6 : 2 }),
    ...(metadata ? [chunk('tEXt', Buffer.from('Comment\0Synthetic photo'))] : []),
    chunk('IDAT', deflateSync(rows)), chunk('IEND')]);
}
// A tiny, generated solid-colour JPEG; no real student's image is used.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAYDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDPooorpOE//9k=', 'base64');

test('正常横竖照、透明 PNG 和 JPEG 有界校验通过，导出图不携带文本元数据', () => {
  for (const options of [{ width: 24, height: 32 }, { width: 40, height: 24 }, { alpha: true }]) {
    const bytes = png(options), image = inspectPhoto(bytes);
    assert.equal(image.mime, 'image/png'); assert.deepEqual(image.data, bytes);
    assert.equal(image.width, options.width ?? 2); assert.equal(image.height, options.height ?? 3);
  }
  assert.deepEqual(inspectPhoto(png({ metadata: true })).data, png());
  const image = inspectPhoto(jpeg, { mime: 'image/jpeg' });
  assert.equal(image.width, 6); assert.equal(image.height, 8); assert.deepEqual(image.data, jpeg);
  assert.throws(() => inspectPhoto(jpeg, { mime: 'image/png' }));
});

test('PNG 必须完整校验无符号长度、CRC、块顺序与结束边界', () => {
  const good = png(), idat = chunk('IDAT', deflateSync(Buffer.alloc(21))), end = chunk('IEND');
  const badCrc = Buffer.from(good); badCrc[badCrc.length - 1] ^= 1;
  const unsignedLength = Buffer.alloc(12); unsignedLength.writeUInt32BE(0x80000000);
  unsignedLength.write('aaAa', 4);
  const cases = [signature, Buffer.concat([signature, unsignedLength]), good.subarray(0, -1), badCrc,
    Buffer.concat([signature, idat, end]), Buffer.concat([signature, header(), header(), idat, end]),
    Buffer.concat([signature, header(), end]), Buffer.concat([signature, header(), idat]),
    Buffer.concat([good, Buffer.from([0])]),
    Buffer.concat([signature, header(), chunk('ABCD'), idat, end]),
    Buffer.concat([signature, header(), chunk('aa\xc1a'), idat, end]),
    Buffer.concat([signature, header(), idat, chunk('aaAa'), idat, end]),
    Buffer.concat([signature, header(2, 3, { color: 3 }), idat, end])];
  for (const bytes of cases) assert.throws(() => inspectPhoto(bytes), undefined, bytes.toString('hex').slice(0, 50));
});

test('PNG 对像素、解压大小、过滤器与块数设置预算，JPEG 拒绝坏段边界', () => {
  const end = chunk('IEND'), pixels = chunk('IDAT', deflateSync(Buffer.alloc(21)));
  for (const bytes of [Buffer.concat([signature, header(0xffffffff, 1), pixels, end]),
    Buffer.concat([signature, header(5000, 5000), pixels, end]),
    Buffer.concat([signature, header(4096, 4096, { bits: 16, color: 6 }), pixels, end]),
    Buffer.concat([signature, header(), chunk('IDAT', deflateSync(Buffer.alloc(22))), end]),
    Buffer.concat([signature, header(), chunk('IDAT', deflateSync(Buffer.alloc(20))), end]),
    Buffer.concat([signature, header(), chunk('IDAT', Buffer.from([1, 2, 3])), end]), png({ filter: 5 }),
    Buffer.concat([signature, header(), ...Array.from({ length: 2048 }, () => chunk('aaAa')), pixels, end]),
    jpeg.subarray(0, -2), Buffer.from('ffd8ffe10000ffd9', 'hex')]) {
    assert.throws(() => inspectPhoto(bytes));
  }
});

test('上传在持久化之前拒绝坏图片，维持 2MB 文件限制', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE accounts(id INTEGER PRIMARY KEY) STRICT; INSERT INTO accounts VALUES(1)');
  const photos = openPhotos(db), httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  const good = await photos.readUpload(new File([png()], 'portrait.png'), httpError);
  photos.save(1, good);
  await assert.rejects(photos.readUpload(new File([signature], 'bad.png'), httpError), { statusCode: 422 });
  await assert.rejects(photos.readUpload(new File([Buffer.alloc(photoLimit + 1)], 'large.png'), httpError), { statusCode: 413 });
  assert.deepEqual(Buffer.from(photos.get(1).bytes), good.bytes);
  assert.equal((await photos.readUpload(new File([jpeg], 'photo.jpg'), httpError)).mime, 'image/jpeg');
});

test('坏历史图及时跳过，正常透明图和 JPEG 的 PDF/Word 仍能导出（隔离期限）', () => {
  const badLength = Buffer.alloc(12); badLength.writeUInt32BE(0x80000000); badLength.write('aaAa', 4);
  const inputs = [{ mime: 'image/png', bytes: Buffer.concat([signature, badLength]) },
    { mime: 'image/png', bytes: png({ filter: 5 }) }, { mime: 'image/png', bytes: png({ alpha: true }) },
    { mime: 'image/png', bytes: png({ width: 40, height: 24 }) }, { mime: 'image/jpeg', bytes: jpeg }];
  const script = `import assert from 'node:assert/strict';
    import {resumePdf,resumeDocx} from ${JSON.stringify(new URL('../src/resume-export.mjs', import.meta.url).href)};
    const inputs=${JSON.stringify(inputs.map(p => ({ mime: p.mime, base64: p.bytes.toString('base64') })))};
    const profile={name:'合成测试学生',bio:'保留文字简历。'};
    for (const input of [...inputs,null]) {
      const photo=input?{mime:input.mime,bytes:Buffer.from(input.base64,'base64')}:null;
      const pdf=await resumePdf(profile,{photo}), word=await resumeDocx(profile,{photo});
      assert.equal(pdf.subarray(0,5).toString(),'%PDF-'); assert.equal(word.subarray(0,2).toString(),'PK');
      const expectPhoto=Boolean(input && inputs.indexOf(input)>=2);
      assert.equal(pdf.includes(Buffer.from('/Subtype /Image')),expectPhoto);
      assert.equal(word.includes(Buffer.from('word/media/')),expectPhoto);
    }
    process.stdout.write('exports complete');`;
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', script],
    { timeout: 8000, maxBuffer: 8192, encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'exports complete');
});
