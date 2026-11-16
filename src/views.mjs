import { workspaceFrame } from './workspace-ui.mjs';
import { themeHead, themeControl } from './theme-ui.mjs';

const siteName = '实验室管理平台';

const categories = {
  lab: '中心动态',
  reading: '论文学习',
};

const levels = {
  undergraduate: '本科生',
  graduate: '研究生',
};

const studentStatuses = {
  active: '在读',
  admitted: '保研待入学',
  graduated: '已毕业',
};

const relationships = {
  direct: '教师直接指导',
  assisted: '教师协助指导',
};

const activities = ['竞赛', '小论文', '本科论文', '学年论文', '毕业设计', '研究生毕业论文'];

const reviewStatuses = {
  pending: '待审核',
  approved: '审核通过',
  rejected: '审核未通过',
};

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Asia/Shanghai',
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function token(state) {
  return `<input type="hidden" name="csrf" value="${escapeHtml(state.csrf)}">`;
}

function dateMarkup(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `<time datetime="${date.toISOString()}">${dateFormat.format(date)}</time>`;
}

function accountPath(user) {
  return user.role === 'admin' ? '/admin' : user.role === 'teacher' ? (user.reviewStatus === 'approved' ? '/teacher' : '/teacher/pending') : '/student';
}

export function layout(state, title, content, { accountEntry = false } = {}) {
  const { user, error, notice } = state;
  const awaitingApproval = ['student', 'teacher'].includes(user?.role) && user.reviewStatus !== 'approved';
  const inWorkspace = user && !awaitingApproval && /^\/(?:admin|teacher|student)(?:\/|$)/.test(state.path ?? '');
  const headingName = inWorkspace ? '实验室工作台' : (state.siteName ?? siteName);
  const inner = `
    ${error ? `<p class="flash flash--error" role="alert">${escapeHtml(error)}</p>` : ''}
    ${notice ? `<p class="flash flash--notice" role="status">${escapeHtml(notice)}</p>` : ''}
    ${content}`;
  const accountLinks = user
    ? `${awaitingApproval ? (state.path === accountPath(user) ? '' : `<a class="button button--plain" href="${accountPath(user)}">注册进度</a>`)
      : `<a class="button button--plain" href="${accountPath(user)}">工作台</a>`}
       <form action="/logout" method="post">${token(state)}
         <button class="button button--quiet" type="submit">退出登录</button>
       </form>`
    : `<a class="button button--primary" href="/login">登录</a>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title ? `${title} · ${headingName}` : headingName)}</title>
  <link rel="icon" href="/lab-logo.png">
  <link rel="stylesheet" href="/app.css">
  <link rel="stylesheet" href="/topics.css">
  <link rel="stylesheet" href="/workspace.css">
  ${state.path === '/teacher/portal' || state.path?.startsWith('/teacher/portal/logo') ? '<link rel="stylesheet" href="/portal.css">' : ''}
  ${inWorkspace && user.role === 'admin' ? '<link rel="stylesheet" href="/admin.css">' : ''}
  ${inWorkspace ? '<link rel="stylesheet" href="/home-desk.css"><link rel="stylesheet" href="/calendar-preview.css"><script src="/calendar-preview.js" defer></script>' : ''}
  ${inWorkspace && user.role === 'student' ? '<script src="/student-dynamics.js?v=publication-checkbox-20261112" defer></script>' : ''}
  ${inWorkspace && /^\/(student|teacher)\/weekly(?:\/|$)/.test(state.path ?? '') ? '<link rel="stylesheet" href="/weekly.css">' : ''}
  ${inWorkspace && state.path === '/student/weekly' ? '<script src="/weekly-editor.js" defer></script>' : ''}
  ${state.tour ? '<link rel="stylesheet" href="/student-tour.css"><script src="/student-tour.js" defer></script>' : ''}
  ${accountEntry ? '<link rel="stylesheet" href="/accounts.css">' : ''}
  ${state.path === '/login' ? '<script src="/login.js" defer></script>' : ''}
  ${themeHead()}
</head>
<body${inWorkspace ? ' class="workspace-page"' : accountEntry ? ' class="account-page"' : ''}>
  <a class="skip-link" href="#${inWorkspace ? 'workspace-content' : 'content'}">跳到正文</a>
  <header class="site-header">
    <div class="frame masthead">
      <a href="/" class="brand"><img class="brand-mark" src="/lab-logo.png" width="40" height="40" alt="">${escapeHtml(headingName)}</a>
      <nav aria-label="账号">${themeControl()}${accountLinks}</nav>
    </div>
  </header>
  <main class="frame main" id="content">
    ${inWorkspace ? workspaceFrame(state, inner, { pendingCount: state.pendingCount }) : inner}
  </main>
</body>
</html>`;
}

function sectionHeading(title, note = '') {
  return `<header class="page-heading">
    <h1>${title}</h1>
    ${note ? `<p>${note}</p>` : ''}
  </header>`;
}

function selectOptions(options, current) {
  return Object.entries(options).map(([value, label]) =>
    `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`
  ).join('');
}

function accountPage(state, title, content, type) {
  return layout(state, title, `
    <div class="account-shell account-shell--${type}">
      <div class="account-identity">
        <div class="account-art" aria-hidden="true">
          <img src="/lab-logo.png" width="112" height="112" alt="">
        </div>
        ${state.centerName ? `<p>${escapeHtml(state.centerName)}</p>` : ''}
      </div>
      <section class="account-panel">${content}</section>
    </div>`, { accountEntry: true });
}

function loginEntryPage(state, { title, note, content, headingId = 'login-title' }) {
  const name = state.siteName || siteName;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f3f8f6">
  <title>${escapeHtml(title)} · ${escapeHtml(name)}</title>
  <link rel="icon" href="/lab-logo.png">
  <link rel="stylesheet" href="/login-entry.css?v=liquid-flow-20261111">
  <script src="/login.js?v=liquid-flow-20261111" defer></script>
  ${themeHead()}
</head>
<body class="login-entry-page">
  <a class="skip-link" href="#content">跳到表单</a>
  <div class="login-theme-control">${themeControl()}</div>
  <button class="login-motion-toggle" type="button" data-background-toggle aria-controls="login-ambient"
    aria-label="播放背景动效" aria-pressed="false" hidden>
    <svg data-background-icon="pause" width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" hidden><path d="M8 5v14M16 5v14"/></svg>
    <svg data-background-icon="play" width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>
    <span data-background-label>播放动效</span>
  </button>
  <main class="login-entry" id="content" tabindex="-1">
    <div class="login-entry-ambient" id="login-ambient" aria-hidden="true"></div>
    <div class="login-entry-wrap">
      <header class="login-entry-brand">
        <img src="/lab-logo.png" width="64" height="64" alt="">
        <h1>${escapeHtml(name)}</h1>
        <p>成员工作台</p>
      </header>
      <section class="login-entry-card" aria-labelledby="${headingId}">
        <header class="login-entry-heading">
          <h2 id="${headingId}">${escapeHtml(title)}</h2>
          ${note ? `<p>${escapeHtml(note)}</p>` : ''}
        </header>
        ${state.error ? `<p class="login-entry-error" role="alert">${escapeHtml(state.error)}</p>` : ''}
        ${state.notice ? `<p class="login-entry-notice" role="status">${escapeHtml(state.notice)}</p>` : ''}
        ${content}
      </section>
      ${state.centerName ? `<footer class="login-entry-footer">${escapeHtml(state.centerName)}</footer>` : ''}
    </div>
  </main>
</body>
</html>`;
}

function passwordToggle(inputId, buttonId) {
  return `<button${buttonId ? ` id="${buttonId}"` : ''} class="password-toggle" type="button"
    data-password-toggle aria-controls="${inputId}" aria-label="显示密码" title="显示密码" aria-pressed="false" hidden>
    <svg data-password-icon="show" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>
    </svg>
    <svg data-password-icon="hide" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden>
      <path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.1 4.2M6.2 6.2A21 21 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.8-1.8M10 10a3 3 0 0 0 4 4"/>
    </svg>
  </button>`;
}

export function loginPage(state, values = {}) {
  return loginEntryPage(state, {
    title: '登录',
    content: `<form class="login-entry-form" method="post" action="/login">
      ${token(state)}
      <label>邮箱或手机号
        <input name="identifier" autocomplete="username" spellcheck="false" autocapitalize="none"
          value="${escapeHtml(values.identifier)}" required>
      </label>
      <div>
        <div class="login-entry-label-row">
          <label for="login-password">密码</label>
          <a href="/forgot-password">忘记密码？</a>
        </div>
        <div class="password-field">
          <input id="login-password" name="password" type="password" autocomplete="current-password" required>
          ${passwordToggle('login-password', 'login-show-password')}
        </div>
      </div>
      <button class="login-entry-submit" type="submit">登录</button>
    </form>
    <p class="login-entry-registration">还没有账号？<a href="/register">学生注册</a> · <a href="/register/teacher">教师注册</a></p>`
  });
}

export function forgotPasswordPage(state, values = {}) {
  const content = state.recoverySent
    ? '<p class="login-entry-notice" role="status">如果该邮箱已绑定账号，你会收到重置邮件。请检查收件箱和垃圾邮件。</p>'
    : state.recoveryConfigured
      ? `<form class="login-entry-form" method="post" action="/forgot-password">
          ${token(state)}
          <label>账号绑定的邮箱
            <input name="email" type="email" autocomplete="email" maxlength="254" spellcheck="false" autocapitalize="none"
              value="${escapeHtml(values.email)}" required>
          </label>
          <button class="login-entry-submit" type="submit">发送重置邮件</button>
        </form>`
      : '<p class="login-entry-notice" role="status">邮件找回尚未启用，请联系管理员处理。</p>';
  return loginEntryPage(state, {
    title: '忘记密码', headingId: 'forgot-password-title',
    note: state.recoverySent ? '' : '重置链接将发送到账号绑定的邮箱。',
    content: `${content}<p class="login-entry-back"><a href="/login">返回登录</a></p>`
  });
}

export function resetPasswordPage(state, values = {}) {
  const content = state.resetValid
    ? `<form class="login-entry-form" method="post" action="/reset-password">
        ${token(state)}
        <input type="hidden" name="resetToken" value="${escapeHtml(values.resetToken)}">
        <div>
          <label for="reset-password">新密码</label>
          <div class="password-field">
            <input id="reset-password" name="password" type="password" autocomplete="new-password"
              minlength="8" maxlength="128" aria-describedby="reset-password-note" required>
            ${passwordToggle('reset-password')}
          </div>
          <p class="login-entry-field-note" id="reset-password-note">8 至 128 个字符。</p>
        </div>
        <div>
          <label for="reset-confirm-password">确认新密码</label>
          <div class="password-field">
            <input id="reset-confirm-password" name="confirmPassword" type="password" autocomplete="new-password"
              minlength="8" maxlength="128" required>
            ${passwordToggle('reset-confirm-password')}
          </div>
        </div>
        <button class="login-entry-submit" type="submit">设置新密码</button>
      </form>`
    : `<p class="login-entry-notice" role="status">链接已失效或已使用，请重新申请。</p>
      <p class="login-entry-back"><a href="/forgot-password">重新申请重置邮件</a></p>`;
  return loginEntryPage(state, {
    title: '设置新密码', headingId: 'reset-password-title',
    note: state.resetValid ? '设置完成后，请使用新密码登录。' : '',
    content: `${content}<p class="login-entry-back"><a href="/login">返回登录</a></p>`
  });
}

export function mailSettingsPage(state, values = {}) {
  const configured = Boolean(values.configured);
  const passwordNote = values.hasPassword
    ? '授权码已保存，保存后不再显示。留空保留原授权码，重新填写可替换。'
    : '填写邮箱的 SMTP 授权码或专用密码。';
  return layout(state, '邮件找回设置', `
    <section class="panel form-panel">
      ${sectionHeading('邮件找回设置', '重置邮件发送到账号已绑定的邮箱。')}
      <div class="stack">
        <p class="field-note" role="status">${configured
          ? '邮件找回已启用。'
          : '邮件找回尚未启用，请先填写发件邮箱配置。'}</p>
        ${values.configurationError ? `<p class="flash flash--error" role="alert">${escapeHtml(values.configurationError)}</p>` : ''}
        <form class="stack" method="post" action="/admin/mail">
          ${token(state)}
          <div class="form-grid">
            <label>SMTP 服务器地址
              <input name="smtpHost" maxlength="253" autocomplete="off" spellcheck="false" autocapitalize="none"
                placeholder="smtp.example.com" value="${escapeHtml(values.smtpHost)}" required>
            </label>
            <label>SMTP 端口
              <select name="smtpPort">${selectOptions({ '465': '465（SSL/TLS）', '587': '587（STARTTLS）' }, String(values.smtpPort || '465'))}</select>
            </label>
            <label class="span-full">发件邮箱账号
              <input name="smtpUser" type="email" maxlength="254" autocomplete="off" spellcheck="false" autocapitalize="none"
                value="${escapeHtml(values.smtpUser)}" required>
            </label>
            <label class="span-full"><span>邮箱授权码或专用密码${values.hasPassword ? ' <span class="badge badge--approved">已保存</span>' : ''}</span>
              <input name="smtpPassword" type="password" autocomplete="new-password" maxlength="1024"
                placeholder="${values.hasPassword ? '已保存，留空保留' : '请输入邮箱授权码'}"
                aria-describedby="mail-password-note"${values.hasPassword ? '' : ' required'}>
              <span class="field-note" id="mail-password-note">${passwordNote}</span>
            </label>
            <label class="span-full">发件地址（选填）
              <input name="smtpFrom" type="email" maxlength="254" autocomplete="off" spellcheck="false" autocapitalize="none"
                value="${escapeHtml(values.smtpFrom)}">
              <span class="field-note">留空使用上方的发件邮箱账号。</span>
            </label>
            <label class="span-full">网站访问地址
              <input name="publicUrl" type="url" maxlength="2048" autocomplete="off" spellcheck="false" autocapitalize="none"
                value="${escapeHtml(values.publicUrl)}" required>
              <span class="field-note">填写师生实际访问的网站地址。</span>
            </label>
          </div>
          <div class="actions">
            <button class="button button--primary" type="submit">保存并启用</button>
            <a class="button button--quiet" href="/admin">返回工作台</a>
          </div>
        </form>
        ${configured ? `<form method="post" action="/admin/mail/disable">
          ${token(state)}<button class="button button--plain" type="submit">停用邮件找回</button>
        </form>` : ''}
      </div>
    </section>`);
}

function applicationFields(values) {
  const selectedActivities = Array.isArray(values.activities) ? values.activities : [values.activities];
  return `
    <div class="form-grid application-fields">
      <label>姓名
        <input name="name" autocomplete="name" maxlength="80" value="${escapeHtml(values.name)}" required>
      </label>
      <label>专业
        <input name="major" maxlength="100" value="${escapeHtml(values.major)}" required>
      </label>
      <label>邮箱
        <input name="email" type="email" autocomplete="email" maxlength="254" spellcheck="false" autocapitalize="none" aria-describedby="contact-note"
          value="${escapeHtml(values.email)}" required>
      </label>
      <label>手机号（选填）
        <input name="phone" type="tel" autocomplete="tel" aria-describedby="contact-note"
          value="${escapeHtml(values.phone)}">
      </label>
      <p id="contact-note" class="field-note span-full">邮箱用于登录和找回密码，请填写常用邮箱。手机号选填，填写后也可登录。</p>
      <label>学习层次
        <select name="level">${selectOptions(levels, values.level)}</select>
      </label>
      <label>学生状态
        <select name="studentStatus">${selectOptions(studentStatuses, values.studentStatus)}</select>
      </label>
      <label>学号
        <input name="studentNumber" maxlength="32" value="${escapeHtml(values.studentNumber)}">
        <span class="field-note">保研待入学或已毕业的学生可留空。</span>
      </label>
      <label>指导关系
        <select name="relationship">${selectOptions(relationships, values.relationship)}</select>
      </label>
      <label class="span-full">导师姓名
        <input name="advisor" maxlength="100" value="${escapeHtml(values.advisor)}">
        <span class="field-note">选择教师协助指导时，请填写你的导师姓名。</span>
      </label>
      <fieldset class="activity-field span-full">
        <legend>参与事项 <span class="field-note">可多选</span></legend>
        <div class="choices">${activities.map((activity) =>
          `<label><input type="checkbox" name="activities" value="${activity}"${selectedActivities.includes(activity) ? ' checked' : ''}>
            ${activity}</label>`
        ).join('')}</div>
      </fieldset>
    </div>`;
}

export function registerPage(state, values = {}) {
  return accountPage(state, '学生注册', `
      ${sectionHeading('学生注册', '提交申请后，可登录查看教师的审核结果。')}
      <form class="stack" action="/register" method="post">
        ${token(state)}
        ${applicationFields(values)}
        <label>主指导教师
          <select name="primaryTeacherId" required>
            ${(state.teachers?.length ?? 0) === 1 ? '' : '<option value="">请选择主指导教师</option>'}
            ${(state.teachers ?? []).map(teacher => `<option value="${teacher.id}"${String(values.primaryTeacherId) === String(teacher.id) ? ' selected' : ''}>${escapeHtml(teacher.name)}</option>`).join('')}
          </select>
          <span class="field-note">副指导教师由管理员分配。${state.teachers?.length ? '' : '当前暂无可选教师，请联系管理员。'}</span>
        </label>
        <label>登录密码
          <input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
          <span class="field-note">密码至少 8 个字符。</span>
        </label>
        <button class="button button--primary" type="submit">提交申请</button>
      </form>
      <p class="form-footer">已有账号？<a href="/login">登录</a></p>
    `, 'register');
}

export function teacherRegisterPage(state, values = {}) {
  return accountPage(state, '教师注册', `
    ${sectionHeading('教师注册', '管理员审核通过后，即可进入教师工作台。')}
    <form class="stack" action="/register/teacher" method="post">
      ${token(state)}
      <label>姓名<input name="name" autocomplete="name" maxlength="80" value="${escapeHtml(values.name)}" required></label>
      <label>邮箱<input name="email" type="email" autocomplete="email" maxlength="254" value="${escapeHtml(values.email)}" required>
        <span class="field-note">用于登录和密码找回。</span></label>
      <label>手机号（选填）<input name="phone" type="tel" autocomplete="tel" value="${escapeHtml(values.phone)}"></label>
      <label>登录密码<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
      <button class="button button--primary" type="submit">提交教师申请</button>
    </form>
    <p class="form-footer">已有账号？<a href="/login">登录</a> · <a href="/register">学生注册</a></p>`, 'register');
}

export function teacherPendingPage(state) {
  const rejected = state.user.reviewStatus === 'rejected';
  return layout(state, '教师注册进度', `<section class="panel form-panel">
    ${sectionHeading(rejected ? '教师申请未通过' : '请等待管理员审核')}
    <p>${rejected ? '请联系管理员确认申请资料。' : '你的教师注册申请已提交，审核通过后即可使用工作台。'}</p>
    ${state.user.reviewReason ? `<p>审核说明：${escapeHtml(state.user.reviewReason)}</p>` : ''}
    <p class="field-note">${escapeHtml(state.user.name)} · ${escapeHtml(state.user.email)}</p>
  </section>`);
}

function statusBadge(status) {
  const tone = status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'pending';
  return `<span class="badge badge--${tone}">${escapeHtml(reviewStatuses[status] ?? '')}</span>`;
}

function studentFacts(student) {
  const fields = [
    ['学习层次', levels[student.level]],
    ['学生状态', studentStatuses[student.studentStatus]],
    ['专业', student.major],
    ['学号', student.studentNumber],
    ['主指导教师', student.primaryTeacherName],
    ['副指导教师', student.secondaryTeacherName || '未设置'],
    ['指导关系', relationships[student.relationship]],
    ['导师姓名', student.advisor],
    ['参与事项', Array.isArray(student.activities) ? student.activities.join('、') : student.activities],
    ['邮箱', student.email],
    ['手机号', student.phone],
    ['生日', student.birthday],
  ];
  return `<dl class="facts">${fields.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${escapeHtml(value || '未填写')}</dd></div>`
  ).join('')}</dl>`;
}

function reviewForm(state, student) {
  return `<form class="record-form" action="/teacher/students/${encodeURIComponent(student.id)}/review" method="post">
    ${token(state)}
    <label>审核说明
      <input name="reason" maxlength="500" placeholder="可填写审核意见">
    </label>
    <div class="actions">
      <button class="button button--primary" type="submit" name="decision" value="approved">通过</button>
      <button class="button button--danger" type="submit" name="decision" value="rejected">驳回</button>
    </div>
  </form>`;
}

function studentStatusForm(state, student) {
  return `<form class="record-form record-form--inline" action="/teacher/students/${encodeURIComponent(student.id)}/status" method="post">
    ${token(state)}
    <label>调整学生状态
      <select name="studentStatus">${selectOptions(studentStatuses, student.studentStatus)}</select>
    </label>
    <label>学号
      <input name="studentNumber" maxlength="32" value="${escapeHtml(student.studentNumber)}">
      <span class="field-note">转为在读时须有学号。</span>
    </label>
    <button class="button button--plain" type="submit">保存状态</button>
  </form>`;
}

function studentRecord(state, student) {
  const initial = Array.from(student.name.trim())[0] || '学';
  return `<li class="record desk-student" data-student-id="${escapeHtml(student.id)}" data-review-status="${escapeHtml(student.reviewStatus)}">
    <header class="record-head">
      <div class="desk-student-identity">
        <span class="desk-student-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
        <div><h3>${escapeHtml(student.name)}</h3>
          <p class="desk-student-meta">${escapeHtml(levels[student.level] ?? '')}${student.major ? ' / ' + escapeHtml(student.major) : ''}</p></div>
      </div>
      ${statusBadge(student.reviewStatus)}
    </header>
    <details${student.reviewStatus === 'pending' ? ' open' : ''}>
      <summary>查看档案与操作</summary>
      ${studentFacts(student)}
      ${profileReviewChanges(state.profileChanges?.get(student.id))}
      ${state.photoOwners?.has(student.id) ? photoMarkup(student.id) : ''}
      ${student.reviewReason ? `<p class="review-note">审核说明：${escapeHtml(student.reviewReason)}</p>` : ''}
      ${student.reviewStatus === 'pending' ? reviewForm(state, student) : ''}
      ${student.reviewStatus === 'approved' ? studentStatusForm(state, student) : ''}
    </details>
  </li>`;
}

function profileReviewChanges(change) {
  if (!change) return '';
  const labels = { name: '姓名', email: '邮箱', phone: '手机号', level: '学习层次', studentStatus: '学生状态',
    studentNumber: '学号', major: '专业', relationship: '指导关系', advisor: '导师姓名', activities: '参与事项' };
  const choices = { level: levels, studentStatus: studentStatuses, relationship: relationships };
  const display = (key, value) => escapeHtml((Array.isArray(value) ? value.join('、') : choices[key]?.[value] ?? value) || '未填写');
  const changed = Object.keys(labels).filter(key => JSON.stringify(change.previous[key]) !== JSON.stringify(change.next[key]));
  if (!changed.length) return '';
  return `<details class="profile-review-changes" open><summary>本次资料修改</summary>
    <ul>${changed.map(key => `<li><strong>${labels[key]}</strong><p>修改前：${display(key, change.previous[key])}<br>修改后：${display(key, change.next[key])}</p></li>`).join('')}</ul></details>`;
}

function teacherNewsList(state, articles) {
  if (!articles.length) return '<p class="empty">暂无新闻。</p>';
  return `<ul class="editor-list">${articles.map((article) => {
    const id = encodeURIComponent(article.id);
    return `<li class="editor-row">
      <div class="editor-title">
        ${article.visibility === 'draft'
          ? `<a href="/teacher/news/${id}/edit">${escapeHtml(article.title)}</a>`
          : `<a href="/news/${id}">${escapeHtml(article.title)}</a>`}
        <div class="article-meta">
          <span class="badge">${escapeHtml(categories[article.category] ?? '')}</span>
          ${article.eventDate ? escapeHtml(article.eventDate) : dateMarkup(article.createdAt)}
          <span class="badge">${article.visibility === 'draft' ? '草稿' : '访客可见'}</span>
        </div>
      </div>
      <div class="actions">
        <a class="button button--plain" href="/teacher/news/${id}/edit">编辑</a>
        <details class="delete">
          <summary class="button button--quiet">删除</summary>
          <form action="/teacher/news/${id}/delete" method="post">
            ${token(state)}
            <button class="button button--danger" type="submit">确认删除</button>
          </form>
        </details>
      </div>
    </li>`;
  }).join('')}</ul>`;
}

const studentFilters = [
  ['level', '学习层次', levels],
  ['studentStatus', '学籍状态', studentStatuses],
  ['relationship', '指导关系', relationships],
  ['reviewStatus', '审核状态', reviewStatuses],
  ['activity', '参与事项', Object.fromEntries(activities.map(item => [item, item]))]
];

function filterForm(query) {
  return `<form action="/teacher#students-heading" method="get" class="record-form desk-filter-form">
    <label>姓名<input name="name" type="search" value="${escapeHtml(query?.get('name'))}"></label>
    ${studentFilters.map(([key, label, options]) => `<label>${label}
      <select name="${key}"><option value="">全部</option>${selectOptions(options, query?.get(key))}</select></label>`).join('')}
    <div class="actions desk-filter-actions"><button class="button button--primary" type="submit">筛选</button>
      <a class="button button--quiet" href="/teacher#students-heading">清除筛选</a></div>
  </form>`;
}

export function teacherPage(state, students, articles, query) {
  const pendingCount = students.filter(student => student.reviewStatus === 'pending').length;
  const name = query?.get('name')?.trim().toLowerCase() ?? '';
  const filtering = Boolean(name || studentFilters.some(([key]) => query?.get(key)));
  const visibleStudents = students.filter(student => student.name.toLowerCase().includes(name)
    && studentFilters.every(([key]) => {
      const value = query?.get(key);
      return !value || (key === 'activity' ? student.activities.includes(value) : student[key] === value);
    })).sort((left, right) => Number(right.reviewStatus === 'pending') - Number(left.reviewStatus === 'pending'));
  return layout(state, '教师工作台', `
    ${state.desk ?? sectionHeading('教师工作台')}
    ${state.calendarContent ? `<div class="home-calendar">${state.calendarContent}</div>` : ''}
    <div class="dashboard-grid desk-dashboard">
      <section class="panel dashboard-section desk-panel" aria-labelledby="students-heading">
        <header class="panel-heading">
          <h2 id="students-heading">学生管理</h2>
          <span class="badge badge--pending">${pendingCount} 人待审核</span>
        </header>
        <details class="desk-filters"${filtering ? ' open' : ''}><summary>筛选学生</summary>${filterForm(query)}</details>
        ${visibleStudents.length
          ? `<p class="field-note desk-students-help">待审核学生优先显示，可在名单内滚动查看。</p>
            <div class="desk-students-scroll" role="region" aria-label="学生管理名单" tabindex="0">
              <ul class="record-list">${visibleStudents.map((student) => studentRecord(state, student)).join('')}</ul>
            </div>`
          : `<p class="empty">${students.length ? '没有符合条件的学生。' : '暂无学生申请。'}</p>`}
      </section>
      <section class="panel dashboard-section desk-panel" aria-labelledby="news-heading">
        <header class="panel-heading">
          <h2 id="news-heading">公开动态</h2>
          <a class="button button--primary" href="/teacher/news/new">发布动态</a>
        </header>
        <p class="field-note">发布后可在展示网站中查看。师生消息请发到<a href="/teacher/notices">站内通知</a>。</p>
        ${teacherNewsList(state, articles)}
      </section>
    </div>`);
}

function profileForm(state, values) {
  return `<section class="panel profile-panel" aria-labelledby="profile-heading">
    <header class="panel-heading">
      <h2 id="profile-heading">修改注册资料</h2>
    </header>
    <p class="field-note">资料有变化时，提交后需要教师重新审核。审核期间暂时无法进入内部工作台，公开个人主页也会暂时隐藏，原有记录会保留。</p>
    <form class="stack" action="/student/profile" method="post">
      ${token(state)}
      <input type="hidden" name="profileFields" value="1">
      ${applicationFields(values)}
      <button class="button button--primary" type="submit">提交修改并重新审核</button>
    </form>
  </section>`;
}

function birthdayForm(state, values) {
  return `<section class="panel profile-panel" aria-labelledby="birthday-heading">
    <h2 id="birthday-heading">生日</h2>
    <p class="field-note">修改生日无需重新审核。</p>
    <form class="stack" action="/student/profile/birthday" method="post">
      ${token(state)}
      <label>出生日期<input name="birthday" type="date" autocomplete="bday" value="${escapeHtml(values.birthday)}"></label>
      <button class="button button--primary" type="submit">保存生日</button>
    </form>
  </section>`;
}

function photoMarkup(studentId, portrait = false) {
  return `<img class="student-photo${portrait ? ' student-photo--portrait' : ''}" src="/student/photo/${studentId}" alt="学生生活照"${portrait ? ' width="96" height="120"' : ' loading="lazy"'}>`;
}

function photoForm(state) {
  return `<section class="panel profile-panel profile-panel--photo" aria-labelledby="photo-heading">
    <h2 id="photo-heading">生活照</h2>
    ${state.hasPhoto ? photoMarkup(state.user.id) : ''}
    <form class="stack" method="post" action="/student/photo" enctype="multipart/form-data">
      ${token(state)}
      <label>选择照片<input required name="photo" type="file" accept="image/jpeg,image/png">
        <span class="field-note">保存后显示在个人信息和导出的简历中。支持 JPG、PNG，最大 2 MB。</span></label>
      <button class="button button--primary">保存生活照</button>
    </form>
    ${state.hasPhoto ? `<form class="profile-photo-remove" method="post" action="/student/photo/remove">
      ${token(state)}<button class="button button--plain">移除生活照</button></form>` : ''}
  </section>`;
}

export function studentProfilePage(state, values = {}) {
  const student = state.user;
  const canEdit = student.reviewStatus === 'approved' && student.studentStatus !== 'graduated';
  return layout(state, '个人信息', `
    ${sectionHeading('个人信息', canEdit ? '查看本人档案，修改注册资料、生日和生活照。' : '查看本人档案。')}
    <div class="student-profile-grid${canEdit ? ' student-profile-grid--editable' : ''}">
      <section class="panel profile-panel" aria-labelledby="student-name">
        <div class="profile-identity">
          ${state.hasPhoto ? photoMarkup(student.id, true) : ''}
          <header class="panel-heading">
            <h2 id="student-name">${escapeHtml(student.name)}</h2>
            ${statusBadge(student.reviewStatus)}
          </header>
        </div>
        ${studentFacts(student)}
        ${student.reviewStatus === 'rejected' ? '<a class="button button--plain" href="/student">修改注册申请</a>' : ''}
      </section>
      ${canEdit ? `<div class="profile-editor-column">${profileForm(state, { ...student, ...values })
        + birthdayForm(state, { ...student, ...values }) + photoForm(state)}</div>` : ''}
    </div>`);
}

function studentContent(state, values) {
  const student = state.user;
  if (student.reviewStatus === 'rejected') {
    return `<section class="panel form-panel application-revision">
      ${sectionHeading('修改注册申请', '本次申请未通过。修改资料后可以重新提交。')}
      ${student.reviewReason ? `<p class="review-note">审核说明：${escapeHtml(student.reviewReason)}</p>` : ''}
      <form class="stack" action="/student/reapply" method="post">
        ${token(state)}
        ${applicationFields({ ...student, ...values })}
        <button class="button button--primary" type="submit">重新提交</button>
      </form>
    </section>`;
  }
  const pending = student.reviewStatus === 'pending';
  const graduated = student.studentStatus === 'graduated';
  const note = pending
    ? '申请已提交，等待教师审核。'
    : graduated ? '你的账号已设为毕业生，可从「个人信息」查看档案。' : '';
  const features = state.featureContent ?? '';
  const dynamics = state.desk ? '' : state.dynamics ?? '';
  return `
    ${state.desk ?? sectionHeading(pending ? '注册进度' : '学生工作台', note)}
    ${state.calendarContent ? `<div class="home-calendar">${state.calendarContent}</div>` : ''}
    ${features || dynamics ? `<div class="student-workspace"><div class="student-main">${features}</div>${dynamics}</div>` : ''}`;
}

export function studentPage(state, values = {}) {
  if (state.user.reviewStatus !== 'approved') {
    if (state.user.reviewStatus === 'rejected') {
      return layout(state, '修改注册申请', studentContent(state, values), { accountEntry: true });
    }
    return layout(state, '注册审核', `<section class="panel application-status" aria-labelledby="application-title">
      <div class="application-status-mark" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
      <h1 id="application-title">请等待教师审核</h1>
      <p>申请已提交，等待教师审核。审核通过后即可进入实验室工作台。</p>
      <p class="field-note">可以稍后重新登录，或点击下方按钮查看审核结果。</p>
      <a class="button button--primary" href="/student">刷新审核状态</a>
    </section>`, { accountEntry: true });
  }
  const tour = state.tour ? studentTour(state) : '';
  return layout(state, '学生工作台', studentContent(state, values) + tour);
}

function studentTour(state) {
  const { needsDismissal } = state.tour;
  return `<dialog id="student-tour" aria-labelledby="student-tour-title" aria-describedby="student-tour-description"
      data-autostart="true" data-dismiss-on-close="${needsDismissal}">
      <div data-tour-spotlight aria-hidden="true"></div>
      <div class="student-tour-card">
        <p data-tour-count></p>
        <h2 id="student-tour-title" tabindex="-1">欢迎使用实验室管理平台</h2>
        <p id="student-tour-description" data-tour-description></p>
        <div class="student-tour-actions">
          <form method="post" action="/student/welcome/dismiss">${token(state)}
            <button type="submit" class="button button--quiet" data-tour-skip>跳过</button>
          </form>
          <button type="button" class="button button--plain" data-tour-prev>上一步</button>
          <button type="button" class="button button--primary" data-tour-next>下一步</button>
        </div>
      </div>
    </dialog>
    ${needsDismissal ? `<noscript><section class="panel" aria-label="欢迎使用实验室管理平台">
      <h2>欢迎使用实验室管理平台</h2>
      <p><a href="/student/guide">阅读使用指引</a></p>
      <form method="post" action="/student/welcome/dismiss">${token(state)}
        <button class="button button--plain" type="submit">关闭欢迎提示</button>
      </form>
    </section></noscript>` : ''}`;
}

export function newsForm(state, values = {}) {
  const editing = values.id != null;
  const title = editing ? '编辑动态' : '发布公开动态';
  const action = editing ? `/teacher/news/${encodeURIComponent(values.id)}/edit` : '/teacher/news/new';
  return layout(state, title, `
    <a class="back-link" href="/teacher">返回工作台</a>
    <section class="panel form-panel">
      ${sectionHeading(title, '公开发布后，无需登录即可从展示网站或动态归档阅读。')}
      <form class="stack" action="${action}" method="post">
        ${token(state)}
        <label>类别
          <select name="category">${selectOptions(categories, values.category)}</select>
        </label>
        <label>标题
          <input name="title" value="${escapeHtml(values.title)}" required>
        </label>
        <label>正文
          <textarea name="body" rows="9" required>${escapeHtml(values.body)}</textarea>
        </label>
        <div class="form-grid">
          <label>动态日期（选填）
            <input name="eventDate" type="date" value="${escapeHtml(values.eventDate)}">
            <span class="field-note">未填写时按发布日期显示。</span>
          </label>
          <label>发布范围
            <select name="visibility">${selectOptions({ public: '公开发布', draft: '仅存草稿' }, values.visibility ?? 'public')}</select>
          </label>
        </div>
        <label>来源链接（选填）
          <input name="sourceUrl" type="url" maxlength="500" value="${escapeHtml(values.sourceUrl)}">
        </label>
        <div class="actions">
          <button class="button button--primary" type="submit">${editing ? '保存修改' : '保存动态'}</button>
          <a class="button button--quiet" href="/teacher">取消</a>
        </div>
      </form>
    </section>`);
}

export function messagePage(state, title, message) {
  return layout(state, title, `
    <section class="panel form-panel">
      ${sectionHeading(escapeHtml(title), escapeHtml(message))}
      <a class="button button--plain" href="/">返回首页</a>
    </section>`);
}
