import { t, h, locale, languageControl } from './i18n.mjs';
import { escapeHtml as e } from './views.mjs';
import { themeHead, themeControl } from './theme-ui.mjs';

const fallbackName = '研栖 · LabNest';
const fallbackCenter = '演示实验室';
const navigation = [
  ['/', '首页'], ['/about', '团队介绍'], ['/research', '研究方向'], ['/publications', '科研成果'],
  ['/news', '新闻动态'], ['/contact', '招生联系']
];
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const categoryNames = { lab: '中心动态', reading: '论文学习' };
const resultKinds = { paper: '论文', patent: '专利', research: '科研项目', industry: '横向项目', award: '竞赛获奖' };
const researchArt = new Map([
  ['网络安全与性能优化', { file: 'team-research-network.svg', alt: '网络节点与多条传输路径' }],
  ['网络数据感知与分析', { file: 'team-research-data.svg', alt: '多种形态的数据汇入同一个分析流程' }],
  ['智能信息服务平台', { file: 'team-research-services.svg', alt: '信息服务连接文化资源、工业和医疗场景' }]
]);

function teamName(profile) {
  if (locale() === 'en' && profile.englishName) return profile.englishName;
  return !profile.name || profile.name === fallbackName ? t(fallbackName) : profile.name;
}
function centerName(profile) {
  return !profile.centerName || profile.centerName === fallbackCenter ? t(fallbackCenter) : profile.centerName;
}

function publicHomePath(state) {
  return state.publicHomePath || '/portal';
}

function dateFor(article) {
  return article.eventDate || dateFormat.format(new Date(article.createdAt));
}

function monthDay(date) {
  return date.slice(5).replace('-', '.');
}

function directionParts(direction) {
  const [name, ...details] = direction.split('｜');
  return { name: name.trim(), detail: details.join('｜').trim() };
}

function textExcerpt(text, max = 104) {
  const value = String(text ?? '').trim().replace(/\s+/g, ' ');
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function publicLink(value) {
  const url = URL.parse(value ?? '');
  return url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
}

function publicLayout(state, data, pageTitle, body) {
  const name = teamName(data.profile);
  const center = centerName(data.profile);
  const copyrightYear = dateFormat.format(new Date()).slice(0, 4);
  const entry = state.user?.role === 'admin' ? '/admin' : state.user?.role === 'teacher' ? '/teacher' : '/student';
  const account = state.user
    ? h`<a class="public-member" href="${entry}">进入工作台</a>`
    : h`<a class="public-member" href="/login">登录</a>`;
  const current = state.path?.startsWith('/news/') ? '/news' : state.path === '/portal' ? '/' : state.path;
  return h`<!doctype html>
<html lang="${locale()}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#f5faf8">
  <meta name="description" content="${e(textExcerpt(data.profile.intro, 160) || t('{name}的新闻动态、研究方向和公开成果。', { name }))}">
  <title>${e(pageTitle ? pageTitle + ' · ' + name : name)}</title>
  <link rel="icon" href="/lab-logo.png">
  <link rel="stylesheet" href="/portal.css">
  <script type="module" src="/portal-navigation.js"></script>
  ${themeHead()}
</head>
<body class="public-site">
  <a class="public-skip" href="#main">跳到正文</a>
  <header class="public-frame public-header">
    <div class="public-masthead">
      <a class="public-brand" href="${publicHomePath(state)}" translate="no">
        <img src="/lab-logo.png" width="48" height="48" alt="">
        <span><b>${e(name)}</b><small>${e(center)}</small></span>
      </a>
      <nav class="public-member-nav" aria-label="成员入口">${themeControl()}${languageControl()}${account}</nav>
    </div>
    <div class="public-nav-band">
      <div class="public-nav-row">
        <button class="public-menu-toggle hs-collapse-toggle" id="portal-menu-toggle" type="button"
          aria-expanded="false" aria-controls="portal-menu" data-hs-collapse="#portal-menu" hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          网站栏目
        </button>
        <div class="public-nav-panel hs-collapse" id="portal-menu">
          <nav class="public-nav" aria-label="团队网站栏目">
            ${navigation.map(([path, label]) => h`<a href="${path === '/' ? publicHomePath(state) : path}"${current === path ? ' aria-current="page"' : ''}>${t(label)}</a>`).join('')}
          </nav>
        </div>
        ${state.preview ? h`<span class="public-preview">本机试用</span>` : ''}
      </div>
    </div>
  </header>
  <main id="main" tabindex="-1">${body}</main>
  <footer class="public-footer"><div class="public-frame">
    <div class="public-footer-main">
      <strong>${e(name)}</strong>
      <nav aria-label="页脚"><a href="/news">动态归档</a><a href="/contact">招生联系</a>
        <a href="${state.user ? entry : '/login'}">${t(state.user ? '工作台' : '成员登录')}</a></nav>
    </div>
    <div class="public-footer-legal">
      <img src="/lab-logo.png" width="32" height="32" alt="" loading="lazy">
      <div>
        <p>© ${copyrightYear} ${t(fallbackCenter)} 版权所有</p>
        <p class="public-footer-credit">设计与开发：<span lang="en">R_C</span></p>
      </div>
    </div>
  </div></footer>
</body>
</html>`;
}

function sourceLink(data) {
  const reference = publicLink(data.profile.referenceUrl);
  return reference ? h`<a href="${e(reference)}">资料来源</a>` : '';
}

function sectionPage(state, data, title, body) {
  return publicLayout(state, data, title, h`<div class="public-frame public-section public-inner">
    <a class="public-back" href="${publicHomePath(state)}">返回首页</a>
    <header class="public-section-title"><h1>${e(t(title))}</h1></header>
    ${body}</div>`);
}

function recentNews(articles) {
  return h`<aside id="updates" class="public-home-news" aria-labelledby="updates-title">
    <h2 id="updates-title">近期动态</h2>
    ${articles.length ? h`<ol class="public-news-digest">${articles.map((article, index) => {
      const date = dateFor(article);
      return h`<li><time datetime="${e(date)}"><b>${e(monthDay(date))}</b><small>${e(date.slice(0, 4))}</small></time>
        <div><div class="public-meta">${e(t(categoryNames[article.category]))}</div>
        <h3><a href="/news/${article.id}">${e(article.title)}</a></h3>
        ${index === 0 ? h`<p>${e(textExcerpt(article.body, 70))}</p>` : ''}</div></li>`;
    }).join('')}</ol>` : h`<p class="public-empty">暂无已发布动态。</p>`}
    <a class="public-more" href="/news">查看全部动态</a>
  </aside>`;
}

function researchGallery(directions) {
  const names = [...new Set(directions.map(direction => directionParts(direction).name))];
  const slides = names.filter(name => researchArt.has(name)).map(name => ({ name, ...researchArt.get(name) }));
  if (!slides.length) return h`<figure class="public-figure public-figure--brand">
    <div class="public-cover" aria-hidden="true">
      <img class="public-cover-pattern" src="/team-cover.svg" width="560" height="315" alt="">
      <img class="public-cover-logo" src="/lab-logo.png" width="180" height="180" alt="">
    </div>
    <figcaption>团队标识</figcaption>
  </figure>`;

  return h`<div class="public-gallery" data-portal-gallery>
    ${slides.map(({ name, file, alt }, index) => h`<figure class="public-figure" data-gallery-slide${index ? ' hidden' : ''}>
      <img class="public-cover-image" src="/${file}" width="1200" height="620" alt="${e(t(alt))}" ${index ? '' : 'fetchpriority="high"'}>
      <figcaption><span class="public-figure-kind">研究示意图</span><span data-gallery-caption>${e(name)}</span></figcaption>
    </figure>`).join('')}
    ${slides.length > 1 ? h`<div class="public-gallery-controls" hidden>
      <button type="button" data-gallery-step="-1" aria-label="上一张研究示意图">‹</button>
      <span data-gallery-count aria-hidden="true"></span>
      <button type="button" data-gallery-step="1" aria-label="下一张研究示意图">›</button>
    </div><span class="public-visually-hidden" data-gallery-status role="status"></span>
    <script src="/portal-gallery.js" defer></script>` : ''}
  </div>`;
}

function compactNews(article) {
  const date = dateFor(article);
  return h`<li class="public-news-item">
    <time datetime="${e(date)}"><b>${e(monthDay(date))}</b><small>${e(date.slice(0, 4))}</small></time>
    <div><div class="public-meta">${e(t(categoryNames[article.category]))}</div>
      <a href="/news/${article.id}">${e(article.title)}</a></div>
  </li>`;
}

function directionList(directions, detailPage = false) {
  const heading = detailPage ? 'h2' : 'h3';
  return directions.length ? h`<ul class="public-direction-grid${detailPage ? ' public-direction-grid--detail' : ''}">${directions.map((direction, index) => {
    const { name, detail } = directionParts(direction);
    const id = 'direction-' + (index + 1);
    const art = detailPage ? researchArt.get(name) : null;
    return h`<li${detailPage ? h` id="${id}"` : ''}>
      <div><${heading}>${detailPage ? e(name) : h`<a href="/research#${id}">${e(name)}</a>`}</${heading}>
      ${detail ? h`<p>${e(detail)}</p>` : ''}</div>
      ${art ? h`<figure><img src="/${art.file}" width="1200" height="620" loading="lazy" alt="${e(t(art.alt))}"><figcaption>研究示意图</figcaption></figure>` : ''}</li>`;
  }).join('')}</ul>` : h`<p class="public-empty">暂无已发布的研究方向。</p>`;
}

function resultList(results, heading = 'h3') {
  return results.length ? h`<ul class="public-result-list">${results.map(item => {
    const url = publicLink(item.url);
    return h`<li><div class="public-meta"><span>${e(t(resultKinds[item.kind] ?? '成果'))}</span><time datetime="${e(item.date)}">${e(item.date.slice(0, 4))}</time></div>
      <${heading}>${url ? h`<a href="${e(url)}">${e(item.title)}</a>` : e(item.title)}</${heading}>
      ${item.summary ? h`<p>${e(item.summary)}</p>` : ''}</li>`;
  }).join('')}</ul>` : h`<p class="public-empty">暂无符合条件的公开成果。</p>`;
}

export function portalPage(state, articles, data) {
  const { profile } = data;
  return publicLayout(state, data, '', h`
    <div class="public-home-lead"><div class="public-frame public-home-grid">
      <div class="public-home-intro">
        <h1 id="team-title">${e(teamName(profile))}</h1>
        ${profile.englishName ? h`<p class="public-english" lang="en">${e(profile.englishName)}</p>` : ''}
        ${profile.intro ? h`<p class="public-intro">${e(textExcerpt(profile.intro, 210))}</p>` : ''}
        <div class="public-intro-links"><a href="/about">团队介绍</a><a href="/contact">招生联系</a></div>
      </div>
      ${recentNews(articles.slice(0, 4))}
      <div class="public-home-figure">${researchGallery(data.directions)}</div>
    </div></div>
    <div class="public-frame public-home-index">
      <section id="research" class="public-section public-home-section">
        <header class="public-section-title"><h2>研究方向</h2><a href="/research">全部方向</a></header>
        ${directionList(data.directions.slice(0, 3))}
        ${state.preview && profile.referenceUrl ? h`<p class="public-affiliation">试用内容整理自学院公开的相关团队介绍。</p>` : ''}
      </section>
      <section id="results" class="public-section public-home-section">
        <header class="public-section-title"><h2>精选成果</h2><a href="/publications">全部成果</a></header>
        ${resultList(data.results.slice(0, 3))}
      </section>
    </div>`);
}

export function aboutPage(state, data) {
  const { profile, people } = data;
  const name = teamName(profile);
  const center = centerName(profile);
  return sectionPage(state, data, t('团队介绍'), h`
    <section class="public-detail-section">
      <h2>${e(name)}</h2><p class="public-affiliation">所属平台　${e(center)}</p>
      ${profile.intro ? h`<p class="public-prose">${e(profile.intro)}</p>` : ''}
      ${sourceLink(data)}
    </section>
    <section class="public-detail-section" id="people"><h2>团队成员</h2>
      ${people?.length ? h`<ul class="public-people-list">${people.map(person => h`<li>
        <h3>${e(person.name)}</h3>
        ${person.role ? h`<p class="public-meta">${e(person.role)}</p>` : ''}
        ${person.description ? h`<p class="public-prose">${e(person.description)}</p>` : ''}
      </li>`).join('')}</ul>` : h`<p class="public-empty">暂无公开的成员资料。</p>`}
    </section>`);
}

export function researchPage(state, data) {
  return sectionPage(state, data, t('研究方向'), h`
    ${state.preview && data.profile.referenceUrl ? h`<p class="public-affiliation">试用版研究方向整理自学院公开的相关团队介绍。</p>` : ''}
    ${directionList(data.directions, true)}
    ${sourceLink(data) ? h`<p class="public-source">${sourceLink(data)}</p>` : ''}`);
}

export function publicationsPage(state, data, query) {
  const kind = Object.hasOwn(resultKinds, query.get('kind')) ? query.get('kind') : '';
  const years = [...new Set(data.results.map(item => item.date.slice(0, 4)))].sort().reverse();
  const year = years.includes(query.get('year')) ? query.get('year') : '';
  const shown = data.results.filter(item => (!kind || item.kind === kind) && (!year || item.date.startsWith(year)));
  return sectionPage(state, data, t('科研成果'), h`
    <form class="public-filter" method="get" action="/publications">
      <label>类型<select name="kind"><option value="">全部类型</option>
        ${Object.entries(resultKinds).map(([key, label]) => h`<option value="${key}"${key === kind ? ' selected' : ''}>${t(label)}</option>`).join('')}
      </select></label>
      <label>年份<select name="year"><option value="">全部年份</option>
        ${years.map(value => h`<option value="${e(value)}"${value === year ? ' selected' : ''}>${e(value)}</option>`).join('')}
      </select></label><button type="submit">筛选</button>
    </form>${resultList(shown, 'h2')}`);
}

export function contactPage(state, data) {
  const { profile } = data;
  return sectionPage(state, data, t('招生联系'), h`
    ${profile.admissions ? h`<section class="public-detail-section"><h2>招生与合作</h2><p class="public-prose">${e(profile.admissions)}</p></section>` : ''}
    ${profile.contact ? h`<section class="public-detail-section"><h2>联系方式</h2><p class="public-prose">${e(profile.contact)}</p></section>` : ''}
    ${!profile.admissions && !profile.contact ? h`<p class="public-empty">暂无公开的招生与联系信息。</p>` : ''}`);
}

export function newsArchive(state, articles, data, query) {
  const category = Object.hasOwn(categoryNames, query.get('category')) ? query.get('category') : '';
  const q = query.get('q')?.trim().slice(0, 100) ?? '';
  const filtered = articles.filter(article => (!category || article.category === category)
    && (!q || (article.title + '\n' + article.body).toLowerCase().includes(q.toLowerCase())));
  return publicLayout(state, data, t('新闻动态'), h`
    <div class="public-frame public-section public-archive">
      <a class="public-back" href="${publicHomePath(state)}">← 首页</a>
      <header class="public-section-title"><h1>新闻动态</h1></header>
      <form class="public-filter" method="get" action="/news">
        <label>搜索动态 <input type="search" name="q" value="${e(q)}" maxlength="100" autocomplete="off"></label>
        <label>分类 <select name="category"><option value="">全部分类</option>
          ${Object.entries(categoryNames).map(([key, label]) => h`<option value="${key}"${key === category ? ' selected' : ''}>${t(label)}</option>`).join('')}
        </select></label><button type="submit">查找</button>
      </form>
      ${filtered.length ? h`<ul class="public-news-list public-archive-list">${filtered.map(compactNews).join('')}</ul>`
        : h`<p class="public-empty">${t(articles.length ? '没有符合条件的动态。' : '暂无已发布动态。')}</p>`}
    </div>`);
}

export function publicArticlePage(state, article, data) {
  const date = dateFor(article);
  const source = publicLink(article.sourceUrl);
  return publicLayout(state, data, article.title, h`
    <article class="public-frame public-section public-article">
      <a class="public-back" href="/news">← 全部动态</a>
      <header><div class="public-meta"><span>${e(t(categoryNames[article.category]))}</span><time datetime="${e(date)}">${e(date)}</time></div>
        <h1>${e(article.title)}</h1></header>
      <div class="public-prose">${e(article.body)}</div>
      ${source ? h`<p class="public-source"><a href="${e(source)}">查看原始来源 <span aria-hidden="true">↗</span></a></p>` : ''}
    </article>`);
}
