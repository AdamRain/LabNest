import { randomBytes } from 'node:crypto';
import { openAccounts } from './accounts.mjs';
import { accountOptions, openDatabase } from './database.mjs';

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('用法 npm run admin -- 管理员邮箱 "管理员姓名"');
  process.exit(1);
}

process.umask(0o077);
const db = openDatabase();
try {
  const accounts = openAccounts(db, accountOptions());
  const password = randomBytes(24).toString('base64url');
  await accounts.createAdmin({ email, name, password });
  console.log(`管理员账号已创建。请保存登录密码 ${password}`);
} catch (error) {
  console.error(error.statusCode ? error.message : '创建管理员账号失败。');
  process.exitCode = 1;
} finally {
  db.close();
}
