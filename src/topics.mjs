import { topicViews } from './topics-views.mjs';

const stages = [
  '尚未形成有效 idea', '调研阶段', '方法构建阶段', '验证实验阶段',
  '消融分析阶段', '对比实验阶段', '实验分析阶段', '方法写作阶段',
  '论文打磨阶段', '已投稿', 'Rebuttal 阶段', '已录用'
];

const kinds = {
  plan: '工作计划及完成情况',
  reading: '论文学习',
  experiments: '实验进展',
  difficulties: '困难与求助',
  summary: '动态摘要'
};
const weeklyKinds = ['plan', 'reading', 'experiments', 'difficulties'];

const day = 86_400_000;
const beijingDate = (date) => new Date(+date + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function openTopics({ db, accounts, weekly, ui }) {
  const { html, redirect, httpError } = ui;
  const views = topicViews(ui, stages, kinds);
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES accounts(id),
      title TEXT NOT NULL,
      abstract TEXT NOT NULL,
      stage INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 11),
      venue TEXT NOT NULL DEFAULT '',
      deadline TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES accounts(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS paper_topic_members (
      topic_id INTEGER NOT NULL REFERENCES paper_topics(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      joined_at TEXT NOT NULL,
      PRIMARY KEY (topic_id, student_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS paper_topic_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES paper_topics(id) ON DELETE CASCADE,
      text TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS paper_topic_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES paper_topics(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES accounts(id),
      action TEXT NOT NULL CHECK (action IN ('review', 'transfer')),
      successor_id INTEGER REFERENCES accounts(id),
      recorded_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS weekly_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      week TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('plan', 'reading', 'experiments', 'difficulties', 'summary')),
      body TEXT NOT NULL,
      published_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS weekly_publications_active
      ON weekly_publications(student_id, week, kind) WHERE revoked_at IS NULL;
  `);

  // Expand the older CHECK constraint while keeping publication IDs and history.
  if (!db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'weekly_publications'").get().sql.includes("'difficulties'")) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE weekly_publications_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL REFERENCES accounts(id),
        week TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('plan', 'reading', 'experiments', 'difficulties', 'summary')),
        body TEXT NOT NULL, published_at TEXT NOT NULL, revoked_at TEXT
      ) STRICT;
      INSERT INTO weekly_publications_next SELECT * FROM weekly_publications;
      DROP INDEX weekly_publications_active;
      DROP TABLE weekly_publications;
      ALTER TABLE weekly_publications_next RENAME TO weekly_publications;
      CREATE UNIQUE INDEX weekly_publications_active
        ON weekly_publications(student_id, week, kind) WHERE revoked_at IS NULL;
      COMMIT;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_publication_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id INTEGER NOT NULL REFERENCES weekly_publications(id),
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      parent_id INTEGER REFERENCES weekly_publication_comments(id),
      depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 5),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
      created_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS weekly_publication_comments_thread
      ON weekly_publication_comments(publication_id, id);
    CREATE INDEX IF NOT EXISTS weekly_publication_comments_rate
      ON weekly_publication_comments(student_id, created_at);
  `);

  const allTopics = db.prepare(`
    SELECT id, title, abstract, reviewed_at AS reviewedAt
    FROM paper_topics ORDER BY updated_at DESC, id DESC
  `);
  const allReminderTopics = db.prepare(`
    SELECT id, title, deadline, updated_at AS updatedAt
    FROM paper_topics WHERE stage <> 11 ORDER BY deadline, id
  `);
  const topicById = db.prepare(`
    SELECT id, owner_id AS ownerId, title, abstract, stage, venue, deadline, reviewed_at AS reviewedAt
    FROM paper_topics WHERE id = ?
  `);
  const insertTopic = db.prepare(`
    INSERT INTO paper_topics (owner_id, title, abstract, stage, venue, deadline, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const join = db.prepare(`
    INSERT INTO paper_topic_members (topic_id, student_id, joined_at)
    VALUES (?, ?, ?) ON CONFLICT (topic_id, student_id) DO NOTHING
  `);
  const membership = db.prepare('SELECT 1 FROM paper_topic_members WHERE topic_id = ? AND student_id = ?');
  const studentTopics = db.prepare(`
    SELECT t.id, t.title, t.stage FROM paper_topics t
    JOIN paper_topic_members m ON t.id = m.topic_id WHERE m.student_id = ? ORDER BY t.title, t.id
  `);
  const memberRows = db.prepare(`
    SELECT a.id, a.name, a.review_status AS reviewStatus, a.student_status AS studentStatus
    FROM accounts a JOIN paper_topic_members m ON a.id = m.student_id WHERE m.topic_id = ? ORDER BY m.joined_at, a.id
  `);
  const updateTopic = db.prepare(`
    UPDATE paper_topics SET title = ?, abstract = ?, stage = ?, venue = ?, deadline = ?,
      reviewed_at = CASE WHEN ? THEN NULL ELSE reviewed_at END,
      reviewed_by = CASE WHEN ? THEN NULL ELSE reviewed_by END,
      updated_at = ? WHERE id = ?
  `);
  const approveTopic = db.prepare('UPDATE paper_topics SET reviewed_at = ?, reviewed_by = ? WHERE id = ? AND reviewed_at IS NULL');
  const transferTopic = db.prepare('UPDATE paper_topics SET owner_id = ?, updated_at = ? WHERE id = ?');
  const touchTopic = db.prepare('UPDATE paper_topics SET reviewed_at = NULL, reviewed_by = NULL, updated_at = ? WHERE id = ?');
  const pointRows = db.prepare('SELECT id, text FROM paper_topic_points WHERE topic_id = ? ORDER BY id');
  const pointById = db.prepare('SELECT topic_id AS topicId, text FROM paper_topic_points WHERE id = ?');
  const insertPoint = db.prepare('INSERT INTO paper_topic_points (topic_id, text) VALUES (?, ?)');
  const updatePoint = db.prepare('UPDATE paper_topic_points SET text = ? WHERE id = ?');
  const deletePoint = db.prepare('DELETE FROM paper_topic_points WHERE id = ?');
  const audit = db.prepare(`
    INSERT INTO paper_topic_actions (topic_id, actor_id, action, successor_id, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const eligiblePublication = `
    FROM weekly_publications p JOIN accounts a ON a.id = p.student_id
    WHERE p.revoked_at IS NULL AND a.role = 'student' AND a.review_status = 'approved'
      AND a.student_status <> 'graduated' AND a.disabled = 0
  `;
  const feedRows = db.prepare(`
    SELECT p.id, p.kind, substr(p.body, 1, 90) AS preview, a.name AS author ${eligiblePublication}
    AND p.week = ? AND p.student_id <> ? ORDER BY p.published_at DESC, p.id DESC LIMIT ?
  `);
  const detailPublication = db.prepare(`
    SELECT p.id, p.student_id AS studentId, p.week, p.kind, p.body,
      p.published_at AS publishedAt, a.name AS author ${eligiblePublication} AND p.id = ?
  `);
  const listPublications = db.prepare(`
    SELECT p.id, p.student_id AS studentId, p.week, p.kind, substr(p.body, 1, 220) AS preview,
      p.published_at AS publishedAt, a.name AS author,
      (SELECT count(*) FROM weekly_publication_comments c WHERE c.publication_id=p.id AND c.deleted_at IS NULL) AS comments
    ${eligiblePublication} AND (? = 'all' OR p.week = ?)
    ORDER BY p.published_at DESC, p.id DESC LIMIT 20 OFFSET ?
  `);
  const countPublications = db.prepare(`SELECT count(*) AS total ${eligiblePublication} AND (? = 'all' OR p.week = ?)`);
  const teacherPublicationRows = db.prepare(`
    SELECT p.id, p.student_id AS studentId, p.week, p.kind, substr(p.body, 1, 220) AS preview,
      p.published_at AS publishedAt, a.name AS author,
      (SELECT count(*) FROM weekly_publication_comments c WHERE c.publication_id=p.id AND c.deleted_at IS NULL) AS comments
    ${eligiblePublication} AND p.week = ? AND p.student_id IN (SELECT value FROM json_each(?))
    ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?
  `);
  const countTeacherPublications = db.prepare(`SELECT count(*) AS total ${eligiblePublication}
    AND p.week = ? AND p.student_id IN (SELECT value FROM json_each(?))`);
  const ownPublications = db.prepare(`
    SELECT id, kind, body FROM weekly_publications
    WHERE student_id = ? AND week = ? AND revoked_at IS NULL
  `);
  const existingPublication = db.prepare(`
    SELECT id, body FROM weekly_publications
    WHERE student_id = ? AND week = ? AND kind = ? AND revoked_at IS NULL
  `);
  const revokePublication = db.prepare(`
    UPDATE weekly_publications SET revoked_at = ? WHERE id = ? AND student_id = ? AND revoked_at IS NULL
  `);
  const insertPublication = db.prepare(`
    INSERT INTO weekly_publications (student_id, week, kind, body, published_at) VALUES (?, ?, ?, ?, ?)
  `);
  const updatePublication = db.prepare('UPDATE weekly_publications SET body = ?, published_at = ? WHERE id = ?');
  const commentById = db.prepare(`SELECT id, publication_id AS publicationId, student_id AS studentId,
    parent_id AS parentId, depth, deleted_at AS deletedAt FROM weekly_publication_comments WHERE id = ?`);
  const commentRows = db.prepare(`SELECT c.id, c.student_id AS studentId, c.parent_id AS parentId,
    c.depth, c.created_at AS createdAt, c.deleted_at AS deletedAt,
    CASE WHEN a.role IN ('student','teacher') AND a.review_status='approved' AND a.disabled=0 AND c.deleted_at IS NULL THEN c.body ELSE '' END AS body,
    CASE WHEN a.role IN ('student','teacher') AND a.review_status='approved' AND a.disabled=0 THEN a.name ELSE '成员' END AS author,
    CASE WHEN a.role IN ('student','teacher') AND a.review_status='approved' AND a.disabled=0 THEN a.role ELSE NULL END AS authorRole
    FROM weekly_publication_comments c JOIN accounts a ON a.id=c.student_id
    WHERE c.publication_id = ? ORDER BY c.id LIMIT 500`);
  const countComments = db.prepare('SELECT count(*) AS total FROM weekly_publication_comments WHERE publication_id = ?');
  const recentComments = db.prepare('SELECT count(*) AS total FROM weekly_publication_comments WHERE student_id = ? AND created_at > ?');
  const insertComment = db.prepare(`INSERT INTO weekly_publication_comments
    (publication_id,student_id,parent_id,depth,body,created_at) VALUES (?,?,?,?,?,?)`);
  const deleteComment = db.prepare(`UPDATE weekly_publication_comments SET deleted_at = ?, body = '[已删除]'
    WHERE id = ? AND student_id = ? AND deleted_at IS NULL`);

  const stamp = () => new Date().toISOString();

  function fail(status, message) {
    throw httpError(status, message);
  }

  function canReadDynamics(user) {
    return user?.role === 'student' && user.reviewStatus === 'approved' && !user.disabled;
  }

  function canParticipate(user) {
    return canReadDynamics(user) && user.studentStatus !== 'graduated';
  }

  function requireRead(user) {
    if (!canReadDynamics(user)) fail(403, '审核通过后可查看成员动态。');
  }

  function requireParticipant(user) {
    if (!canParticipate(user)) fail(403, '当前账号没有此操作的权限。');
  }

  function requireTopicAccess(user) {
    if (user.role !== 'teacher') requireParticipant(user);
  }

  function managesStudent(user, studentId) {
    return user?.role === 'admin' || (user?.role === 'teacher' && accounts.canManageStudent(user, studentId));
  }

  function canSeeTopic(user, topic) {
    return user.role !== 'teacher' || managesStudent(user, topic.ownerId)
      || memberRows.all(topic.id).some(member => managesStudent(user, member.id));
  }

  function requireTeacherTopic(user, topic) {
    if (!canSeeTopic(user, topic)) fail(404, '没有找到这个课题。');
  }

  function getTopic(id) {
    const topic = topicById.get(id);
    if (!topic) fail(404, '没有找到这个课题。');
    return topic;
  }

  function mayEdit(user, topic) {
    return (user.role === 'teacher' && canSeeTopic(user, topic)) || (canParticipate(user) && user.id === topic.ownerId);
  }

  function requireEdit(user, topic) {
    if (!mayEdit(user, topic)) fail(403, '只有课题负责人和教师可以修改课题。');
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function textField(value, label, max, required = false) {
    const text = typeof value === 'string' ? value : '';
    if (required && !text.trim()) fail(400, `请填写${label}。`);
    if (text.length > max) fail(400, `${label}最多填写 ${max} 个字符。`);
    return text;
  }

  function cleanTopic(input) {
    const title = textField(input.title, '论文题目', 160, true).trim();
    const abstract = textField(input.abstract, '摘要', 4000, true);
    const venue = textField(input.venue, '目标会议或期刊', 120).trim();
    const deadline = textField(input.deadline, '目标截稿日期', 10);
    const stage = input.stage;
    if (!/^(?:[0-9]|1[01])$/.test(stage ?? '')) fail(400, '请选择研究或投稿阶段。');
    if (deadline) {
      const date = new Date(deadline);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(+date) || date.toISOString().slice(0, 10) !== deadline) {
        fail(400, '请填写有效的目标截稿日期。');
      }
    }
    return { title, abstract, stage: Number(stage), venue, deadline };
  }

  function createTopic(user, input) {
    requireParticipant(user);
    const { title, abstract, stage, venue, deadline } = cleanTopic(input);
    return transaction(() => {
      const now = stamp();
      const id = Number(insertTopic.run(user.id, title, abstract, stage, venue, deadline, now, now).lastInsertRowid);
      join.run(id, user.id, now);
      return id;
    });
  }

  function topicDetail(user, id) {
    requireTopicAccess(user);
    const topic = getTopic(id);
    requireTeacherTopic(user, topic);
    const canEdit = mayEdit(user, topic);
    const isMember = !!membership.get(id, user.id);
    const share = isMember || user.role === 'teacher';
    const progress = canEdit ? weekly.progressForTopic(id).filter(record => user.role !== 'teacher' || managesStudent(user, record.studentId)).map((record) =>
      ({ ...record, name: accounts.getUser(record.studentId)?.name ?? '学生' })) : [];
    return {
      topic, canEdit, isMember, progress,
      members: share ? memberRows.all(id).filter(member => user.role !== 'teacher' || managesStudent(user, member.id)) : [],
      points: share ? pointRows.all(id) : []
    };
  }

  function editTopic(user, id, input) {
    const topic = getTopic(id);
    requireEdit(user, topic);
    const { title, abstract, stage, venue, deadline } = cleanTopic(input);
    if (title === topic.title && abstract === topic.abstract && stage === topic.stage
      && venue === topic.venue && deadline === topic.deadline) return;
    const reset = Number(title !== topic.title || abstract !== topic.abstract);
    updateTopic.run(title, abstract, stage, venue, deadline, reset, reset, stamp(), id);
  }

  function editPoint(user, id, input) {
    const point = pointById.get(id);
    if (!point) fail(404, '没有找到这条创新点。');
    requireEdit(user, getTopic(point.topicId));
    const deleting = input.action === 'delete';
    const text = deleting ? null : textField(input.text, '创新点', 1500, true);
    if (!deleting && text === point.text) return point.topicId;
    return transaction(() => {
      if (deleting) deletePoint.run(id);
      else updatePoint.run(text, id);
      touchTopic.run(stamp(), point.topicId);
      return point.topicId;
    });
  }

  function weeklyChoices(studentId) {
    if (!canParticipate(accounts.getUser(studentId))) return [];
    return studentTopics.all(studentId).map((topic) => ({ ...topic, stage: stages[topic.stage] }));
  }

  function weeklyProgress(studentId, topicId, input) {
    const text = textField(input, '课题进展', 4000);
    if (topicId == null || topicId === '') {
      if (text.trim()) fail(400, '请选择课题后再填写进展。');
      return null;
    }
    if (!/^[1-9]\d*$/.test(String(topicId)) || !Number.isSafeInteger(Number(topicId))) fail(400, '课题无效。');
    const selected = weeklyChoices(studentId).find((topic) => topic.id === Number(topicId));
    if (!selected) fail(403, '只能关联自己已加入的课题。');
    return { ...selected, text };
  }

  function snapshot(studentId, week, kind, summary) {
    if (kind === 'summary') return textField(summary, '动态摘要', 1500, true);
    const report = weekly.getReport(studentId, week);
    const version = report?.latestVersion;
    if (!version || report.status === 'draft') fail(400, '请先提交本周周报，再公开所选内容。');
    if (kind === 'plan') {
      const lastWeek = new Date(Date.parse(week) - 7 * day).toISOString().slice(0, 10);
      const followup = weekly.taskProgress(studentId, lastWeek)
        .map(({ done, text }) => `${done ? '已完成' : '待完成'}　${text}`);
      return [
        version.plan.length ? ['本周工作计划', ...version.plan].join('\n') : '',
        followup.length ? ['上周任务跟进', ...followup].join('\n') : ''
      ].filter(Boolean).join('\n\n');
    }
    return version[kind];
  }

  function publish(user, { kind, summary }) {
    requireParticipant(user);
    if (!Object.hasOwn(kinds, kind)) fail(400, '请选择要发布的内容。');
    const week = weekly.currentWeek();
    const body = snapshot(user.id, week, kind, summary);
    if (!body?.trim()) fail(400, '所选内容为空，暂时无法发布。');
    return transaction(() => {
      const current = existingPublication.get(user.id, week, kind);
      if (current?.body === body) return current.id;
      const now = stamp();
      if (current) {
        updatePublication.run(body, now, current.id);
        return current.id;
      }
      return Number(insertPublication.run(user.id, week, kind, body, now).lastInsertRowid);
    });
  }

  function setPublicationVisibility(user, { kind, week, published, summary, intent }) {
    requireParticipant(user);
    if (!Object.hasOwn(kinds, kind)) fail(400, '请选择要发布的内容。');
    if (week !== weekly.currentWeek()) fail(409, '周次已变化，请刷新页面后重新设置。');
    if (published !== undefined && published !== '1') fail(400, '发布设置无效，请刷新后重试。');
    if (intent !== undefined && intent !== 'update') fail(400, '操作无效，请刷新后重试。');
    const current = existingPublication.get(user.id, week, kind);
    if (published !== '1') {
      if (current) revokePublication.run(stamp(), current.id, user.id);
      return;
    }
    // Repeated checked submissions preserve the snapshot already shared.
    if (current && intent !== 'update') return;
    publish(user, { kind, summary });
  }

  function publicationState(user, week) {
    requireRead(user);
    return Object.fromEntries(ownPublications.all(user.id, week).map(item => [item.kind, item]));
  }

  // The weekly submission owns the transaction, so report and visibility commit together.
  function saveWeeklyVisibility(user, { week, kinds: selected }) {
    requireParticipant(user);
    if (!Array.isArray(selected) || selected.length > weeklyKinds.length
      || selected.some(kind => !weeklyKinds.includes(kind)) || new Set(selected).size !== selected.length) {
      fail(400, '请选择有效的周报发布分项。');
    }
    const date = new Date(week);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week ?? '') || Number.isNaN(+date)
      || date.toISOString().slice(0, 10) !== week || date.getUTCDay() !== 1 || week > weekly.currentWeek()) {
      fail(400, '发布周次无效。');
    }
    const report = weekly.getReport(user.id, week);
    if (!report?.latestVersion || report.status === 'draft') fail(400, '请先提交周报，再公开所选内容。');
    const bodies = new Map(selected.map(kind => {
      const body = snapshot(user.id, week, kind);
      if (typeof body !== 'string' || !body.trim()) fail(400, '所选发布分项为空，请填写内容或取消勾选。');
      return [kind, body];
    }));
    const now = stamp();
    for (const kind of weeklyKinds) {
      const current = existingPublication.get(user.id, week, kind);
      if (!bodies.has(kind)) {
        if (current) revokePublication.run(now, current.id, user.id);
      } else if (current) {
        if (current.body !== bodies.get(kind)) updatePublication.run(bodies.get(kind), now, current.id);
      } else insertPublication.run(user.id, week, kind, bodies.get(kind), now);
    }
    return publicationState(user, week);
  }

  function readablePublication(user, id) {
    requireRead(user);
    const item = detailPublication.get(id);
    if (!item) fail(404, '这条动态已撤回或不再显示。');
    return item;
  }

  function teacherScope(actor) {
    const teacher = actor && accounts.getUser(actor.id);
    if (teacher?.role !== 'teacher' || teacher.reviewStatus !== 'approved' || teacher.disabled) {
      fail(403, '请使用审核通过的教师账号查看学生动态。');
    }
    return { teacher, studentIds: JSON.stringify(accounts.teacherStudents(teacher).map(student => student.id)) };
  }

  function teacherFeed(actor, { limit = 5 } = {}) {
    const { studentIds } = teacherScope(actor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail(400, '动态数量无效。');
    return teacherPublicationRows.all(weekly.currentWeek(), studentIds, limit, 0);
  }

  function readableTeacherPublication(actor, id) {
    const { teacher } = teacherScope(actor);
    const item = detailPublication.get(id);
    if (!item || item.week !== weekly.currentWeek() || !accounts.canManageStudent(teacher, item.studentId)) {
      fail(404, '没有找到可查看的本周学生动态。');
    }
    return { teacher, item };
  }

  function pageNumber(value) {
    if (value == null || value === '') return 1;
    if (!/^[1-9]\d{0,5}$/.test(value)) fail(400, '页码无效。');
    return Number(value);
  }

  function discussion(user, publicationId, requestedPage) {
    const participant = user.role === 'teacher'
      ? readableTeacherPublication(user, publicationId).teacher : accounts.getUser(user.id);
    const canReply = participant?.role === 'teacher' || canParticipate(participant);
    const comments = commentRows.all(publicationId);
    const roots = comments.filter(comment => comment.parentId === null);
    const pages = Math.max(1, Math.ceil(roots.length / 20));
    const page = Math.min(pageNumber(requestedPage), pages);
    const shownRoots = new Set(roots.slice((page - 1) * 20, page * 20).map(comment => comment.id));
    const visible = new Set(shownRoots);
    const rows = comments.filter(comment => {
      if (!shownRoots.has(comment.id) && !visible.has(comment.parentId)) return false;
      visible.add(comment.id);
      return true;
    }).map(comment => ({ ...comment, canDelete: canReply && comment.studentId === participant.id && !comment.deletedAt }));
    return { comments: rows, total: comments.filter(comment => !comment.deletedAt && comment.body).length,
      page, pages, canReply, full: comments.length >= 500 };
  }

  function commentActor(actor, publicationId, teacher) {
    if (teacher) return readableTeacherPublication(actor, publicationId).teacher;
    const student = actor && accounts.getUser(actor.id);
    requireParticipant(student);
    readablePublication(student, publicationId);
    return student;
  }

  function addComment(user, publicationId, input, teacher = false) {
    commentActor(user, publicationId, teacher);
    const body = textField(input.body, '回复内容', 2000, true).trim();
    let parent = null;
    if (input.parentId) {
      if (!/^[1-9]\d*$/.test(input.parentId) || !Number.isSafeInteger(Number(input.parentId))) fail(400, '回复对象无效。');
      parent = commentById.get(Number(input.parentId));
      if (!parent || parent.publicationId !== publicationId) fail(400, '回复对象不属于这条动态。');
      if (parent.depth >= 5) fail(400, '回复层级已达上限，请回复上一级讨论。');
    }
    return transaction(() => {
      const actor = commentActor(user, publicationId, teacher);
      if (countComments.get(publicationId).total >= 500) fail(409, '这条动态的回复已达上限。');
      if (recentComments.get(actor.id, new Date(Date.now() - 60_000).toISOString()).total >= 5) {
        fail(429, '回复过于频繁，请稍后再试。');
      }
      return Number(insertComment.run(publicationId, actor.id, parent?.id ?? null, (parent?.depth ?? 0) + 1, body, stamp()).lastInsertRowid);
    });
  }

  function commentLocation(publicationId, commentId, teacher = false) {
    const comments = commentRows.all(publicationId);
    let root = commentById.get(commentId);
    while (root.parentId !== null) root = commentById.get(root.parentId);
    const page = Math.floor(comments.filter(comment => comment.parentId === null).findIndex(comment => comment.id === root.id) / 20) + 1;
    return `/${teacher ? 'teacher' : 'student'}/dynamics/${publicationId}?page=${page}#comment-${commentId}`;
  }

  function removeOwnComment(user, id, teacher = false) {
    return transaction(() => {
      const comment = commentById.get(id);
      if (!comment || comment.studentId !== user.id) fail(404, '没有找到可删除的回复。');
      const actor = commentActor(user, comment.publicationId, teacher);
      deleteComment.run(stamp(), id, actor.id);
      return comment.publicationId;
    });
  }

  function dashboard(user) {
    if (!canReadDynamics(user)) return '';
    return views.dashboard(user, feedRows.all(weekly.currentWeek(), user.id, 12));
  }

  function teacherDashboard(actor) {
    return views.teacherDashboard(teacherFeed(actor));
  }

  function reminders(now = new Date(), actorOrOptions = {}, options = {}) {
    const actor = actorOrOptions?.role ? actorOrOptions : null;
    const { leadDays = 14, staleDays = 21 } = actor ? options : actorOrOptions;
    const date = beijingDate(now);
    const horizon = beijingDate(new Date(+now + leadDays * day));
    return allReminderTopics.all().filter(item => !actor || canSeeTopic(actor, getTopic(item.id))).flatMap((item) => {
      const result = [];
      if (item.deadline && item.deadline >= date && item.deadline <= horizon) {
        result.push({ date: item.deadline, title: '课题目标截稿', detail: item.title });
      }
      if (+now - Date.parse(item.updatedAt) >= staleDays * day) {
        result.push({ date, title: '课题长期未更新', detail: item.title });
      }
      return result;
    });
  }

  const routes = [
    ['GET', /^\/teacher\/dynamics$/, 'teacher', ({ response, state, url }) => {
      const { teacher, studentIds } = teacherScope(state.user);
      const week = weekly.currentWeek();
      const total = countTeacherPublications.get(week, studentIds).total;
      const pages = Math.max(1, Math.ceil(total / 20));
      const page = Math.min(pageNumber(url.searchParams.get('page')), pages);
      html(response, views.feed({ ...state, user: teacher, publicationWeek: week },
        teacherPublicationRows.all(week, studentIds, 20, (page - 1) * 20), null,
        { scope: 'week', total, page, pages }));
    }],
    ['GET', /^\/teacher\/dynamics\/(\d+)$/, 'teacher', ({ response, state, id, url }) => {
      const { teacher, item } = readableTeacherPublication(state.user, id);
      html(response, views.publication({ ...state, user: teacher }, item, discussion(teacher, id, url.searchParams.get('page'))));
    }],
    ['POST', /^\/teacher\/dynamics\/(\d+)\/comments$/, 'teacher', ({ response, state, id, form }) => {
      const commentId = addComment(state.user, id, form, true);
      redirect(response, commentLocation(id, commentId, true));
    }],
    ['POST', /^\/teacher\/dynamics\/comments\/(\d+)\/delete$/, 'teacher', ({ response, state, id }) => {
      teacherScope(state.user);
      const publicationId = removeOwnComment(state.user, id, true);
      redirect(response, '/teacher/dynamics/' + publicationId + '#discussion');
    }],
    ['GET', /^\/student\/dynamics$/, 'student', ({ response, state, url }) => {
      requireRead(state.user);
      const week = weekly.currentWeek();
      const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'week';
      const total = countPublications.get(scope, week).total;
      const pages = Math.max(1, Math.ceil(total / 20));
      const page = Math.min(pageNumber(url.searchParams.get('page')), pages);
      const personal = canParticipate(state.user)
        ? Object.fromEntries(ownPublications.all(state.user.id, week).map((item) => [item.kind, item])) : null;
      html(response, views.feed({ ...state, publicationWeek: week, publicationManagerOpen: url.searchParams.get('manage') === '1' }, listPublications.all(scope, week, (page - 1) * 20), personal,
        { scope, total, page, pages }));
    }],
    ['GET', /^\/student\/dynamics\/feed$/, 'student', ({ response, state }) => {
      requireRead(state.user);
      html(response, dashboard(state.user));
    }],
    ['GET', /^\/student\/dynamics\/(\d+)$/, 'student', ({ response, state, id, url }) => {
      const item = readablePublication(state.user, id);
      html(response, views.publication(state, item, discussion(state.user, id, url.searchParams.get('page'))));
    }],
    ['POST', /^\/student\/dynamics\/(\d+)\/comments$/, 'student', ({ response, state, id, form }) => {
      const commentId = addComment(state.user, id, form);
      redirect(response, commentLocation(id, commentId));
    }],
    ['POST', /^\/student\/dynamics\/comments\/(\d+)\/delete$/, 'student', ({ response, state, id }) => {
      requireParticipant(state.user);
      const publicationId = removeOwnComment(state.user, id);
      redirect(response, '/student/dynamics/' + publicationId + '#discussion');
    }],
    ['POST', /^\/student\/dynamics\/publish$/, 'student', ({ response, state, form }) => {
      publish(state.user, form);
      redirect(response, '/student/dynamics');
    }],
    ['POST', /^\/student\/dynamics\/visibility$/, 'student', ({ response, state, form }) => {
      setPublicationVisibility(state.user, form);
      redirect(response, '/student/dynamics?manage=1#publication-' + form.kind);
    }],
    ['POST', /^\/student\/dynamics\/(\d+)\/withdraw$/, 'student', ({ response, state, id }) => {
      requireParticipant(state.user);
      if (!revokePublication.run(stamp(), id, state.user.id).changes) fail(404, '没有找到可撤回的动态。');
      redirect(response, '/student/dynamics');
    }],
    ['POST', /^\/student\/topics$/, 'student', ({ response, state, form }) => {
      const id = createTopic(state.user, form);
      redirect(response, '/student/topics/' + id);
    }],
    ['POST', /^\/student\/topics\/(\d+)\/join$/, 'student', ({ response, state, id }) => {
      requireParticipant(state.user);
      getTopic(id);
      join.run(id, state.user.id, stamp());
      redirect(response, '/student/topics/' + id);
    }],
    ['POST', /^\/teacher\/topics\/(\d+)\/review$/, 'teacher', ({ response, state, id }) => {
      requireTeacherTopic(state.user, getTopic(id));
      transaction(() => {
        const now = stamp();
        if (approveTopic.run(now, state.user.id, id).changes) audit.run(id, state.user.id, 'review', null, now);
      });
      redirect(response, '/teacher/topics/' + id);
    }],
    ['POST', /^\/teacher\/topics\/(\d+)\/transfer$/, 'teacher', ({ response, state, id, form }) => {
      const topic = getTopic(id);
      requireTeacherTopic(state.user, topic);
      const studentId = Number(form.studentId);
      if (!/^[1-9]\d*$/.test(form.studentId ?? '') || !Number.isSafeInteger(studentId)) {
        fail(400, '请选择接任的课题成员。');
      }
      const student = accounts.getUser(studentId);
      if (!canParticipate(student) || !membership.get(id, student.id) || !managesStudent(state.user, student.id)) {
        fail(400, '请选择自己指导的、审核通过的非毕业课题成员。');
      }
      if (student.id !== topic.ownerId) transaction(() => {
        const now = stamp();
        transferTopic.run(student.id, now, id);
        audit.run(id, state.user.id, 'transfer', student.id, now);
      });
      redirect(response, '/teacher/topics/' + id);
    }]
  ];

  for (const role of ['student', 'teacher']) {
    const base = '/' + role + '/topics';
    routes.push(
      ['GET', new RegExp('^' + base + '$'), role, ({ response, state }) => {
        requireTopicAccess(state.user);
        html(response, views.directory(state, allTopics.all().filter(topic => canSeeTopic(state.user, getTopic(topic.id)))));
      }],
      ['GET', new RegExp('^' + base + '/([0-9]+)$'), role, ({ response, state, id }) => {
        html(response, views.detail(state, topicDetail(state.user, id)));
      }],
      ['POST', new RegExp('^' + base + '/([0-9]+)/edit$'), role, ({ response, state, id, form }) => {
        editTopic(state.user, id, form);
        redirect(response, base + '/' + id);
      }],
      ['POST', new RegExp('^' + base + '/([0-9]+)/points$'), role, ({ response, state, id, form }) => {
        requireEdit(state.user, getTopic(id));
        const text = textField(form.text, '创新点', 1500, true);
        transaction(() => {
          insertPoint.run(id, text);
          touchTopic.run(stamp(), id);
        });
        redirect(response, base + '/' + id);
      }],
      ['POST', new RegExp('^' + base + '/points/([0-9]+)$'), role, ({ response, state, id, form }) => {
        redirect(response, base + '/' + editPoint(state.user, id, form));
      }]
    );
  }

  return { routes, dashboard, teacherFeed, teacherDashboard, topicsForStudent: weeklyChoices, weeklyChoices, weeklyProgress, reminders,
    publicationState, saveWeeklyVisibility };
}
