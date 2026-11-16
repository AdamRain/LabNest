import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createResetMailer } from './reset-mailer.mjs';

const fields = {
  smtpHost: 'LAB_SMTP_HOST', smtpPort: 'LAB_SMTP_PORT', smtpUser: 'LAB_SMTP_USER',
  smtpPassword: 'LAB_SMTP_PASSWORD', smtpFrom: 'LAB_SMTP_FROM', publicUrl: 'LAB_PUBLIC_URL'
};

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function disabledMailer(message) {
  return {
    configured: false, publicOrigin: null, configurationError: message,
    async sendPasswordReset() {
      throw Object.assign(new Error('邮件找回暂未启用，请联系教师。'), { code: 'RESET_MAIL_NOT_CONFIGURED' });
    }
  };
}

export function openMailSettings({ file, env = process.env }) {
  const configFile = resolve(file);
  let values = Object.fromEntries(Object.entries(fields).map(([field, variable]) => [field,
    field === 'smtpPassword' ? (typeof env[variable] === 'string' ? env[variable] : '') : clean(env[variable])]));
  values.smtpPort ||= '465';
  let enabled = true;
  let readError = null;
  try {
    const stat = lstatSync(configFile);
    if (!stat.isFile() || stat.size > 16_384) throw new Error();
    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    if (saved?.version !== 1 || typeof saved.enabled !== 'boolean'
      || !saved.settings || typeof saved.settings !== 'object' || Array.isArray(saved.settings)) throw new Error();
    for (const field of Object.keys(fields)) {
      if (saved.settings[field] !== undefined && typeof saved.settings[field] !== 'string') throw new Error();
    }
    values = { ...values, ...Object.fromEntries(Object.keys(fields)
      .filter(field => saved.settings[field] !== undefined).map(field => [field, saved.settings[field]])) };
    enabled = saved.enabled;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      enabled = false;
      readError = '本机邮件配置无法读取，请重新保存配置。';
    }
  }

  function configEnv(data) {
    return Object.fromEntries(Object.entries(fields).map(([field, variable]) => [variable, data[field]]));
  }

  let activeMailer = enabled ? createResetMailer(configEnv(values)) : disabledMailer(readError || '邮件找回已停用。');

  function publicView() {
    const { smtpPassword, ...publicValues } = values;
    return { ...publicValues, hasPassword: Boolean(smtpPassword), enabled,
      configured: activeMailer.configured, configurationError: activeMailer.configurationError };
  }

  function persist(data, nextEnabled) {
    const temporary = configFile + '.' + randomBytes(10).toString('hex') + '.tmp';
    let descriptor;
    try {
      mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ version: 1, enabled: nextEnabled, settings: data }, null, 2) + '\n');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, configFile);
    } catch {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
      try { unlinkSync(temporary); } catch {}
      fail('邮件配置无法保存，请检查本机配置目录的写入权限。', 500);
    }
  }

  return {
    mailer: () => activeMailer,
    publicView,

    save(input = {}) {
      const next = Object.fromEntries(Object.keys(fields).map(field => [field,
        field === 'smtpPassword' ? (typeof input[field] === 'string' && input[field] !== '' ? input[field] : values[field])
          : clean(input[field])]));
      next.smtpPort ||= '465';
      if (Object.values(next).some(value => value.length > 2_048)) fail('邮件配置内容过长，请检查后重试。');
      const candidate = createResetMailer(configEnv(next));
      if (!candidate.configured) fail(candidate.configurationError);
      persist(next, true);
      values = next;
      enabled = true;
      activeMailer = candidate;
      return publicView();
    },

    disable() {
      persist(values, false);
      enabled = false;
      activeMailer = disabledMailer('邮件找回已停用。');
      return publicView();
    }
  };
}
