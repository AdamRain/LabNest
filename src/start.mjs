import { accountOptions, databasePath, openDatabase } from './database.mjs';
import { createLabServer } from './server.mjs';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { openMailSettings } from './mail-settings.mjs';
import { loadTransportConfig } from './transport-config.mjs';
import { createHttpsRedirect } from './transport-security.mjs';

const environmentFile = process.env.LAB_ENV_FILE
  || new URL(process.env.LAB_PREVIEW === '1' ? '../.env.demo' : '../.env', import.meta.url);
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

let db, server, redirectServer;
let stopping = false;
const listenerAbort = new AbortController();
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  redirectServer?.close();
  if (server?.listening) server.close(() => db?.close());
  else db?.close();
  listenerAbort.abort();
}
function failed(error) {
  if (stopping && error.code === 'ABORT_ERR') return;
  const hints = { EADDRINUSE: '端口已被占用，请检查端口配置。', EADDRNOTAVAIL: '无法监听指定地址，请检查 LAB_HOST。' };
  console.error('网站启动失败：' + (hints[error.code] || error.message));
  stop(1);
}

try {
  // Validate transport before opening the database. Missing TLS must never silently become public HTTP.
  const config = loadTransportConfig();
  const options = accountOptions();
  process.umask(0o077);
  db = openDatabase();
  const mailSettings = openMailSettings({ file: databasePath() + '.mail.json' });
  server = createLabServer({ db, options, tls: config.tls, transport: config.transport,
    cookieSuffix: config.port === 4173 ? '' : '_' + config.port,
    autoCalendar: process.env.LAB_CALENDAR_SYNC !== '0', preview: process.env.LAB_PREVIEW === '1',
    publicHome: process.env.LAB_PUBLIC_HOME === '1', mailSettings, mailDefaultOrigin: config.canonicalUrl });
  server.on('error', failed);
  if (config.redirectPort) {
    redirectServer = createHttpsRedirect(config.canonicalUrl);
    redirectServer.on('error', failed);
  }
  server.listen({ port: config.port, host: config.host, signal: listenerAbort.signal }, () => {
    if (stopping) { server.close(); return; }
    if (redirectServer) redirectServer.listen(config.redirectPort, config.host);
    if (config.transport.mode === 'legacy-http') console.warn('当前保留校园网 HTTP 兼容入口，传输加密尚未启用。');
    console.log(`实验室管理平台已启动 ${config.canonicalUrl}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
} catch (error) { failed(error); }
