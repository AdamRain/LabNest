const dayMs = 24 * 60 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

export function openTeacherDesk({ db, accounts, weekly, topics, ui }) {
  const e = ui.escapeHtml;
  const queueCounts = db.prepare(`
    WITH scoped AS (SELECT value AS id FROM json_each(?))
    SELECT
      (SELECT count(*) FROM accounts WHERE id IN scoped AND review_status='pending') AS applications,
      (SELECT count(*) FROM weekly_leaves WHERE student_id IN scoped AND status='pending') AS leaves,
      (SELECT count(*) FROM internships WHERE student_id IN scoped AND status='pending') AS internships,
      (SELECT count(*) FROM graduation_tasks WHERE student_id IN scoped AND status='submitted') AS graduation,
      (SELECT count(*) FROM paper_topics t WHERE reviewed_at IS NULL AND
        (owner_id IN scoped OR EXISTS (SELECT 1 FROM paper_topic_members m WHERE m.topic_id=t.id AND m.student_id IN scoped))) AS topics
  `);
  const activityCounts = db.prepare(`
    WITH scoped AS (SELECT value AS id FROM json_each(?))
    SELECT local_day AS localDay, kind, count(*) AS total FROM (
      SELECT date(first_submitted_at / 1000.0, 'unixepoch', '+8 hours') AS local_day, 'submit' AS kind
      FROM weekly_reports WHERE first_submitted_at IS NOT NULL AND student_id IN scoped
      UNION ALL
      SELECT date(occurred_at, '+8 hours'), 'review' FROM account_audit
      WHERE action='review' AND new_value IN ('approved','rejected') AND student_id IN scoped
      UNION ALL
      SELECT date(reviewed_at / 1000.0, 'unixepoch', '+8 hours'), 'review'
      FROM weekly_leaves WHERE reviewed_at IS NOT NULL AND student_id IN scoped
      UNION ALL
      SELECT date(d.decided_at, '+8 hours'), 'review' FROM management_decisions d
      WHERE (d.kind='graduation' AND EXISTS (SELECT 1 FROM graduation_tasks g WHERE g.id=d.record_id AND g.student_id IN scoped))
        OR (d.kind='internship' AND EXISTS (SELECT 1 FROM internships i WHERE i.id=d.record_id AND i.student_id IN scoped))
      UNION ALL
      SELECT date(a.recorded_at, '+8 hours'), 'review' FROM paper_topic_actions a
      JOIN paper_topics t ON t.id=a.topic_id WHERE a.action='review' AND
        (t.owner_id IN scoped OR EXISTS (SELECT 1 FROM paper_topic_members m WHERE m.topic_id=t.id AND m.student_id IN scoped))
    ) WHERE local_day BETWEEN ? AND ? GROUP BY local_day, kind
  `);
  const latestNotices = db.prepare(`
    SELECT id, title, published_at AS publishedAt
    FROM member_notices ORDER BY published_at DESC, id DESC LIMIT 3
  `);

  function metric(label, count, href) {
    return `<a class="home-desk-metric" href="${e(href)}"><strong>${count}</strong><span>${label}</span></a>`;
  }

  function bar(label, count, total) {
    return `<div class="home-desk-bar">
      <span>${label}</span>
      <progress class="home-desk-progress" max="${Math.max(1, total)}" value="${count}" aria-label="${label}">${count} / ${total}</progress>
      <strong>${count} / ${total}</strong>
    </div>`;
  }

  function chart(days) {
    const highest = Math.max(...days.flatMap(({ submit, review }) => [submit, review]));
    if (!highest) return '<p class="empty">这 7 天暂无周报首次提交或审核记录。</p>';
    const baseline = 122;
    const height = 100;
    const ticks = highest >= 2 ? [0, Math.floor(highest / 2), highest] : [0, highest];
    const description = days.map(({ date, submit, review }) =>
      `${date.slice(5)}提交 ${submit} 份，审核 ${review} 项`).join('。');
    return `
      <svg class="home-desk-chart" viewBox="0 0 540 150" role="img" aria-labelledby="desk-trend-title desk-trend-desc">
        <title id="desk-trend-title">近 7 天周报提交与审核</title>
        <desc id="desk-trend-desc">${e(description)}</desc>
        ${ticks.map(value => {
          const y = baseline - height * value / highest;
          return `<line class="home-desk-chart-grid" x1="33" y1="${y}" x2="535" y2="${y}"/>
            <text x="27" y="${y + 4}" text-anchor="end">${value}</text>`;
        }).join('')}
        ${days.map(({ date, submit, review }, index) => {
          const x = 68 + index * 71;
          const submitted = height * submit / highest;
          const reviewed = height * review / highest;
          return `<g>
            ${submit ? `<rect class="home-desk-series-submit" x="${x - 14}" y="${baseline - submitted}" width="12" height="${submitted}" rx="2"/>` : ''}
            ${review ? `<rect class="home-desk-series-review" x="${x + 2}" y="${baseline - reviewed}" width="12" height="${reviewed}" rx="2"/>` : ''}
            <text x="${x}" y="143" text-anchor="middle">${e(date.slice(5))}</text>
          </g>`;
        }).join('')}
      </svg>
      <p class="home-desk-chart-key"><span><i class="home-desk-series-submit" aria-hidden="true"></i>周报首次提交</span>
        <span><i class="home-desk-series-review" aria-hidden="true"></i>审核操作</span></p>`;
  }

  function activity(now, scope) {
    const days = Array.from({ length: 7 }, (_, index) => ({
      date: dateFormat.format(now - (6 - index) * dayMs), submit: 0, review: 0
    }));
    const byDate = new Map(days.map(entry => [entry.date, entry]));
    for (const { localDay, kind, total } of activityCounts.all(scope, days[0].date, days[6].date)) {
      byDate.get(localDay)[kind] = total;
    }
    return days;
  }

  return function renderTeacherDesk(state) {
    if (state.user?.role !== 'teacher') return '';
    const students = accounts.teacherStudents(state.user);
    const scope = JSON.stringify(students.map(student => student.id));
    const week = weekly.currentWeek();
    const weekEnd = dateFormat.format(Date.parse(week + 'T00:00:00+08:00') + 6 * dayMs);
    const weeklyPath = '/teacher/weekly?week=' + encodeURIComponent(week);
    const required = students.map(student => weekly.overview(student.id, week))
      .filter(report => report.required);
    const onTime = required.filter(report => report.submission === 'submitted').length;
    const late = required.filter(report => report.submission === 'late').length;
    const missing = required.filter(report => report.submission === 'not-submitted')
      .sort((left, right) => left.dueAt - right.dueAt || left.student.id - right.student.id);
    const overdue = missing.filter(report => report.overdue).length;
    const submitted = onTime + late;
    const queue = queueCounts.get(scope);
    const items = [
      ['注册与资料审核', queue.applications, '/teacher?reviewStatus=pending#students-heading'],
      ['请假审批', queue.leaves, weeklyPath],
      ['实习审核', queue.internships, '/teacher/internships'],
      ['毕业任务确认', queue.graduation, '/teacher/graduation'],
      ['课题审核', queue.topics, '/teacher/topics']
    ];
    const actionCount = items.reduce((total, [, count]) => total + count, 0);
    const byLevel = [
      ['本科生', required.filter(report => report.student.level === 'undergraduate')],
      ['研究生', required.filter(report => report.student.level === 'graduate')]
    ];
    const notices = latestNotices.all();
    return `<section class="home-desk" aria-labelledby="teacher-home-title">
      <header class="home-desk-heading">
        <h1 id="teacher-home-title">教师工作台</h1>
        <p>本周 ${e(week)} 至 ${e(weekEnd)}</p>
      </header>
      <nav class="home-desk-metrics" aria-label="本周周报和待办总览">
        ${metric('本周应交', required.length, weeklyPath)}
        ${metric('已交周报', submitted, weeklyPath)}
        ${metric('待交周报', missing.length, '#home-desk-missing')}
        ${metric('逾期未交', overdue, '#home-desk-missing')}
        ${metric('待处理事项', actionCount, '#home-desk-queue')}
      </nav>
      <div class="home-desk-grid">
        <div class="home-desk-main">
          <section class="panel home-desk-card">
            <header class="home-desk-card-heading"><h2>本周周报进度</h2><a href="${e(weeklyPath)}">查看周报</a></header>
            ${required.length ? `<p><strong>${submitted} / ${required.length}</strong> 位应交学生已提交</p>
              <div class="home-desk-bars">
                ${bar('按时提交', onTime, required.length)}
                ${bar('逾期补交', late, required.length)}
                ${bar('尚未提交', missing.length, required.length)}
                ${byLevel.filter(([, group]) => group.length).map(([label, group]) =>
                  bar(label, group.filter(report => report.submission !== 'not-submitted').length, group.length)).join('')}
              </div>` : '<p class="empty">本周暂无需要提交周报的学生。</p>'}
          </section>
          <section class="panel home-desk-card">
            <header class="home-desk-card-heading"><h2>近 7 天提交与审核</h2></header>
            ${chart(activity(Date.now(), scope))}
          </section>
          <section class="panel home-desk-card" id="home-desk-missing">
            <header class="home-desk-card-heading"><h2>应交未交</h2><a href="${e(weeklyPath)}">完整名单</a></header>
            ${missing.length ? `<ul class="home-desk-list">${missing.slice(0, 6).map(report => `<li>
              <a href="/teacher/weekly/${encodeURIComponent(report.student.id)}?week=${e(week)}">${e(report.student.name)}</a>
              <span>${report.overdue ? '<span class="badge badge--rejected">已逾期</span> ' : ''}
                截止 ${e(timeFormat.format(report.dueAt))}</span>
            </li>`).join('')}</ul>
            ${missing.length > 6 ? `<p class="field-note">另有 ${missing.length - 6} 位学生待交。</p>` : ''}`
            : '<p class="empty">本周暂无应交未交的周报。</p>'}
          </section>
        </div>
        <aside class="home-desk-side" aria-label="教师待办与工具">
          <section class="panel home-desk-card" id="home-desk-queue">
            <header class="home-desk-card-heading"><h2>待我处理</h2></header>
            <ul class="home-desk-list">${items.map(([label, count, href]) =>
              `<li><a href="${e(href)}">${label}</a><strong>${count}</strong></li>`).join('')}</ul>
          </section>
          ${topics?.teacherDashboard(state.user) ?? ''}
          <section class="panel home-desk-card">
            <header class="home-desk-card-heading"><h2>教师工具</h2></header>
            <nav class="home-desk-actions" aria-label="教师快捷工具">
              <a href="/teacher/news/new">发布公开动态</a>
              <a href="/teacher/notices">发布站内通知</a>
              <a href="/teacher/results">管理科研成果</a>
              <a href="/teacher/portal">编辑门户内容</a>
              <a href="/teacher/calendar">打开完整日历</a>
            </nav>
          </section>
          <section class="panel home-desk-card">
            <header class="home-desk-card-heading"><h2>最近发布的通知</h2><a href="/teacher/notices">查看全部</a></header>
            ${notices.length ? `<ul class="home-desk-list">${notices.map(notice =>
              `<li><span>${e(notice.title)}</span><time datetime="${e(notice.publishedAt)}">${e(timeFormat.format(new Date(notice.publishedAt)))}</time></li>`).join('')}</ul>`
              : '<p class="empty">暂无已发布通知。</p>'}
          </section>
        </aside>
      </div>
    </section>`;
  };
}
