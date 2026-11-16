const adminGroups = [['用户管理', [['/admin', '全部用户']]], ['系统设置', [['/admin/mail', '邮件设置']]]];

const teacherGroups = [
  ['日常管理', [
    ['/teacher', '工作台首页'],
    ['/teacher/weekly', '周报与请假'],
    ['/teacher/dynamics', '学生本周动态'],
    ['/teacher/notices', '站内通知'],
    ['/teacher/calendar', '提醒与日历']
  ]],
  ['科研与培养', [
    ['/teacher/topics', '论文课题'],
    ['/teacher/graduation', '毕业任务'],
    ['/teacher/internships', '实习审核'],
    ['/teacher/results', '实验室成果']
  ]],
  ['公开网站', [
    ['/teacher/portal', '门户内容']
  ]]
];

const navIcons = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  weekly: '<path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5m-5 4h5"/>',
  notices: '<path d="M4 10v5h4l9 4V6l-9 4zM8 15l2 5m10-9 2-1m-2 4 2 1"/>',
  calendar: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 4h3m3 0h3m-9 3h3"/>',
  topics: '<path d="M12 6v14m0-14C8 3 5 3 3 4v14c3-1 6-1 9 2m0-14c4-3 7-3 9-2v14c-3-1-6-1-9 2"/>',
  graduation: '<path d="m2 9 10-5 10 5-10 5zm5 3v5c3 2 7 2 10 0v-5m5-3v6"/>',
  internships: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3M3 12l9 3 9-3m-9 2v3"/>',
  results: '<circle cx="12" cy="9" r="5"/><path d="m8 12-2 8 6-3 6 3-2-8"/>',
  portal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18m-13 4h8m-8 4h5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  dynamics: '<path d="M3 12h4l3-6 4 12 3-6h4"/>',
  profile: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 2.8c-.7.3-1 1.2-1 2.2m0 3h.01"/>'
};

function icon(markup) {
  return `<svg class="workspace-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`;
}

function studentGroups(user) {
  const profile = ['/student/profile', '个人信息'];
  if (user.reviewStatus !== 'approved') {
    return [[null, [['/student', '注册进度'], profile]]];
  }
  if (user.studentStatus === 'graduated') {
    return [[null, [['/student', '工作台首页'], ['/student/dynamics', '本周动态'], profile]]];
  }
  const training = [
    ['/student/topics', '论文课题'],
    ['/student/graduation', '毕业任务']
  ];
  if (user.level === 'graduate') training.push(['/student/internships', '实习日历']);
  return [
    ['日常事务', [
      ['/student', '工作台首页'],
      ['/student/weekly', '周报与请假'],
      ['/student/calendar', '个人日历与会议 DDL'],
      ['/student/dynamics', '本周动态'],
      ['/student/notices', '站内通知']
    ]],
    ['科研与培养', training],
    ['账号', [profile, ['/student/guide', '使用指引']]]
  ];
}

function currentLink(groups, path, home) {
  if (home === '/teacher') {
    if (path === '/teacher/news/new') return path;
    if (path.startsWith('/teacher/news/')) return '/teacher/portal';
  }

  for (const [, links] of groups) {
    const match = links.find(([href]) => path === href || (href !== home && path.startsWith(href + '/')));
    if (match) return match[0];
  }
  return home;
}

function menuLinks(groups, current) {
  return groups.map(([title, links]) => `
    <div class="workspace-nav-group">
      ${title ? `<p class="workspace-nav-label">${title}</p>` : ''}
      <ul class="workspace-nav-list">
        ${links.map(([href, label]) => {
          const graphic = navIcons[href.split('/')[2]] ?? navIcons.home;
          const target = href === '/student/profile' ? 'profile' : href === '/student/guide' ? 'guide' : '';
          return `<li><a class="workspace-nav-link" href="${href}"${href === current ? ' aria-current="page"' : ''}${target ? ` data-tour-target="${target}"` : ''}>${icon(graphic)}<span>${label}</span></a></li>`;
        }).join('')}
      </ul>
    </div>
  `).join('');
}

function publishLink(current) {
  return `<a class="workspace-publish-link" href="/teacher/news/new"${current === '/teacher/news/new' ? ' aria-current="page"' : ''}>${icon('<path d="M12 5v14M5 12h14"/>')}发布公开动态</a>`;
}

function menu(groups, current, isTeacher, pendingCount, showPublish = false) {
  return `<nav class="workspace-nav" aria-label="${isTeacher ? '教师功能' : '学生功能'}">
    ${isTeacher && (showPublish || pendingCount > 0) ? `<div class="workspace-publish">
      ${showPublish ? publishLink(current) : ''}
      ${pendingCount > 0 ? `<a class="workspace-review-link" href="/teacher?reviewStatus=pending#students-heading">待审核申请 <span>${pendingCount}</span></a>` : ''}
    </div>` : ''}
    ${menuLinks(groups, current)}
    <a class="workspace-public-link" href="${isTeacher ? "/portal" : "/student/homepage"}">${isTeacher ? "预览展示网站" : "个人主页与简历"} ${icon('<path d="M7 17 17 7M7 7h10v10"/>')}</a>
  </nav>`;
}

export function workspaceFrame(state, inner, { pendingCount = 0 } = {}) {
  const user = state.user;
  if (!['admin', 'teacher', 'student'].includes(user?.role)) return inner;
  if (user.role !== 'admin' && user.reviewStatus !== 'approved') return inner;

  const isTeacher = user.role === 'teacher';
  const isAdmin = user.role === 'admin';
  const home = isAdmin ? '/admin' : isTeacher ? '/teacher' : '/student';
  const path = state.path ?? state.pathname ?? home;
  const groups = isAdmin ? adminGroups : isTeacher ? teacherGroups : studentGroups(user);
  const current = currentLink(groups, path, home);
  const section = current === '/teacher/news/new'
    ? '发布公开动态'
    : groups.flatMap(([, links]) => links).find(([href]) => href === current)?.[1];
  const count = Number.isSafeInteger(pendingCount) ? pendingCount : 0;

  return `<div class="workspace-shell">
    <aside class="workspace-rail">
      <div class="workspace-rail-head">
        <span class="workspace-rail-mark">${icon('<path d="m12 2 9 5v10l-9 5-9-5V7zM7 9h3l2 2h5m-10 4h4l2-2h4"/><circle cx="17" cy="11" r=".8"/><circle cx="7" cy="15" r=".8"/>')}</span>
        <p class="workspace-rail-title">${isAdmin ? '管理员工作台' : isTeacher ? '教师工作台' : '学生工作台'}</p>
      </div>
      ${isAdmin ? `<nav class="workspace-nav" aria-label="管理员功能">${menuLinks(groups, current)}</nav>` : menu(groups, current, isTeacher, count, true)}
    </aside>
    <div class="workspace-mobile-tools">
      <details class="workspace-mobile-menu">
        <summary>${icon('<path d="M5 7h14M5 12h14M5 17h14"/>')}<span>工作台菜单<small>${section}</small></span>${icon('<path d="m6 9 6 6 6-6"/>')}</summary>
        ${isAdmin ? `<nav class="workspace-nav" aria-label="管理员功能">${menuLinks(groups, current)}</nav>` : menu(groups, current, isTeacher, count)}
      </details>
      ${isTeacher && current !== '/teacher/news/new' ? publishLink(current) : ''}
    </div>
    <div id="workspace-content" class="workspace-content" tabindex="-1">${inner}</div>
  </div>`;
}
