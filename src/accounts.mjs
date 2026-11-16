import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { passwordHashBudget } from './auth-abuse.mjs';

const deriveKey = promisify(scrypt);
const sessionLifetime = 24 * 60 * 60 * 1000;
const resetLifetime = 15 * 60 * 1000;
const resetCooldown = 60 * 1000;
const resetRequestWindow = 60 * 60 * 1000;
const fallbackSalt = randomBytes(16).toString('hex');
const fallbackKey = Buffer.alloc(64);
const studentStates = ['active', 'admitted', 'graduated'];
const studentLevels = ['undergraduate', 'graduate'];
const relationships = ['direct', 'assisted'];
const columns = `
  id, role, name, email, phone, level, major, advisor, birthday, relationship,
  student_status AS studentStatus, student_number AS studentNumber,
  review_status AS reviewStatus, review_reason AS reviewReason, activities,
  primary_teacher_id AS primaryTeacherId, secondary_teacher_id AS secondaryTeacherId, disabled,
  (SELECT name FROM accounts AS supervisor WHERE supervisor.id=accounts.primary_teacher_id) AS primaryTeacherName,
  (SELECT name FROM accounts AS supervisor WHERE supervisor.id=accounts.secondary_teacher_id) AS secondaryTeacherName,
  created_at AS createdAt, updated_at AS updatedAt
`;

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function field(value, label, limit, required = false) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) fail(`请填写${label}。`);
  if (result.length > limit) fail(`${label}最多填写 ${limit} 个字符。`);
  return result || null;
}

function choice(value, choices, label) {
  if (!choices.includes(value)) fail(`请选择有效的${label}。`);
  return value;
}

function normalizedEmail(value) {
  return value?.trim().toLowerCase() || null;
}

function normalizedPhone(value) {
  const phone = value?.replace(/[\s()-]/g, '').replace(/^00/, '+') || null;
  if (/^\+861[0-9]{10}$/.test(phone)) return phone.slice(3);
  return phone;
}

function contacts(input, { requireEmail = false } = {}) {
  const email = normalizedEmail(field(input.email, '邮箱', 254));
  const phone = normalizedPhone(field(input.phone, '手机号', 30));
  if (requireEmail && !email) fail('请填写邮箱，用于登录和找回密码。');
  if (!email && !phone) fail('请至少填写邮箱或手机号。');
  if (email && !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(email)) fail('邮箱格式有误。');
  if (phone && !/^\+?[0-9]{7,15}$/.test(phone)) fail('手机号格式有误。');
  return { email, phone };
}

function checkedStudentNumber(value, level, studentStatus, options) {
  const studentNumber = field(value, '学号', 32, studentStatus === 'active');
  const expectedLength = level === 'undergraduate' ? options.undergradIdLength : options.gradIdLength;
  if (studentNumber && expectedLength && studentNumber.length !== expectedLength) {
    fail(`学号须为 ${expectedLength} 个字符。`);
  }
  return studentNumber;
}

function application(input, options) {
  const name = field(input.name, '姓名', 80, true);
  const level = choice(input.level, studentLevels, '学习层次');
  const studentStatus = choice(input.studentStatus, studentStates, '学籍状态');
  const relationship = choice(input.relationship, relationships, '指导关系');
  const studentNumber = checkedStudentNumber(input.studentNumber, level, studentStatus, options);
  const major = field(input.major, '专业', 100, true);
  const advisor = relationship === 'assisted' ? field(input.advisor, '导师姓名', 100, true) : null;
  const values = [input.activities].flat().filter(value => typeof value === 'string' && value.trim());
  if (values.length > 12) fail('参与事项最多选择 12 项。');
  const activities = JSON.stringify([...new Set(values.map(value => field(value, '参与事项', 40)))]);
  return { name, ...contacts(input, { requireEmail: true }), level, studentStatus, relationship, studentNumber, major, advisor, activities };
}

function registrationSnapshot(student) {
  const keys = ['name', 'email', 'phone', 'level', 'studentStatus', 'studentNumber', 'major', 'relationship', 'advisor'];
  return { ...Object.fromEntries(keys.map(key => [key, student[key] ?? null])),
    activities: [...(Array.isArray(student.activities) ? student.activities : JSON.parse(student.activities))].sort() };
}

function passwordIsValid(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

async function passwordDigest(password) {
  if (!passwordIsValid(password)) fail('密码须为 8 至 128 个字符。');
  const salt = randomBytes(16).toString('hex');
  const key = await passwordHashBudget.run(() => deriveKey(password, salt, 64));
  return `${salt}:${key.toString('hex')}`;
}

function publicUser(row) {
  return row ? { ...row, disabled: Boolean(row.disabled), activities: JSON.parse(row.activities) } : null;
}

function accountTable(name = 'accounts') {
  return `CREATE TABLE ${name} (
    id INTEGER PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
    name TEXT NOT NULL, email TEXT UNIQUE, phone TEXT UNIQUE, password_hash TEXT NOT NULL,
    level TEXT, student_status TEXT, relationship TEXT, student_number TEXT, major TEXT, advisor TEXT, birthday TEXT,
    activities TEXT NOT NULL DEFAULT '[]',
    review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected')),
    review_reason TEXT,
    primary_teacher_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
    secondary_teacher_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (role <> 'student' OR primary_teacher_id IS NOT NULL),
    CHECK (secondary_teacher_id IS NULL OR secondary_teacher_id <> primary_teacher_id)
  )`;
}

function migrateAccounts(db) {
  const existing = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='accounts'").get();
  if (!existing) { db.exec(accountTable()); return; }
  const columns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(column => column.name));
  if (existing.sql.includes("'admin'") && columns.has('primary_teacher_id') && columns.has('disabled')) {
    db.exec('DROP INDEX IF EXISTS accounts_one_teacher');
    return;
  }
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  const indexes = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='accounts' AND sql IS NOT NULL AND name <> 'accounts_one_teacher'").all();
  const teacher = db.prepare("SELECT id FROM accounts WHERE role='teacher' AND review_status='approved' ORDER BY id LIMIT 1").get();
  if (!teacher && db.prepare("SELECT 1 FROM accounts WHERE role='student' LIMIT 1").get()) {
    fail('已有学生缺少主指导教师，账号升级已停止，请先恢复原教师账号。', 409);
  }
  db.exec('PRAGMA foreign_keys=OFF');
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys) throw new Error('账号迁移须在独立事务中执行。');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(accountTable('accounts_v2'));
    const oldNames = [...columns].map(name => '"' + name.replaceAll('"', '""') + '"');
    const additional = [];
    if (!columns.has('primary_teacher_id')) additional.push(['primary_teacher_id', `CASE WHEN role='student' THEN ${teacher?.id ?? 'NULL'} ELSE NULL END`]);
    if (!columns.has('secondary_teacher_id')) additional.push(['secondary_teacher_id', 'NULL']);
    if (!columns.has('disabled')) additional.push(['disabled', '0']);
    db.exec(`INSERT INTO accounts_v2 (${[...oldNames, ...additional.map(([name]) => name)].join(',')})
      SELECT ${[...oldNames, ...additional.map(([, value]) => value)].join(',')} FROM accounts`);
    // Do not rename the original table: its child-table foreign keys must keep referencing accounts.
    db.exec('DROP TABLE accounts; ALTER TABLE accounts_v2 RENAME TO accounts');
    for (const { sql } of indexes) db.exec(sql);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('账号升级的关联记录检查失败。');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex');
}

function isSessionToken(token) {
  return typeof token === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(token);
}

function validBirthday(value) {
  const birthday = field(value, '出生日期', 10);
  if (!birthday) return null;
  const date = new Date(birthday);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== birthday || date > new Date()) {
    fail('请填写有效的出生日期。');
  }
  return birthday;
}

function explainUniqueViolation(error) {
  if (error.errcode === 2067 && /accounts\.email/.test(error.message)) fail('该邮箱已关联其他账号。', 409);
  if (error.errcode === 2067 && /accounts\.phone/.test(error.message)) fail('该手机号已关联其他账号。', 409);
  if (error.errcode === 2067 && /accounts\.role/.test(error.message)) fail('教师账号已创建。', 409);
  throw error;
}

export function openAccounts(db, options = {}) {
  migrateAccounts(db);
  db.exec(`
    DROP INDEX IF EXISTS accounts_one_teacher;
    CREATE INDEX IF NOT EXISTS accounts_primary_teacher ON accounts(primary_teacher_id);
    CREATE INDEX IF NOT EXISTS accounts_secondary_teacher ON accounts(secondary_teacher_id);
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user ON password_reset_tokens(user_id);
    CREATE TABLE IF NOT EXISTS password_reset_requests (
      user_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS password_reset_requests_user_time ON password_reset_requests(user_id, created_at);
    CREATE TABLE IF NOT EXISTS account_audit (
      id INTEGER PRIMARY KEY,
      actor_id INTEGER NOT NULL REFERENCES accounts(id),
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      action TEXT NOT NULL,
      previous_value TEXT NOT NULL,
      new_value TEXT NOT NULL,
      reason TEXT,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const selectById = db.prepare(`SELECT ${columns} FROM accounts WHERE id = ?`);
  const selectAllUsers = db.prepare(`SELECT ${columns} FROM accounts ORDER BY disabled, CASE review_status WHEN 'pending' THEN 0 ELSE 1 END, id DESC`);
  const selectTeachers = db.prepare(`SELECT ${columns} FROM accounts WHERE role='teacher' AND disabled=0 ORDER BY name,id`);
  const selectStudents = db.prepare(`SELECT ${columns} FROM accounts WHERE role = 'student' AND disabled=0 ORDER BY id DESC`);
  const pendingStudents = db.prepare("SELECT count(*) AS total FROM accounts WHERE role='student' AND review_status='pending' AND disabled=0");
  const selectByEmail = db.prepare('SELECT id, password_hash FROM accounts WHERE email = ? AND disabled=0');
  const selectByPhone = db.prepare('SELECT id, password_hash FROM accounts WHERE phone = ? AND disabled=0');
  const selectSession = db.prepare('SELECT user_id FROM account_sessions WHERE token_hash = ? AND expires_at > ?');
  const insertSession = db.prepare('INSERT INTO account_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
  const removeSession = db.prepare('DELETE FROM account_sessions WHERE token_hash = ?');
  const removeExpired = db.prepare('DELETE FROM account_sessions WHERE expires_at <= ?');
  const removeUserSessions = db.prepare('DELETE FROM account_sessions WHERE user_id = ?');
  const insertReset = db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?)');
  const selectReset = db.prepare(`
    SELECT reset.user_id FROM password_reset_tokens AS reset
    JOIN accounts ON accounts.id = reset.user_id AND accounts.email = reset.email AND accounts.disabled=0
    WHERE reset.token_hash = ? AND reset.expires_at > ?
  `);
  const removeReset = db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?');
  const removeUserResets = db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?');
  const removeExpiredResets = db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?');
  const recordResetRequest = db.prepare('INSERT INTO password_reset_requests (user_id, created_at) VALUES (?, ?)');
  const removeOldResetRequests = db.prepare('DELETE FROM password_reset_requests WHERE created_at <= ?');
  const recentResetRequests = db.prepare('SELECT count(*) AS count, max(created_at) AS latest FROM password_reset_requests WHERE user_id = ? AND created_at > ?');
  const changePassword = db.prepare('UPDATE accounts SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const audit = db.prepare(`
    INSERT INTO account_audit (actor_id, student_id, action, previous_value, new_value, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertTeacher = db.prepare(`
    INSERT INTO accounts (role, name, email, password_hash, review_status)
    VALUES ('teacher', ?, ?, ?, 'approved')
  `);
  const insertTeacherApplication = db.prepare(`
    INSERT INTO accounts (role, name, email, phone, password_hash, review_status)
    VALUES ('teacher', ?, ?, ?, ?, 'pending')
  `);
  const insertAdmin = db.prepare(`
    INSERT INTO accounts (role, name, email, password_hash, review_status)
    VALUES ('admin', ?, ?, ?, 'approved')
  `);
  const changeTeachers = db.prepare(`UPDATE accounts SET primary_teacher_id=?, secondary_teacher_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
  const changeEnabled = db.prepare(`UPDATE accounts SET disabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
  const supervising = db.prepare(`SELECT count(*) AS total FROM accounts WHERE role='student' AND (primary_teacher_id=? OR secondary_teacher_id=?)`);
  const insertStudent = db.prepare(`
    INSERT INTO accounts (
      role, name, email, phone, level, student_status, relationship, student_number, major, advisor, activities,
      password_hash, review_status, primary_teacher_id, secondary_teacher_id
    )
    VALUES (
      'student', :name, :email, :phone, :level, :studentStatus, :relationship, :studentNumber, :major, :advisor,
      :activities, :passwordHash, 'pending', :primaryTeacherId, :secondaryTeacherId
    )
  `);
  const resubmitStudent = db.prepare(`
    UPDATE accounts SET
      name = :name, email = :email, phone = :phone, level = :level, student_status = :studentStatus,
      relationship = :relationship, student_number = :studentNumber, major = :major, advisor = :advisor,
      activities = :activities, review_status = 'pending', review_reason = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = :id
  `);
  const changeReview = db.prepare(`
    UPDATE accounts SET review_status = ?, review_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  const changeStatus = db.prepare(`
    UPDATE accounts SET student_status = ?, student_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  const changeBirthday = db.prepare(`
    UPDATE accounts SET birthday = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  const pendingProfileChanges = db.prepare(`
    SELECT audit.student_id, audit.previous_value, audit.new_value FROM account_audit AS audit
    JOIN accounts ON accounts.id = audit.student_id
    WHERE accounts.review_status = 'pending' AND audit.action = 'profile_revision'
      AND audit.id = (SELECT max(latest.id) FROM account_audit AS latest
        WHERE latest.student_id = audit.student_id AND latest.action = 'profile_revision')
  `);

  function getUser(id) {
    if (typeof id !== 'number' && typeof id !== 'bigint' && !(typeof id === 'string' && /^[1-9][0-9]*$/.test(id))) return null;
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) return null;
    return publicUser(selectById.get(id));
  }

  function requireStudent(id) {
    const user = getUser(id);
    if (user?.role !== 'student' || user.disabled) fail('未找到该学生。', 404);
    return user;
  }

  function requireTeacher(id) {
    const actor = getUser(typeof id === 'object' && id ? id.id : id);
    if (!actor || actor.disabled || actor.reviewStatus !== 'approved' || !['teacher', 'admin'].includes(actor.role)) {
      fail('当前账号没有此操作的权限。', 403);
    }
    return actor;
  }

  function requireAdmin(id) {
    const actor = requireTeacher(id);
    if (actor.role !== 'admin') fail('仅管理员可以执行此操作。', 403);
    return actor;
  }

  function listTeachers({ approvedOnly = true } = {}) {
    return selectTeachers.all().map(publicUser).filter(teacher => !approvedOnly || teacher.reviewStatus === 'approved');
  }

  function supervisorIds(input, { allowDefault = false } = {}) {
    const teachers = listTeachers();
    let primary = input.primaryTeacherId;
    if ((primary === undefined || primary === null || primary === '') && allowDefault && teachers.length === 1) primary = teachers[0].id;
    const parse = (value, label, required) => {
      if ((value === undefined || value === null || value === '') && !required) return null;
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id < 1 || !teachers.some(teacher => teacher.id === id)) {
        fail(`请选择有效的${label}。`);
      }
      return id;
    };
    const primaryTeacherId = parse(primary, '主指导教师', true);
    const secondaryTeacherId = parse(input.secondaryTeacherId, '副指导教师', false);
    if (primaryTeacherId === secondaryTeacherId) fail('主指导教师与副指导教师不能是同一人。');
    return { primaryTeacherId, secondaryTeacherId };
  }

  function canManageStudent(actor, id) {
    const user = getUser(typeof actor === 'object' && actor ? actor.id : actor);
    const student = getUser(id);
    if (!user || user.disabled || user.reviewStatus !== 'approved' || student?.role !== 'student') return false;
    if (user.role === 'admin') return true;
    return user.role === 'teacher' && !student.disabled && [student.primaryTeacherId, student.secondaryTeacherId].includes(user.id);
  }

  function assertManageStudent(actor, id) {
    if (!canManageStudent(actor, id)) fail('当前账号没有该学生的管理权限。', 403);
    return getUser(id);
  }

  function teacherStudents(actor) {
    requireTeacher(actor);
    return selectStudents.all().map(publicUser).filter(student => canManageStudent(actor, student.id));
  }

  function setUserEnabled(actorId, id, enabled) {
    if (typeof enabled !== 'boolean') fail('请选择有效的账号状态。');
    return transaction(() => {
      const actor = requireAdmin(actorId);
      const user = getUser(id);
      if (!user) fail('未找到该账号。', 404);
      if (user.disabled === !enabled) return user;
      if (!enabled && user.role === 'admin' && db.prepare("SELECT count(*) AS total FROM accounts WHERE role='admin' AND disabled=0 AND review_status='approved'").get().total <= 1) {
        fail('至少须保留一名启用的管理员。', 409);
      }
      if (!enabled && actor.id === id) fail('不能停用当前登录的管理员账号。', 409);
      if (!enabled && user.role === 'teacher' && supervising.get(id, id).total) {
        fail('请先将该教师名下的主、副指导学生重新分配，再移除教师。', 409);
      }
      changeEnabled.run(enabled ? 0 : 1, id);
      removeUserSessions.run(id);
      removeUserResets.run(id);
      audit.run(actor.id, id, 'account_enabled', user.disabled ? 'disabled' : 'enabled', enabled ? 'enabled' : 'disabled', null);
      return getUser(id);
    });
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      return explainUniqueViolation(error);
    }
  }

  return {
    async createTeacher({ name, email, password }, { actorId } = {}) {
      if (actorId !== undefined) requireAdmin(actorId);
      const teacherName = field(name, '姓名', 80, true);
      const { email: teacherEmail } = contacts({ email }, { requireEmail: true });
      const hash = await passwordDigest(password);
      try {
        return transaction(() => {
          if (actorId !== undefined) requireAdmin(actorId);
          return getUser(insertTeacher.run(teacherName, teacherEmail, hash).lastInsertRowid);
        });
      } catch (error) {
        return explainUniqueViolation(error);
      }
    },

    async createAdmin({ name, email, password }) {
      const adminName = field(name, '姓名', 80, true);
      const { email: adminEmail } = contacts({ email }, { requireEmail: true });
      const hash = await passwordDigest(password);
      try { return getUser(insertAdmin.run(adminName, adminEmail, hash).lastInsertRowid); }
      catch (error) { return explainUniqueViolation(error); }
    },

    async registerTeacher(input, { maxPendingTeachers = options.maxPendingTeachers ?? 100 } = {}) {
      const teacherName = field(input.name, '姓名', 80, true);
      const { email, phone } = contacts(input, { requireEmail: true });
      if (!Number.isSafeInteger(maxPendingTeachers) || maxPendingTeachers < 1) throw new TypeError('Invalid pending teacher application limit');
      const checkCapacity = () => {
        if (db.prepare("SELECT count(*) AS total FROM accounts WHERE role='teacher' AND review_status='pending' AND disabled=0").get().total >= maxPendingTeachers) {
          throw Object.assign(new Error('当前待审核教师申请较多，请联系管理员处理后再申请。'),
            { statusCode: 503, retryAfter: 60, code: 'AUTH_CAPACITY' });
        }
      };
      checkCapacity();
      const hash = await passwordDigest(input.password);
      return transaction(() => {
        checkCapacity();
        return getUser(insertTeacherApplication.run(teacherName, email, phone, hash).lastInsertRowid);
      });
    },

    async register(input, { maxPendingStudents = options.maxPendingStudents ?? 100 } = {}) {
      const data = { ...application(input, options), ...supervisorIds({ ...input, secondaryTeacherId: null }, { allowDefault: true }) };
      if (!Number.isSafeInteger(maxPendingStudents) || maxPendingStudents < 1) throw new TypeError('Invalid pending application limit');
      const checkCapacity = () => {
        if (pendingStudents.get().total >= maxPendingStudents) {
          throw Object.assign(new Error('当前待审核申请较多，请联系教师处理后再申请。'),
            { statusCode: 503, retryAfter: 60, code: 'AUTH_CAPACITY' });
        }
      };
      checkCapacity();
      const hash = await passwordDigest(input.password);
      return transaction(() => {
        // Recheck after the async hash so simultaneous applications cannot exceed the cap.
        checkCapacity();
        supervisorIds(data);
        return getUser(insertStudent.run({ ...data, passwordHash: hash }).lastInsertRowid);
      });
    },

    authenticationTarget(identifier) {
      if (typeof identifier !== 'string' || identifier.length > 254) return 'invalid';
      const email = identifier.includes('@');
      const normalized = email ? normalizedEmail(identifier) : normalizedPhone(identifier);
      const row = email ? selectByEmail.get(normalized) : selectByPhone.get(normalized);
      return row ? `account:${row.id}` : `unknown:${normalized ?? ''}`;
    },

    async authenticate(identifier, password) {
      if (typeof identifier !== 'string' || identifier.length > 254 || !passwordIsValid(password)) return null;
      const row = identifier.includes('@')
        ? selectByEmail.get(normalizedEmail(identifier))
        : selectByPhone.get(normalizedPhone(identifier));
      const [salt, storedKey] = row?.password_hash.split(':') ?? [fallbackSalt, null];
      const expected = storedKey ? Buffer.from(storedKey, 'hex') : fallbackKey;
      const actual = await passwordHashBudget.run(() => deriveKey(password, salt, 64));
      if (!timingSafeEqual(actual, expected) || !row) return null;
      return getUser(row.id);
    },

    issuePasswordReset(email) {
      if (typeof email !== 'string' || email.length > 254) return null;
      const address = normalizedEmail(email);
      if (!address || !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(address)) return null;
      return transaction(() => {
        const now = Date.now();
        removeExpiredResets.run(now);
        removeOldResetRequests.run(now - resetRequestWindow);
        const row = selectByEmail.get(address);
        if (!row) return null;
        const recent = recentResetRequests.get(row.id, now - resetRequestWindow);
        if (recent.count >= 5 || (recent.latest !== null && recent.latest > now - resetCooldown)) return null;
        const user = getUser(row.id);
        const token = randomBytes(32).toString('base64url');
        removeUserResets.run(user.id);
        insertReset.run(tokenDigest(token), user.id, user.email, now + resetLifetime, now);
        recordResetRequest.run(user.id, now);
        return { user, token };
      });
    },

    getPasswordReset(token) {
      if (!isSessionToken(token)) return null;
      const row = selectReset.get(tokenDigest(token), Date.now());
      return row ? getUser(row.user_id) : null;
    },

    discardPasswordReset(token) {
      if (isSessionToken(token)) removeReset.run(tokenDigest(token));
    },

    async completePasswordReset(token, password) {
      if (!isSessionToken(token) || !selectReset.get(tokenDigest(token), Date.now())) {
        fail('重置链接已失效，请重新申请。');
      }
      const hash = await passwordDigest(password);
      return transaction(() => {
        const row = isSessionToken(token) ? selectReset.get(tokenDigest(token), Date.now()) : null;
        if (!row) fail('重置链接已失效，请重新申请。');
        changePassword.run(hash, row.user_id);
        removeUserResets.run(row.user_id);
        removeUserSessions.run(row.user_id);
        return getUser(row.user_id);
      });
    },

    getUser,

    listTeachers,

    listUsers() { return selectAllUsers.all().map(publicUser); },

    canManageStudent,
    assertManageStudent,
    teacherStudents,
    visibleStudentIds(actor) { return teacherStudents(actor).map(student => student.id); },

    assignTeachers(actorId, id, input) {
      return transaction(() => {
        const actor = requireAdmin(actorId);
        const student = getUser(id);
        if (student?.role !== 'student') fail('未找到该学生。', 404);
        const ids = supervisorIds(input);
        changeTeachers.run(ids.primaryTeacherId, ids.secondaryTeacherId, id);
        audit.run(actor.id, id, 'supervisors',
          JSON.stringify({ primaryTeacherId: student.primaryTeacherId, secondaryTeacherId: student.secondaryTeacherId }),
          JSON.stringify(ids), '管理员调整指导关系');
        return getUser(id);
      });
    },

    reviewTeacher(actorId, id, decision, reason) {
      const next = choice(decision, ['approved', 'rejected'], '审核结果');
      const note = field(reason, '审核说明', 500);
      return transaction(() => {
        const actor = requireAdmin(actorId);
        const teacher = getUser(id);
        if (teacher?.role !== 'teacher' || teacher.disabled) fail('未找到该教师。', 404);
        if (teacher.reviewStatus !== 'pending' && !(teacher.reviewStatus === 'rejected' && next === 'approved')) {
          fail('该教师申请已处理，请刷新后查看。', 409);
        }
        changeReview.run(next, note, id);
        audit.run(actor.id, id, 'teacher_review', teacher.reviewStatus, next, note);
        if (next !== 'approved') { removeUserSessions.run(id); removeUserResets.run(id); }
        return getUser(id);
      });
    },

    setUserEnabled,
    disableUser(actorId, id) { return setUserEnabled(actorId, id, false); },
    removeUser(actorId, id) { return setUserEnabled(actorId, id, false); },

    listStudents() {
      return selectStudents.all().map(publicUser);
    },

    pendingProfileChanges(actor) {
      if (actor !== undefined) requireTeacher(actor);
      return new Map(pendingProfileChanges.all().filter(row => actor === undefined || canManageStudent(actor, row.student_id)).map(row => [row.student_id,
        { previous: JSON.parse(row.previous_value), next: JSON.parse(row.new_value) }]));
    },

    updateStudent(id, input) {
      const data = application(input, options);
      return transaction(() => {
        const student = requireStudent(id);
        if (student.reviewStatus !== 'rejected') fail('只有审核未通过的申请可以修改后重提。', 409);
        resubmitStudent.run({ ...data, id });
        const previous = JSON.stringify(registrationSnapshot(student));
        const next = JSON.stringify(registrationSnapshot(data));
        if (previous !== next) audit.run(id, id, 'profile_revision', previous, next, '修改申请后重新提交');
        if (student.email !== data.email) removeUserResets.run(id);
        audit.run(id, id, 'review', 'rejected', 'pending', null);
        return getUser(id);
      });
    },

    reviewStudent(teacherId, id, decision, reason) {
      const next = choice(decision, ['approved', 'rejected'], '审核结果');
      const note = field(reason, '审核说明', 500);
      return transaction(() => {
        assertManageStudent(teacherId, id);
        const student = requireStudent(id);
        if (student.reviewStatus !== 'pending') fail('该申请已处理，请刷新后查看。', 409);
        changeReview.run(next, note, id);
        audit.run(teacherId, id, 'review', 'pending', next, note);
        return getUser(id);
      });
    },

    setStudentStatus(teacherId, id, status, studentNumber) {
      const next = choice(status, studentStates, '学籍状态');
      return transaction(() => {
        assertManageStudent(teacherId, id);
        const student = requireStudent(id);
        if (student.reviewStatus !== 'approved') fail('请先审核该学生的申请。', 409);
        const number = studentNumber === undefined ? student.studentNumber
          : checkedStudentNumber(studentNumber, student.level, next, options);
        if (next === 'active' && !number) fail('请填写学号再转为在读。', 409);
        if (student.studentStatus === next && student.studentNumber === number) return student;
        changeStatus.run(next, number, id);
        if (student.studentStatus !== next) {
          audit.run(teacherId, id, 'student_status', student.studentStatus, next, null);
        }
        if (student.studentNumber !== number) {
          audit.run(teacherId, id, 'student_number', student.studentNumber ?? '', number ?? '', null);
        }
        return getUser(id);
      });
    },

    updateProfile(id, input) {
      return transaction(() => {
        const student = requireStudent(id);
        if (student.reviewStatus !== 'approved' || student.studentStatus === 'graduated') {
          fail('当前账号不能修改个人资料。', 403);
        }
        const data = application({ ...student, ...input }, options);
        const previous = JSON.stringify(registrationSnapshot(student));
        const next = JSON.stringify(registrationSnapshot(data));
        if (previous === next) return student;
        resubmitStudent.run({ ...data, id });
        audit.run(id, id, 'profile_revision', previous, next, '学生修改注册资料，等待重新审核');
        audit.run(id, id, 'review', 'approved', 'pending', '注册资料已修改');
        if (student.email !== data.email) removeUserResets.run(id);
        return getUser(id);
      });
    },

    updateBirthday(id, input) {
      return transaction(() => {
        const student = requireStudent(id);
        if (student.reviewStatus !== 'approved' || student.studentStatus === 'graduated') {
          fail('当前账号不能修改个人资料。', 403);
        }
        const birthday = validBirthday(input.birthday);
        if (student.birthday === birthday) return student;
        changeBirthday.run(birthday, id);
        audit.run(id, id, 'birthday', student.birthday ?? '', birthday ?? '', null);
        return getUser(id);
      });
    },

    createSession(userId) {
      const user = getUser(userId);
      if (!user || user.disabled) fail('未找到该账号。', 404);
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      removeExpired.run(now);
      insertSession.run(tokenDigest(token), userId, now + (options.sessionTtlMs ?? sessionLifetime));
      return token;
    },

    findSession(token) {
      if (!isSessionToken(token)) return null;
      const session = selectSession.get(tokenDigest(token), Date.now());
      const user = session ? getUser(session.user_id) : null;
      return user?.disabled ? null : user;
    },

    deleteSession(token) {
      if (isSessionToken(token)) removeSession.run(tokenDigest(token));
    }
  };
}
