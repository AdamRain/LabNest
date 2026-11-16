import { createManagementViews, resultKinds, todayInShanghai } from './management-views.mjs';

export function openManagement({ db, accounts, ui }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graduation_templates (
      id INTEGER PRIMARY KEY,
      level TEXT NOT NULL CHECK (level IN ('undergraduate','graduate')),
      title TEXT NOT NULL,
      UNIQUE(level,title)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graduation_tasks (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      template_id INTEGER REFERENCES graduation_templates(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','confirmed')),
      student_at TEXT,
      teacher_id INTEGER REFERENCES accounts(id),
      teacher_at TEXT,
      review_note TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS graduation_assignment
      ON graduation_tasks(student_id, template_id) WHERE template_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS internships (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      organization TEXT NOT NULL,
      position TEXT NOT NULL,
      location TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      notes TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      submitted_at TEXT NOT NULL,
      teacher_id INTEGER REFERENCES accounts(id),
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE IF NOT EXISTS management_decisions (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('graduation','internship')),
      record_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES accounts(id),
      decision TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      note TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS member_notices (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      published_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS welcome_dismissals (
      student_id INTEGER PRIMARY KEY REFERENCES accounts(id),
      dismissed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS lab_results (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('paper','patent','research','industry','award')),
      title TEXT NOT NULL,
      result_date TEXT NOT NULL,
      notes TEXT NOT NULL,
      detail TEXT NOT NULL,
      url TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS lab_result_members (
      result_id INTEGER NOT NULL REFERENCES lab_results(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES accounts(id),
      PRIMARY KEY(result_id, student_id)
    ) STRICT;
  `);

  const { html, httpError, redirect } = ui;
  const view = createManagementViews(ui);
  const allTemplates = db.prepare('SELECT * FROM graduation_templates ORDER BY level DESC,id');
  const templateById = db.prepare('SELECT * FROM graduation_templates WHERE id=?');
  const addTemplate = db.prepare('INSERT INTO graduation_templates(level,title) VALUES (?,?) ON CONFLICT DO NOTHING');
  const editTemplate = db.prepare('UPDATE graduation_templates SET level=?,title=? WHERE id=?');
  const deleteTemplate = db.prepare('DELETE FROM graduation_templates WHERE id=?');
  const allTasks = db.prepare(`
    SELECT t.*, a.name, a.level FROM graduation_tasks t JOIN accounts a ON a.id=t.student_id
    ORDER BY due_date,t.id
  `);
  const myTasks = db.prepare('SELECT * FROM graduation_tasks WHERE student_id=? ORDER BY due_date,id');
  const taskById = db.prepare('SELECT * FROM graduation_tasks WHERE id=?');
  const addTask = db.prepare(`
    INSERT INTO graduation_tasks(student_id,template_id,title,due_date) VALUES (?,?,?,?) ON CONFLICT DO NOTHING
  `);
  const dueTask = db.prepare("UPDATE graduation_tasks SET due_date=? WHERE id=? AND status!='confirmed'");
  const submitTask = db.prepare(`
    UPDATE graduation_tasks SET status='submitted',student_at=?,review_note=''
    WHERE id=? AND student_id=? AND status='open'
  `);
  const reviewTask = db.prepare(`
    UPDATE graduation_tasks SET status=?,teacher_id=?,teacher_at=?,review_note=? WHERE id=? AND status='submitted'
  `);
  const allInternships = db.prepare(`
    SELECT i.*, a.name FROM internships i JOIN accounts a ON a.id=i.student_id ORDER BY start_date DESC,i.id DESC
  `);
  const myInternships = db.prepare('SELECT * FROM internships WHERE student_id=? ORDER BY start_date DESC,id DESC');
  const internshipById = db.prepare('SELECT * FROM internships WHERE id=?');
  const addInternship = db.prepare(`
    INSERT INTO internships(student_id,organization,position,location,start_date,end_date,notes,submitted_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const resubmitInternship = db.prepare(`
    UPDATE internships SET organization=?,position=?,location=?,start_date=?,end_date=?,notes=?,submitted_at=?,
      status='pending',teacher_id=NULL,reviewed_at=NULL,review_note='' WHERE id=? AND student_id=? AND status='rejected'
  `);
  const reviewInternship = db.prepare(`
    UPDATE internships SET status=?,teacher_id=?,reviewed_at=?,review_note=? WHERE id=? AND status='pending'
  `);
  const addDecision = db.prepare(`
    INSERT INTO management_decisions(kind,record_id,actor_id,decision,decided_at,note) VALUES (?,?,?,?,?,?)
  `);
  const allNotices = db.prepare('SELECT * FROM member_notices ORDER BY published_at DESC,id DESC');
  const recentNotices = db.prepare('SELECT id,title,published_at FROM member_notices ORDER BY published_at DESC,id DESC LIMIT 3');
  const noticeById = db.prepare('SELECT * FROM member_notices WHERE id=?');
  const addNotice = db.prepare('INSERT INTO member_notices(title,body,published_at,updated_at) VALUES (?,?,?,?)');
  const editNotice = db.prepare('UPDATE member_notices SET title=?,body=?,updated_at=? WHERE id=?');
  const deleteNotice = db.prepare('DELETE FROM member_notices WHERE id=?');
  const welcomed = db.prepare('SELECT 1 FROM welcome_dismissals WHERE student_id=?');
  const dismissWelcome = db.prepare('INSERT OR IGNORE INTO welcome_dismissals(student_id,dismissed_at) VALUES (?,?)');
  const allResults = db.prepare('SELECT * FROM lab_results ORDER BY result_date DESC,id DESC');
  const resultById = db.prepare('SELECT * FROM lab_results WHERE id=?');
  const myResults = db.prepare(`
    SELECT r.* FROM lab_results r JOIN lab_result_members m ON m.result_id=r.id
    WHERE m.student_id=? ORDER BY r.result_date DESC,r.id DESC
  `);
  const resultMembers = db.prepare(`
    SELECT a.id,a.name FROM lab_result_members m JOIN accounts a ON a.id=m.student_id WHERE m.result_id=? ORDER BY a.name,a.id
  `);
  const addResult = db.prepare('INSERT INTO lab_results(kind,title,result_date,notes,detail,url) VALUES (?,?,?,?,?,?)');
  const editResult = db.prepare('UPDATE lab_results SET kind=?,title=?,result_date=?,notes=?,detail=?,url=? WHERE id=?');
  const deleteResult = db.prepare('DELETE FROM lab_results WHERE id=?');
  const unlinkResult = db.prepare('DELETE FROM lab_result_members WHERE result_id=?');
  const linkResult = db.prepare('INSERT INTO lab_result_members(result_id,student_id) VALUES (?,?)');
  const upcomingTasks = db.prepare(`
    SELECT t.title,t.due_date AS date,a.name,t.student_id FROM graduation_tasks t JOIN accounts a ON a.id=t.student_id
    WHERE t.status!='confirmed' AND a.student_status!='graduated' AND a.review_status='approved' AND t.due_date<=?
    ORDER BY t.due_date,t.id
  `);

  const timestamp = () => new Date().toISOString();

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

  function approved(user, { graduateLevel = false } = {}) {
    if (user?.role !== 'student' || user.reviewStatus !== 'approved' || user.studentStatus === 'graduated') {
      throw httpError(403, '该页面仅向已审核的非毕业学生开放。');
    }
    if (graduateLevel && user.level !== 'graduate') throw httpError(403, '实习登记仅向研究生开放。');
    return user;
  }

  function record(query, id) {
    const row = query.get(id);
    if (!row) throw httpError(404, '没有找到这条记录。');
    return row;
  }

  function change(result) {
    if (!result.changes) throw httpError(409, '记录已更新，请刷新页面后再试。');
  }

  function input(value, label, limit, required = true, preserve = false) {
    const original = typeof value === 'string' ? value : '';
    const trimmed = original.trim();
    if (required && !trimmed) throw httpError(400, `请填写${label}。`);
    if (original.length > limit) throw httpError(400, `${label}最多填写 ${limit} 个字符。`);
    return preserve ? original : trimmed;
  }

  function choice(value, values, label) {
    if (!values.includes(value)) throw httpError(400, `请选择有效的${label}。`);
    return value;
  }

  function date(value, label) {
    const raw = input(value, label, 10);
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      throw httpError(400, `请填写有效的${label}。`);
    }
    return raw;
  }

  function identifier(value, label) {
    if (!/^\d+$/.test(String(value ?? '')) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
      throw httpError(400, `请选择有效的${label}。`);
    }
    return Number(value);
  }

  function internshipValues(form) {
    const start = date(form.start, '开始日期');
    const end = date(form.end, '结束日期');
    if (end < start) throw httpError(400, '结束日期须在开始日期当天或之后。');
    if (start < '1900-01-01' || end > '2199-12-31') throw httpError(400, '实习日期须在 1900 年至 2199 年之间。');
    return [
      input(form.organization, '实习单位', 150),
      input(form.position, '岗位', 120),
      input(form.location, '地点', 120, false),
      start, end,
      input(form.notes, '备注', 4000, false, true),
      timestamp()
    ];
  }

  function resultValues(form) {
    const link = input(form.url, '成果链接', 1000, false);
    if (link) {
      const parsed = URL.parse(link);
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw httpError(400, '成果链接须以 http:// 或 https:// 开头。');
      }
    }
    return [
      choice(form.kind, Object.keys(resultKinds), '成果类型'),
      input(form.title, '成果名称', 180),
      date(form.date, '成果日期'),
      input(form.notes, '说明', 6000, false, true),
      input(form.detail, '分类信息', 300, false),
      link
    ];
  }

  function members(ctx) {
    return [...new Set(ctx.fields.getAll('member').map((value) => identifier(value, '参与学生')))].map((id) => {
      const student = accounts.getUser(id);
      if (student?.role !== 'student' || student.reviewStatus !== 'approved') throw httpError(400, '请选择已审核的学生。');
      accounts.assertManageStudent(ctx.state.user, id);
      return id;
    });
  }

  function back(response, path) {
    return redirect(response, `${path}${path.includes('?') ? '&' : '?'}done=management`);
  }

  function show(ctx, content) {
    return html(ctx.response, view.page(ctx.state, content));
  }

  function saveTemplate(ctx) {
    const level = choice(ctx.form.level, ['undergraduate', 'graduate'], '学习层次');
    const title = input(ctx.form.title, '任务名称', 150);
    if (ctx.id) {
      record(templateById, ctx.id);
      if (allTemplates.all().some((item) => item.id !== ctx.id && item.level === level && item.title === title)) {
        throw httpError(409, '此学习层次已有同名任务。');
      }
      editTemplate.run(level, title, ctx.id);
    } else if (!addTemplate.run(level, title).changes) {
      throw httpError(409, '此学习层次已有同名任务。');
    }
    back(ctx.response, '/teacher/graduation');
  }

  function assignTask(ctx) {
    const studentId = identifier(ctx.form.student, '学生');
    accounts.assertManageStudent(ctx.state.user, studentId);
    const student = approved(accounts.getUser(studentId));
    const template = ctx.form.template ? record(templateById, identifier(ctx.form.template, '任务模板')) : null;
    if (template && template.level !== student.level) throw httpError(400, '所选任务模板与学生的学习层次不一致。');
    const title = template ? template.title : input(ctx.form.title, '任务名称', 150);
    const due = date(ctx.form.due, '任务截止日期');
    if (!addTask.run(studentId, template?.id ?? null, title, due).changes) {
      throw httpError(409, '该学生已收到这项模板任务。');
    }
    back(ctx.response, '/teacher/graduation');
  }

  function review(ctx, kind) {
    const isTask = kind === 'graduation';
    const decision = choice(ctx.form.decision, isTask ? ['open', 'confirmed'] : ['approved', 'rejected'], '处理结果');
    const note = input(ctx.form.note, '处理说明', 1000, false, true);
    const time = timestamp();
    const actor = ctx.state.user.id;
    transaction(() => {
      const item = record(isTask ? taskById : internshipById, ctx.id);
      accounts.assertManageStudent(ctx.state.user, item.student_id);
      change((isTask ? reviewTask : reviewInternship).run(decision, actor, time, note, ctx.id));
      addDecision.run(kind, ctx.id, actor, decision, time, note);
    });
    back(ctx.response, isTask ? '/teacher/graduation' : '/teacher/internships');
  }

  function saveNotice(ctx) {
    const title = input(ctx.form.title, '通知标题', 150);
    const body = input(ctx.form.body, '通知正文', 8000, true, true);
    const time = timestamp();
    if (ctx.id) {
      record(noticeById, ctx.id);
      editNotice.run(title, body, time, ctx.id);
    } else {
      addNotice.run(title, body, time, time);
    }
    back(ctx.response, '/teacher/notices');
  }

  function saveResult(ctx) {
    const values = resultValues(ctx.form);
    const students = members(ctx);
    transaction(() => {
      let id = ctx.id;
      if (id) {
        record(resultById, id);
        assertResultAccess(ctx.state.user, id);
        editResult.run(...values, id);
        unlinkResult.run(id);
      } else {
        id = addResult.run(...values).lastInsertRowid;
      }
      for (const student of students) linkResult.run(id, student);
    });
    back(ctx.response, '/teacher/results');
  }

  function assertResultAccess(actor, id) {
    for (const member of resultMembers.all(id)) accounts.assertManageStudent(actor, member.id);
  }
  const eligible = actor => accounts.teacherStudents(actor).filter(student => student.reviewStatus === 'approved');
  const scoped = (actor, rows) => rows.filter(row => accounts.canManageStudent(actor, row.student_id));
  const routes = [
    ['GET', /^\/teacher\/graduation$/, 'teacher', (ctx) =>
      show(ctx, view.teacherGraduation(allTemplates.all(), scoped(ctx.state.user, allTasks.all()), eligible(ctx.state.user).filter((s) => s.studentStatus !== 'graduated')))],
    ['POST', /^\/teacher\/graduation\/templates$/, 'teacher', saveTemplate],
    ['POST', /^\/teacher\/graduation\/templates\/(\d+)$/, 'teacher', saveTemplate],
    ['POST', /^\/teacher\/graduation\/templates\/(\d+)\/delete$/, 'teacher', (ctx) => {
      record(templateById, ctx.id);
      deleteTemplate.run(ctx.id);
      back(ctx.response, '/teacher/graduation');
    }],
    ['POST', /^\/teacher\/graduation\/assign$/, 'teacher', assignTask],
    ['POST', /^\/teacher\/graduation\/tasks\/(\d+)\/due$/, 'teacher', (ctx) => {
      accounts.assertManageStudent(ctx.state.user, record(taskById, ctx.id).student_id);
      change(dueTask.run(date(ctx.form.due, '任务截止日期'), ctx.id));
      back(ctx.response, '/teacher/graduation');
    }],
    ['POST', /^\/teacher\/graduation\/tasks\/(\d+)\/review$/, 'teacher', (ctx) => review(ctx, 'graduation')],
    ['GET', /^\/student\/graduation$/, 'student', (ctx) =>
      show(ctx, view.studentGraduation(myTasks.all(approved(ctx.state.user).id)))],
    ['POST', /^\/student\/graduation\/(\d+)\/complete$/, 'student', (ctx) => {
      const user = approved(ctx.state.user);
      const task = record(taskById, ctx.id);
      if (task.student_id !== user.id) throw httpError(404, '没有找到这条记录。');
      change(submitTask.run(timestamp(), ctx.id, user.id));
      back(ctx.response, '/student/graduation');
    }],
    ['GET', /^\/student\/internships$/, 'student', (ctx) => {
      const user = approved(ctx.state.user, { graduateLevel: true });
      show(ctx, view.studentInternships(myInternships.all(user.id), ctx.url.searchParams.get('month')));
    }],
    ['POST', /^\/student\/internships$/, 'student', (ctx) => {
      const user = approved(ctx.state.user, { graduateLevel: true });
      const values = internshipValues(ctx.form);
      addInternship.run(user.id, ...values);
      back(ctx.response, `/student/internships?month=${values[3].slice(0, 7)}`);
    }],
    ['POST', /^\/student\/internships\/(\d+)\/resubmit$/, 'student', (ctx) => {
      const user = approved(ctx.state.user, { graduateLevel: true });
      if (record(internshipById, ctx.id).student_id !== user.id) throw httpError(404, '没有找到这条记录。');
      const values = internshipValues(ctx.form);
      change(resubmitInternship.run(...values, ctx.id, user.id));
      back(ctx.response, `/student/internships?month=${values[3].slice(0, 7)}`);
    }],
    ['GET', /^\/teacher\/internships$/, 'teacher', (ctx) => show(ctx, view.teacherInternships(scoped(ctx.state.user, allInternships.all())))],
    ['POST', /^\/teacher\/internships\/(\d+)\/review$/, 'teacher', (ctx) => review(ctx, 'internship')],
    ['GET', /^\/teacher\/notices$/, 'teacher', (ctx) => show(ctx, view.teacherNotices(allNotices.all()))],
    ['POST', /^\/teacher\/notices$/, 'teacher', saveNotice],
    ['POST', /^\/teacher\/notices\/(\d+)$/, 'teacher', saveNotice],
    ['POST', /^\/teacher\/notices\/(\d+)\/delete$/, 'teacher', (ctx) => {
      record(noticeById, ctx.id);
      deleteNotice.run(ctx.id);
      back(ctx.response, '/teacher/notices');
    }],
    ['GET', /^\/student\/notices$/, 'student', (ctx) => {
      approved(ctx.state.user);
      show(ctx, view.studentNotices(allNotices.all()));
    }],
    ['GET', /^\/student\/guide$/, 'student', (ctx) => {
      approved(ctx.state.user);
      show(ctx, view.guide());
    }],
    ['POST', /^\/student\/welcome\/dismiss$/, 'student', (ctx) => {
      dismissWelcome.run(approved(ctx.state.user).id, timestamp());
      redirect(ctx.response, '/student');
    }],
    ['GET', /^\/teacher\/results$/, 'teacher', (ctx) => {
      const keyword = ctx.url.searchParams.get('q')?.trim().slice(0, 180) ?? '';
      const kind = ctx.url.searchParams.get('kind') ?? '';
      const items = allResults.all()
        .filter((item) => (!kind || item.kind === kind) && item.title.toLowerCase().includes(keyword.toLowerCase()))
        .map((item) => ({ ...item, members: resultMembers.all(item.id) }))
        .filter(item => item.members.every(member => accounts.canManageStudent(ctx.state.user, member.id)));
      show(ctx, view.teacherResults(items, eligible(ctx.state.user), { keyword, kind }));
    }],
    ['POST', /^\/teacher\/results$/, 'teacher', saveResult],
    ['POST', /^\/teacher\/results\/(\d+)$/, 'teacher', saveResult],
    ['POST', /^\/teacher\/results\/(\d+)\/delete$/, 'teacher', (ctx) => {
      record(resultById, ctx.id);
      assertResultAccess(ctx.state.user, ctx.id);
      deleteResult.run(ctx.id);
      back(ctx.response, '/teacher/results');
    }]
  ];

  function dashboard(user) {
    if (user?.role !== 'student' || user.reviewStatus !== 'approved') return '';
    if (user.studentStatus === 'graduated') {
      return view.alumni(myResults.all(user.id), myInternships.all(user.id));
    }
    return view.studentDashboard({
      notices: recentNotices.all(),
      internships: user.level === 'graduate' ? myInternships.all(user.id) : null
    });
  }

  function reminders(now = new Date(), actor = null) {
    const day = todayInShanghai(now);
    const end = new Date(`${day}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 30);
    return upcomingTasks.all(end.toISOString().slice(0, 10))
      .filter(task => !actor || accounts.canManageStudent(actor, task.student_id)).map((task) => ({
      date: task.date,
      title: task.title,
      detail: task.name,
      href: '/teacher/graduation'
    }));
  }

  return { routes, dashboard, reminders, needsWelcome: studentId => !welcomed.get(studentId) };
}
