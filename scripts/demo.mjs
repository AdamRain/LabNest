import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLabServer } from '../src/server.mjs';
import { seedDemo, demoCalendar, demoCalendarUrl } from './seed-demo.mjs';

export function demoOptions(args = [], env = process.env) {
  if (env.NODE_ENV === 'production') throw new Error('公开口令演示不能在生产模式启动；请按部署文档创建空库和专用账号。');
  if (env.LAB_DB_PATH || env.LAB_ENV_FILE) throw new Error('演示模式不接受 LAB_DB_PATH 或 LAB_ENV_FILE；请取消这些变量后重试。');
  if (env.LAB_HOST && env.LAB_HOST !== '127.0.0.1') throw new Error('公开口令演示仅允许监听 127.0.0.1。');
  let port = 4180;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1])) throw new Error('用法：npm run demo [-- --port 4181]');
    port = Number(args[1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('演示端口须为 1024 至 65535 之间的整数。');
  }
  return { host: '127.0.0.1', port };
}

export async function startDemo({ args = process.argv.slice(2), env = process.env } = {}) {
  const config = demoOptions(args, env);
  const seeded = await seedDemo();
  const db = new DatabaseSync(seeded.path, { timeout: 3000 });
  const origin = `http://127.0.0.1:${config.port}`;
  // No environment-file loader, SMTP adapter, real feed fetcher, or public bind in this launcher.
  const server = createLabServer({ db, cookieSuffix: '_public_demo_' + config.port, autoCalendar: false,
    transport: { mode: 'development' }, preview: true, publicHome: false,
    calendarFetch: async url => {
      if (url !== demoCalendarUrl) throw new Error('演示模式只读取内置虚构日程；真实订阅请在独立正式安装中配置。');
      return new Response(demoCalendar(Date.parse(seeded.seededAt)), { headers: { 'content-type': 'text/calendar; charset=utf-8' } });
    }
  });
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(config.port, config.host, done); });
  } catch (error) {
    server.close();
    db.close();
    throw error;
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => db.close());
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  console.log('研栖 · LabNest 本机演示已启动：' + origin);
  console.log('所有人物、成果和会议日程均为虚构；演示口令见 DEMO.md。');
  console.log('演示内容对应周次：' + seeded.week + '；关闭此终端或按 Ctrl+C 停止。');
  return { db, server, stop, origin, seeded };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await startDemo(); }
  catch (error) {
    console.error('演示启动失败：' + (error.code === 'EADDRINUSE' ? '端口已占用，可用 npm run demo -- --port 4181。' : error.message));
    process.exitCode = 1;
  }
}
