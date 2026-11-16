import { weeklyViews } from './weekly-views.mjs';
import { openWeeklyAttachments, maxWeeklyAttachments } from './weekly-attachments.mjs';
import { normalizePlanRich, planRichText } from './rich-text.mjs';

const dayMs = 86_400_000;
const weekMs = 7 * dayMs;
const offset = 8 * 60 * 60 * 1000;
const lateWeeks = 4;
const defaultPolicy = { required: true, weekday: 6, time: '23:59' };

const leaveReasons = {
  course: '课程或考试', health: '身体原因', internship: '实习', travel: '出差',
  personal: '个人事务', other: '其他'
};

function day(value) {
  return new Date(value + offset).toISOString().slice(0, 10);
}

function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || value < '2000-01-01' || value > '2099-12-31') return NaN;
  const time = Date.parse(value + 'T00:00:00+08:00');
  return Number.isFinite(time) && day(time) === value ? time : NaN;
}

function monday(time) {
  const localDate = new Date(time + offset);
  const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
  return day(time - daysSinceMonday * dayMs);
}

function endOfWeek(week) {
  return day(dateValue(week) + 6 * dayMs);
}

function whenDue(week, settings) {
  return Date.parse(day(dateValue(week) + settings.weekday * dayMs) + 'T' + settings.time + ':00+08:00');
}

function fromSqlTime(value) {
  return Date.parse(value?.replace(' ', 'T') + 'Z');
}

export function openWeekly({ db, accounts, ui, now = Date.now, attachments }) {
  const { httpError, html, redirect } = ui;
  const views = weeklyViews(ui, leaveReasons);
  const files = attachments ?? openWeeklyAttachments({ db, accounts, httpError });
  let topics = null;

  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_policies (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      teacher_id INTEGER NOT NULL REFERENCES accounts(id),
      week TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('week', 'recurring')),
      required INTEGER NOT NULL CHECK (required IN (0, 1)),
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      time TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS weekly_policy_lookup ON weekly_policies(student_id, scope, week, id);

    CREATE TABLE IF NOT EXISTS weekly_reports (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      week TEXT NOT NULL,
      draft TEXT,
      first_submitted_at INTEGER,
      first_cutoff_at INTEGER,
      was_late INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE (student_id, week)
    );
    CREATE TABLE IF NOT EXISTS weekly_versions (
      id INTEGER PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES weekly_reports(id),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS weekly_versions_report ON weekly_versions(report_id, id);
    CREATE TABLE IF NOT EXISTS weekly_task_changes (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      week TEXT NOT NULL,
      origin_version_id INTEGER NOT NULL REFERENCES weekly_versions(id),
      task_index INTEGER NOT NULL,
      done INTEGER NOT NULL CHECK (done IN (0, 1)),
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS weekly_task_lookup ON weekly_task_changes(student_id, week, origin_version_id, task_index, id);

    CREATE TABLE IF NOT EXISTS weekly_leaves (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      reason TEXT NOT NULL,
      note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      requested_at INTEGER NOT NULL,
      reviewer_id INTEGER REFERENCES accounts(id),
      review_note TEXT,
      reviewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS weekly_leave_lookup ON weekly_leaves(student_id, status, date_from, date_to);
  `);

  const sql = {
    report: db.prepare('SELECT * FROM weekly_reports WHERE student_id = ? AND week = ?'),
    versions: db.prepare('SELECT * FROM weekly_versions WHERE report_id = ? ORDER BY id DESC'),
    taskEvents: db.prepare(`SELECT * FROM weekly_task_changes
      WHERE student_id = ? AND week = ? ORDER BY id DESC`),
    insertTask: db.prepare(`INSERT INTO weekly_task_changes
      (student_id, week, origin_version_id, task_index, done, changed_at) VALUES (?, ?, ?, ?, ?, ?)`),
    initReport: db.prepare('INSERT INTO weekly_reports (student_id, week) VALUES (?, ?) ON CONFLICT DO NOTHING'),
    saveDraft: db.prepare('UPDATE weekly_reports SET draft = ?, revision = revision + 1 WHERE id = ?'),
    initialSubmit: db.prepare(`UPDATE weekly_reports SET draft = NULL, revision = revision + 1,
      first_submitted_at = ?, first_cutoff_at = ?, was_late = ? WHERE id = ?`),
    increaseRevision: db.prepare('UPDATE weekly_reports SET revision = revision + 1 WHERE id = ?'),
    insertVersion: db.prepare('INSERT INTO weekly_versions (report_id, content, created_at) VALUES (?, ?, ?)'),
    policy: db.prepare(`SELECT required, weekday, time FROM weekly_policies WHERE student_id = ?
      AND ((scope = 'week' AND week = ?) OR (scope = 'recurring' AND week <= ?))
      ORDER BY (scope = 'week') DESC, week DESC, id DESC LIMIT 1`),
    insertPolicy: db.prepare(`INSERT INTO weekly_policies
      (student_id, teacher_id, week, scope, required, weekday, time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    studentLeaves: db.prepare('SELECT * FROM weekly_leaves WHERE student_id = ? ORDER BY id DESC'),
    teacherLeaves: db.prepare(`SELECT l.*, a.name FROM weekly_leaves l JOIN accounts a ON a.id = l.student_id
      WHERE l.status = 'pending' OR (l.date_from <= ? AND l.date_to >= ?) ORDER BY l.id DESC`),
    covered: db.prepare(`SELECT date_from, date_to FROM weekly_leaves
      WHERE student_id = ? AND status = 'approved' AND date_from <= ? AND date_to >= ?`),
    sameLeave: db.prepare(`SELECT id FROM weekly_leaves WHERE student_id = ? AND date_from = ? AND date_to = ?
      AND reason = ? AND note = ? AND status != 'rejected'`),
    insertLeave: db.prepare(`INSERT INTO weekly_leaves
      (student_id, date_from, date_to, reason, note, requested_at) VALUES (?, ?, ?, ?, ?, ?)`),
    approveLeave: db.prepare(`UPDATE weekly_leaves SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'`),
    leave: db.prepare('SELECT student_id FROM weekly_leaves WHERE id = ?'),
    audit: db.prepare(`SELECT previous_value, new_value, occurred_at FROM account_audit
      WHERE student_id = ? AND action = ? ORDER BY id`),
    progress: db.prepare(`SELECT r.student_id, r.week, v.content FROM weekly_reports r JOIN weekly_versions v
      ON v.id = (SELECT max(id) FROM weekly_versions WHERE report_id = r.id)
      WHERE r.first_submitted_at IS NOT NULL
        AND json_extract(v.content, '$.relatedTopic.id') = ?
      ORDER BY r.week DESC, v.created_at DESC`)
  };

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const currentWeek = () => monday(now());
  function chooseWeek(value) {
    if (!value) return currentWeek();
    const date = dateValue(value);
    if (!Number.isFinite(date) || monday(date) > currentWeek()) {
      throw httpError(400, '请选择本周或之前的日期。');
    }
    return monday(date);
  }

  function getReport(studentId, week) {
    const row = sql.report.get(studentId, week);
    if (!row) return null;
    const versions = sql.versions.all(row.id).map((version) => ({
      id: version.id, at: version.created_at, difficulties: '', attachments: [], ...JSON.parse(version.content)
    }));
    // Follow unchanged task text across revisions, including reordering. Each alias preserves
    // completion events saved against older version IDs without modifying those snapshots.
    let previousTasks = [];
    for (const version of [...versions].reverse()) {
      const byText = new Map();
      for (const task of previousTasks) {
        if (!byText.has(task.text)) byText.set(task.text, []);
        byText.get(task.text).push(task.origins);
      }
      const currentTasks = (version.plan ?? []).map((text, index) => ({ text,
        origins: [...(byText.get(text)?.shift() ?? []), { versionId: version.id, index }] }));
      version.taskOrigins = currentTasks.map(task => task.origins);
      previousTasks = currentTasks;
    }
    return {
      id: row.id, studentId, week, revision: row.revision,
      status: row.first_submitted_at === null ? 'draft' : row.was_late ? 'late' : 'submitted',
      firstSubmittedAt: row.first_submitted_at, firstCutoffAt: row.first_cutoff_at,
      draft: row.draft === null ? null : { difficulties: '', attachments: [], ...JSON.parse(row.draft) }, versions, latestVersion: versions[0] ?? null
    };
  }

  function priorWeek(week) {
    return day(dateValue(week) - weekMs);
  }

  function taskDetails(studentId, week, version) {
    const events = sql.taskEvents.all(studentId, week);
    return (version.plan ?? []).map((task, index) => {
      const origins = version.taskOrigins?.[index] ?? [{ versionId: version.id, index }];
      const history = events.filter(event => origins.some(origin =>
        event.origin_version_id === origin.versionId && event.task_index === origin.index));
      return { text: task, index, sourceVersionId: version.id, done: Boolean(history[0]?.done), changedAt: history[0]?.changed_at ?? null,
        history: history.map((event) => ({ done: Boolean(event.done), at: event.changed_at })) };
    });
  }

  function previousTasks(studentId, week) {
    const version = getReport(studentId, priorWeek(week))?.latestVersion;
    return version ? taskDetails(studentId, week, version) : [];
  }

  function taskProgress(studentId, week) {
    const version = getReport(studentId, week)?.latestVersion;
    return version ? taskDetails(studentId, day(dateValue(week) + weekMs), version)
      .map(({ text, done, changedAt }) => ({ text, done, changedAt })) : [];
  }

  function eligibleAt(student, week) {
    if (student.reviewStatus !== 'approved') return false;
    if (week === currentWeek()) return student.studentStatus !== 'graduated';
    const weekEndsAt = dateValue(week) + weekMs;
    const approved = sql.audit.all(student.id, 'review').findLast((event) => event.new_value === 'approved');
    if (fromSqlTime(approved?.occurred_at ?? student.createdAt) >= weekEndsAt) return false;
    const events = sql.audit.all(student.id, 'student_status');
    const latest = events.findLast((event) => fromSqlTime(event.occurred_at) < weekEndsAt);
    return (latest?.new_value ?? events[0]?.previous_value ?? student.studentStatus) !== 'graduated';
  }

  function overview(studentId, week) {
    const student = accounts.getUser(studentId);
    if (student?.role !== 'student') throw httpError(404, '未找到该学生。');
    const report = getReport(studentId, week);
    const submission = report?.latestVersion ? report.status : 'not-submitted';
    const row = sql.policy.get(studentId, week, week);
    const settings = row ? { required: Boolean(row.required), weekday: row.weekday, time: row.time } : defaultPolicy;
    const dueAt = whenDue(week, settings);
    const firstCutoffAt = report?.firstCutoffAt ?? null;
    let obligation = 'ineligible';
    if (eligibleAt(student, week)) {
      const leaves = sql.covered.all(studentId, endOfWeek(week), week);
      const fullWeek = Array.from({ length: 7 }, (_, index) => day(dateValue(week) + index * dayMs))
        .every((date) => leaves.some((leave) => leave.date_from <= date && leave.date_to >= date));
      obligation = !settings.required ? 'exempt' : fullWeek ? 'leave' : 'required';
    }
    const required = obligation === 'required';
    const pastDeadline = now() > dueAt;
    const overdue = required && submission === 'not-submitted' && pastDeadline;
    const canEdit = Boolean(student.reviewStatus === 'approved' && student.studentStatus !== 'graduated' &&
      (report?.latestVersion || (obligation !== 'ineligible' &&
        dateValue(week) >= dateValue(currentWeek()) - lateWeeks * weekMs)));
    return { student, week, report, required, obligation, submission, dueAt, firstCutoffAt, overdue, pastDeadline, settings, canEdit };
  }

  function assertStudent(state) {
    if (state.user.reviewStatus !== 'approved' || state.user.studentStatus === 'graduated') {
      throw httpError(403, '当前账号无法操作周报。');
    }
  }

  function limitedText(value, name, limit) {
    const result = String(value ?? '').replaceAll('\r\n', '\n');
    if (result.length > limit) throw httpError(400, name + '最多填写 ' + limit + ' 个字符。');
    return result;
  }

  function draftContent(form, studentId) {
    const planRich = form.richEditor === '1' ? normalizePlanRich(form.planRich) : undefined;
    const plan = planRich ? planRichText(planRich) : limitedText(form.plan, '工作计划', 2000).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (plan.length > 15) throw httpError(400, '工作计划最多填写 15 项，每行一项。');
    const progress = limitedText(form.progress, '课题进展', 1200);
    return {
      plan, ...(planRich ? { planRich } : {}), reading: limitedText(form.reading, '论文学习', 2000),
      experiments: limitedText(form.experiments, '实验进展', 2000),
      difficulties: limitedText(form.difficulties, '遇到的困难与需要的帮助', 3000),
      relatedTopic: topics?.weeklyProgress(studentId, form.topicId ?? '', progress) ?? null
    };
  }

  function saveReport(studentId, week, form, uploads, retainedIds, kinds = []) {
    const submit = form.action === 'submit';
    if (!submit && form.action !== 'draft') throw httpError(400, '请选择保存草稿或提交周报。');
    const text = draftContent(form, studentId);
    if (submit && !text.plan.length && !text.reading.trim() && !text.experiments.trim() &&
        !text.difficulties.trim() && !text.relatedTopic?.text?.trim() && !uploads.length && !retainedIds.length) {
      throw httpError(400, '请至少填写一项周报内容或添加附件。');
    }
    transaction(() => {
      const { report, canEdit, dueAt, submission } = overview(studentId, week);
      if (!canEdit) throw httpError(409, '当前周次不可新增周报，请选择本周或此前四周。已提交的周报仍可修改。');
      if (String(report?.revision ?? 0) !== form.revision) throw httpError(409, '周报已在另一页面更新，请刷新后再编辑。');
      if (!submit && submission !== 'not-submitted') throw httpError(409, '已经提交的周报只能保存修改版本。');
      const retained = files.metadataForIds(studentId, week, retainedIds);
      // A version may only retain files already present in this report, including an older version.
      const knownIds = new Set([...(report?.draft?.attachments ?? []),
        ...(report?.versions.flatMap(version => version.attachments ?? []) ?? [])].map(file => file.id));
      if (retained.some(file => !knownIds.has(file.id))) throw httpError(400, '附件记录已变化，请刷新后重新选择。');
      if (retained.length + uploads.length > maxWeeklyAttachments) throw httpError(400, '每份周报最多保留 5 个附件，请先取消不需要的附件。');
      const added = files.saveMany(studentId, week, uploads);
      const content = { ...text, attachments: [...retained, ...added] };
      if (text.planRich) content.planRich = normalizePlanRich(JSON.stringify(text.planRich), { attachments: retained, uploads: added, resolve: true });
      if (!submit && form.publicationControls === '1') content.shareKinds = [...new Set(kinds.filter(kind => ['plan', 'reading', 'experiments', 'difficulties'].includes(kind)))];
      const syncVisibility = () => {
        if (submit && form.publicationControls === '1') topics?.saveWeeklyVisibility(accounts.getUser(studentId), { week, kinds });
      };
      const previous = submit ? report?.latestVersion : report?.draft;
      if (previous) {
        const { plan, planRich, reading, experiments, relatedTopic = null, difficulties = '', attachments = [] } = previous;
        const comparable = { plan, ...(planRich ? { planRich } : {}), reading, experiments, difficulties, relatedTopic, attachments };
        if (!submit && previous.shareKinds) comparable.shareKinds = previous.shareKinds;
        if (JSON.stringify(comparable) === JSON.stringify(content)) { syncVisibility(); return; }
      }
      sql.initReport.run(studentId, week);
      const id = sql.report.get(studentId, week).id;
      if (!submit) {
        sql.saveDraft.run(JSON.stringify(content), id);
        return;
      }
      const at = now();
      if (submission === 'not-submitted') sql.initialSubmit.run(at, dueAt, Number(at > dueAt), id);
      else sql.increaseRevision.run(id);
      sql.insertVersion.run(id, JSON.stringify(content), at);
      syncVisibility();
    });
  }

  function saveTaskChanges(studentId, week, fields) {
    if (week !== currentWeek()) throw httpError(409, '只能在本周更新上周任务。');
    const version = getReport(studentId, priorWeek(week))?.latestVersion;
    if (!version) throw httpError(404, '未找到上周的工作计划。');
    if (String(version.id) !== fields.get('originVersionId')) throw httpError(409, '上周计划已更新，请刷新后再勾选任务。');
    const selected = new Set(fields.getAll('done'));
    if ([...selected].some((index) => !/^\d+$/.test(index) || !version.plan[Number(index)])) {
      throw httpError(400, '任务已变化，请刷新页面。');
    }
    transaction(() => {
      for (const task of taskDetails(studentId, week, version)) {
        const done = selected.has(String(task.index));
        if (task.done !== done) sql.insertTask.run(studentId, week, version.id, task.index, Number(done), now());
      }
    });
  }

  function policy(studentId, teacherId, week, form) {
    if (week !== currentWeek()) throw httpError(409, '历史周报设置已留档，只能调整本周或后续设置。');
    if (overview(studentId, week).obligation === 'ineligible') throw httpError(409, '该学生当前无需设置周报要求。');
    if (!['recurring', 'week'].includes(form.scope) || !['0', '1'].includes(form.required) ||
        !/^[0-6]$/.test(form.weekday ?? '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time ?? '')) {
      throw httpError(400, '请设置有效的截止星期和时间。');
    }
    sql.insertPolicy.run(studentId, teacherId, week, form.scope, Number(form.required), Number(form.weekday), form.time, now());
  }

  function applyLeave(studentId, form) {
    const from = dateValue(form.from);
    const to = dateValue(form.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 365 * dayMs) {
      throw httpError(400, '请选择有效的请假起止日期，时长不超过一年。');
    }
    if (!Object.hasOwn(leaveReasons, form.reason)) throw httpError(400, '请选择请假事由。');
    const note = limitedText(form.note, '补充说明', 500).trim();
    transaction(() => {
      if (!sql.sameLeave.get(studentId, form.from, form.to, form.reason, note)) {
        sql.insertLeave.run(studentId, form.from, form.to, form.reason, note, now());
      }
    });
  }

  function showStudent(state, response, week, { done, values, status, tab = 'report' } = {}) {
    const studentId = state.user.id;
    html(response, views.student(state, {
      summary: overview(studentId, week), week, current: currentWeek(),
      prior: previousTasks(studentId, week), leaves: sql.studentLeaves.all(studentId),
      choices: topics?.weeklyChoices(studentId) ?? [], publications: topics?.publicationState(state.user, week) ?? {}, done, values, tab
    }), status);
  }

  const routes = [
    ['GET', /^\/student\/weekly\/attachments\/(\d+)$/, 'any', context => files.download(context)],
    ['GET', /^\/teacher\/weekly\/attachments\/(\d+)$/, 'any', context => files.download(context)],
    ['GET', /^\/student\/weekly\/images\/(\d+)$/, 'any', context => files.download({ ...context, inline: true })],
    ['GET', /^\/teacher\/weekly\/images\/(\d+)$/, 'any', context => files.download({ ...context, inline: true })],
    ['GET', /^\/student\/weekly$/, 'student', ({ state, response, url }) => {
      assertStudent(state);
      const week = chooseWeek(url.searchParams.get('week'));
      showStudent(state, response, week, { done: url.searchParams.get('saved'), tab: url.searchParams.get('tab') });
    }],
    ['POST', /^\/student\/weekly$/, 'student', async ({ state, response, form, fields }) => {
      assertStudent(state);
      const week = chooseWeek(form.week);
      try {
        const uploads = await files.readUploads(fields.getAll('attachments'));
        saveReport(state.user.id, week, form, uploads, fields.getAll('retainedAttachment'), fields.getAll('shareKind'));
      } catch (error) {
        if (![400, 413, 422].includes(error.statusCode)) throw error;
        showStudent({ ...state, error: error.message }, response, week, { values: { ...form,
          uploadNeedsRetry: fields.getAll('attachments').some(file => file instanceof File && file.size > 0),
          shareKinds: fields.getAll('shareKind'), retainedAttachment: fields.getAll('retainedAttachment') }, status: error.statusCode });
        return;
      }
      redirect(response, '/student/weekly?week=' + week + '&saved=' + form.action);
    }],
    ['POST', /^\/student\/weekly\/tasks$/, 'student', ({ state, response, form, fields }) => {
      assertStudent(state);
      const week = chooseWeek(form.week);
      saveTaskChanges(state.user.id, week, fields);
      redirect(response, '/student/weekly?week=' + week + '&saved=tasks');
    }],
    ['POST', /^\/student\/weekly\/leave$/, 'student', ({ state, response, form }) => {
      assertStudent(state);
      applyLeave(state.user.id, form);
      redirect(response, '/student/weekly?tab=leave&saved=leave');
    }],
    ['GET', /^\/teacher\/weekly$/, 'teacher', ({ state, response, url }) => {
      const week = chooseWeek(url.searchParams.get('week'));
      const students = accounts.teacherStudents(state.user);
      const visible = new Set(students.map(student => student.id));
      const rows = students.map((student) => overview(student.id, week));
      html(response, views.teacher(state, { week, current: currentWeek(), rows,
        leaves: sql.teacherLeaves.all(endOfWeek(week), week).filter(leave => visible.has(leave.student_id)), reviewed: url.searchParams.get('reviewed') === '1' }));
    }],
    ['GET', /^\/teacher\/weekly\/(\d+)$/, 'teacher', ({ state, response, url, id }) => {
      accounts.assertManageStudent(state.user, id);
      const week = chooseWeek(url.searchParams.get('week'));
      html(response, views.detail(state, { summary: overview(id, week), week, current: currentWeek(),
        prior: previousTasks(id, week), updated: url.searchParams.get('updated') === '1' }));
    }],
    ['POST', /^\/teacher\/weekly\/(\d+)\/policy$/, 'teacher', ({ state, response, id, form }) => {
      accounts.assertManageStudent(state.user, id);
      const week = chooseWeek(form.week);
      policy(id, state.user.id, week, form);
      redirect(response, '/teacher/weekly/' + id + '?week=' + week + '&updated=1');
    }],
    ['POST', /^\/teacher\/weekly\/leave\/(\d+)$/, 'teacher', ({ state, response, id, form }) => {
      const leave = sql.leave.get(id);
      if (!leave) throw httpError(404, '未找到请假申请。');
      accounts.assertManageStudent(state.user, leave.student_id);
      const week = chooseWeek(form.week);
      if (!['approved', 'rejected'].includes(form.decision)) throw httpError(400, '请选择审批结果。');
      const note = limitedText(form.note, '审批说明', 500).trim();
      if (!sql.approveLeave.run(form.decision, state.user.id, note, now(), id).changes) {
        throw httpError(409, '请假申请不存在或已经审批。');
      }
      redirect(response, '/teacher/weekly?week=' + week + '&reviewed=1');
    }]
  ];

  return {
    routes, getReport, currentWeek, overview, taskProgress,
    setTopics(service) { topics = service; },
    progressForTopic(topicId) {
      return sql.progress.all(Number(topicId)).map((row) => {
        const { text, stage } = JSON.parse(row.content).relatedTopic;
        return { studentId: row.student_id, week: row.week, text, stage };
      });
    }
  };
}
