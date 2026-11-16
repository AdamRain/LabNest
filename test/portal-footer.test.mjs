import test from 'node:test';
import assert from 'node:assert/strict';
import {
  portalPage, aboutPage, researchPage, publicationsPage, contactPage, newsArchive, publicArticlePage
} from '../src/portal-views.mjs';

const owner = '演示实验室';
const data = {
  profile: { name: '研栖 · LabNest', centerName: owner, intro: '团队公开介绍' },
  directions: [], people: [], results: []
};
const article = { id: 1, title: '公开新闻', category: 'lab', body: '已公开的新闻内容', createdAt: '2026-11-16T01:00:00Z' };
const query = new URLSearchParams();
const pages = [
  ['/portal', state => portalPage(state, [article], data)],
  ['/about', state => aboutPage(state, data)],
  ['/research', state => researchPage(state, data)],
  ['/publications', state => publicationsPage(state, data, query)],
  ['/contact', state => contactPage(state, data)],
  ['/news', state => newsArchive(state, [article], data, query)],
  ['/news/1', state => publicArticlePage(state, article, data)]
];

const footerOf = page => {
  const footer = page.match(/<footer class="public-footer">[\s\S]*?<\/footer>/)?.[0];
  assert.ok(footer, '公开页面需要统一页脚');
  return footer;
};

test('全部公开栏目使用同一版权主体与开发署名，页脚在正文后并加载当前系统Logo', () => {
  const year = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date());
  for (const [path, render] of pages) {
    const page = render({ path, publicHomePath: '/portal' });
    const footer = footerOf(page);
    assert.equal(page.match(/<footer\b/g)?.length, 1, path);
    assert.ok(page.indexOf('</main>') < page.indexOf('<footer'), path);
    assert.ok(footer.includes(`© ${year} ${owner} 版权所有`), path);
    assert.match(footer, /设计与开发：[\s\S]*R_C/, path);
    assert.match(footer, /<img src="\/lab-logo\.png" width="32" height="32" alt=""/, path);
    assert.doesNotMatch(footer, /备案|RuanMei|ithome\.com/, path);
    // The image response may be PNG or JPEG after a Logo change.
    assert.match(page, /<link rel="icon" href="\/lab-logo\.png">/, path);
  }
});

test('团队可编辑名称不能注入页脚或改写指定版权主体；成员入口保留身份分流', () => {
  const malicious = { ...data, profile: { ...data.profile, name: '<img src=x onerror=alert(1)>', centerName: '其他可编辑中心名' } };
  for (const [role, entry] of [['admin', '/admin'], ['teacher', '/teacher'], ['student', '/student']]) {
    const page = aboutPage({ path: '/about', user: { role } }, malicious);
    const footer = footerOf(page);
    assert.ok(footer.includes(owner + ' 版权所有'));
    assert.match(footer, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(footer, /<img src=x/);
    assert.ok(footer.includes(`href="${entry}"`));
    assert.doesNotMatch(footer, /其他可编辑中心名 版权所有/);
  }
});
