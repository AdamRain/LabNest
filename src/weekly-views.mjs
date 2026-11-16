import { t, h, locale } from './i18n.mjs';
import { renderPlanRich } from './rich-text.mjs';

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const obligationLabels = { required: '应交', exempt: '按人设置免交', leave: '请假免交', ineligible: '无需提交' };
const submissionLabels = { 'not-submitted': '未提交', submitted: '按时提交', late: '逾期提交' };
const leaveLabels = { pending: '待审批', approved: '已批准', rejected: '已驳回' };
const reportNotices = {
  draft: '草稿已保存。', submit: '周报已保存。', tasks: '上周任务状态已更新。', leave: '请假申请已提交。'
};
const dateTime = { format: value => new Intl.DateTimeFormat(locale(), {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).format(value) };

function timeLabel(value) {
  return value == null ? '—' : dateTime.format(value);
}

export function weeklyViews({ layout, escapeHtml: e, token }, leaveReasons) {
  function heading(title, note = '') {
    return h`<header class="page-heading"><h1>${title}</h1>${note ? h`<p>${note}</p>` : ''}</header>`;
  }

  function chooser(action, week, current, tab = '') {
    return h`<form class="actions weekly-chooser" action="${action}" method="get">
      ${tab ? h`<input type="hidden" name="tab" value="${tab}">` : ''}
      <label>选择周次 <input name="week" type="date" value="${week}" max="${current}" required></label>
      <button class="button button--quiet" type="submit">查看</button>
      ${week !== current ? h`<a class="button button--plain" href="${action}${tab ? h`?tab=${tab}` : ''}">返回本周</a>` : ''}
      <p class="field-note">选择周一，按北京时间统计。</p>
    </form>`;
  }

  function submissionBadge({ submission, overdue }) {
    const tone = submission === 'submitted' ? 'approved' : submission === 'late' || overdue ? 'rejected' : 'pending';
    return h`<span class="badge badge--${tone}">${t(submissionLabels[submission])}${overdue ? t(' · 已过截止') : ''}</span>`;
  }

  function labels(summary) {
    return h`${submissionBadge(summary)} <span class="badge">${t(obligationLabels[summary.obligation])}</span>${summary.report?.status === 'draft' ? h` <span class="badge">有草稿</span>` : ''}`;
  }

  function note(key) {
    return Object.hasOwn(reportNotices, key) ? h`<p class="flash flash--notice" role="status">${t(reportNotices[key])}</p>` : '';
  }

  function textField(title, body) {
    return h`<div><h3>${title}</h3>${body ? h`<p class="article-body">${e(body)}</p>` : h`<p class="field-note">未填写</p>`}</div>`;
  }

  function attachmentLink(state, attachment) {
    const prefix = ['admin', 'teacher'].includes(state.user?.role) ? '/teacher' : '/student';
    const size = Number(attachment.size);
    const sizeLabel = Number.isFinite(size) && size > 0
      ? (size >= 1024 * 1024 ? h`${(size / (1024 * 1024)).toFixed(1)} MB` : h`${Math.max(1, Math.round(size / 1024))} KB`) : '';
    return h`<a href="${prefix}/weekly/attachments/${e(attachment.id)}">${e(attachment.name)}</a>${sizeLabel ? h`<span class="field-note">${sizeLabel}</span>` : ''}`;
  }

  function attachmentList(state, attachments) {
    if (!attachments?.length) return h`<p class="field-note">未上传附件</p>`;
    return h`<ul class="weekly-attachment-list">${attachments.map((attachment) => h`<li>${attachmentLink(state, attachment)}</li>`).join('')}</ul>`;
  }

  function versions(state, report) {
    if (!report?.versions?.length) return h`<p class="empty">提交第一份周报后，可以在这里查看各次提交的内容。</p>`;
    return report.versions.map((version, index) => {
      const original = index === report.versions.length - 1;
      const title = original ? t('首次提交') : t('第 {version} 版', { version: report.versions.length - index });
      const topic = version.relatedTopic;
      return h`<details class="weekly-version" ${index === 0 ? 'open' : ''}>
        <summary><span>${title}${index === 0 ? h`<span class="badge">当前版本</span>` : ''}</span><time>${timeLabel(version.at)}</time></summary>
        <div class="stack weekly-version-body">
          <div><h3>工作计划</h3>${version.planRich ? h`<div class="weekly-rich-content">${renderPlanRich(version.planRich, { imagePrefix: ['admin', 'teacher'].includes(state.user?.role) ? '/teacher' : '/student' })}</div>` : version.plan?.length ? h`<ul>${version.plan.map((item) => h`<li>${e(item)}</li>`).join('')}</ul>` : h`<p class="field-note">未填写</p>`}</div>
          ${textField(t('论文学习'), version.reading)}
          ${textField(t('实验进展'), version.experiments)}
          ${textField(t('遇到的困难与需要的帮助'), version.difficulties)}
          ${topic ? textField(t('课题进展'), h`${topic.title}（${t(topic.stage)}）\n${topic.text}`) : ''}
          <div><h3>附件</h3>${attachmentList(state, version.attachments)}</div>
        </div>
      </details>`;
    }).join('');
  }

  function editor(state, summary, week, choices, values, publications) {
    if (!summary.canEdit) {
      return h`<p class="empty">当前周次无法编辑。${summary.report?.latestVersion ? t('已提交的内容可在历史版本中查看。') : t('请核对入组时间和补交范围。')}</p>`;
    }
    const report = summary.report;
    const draft = report?.latestVersion ?? report?.draft;
    const savedTopic = draft?.relatedTopic;
    const currentTopicId = values?.topicId ?? String(savedTopic?.id ?? '');
    const listed = choices.some((item) => String(item.id) === currentTopicId);
    const savedAttachments = draft?.attachments ?? [];
    const retainedValue = values?.retainedAttachmentIds ?? values?.retainedAttachment;
    const retained = values ? new Set((Array.isArray(retainedValue) ? retainedValue : retainedValue ? [retainedValue] : []).map(String)) : null;
    const shared = new Set(values?.shareKinds ?? (!report?.latestVersion && draft?.shareKinds ? draft.shareKinds : Object.keys(publications)));
    const share = kind => h`<label class="weekly-share-choice"><input type="checkbox" name="shareKind" value="${kind}"${shared.has(kind) ? ' checked' : ''}>发布到同学动态</label>`;
    let rich;
    try { rich = values?.planRich ? JSON.parse(values.planRich) : draft?.planRich; } catch { /* Keep the plain textarea available after an invalid submission. */ }
    return h`<form class="stack weekly-editor" action="/student/weekly" method="post" enctype="multipart/form-data">
      ${token(state)}
      <input type="hidden" name="week" value="${week}">
      <input type="hidden" name="revision" value="${report?.revision ?? 0}">
      <input type="hidden" name="publicationControls" value="1">
      <input type="hidden" name="richEditor" value="0">
      <input type="hidden" name="planRich" value="${e(JSON.stringify(rich ?? { version: 1, blocks: [] }))}">
      <div class="weekly-plan-field">
        <div class="weekly-field-heading"><label for="weekly-plan">工作计划</label>${share('plan')}</div>
        <p class="field-note" id="weekly-plan-note">每行填写一项，下周可逐项勾选完成情况。支持粘贴图片，图片计入附件数量。</p>
        <textarea id="weekly-plan" name="plan" rows="4" maxlength="2000" placeholder="填写接下来的工作安排">${e(values?.plan ?? draft?.plan?.join('\n') ?? '')}</textarea>
        <div class="weekly-rich-shell" data-rich-shell hidden>
          <div class="weekly-rich-toolbar" role="toolbar" aria-label="工作计划格式">
            <button type="button" data-rich-command="bold" aria-label="粗体" title="粗体（Ctrl/⌘ B）"><strong>B</strong></button>
            <button type="button" data-rich-command="italic" aria-label="斜体" title="斜体（Ctrl/⌘ I）"><em>I</em></button>
            <span class="weekly-toolbar-divider" aria-hidden="true"></span>
            <button type="button" data-rich-command="insertUnorderedList" aria-label="项目列表" title="项目列表">☷ <span>列表</span></button>
            <button type="button" data-rich-command="insertOrderedList" aria-label="编号列表" title="编号列表">1. <span>编号</span></button>
            <span class="weekly-toolbar-divider" aria-hidden="true"></span>
            <button type="button" data-rich-link aria-label="插入链接">↗ <span>链接</span></button>
            <button type="button" data-rich-image aria-label="插入图片">▧ <span>图片</span></button>
          </div>
          <div class="weekly-rich-link" data-rich-link-panel hidden><label>链接地址<input type="url" data-rich-link-url placeholder="https://" aria-label="链接地址"></label><button type="button" data-rich-link-apply>插入</button><button type="button" data-rich-link-cancel>取消</button></div>
          <div class="weekly-rich-content weekly-rich-input" data-rich-input contenteditable="true" role="textbox" aria-label="工作计划" aria-multiline="true" aria-describedby="weekly-plan-note">${rich ? renderPlanRich(rich) : ''}</div>
        </div>
        <p class="field-note weekly-editor-feedback" data-rich-feedback role="status" aria-live="polite"></p>
      </div>
      <div class="weekly-progress-fields">
        <div class="weekly-text-field"><div class="weekly-field-heading"><label for="weekly-reading">论文学习</label>${share('reading')}</div><textarea id="weekly-reading" name="reading" rows="5" maxlength="2000" placeholder="阅读了什么，有哪些收获">${e(values?.reading ?? draft?.reading ?? '')}</textarea></div>
        <div class="weekly-text-field"><div class="weekly-field-heading"><label for="weekly-experiments">实验进展</label>${share('experiments')}</div><textarea id="weekly-experiments" name="experiments" rows="5" maxlength="2000" placeholder="本周完成的工作、实验结果与分析">${e(values?.experiments ?? draft?.experiments ?? '')}</textarea></div>
      </div>
      <div class="weekly-text-field weekly-help-field"><div class="weekly-field-heading"><label for="weekly-difficulties">遇到的困难与需要的帮助</label>${share('difficulties')}</div><p class="field-note">可写清问题、已尝试的方法，以及希望老师或同学协助的内容。勾选后，同学可以在动态里回复。</p><textarea id="weekly-difficulties" name="difficulties" rows="3" maxlength="3000" placeholder="没有困难时可留空">${e(values?.difficulties ?? draft?.difficulties ?? '')}</textarea></div>
      <p class="field-note">勾选内容会在提交周报后发布给实验室同学；保存草稿不会发布。取消勾选并提交可撤回对应动态。</p>
      ${choices.length || currentTopicId ? h`<label>关联课题
        <select name="topicId"><option value="">不关联</option>
          ${currentTopicId && !listed ? h`<option selected value="${e(currentTopicId)}">原关联不可用，请重新选择</option>` : ''}
          ${choices.map(({ id, title, stage }) => h`<option value="${id}"${String(id) === currentTopicId ? ' selected' : ''}>${e(title)}（${e(t(stage))}）</option>`).join('')}
        </select>
      </label>
      <label>个人课题进展<textarea name="progress" rows="3" maxlength="1200">${e(values?.progress ?? savedTopic?.text ?? '')}</textarea></label>
      <p class="field-note">课题负责人可查看你提交的课题进展片段。</p>` : ''}
      <fieldset class="weekly-upload-field">
        <legend>附件</legend>
        ${values?.uploadNeedsRetry ? h`<p class="flash flash--notice" role="status">本次新选择的附件尚未保存，请重新选择并插入图片。填写的文字和原有附件仍然保留。</p>` : ''}
        ${savedAttachments.length ? h`<div class="weekly-retained-files"><p class="field-note">已上传的附件默认保留，取消勾选可从新版本中移除。</p><ul class="weekly-attachment-list">${savedAttachments.map((attachment) => h`<li><label class="weekly-retained-choice"><input type="checkbox" name="retainedAttachment" value="${e(attachment.id)}"${!retained || retained.has(String(attachment.id)) ? ' checked' : ''}><span>保留 <span class="weekly-file-name">${e(attachment.name)}</span></span></label><span class="weekly-file-download">${attachmentLink(state, attachment)}</span></li>`).join('')}</ul></div>` : ''}
        <label class="weekly-file-picker">添加附件<input type="file" name="attachments" multiple accept=".pdf,.doc,.docx,.md,.markdown,.jpg,.jpeg,.png,.gif,.webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,image/jpeg,image/png,image/gif,image/webp" aria-describedby="weekly-upload-note"></label>
        <p class="field-note" id="weekly-upload-note">支持 PDF、Word、Markdown（UTF-8）、JPG、PNG、GIF、WebP，每个不超过 5 MB，最多保留 5 个。历史版本中的附件会继续保留。</p>
      </fieldset>
      ${!report?.latestVersion && summary.pastDeadline ? h`<p class="weekly-deadline-note">首次提交已过截止时间，会记为逾期；提交后仍可修改。</p>` : ''}
      <div class="actions weekly-editor-actions">
        <button class="button button--primary" name="action" value="submit" type="submit">${report?.latestVersion ? t('保存新版本') : t('提交周报')}</button>
        ${!report?.latestVersion ? h`<button class="button button--quiet" name="action" value="draft" type="submit">保存草稿</button>` : ''}
        ${report?.latestVersion ? h`<p class="field-note">保存后会新增版本，首次提交时间不变。</p>` : ''}
      </div>
    </form>`;
  }

  function tasks(state, prior, week, editable) {
    if (!prior.length) return h`<p class="empty">没有上周已提交的工作计划。</p>`;
    const lines = prior.map((task) => h`<li>
      ${editable ? h`<div class="choices"><label><input type="checkbox" name="done" value="${task.index}"${task.done ? ' checked' : ''}> ${e(task.text)}</label></div>`
        : h`<span class="badge">${task.done ? t('已完成') : t('待完成')}</span> ${e(task.text)}`}
      ${task.history.length ? h`<details><summary>任务变动记录</summary><ul>
        ${task.history.map((event) => h`<li>${timeLabel(event.at)} · ${event.done ? t('标记完成') : t('取消完成')}</li>`).join('')}
      </ul></details>` : ''}
    </li>`).join('');
    if (!editable) return h`<ul class="record-list">${lines}</ul>`;
    return h`<form class="stack" action="/student/weekly/tasks" method="post">${token(state)}
      <input type="hidden" name="week" value="${week}"><input type="hidden" name="originVersionId" value="${prior[0].sourceVersionId}"><ul class="record-list">${lines}</ul>
      <button class="button button--quiet" type="submit">保存任务状态</button></form>`;
  }

  function leaveEntries(state, entries, week, teacher = false) {
    if (!entries.length) return h`<p class="empty">暂无请假记录。</p>`;
    return h`<ul class="record-list">${entries.map((leave) => h`<li class="stack">
      <div>${teacher ? h`<strong>${e(leave.name)}</strong> · ` : ''}
        ${leave.date_from} 至 ${leave.date_to} · ${t(leaveReasons[leave.reason])} ·
        <span class="badge">${t(leaveLabels[leave.status])}</span></div>
      ${leave.note ? h`<p class="article-body">${e(leave.note)}</p>` : ''}
      ${leave.reviewed_at ? h`<p>审批时间 ${timeLabel(leave.reviewed_at)}${leave.review_note ? h` · ${e(leave.review_note)}` : ''}</p>` : ''}
      ${teacher && leave.status === 'pending' ? h`<form class="stack" action="/teacher/weekly/leave/${leave.id}" method="post">
        ${token(state)}<input type="hidden" name="week" value="${week}">
        <label>审批说明<input name="note" maxlength="500"></label>
        <div class="actions">
          <button class="button button--primary" name="decision" value="approved">批准</button>
          <button class="button button--quiet" name="decision" value="rejected">驳回</button>
        </div>
      </form>` : ''}
    </li>`).join('')}</ul>`;
  }

  function student(state, { summary, week, current, prior, leaves, choices = [], publications = {}, done, values, tab = 'report' }) {
    const selected = ['report', 'history', 'leave'].includes(tab) ? tab : 'report';
    const versionCount = summary.report?.versions?.length ?? 0;
    const tabs = [
      ['report', t('填写周报')],
      ['history', h`历史版本${versionCount ? h` <span>${versionCount}</span>` : ''}`],
      ['leave', t('请假')]
    ];
    const overview = h`<div class="weekly-status"><div class="weekly-status-badges">${labels(summary)}</div><p>个人截止 <strong>${timeLabel(summary.dueAt)}</strong></p></div>`;
    let content;
    if (selected === 'history') {
      content = h`<section class="panel weekly-history stack" aria-labelledby="weekly-history-heading">
        <header class="weekly-section-heading"><h2 id="weekly-history-heading">历史版本</h2><p class="field-note">${versionCount ? h`共 ${versionCount} 个版本，最近保存的内容排在最前。` : t('已提交的内容会按版本保留。')}</p></header>
        ${summary.report?.firstSubmittedAt != null ? h`<div class="weekly-first-submit"><span>首次提交 <strong>${timeLabel(summary.report.firstSubmittedAt)}</strong></span><span>首次提交时的截止 <strong>${timeLabel(summary.report.firstCutoffAt)}</strong></span></div>` : ''}
        <div class="weekly-version-list">${versions(state, summary.report)}</div>
      </section>`;
    } else if (selected === 'leave') {
      content = h`<div class="weekly-leave-layout">
        <section class="panel stack weekly-leave-form" aria-labelledby="weekly-leave-heading">
          <header class="weekly-section-heading"><h2 id="weekly-leave-heading">申请请假</h2><p class="field-note">获批且覆盖整周的请假计为免交，已提交的周报仍会保留。</p></header>
          <form class="stack" action="/student/weekly/leave" method="post">
            ${token(state)}
            <div class="form-grid"><label>开始日期<input type="date" name="from" required></label>
            <label>结束日期<input type="date" name="to" required></label></div>
            <label>请假事由<select name="reason">
              ${Object.entries(leaveReasons).map(([key, label]) => h`<option value="${key}">${e(t(label))}</option>`).join('')}
            </select></label>
            <label>补充说明<textarea name="note" rows="3" maxlength="500"></textarea></label>
            <button class="button button--primary" type="submit">提交请假申请</button>
          </form>
        </section>
        <section class="panel stack weekly-leave-records" aria-labelledby="weekly-leave-records-heading"><h2 id="weekly-leave-records-heading">请假记录</h2>${leaveEntries(state, leaves, week)}</section>
      </div>`;
    } else {
      content = h`<div class="weekly-report-layout">
        <section class="panel stack weekly-writing" aria-labelledby="weekly-writing-heading">
          <header class="weekly-section-heading"><h2 id="weekly-writing-heading">${week === current ? t('本周周报') : t('{week} 这一周', { week })}</h2><p class="field-note">${summary.report?.latestVersion ? t('继续补充本周的工作，保存后可在历史版本中查看修改前的内容。') : t('记录工作进展，也可以先保存草稿。')}</p></header>
          ${editor(state, summary, week, choices, values, publications)}
        </section>
        <aside class="panel stack weekly-prior" aria-labelledby="weekly-prior-heading">
          <header class="weekly-section-heading"><h2 id="weekly-prior-heading">上周任务</h2><p class="field-note">回顾上周计划，勾选已经完成的事项。</p></header>
          ${tasks(state, prior, week, week === current)}
          ${versionCount ? h`<a class="weekly-history-link" href="/student/weekly?week=${week}&amp;tab=history">查看 ${versionCount} 个历史版本</a>` : ''}
        </aside>
      </div>`;
    }
    return layout(state, t('周报'), h`<div class="weekly-page">
      <div class="weekly-topbar">${heading(t('周报'), t('提交后可继续修改，历史版本会保留。'))}${chooser('/student/weekly', week, current, selected)}</div>
      ${overview}
      <nav class="weekly-tabs" aria-label="周报功能">${tabs.map(([key, label]) => h`<a href="/student/weekly?week=${week}&amp;tab=${key}"${key === selected ? ' aria-current="page"' : ''}>${t(label)}</a>`).join('')}</nav>
      ${note(done)}
      ${content}
    </div>`);
  }

  function teacher(state, { week, current, rows, leaves, reviewed }) {
    const count = (predicate) => rows.filter(predicate).length;
    return layout(state, t('周报管理'), h`<div class="weekly-page weekly-teacher-page">
      <div class="weekly-topbar">${heading(t('周报管理'))}${chooser('/teacher/weekly', week, current)}</div>
      ${reviewed ? h`<p class="flash flash--notice" role="status">请假审批结果已保存。</p>` : ''}
      <div class="weekly-teacher-sections">
        <section class="panel weekly-roster-panel stack" aria-labelledby="weekly-roster-heading">
          <h2 id="weekly-roster-heading">${t('{week} 这一周', { week })}</h2>
          <p class="weekly-roster-summary">${t('按时 {onTime} 人 · 逾期提交 {late} 人 · 应交未交 {missing} 人 · 请假免交 {leave} 人', {
            onTime: count(row => row.submission === 'submitted'), late: count(row => row.submission === 'late'),
            missing: count(row => row.required && row.submission === 'not-submitted'), leave: count(row => row.obligation === 'leave') })}</p>
          ${rows.length ? h`<p class="field-note weekly-roster-scroll-hint" id="weekly-roster-scroll-hint">左右滑动可查看完整名单，点击姓名查看周报。</p>
          <div class="weekly-roster-scroll" role="region" aria-label="${week} 学生周报名单" tabindex="0">
            <table class="weekly-roster">
              <thead><tr><th scope="col">学生</th><th scope="col">提交状态</th><th scope="col">提交要求</th><th scope="col">截止时间（北京时间）</th></tr></thead>
              <tbody>${rows.map(row => h`<tr>
                <th scope="row"><a href="/teacher/weekly/${row.student.id}?week=${week}">${e(row.student.name)}</a></th>
                <td><div class="weekly-roster-status">${submissionBadge(row)}${row.report?.status === 'draft' ? h`<span class="badge">有草稿</span>` : ''}</div></td>
                <td><span class="badge">${t(obligationLabels[row.obligation])}</span></td>
                <td class="weekly-roster-deadline">${row.dueAt == null ? '—' : h`<time datetime="${new Date(row.dueAt).toISOString()}">${timeLabel(row.dueAt)}</time>`}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>` : h`<p class="empty">暂无学生。</p>`}
        </section>
        <section class="panel dashboard-section stack">
          <h2>请假审批</h2>
          <p class="field-note">显示全部待审批申请和本周请假记录。</p>
          ${leaveEntries(state, leaves, week, true)}
        </section>
      </div></div>`);
  }

  function policyForm(state, summary, week, current) {
    if (week !== current || summary.obligation === 'ineligible') return '';
    const { settings, student } = summary;
    return h`<section class="panel dashboard-section stack">
      <h2>个人周报设置</h2>
      <form class="stack" action="/teacher/weekly/${student.id}/policy" method="post">${token(state)}
        <input type="hidden" name="week" value="${week}">
        <label>生效范围<select name="scope"><option value="week">仅本周</option><option value="recurring">从本周起每周生效</option></select></label>
        <p class="field-note">本周专门设置优先于每周设置。</p>
        <label>提交要求<select name="required">
          <option value="1"${settings.required ? ' selected' : ''}>应交</option>
          <option value="0"${settings.required ? '' : ' selected'}>免交</option></select></label>
        <div class="form-grid">
          <label>截止星期<select name="weekday">${weekdays.map((name, index) =>
            h`<option value="${index}"${index === settings.weekday ? ' selected' : ''}>${t(name)}</option>`).join('')}</select></label>
          <label>截止时间（北京时间）<input type="time" name="time" value="${settings.time}" required></label>
        </div>
        <button class="button button--primary" type="submit">保存设置</button>
      </form>
    </section>`;
  }

  function detail(state, { summary, week, current, prior, updated }) {
    return layout(state, t('学生周报'), h`
      <a class="back-link" href="/teacher/weekly?week=${week}">返回周报管理</a>
      ${heading(e(summary.student.name) + t('的周报'))}
      ${chooser('/teacher/weekly/' + summary.student.id, week, current)}
      ${updated ? h`<p class="flash flash--notice" role="status">周报设置已更新。</p>` : ''}
      <div class="dashboard-grid">
        <section class="panel dashboard-section stack">
          <h2>${t('{week} 这一周', { week })}</h2>
          <div>${labels(summary)} <span>个人截止 ${timeLabel(summary.dueAt)}</span></div>
          ${summary.report?.firstSubmittedAt != null
            ? h`<p class="field-note">首次提交 ${timeLabel(summary.report.firstSubmittedAt)} · 当时的截止 ${timeLabel(summary.report.firstCutoffAt)}</p>` : ''}
          <div class="weekly-version-list">${versions(state, summary.report)}</div>
        </section>
        <section class="panel dashboard-section stack"><h2>上周任务</h2>${tasks(state, prior, week, false)}</section>
        ${policyForm(state, summary, week, current)}
      </div>`);
  }

  return { student, teacher, detail };
}
