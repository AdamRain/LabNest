import { t, h, locale, languageControl } from './i18n.mjs';
import { publicLinks, resumeSections } from './resume-export.mjs';
import { themeHead, themeControl } from './theme-ui.mjs';

export const siteFields = [
  { key: 'title', label: '个人简介标题', limit: 120, hint: '例如：计算机技术专业硕士生' },
  { key: 'bio', label: '个人介绍', limit: 1800, rows: 5, hint: '简要介绍自己正在做什么，以及关注的问题。发布主页前请先填写。' },
  { key: 'research', label: '研究方向', limit: 1800, rows: 3, hint: '每行一个方向，可补充简短说明。' },
  { key: 'education', label: '教育经历', limit: 3000, rows: 3, hint: '每行一段经历，注明时间、学校、专业和学位。' },
  { key: 'projects', label: '项目经历', limit: 5000, rows: 5, hint: '写清项目名称、承担的工作与结果。请勿填写未获准公开的项目内容。' },
  { key: 'publications', label: '论文与成果', limit: 5000, rows: 5, hint: '可填写论文、软件、专利等公开成果；相关网址可放在下方链接中。' },
  { key: 'awards', label: '奖励与荣誉', limit: 2500, rows: 3 },
  { key: 'skills', label: '技能', limit: 1500, rows: 3, hint: '例如编程语言、工具、实验方法。' },
  { key: 'links', label: '相关链接', limit: 3000, rows: 3, hint: '每行「名称｜https://网址」，例如 GitHub｜https://github.com/用户名。最多 10 条。' },
  { key: 'publicEmail', label: '公开联系邮箱', limit: 254, type: 'email', hint: '选填。单独填写愿意公开的邮箱；不会读取登录邮箱。' }
];

function shell(title, body, e, manager = false) {
  return h`<!doctype html><html lang="${locale()}"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="#edf5f1"><meta name="referrer" content="same-origin">
    <title>${e(title)}</title><link rel="icon" href="/lab-logo.png">
    <link rel="stylesheet" href="/student-site.css">
    ${manager ? '<meta name="robots" content="noindex,nofollow">' : ''}
    ${themeHead()}
    </head><body class="personal-site${manager ? ' personal-manager' : ''}">
    <a class="site-skip" href="#main">跳到正文</a>${body}</body></html>`;
}

function profileContent(profile, e, preview = false) {
  const links = publicLinks(profile.links);
  const hasContent = resumeSections.some(([key]) => profile[key]);
  return h`<div class="profile-grid">
    <aside class="profile-sidebar">
      <div class="profile-monogram" aria-hidden="true">${e([...profile.name][0] || t('我'))}</div>
      <h1>${e(profile.name)}</h1>
      ${profile.title ? h`<p class="profile-role">${e(profile.title)}</p>` : ''}
      ${profile.major ? h`<p class="profile-major">${e(profile.major)}</p>` : ''}
      ${profile.publicEmail || links.length ? h`<div class="profile-contact">
        ${profile.publicEmail ? h`<a href="mailto:${e(profile.publicEmail)}">${e(profile.publicEmail)}</a>` : ''}
        ${links.map(link => h`<a href="${e(link.url)}" rel="noopener noreferrer">${e(link.label)}<span aria-hidden="true">↗</span></a>`).join('')}
      </div>` : ''}
    </aside>
    <div class="profile-body">
      ${profile.bio ? h`<section class="profile-intro" aria-labelledby="bio-title"><h2 id="bio-title">个人介绍</h2>
        <div class="profile-text">${e(profile.bio)}</div></section>` : ''}
      ${resumeSections.filter(([key]) => key !== 'bio' && profile[key]).map(([key, label]) => h`
        <section class="profile-section" aria-labelledby="section-${key}"><h2 id="section-${key}">${e(t(label))}</h2>
          <div class="profile-text">${e(profile[key])}</div></section>`).join('')}
      ${!hasContent && preview ? h`<div class="profile-empty"><h2>从一段个人介绍开始</h2><p>保存左侧内容后，这里会显示主页预览。空白栏目不会出现在公开页面。</p></div>` : ''}
    </div>
  </div>`;
}

export function renderStudentHomepage(state, profile, options, { escapeHtml: e }) {
  const content = h`<header class="personal-header personal-frame">
    <a class="personal-wordmark" href="#main" aria-label="${e(t('{name}的个人主页', { name: profile.name }))}">${e(profile.name)}<span>的个人主页</span></a>
    <div class="personal-header-actions">${themeControl()}${languageControl()}${options.owner ? h`<a class="site-button site-button-soft" href="/student/homepage">编辑我的主页</a>` : ''}</div>
    </header>
    <main id="main" class="personal-frame public-profile" tabindex="-1">${profileContent(profile, e)}</main>
    <footer class="personal-footer personal-frame"><span>${e(state.siteName && state.siteName !== '研栖 · LabNest' ? state.siteName : t('研栖 · LabNest'))}</span>
      <span>个人主页</span></footer>`;
  return shell(t('{name}的个人主页', { name: profile.name }), content, e);
}

export function renderStudentSiteManager(state, site, { escapeHtml: e, token }) {
  const approved = state.user.reviewStatus === 'approved';
  const publicPath = h`/people/${state.user.id}`;
  const changed = site.published && site.revision !== site.publishedRevision;
  const input = ({ key, label, limit, hint, rows, type }) => h`<label class="site-field" for="profile-${key}">
    <span>${e(t(label))}</span>${rows
      ? h`<textarea id="profile-${key}" name="${key}" rows="${rows}" maxlength="${limit}" aria-describedby="hint-${key}">${e(site.draft[key])}</textarea>`
      : h`<input id="profile-${key}" name="${key}" type="${type || 'text'}" maxlength="${limit}" value="${e(site.draft[key])}" aria-describedby="hint-${key}"${type === 'email' ? ' autocomplete="off"' : ''}>`}
    <small id="hint-${key}">${hint ? e(t(hint)) : t('选填。')}</small></label>`;
  const content = h`<header class="personal-header personal-frame">
    <a class="personal-wordmark" href="/student/homepage">个人主页<span>与简历</span></a>
    <div class="personal-header-actions">${themeControl()}${languageControl()}<a class="site-button site-button-soft" href="/student">返回工作台</a></div></header>
    <main id="main" class="personal-frame manager-main" tabindex="-1">
      <header class="manager-title"><div><h1>让别人了解你的研究</h1>
        <p>先整理介绍和经历，确认后再公开。保存草稿不会改动已发布的主页。</p></div>
        <span class="site-status${site.published ? ' is-published' : ''}">${t(site.published ? '已公开' : '尚未公开')}</span></header>
      ${state.error ? h`<p class="site-message site-error" role="alert">${e(t(state.error))}</p>` : ''}
      ${state.notice ? h`<p class="site-message" role="status">${e(t(state.notice))}</p>` : ''}
      ${!approved ? h`<section class="site-panel site-awaiting"><h2>账号审核通过后即可维护主页</h2>
        <p>目前没有对外公开你的个人资料。审核结果可在工作台查看。</p></section>` : h`
      <section class="site-panel publication-panel" aria-labelledby="visibility-title">
        <div><h2 id="visibility-title">公开状态</h2>
          <p>${site.published ? h`访客可访问 <a href="${publicPath}">${publicPath}</a>${locale() === 'en' ? '. ' : '。'}${t(changed ? '草稿已有修改，需要重新发布后访客才会看到。' : '当前显示上次发布的版本。')}` : t('目前仅你能查看。发布后，持有链接的访客无需登录即可浏览。')}</p>
          <p class="site-note">仅公开下面填写的介绍、姓名和专业。周报、附件、生日、手机号和生活照均不会带入。</p>
        </div>
        <div class="publication-actions">
          <form method="post" action="/student/homepage/publish">${token(state)}
            <input type="hidden" name="revision" value="${site.revision}">
            <label class="site-check"><input type="checkbox" name="confirmPublic" value="1" required>
              <span>我确认将已保存的内容公开</span></label>
            <button class="site-button site-button-primary" type="submit">${t(site.published ? '更新公开主页' : '发布个人主页')}</button>
          </form>
          ${site.published ? h`<form method="post" action="/student/homepage/unpublish">${token(state)}
            <button class="site-button site-button-quiet" type="submit">撤下公开主页</button></form>` : ''}
        </div>
      </section>
      <div class="manager-grid">
        <section class="site-panel profile-editor" id="profile-editor" aria-labelledby="editor-title">
          <header><h2 id="editor-title">编辑介绍与经历</h2><p class="site-note">姓名和专业来自个人信息。其他栏目均可留空。</p></header>
          <form method="post" action="/student/homepage" class="site-form">${token(state)}
            <input type="hidden" name="revision" value="${site.revision}">
            ${siteFields.map(input).join('')}
            <label class="site-check"><input type="checkbox" name="publishEmail" value="1"${site.draft.publicEmail ? ' checked' : ''}>
              <span>在个人主页和简历中显示此邮箱</span></label>
            <button type="submit" class="site-button site-button-primary">保存草稿与预览</button>
          </form>
        </section>
        <div class="manager-preview-column">
          <section class="site-panel resume-panel" aria-labelledby="resume-title"><div>
            <h2 id="resume-title">导出个人简历</h2><p class="site-note">使用已保存的内容和生活照生成，不需要先公开主页。生活照可在<a href="/student/profile#photo-heading">个人信息</a>中更换或移除。</p></div>
            <div class="resume-actions"><a class="site-button site-button-soft" href="/student/resume.pdf">下载 PDF</a>
              <a class="site-button site-button-soft" href="/student/resume.docx">下载 Word</a></div></section>
          <section class="site-panel preview-panel" aria-labelledby="preview-title"><header class="preview-heading">
            <h2 id="preview-title">草稿预览</h2><span class="site-note">仅自己可见</span></header>
            ${profileContent(site.profile, e, true)}</section>
        </div>
      </div>`}
    </main><footer class="personal-footer personal-frame"><span>${e(state.siteName && state.siteName !== '研栖 · LabNest' ? state.siteName : t('研栖 · LabNest'))}</span><span>个人主页与简历</span></footer>`;
  return shell(t('个人主页与简历'), content, e, true);
}
