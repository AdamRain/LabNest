import { isIP } from 'node:net';
import nodemailer from 'nodemailer';

function setting(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function plainEmail(value) {
  const address = setting(value);
  if (address.length > 254 || !/^[^@\s<>,:;"\\[\]()]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(address)) return null;
  return address.toLowerCase();
}

function publicOrigin(value) {
  const url = URL.parse(setting(value));
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) return null;
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  return url.protocol === 'https:' || loopback ? url.origin : null;
}

function smtpHost(value) {
  const host = setting(value);
  if (!host || host.length > 253 || /[\s/@?#]/.test(host)) return null;
  if (isIP(host)) return host;
  return host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ? host : null;
}

function textField(value, fallback, limit = 100) {
  return setting(value).replace(/[\r\n]/g, ' ').slice(0, limit) || fallback;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function unavailable(code = 'RESET_MAIL_FAILED') {
  return Object.assign(new Error(code === 'RESET_MAIL_NOT_CONFIGURED'
    ? '邮件找回暂未启用，请联系教师。'
    : '重置邮件暂时无法发送，请稍后再试。'), { code });
}

export function createResetMailer(env = process.env, { createTransport = nodemailer.createTransport } = {}) {
  const host = smtpHost(env.LAB_SMTP_HOST);
  const port = Number(setting(env.LAB_SMTP_PORT) || '465');
  const user = setting(env.LAB_SMTP_USER);
  const password = typeof env.LAB_SMTP_PASSWORD === 'string' ? env.LAB_SMTP_PASSWORD : '';
  const from = plainEmail(env.LAB_SMTP_FROM || user);
  const origin = publicOrigin(env.LAB_PUBLIC_URL);
  const missing = !setting(env.LAB_SMTP_HOST) || !user || !password || !setting(env.LAB_PUBLIC_URL);
  let configurationError = missing ? '请配置网站地址及邮件发送账号。' : '';
  if (!missing && (!host || ![465, 587].includes(port) || !from || !origin || /[\r\n]/.test(user))) {
    configurationError = '邮件发送配置有误，请检查网站地址、服务器、端口和发件邮箱。';
  }

  let transport = null;
  if (!configurationError) {
    try {
      transport = createTransport({
        host, port, secure: port === 465, requireTLS: port === 587,
        auth: { user, pass: password },
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        connectionTimeout: 10_000, greetingTimeout: 10_000,
        socketTimeout: 10_000, dnsTimeout: 10_000,
        logger: false, debug: false,
        disableFileAccess: true, disableUrlAccess: true
      });
      if (typeof transport?.sendMail !== 'function') throw unavailable();
    } catch {
      transport = null;
      configurationError = '邮件发送配置有误，请检查邮件服务器设置。';
    }
  }

  return {
    configured: Boolean(transport),
    publicOrigin: transport ? origin : null,
    configurationError: configurationError || null,

    async sendPasswordReset({ to, name, resetUrl, siteName } = {}) {
      if (!transport) throw unavailable('RESET_MAIL_NOT_CONFIGURED');
      const recipient = plainEmail(to);
      const url = URL.parse(typeof resetUrl === 'string' ? resetUrl : '');
      if (!recipient || !url || url.origin !== origin || url.username || url.password || url.hash) {
        throw unavailable();
      }
      const team = textField(siteName, '实验室管理平台');
      const person = textField(name, '', 80);
      const greeting = person ? `${person}，你好：` : '你好：';
      const link = url.href;
      const text = `${greeting}\n\n我们收到了你的${team}密码重置申请。请在 15 分钟内打开以下链接设置新密码：\n\n${link}\n\n此链接仅可使用一次。如果你没有申请重置密码，请忽略这封邮件。\n\n${team}`;
      const html = `<p>${escapeHtml(greeting)}</p><p>我们收到了你的${escapeHtml(team)}密码重置申请。请在 15 分钟内打开以下链接设置新密码：</p><p><a href="${escapeHtml(link)}">设置新密码</a></p><p>如果按钮无法打开，可复制以下地址到浏览器：</p><p>${escapeHtml(link)}</p><p>此链接仅可使用一次。如果你没有申请重置密码，请忽略这封邮件。</p><p>${escapeHtml(team)}</p>`;
      try {
        const info = await transport.sendMail({
          from: { name: team, address: from },
          to: { name: person, address: recipient },
          subject: `${team}：重置登录密码`, text, html,
          disableFileAccess: true, disableUrlAccess: true
        });
        const accepted = info?.accepted ?? [];
        if (!accepted.some(address => plainEmail(typeof address === 'string' ? address : address?.address) === recipient)) {
          throw unavailable();
        }
        return { accepted: true };
      } catch {
        throw unavailable();
      }
    }
  };
}
