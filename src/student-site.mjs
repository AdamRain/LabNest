import { resumePdf, resumeDocx, publicLinks } from './resume-export.mjs';
import { siteFields, renderStudentHomepage, renderStudentSiteManager } from './student-site-views.mjs';

const emptyDraft = () => Object.fromEntries(siteFields.map(field => [field.key, '']));

export function openStudentSite({ db, accounts, ui, photos }) {
  db.exec(`CREATE TABLE IF NOT EXISTS student_sites (
    student_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    draft TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    published TEXT,
    published_revision INTEGER,
    published_at TEXT
  ) STRICT;`);
  const read = db.prepare('SELECT * FROM student_sites WHERE student_id=?');
  const save = db.prepare(`INSERT INTO student_sites(student_id,draft,revision,updated_at) VALUES(?,?,1,?)
    ON CONFLICT(student_id) DO UPDATE SET draft=excluded.draft,revision=student_sites.revision+1,updated_at=excluded.updated_at`);
  const publish = db.prepare('UPDATE student_sites SET published=?,published_revision=revision,published_at=? WHERE student_id=?');
  const unpublish = db.prepare('UPDATE student_sites SET published=NULL,published_revision=NULL,published_at=NULL WHERE student_id=?');
  const { html, redirect, httpError } = ui;

  function owner(state) {
    const user = state.user ? accounts.getUser(state.user.id) : null;
    if (user?.role !== 'student') throw httpError(403, '请使用学生账号打开个人主页。');
    if (user.disabled || user.reviewStatus !== 'approved') throw httpError(403, '账号启用且审核通过后，可以编辑和发布个人主页。');
    return user;
  }

  function storedFor(user) {
    const row = read.get(user.id);
    return { draft: row ? { ...emptyDraft(), ...JSON.parse(row.draft) } : emptyDraft(),
      revision: row?.revision ?? 0, publishedRevision: row?.published_revision ?? null,
      updatedAt: row?.updated_at ?? null, publishedAt: row?.published_at ?? null,
      published: row?.published ? JSON.parse(row.published) : null };
  }

  function checkedRevision(form, stored) {
    if (!/^\d+$/.test(String(form.revision ?? '')) || Number(form.revision) !== stored.revision) {
      throw httpError(409, '个人主页已在其他页面更新，请刷新后再修改。');
    }
  }

  function checkedDraft(form) {
    const draft = emptyDraft();
    for (const { key, label, limit } of siteFields) {
      const value = typeof form[key] === 'string' ? form[key].trim().replace(/\r\n/g, '\n') : '';
      if (value.length > limit) throw httpError(400, `${label}最多填写 ${limit} 个字符。`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw httpError(400, `${label}包含无法使用的字符。`);
      draft[key] = value;
    }
    if (draft.publicEmail && !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(draft.publicEmail)) {
      throw httpError(400, '请填写有效的公开联系邮箱，或留空。');
    }
    if (form.publishEmail !== '1') draft.publicEmail = '';
    const linkLines = draft.links.split('\n').map(line => line.trim()).filter(Boolean);
    if (linkLines.length > 10) throw httpError(400, '相关链接最多填写 10 条。');
    if (linkLines.length !== publicLinks(draft.links).length) {
      throw httpError(400, '每行填写「名称｜https://网址」或一个 http/https 网址。');
    }
    return draft;
  }

  // Public content is allow-listed. The owner's photo is loaded separately for private CV downloads.
  function projection(user, draft) {
    return { name: user.name, major: user.major || '',
      ...Object.fromEntries(siteFields.map(({ key }) => [key, String(draft[key] ?? '')])) };
  }

  function manager(response, state, status = 200, values = null) {
    const user = owner(state);
    const stored = storedFor(user);
    return html(response, renderStudentSiteManager({ ...state, user }, {
      ...stored, draft: values ?? stored.draft,
      profile: projection(user, values ?? stored.draft)
    }, ui), status);
  }

  async function download({ response, state }, format) {
    const user = owner(state);
    const profile = projection(user, storedFor(user).draft);
    const options = { photo: photos?.get(user.id) };
    const bytes = await (format === 'pdf' ? resumePdf(profile, options) : resumeDocx(profile, options));
    const filename = encodeURIComponent(`${user.name}的个人简历.${format}`);
    response.writeHead(200, {
      'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="resume-${user.id}.${format}"; filename*=UTF-8''${filename}`,
      'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    response.end(bytes);
  }

  const routes = [
    ['GET', /^\/student\/homepage$/, 'student', ({ response, state, url }) => {
      const notice = url?.searchParams.has('published') ? '个人主页已发布。'
        : url?.searchParams.has('unpublished') ? '个人主页已撤下。'
          : url?.searchParams.has('saved') ? '草稿已保存。' : state.notice;
      return manager(response, { ...state, notice });
    }],
    ['POST', /^\/student\/homepage$/, 'student', ({ response, state, form }) => {
      const user = owner(state);
      const stored = storedFor(user);
      checkedRevision(form, stored);
      let draft;
      try { draft = checkedDraft(form); }
      catch (error) {
        if (error.statusCode !== 400) throw error;
        const values = Object.fromEntries(siteFields.map(({ key }) => [key, typeof form[key] === 'string' ? form[key] : '']));
        return manager(response, { ...state, error: error.message }, 400, values);
      }
      save.run(user.id, JSON.stringify(draft), new Date().toISOString());
      return redirect(response, '/student/homepage?saved=1#profile-editor');
    }],
    ['POST', /^\/student\/homepage\/publish$/, 'student', ({ response, state, form }) => {
      const user = owner(state);
      const stored = storedFor(user);
      checkedRevision(form, stored);
      if (form.confirmPublic !== '1') throw httpError(400, '请勾选确认公开后再发布个人主页。');
      if (!stored.draft.bio.trim()) throw httpError(400, '先保存一段个人介绍，再发布主页。');
      publish.run(JSON.stringify(projection(user, stored.draft)), new Date().toISOString(), user.id);
      return redirect(response, '/student/homepage?published=1');
    }],
    ['POST', /^\/student\/homepage\/unpublish$/, 'student', ({ response, state }) => {
      const user = owner(state);
      unpublish.run(user.id);
      return redirect(response, '/student/homepage?unpublished=1');
    }],
    ['GET', /^\/people\/(\d+)$/, 'any', ({ response, state, id }) => {
      const user = accounts.getUser(id);
      const row = user?.role === 'student' && !user.disabled && user.reviewStatus === 'approved' ? read.get(id) : null;
      if (!row?.published) throw httpError(404, '这个个人主页尚未公开，或已被撤下。');
      return html(response, renderStudentHomepage(state, JSON.parse(row.published), {
        id, owner: state.user?.id === id, publishedAt: row.published_at
      }, ui));
    }],
    ['GET', /^\/student\/resume\.pdf$/, 'student', context => download(context, 'pdf')],
    ['GET', /^\/student\/resume\.docx$/, 'student', context => download(context, 'docx')]
  ];
  return { routes };
}
