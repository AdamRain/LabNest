const day = 86_400_000;
const shortDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric'
});
const deadlineFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function reportStatus(summary) {
  if (summary.submission === 'submitted') return '已提交';
  if (summary.submission === 'late') return '逾期已交';
  if (summary.obligation === 'leave') return '请假免交';
  if (summary.obligation === 'exempt') return '本周免交';
  if (!summary.required) return '无需提交';
  if (summary.overdue) return '待补交';
  return summary.report?.draft ? '有草稿' : '待提交';
}

export function openStudentDesk({ db, weekly, topics, ui }) {
  const { escapeHtml: e } = ui;
  const graduationTasks = db.prepare(`
    SELECT title, due_date AS dueDate, status FROM graduation_tasks
    WHERE student_id = ? ORDER BY due_date, id
  `);

  function metric(link, value, label, description, target = '') {
    return `<a href="${link}"${target ? ` data-tour-target="${target}"` : ''}><strong>${e(value)}</strong><span>${label}</span>
      ${description ? `<small>${e(description)}</small>` : ''}</a>`;
  }

  function progress(done, total, label) {
    return total ? `<div class="home-desk-progress">
      <progress value="${done}" max="${total}" aria-label="${label}"></progress>
      <span>${done} / ${total}</span>
    </div>` : '';
  }

  return function renderStudentDesk(state) {
    const student = state.user;
    if (student?.role !== 'student' || student.reviewStatus !== 'approved' || student.studentStatus === 'graduated') return '';

    const week = weekly.currentWeek();
    const weekStart = Date.parse(week);
    const end = weekStart + 6 * day;
    const lastWeek = new Date(weekStart - 7 * day).toISOString().slice(0, 10);
    const weeklyPath = '/student/weekly?week=' + encodeURIComponent(week);
    const summary = weekly.overview(student.id, week);
    const priorTasks = weekly.taskProgress(student.id, lastWeek);
    const done = priorTasks.filter(task => task.done).length;
    const graduation = graduationTasks.all(student.id);
    const confirmed = graduation.filter(task => task.status === 'confirmed').length;
    const relatedTopics = topics.weeklyChoices(student.id);
    const deadline = deadlineFormat.format(summary.dueAt);
    const pendingGraduation = graduation.filter(task => task.status !== 'confirmed');
    const reportAction = summary.overdue ? '补交本周周报' : summary.report?.draft ? '继续填写周报' : '填写本周周报';
    const actionItems = [
      [weeklyPath, '周报与请假'],
      ['/student/graduation', '毕业任务'],
      ['/student/topics', '论文课题'],
      ['/student/calendar', '个人日历与顶会 DDL']
    ];
    if (student.level === 'graduate') actionItems.push(['/student/internships', '实习日历']);

    return `<section class="home-desk home-desk--student" aria-labelledby="student-desk-title">
      <header class="home-desk-heading"><h1 id="student-desk-title">学生工作台</h1>
        <p>本周 ${shortDate.format(weekStart)} 至 ${shortDate.format(end)}</p></header>
      <nav class="home-desk-metrics" aria-label="个人工作概览">
        ${metric(weeklyPath, reportStatus(summary), '本周周报', summary.required ? '截止 ' + deadline : '', 'weekly')}
        ${metric(weeklyPath, `${done} / ${priorTasks.length}`, '上周计划完成', priorTasks.length ? '' : '暂无上周计划')}
        ${metric('/student/graduation', `${confirmed} / ${graduation.length}`, '毕业任务已确认', graduation.length ? '' : '暂无分配任务')}
        ${metric('/student/topics', relatedTopics.length, '参与课题', '')}
      </nav>
      <div class="home-desk-grid">
        <div class="home-desk-main">
          <section class="panel home-desk-card home-desk-todo">
            <header class="panel-heading"><h2>我的待办</h2><a href="/student/graduation">全部毕业任务</a></header>
            ${summary.required && summary.submission === 'not-submitted' ? `<p>
              <a href="${weeklyPath}">${reportAction}</a> <span class="field-note">截止 ${e(deadline)}</span>
            </p>` : ''}
            ${progress(confirmed, graduation.length, '毕业任务确认进度')}
            ${pendingGraduation.length ? `<ul class="home-desk-list">
              ${pendingGraduation.slice(0, 3).map(task => `<li><strong>${e(task.title)}</strong>
                <span class="field-note">${e(task.dueDate)} · ${task.status === 'submitted' ? '待确认' : '待完成'}</span></li>`).join('')}
            </ul>` : '<p class="field-note">暂无待办的毕业任务。</p>'}
          </section>
          <section class="panel home-desk-card home-desk-plan">
            <header class="panel-heading"><h2>上周计划回顾</h2><a href="${weeklyPath}">更新完成状态</a></header>
            ${priorTasks.length ? `${progress(done, priorTasks.length, '上周计划完成进度')}
              <ul class="home-desk-list">${priorTasks.slice(0, 4).map(task => `<li>
                <span>${e(task.text)}</span><span class="badge${task.done ? ' badge--approved' : ''}">${task.done ? '已完成' : '待完成'}</span>
              </li>`).join('')}</ul>` : '<p class="empty">暂无上周计划。</p>'}
          </section>
          <section class="panel home-desk-card home-desk-topics">
            <header class="panel-heading"><h2>我的课题</h2><a href="/student/topics">查看课题</a></header>
            ${relatedTopics.length ? `<ul class="home-desk-list">${relatedTopics.slice(0, 4).map(topic => `<li>
              <a href="/student/topics/${encodeURIComponent(topic.id)}">${e(topic.title)}</a>
              <span class="badge">${e(topic.stage)}</span></li>`).join('')}</ul>` : '<p class="empty">你还没有加入课题。</p>'}
          </section>
        </div>
        <div class="home-desk-side">
          <section class="panel home-desk-card home-desk-shortcuts"><h2>常用入口</h2>
            <nav class="home-desk-actions" aria-label="学生常用入口">
              ${actionItems.map(([href, label]) => `<a href="${href}"${href === '/student/calendar' ? ' data-tour-target="calendar"' : ''}>${label}</a>`).join('')}
            </nav>
          </section>
          ${state.dynamics ?? ''}
        </div>
      </div>
    </section>`;
  };
}
