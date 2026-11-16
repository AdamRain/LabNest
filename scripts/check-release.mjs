import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a publication hygiene check, not a complete security audit.
// Default mode skips local runtime artifacts. Strict mode checks an unpacked archive.
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const supplied = args.filter(value => value !== '--strict');
if (supplied.length > 1 || supplied.some(value => value.startsWith('--'))) {
  console.error('用法：node scripts/check-release.mjs [--strict] [待检查目录]');
  process.exit(2);
}
const root = resolve(supplied[0] || dirname(fileURLToPath(new URL('../package.json', import.meta.url))));
const generated = new Set(['node_modules', '.git', 'data', '.runtime', 'dist', 'tmp', 'coverage', 'backups', 'release']);
const textExtensions = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.example', '.svg', '.css', '.sh', '.command', '.service', '.license', '.pem', '.key', '.crt', '.cer', '.log']);
const findings = [];
const skipped = [];
let checkedFiles = 0;
const report = (file, rule, line) => findings.push({ file, rule, ...(line ? { line } : {}) });
const lineOf = (text, position) => text.slice(0, position).split('\n').length;
const testFile = file => file.startsWith('test/');
const publicDemo = file => /^(?:fixtures\/demo[^/]*\.json|scripts\/(?:seed-demo|demo)[^/]*\.mjs|README(?:\.[a-zA-Z-]+)?\.md|docs\/[^/]+\.md)$/.test(file);
const thirdPartyNotice = file => file.startsWith('src/fonts/Fandol-') || file === 'public/vendor/preline-collapse.LICENSE';
const reservedEmail = value => {
  const domain = value.toLowerCase().split('@')[1] || '';
  return /(?:^|\.)(?:example|test|invalid|localhost)$/.test(domain)
    || /^(?:[a-z0-9.-]+\.)?example\.(?:com|org|net)$/.test(domain)
    || domain === 'users.noreply.github.com';
};
const secretPatterns = [
  ['private-key-content', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['api-secret-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g],
  ['stored-password-hash', /\bscrypt\$[a-f0-9]{32}\$[a-f0-9]{128}\b/gi],
  ['stored-account-password-hash', /\b[a-f0-9]{32}:[a-f0-9]{128}\b/gi],
  ['personal-device-name', /\brui-(?:mac|lab)(?:-pc)?\b/gi],
  ['personal-absolute-path', /\/(?:Users|home)\/(?!lab(?:app)?(?:\/|\b)|app(?:\/|\b)|example(?:\/|\b)|user(?:\/|\b))[A-Za-z0-9._-]+\//g]
];

function inspect(file, bytes) {
  checkedFiles++;
  if (bytes.subarray(0, 16).toString() === 'SQLite format 3\0') report(file, 'database-content');
  const name = basename(file);
  if (/^\.env(?:\.|$)/.test(name) && name !== '.env.example') report(file, 'private-environment-file');
  if (/\.(?:sqlite3?(?:-(?:shm|wal))?|db3?|pem|key|p12|pfx|jks|crt|cer|log|bak|dump|zip|tar|tgz|gz|7z)$/i.test(name)
    || name === '.DS_Store' || /(?:^|[-_.])(?:credentials|secrets?)(?:[-_.]|$)/i.test(name) && !publicDemo(file)) {
    report(file, 'private-or-generated-file');
  }
  const isText = textExtensions.has(extname(file).toLowerCase()) || name.startsWith('.')
    || /^(?:LICENSE|NOTICE|Caddyfile)/.test(name);
  const plainAscii = bytes.length > 0 && bytes.every(byte => byte === 9 || byte === 10 || byte === 13 || byte >= 32 && byte <= 126);
  if ((!isText && !plainAscii) || bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  for (const [rule, expression] of secretPatterns) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) report(file, rule, lineOf(text, match.index));
  }
  if (!testFile(file) && !thirdPartyNotice(file)) {
    for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      if (!reservedEmail(match[0])) report(file, 'non-example-contact-email', lineOf(text, match.index));
    }
    for (const match of text.matchAll(/\b1[3-9][0-9]{9}\b/g)) {
      if (!(publicDemo(file) && /^199000[0-9]{5}$/.test(match[0]))) report(file, 'phone-number-needs-review', lineOf(text, match.index));
    }
    // Public documentation may use generic private addresses. Actual deployment
    // addresses do not belong in published configuration or documentation.
    if (file !== 'src/conference-feed.mjs') {
      for (const match of text.matchAll(/\b(?:10(?:\.[0-9]{1,3}){3}|192\.168(?:\.[0-9]{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]{1,3}){2})\b/g)) {
        if (!/^(?:10\.0\.0\.(?:0|10|11|20)|192\.168\.1\.(?:0|1|10))$/.test(match[0])) {
          report(file, 'private-deployment-address-needs-review', lineOf(text, match.index));
        }
      }
    }
  }
  if (!testFile(file)) {
    const credentials = /(?:\b(?:password|smtpPassword|[A-Z][A-Z_]*PASSWORD)|["'](?:password|smtpPassword|[A-Z][A-Z_]*PASSWORD)["'])\s*[:=]\s*(['"])([^'"\r\n]{8,})\1/g;
    for (const match of text.matchAll(credentials)) {
      const documentedDemo = publicDemo(file) && match[2] === 'DemoOnly!2026';
      if (!/^LAB_[A-Z_]+$/.test(match[2]) && !documentedDemo) report(file, 'literal-password-outside-demo', lineOf(text, match.index));
    }
  }
  if (name === '.env.example') {
    for (const match of text.matchAll(/^[ \t]*LAB_SMTP_PASSWORD[ \t]*=[ \t]*[^\s\r\n][^\r\n]*$/gm)) report(file, 'configured-mail-secret', lineOf(text, match.index));
  }
}

function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    const file = relative(root, path).split(sep).join('/');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      report(file, 'symbolic-link-not-allowed');
    } else if (stat.isDirectory()) {
      if (generated.has(name)) {
        if (strict) report(file + '/', 'runtime-directory-in-release');
        else skipped.push(file + '/');
      } else walk(path);
    } else if (stat.isFile()) inspect(file, readFileSync(path));
  }
}

try { walk(root); }
catch (error) { console.error('无法完成发布检查：' + error.message); process.exit(2); }
findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0) || a.rule.localeCompare(b.rule));
console.log(JSON.stringify({ target: basename(root), mode: strict ? 'strict archive' : 'source', checkedFiles,
  skipped, passed: findings.length === 0, findings }, null, 2));
if (findings.length) process.exitCode = 1;
