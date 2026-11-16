import { randomBytes } from 'node:crypto';
import { openAccounts } from './accounts.mjs';
import { accountOptions, openDatabase } from './database.mjs';

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('用法 npm run teacher -- 教师邮箱 "教师姓名"');
  process.exit(1);
}

process.umask(0o077);
const db = openDatabase();
try {
  const accounts = openAccounts(db, accountOptions());
  const password = randomBytes(24).toString('base64url');
  await accounts.createTeacher({ email, name, password });
  console.log(`教师账号已创建。请保存登录密码 ${password}`);
} catch (error) {
  console.error(error.statusCode ? error.message : '创建教师账号失败。');
  process.exitCode = 1;
} finally {
  db.close();
}
