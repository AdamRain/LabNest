import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { packageRelease } from '../scripts/package-release.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checker = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'labnest-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  copyFileSync(checker, join(root, 'scripts', 'check-release.mjs'));
  writeFileSync(join(root, 'README.md'), '# Demo LabNest\n');
  writeFileSync(join(root, 'LICENSE'), 'MIT License\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'labnest', version: '0.5.0' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'labnest', version: '0.5.0', lockfileVersion: 3, packages: {} }));
  writeFileSync(join(root, 'src', 'example.mjs'), 'export const message = "公开示例";\n');
  writeFileSync(join(root, 'src', '示例.txt'), 'Unicode ZIP filename\n');
  return root;
}

// Read the standard central directory independently from the writer, then
// inflate each payload using the offsets recorded in its local header.
function unzip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 10), 8);
    assert.ok(bytes.readUInt16LE(cursor + 8) & 0x0800);
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const body = inflateRawSync(bytes.subarray(start, start + size));
    assert.equal(body.length, bytes.readUInt32LE(cursor + 24));
    files.set(name, body);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('发布ZIP可解压，逐文件SHA清单与校验文件匹配，根目录运行数据不进入包', t => {
  const root = fixture(t);
  for (const name of ['data', 'node_modules', '.runtime', '.git']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'data', 'real.sqlite'), 'SQLite format 3\0');
  writeFileSync(join(root, '.env'), 'LOCAL_ONLY=not-public\n');
  const result = packageRelease({ sourceRoot: root });
  assert.equal(result.archivePath, join(root, 'dist', 'LabNest-v0.5.0.zip'));
  const archive = readFileSync(result.archivePath);
  const files = unzip(archive);
  const prefix = 'LabNest-v0.5.0/';
  assert.equal(files.get(prefix + 'src/example.mjs').toString(), 'export const message = "公开示例";\n');
  assert.equal(files.get(prefix + 'src/示例.txt').toString(), 'Unicode ZIP filename\n');
  for (const file of files.keys()) assert.doesNotMatch(file, /\/(?:data|node_modules|\.runtime|\.git|dist)\/|\.env$/);
  const manifest = JSON.parse(files.get(prefix + 'SOURCE_MANIFEST.json'));
  assert.equal(manifest.project, 'LabNest');
  assert.equal(manifest.version, '0.5.0');
  assert.equal(Object.keys(manifest.files).length, files.size - 1);
  for (const [name, record] of Object.entries(manifest.files)) {
    const bytes = files.get(prefix + name);
    assert.ok(bytes, name);
    assert.equal(record.bytes, bytes.length, name);
    assert.equal(record.sha256, hash(bytes), name);
  }
  assert.equal(readFileSync(result.checksumPath, 'utf8'), hash(archive) + '  LabNest-v0.5.0.zip\n');
  assert.equal(result.sha256, hash(archive));
  assert.ok(result.excludedRootEntries.includes('.env'));
});

test('白名单目录中的私有文件与嵌套运行目录会阻止打包，不能静默省略', t => {
  for (const name of ['private.key', 'copied.sqlite', '.env.local']) {
    const root = fixture(t);
    writeFileSync(join(root, 'src', name), 'not-a-real-secret');
    assert.throws(() => packageRelease({ sourceRoot: root }), /禁止发布/);
    assert.equal(existsSync(join(root, 'dist', 'LabNest-v0.5.0.zip')), false);
  }
  const root = fixture(t);
  mkdirSync(join(root, 'src', '.runtime'));
  assert.throws(() => packageRelease({ sourceRoot: root }), /私有运行目录/);
  if (process.platform !== 'win32') {
    const unsafe = fixture(t);
    writeFileSync(join(unsafe, 'src', '..\\outside.txt'), 'not-public');
    assert.throws(() => packageRelease({ sourceRoot: unsafe }), /不安全的ZIP路径/);
  }
});

test('白名单内符号链接和伪装为普通源码的凭据均会阻止发布', t => {
  const root = fixture(t);
  const link = join(root, 'src', 'linked.mjs');
  try { symlinkSync(join(root, 'README.md'), link); }
  catch (error) { if (error.code === 'EPERM') { t.skip('当前平台不允许创建测试符号链接。'); return; } throw error; }
  assert.throws(() => packageRelease({ sourceRoot: root }), /符号链接/);
  rmSync(link);
  writeFileSync(join(root, 'src', 'config.mjs'), "const password = 'not-a-real-private-value';");
  assert.throws(() => packageRelease({ sourceRoot: root }), /检查未通过/);
  assert.equal(existsSync(join(root, 'dist', 'LabNest-v0.5.0.zip')), false);
});

test('同一源码重复打包不受本地mtime或已有dist文件影响', t => {
  const root = fixture(t);
  const first = packageRelease({ sourceRoot: root });
  const expected = readFileSync(first.archivePath);
  utimesSync(join(root, 'src', 'example.mjs'), new Date('2020-01-01'), new Date('2030-01-01'));
  writeFileSync(join(root, 'dist', 'local-note.txt'), 'not-part-of-release');
  const second = packageRelease({ sourceRoot: root });
  assert.deepEqual(readFileSync(second.archivePath), expected);
  assert.equal(second.sha256, first.sha256);
});
