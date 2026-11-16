import { t, h, locale } from './i18n.mjs';
const roleLabels = { admin: '管理员', teacher: '教师', student: '学生' };
const reviewLabels = { pending: '待审核', approved: '已通过', rejected: '未通过' };
const statusLabels = { active: '在读', admitted: '保研待入学', graduated: '已毕业' };
const levelLabels = { undergraduate: '本科生', graduate: '研究生' };
const notices = {
  created: '教师账号已创建。请通过安全方式交付初始密码。',
  reviewed: '教师申请已处理。', studentReviewed: '学生申请已处理。', studentStatus: '学生学籍状态已更新。', assigned: '指导关系已更新。',
  disabled: '账号已移除登录权限，历史记录已保留。', enabled: '账号已恢复。'
};

export function openAdmin({ accounts, ui }) {
  const { layout, escapeHtml: e, token, html, redirect, httpError } = ui;
  const form = (state, path, body) => h`<form class="stack" method="post" action="${path}">${token(state)}${body}</form>`;
  const button = (label, variant = 'primary') => h`<button class="button button--${variant}" type="submit">${t(label)}</button>`;
  const field = (name, label, attributes = '') => h`<label>${t(label)}<input name="${name}" ${attributes}></label>`;
  const select = (name, label, choices, current = '', translateChoices = true) => h`<label>${t(label)}<select name="${name}">${choices.map(([id, title]) =>
    h`<option value="${e(id)}"${String(id) === String(current ?? '') ? ' selected' : ''}>${e(translateChoices ? t(title) : title)}</option>`).join('')}</select></label>`;

  function requireAdmin(state) {
    const actor = state.user && accounts.getUser(state.user.id);
    if (!actor || actor.disabled || actor.role !== 'admin' || actor.reviewStatus !== 'approved') {
      throw httpError(403, t('仅管理员可以访问用户管理。'));
    }
    return actor;
  }

  function userDetails(user) {
    const facts = user.role === 'student' ? [
      [t('学习层次'), t(levelLabels[user.level] ?? '—')], [t('学籍状态'), t(statusLabels[user.studentStatus] ?? '—')],
      [t('学号'), user.studentNumber], [t('专业'), user.major],
      [t('指导方式'), user.relationship === 'assisted' ? t('协助指导') : t('教师直接指导')], [t('原导师'), user.advisor],
      [t('主指导教师'), user.primaryTeacherName], [t('副指导教师'), user.secondaryTeacherName],
      [t('参与事项'), user.activities.map(value => t(value)).join(locale() === 'en' ? ', ' : '、')], [t('生日'), user.birthday]
    ] : [];
    facts.unshift([t('姓名'), user.name], [t('邮箱'), user.email], [t('手机号'), user.phone]);
    facts.push([t('注册时间'), user.createdAt], [t('审核说明'), user.reviewReason]);
    return h`<details class="record-form"><summary>查看用户信息</summary><dl class="admin-user-facts">${facts.map(([label, value]) =>
      h`<div><dt>${t(label)}</dt><dd>${e(value || '—')}</dd></div>`).join('')}</dl></details>`;
  }

  function actions(state, user, teachers) {
    let result = '';
    if (user.role === 'teacher' && ['pending', 'rejected'].includes(user.reviewStatus) && !user.disabled) {
      result += h`<details class="record-form"><summary>${user.reviewStatus === 'rejected' ? t('重新审核教师申请') : t('审核教师申请')}</summary>${form(state, h`/admin/teachers/${user.id}/review`,
        select('decision', t('审核结果'), user.reviewStatus === 'rejected' ? [['approved', t('通过')]] : [['approved', t('通过')], ['rejected', t('不通过')]]) +
        field('reason', t('审核说明（选填）'), 'maxlength="500"') + button(t('保存审核结果')))}</details>`;
    }
    if (user.role === 'student') {
      const choices = teachers.map(teacher => [teacher.id, teacher.name + ' · ' + teacher.email]);
      if (!user.disabled && user.reviewStatus === 'pending') {
        result += h`<details class="record-form"><summary>审核学生申请</summary>${form(state, h`/admin/students/${user.id}/review`,
          select('decision', t('审核结果'), [['approved', t('通过')], ['rejected', t('不通过')]]) +
          field('reason', t('审核说明（选填）'), 'maxlength="500"') + button(t('保存审核结果')))}</details>`;
      }
      if (!user.disabled && user.reviewStatus === 'approved') {
        result += h`<details class="record-form"><summary>调整学籍状态</summary>${form(state, h`/admin/students/${user.id}/status`,
          select('studentStatus', t('学籍状态'), Object.entries(statusLabels), user.studentStatus) +
          field('studentNumber', t('学号（在读时必填）'), h`value="${e(user.studentNumber || '')}" maxlength="32"`) +
          button(t('保存学籍状态')))}</details>`;
      }
      result += h`<details class="record-form"><summary>调整指导教师</summary>${form(state, h`/admin/users/${user.id}/teachers`,
        select('primaryTeacherId', t('主指导教师'), choices, user.primaryTeacherId, false) +
        select('secondaryTeacherId', t('副指导教师（选填）'), [['', t('不设置副指导教师')], ...choices], user.secondaryTeacherId, false) +
        button(t('保存指导关系')))}</details>`;
    }
    if (user.id !== state.user.id) {
      result += h`<details class="record-form"><summary>${user.disabled ? t('恢复账号') : t('移除账号')}</summary>
        <p class="hint">${user.disabled ? t('恢复后可使用原账号登录，审核状态保持不变。') :
          t('将停用登录并撤销现有会话，历史资料仍会保留。教师名下的学生须先重新分配。')}</p>
        ${form(state, h`/admin/users/${user.id}/${user.disabled ? 'enable' : 'disable'}`, button(user.disabled ? t('确认恢复') : t('确认移除'), user.disabled ? 'primary' : 'danger'))}</details>`;
    }
    return result || h`<span class="hint">当前账号</span>`;
  }

  function page(state, filters = {}) {
    requireAdmin(state);
    const all = accounts.listUsers();
    const teachers = accounts.listTeachers();
    const role = Object.hasOwn(roleLabels, filters.role) ? filters.role : '';
    const status = ['pending', 'enabled', 'disabled'].includes(filters.status) ? filters.status : '';
    const keyword = typeof filters.keyword === 'string' ? filters.keyword.trim().slice(0, 100) : '';
    const needle = keyword.toLocaleLowerCase();
    const users = all.filter(user => (!role || user.role === role) &&
      (!status || (status === 'pending' ? user.reviewStatus === 'pending' && !user.disabled : user.disabled === (status === 'disabled'))) &&
      (!needle || [user.name, user.email, user.phone, user.studentNumber].some(value => value?.toLocaleLowerCase().includes(needle))));
    const content = h`<div class="stack admin-page">
      <header class="page-heading"><h1>用户管理</h1><p>审核教师申请，管理用户账号与学生指导关系。</p></header>
      <section class="panel"><div class="admin-summary" aria-label="用户统计">
        <div><span>启用用户</span><strong>${all.filter(user => !user.disabled).length}</strong></div>
        <div><span>教师</span><strong>${teachers.length}</strong></div>
        <div><span>学生</span><strong>${all.filter(user => user.role === 'student' && !user.disabled).length}</strong></div>
        <div><span>待审教师</span><strong>${all.filter(user => user.role === 'teacher' && user.reviewStatus === 'pending' && !user.disabled).length}</strong></div>
      </div></section>
      <section class="panel"><div class="panel-heading"><h2>全部用户</h2><span class="hint">待审核用户优先显示</span></div>
        <form class="admin-user-filters" method="get" action="/admin">
          ${select('role', t('账号角色'), [['', t('全部角色')], ...Object.entries(roleLabels)], role)}
          ${select('status', t('账号状态'), [['', t('全部状态')], ['pending', t('待审核')], ['enabled', t('启用')], ['disabled', t('已移除')]], status)}
          <label>搜索用户<input name="keyword" value="${e(keyword)}" maxlength="100" placeholder="姓名、邮箱、手机号或学号"></label>
          ${button(t('筛选'), 'plain')}
        </form>
        <div class="admin-users-scroll" role="region" aria-label="用户列表" tabindex="0"><table class="admin-users-table">
          <thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">联系方式</th><th scope="col">状态</th><th scope="col">管理</th></tr></thead>
          <tbody>${users.map(user => h`<tr><td><strong>${e(user.name)}</strong>${userDetails(user)}</td>
            <td>${t(roleLabels[user.role])}</td><td><div>${e(user.email || '—')}</div><small class="hint">${e(user.phone || '')}</small></td>
            <td><span class="badge badge--${user.disabled ? 'rejected' : user.reviewStatus}">${user.disabled ? t('已移除') : t(reviewLabels[user.reviewStatus])}</span></td>
            <td>${actions(state, user, teachers)}</td></tr>`).join('') || h`<tr><td colspan="5">没有符合条件的用户。</td></tr>`}</tbody>
        </table></div>
      </section>
      <section class="panel"><h2>添加教师</h2><p class="hint">教师也可在登录页申请注册，经管理员审核后启用。</p>
        ${form(state, '/admin/teachers', h`<div class="form-grid">${field('name', t('教师姓名'), 'required maxlength="80" autocomplete="name"')}
          ${field('email', t('邮箱'), 'type="email" required maxlength="254" autocomplete="email"')}
          ${field('password', t('初始密码'), 'type="password" required minlength="8" maxlength="128" autocomplete="new-password"')}</div>${button(t('创建教师账号'))}`)}
      </section>
    </div>`;
    return layout(state, t('用户管理'), content);
  }

  async function act(ctx, operation, done) {
    const actor = requireAdmin(ctx.state);
    try {
      await operation(actor);
      return redirect(ctx.response, '/admin?done=' + done);
    } catch (error) {
      if (!error.statusCode) throw error;
      return html(ctx.response, page({ ...ctx.state, error: error.message }), error.statusCode);
    }
  }

  const routes = [
    ['GET', /^\/admin$/, 'admin', ctx => html(ctx.response, page({ ...ctx.state,
      notice: Object.hasOwn(notices, ctx.url.searchParams.get('done')) ? notices[ctx.url.searchParams.get('done')] : ctx.state.notice }, Object.fromEntries(ctx.url.searchParams)))],
    ['POST', /^\/admin\/teachers$/, 'admin', ctx => act(ctx,
      actor => accounts.createTeacher(ctx.form, { actorId: actor.id }), 'created')],
    ['POST', /^\/admin\/teachers\/(\d+)\/review$/, 'admin', ctx => act(ctx,
      actor => accounts.reviewTeacher(actor.id, ctx.id, ctx.form.decision, ctx.form.reason), 'reviewed')],
    ['POST', /^\/admin\/students\/(\d+)\/review$/, 'admin', ctx => act(ctx,
      actor => accounts.reviewStudent(actor.id, ctx.id, ctx.form.decision, ctx.form.reason), 'studentReviewed')],
    ['POST', /^\/admin\/students\/(\d+)\/status$/, 'admin', ctx => act(ctx,
      actor => accounts.setStudentStatus(actor.id, ctx.id, ctx.form.studentStatus, ctx.form.studentNumber), 'studentStatus')],
    ['POST', /^\/admin\/users\/(\d+)\/teachers$/, 'admin', ctx => act(ctx,
      actor => accounts.assignTeachers(actor.id, ctx.id, ctx.form), 'assigned')],
    ['POST', /^\/admin\/users\/(\d+)\/disable$/, 'admin', ctx => act(ctx,
      actor => accounts.disableUser(actor.id, ctx.id), 'disabled')],
    ['POST', /^\/admin\/users\/(\d+)\/enable$/, 'admin', ctx => act(ctx,
      actor => accounts.setUserEnabled(actor.id, ctx.id, true), 'enabled')]
  ];
  return { routes };
}
