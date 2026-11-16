import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const sourceDirectories = ['src', 'public', 'test', 'scripts', 'fixtures', 'docs', 'deploy', '.github'];
const sourceFiles = ['README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md',
  'DEMO.md', 'package.json', 'package-lock.json', '.env.example', '.gitignore', '.gitattributes', '.nvmrc'];
const privateDirectories = new Set(['data', 'node_modules', '.runtime', '.git', 'dist', 'tmp', 'coverage', 'backups']);
const privateExtension = /\.(?:sqlite3?(?:-(?:shm|wal))?|db3?|pem|key|p12|pfx|jks|crt|cer|log|bak|dump|zip|tar|tgz|gz|7z)$/i;
const maxFileBytes = 64 * 1024 * 1024;
const maxSourceBytes = 256 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = path => path.split(sep).join('/');
function hasEntry(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function assertSafe(path, file) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('发布源码不接受符号链接：' + file);
  if (stat.isDirectory() && privateDirectories.has(basename(path))) throw new Error('白名单目录含私有运行目录：' + file);
  if (stat.isFile() && (privateExtension.test(file) || basename(path) === '.DS_Store'
    || /^\.env(?:\.|$)/.test(basename(path)) && basename(path) !== '.env.example')) {
    throw new Error('白名单目录含禁止发布的私有或生成文件：' + file);
  }
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('发布源码含不支持的文件类型：' + file);
  if (stat.isFile() && stat.size > maxFileBytes) throw new Error('单个发布文件超过64 MiB：' + file);
  return stat;
}

// ZIP32 with UTF-8 names and raw DEFLATE. Fixed DOS timestamps avoid leaking
// local file times and make repeated builds of the same source reproducible.
function zipArchive(files, prefix) {
  if (files.length > 0xffff) throw new Error('发布文件过多，超过ZIP32限制。');
  const table = Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
    return crc >>> 0;
  });
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ crc >>> 8;
    return (crc ^ 0xffffffff) >>> 0;
  };
  const local = [], central = [];
  let offset = 0, centralSize = 0;
  for (const file of files) {
    const name = Buffer.from(prefix + '/' + file.name, 'utf8');
    const bytes = readFileSync(file.path);
    const compressed = deflateRawSync(bytes, { level: 9 });
    if (name.length > 0xffff || bytes.length > 0xffffffff || compressed.length > 0xffffffff) {
      throw new Error('发布文件超出ZIP32限制：' + file.name);
    }
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(33, 12); // 1980-01-01, the first valid DOS date.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);

    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(0x0314, 4); // Unix creator, ZIP version 2.0.
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x0800, 8);
    index.writeUInt16LE(8, 10);
    index.writeUInt16LE(33, 14);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(compressed.length, 20);
    index.writeUInt32LE(bytes.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((file.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    central.push(index, name);
    offset += header.length + name.length + compressed.length;
    centralSize += index.length + name.length;
    if (offset + centralSize > 0xffffffff) throw new Error('发布包超过ZIP32限制。');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function atomicWrite(path, bytes) {
  const temp = join(dirname(path), '.' + basename(path) + '.' + randomBytes(6).toString('hex') + '.tmp');
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function packageRelease({ sourceRoot = fileURLToPath(new URL('..', import.meta.url)), outputRoot } = {}) {
  const root = resolve(sourceRoot);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('源码路径必须是普通目录。');
  const output = resolve(outputRoot || join(root, 'dist'));
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory())) {
    throw new Error('输出路径必须是普通目录。');
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version || '')) {
    throw new Error('package.json须包含有效的版本号。');
  }
  for (const required of ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'scripts/check-release.mjs']) {
    if (!existsSync(join(root, required))) throw new Error('缺少发布必需文件：' + required);
  }
  const prefix = 'LabNest-v' + pkg.version;
  const workspace = mkdtempSync(join(tmpdir(), 'labnest-release-'));
  const copiedRoot = join(workspace, prefix);
  const files = [];
  let total = 0;
  mkdirSync(copiedRoot);
  function copy(path) {
    const file = normalized(relative(root, path));
    if (file.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))) {
      throw new Error('发布源码含不安全的ZIP路径名称。');
    }
    const stat = assertSafe(path, file);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) copy(join(path, name));
    } else {
      total += stat.size;
      if (total > maxSourceBytes) throw new Error('发布源码总量超过256 MiB，请检查是否混入运行数据。');
      const dest = join(copiedRoot, file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(path, dest);
      files.push({ name: file, path: dest, executable: Boolean(stat.mode & 0o111) });
    }
  }
  try {
    for (const name of [...sourceDirectories, ...sourceFiles].sort()) {
      if (hasEntry(join(root, name))) copy(join(root, name));
    }
    files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const sourceManifest = { formatVersion: 1, project: 'LabNest', version: pkg.version,
      files: Object.fromEntries(files.map(file => {
        const bytes = readFileSync(file.path);
        return [file.name, { bytes: bytes.length, sha256: hash(bytes) }];
      })) };
    const manifestPath = join(copiedRoot, 'SOURCE_MANIFEST.json');
    writeFileSync(manifestPath, JSON.stringify(sourceManifest, null, 2) + '\n');
    const scan = spawnSync(process.execPath, [join(copiedRoot, 'scripts/check-release.mjs'), '--strict', copiedRoot],
      { encoding: 'utf8', timeout: 30000 });
    if (scan.error || scan.status !== 0) throw new Error('发布源码检查未通过。\n' + (scan.stdout || '扫描器未能完成。'));
    files.push({ name: 'SOURCE_MANIFEST.json', path: manifestPath, executable: false });
    files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const archive = zipArchive(files, prefix);
    mkdirSync(output, { recursive: true });
    const archiveName = prefix + '.zip';
    const archivePath = join(output, archiveName);
    const checksumPath = join(output, 'SHA256SUMS.txt');
    atomicWrite(archivePath, archive);
    atomicWrite(checksumPath, hash(archive) + '  ' + archiveName + '\n');
    const selected = new Set([...sourceDirectories, ...sourceFiles]);
    return { archivePath, checksumPath, files: files.length, bytes: archive.length,
      sha256: hash(archive), excludedRootEntries: readdirSync(root).filter(name => !selected.has(name)).sort() };
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('用法：node scripts/package-release.mjs；版本读取自package.json。');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(packageRelease(), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
