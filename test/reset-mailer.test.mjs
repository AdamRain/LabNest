import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResetMailer } from '../src/reset-mailer.mjs';
import { openMailSettings } from '../src/mail-settings.mjs';

function mailEnvironment(extra = {}) {
  return {
    LAB_PUBLIC_URL: 'https://lab.example',
    LAB_SMTP_HOST: 'smtp.example',
    LAB_SMTP_USER: 'sender@example.com',
    LAB_SMTP_PASSWORD: 'test-only-secret',
    ...extra
  };
}

function isolatedSettings(t, env = mailEnvironment()) {
  const folder = mkdtempSync(join(tmpdir(), 'lab-mail-settings-test.'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'config.json');
  return { folder, file, env, settings: openMailSettings({ file, env }) };
}

function formFields(extra = {}) {
  return {
    smtpHost: 'smtp.local.example', smtpPort: '587', smtpUser: 'mailer@example.com',
    smtpPassword: 'saved-test-secret', smtpFrom: 'mailer@example.com', publicUrl: 'https://lab.example',
    ...extra
  };
}

describe('SMTP transport TLS and trusted origins', () => {
  test('465 uses direct TLS and 587 requires STARTTLS with certificate validation', () => {
    for (const port of ['465', '587']) {
      let options;
      const mailer = createResetMailer(mailEnvironment({ LAB_SMTP_PORT: port }), {
        createTransport(value) { options = value; return { sendMail() { assert.fail('No SMTP send expected'); } }; }
      });
      assert.equal(mailer.configured, true);
      assert.equal(options.port, Number(port));
      assert.equal(options.secure, port === '465');
      assert.equal(options.requireTLS, port === '587');
      assert.equal(options.tls.rejectUnauthorized, true);
      assert.equal(options.logger, false);
      assert.equal(options.debug, false);
      assert.equal(options.disableFileAccess, true);
      assert.equal(options.disableUrlAccess, true);
      assert.equal(options.connectionTimeout, 10_000);
    }
  });

  test('email content is escaped and delivery must accept the intended recipient', async () => {
    let message;
    const mailer = createResetMailer(mailEnvironment(), {
      createTransport: () => ({ async sendMail(value) { message = value; return { accepted: [value.to.address] }; } })
    });
    const result = await mailer.sendPasswordReset({
      to: 'Student@Example.com', name: '<测试学生>', siteName: '测试 & 团队',
      resetUrl: 'https://lab.example/reset-password?token=test-only-token'
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(message.to.address, 'student@example.com');
    assert.equal(message.from.address, 'sender@example.com');
    assert.match(message.html, /&lt;测试学生&gt;/);
    assert.match(message.html, /测试 &amp; 团队/);
    assert.match(message.text, /15 分钟/);
    assert.match(message.text, /仅可使用一次/);
    assert.doesNotMatch(message.text, /test-only-secret/);
    assert.equal(message.disableFileAccess, true);
    assert.equal(message.disableUrlAccess, true);
  });

  test('invalid recipients and links outside the trusted origin never reach the transport', async () => {
    let sends = 0;
    const mailer = createResetMailer(mailEnvironment(), {
      createTransport: () => ({ async sendMail() { sends++; return { accepted: [] }; } })
    });
    for (const to of [
      'one@example.com,two@example.com', 'x\r\nBcc:other@example.com', '"name" <x@example.com>',
      'x@example.com/evil', 'x@-example.com', 'x@example..com'
    ]) {
      await assert.rejects(mailer.sendPasswordReset({ to, resetUrl: 'https://lab.example/reset-password?token=x' }), /暂时无法发送/);
    }
    for (const resetUrl of [
      'https://attacker.example/reset-password?token=x', 'https://user:pass@lab.example/reset-password',
      'https://lab.example/reset-password#token', 'javascript:alert(1)'
    ]) {
      await assert.rejects(mailer.sendPasswordReset({ to: 'student@example.com', resetUrl }), /暂时无法发送/);
    }
    assert.equal(sends, 0);
  });

  test('incomplete or unsafe configuration is disabled, with HTTP allowed only on loopback', async () => {
    let creations = 0;
    const injected = {
      createTransport() { creations++; return { sendMail() { assert.fail('No SMTP send expected'); } }; }
    };
    const missing = createResetMailer({}, injected);
    assert.equal(missing.configured, false);
    await assert.rejects(missing.sendPasswordReset({}), /暂未启用/);
    for (const value of [
      'http://lab.example', 'https://lab.example/base', 'https://lab.example?x=1',
      'https://lab.example/#token', 'https://user:pass@lab.example'
    ]) {
      assert.equal(createResetMailer(mailEnvironment({ LAB_PUBLIC_URL: value }), injected).configured, false);
    }
    for (const extra of [
      { LAB_SMTP_PORT: '25' }, { LAB_SMTP_HOST: 'smtp.example/extra' }, { LAB_SMTP_HOST: 'bad\r\nhost' },
      { LAB_SMTP_FROM: 'Sender <sender@example.com>' }, { LAB_SMTP_FROM: 'sender@example.com,other@example.com' },
      { LAB_SMTP_USER: 'bad\r\nuser' }
    ]) {
      assert.equal(createResetMailer(mailEnvironment(extra), injected).configured, false);
    }
    assert.equal(creations, 0);
    for (const value of ['http://127.0.0.1:4173', 'http://127.0.0.2:4174', 'http://localhost:4173', 'http://[::1]:4173']) {
      const mailer = createResetMailer(mailEnvironment({ LAB_PUBLIC_URL: value }), injected);
      assert.equal(mailer.configured, true);
      assert.equal(mailer.publicOrigin, value);
    }
  });

  test('delivery failure never exposes SMTP credentials or claims a rejected recipient succeeded', async () => {
    const parameters = { to: 'student@example.com', resetUrl: 'https://lab.example/reset-password' };
    const rejected = createResetMailer(mailEnvironment(), {
      createTransport: () => ({ async sendMail() { return { accepted: [] }; } })
    });
    await assert.rejects(rejected.sendPasswordReset(parameters), /暂时无法发送/);
    const failed = createResetMailer(mailEnvironment(), {
      createTransport: () => ({ async sendMail() { throw new Error('SMTP error test-only-secret'); } })
    });
    await assert.rejects(failed.sendPasswordReset(parameters), error => {
      assert.doesNotMatch(error.message, /test-only-secret/);
      assert.equal(error.cause, undefined);
      assert.equal(error.code, 'RESET_MAIL_FAILED');
      return true;
    });
  });
});

describe('mail settings and secret storage', () => {
  test('public settings omit the secret and saved files are private without leftover temporary files', t => {
    const { folder, file, settings } = isolatedSettings(t);
    assert.equal(settings.publicView().hasPassword, true);
    assert.ok(!Object.hasOwn(settings.publicView(), 'smtpPassword'));
    assert.doesNotMatch(JSON.stringify(settings.publicView()), /test-only-secret/);
    settings.save(formFields());
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(folder), ['config.json']);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).settings.smtpPassword, 'saved-test-secret');
    assert.doesNotMatch(JSON.stringify(settings.publicView()), /saved-test-secret/);
  });

  test('blank passwords retain the existing secret, and invalid saves preserve the working configuration', t => {
    const { file, env, settings } = isolatedSettings(t);
    settings.save(formFields({ smtpPassword: '' }));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).settings.smtpPassword, env.LAB_SMTP_PASSWORD);
    settings.save(formFields());
    settings.save(formFields({ smtpPassword: '', smtpHost: 'smtp.new.example' }));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).settings.smtpPassword, 'saved-test-secret');
    const previousFile = readFileSync(file, 'utf8');
    assert.throws(() => settings.save(formFields({ publicUrl: 'http://public.example' })), error => error.statusCode === 400);
    assert.equal(readFileSync(file, 'utf8'), previousFile);
    assert.equal(settings.publicView().smtpHost, 'smtp.new.example');
    assert.equal(settings.mailer().configured, true);
  });

  test('disable survives reload and retains fields for later reactivation without sending mail', async t => {
    const { file, env, settings } = isolatedSettings(t);
    settings.save(formFields());
    settings.disable();
    assert.equal(settings.mailer().configured, false);
    await assert.rejects(settings.mailer().sendPasswordReset({}), /暂未启用/);
    const reloaded = openMailSettings({ file, env });
    assert.equal(reloaded.publicView().enabled, false);
    assert.equal(reloaded.publicView().hasPassword, true);
    assert.equal(reloaded.mailer().configured, false);
    reloaded.save(formFields({ smtpPassword: '' }));
    assert.equal(reloaded.mailer().configured, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).settings.smtpPassword, 'saved-test-secret');
  });

  test('a corrupt local configuration fails closed instead of enabling environment fallback', t => {
    const { file, env } = isolatedSettings(t);
    writeFileSync(file, '{broken-json-with-secret');
    const settings = openMailSettings({ file, env });
    assert.equal(settings.mailer().configured, false);
    assert.equal(settings.publicView().enabled, false);
    assert.match(settings.publicView().configurationError, /无法读取/);
    assert.doesNotMatch(JSON.stringify(settings.publicView()), /test-only-secret|broken-json-with-secret/);
  });
});
