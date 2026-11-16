import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const checker = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'labmanager-publication-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function check(root, ...options) {
  const result = spawnSync(process.execPath, [checker, ...options, root], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test('发布检查保留示例配置、公开演示凭据与测试假值，不打印内容', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'fixtures'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, '.env.example'), 'LAB_SMTP_PASSWORD=\n# Fill in locally.\n');
  writeFileSync(join(root, 'fixtures', 'demo-users.json'), JSON.stringify({ email: 'student@demo.example.test', password: 'DemoOnly!2026', phone: '19900000001' }));
  writeFileSync(join(root, 'test', 'sample.test.mjs'), "const password = 'Test-only-password-42';");
  const { status, report } = check(root, '--strict');
  assert.equal(status, 0);
  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.checkedFiles, 3);
  assert.ok(!JSON.stringify(report).includes('DemoOnly!2026'));
});

test('发布检查拒绝私有配置、数据库、密钥与运行目录；source模式明确跳过生成目录', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'demo.sqlite'), 'SQLite format 3\0');
  writeFileSync(join(root, '.env'), 'LAB_SMTP_PASSWORD=not-a-real-secret');
  writeFileSync(join(root, 'private.key'), ['-----BEGIN ', 'PRIVATE KEY-----\nnot-a-real-key'].join(''));
  writeFileSync(join(root, 'asset.png'), ['-----BEGIN ', 'PRIVATE KEY-----\nnot-a-real-key'].join(''));
  const strict = check(root, '--strict');
  assert.equal(strict.status, 1);
  const rules = new Set(strict.report.findings.map(item => item.rule));
  assert.ok(rules.has('runtime-directory-in-release'));
  assert.ok(rules.has('private-environment-file'));
  assert.ok(rules.has('private-or-generated-file'));
  assert.ok(rules.has('private-key-content'));
  assert.ok(strict.report.findings.some(item => item.file === 'asset.png' && item.rule === 'private-key-content'));
  const source = check(root);
  assert.ok(source.report.skipped.includes('data/'));
  assert.ok(!JSON.stringify(strict.report).includes('not-a-real-secret'));
  assert.ok(!JSON.stringify(strict.report).includes('not-a-real-key'));
});

test('公开演示例外不绕过真实令牌、联系信息或运行源文件里的字面密码检查', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'fixtures'));
  const contact = ['owner', 'private-university.edu'].join('@');
  const privateAddress = [10, 24, 56, 78].join('.');
  const privatePath = ['', 'Users', 'sample-owner', 'workspace', ''].join('/');
  const accessToken = 'ghp_' + 'A'.repeat(36);
  const passwordHash = 'a'.repeat(32) + ':' + 'b'.repeat(128);
  writeFileSync(join(root, 'README.md'), [contact, privateAddress, privatePath, accessToken, passwordHash].join('\n'));
  writeFileSync(join(root, 'src', 'config.mjs'), "const password = 'not-a-real-password';");
  writeFileSync(join(root, 'fixtures', 'demo-users.json'), JSON.stringify({ password: 'an-undocumented-test-value' }));
  const { status, report } = check(root, '--strict');
  assert.equal(status, 1);
  const rules = new Set(report.findings.map(item => item.rule));
  for (const rule of ['non-example-contact-email', 'private-deployment-address-needs-review', 'personal-absolute-path', 'github-token', 'literal-password-outside-demo', 'stored-account-password-hash']) {
    assert.ok(rules.has(rule), rule);
  }
  assert.ok(report.findings.every(item => !item.file.startsWith(root)));
  assert.ok(report.findings.some(item => item.file === 'fixtures/demo-users.json' && item.rule === 'literal-password-outside-demo'));
  for (const value of [contact, privateAddress, privatePath, accessToken, passwordHash]) assert.ok(!JSON.stringify(report).includes(value));
});
