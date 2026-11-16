import { t, h, locale } from './i18n.mjs';
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
  const form = (state, path, body) => h`<form class="stack" method="post" action="${path}">${token(state)}${body}</form>`;
  const button = (text, variant = 'primary') => h`<button class="button button--${variant}" type="submit">${text}</button>`;
  const link = (path, text) => h`<a class="button button--plain" href="${path}">${text}</a>`;
  const panel = (title, content) => h`<section class="panel"><h2>${title}</h2>${content}</section>`;
  const empty = (text) => h`<p class="empty">${text}</p>`;
  const page = (state, { title, render }) => layout(state, title,
    h`<a class="back-link" href="/${state.user.role === 'teacher' ? 'teacher' : 'student'}">返回工作台</a>
    <header class="page-heading"><h1>${title}</h1></header>${render(state)}`);
  const record = (content, id = '') => h`<li class="record"${id ? h` id="${id}"` : ''}>${content}</li>`;
  const list = (records, whenEmpty) => records.length
    ? h`<ul class="record-list">${records.join('')}</ul>`
    : empty(whenEmpty);

  function field(name, title, value = '', attributes = '') {
    return h`<label>${title}<input name="${name}" value="${e(value)}" ${attributes}></label>`;
  }

  function textarea(name, title, value = '', max = 4000, required = false) {
    return h`<label>${title}<textarea name="${name}" rows="4" maxlength="${max}"${required ? ' required' : ''}>${e(value)}</textarea></label>`;
  }

  function select(name, title, choices, value, translateChoices = true) {
    return h`<label>${title}<select name="${name}">${choices.map(([key, label]) =>
      h`<option value="${e(key)}"${String(value ?? '') === String(key) ? ' selected' : ''}>${e(translateChoices ? t(label) : label)}</option>`).join('')}</select></label>`;
  }

  function badge(key, labels) {
    const tone = ['confirmed', 'approved'].includes(key) ? 'approved' : key === 'rejected' ? 'rejected' : 'pending';
    return h`<span class="badge badge--${tone}">${t(labels[key])}</span>`;
  }

  function templateForm(state, template = {}) {
    const path = '/teacher/graduation/templates' + (template.id ? h`/${template.id}` : '');
    return form(state, path, select('level', t('学习层次'), Object.entries(levelLabels), template.level) +
      field('title', t('任务名称'), template.title, 'required maxlength="150"') + button(template.id ? t('保存模板') : t('添加模板')));
  }

  function removal(state, path, label) {
    return h`<details class="record-form"><summary>${t(label)}</summary>${form(state, path, button(t('确认删除'), 'danger'))}</details>`;
  }

  function reviewForm(state, path, options) {
    return form(state, path, select('decision', t('处理结果'), options) + field('note', t('处理说明（选填）'), '', 'maxlength="1000"') +
      button(t('保存处理结果')));
  }

  function teacherGraduation(templates, tasks, students) {
    return {
      title: t('毕业任务'),
      render: (state) => {
        const templateLists = Object.entries(levelLabels).map(([level, label]) => h`<section><h3>${t(label)}清单</h3>
          ${list(templates.filter((t) => t.level === level).map((template) => record(
            h`<p><strong>${e(template.title)}</strong></p>
            <details class="record-form"><summary>修改模板</summary>${templateForm(state, template)}</details>
            ${removal(state, h`/teacher/graduation/templates/${template.id}/delete`, t('删除模板'))}`
          )), t('暂无模板任务。'))}</section>`).join('');
        const templatesOptions = templates.map((template) => [template.id, h`${t(levelLabels[template.level])} · ${template.title}`]);
        const assignments = students.length
          ? form(state, '/teacher/graduation/assign',
            select('student', t('学生'), students.map((s) => [s.id, h`${s.name}（${t(levelLabels[s.level])}）`]), undefined, false) +
            select('template', t('任务来源'), [['', t('自定义任务')], ...templatesOptions], undefined, false) +
            field('title', t('自定义任务名称（使用模板时留空）'), '', 'maxlength="150"') +
            field('due', t('截止日期（北京时间）'), '', 'type="date" required') + button(t('分配任务')))
          : empty(t('暂无可分配任务的学生。'));
        return h`<div class="stack">
          ${panel(t('任务模板'), h`<div class="stack">${templateLists}<details class="record-form"><summary>新增模板任务</summary>${templateForm(state)}</details></div>`)}
          ${panel(t('分配任务'), assignments)}
          ${panel(t('学生任务'), list(tasks.map((task) => {
            const path = h`/teacher/graduation/tasks/${task.id}`;
            return record(taskText(task, task.name) +
              (task.status === 'submitted' ? reviewForm(state, h`${path}/review`, [['confirmed', t('确认完成')], ['open', t('退回')]]) : '') +
              (task.status !== 'confirmed' ? h`<details class="record-form"><summary>调整截止日期</summary>
                ${form(state, h`${path}/due`, field('due', t('截止日期'), task.due_date, 'type="date" required') + button(t('保存截止日期')))}</details>` : ''));
          }), t('暂无个人毕业任务。')))}
        </div>`;
      }
    };
  }

  function taskText(task, owner = '') {
    return h`<div class="record-head"><h3>${e(task.title)}</h3>${badge(task.status, taskLabels)}</div>
      <p>${owner ? h`${e(owner)} · ` : ''}截止 ${e(task.due_date)}</p>
      ${task.review_note ? h`<p class="article-body">教师说明：${e(task.review_note)}</p>` : ''}`;
  }

  function studentGraduation(tasks) {
    return {
      title: t('我的毕业任务'),
      render: (state) => panel(h`已确认 ${tasks.filter((task) => task.status === 'confirmed').length} / ${tasks.length}`,
        list(tasks.map((task) => record(taskText(task) + (task.status === 'open'
          ? form(state, h`/student/graduation/${task.id}/complete`, button(t('提交完成确认')))
          : ''))), t('教师还未分配任务。')))
    };
  }

  function internshipForm(state, internship = {}) {
    const path = internship.id ? h`/student/internships/${internship.id}/resubmit` : '/student/internships';
    return form(state, path, h`<div class="form-grid">
      ${field('organization', t('实习单位'), internship.organization, 'required maxlength="150"')}
      ${field('position', t('岗位'), internship.position, 'required maxlength="120"')}
      ${field('location', t('地点（选填）'), internship.location, 'maxlength="120"')}
      ${field('start', t('开始日期'), internship.start_date, 'type="date" min="1900-01-01" max="2199-12-31" required')}
      ${field('end', t('结束日期'), internship.end_date, 'type="date" min="1900-01-01" max="2199-12-31" required')}
      <div class="span-full">${textarea('notes', t('备注（选填）'), internship.notes)}</div>
    </div>${button(internship.id ? t('重新提交') : t('提交审核'))}`);
  }

  function internshipText(internship, showOwner = false) {
    return h`<div class="record-head"><h3>${e(internship.organization)} · ${e(internship.position)}</h3>
      ${badge(internship.status, internshipLabels)}</div>
      <p>${showOwner ? h`${e(internship.name)} · ` : ''}${e(internship.start_date)} 至 ${e(internship.end_date)}
      ${internship.location ? h` · ${e(internship.location)}` : ''}</p>
      ${internship.notes ? h`<p class="article-body">${e(internship.notes)}</p>` : ''}
      ${internship.review_note ? h`<p class="article-body">教师说明：${e(internship.review_note)}</p>` : ''}`;
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
      if (day < 1 || day > dayCount) return h`<td></td>`;
      const date = h`${selected}-${String(day).padStart(2, '0')}`;
      const entries = internships.filter((item) => item.start_date <= date && item.end_date >= date && item.status !== 'rejected');
      return h`<td><span>${day}</span>${entries.map((item) => h`<a href="${recordPath}#internship-${item.id}" aria-label="${e(item.organization)}，${t(internshipLabels[item.status])}">
          ${e(item.organization)} · ${t(internshipLabels[item.status])}</a>`).join('')}</td>`;
    });
    const rows = [];
    for (let index = 0; index < cells.length; index += 7) rows.push(h`<tr>${cells.slice(index, index + 7).join('')}</tr>`);
    return h`<div class="panel-heading"><strong>${selected}</strong>
      <div class="actions">${selected > '1900-01' ? link(`/student/internships?month=${prev}`, t('上个月')) : ''}
      ${selected < '2199-12' ? link(`/student/internships?month=${next}`, t('下个月')) : ''}</div>
    </div><div class="management-calendar"><table aria-label="${selected} 实习日历">
      <thead><tr>${[t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六'), t('周日')].map((day) => h`<th scope="col">${day}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
  }

  function teacherInternships(internships) {
    return {
      title: t('实习审核'),
      render: (state) => panel(t('学生实习'), list(internships.map((item) => record(internshipText(item, true) +
        (item.status === 'pending' ? reviewForm(state, h`/teacher/internships/${item.id}/review`, [
          ['approved', t('通过')], ['rejected', t('退回')]
        ]) : ''))), t('暂无实习登记。')))
    };
  }

  function studentInternships(internships, month) {
    return {
      title: t('我的实习'),
      render: (state) => h`<div class="stack">
        ${panel(t('实习日历'), internshipCalendar(internships, month))}
        ${panel(t('登记实习'), h`<p>实习审核和周报要求分开处理。如需调整周报，请和教师确认。</p>` + internshipForm(state))}
        ${panel(t('实习记录'), list(internships.map((item) => record(internshipText(item) +
          (item.status === 'rejected' ? h`<details class="record-form"><summary>修改并重提</summary>${internshipForm(state, item)}</details>` : ''),
          h`internship-${item.id}`)), t('暂无实习记录。')))}
      </div>`
    };
  }

  function noticeText(notice) {
    return h`<h3>${e(notice.title)}</h3><p class="article-meta">${todayInShanghai(notice.published_at)}</p>
      <p class="article-body">${e(notice.body)}</p>`;
  }

  function noticeForm(state, notice = {}) {
    const path = '/teacher/notices' + (notice.id ? h`/${notice.id}` : '');
    return form(state, path, field('title', t('标题'), notice.title, 'required maxlength="150"') +
      textarea('body', t('正文'), notice.body, 8000, true) + button(notice.id ? t('保存通知') : t('发布全员通知')));
  }

  function teacherNotices(notices) {
    return {
      title: t('站内通知'),
      render: (state) => h`<div class="stack">
        ${panel(t('发布通知'), h`<p>通知面向已审核的非毕业学生。</p>` + noticeForm(state))}
        ${panel(t('已发布通知'), list(notices.map((notice) => record(noticeText(notice) +
          h`<details class="record-form"><summary>修改通知</summary>${noticeForm(state, notice)}</details>` +
          removal(state, h`/teacher/notices/${notice.id}/delete`, t('删除通知')))), t('暂无通知。')))}
      </div>`
    };
  }

  function studentNotices(notices) {
    return {
      title: t('站内通知'),
      render: () => panel(t('全员通知'), list(notices.map((notice) => record(noticeText(notice), h`notice-${notice.id}`)), t('暂无通知。')))
    };
  }

  const guideSteps = () => h`<ol>
    <li>打开<a href="/student/profile">个人信息</a>，可更新邮箱、手机号、生日和生活照。</li>
    <li>打开<a href="/student/weekly">周报与请假</a>，查看本周截止时间。可填写困难与求助、添加附件；草稿写完后记得提交，提交后仍可修改并查看历史版本。</li>
    <li>从侧栏底部的<a href="/student/homepage">个人主页与简历</a>完善公开介绍，预览后主动发布，也可下载 PDF 或 Word 简历。</li>
    <li>在<a href="/student/calendar">个人日历</a>查看个人任务和顶会投稿的截止时间。</li>
    <li>需要分享时，在动态页选择具体项目。公开后可在同一页面撤回。</li>
    <li>在毕业任务页提交完成情况。教师确认后，任务才计入完成进度。</li>
  </ol>`;

  function guide() {
    return { title: t('使用指引'), render: () => panel(t('开始使用'), h`
      <p>想再看一遍？导览会在工作台上依次指出常用入口。</p>
      <div class="actions"><a class="button button--primary" href="/student?tour=1">重新播放导览</a></div>
      ${guideSteps()}`) };
  }

  function resultForm(state, students, item = {}) {
    const path = '/teacher/results' + (item.id ? h`/${item.id}` : '');
    const selected = new Set(item.members?.map((member) => member.id));
    const participants = students.map((student) => h`<label><input type="checkbox" name="member" value="${student.id}"${selected.has(student.id) ? ' checked' : ''}>
      ${e(student.name)}${student.studentStatus === 'graduated' ? t('（已毕业）') : ''}</label>`).join('');
    return form(state, path, h`<div class="form-grid">
      ${select('kind', t('成果类型'), Object.entries(resultKinds), item.kind)}
      ${field('title', t('成果名称'), item.title, 'required maxlength="180"')}
      ${field('date', t('成果日期'), item.result_date, 'type="date" required')}
      ${field('detail', t('分类信息（选填）'), item.detail, 'maxlength="300"')}
      <p class="field-note span-full">可填写发表载体、专利号、项目来源、合作单位或获奖等次。</p>
      <div class="span-full">${field('url', t('链接（选填）'), item.url, 'type="url" maxlength="1000"')}</div>
      <div class="span-full">${textarea('notes', t('说明（选填）'), item.notes, 6000)}</div>
    </div>
    <fieldset class="activity-field"><legend>参与学生</legend>
      ${participants ? h`<div class="choices">${participants}</div>` : h`<p>暂无已审核学生。</p>`}
    </fieldset>${button(item.id ? t('保存成果') : t('添加成果'))}`);
  }

  function resultText(item, showMembers = false) {
    return h`<h3>${e(item.title)}</h3><p>${t(resultKinds[item.kind])} · ${e(item.result_date)}
      ${item.detail ? h` · ${e(item.detail)}` : ''}</p>
      ${showMembers && item.members.length ? h`<p>参与学生：${item.members.map((member) => e(member.name)).join('、')}</p>` : ''}
      ${item.notes ? h`<p class="article-body">${e(item.notes)}</p>` : ''}
      ${item.url ? h`<p><a href="${e(item.url)}" rel="noreferrer">查看成果链接</a></p>` : ''}`;
  }

  function teacherResults(items, students, { keyword, kind }) {
    return {
      title: t('实验室成果'),
      render: (state) => h`<div class="stack">
        ${panel(t('登记成果'), resultForm(state, students))}
        ${panel(t('查询成果'), h`<form method="get" action="/teacher/results" class="stack">
          <div class="form-grid">${field('q', t('按名称查询'), keyword, 'maxlength="180"')}
          ${select('kind', t('成果类型'), [['', t('全部')], ...Object.entries(resultKinds)], kind)}</div>${button(t('查询'))}</form>` +
          list(items.map((item) => record(resultText(item, true) +
            h`<details class="record-form"><summary>修改成果</summary>${resultForm(state, students, item)}</details>` +
            removal(state, h`/teacher/results/${item.id}/delete`, t('删除成果')))), t('没有找到成果。')))}
      </div>`
    };
  }

  function alumni(results, internships) {
    return h`<div class="stack">
      ${panel(t('毕业生主页'), h`<p>欢迎回来。这里可以查看自己的成果、实习记录和实验室成员分享的动态。</p>`)}
      ${panel(t('我的成果'), list(results.map((result) => record(resultText(result))), t('暂无与你关联的成果。')))}
      ${panel(t('我的实习经历'), list(internships.map((internship) => record(internshipText(internship))), t('暂无实习记录。')))}
    </div>`;
  }

  function studentDashboard({ notices, internships }) {
    const noticesContent = notices.length
      ? h`<ul>${notices.map((notice) => h`<li><a href="/student/notices#notice-${notice.id}">${e(notice.title)}</a></li>`).join('')}</ul>`
      : empty(t('暂无通知。'));
    return h`<div class="stack">
      ${panel(t('站内通知'), noticesContent + h`<div class="actions">${link('/student/notices', t('全部通知'))}${link('/student/guide', t('使用指引'))}</div>`)}
      ${internships ? panel(t('我的实习日历'), internshipCalendar(internships, null, '/student/internships') +
        link('/student/internships', t('查看或登记实习'))) : ''}
    </div>`;
  }

  return {
    page, teacherGraduation, studentGraduation, studentInternships, teacherInternships,
    teacherNotices, studentNotices, guide, teacherResults, alumni, studentDashboard
  };
}
