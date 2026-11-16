import { closeSync, openSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import * as sqlite from 'node:sqlite';
import { databasePath } from './database.mjs';

const name = process.argv[2];
if (!name) {
  console.error('用法 npm run backup -- 备份文件路径');
  process.exit(1);
}

const destination = resolve(name);
const Database = sqlite.Database ?? sqlite.DatabaseSync;
let source;
let created = false;
try {
  source = new Database(databasePath(), { readOnly: true, timeout: 3000 });
  const fd = openSync(destination, 'wx', 0o600);
  created = true;
  closeSync(fd);
  await sqlite.backup(source, destination);
  console.log('备份已写入 ' + destination);
} catch (error) {
  if (created) unlinkSync(destination);
  console.error(error.code === 'EEXIST' ? '备份文件已存在，请指定新的文件名。' : error.message);
  process.exitCode = 1;
} finally {
  source?.close();
}
