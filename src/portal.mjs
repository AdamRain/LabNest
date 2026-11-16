import { resultKinds } from './management-views.mjs';
import { openSiteBranding } from './site-branding.mjs';

const defaultName = '研栖 · LabNest';
const defaultCenter = '演示实验室';
const editorPath = '/teacher/portal';
const profileFields = [
  { key: 'name', label: '团队中文名称', limit: 100, required: true },
  {
    key: 'centerName', label: '所属研究中心', limit: 140,
    hint: '留空时使用默认的研究中心名称。'
  },
  { key: 'englishName', label: '团队英文名称（选填）', limit: 160 },
  { key: 'intro', label: '团队简介（选填）', limit: 2200, multiline: true },
  {
    key: 'research', label: '研究方向（选填）', limit: 2200, multiline: true,
    hint: '每行填写一个方向，可用「方向｜简短说明」分隔标题与说明。'
  },
  {
    key: 'people', label: '公开团队成员（选填）', limit: 1200, multiline: true,
    hint: '每行填写一人，格式为「姓名｜角色｜简介」。角色和简介可留空，请仅填写获准公开的资料。'
  },
  { key: 'admissions', label: '招生与合作（选填）', limit: 1500, multiline: true },
  { key: 'contact', label: '公开联系方式（选填）', limit: 800, multiline: true },
  { key: 'referenceUrl', label: '资料来源链接（选填）', limit: 500, type: 'url' }
];
const summaryLimit = 1200;
const resultUrlLimit = 500;

function website(value) {
  const url = URL.parse(value);
  if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  return '';
}

function lines(value) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function publicPeople(value) {
  return lines(value).map(line => {
    const [name, role = '', ...description] = line.split(/[｜|]/).map(field => field.trim());
    return { name, role, description: description.join('｜') };
  }).filter(person => person.name);
}

export function openPortal({ db, accounts, ui, defaults = {} }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS portal_results (
      result_id INTEGER PRIMARY KEY REFERENCES lab_results(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      result_date TEXT NOT NULL,
      url TEXT NOT NULL,
      summary TEXT NOT NULL
    ) STRICT;
  `);

  const readProfile = db.prepare('SELECT content FROM portal_profile WHERE id=1');
  const writeProfile = db.prepare(`
    INSERT INTO portal_profile(id,content) VALUES (1,?)
    ON CONFLICT(id) DO UPDATE SET content=excluded.content
  `);
  const editorResults = db.prepare(`
    SELECT r.id,r.title,r.kind,r.result_date AS date,p.result_id AS published,p.title AS public_title,p.url,p.summary
    FROM lab_results r LEFT JOIN portal_results p ON p.result_id=r.id
    ORDER BY r.result_date DESC,r.id DESC
  `);
  const readResult = db.prepare('SELECT id,title,kind,result_date FROM lab_results WHERE id=?');
  const resultMembers = db.prepare('SELECT student_id FROM lab_result_members WHERE result_id=?');
  const readPublicResults = db.prepare(`
    SELECT p.result_id AS id,p.title,p.kind,p.result_date AS date,p.url,p.summary
    FROM portal_results p JOIN lab_results r ON r.id=p.result_id
    ORDER BY p.result_date DESC,p.result_id DESC
  `);
  const publishResult = db.prepare(`
    INSERT INTO portal_results(result_id,title,kind,result_date,url,summary) VALUES (?,?,?,?,?,?)
    ON CONFLICT(result_id) DO UPDATE SET
      title=excluded.title,kind=excluded.kind,result_date=excluded.result_date,url=excluded.url,summary=excluded.summary
  `);
  const unpublishResult = db.prepare('DELETE FROM portal_results WHERE result_id=?');
  const { layout, escapeHtml: e, token, html, redirect, httpError } = ui;
  const branding = openSiteBranding({ db, accounts, httpError });

  function canEditResult(actor, id) {
    const user = actor && accounts.getUser(actor.id);
    if (!user || user.disabled || user.reviewStatus !== 'approved' || !['teacher', 'admin'].includes(user.role)) return false;
    return resultMembers.all(id).every(member => accounts.canManageStudent(user, member.student_id));
  }

  function editableResult(actor, id) {
    const row = readResult.get(id);
    if (!row) throw httpError(404, '没有找到这条成果。');
    if (!canEditResult(actor, id)) throw httpError(403, '当前账号没有该成果的管理权限。');
    return row;
  }

  function getProfile() {
    const stored = readProfile.get();
    const values = stored ? JSON.parse(stored.content) : defaults;
    const profile = Object.fromEntries(profileFields.map(({ key }) => [key, String(values[key] ?? '')]));
    const name = profile.name.trim();
    const legacyCenterTitle = !Object.hasOwn(values, 'centerName') && name === defaultCenter;
    profile.name = legacyCenterTitle ? defaultName : name || defaultName;
    profile.centerName = profile.centerName.trim() || defaultCenter;
    profile.referenceUrl = website(profile.referenceUrl);
    return profile;
  }

  function publicContent() {
    const profile = getProfile();
    const directions = lines(profile.research);
    const people = publicPeople(profile.people);
    const results = readPublicResults.all().map((result) => ({ ...result, url: website(result.url) }));
    return { profile, directions, people, results };
  }

  function text(value, label, limit, required = false) {
    const cleaned = String(value ?? '').trim();
    if (required && !cleaned) throw httpError(400, `请填写${label}。`);
    if (cleaned.length > limit) throw httpError(400, `${label}最多填写 ${limit} 个字符。`);
    return cleaned;
  }

  function link(value, label, limit) {
    const cleaned = text(value, label, limit);
    if (cleaned && !website(cleaned)) throw httpError(400, `${label}须以 http:// 或 https:// 开头。`);
    return cleaned ? website(cleaned) : '';
  }

  function renderEditor(state, profile = getProfile()) {
    const profileForm = profileFields.map(({ key, label, limit, required, multiline, hint, type }) => {
      const attributes = `name="${key}" maxlength="${limit}"${required ? ' required' : ''}`;
      return `<label>${label}
        ${multiline
          ? `<textarea ${attributes} rows="3">${e(profile[key])}</textarea>`
          : `<input type="${type ?? 'text'}" ${attributes} value="${e(profile[key])}">`}
        ${hint ? `<span class="field-note">${hint}</span>` : ''}
      </label>`;
    }).join('');
    const resultList = editorResults.all().filter(row => canEditResult(state.user, row.id)).map((row) => `<li class="record">
      <header class="record-head"><strong>${e(row.title)}</strong>
        <span class="badge">${row.published ? '已展示' : '未展示'}</span></header>
      <p class="field-note">${e(resultKinds[row.kind])} · ${e(row.date)}</p>
      ${row.published && row.title !== row.public_title
        ? `<p class="field-note">门户仍显示已发布的标题「${e(row.public_title)}」。</p>` : ''}
      <details><summary>${row.published ? '编辑公开内容' : '选择公开展示'}</summary>
        <form class="stack record-form" method="post" action="${editorPath}/results/${row.id}">
          ${token(state)}
          <label>公开说明（选填）<textarea name="summary" maxlength="${summaryLimit}" rows="3">${e(row.summary)}</textarea></label>
          <label>公开链接（选填）<input type="url" name="url" maxlength="${resultUrlLimit}" value="${e(row.url)}"></label>
          <button type="submit" class="button button--primary">${row.published ? '更新公开成果' : '发布到门户'}</button>
        </form>
      </details>
      ${row.published ? `<form method="post" action="${editorPath}/results/${row.id}/hide">
        ${token(state)}<button type="submit" class="button button--plain">撤下公开展示</button></form>` : ''}
    </li>`).join('');
    return layout(state, '门户管理', `
      <header class="page-heading"><h1>门户管理</h1><p>这里管理访客无需登录即可看到的内容。</p></header>
      <div class="stack">
        <section class="panel" aria-labelledby="portal-logo-title">
          <h2 id="portal-logo-title">系统 Logo</h2>
          <p class="field-note">用于登录页、工作台、展示网站及页脚。建议使用正方形透明 PNG，也支持 JPG，最大 2 MB。</p>
          <div class="portal-logo-preview"><img src="/lab-logo.png" width="88" height="88" alt="当前系统 Logo"></div>
          <form class="stack" method="post" action="${editorPath}/logo" enctype="multipart/form-data">
            ${token(state)}<label>选择新的 Logo<input name="logo" type="file" accept="image/png,image/jpeg" required></label>
            <div class="actions"><button type="submit" class="button button--primary">保存 Logo</button></div>
          </form>
          ${branding.current() ? `<form class="record-form" method="post" action="${editorPath}/logo/restore">
            ${token(state)}<p class="field-note">恢复后使用最初提供的实验室 Logo。</p>
            <button class="button button--plain" type="submit">恢复默认 Logo</button>
          </form>` : ''}
        </section>
        <section class="panel" aria-labelledby="public-news-title">
          <h2 id="public-news-title">首页动态</h2>
          <p>发布后可在展示网站中查看。发给师生的内部消息请使用站内通知。</p>
          <div class="actions">
            <a class="button button--primary" href="/teacher/news/new">发布动态</a>
            <a class="button button--plain" href="/teacher#news-heading">管理已发布动态</a>
            <a class="button button--plain" href="/portal">预览展示首页</a>
          </div>
        </section>
        <section class="panel" aria-labelledby="portal-profile-title">
          <h2 id="portal-profile-title">团队资料</h2>
          <form class="stack" method="post" action="${editorPath}">
            ${token(state)}${profileForm}
            <button type="submit" class="button button--primary">保存团队资料</button>
          </form>
        </section>
        <section class="panel" aria-labelledby="portal-results-title">
          <h2 id="portal-results-title">精选成果</h2>
          <p>发布时使用当前成果的名称、类型和日期。公开说明和链接由你单独填写。</p>
          <p class="field-note">更新内部成果后，如需同步到门户，请在这里重新发布。</p>
          ${resultList ? `<ul class="record-list">${resultList}</ul>` : '<p class="empty">暂无可选成果。</p>'}
          <a class="button button--plain" href="/teacher/results">打开成果管理</a>
        </section>
      </div>`);
  }

  const back = (response) => redirect(response, `${editorPath}?done=portal`);
  const routes = [
    ['POST', /^\/teacher\/portal\/logo$/, 'teacher', async ({ state, response, fields }) => {
      try {
        if (fields.getAll('logo').length !== 1) throw httpError(422, '请仅选择一张 Logo 图片。');
        await branding.upload(state.user, fields.get('logo'));
      } catch (error) {
        if (![413, 422].includes(error.statusCode)) throw error;
        return html(response, renderEditor({ ...state, error: error.message }), error.statusCode);
      }
      return redirect(response, `${editorPath}?done=logo`);
    }],
    ['POST', /^\/teacher\/portal\/logo\/restore$/, 'teacher', ({ state, response }) => {
      branding.restore(state.user);
      return redirect(response, `${editorPath}?done=logoRestored`);
    }],
    ['GET', /^\/teacher\/portal$/, 'teacher', ({ state, response }) => html(response, renderEditor(state))],
    ['POST', /^\/teacher\/portal$/, 'teacher', ({ form, state, response }) => {
      const values = { ...getProfile(), ...form };
      let fields;
      try {
        fields = Object.fromEntries(profileFields.map(({ key, label, limit, required, type }) => [
          key, type === 'url' ? link(values[key], label, limit) : text(values[key], label, limit, required)
        ]));
      } catch (error) {
        if (error.statusCode !== 400) throw error;
        return html(response, renderEditor({ ...state, error: error.message }, values), 400);
      }
      writeProfile.run(JSON.stringify(fields));
      return back(response);
    }],
    ['POST', /^\/teacher\/portal\/results\/(\d+)$/, 'teacher', ({ form, id, state, response }) => {
      const row = editableResult(state.user, id);
      publishResult.run(
        row.id, row.title, row.kind, row.result_date,
        link(form.url, '公开链接', resultUrlLimit), text(form.summary, '公开说明', summaryLimit)
      );
      return back(response);
    }],
    ['POST', /^\/teacher\/portal\/results\/(\d+)\/hide$/, 'teacher', ({ id, state, response }) => {
      editableResult(state.user, id);
      unpublishResult.run(id);
      return back(response);
    }]
  ];
  return { routes, publicContent, profile: getProfile, logo: branding.current };
}
