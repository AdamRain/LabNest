import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sqlite from 'node:sqlite';

export function databasePath() {
  const defaultFile = fileURLToPath(new URL('../data/lab.sqlite', import.meta.url));
  return resolve(process.env.LAB_DB_PATH || defaultFile);
}

export function openDatabase() {
  const file = databasePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const Database = sqlite.Database ?? sqlite.DatabaseSync;
  const db = new Database(file, { timeout: 3000 });
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

export function accountOptions() {
  const undergraduate = process.env.LAB_UNDERGRAD_ID_LENGTH;
  const graduate = process.env.LAB_GRAD_ID_LENGTH;

  if (!undergraduate && !graduate) return {};
  if (!/^[1-9][0-9]?$/.test(undergraduate ?? '') ||
      !/^[1-9][0-9]?$/.test(graduate ?? '') ||
      Number(undergraduate) > 32 || Number(undergraduate) <= Number(graduate)) {
    throw new Error('请同时设置本科生和研究生的学号位数，均为 1 至 32 位，本科学号须更长。');
  }

  return { undergradIdLength: Number(undergraduate), gradIdLength: Number(graduate) };
}
