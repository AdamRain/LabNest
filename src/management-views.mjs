export const resultKinds = {
  paper: '论文',
  patent: '专利',
  research: '科研项目',
  industry: '横向项目',
  award: '竞赛获奖'
};

const levelLabels = { undergraduate: '本科生', graduate: '研究生' };
const taskLabels = { open: '待完成', submitted: '待教师确认', confirmed: '已确认' };
const internshipLabels = { pending: '待审核', approved: '已审核', rejected: '已退回' };
const dateFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});

export function todayInShanghai(value = new Date()) {
  return dateFormat.format(new Date(value));
}

export function createManagementViews({ escapeHtml: e, layout, token }) {
  const form = (state, path, body) => `<form class="stack" method="post" action="${path}">${token(state)}${body}</form>`;
  const button = (text, variant = 'primary') => `<button class="button button--${variant}" type="submit">${text}</button>`;
  const link = (path, text) => `<a class="button button--plain" href="${path}">${text}</a>`;
  const panel = (title, content) => `<section class="panel"><h2>${title}</h2>${content}</section>`;
  const empty = (text) => `<p class="empty">${text}</p>`;
  const page = (state, { title, render }) => layout(state, title,
    `<a class="back-link" href="/${state.user.role === 'teacher' ? 'teacher' : 'student'}">返回工作台</a>
    <header class="page-heading"><h1>${title}</h1></header>${render(state)}`);
  const record = (content, id = '') => `<li class="record"${id ? ` id="${id}"` : ''}>${content}</li>`;
  const list = (records, whenEmpty) => records.length
    ? `<ul class="record-list">${records.join('')}</ul>`
    : empty(whenEmpty);

  function field(name, title, value = '', attributes = '') {
    return `<label>${title}<input name="${name}" value="${e(value)}" ${attributes}></label>`;
  }

  function textarea(name, title, value = '', max = 4000, required = false) {
    return `<label>${title}<textarea name="${name}" rows="4" maxlength="${max}"${required ? ' required' : ''}>${e(value)}</textarea></label>`;
  }

  function select(name, title, choices, value) {
    return `<label>${title}<select name="${name}">${choices.map(([key, label]) =>
      `<option value="${e(key)}"${String(value ?? '') === String(key) ? ' selected' : ''}>${e(label)}</option>`).join('')}</select></label>`;
  }

  function badge(key, labels) {
    const tone = ['confirmed', 'approved'].includes(key) ? 'approved' : key === 'rejected' ? 'rejected' : 'pending';
    return `<span class="badge badge--${tone}">${labels[key]}</span>`;
  }

  function templateForm(state, template = {}) {
    const path = '/teacher/graduation/templates' + (template.id ? `/${template.id}` : '');
    return form(state, path, select('level', '学习层次', Object.entries(levelLabels), template.level) +
      field('title', '任务名称', template.title, 'required maxlength="150"') + button(template.id ? '保存模板' : '添加模板'));
  }

  function removal(state, path, label) {
    return `<details class="record-form"><summary>${label}</summary>${form(state, path, button('确认删除', 'danger'))}</details>`;
  }

  function reviewForm(state, path, options) {
    return form(state, path, select('decision', '处理结果', options) + field('note', '处理说明（选填）', '', 'maxlength="1000"') +
      button('保存处理结果'));
  }

  function teacherGraduation(templates, tasks, students) {
    return {
      title: '毕业任务',
      render: (state) => {
        const templateLists = Object.entries(levelLabels).map(([level, label]) => `<section><h3>${label}清单</h3>
          ${list(templates.filter((t) => t.level === level).map((template) => record(
            `<p><strong>${e(template.title)}</strong></p>
            <details class="record-form"><summary>修改模板</summary>${templateForm(state, template)}</details>
            ${removal(state, `/teacher/graduation/templates/${template.id}/delete`, '删除模板')}`
          )), '暂无模板任务。')}</section>`).join('');
        const templatesOptions = templates.map((t) => [t.id, `${levelLabels[t.level]} · ${t.title}`]);
        const assignments = students.length
          ? form(state, '/teacher/graduation/assign',
            select('student', '学生', students.map((s) => [s.id, `${s.name}（${levelLabels[s.level]}）`])) +
            select('template', '任务来源', [['', '自定义任务'], ...templatesOptions]) +
            field('title', '自定义任务名称（使用模板时留空）', '', 'maxlength="150"') +
            field('due', '截止日期（北京时间）', '', 'type="date" required') + button('分配任务'))
          : empty('暂无可分配任务的学生。');
        return `<div class="stack">
          ${panel('任务模板', `<div class="stack">${templateLists}<details class="record-form"><summary>新增模板任务</summary>${templateForm(state)}</details></div>`)}
          ${panel('分配任务', assignments)}
          ${panel('学生任务', list(tasks.map((task) => {
            const path = `/teacher/graduation/tasks/${task.id}`;
            return record(taskText(task, task.name) +
              (task.status === 'submitted' ? reviewForm(state, `${path}/review`, [['confirmed', '确认完成'], ['open', '退回']]) : '') +
              (task.status !== 'confirmed' ? `<details class="record-form"><summary>调整截止日期</summary>
                ${form(state, `${path}/due`, field('due', '截止日期', task.due_date, 'type="date" required') + button('保存截止日期'))}</details>` : ''));
          }), '暂无个人毕业任务。'))}
        </div>`;
      }
    };
  }

  function taskText(task, owner = '') {
    return `<div class="record-head"><h3>${e(task.title)}</h3>${badge(task.status, taskLabels)}</div>
      <p>${owner ? `${e(owner)} · ` : ''}截止 ${e(task.due_date)}</p>
      ${task.review_note ? `<p class="article-body">教师说明：${e(task.review_note)}</p>` : ''}`;
  }

  function studentGraduation(tasks) {
    return {
      title: '我的毕业任务',
      render: (state) => panel(`已确认 ${tasks.filter((task) => task.status === 'confirmed').length} / ${tasks.length}`,
        list(tasks.map((task) => record(taskText(task) + (task.status === 'open'
          ? form(state, `/student/graduation/${task.id}/complete`, button('提交完成确认'))
          : ''))), '教师还未分配任务。'))
    };
  }

  function internshipForm(state, internship = {}) {
    const path = internship.id ? `/student/internships/${internship.id}/resubmit` : '/student/internships';
    return form(state, path, `<div class="form-grid">
      ${field('organization', '实习单位', internship.organization, 'required maxlength="150"')}
      ${field('position', '岗位', internship.position, 'required maxlength="120"')}
      ${field('location', '地点（选填）', internship.location, 'maxlength="120"')}
      ${field('start', '开始日期', internship.start_date, 'type="date" min="1900-01-01" max="2199-12-31" required')}
      ${field('end', '结束日期', internship.end_date, 'type="date" min="1900-01-01" max="2199-12-31" required')}
      <div class="span-full">${textarea('notes', '备注（选填）', internship.notes)}</div>
    </div>${button(internship.id ? '重新提交' : '提交审核')}`);
  }

  function internshipText(internship, showOwner = false) {
    return `<div class="record-head"><h3>${e(internship.organization)} · ${e(internship.position)}</h3>
      ${badge(internship.status, internshipLabels)}</div>
      <p>${showOwner ? `${e(internship.name)} · ` : ''}${e(internship.start_date)} 至 ${e(internship.end_date)}
      ${internship.location ? ` · ${e(internship.location)}` : ''}</p>
      ${internship.notes ? `<p class="article-body">${e(internship.notes)}</p>` : ''}
      ${internship.review_note ? `<p class="article-body">教师说明：${e(internship.review_note)}</p>` : ''}`;
  }

  function internshipCalendar(internships, month, recordPath = '') {
    const selected = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month ?? '') &&
      month >= '1900-01' && month <= '2199-12' ? month : todayInShanghai().slice(0, 7);
    const [year, monthIndex] = selected.split('-').map(Number);
    const prev = new Date(Date.UTC(year, monthIndex - 2, 1)).toISOString().slice(0, 7);
    const next = new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 7);
    const offset = (new Date(Date.UTC(year, monthIndex - 1, 1)).getUTCDay() + 6) % 7;
    const dayCount = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
    const cells = Array.from({ length: Math.ceil((offset + dayCount) / 7) * 7 }, (_, index) => {
      const day = index - offset + 1;
      if (day < 1 || day > dayCount) return '<td></td>';
      const date = `${selected}-${String(day).padStart(2, '0')}`;
      const entries = internships.filter((item) => item.start_date <= date && item.end_date >= date && item.status !== 'rejected');
      return `<td><span>${day}</span>${entries.map((item) => `<a href="${recordPath}#internship-${item.id}" aria-label="${e(item.organization)}，${internshipLabels[item.status]}">
          ${e(item.organization)} · ${internshipLabels[item.status]}</a>`).join('')}</td>`;
    });
    const rows = [];
    for (let index = 0; index < cells.length; index += 7) rows.push(`<tr>${cells.slice(index, index + 7).join('')}</tr>`);
    return `<div class="panel-heading"><strong>${selected}</strong>
      <div class="actions">${selected > '1900-01' ? link(`/student/internships?month=${prev}`, '上个月') : ''}
      ${selected < '2199-12' ? link(`/student/internships?month=${next}`, '下个月') : ''}</div>
    </div><div class="management-calendar"><table aria-label="${selected} 实习日历">
      <thead><tr>${['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((day) => `<th scope="col">${day}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
  }

  function teacherInternships(internships) {
    return {
      title: '实习审核',
      render: (state) => panel('学生实习', list(internships.map((item) => record(internshipText(item, true) +
        (item.status === 'pending' ? reviewForm(state, `/teacher/internships/${item.id}/review`, [
          ['approved', '通过'], ['rejected', '退回']
        ]) : ''))), '暂无实习登记。'))
    };
  }

  function studentInternships(internships, month) {
    return {
      title: '我的实习',
      render: (state) => `<div class="stack">
        ${panel('实习日历', internshipCalendar(internships, month))}
        ${panel('登记实习', '<p>实习审核和周报要求分开处理。如需调整周报，请和教师确认。</p>' + internshipForm(state))}
        ${panel('实习记录', list(internships.map((item) => record(internshipText(item) +
          (item.status === 'rejected' ? `<details class="record-form"><summary>修改并重提</summary>${internshipForm(state, item)}</details>` : ''),
          `internship-${item.id}`)), '暂无实习记录。'))}
      </div>`
    };
  }

  function noticeText(notice) {
    return `<h3>${e(notice.title)}</h3><p class="article-meta">${todayInShanghai(notice.published_at)}</p>
      <p class="article-body">${e(notice.body)}</p>`;
  }

  function noticeForm(state, notice = {}) {
    const path = '/teacher/notices' + (notice.id ? `/${notice.id}` : '');
    return form(state, path, field('title', '标题', notice.title, 'required maxlength="150"') +
      textarea('body', '正文', notice.body, 8000, true) + button(notice.id ? '保存通知' : '发布全员通知'));
  }

  function teacherNotices(notices) {
    return {
      title: '站内通知',
      render: (state) => `<div class="stack">
        ${panel('发布通知', '<p>通知面向已审核的非毕业学生。</p>' + noticeForm(state))}
        ${panel('已发布通知', list(notices.map((notice) => record(noticeText(notice) +
          `<details class="record-form"><summary>修改通知</summary>${noticeForm(state, notice)}</details>` +
          removal(state, `/teacher/notices/${notice.id}/delete`, '删除通知'))), '暂无通知。'))}
      </div>`
    };
  }

  function studentNotices(notices) {
    return {
      title: '站内通知',
      render: () => panel('全员通知', list(notices.map((notice) => record(noticeText(notice), `notice-${notice.id}`)), '暂无通知。'))
    };
  }

  const guideSteps = `<ol>
    <li>打开<a href="/student/profile">个人信息</a>，可更新邮箱、手机号、生日和生活照。</li>
    <li>打开<a href="/student/weekly">周报与请假</a>，查看本周截止时间。可填写困难与求助、添加附件；草稿写完后记得提交，提交后仍可修改并查看历史版本。</li>
    <li>从侧栏底部的<a href="/student/homepage">个人主页与简历</a>完善公开介绍，预览后主动发布，也可下载 PDF 或 Word 简历。</li>
    <li>在<a href="/student/calendar">个人日历</a>查看个人任务和顶会投稿的截止时间。</li>
    <li>需要分享时，在动态页选择具体项目。公开后可在同一页面撤回。</li>
    <li>在毕业任务页提交完成情况。教师确认后，任务才计入完成进度。</li>
  </ol>`;

  function guide() {
    return { title: '使用指引', render: () => panel('开始使用', `
      <p>想再看一遍？导览会在工作台上依次指出常用入口。</p>
      <div class="actions"><a class="button button--primary" href="/student?tour=1">重新播放导览</a></div>
      ${guideSteps}`) };
  }

  function resultForm(state, students, item = {}) {
    const path = '/teacher/results' + (item.id ? `/${item.id}` : '');
    const selected = new Set(item.members?.map((member) => member.id));
    const participants = students.map((student) => `<label><input type="checkbox" name="member" value="${student.id}"${selected.has(student.id) ? ' checked' : ''}>
      ${e(student.name)}${student.studentStatus === 'graduated' ? '（已毕业）' : ''}</label>`).join('');
    return form(state, path, `<div class="form-grid">
      ${select('kind', '成果类型', Object.entries(resultKinds), item.kind)}
      ${field('title', '成果名称', item.title, 'required maxlength="180"')}
      ${field('date', '成果日期', item.result_date, 'type="date" required')}
      ${field('detail', '分类信息（选填）', item.detail, 'maxlength="300"')}
      <p class="field-note span-full">可填写发表载体、专利号、项目来源、合作单位或获奖等次。</p>
      <div class="span-full">${field('url', '链接（选填）', item.url, 'type="url" maxlength="1000"')}</div>
      <div class="span-full">${textarea('notes', '说明（选填）', item.notes, 6000)}</div>
    </div>
    <fieldset class="activity-field"><legend>参与学生</legend>
      ${participants ? `<div class="choices">${participants}</div>` : '<p>暂无已审核学生。</p>'}
    </fieldset>${button(item.id ? '保存成果' : '添加成果')}`);
  }

  function resultText(item, showMembers = false) {
    return `<h3>${e(item.title)}</h3><p>${resultKinds[item.kind]} · ${e(item.result_date)}
      ${item.detail ? ` · ${e(item.detail)}` : ''}</p>
      ${showMembers && item.members.length ? `<p>参与学生：${item.members.map((member) => e(member.name)).join('、')}</p>` : ''}
      ${item.notes ? `<p class="article-body">${e(item.notes)}</p>` : ''}
      ${item.url ? `<p><a href="${e(item.url)}" rel="noreferrer">查看成果链接</a></p>` : ''}`;
  }

  function teacherResults(items, students, { keyword, kind }) {
    return {
      title: '实验室成果',
      render: (state) => `<div class="stack">
        ${panel('登记成果', resultForm(state, students))}
        ${panel('查询成果', `<form method="get" action="/teacher/results" class="stack">
          <div class="form-grid">${field('q', '按名称查询', keyword, 'maxlength="180"')}
          ${select('kind', '成果类型', [['', '全部'], ...Object.entries(resultKinds)], kind)}</div>${button('查询')}</form>` +
          list(items.map((item) => record(resultText(item, true) +
            `<details class="record-form"><summary>修改成果</summary>${resultForm(state, students, item)}</details>` +
            removal(state, `/teacher/results/${item.id}/delete`, '删除成果'))), '没有找到成果。'))}
      </div>`
    };
  }

  function alumni(results, internships) {
    return `<div class="stack">
      ${panel('毕业生主页', '<p>欢迎回来。这里可以查看自己的成果、实习记录和实验室成员分享的动态。</p>')}
      ${panel('我的成果', list(results.map((result) => record(resultText(result))), '暂无与你关联的成果。'))}
      ${panel('我的实习经历', list(internships.map((internship) => record(internshipText(internship))), '暂无实习记录。'))}
    </div>`;
  }

  function studentDashboard({ notices, internships }) {
    const noticesContent = notices.length
      ? `<ul>${notices.map((notice) => `<li><a href="/student/notices#notice-${notice.id}">${e(notice.title)}</a></li>`).join('')}</ul>`
      : empty('暂无通知。');
    return `<div class="stack">
      ${panel('站内通知', noticesContent + `<div class="actions">${link('/student/notices', '全部通知')}${link('/student/guide', '使用指引')}</div>`)}
      ${internships ? panel('我的实习日历', internshipCalendar(internships, null, '/student/internships') +
        link('/student/internships', '查看或登记实习')) : ''}
    </div>`;
  }

  return {
    page, teacherGraduation, studentGraduation, studentInternships, teacherInternships,
    teacherNotices, studentNotices, guide, teacherResults, alumni, studentDashboard
  };
}
