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
  const form = (state, path, body) => `<form class="stack" method="post" action="${path}">${token(state)}${body}</form>`;
  const button = (label, variant = 'primary') => `<button class="button button--${variant}" type="submit">${label}</button>`;
  const field = (name, label, attributes = '') => `<label>${label}<input name="${name}" ${attributes}></label>`;
  const select = (name, label, choices, current = '') => `<label>${label}<select name="${name}">${choices.map(([id, title]) =>
    `<option value="${e(id)}"${String(id) === String(current ?? '') ? ' selected' : ''}>${e(title)}</option>`).join('')}</select></label>`;

  function requireAdmin(state) {
    const actor = state.user && accounts.getUser(state.user.id);
    if (!actor || actor.disabled || actor.role !== 'admin' || actor.reviewStatus !== 'approved') {
      throw httpError(403, '仅管理员可以访问用户管理。');
    }
    return actor;
  }

  function userDetails(user) {
    const facts = user.role === 'student' ? [
      ['学习层次', levelLabels[user.level] ?? '—'], ['学籍状态', statusLabels[user.studentStatus] ?? '—'],
      ['学号', user.studentNumber], ['专业', user.major],
      ['指导方式', user.relationship === 'assisted' ? '协助指导' : '教师直接指导'], ['原导师', user.advisor],
      ['主指导教师', user.primaryTeacherName], ['副指导教师', user.secondaryTeacherName],
      ['参与事项', user.activities.join('、')], ['生日', user.birthday]
    ] : [];
    facts.unshift(['姓名', user.name], ['邮箱', user.email], ['手机号', user.phone]);
    facts.push(['注册时间', user.createdAt], ['审核说明', user.reviewReason]);
    return `<details class="record-form"><summary>查看用户信息</summary><dl class="admin-user-facts">${facts.map(([label, value]) =>
      `<div><dt>${label}</dt><dd>${e(value || '—')}</dd></div>`).join('')}</dl></details>`;
  }

  function actions(state, user, teachers) {
    let result = '';
    if (user.role === 'teacher' && ['pending', 'rejected'].includes(user.reviewStatus) && !user.disabled) {
      result += `<details class="record-form"><summary>${user.reviewStatus === 'rejected' ? '重新审核教师申请' : '审核教师申请'}</summary>${form(state, `/admin/teachers/${user.id}/review`,
        select('decision', '审核结果', user.reviewStatus === 'rejected' ? [['approved', '通过']] : [['approved', '通过'], ['rejected', '不通过']]) +
        field('reason', '审核说明（选填）', 'maxlength="500"') + button('保存审核结果'))}</details>`;
    }
    if (user.role === 'student') {
      const choices = teachers.map(teacher => [teacher.id, teacher.name + ' · ' + teacher.email]);
      if (!user.disabled && user.reviewStatus === 'pending') {
        result += `<details class="record-form"><summary>审核学生申请</summary>${form(state, `/admin/students/${user.id}/review`,
          select('decision', '审核结果', [['approved', '通过'], ['rejected', '不通过']]) +
          field('reason', '审核说明（选填）', 'maxlength="500"') + button('保存审核结果'))}</details>`;
      }
      if (!user.disabled && user.reviewStatus === 'approved') {
        result += `<details class="record-form"><summary>调整学籍状态</summary>${form(state, `/admin/students/${user.id}/status`,
          select('studentStatus', '学籍状态', Object.entries(statusLabels), user.studentStatus) +
          field('studentNumber', '学号（在读时必填）', `value="${e(user.studentNumber || '')}" maxlength="32"`) +
          button('保存学籍状态'))}</details>`;
      }
      result += `<details class="record-form"><summary>调整指导教师</summary>${form(state, `/admin/users/${user.id}/teachers`,
        select('primaryTeacherId', '主指导教师', choices, user.primaryTeacherId) +
        select('secondaryTeacherId', '副指导教师（选填）', [['', '不设置副指导教师'], ...choices], user.secondaryTeacherId) +
        button('保存指导关系'))}</details>`;
    }
    if (user.id !== state.user.id) {
      result += `<details class="record-form"><summary>${user.disabled ? '恢复账号' : '移除账号'}</summary>
        <p class="hint">${user.disabled ? '恢复后可使用原账号登录，审核状态保持不变。' :
          '将停用登录并撤销现有会话，历史资料仍会保留。教师名下的学生须先重新分配。'}</p>
        ${form(state, `/admin/users/${user.id}/${user.disabled ? 'enable' : 'disable'}`, button(user.disabled ? '确认恢复' : '确认移除', user.disabled ? 'primary' : 'danger'))}</details>`;
    }
    return result || '<span class="hint">当前账号</span>';
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
    const content = `<div class="stack admin-page">
      <header class="page-heading"><h1>用户管理</h1><p>审核教师申请，管理用户账号与学生指导关系。</p></header>
      <section class="panel"><div class="admin-summary" aria-label="用户统计">
        <div><span>启用用户</span><strong>${all.filter(user => !user.disabled).length}</strong></div>
        <div><span>教师</span><strong>${teachers.length}</strong></div>
        <div><span>学生</span><strong>${all.filter(user => user.role === 'student' && !user.disabled).length}</strong></div>
        <div><span>待审教师</span><strong>${all.filter(user => user.role === 'teacher' && user.reviewStatus === 'pending' && !user.disabled).length}</strong></div>
      </div></section>
      <section class="panel"><div class="panel-heading"><h2>全部用户</h2><span class="hint">待审核用户优先显示</span></div>
        <form class="admin-user-filters" method="get" action="/admin">
          ${select('role', '账号角色', [['', '全部角色'], ...Object.entries(roleLabels)], role)}
          ${select('status', '账号状态', [['', '全部状态'], ['pending', '待审核'], ['enabled', '启用'], ['disabled', '已移除']], status)}
          <label>搜索用户<input name="keyword" value="${e(keyword)}" maxlength="100" placeholder="姓名、邮箱、手机号或学号"></label>
          ${button('筛选', 'plain')}
        </form>
        <div class="admin-users-scroll" role="region" aria-label="用户列表" tabindex="0"><table class="admin-users-table">
          <thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">联系方式</th><th scope="col">状态</th><th scope="col">管理</th></tr></thead>
          <tbody>${users.map(user => `<tr><td><strong>${e(user.name)}</strong>${userDetails(user)}</td>
            <td>${roleLabels[user.role]}</td><td><div>${e(user.email || '—')}</div><small class="hint">${e(user.phone || '')}</small></td>
            <td><span class="badge badge--${user.disabled ? 'rejected' : user.reviewStatus}">${user.disabled ? '已移除' : reviewLabels[user.reviewStatus]}</span></td>
            <td>${actions(state, user, teachers)}</td></tr>`).join('') || '<tr><td colspan="5">没有符合条件的用户。</td></tr>'}</tbody>
        </table></div>
      </section>
      <section class="panel"><h2>添加教师</h2><p class="hint">教师也可在登录页申请注册，经管理员审核后启用。</p>
        ${form(state, '/admin/teachers', `<div class="form-grid">${field('name', '教师姓名', 'required maxlength="80" autocomplete="name"')}
          ${field('email', '邮箱', 'type="email" required maxlength="254" autocomplete="email"')}
          ${field('password', '初始密码', 'type="password" required minlength="8" maxlength="128" autocomplete="new-password"')}</div>${button('创建教师账号')}`)}
      </section>
    </div>`;
    return layout(state, '用户管理', content);
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
