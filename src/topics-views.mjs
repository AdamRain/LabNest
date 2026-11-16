export function topicViews(ui, stages, publications) {
  const { layout, escapeHtml: e, token } = ui;

  function button(text, variant = 'quiet') {
    return `<button class="button button--${variant}" type="submit">${text}</button>`;
  }

  function form(state, action, content, className = '') {
    return `<form class="${className}" method="post" action="${action}">${token(state)}${content}</form>`;
  }

  function heading(title, note = '') {
    return `<header class="page-heading"><h1>${title}</h1>${note ? `<p>${note}</p>` : ''}</header>`;
  }

  function badge(topic) {
    return topic.reviewedAt
      ? '<span class="badge badge--approved">已审核</span>'
      : '<span class="badge badge--pending">待审核</span>';
  }

  function topicFields(topic = {}) {
    const selected = topic.stage ?? 0;
    return `
      <label>论文题目<input name="title" value="${e(topic.title)}" required maxlength="160"></label>
      <label>摘要<textarea name="abstract" rows="5" required maxlength="4000">\n${e(topic.abstract)}</textarea></label>
      <div class="form-grid">
        <label>研究或投稿阶段<select name="stage">${stages.map((stage, i) =>
          `<option value="${i}"${selected === i ? ' selected' : ''}>${stage}</option>`).join('')}</select></label>
        <label>目标会议或期刊<input name="venue" value="${e(topic.venue)}" maxlength="120"></label>
        <label>目标截稿日期<input name="deadline" type="date" value="${e(topic.deadline)}"></label>
      </div>`;
  }

  function directory(state, topics) {
    const base = state.user.role === 'teacher' ? '/teacher/topics' : '/student/topics';
    const create = state.user.role === 'student'
      ? `<section class="panel topics-panel"><details><summary>创建课题</summary>
          ${form(state, base, topicFields() + button('创建课题', 'primary'), 'stack')}
        </details></section>` : '';
    const list = topics.length ? `<ul class="record-list">
      ${topics.map((topic) => `<li class="panel topics-panel">
        <div class="panel-heading"><h2><a href="${base}/${topic.id}">${e(topic.title)}</a></h2>${badge(topic)}</div>
        <p class="topics-text">${e(topic.abstract)}</p>
      </li>`).join('')}</ul>` : '<p class="empty">暂无课题。</p>';
    return layout(state, '论文课题', heading('论文课题') + create + list);
  }

  function innovationPoints(state, base, directoryPath, points, canEdit) {
    if (!canEdit) return points.length
      ? `<ol>${points.map(({ text }) => `<li class="topics-text">${e(text)}</li>`).join('')}</ol>`
      : '<p class="empty">暂无创新点。</p>';
    return `<ul class="record-list topics-points">
      ${points.map(({ id, text }) => `<li>${form(state, directoryPath + '/points/' + id, `
        <label>创新点<textarea name="text" required maxlength="1500" rows="2">\n${e(text)}</textarea></label>
        <div class="actions">${button('保存本条')}
        <button class="button button--danger" type="submit" name="action" value="delete" formnovalidate>删除本条</button></div>`, 'stack')}</li>`).join('')}
    </ul>
    ${form(state, base + '/points', `<label>添加创新点<textarea name="text" required maxlength="1500" rows="2"></textarea></label>
      ${button('添加')}`, 'stack')}`;
  }

  function detail(state, view) {
    const { topic, members, points, progress, isMember, canEdit } = view;
    const teacher = state.user.role === 'teacher';
    const directoryPath = teacher ? '/teacher/topics' : '/student/topics';
    const base = directoryPath + '/' + topic.id;
    const shared = isMember || teacher ? `
      <section class="panel topics-panel">
        <h2>研究进度</h2>
        <p>${stages[topic.stage]}</p>
        ${topic.venue ? `<p>目标会议或期刊　${e(topic.venue)}</p>` : ''}
        ${topic.deadline ? `<p>目标截稿日期　<time>${e(topic.deadline)}</time></p>` : ''}
      </section>
      <section class="panel topics-panel">
        <h2>创新点</h2>
        ${innovationPoints(state, base, directoryPath, points, canEdit)}
      </section>
      <section class="panel topics-panel">
        <h2>课题成员</h2>
        <ul>${members.map((member) => `<li>${e(member.name)}${member.id === topic.ownerId ? '（负责人）' : ''}${member.studentStatus === 'graduated' ? '（已毕业）' : ''}</li>`).join('')}</ul>
        ${teacher ? transferForm(state, base, members, topic.ownerId) : ''}
      </section>` : form(state, base + '/join', button('加入课题', 'primary'));
    const progressMarkup = canEdit ? `
      <section class="panel topics-panel">
        <h2>周报关联进展</h2>
        ${progress.length ? `<ul class="record-list">
          ${progress.map((item) => `<li class="topics-progress">
            <h3>${e(item.name)} · ${e(item.week)} 当周</h3>
            <p class="field-note">提交时阶段　${e(item.stage)}</p>
            <p class="topics-text">${e(item.text)}</p>
          </li>`).join('')}</ul>` : '<p class="empty">暂无已提交的课题进展。</p>'}
      </section>` : '';
    return layout(state, '课题详情', `
      <a class="back-link" href="${directoryPath}">返回课题列表</a>
      ${heading(e(topic.title))}
      <section class="panel topics-panel">
        <div class="panel-heading"><h2>摘要</h2>${badge(topic)}</div>
        <p class="topics-text">${e(topic.abstract)}</p>
        ${teacher && !topic.reviewedAt ? form(state, base + '/review', button('确认审核', 'primary')) : ''}
      </section>
      ${shared}
      ${canEdit ? `<section class="panel topics-panel"><details><summary>编辑课题</summary>
        ${form(state, base + '/edit', topicFields(topic) + button('保存课题', 'primary'), 'stack')}
      </details></section>` : ''}
      ${progressMarkup}`);
  }

  function transferForm(state, base, members, ownerId) {
    const eligible = members.filter(({ id, studentStatus, reviewStatus }) =>
      id !== ownerId && studentStatus !== 'graduated' && reviewStatus === 'approved');
    if (!eligible.length) return '';
    return form(state, base + '/transfer', `
      <label>接任负责人<select name="studentId" required>
        <option value="">选择课题成员</option>
        ${eligible.map(({ id, name }) => `<option value="${id}">${e(name)}</option>`).join('')}
      </select></label>
      ${button('指定负责人')}`, 'stack');
  }

  function entryLink(item, duplicate = false) {
    return `<a href="/student/dynamics/${item.id}"${duplicate ? ' tabindex="-1"' : ''}>
      <span class="dynamics-caption"><strong>${e(item.author)}</strong><span>${publications[item.kind]}</span></span>
      <span class="dynamics-preview">${e(item.preview)}</span>
    </a>`;
  }

  function dashboard(user, entries) {
    if (!user) return '';
    const label = entries.length ? '查看全部动态' : '查看动态';
    const scroll = entries.length > 4;
    const rows = (duplicate) => `<ul class="topics-dynamics-list"${duplicate ? ' aria-hidden="true"' : ''}>
      ${entries.map((item) => `<li>${entryLink(item, duplicate)}</li>`).join('')}</ul>`;
    const list = scroll
      ? `<input id="pause-dynamics" type="checkbox" class="dynamics-pause">
        <label for="pause-dynamics" class="dynamics-pause-label">暂停滚动</label>
        <div class="dynamics-viewport"><div class="dynamics-track">${rows(false)}${rows(true)}</div></div>`
      : rows(false);
    return `<aside class="panel dynamics-aside" aria-label="本周动态" data-student-dynamics-feed>
      <div class="panel-heading"><h2>本周动态</h2><a href="/student/dynamics" data-tour-target="dynamics">${label}</a></div>
      ${entries.length ? list
        : '<p class="empty">暂无其他成员发布的动态。</p>'}
    </aside>`;
  }

  function teacherDashboard(entries) {
    return `<section class="panel home-desk-card teacher-dynamics-card" aria-label="学生本周动态">
      <header class="home-desk-card-heading"><h2>学生本周动态</h2><a href="/teacher/dynamics">查看全部</a></header>
      ${entries.length ? `<ul class="teacher-dynamics-list">${entries.map(item => `<li>
        <a href="/teacher/dynamics/${item.id}">
          <span class="dynamics-caption"><strong>${e(item.author)}</strong><span>${e(publications[item.kind])}</span></span>
          <span class="teacher-dynamics-preview">${e(item.preview.slice(0, 100))}${item.preview.length > 100 ? '…' : ''}</span>
          <span class="teacher-dynamics-replies">${item.comments ? item.comments + ' 条回复' : '参与讨论'}</span>
        </a></li>`).join('')}</ul>`
        : '<p class="empty">名下学生本周还没有发布动态。学生在周报中勾选分享后，会显示在这里。</p>'}
    </section>`;
  }

  function feed(state, entries, personal, paging = { scope: 'week', page: 1, pages: 1, total: entries.length }) {
    const teacher = state.user.role === 'teacher';
    const base = teacher ? '/teacher/dynamics' : '/student/dynamics';
    const title = teacher ? '学生本周动态' : '成员动态';
    const source = personal ? `<section class="panel topics-panel" id="my-publications">
      <details class="social-publication-manager"${state.publicationManagerOpen ? ' open' : ''}>
      <summary>管理动态与发布摘要</summary>
      <div class="social-manager-content">
      <h2>我发布的动态</h2>
      <p class="field-note">周报中勾选的分项会随提交更新；这里也可单独调整发布状态或撰写摘要。更新保留已有讨论，取消勾选即可撤下。</p>
      ${Object.entries(publications).filter(([kind]) => kind !== 'difficulties').map(([kind, label]) => {
        const item = personal[kind];
        const field = kind === 'summary'
          ? `<label>摘要内容<textarea name="summary" rows="3" maxlength="1500">\n${e(item?.body)}</textarea></label>`
          : `<p class="field-note">${kind === 'plan'
            ? '分享已提交周报中的本周计划和上周任务勾选结果。' : '分享已提交的本周周报中这一项的内容。'}</p>`;
        return `<div class="topics-publication" id="publication-${kind}">
          <form class="stack" method="post" action="/student/dynamics/visibility"
            aria-labelledby="publication-${kind}-title" data-publication-form>
            ${token(state)}<input type="hidden" name="kind" value="${kind}">
            <input type="hidden" name="week" value="${e(state.publicationWeek)}">
            <h3 id="publication-${kind}-title">${label}</h3>${field}
            <label class="publication-toggle">
              <input type="checkbox" name="published" value="1"${item ? ' checked' : ''}
                aria-describedby="publication-${kind}-status" data-publication-toggle>
              <span>发布此项动态</span>
            </label>
            <p class="field-note" id="publication-${kind}-status" role="status" data-publication-status>${item
              ? '已发布，其他学生可在右侧动态栏查看。' : '未发布。'}</p>
            <p class="field-note flash--error" role="alert" data-publication-error hidden></p>
            <div class="actions">
              <button class="button button--quiet" type="submit" data-publication-save>保存发布设置</button>
              ${item ? `<button class="button button--quiet" type="submit" name="intent" value="update">更新发布内容</button>
                <a class="button button--plain" href="/student/dynamics/${item.id}">查看发布内容</a>` : ''}
            </div>
          </form>
        </div>`;
      }).join('')}
      </div></details>
    </section>` : '';
    return layout(state, title, `${heading(title, teacher ? '查看名下学生公开的进展与求助，并参与讨论。' : '分享研究进展，交流问题与想法。')}
      <section class="panel topics-panel">
      <div class="panel-heading"><h2>${teacher ? '名下学生的动态' : '交流广场'}</h2><span class="field-note">${paging.total} 条动态</span></div>
      ${personal ? `<div class="social-publish-prompt"><div><strong>分享进展，或向同学寻求帮助</strong>
        <p class="field-note">在周报里勾选要发布的内容，提交后就会出现在这里。仅审核通过的实验室成员可见。</p></div>
        <a class="button button--primary" href="/student/weekly">写周报并分享</a></div>` : ''}
      ${teacher ? `<p class="field-note">${e(state.publicationWeek)} 这一周。这里只展示学生选择分享的内容，完整周报请在「周报与请假」中查看。</p>` : `<nav class="social-tabs" aria-label="动态范围">
        <a href="/student/dynamics"${paging.scope === 'week' ? ' aria-current="page"' : ''}>本周</a>
        <a href="/student/dynamics?scope=all"${paging.scope === 'all' ? ' aria-current="page"' : ''}>全部动态</a>
      </nav>`}
      ${entries.length ? `<ul class="social-feed">${entries.map(item => `<li><article>
        <div class="social-meta"><strong>${e(item.author)}</strong>${item.studentId === state.user.id ? '<span class="badge">我</span>' : ''}
          <span class="social-kind">${e(publications[item.kind])}</span><span>${e(item.week)} 这一周</span></div>
        <a class="social-post-link" href="${base}/${item.id}"><p class="topics-text">${e(item.preview)}${item.preview.length === 220 ? '…' : ''}</p>
          <span class="social-discuss">${item.comments ? item.comments + ' 条回复' : '参与讨论'} <span aria-hidden="true">↗</span></span></a>
      </article></li>`).join('')}</ul>` : `<p class="empty">${teacher ? '名下学生本周还没有发布动态。' : '暂时没有发布的动态。可以在周报里分享进展，或发布一条动态摘要。'}</p>`}
      ${pagination(base + '?scope=' + paging.scope, paging)}
      </section>${source}`);
  }

  function pagination(path, { page, pages }) {
    if (pages <= 1) return '';
    return `<nav class="social-pagination" aria-label="分页">${page > 1 ? `<a href="${path}&page=${page - 1}">上一页</a>` : '<span>上一页</span>'}
      <span>第 ${page} / ${pages} 页</span>${page < pages ? `<a href="${path}&page=${page + 1}">下一页</a>` : '<span>下一页</span>'}</nav>`;
  }

  function commentForm(state, itemId, parent = null) {
    const fieldId = 'reply-' + (parent?.id ?? 'post');
    const base = state.user.role === 'teacher' ? '/teacher/dynamics' : '/student/dynamics';
    return form(state, base + '/' + itemId + '/comments', `
      ${parent ? `<input type="hidden" name="parentId" value="${parent.id}">` : ''}
      <label for="${fieldId}">${parent ? '回复 ' + e(parent.author) : '写下你的回复'}</label>
      <textarea id="${fieldId}" name="body" rows="3" maxlength="2000" required placeholder="可以分享建议、资料或你的经验。"></textarea>
      <div class="actions"><span class="field-note">最多 2000 字</span>${button('发表回复', 'primary')}</div>`, 'stack social-reply-form');
  }

  function commentTree(state, itemId, discussion, parentId = null) {
    const children = discussion.comments.filter(comment => comment.parentId === parentId);
    const base = state.user.role === 'teacher' ? '/teacher/dynamics' : '/student/dynamics';
    if (!children.length) return '';
    return `<ol class="social-comments${parentId === null ? ' social-comments-root' : ''}">${children.map(comment => `
      <li id="comment-${comment.id}" class="social-comment">
        <article>
          <div class="social-meta"><strong>${e(comment.author)}</strong>${comment.authorRole === 'teacher' ? '<span class="badge">教师</span>' : ''}<time datetime="${e(comment.createdAt)}">${e(new Date(Date.parse(comment.createdAt) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '))}</time></div>
          <p class="topics-text${!comment.body ? ' field-note' : ''}">${comment.body ? e(comment.body) : comment.deletedAt ? '该回复已删除。' : '该回复暂不可见。'}</p>
          <div class="social-comment-actions">
            ${discussion.canReply && !discussion.full && comment.depth < 5 ? `<details><summary>回复</summary>${commentForm(state, itemId, comment)}</details>` : ''}
            ${comment.canDelete ? form(state, base + '/comments/' + comment.id + '/delete', button('删除回复', 'plain')) : ''}
          </div>
        </article>${commentTree(state, itemId, discussion, comment.id)}
      </li>`).join('')}</ol>`;
  }

  function publication(state, item, discussion = { comments: [], total: 0, canReply: false, page: 1, pages: 1 }) {
    const teacher = state.user.role === 'teacher';
    const base = teacher ? '/teacher/dynamics' : '/student/dynamics';
    return layout(state, '动态详情', `
      <a class="back-link" href="${base}">${teacher ? '返回学生本周动态' : '返回成员动态'}</a>
      ${heading(publications[item.kind])}
      <article class="panel topics-panel">
        <div class="panel-heading"><h2>${e(item.author)}</h2><span class="field-note">${e(item.week)} 这一周</span></div>
        <p class="topics-text">${e(item.body)}</p>
      </article>
      <section class="panel topics-panel social-discussion" id="discussion">
        <div class="panel-heading"><h2>讨论</h2><span class="field-note">${discussion.total} 条回复</span></div>
        <p class="field-note">${teacher ? '可以回复学生，也可以继续讨论。' : '讨论仅对审核通过的实验室成员显示，'}时间按北京时间展示。</p>
        ${discussion.canReply && !discussion.full ? commentForm(state, item.id) : `<p class="empty">${discussion.full ? '回复数量已达上限。' : teacher ? '当前账号可浏览讨论。' : '毕业账号可浏览讨论。'}</p>`}
        ${discussion.comments.length ? commentTree(state, item.id, discussion) : `<p class="empty">${teacher ? '还没有回复，欢迎给学生一些建议。' : '还没有回复，欢迎分享你的想法。'}</p>`}
        ${pagination(base + '/' + item.id + '?discussion=1', discussion)}
      </section>`);
  }

  return { directory, detail, dashboard, teacherDashboard, feed, publication };
}
