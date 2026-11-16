import { createHash } from 'node:crypto';

const minute = 60_000;
const defaults = {
  loginAccountLimit: 10, loginIpLimit: 120, loginGlobalLimit: 600, loginWindowMs: 15 * minute,
  registrationIpLimit: 30, registrationEmailLimit: 5, registrationGlobalLimit: 100,
  registrationWindowMs: 60 * minute, maxPendingStudents: 100,
  recoveryIpLimit: 5, recoveryWindowMs: 15 * minute, maxBuckets: 10_000
};

function rejection(message, statusCode, retryAfter = 1, code) {
  return Object.assign(new Error(message), { statusCode, retryAfter: Math.max(1, Math.ceil(retryAfter)), ...(code ? { code } : {}) });
}

// Admission happens before scrypt. Bounded queues prevent request floods from growing the libuv work queue.
export function createPasswordHashBudget({ concurrency = 2, maxQueue = 16, waitMs = 2000 } = {}) {
  if (![concurrency, maxQueue, waitMs].every(Number.isSafeInteger) || concurrency < 1 || maxQueue < 0 || waitMs < 1) {
    throw new TypeError('Invalid password hash budget');
  }
  let active = 0;
  const queue = [];
  const busy = () => rejection('当前登录或注册请求较多，请稍后重试。', 503, 2, 'AUTH_CAPACITY');
  function release() {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(release);
    } else active--;
  }
  function acquire() {
    if (active < concurrency) { active++; return Promise.resolve(release); }
    if (queue.length >= maxQueue) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        reject(busy());
      }, waitMs);
      queue.push(entry);
    });
  }
  return {
    async run(operation) {
      const done = await acquire();
      try { return await operation(); } finally { done(); }
    },
    snapshot: () => ({ active, queued: queue.length })
  };
}

export const passwordHashBudget = createPasswordHashBudget();

export function openAuthAbuse({ db, now = Date.now, ...overrides }) {
  const policy = { ...defaults, ...overrides };
  for (const key of Object.keys(defaults)) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new TypeError(`Invalid auth policy: ${key}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry ON auth_rate_limits(expires_at);`);
  const read = db.prepare('SELECT attempts, expires_at FROM auth_rate_limits WHERE bucket=?');
  const write = db.prepare(`INSERT INTO auth_rate_limits(bucket,attempts,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1`);
  const expire = db.prepare('DELETE FROM auth_rate_limits WHERE expires_at<=?');
  const count = db.prepare('SELECT count(*) AS total FROM auth_rate_limits');
  const pending = db.prepare("SELECT count(*) AS total FROM accounts WHERE role IN ('student','teacher') AND review_status='pending' AND disabled=0");
  const remove = db.prepare('DELETE FROM auth_rate_limits WHERE bucket=?');
  const bucketKey = (scope, value) => scope + ':' + createHash('sha256').update(String(value)).digest('hex');

  function consume(items, message) {
    const instant = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      expire.run(instant);
      const entries = items.map(([scope, value, limit, window]) => {
        const key = bucketKey(scope, value), existing = read.get(key);
        if (existing?.attempts >= limit) throw rejection(message, 429, (existing.expires_at - instant) / 1000);
        return { key, existing, expiresAt: instant + window };
      });
      if (count.get().total + entries.filter(entry => !entry.existing).length > policy.maxBuckets) {
        throw rejection('当前请求较多，请稍后重试。', 503, 2, 'AUTH_CAPACITY');
      }
      for (const entry of entries) write.run(entry.key, entry.existing?.expires_at ?? entry.expiresAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    policy,
    login(ip, target) {
      consume([
        ['login.ip', ip, policy.loginIpLimit, policy.loginWindowMs],
        ['login.account', target, policy.loginAccountLimit, policy.loginWindowMs],
        ['login.global', 'all', policy.loginGlobalLimit, policy.loginWindowMs]
      ], '登录尝试过多，请稍后再试。');
    },
    loginSucceeded(target) {
      // A self-owned account must never erase another target's or the shared IP's guess budget.
      remove.run(bucketKey('login.account', target));
    },
    register(ip, email) {
      consume([
        ['register.ip', ip, policy.registrationIpLimit, policy.registrationWindowMs],
        ['register.email', String(email ?? '').trim().toLowerCase(), policy.registrationEmailLimit, policy.registrationWindowMs],
        ['register.global', 'all', policy.registrationGlobalLimit, policy.registrationWindowMs]
      ], '注册申请过于频繁，请稍后再试。');
      if (pending.get().total >= policy.maxPendingStudents) {
        throw rejection('当前待审核申请较多，请联系教师处理后再申请。', 503, 60, 'AUTH_CAPACITY');
      }
    },
    recover(ip) {
      consume([['recovery.ip', ip, policy.recoveryIpLimit, policy.recoveryWindowMs]], '申请过于频繁，请稍后再试。');
    }
  };
}
