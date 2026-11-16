import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { transportSecurity } from './transport-security.mjs';
import { openAccounts } from './accounts.mjs';
import { openAdmin } from './admin.mjs';
import { openAuthAbuse } from './auth-abuse.mjs';
import { openNews } from './news.mjs';
import { openWeekly } from './weekly.mjs';
import { attachmentLimit, maxWeeklyAttachments } from './weekly-attachments.mjs';
import { openStudentSite } from './student-site.mjs';
import { openTopics } from './topics.mjs';
import { openManagement } from './management.mjs';
import { openCalendar } from './calendar.mjs';
import { openPhotos, photoLimit } from './photos.mjs';
import { openPortal } from './portal.mjs';
import { openTeacherDesk } from './teacher-desk.mjs';
import { openStudentDesk } from './student-desk.mjs';
import { aboutPage, contactPage, newsArchive, portalPage, publicArticlePage, publicationsPage, researchPage } from './portal-views.mjs';
import {
  escapeHtml, forgotPasswordPage, layout, loginPage, mailSettingsPage, messagePage, newsForm, registerPage, resetPasswordPage,
  studentPage, studentProfilePage, teacherPage, teacherRegisterPage, teacherPendingPage, token
} from './views.mjs';

const assets = new Map([
  ['app.css', 'text/css; charset=utf-8'],
  ['accounts.css', 'text/css; charset=utf-8'],
  ['admin.css', 'text/css; charset=utf-8'],
  ['theme.css', 'text/css; charset=utf-8'],
  ['theme.js', 'text/javascript; charset=utf-8'],
  ['appearance-controls.css', 'text/css; charset=utf-8'],
  ['accent.css', 'text/css; charset=utf-8'],
  ['glass.css', 'text/css; charset=utf-8'],
  ['login-entry.css', 'text/css; charset=utf-8'],
  ['topics.css', 'text/css; charset=utf-8'],
  ['weekly.css', 'text/css; charset=utf-8'],
  ['weekly-editor.js', 'text/javascript; charset=utf-8'],
  ['student-site.css', 'text/css; charset=utf-8'],
  ['student-dynamics.js', 'text/javascript; charset=utf-8'],
  ['workspace.css', 'text/css; charset=utf-8'],
  ['home-desk.css', 'text/css; charset=utf-8'],
  ['student-tour.css', 'text/css; charset=utf-8'],
  ['student-tour.js', 'text/javascript; charset=utf-8'],
  ['calendar-preview.css', 'text/css; charset=utf-8'],
  ['calendar-preview.js', 'text/javascript; charset=utf-8'],
  ['portal.css', 'text/css; charset=utf-8'],
  ['team-cover.svg', 'image/svg+xml'],
  ['team-research-network.svg', 'image/svg+xml'],
  ['team-research-data.svg', 'image/svg+xml'],
  ['team-research-services.svg', 'image/svg+xml'],
  ['portal-gallery.js', 'text/javascript; charset=utf-8'],
  ['portal-navigation.js', 'text/javascript; charset=utf-8'],
  ['vendor/preline-collapse-5.0.0.mjs', 'text/javascript; charset=utf-8'],
  ['vendor/preline-collapse.LICENSE', 'text/plain; charset=utf-8'],
  ['login.js', 'text/javascript; charset=utf-8'],
  ['lab-logo.png', 'image/png']
].map(([name, type]) => ['/' + name, { type, bytes: readFileSync(new URL('../public/' + name, import.meta.url)) }]));
const maxBody = 80 * 1024;
const notices = {
  registered: '申请已提交，请等教师审核。',
  reapplied: '申请已重新提交。',
  profile: '个人资料已保存。',
  profileReview: '注册资料已提交，请等待教师重新审核。',
  profileUnchanged: '注册资料没有变化，无需重新审核。',
  birthday: '生日已保存。',
  photo: '生活照已保存。',
  photoRemoved: '生活照已移除。',
  management: '已保存。',
  reviewed: '审核结果已保存。',
  status: '学生状态已更新。',
  published: '动态已发布，可在展示网站中查看。',
  updated: '公开动态已更新。',
  draft: '动态已保存为草稿，访客不可见。',
  portal: '门户内容已更新。',
  logo: '系统 Logo 已更新。',
  logoRestored: '已恢复默认 Logo。',
  deleted: '新闻已删除。',
  mailSaved: '邮件设置已保存。', mailDisabled: '邮件找回已停用。'
};

export function createLabServer({ db, options = {}, secureCookies = false, cookieSuffix = '', autoCalendar = false, calendarFetch, preview = false, publicHome = false, resetMailer = null, mailSettings = null, mailDefaultOrigin = '', tls = null, transport = {} }) {
  if (tls && transport.mode === 'legacy-http') throw new Error('HTTP 兼容模式不能混用 TLS。');
  const connection = transportSecurity({ ...transport, mode: transport.mode ?? (tls ? 'tls' : 'development') });
  const clientAddress = request => connection.clientAddress(request);
  const protectedCookies = secureCookies || connection.secureCookies;
  const cookiePrefix = protectedCookies ? '__Host-' : '';
  const sessionName = cookiePrefix + 'lab_session' + cookieSuffix;
  const formCookie = cookiePrefix + 'lab_form' + cookieSuffix;
  const accounts = openAccounts(db, options);
  const news = openNews(db);
  const ui = { layout, escapeHtml, token, html, redirect, httpError };
  const admin = openAdmin({ db, accounts, ui });
  const weekly = openWeekly({ db, accounts, ui });
  const topics = openTopics({ db, accounts, weekly, ui });
  weekly.setTopics(topics);
  const management = openManagement({ db, accounts, ui });
  const portalSite = openPortal({ db, accounts, ui });
  const calendar = openCalendar({ db, accounts, management, topics, weekly, ui, fetcher: calendarFetch });
  const teacherDesk = openTeacherDesk({ db, accounts, weekly, topics, ui });
  const studentDesk = openStudentDesk({ db, weekly, topics, ui });
  const photos = openPhotos(db);
  const studentSite = openStudentSite({ db, accounts, ui, photos });
  const csrfKey = randomBytes(32);
  const authAbuse = openAuthAbuse({ db, ...options.authLimits });

  function currentResetMailer() {
    const mailer = mailSettings?.mailer() ?? resetMailer;
    if (!mailer?.configured || !mailer.publicOrigin) return null;
    const origin = URL.parse(mailer.publicOrigin);
    const expected = URL.parse(mailDefaultOrigin);
    if (!origin) return null;
    if (connection.secureCookies && origin.protocol !== 'https:') return null;
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    if (loopback && expected && origin.port !== expected.port) return null;
    return mailer;
  }

  function tokenFor(cookie) {
    return createHmac('sha256', csrfKey).update(cookie).digest('base64url');
  }

  function setCookie(response, name, value, lifetime = '') {
    const secure = protectedCookies ? '; Secure' : '';
    response.appendHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}${lifetime}`);
  }

  function signIn(response, user, previousSession) {
    if (previousSession) accounts.deleteSession(previousSession);
    setCookie(response, sessionName, accounts.createSession(user.id));
    setCookie(response, formCookie, '', '; Max-Age=0');
    redirect(response, workspace(user));
  }

  const registrationPage = (state, values) => registerPage({ ...state, teachers: accounts.listTeachers() }, values);

  async function register(context) {
    const { request, response, form } = context;
    await tryForm(context, registrationPage, async () => {
      authAbuse.register(clientAddress(request), form.email);
      const user = await accounts.register(form, { maxPendingStudents: authAbuse.policy.maxPendingStudents });
      setCookie(response, sessionName, accounts.createSession(user.id));
      setCookie(response, formCookie, '', '; Max-Age=0');
      redirect(response, '/student?done=registered');
    });
  }

  async function registerTeacher(context) {
    const { request, response, form } = context;
    await tryForm(context, teacherRegisterPage, async () => {
      authAbuse.register(clientAddress(request), form.email);
      const user = await accounts.registerTeacher(form, { maxPendingTeachers: authAbuse.policy.maxPendingStudents });
      setCookie(response, sessionName, accounts.createSession(user.id));
      setCookie(response, formCookie, '', '; Max-Age=0');
      redirect(response, '/teacher/pending');
    });
  }

  async function login(context) {
    const { request, response, form, session } = context;
    await tryForm(context, loginPage, async () => {
      const target = accounts.authenticationTarget(form.identifier ?? '');
      authAbuse.login(clientAddress(request), target);
      const user = await accounts.authenticate(form.identifier ?? '', form.password ?? '');
      if (!user) throw httpError(401, '账号或密码不正确，请检查后重试。');
      authAbuse.loginSucceeded(target);
      signIn(response, user, session);
    });
  }

  function recoveryState(state) {
    return { ...state, recoveryConfigured: Boolean(currentResetMailer()) };
  }

  async function requestPasswordReset(context) {
    const { response, request, form, state } = context;
    if (!currentResetMailer()) return html(response, forgotPasswordPage(recoveryState(state)), 503);
    await tryForm(context, (page, values) => forgotPasswordPage(recoveryState(page), values), async () => {
      const mailer = currentResetMailer();
      const email = typeof form.email === 'string' ? form.email.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(email)) {
        throw httpError(400, '请填写有效的邮箱地址。');
      }
      authAbuse.recover(clientAddress(request));
      const reset = accounts.issuePasswordReset(email);
      redirect(response, '/forgot-password?sent=1');
      if (reset) {
        const resetUrl = new URL('/reset-password', mailer.publicOrigin);
        resetUrl.searchParams.set('token', reset.token);
        // Delivery runs after the same response for existing and unknown accounts.
        Promise.resolve().then(() => mailer.sendPasswordReset({
          to: reset.user.email, name: reset.user.name, siteName: state.siteName, resetUrl: resetUrl.href
        })).catch(() => {
          try { accounts.discardPasswordReset(reset.token); } catch { /* Server may have closed during delivery. */ }
          console.error('密码重置邮件发送失败，请检查发件邮箱配置。');
        });
      }
    });
  }

  function resetPage(state, values = {}) {
    return resetPasswordPage({ ...state, resetValid: Boolean(accounts.getPasswordReset(values.resetToken)) }, values);
  }

  async function resetPassword(context) {
    const { response, form } = context;
    await tryForm(context, resetPage, async () => {
      if (form.password !== form.confirmPassword) throw httpError(400, '两次输入的密码不一致。');
      await accounts.completePasswordReset(form.resetToken, form.password);
      setCookie(response, sessionName, '', '; Max-Age=0');
      setCookie(response, formCookie, '', '; Max-Age=0');
      redirect(response, '/login?done=password-reset');
    });
  }

  function mailSettingsView(state, values = {}) {
    const stored = mailSettings?.publicView() ?? {};
    const fields = Object.fromEntries(['smtpHost', 'smtpPort', 'smtpUser', 'smtpFrom', 'publicUrl']
      .filter(key => typeof values[key] === 'string').map(key => [key, values[key]]));
    return mailSettingsPage(state, { ...stored, ...fields,
      publicUrl: fields.publicUrl ?? (stored.publicUrl || mailDefaultOrigin),
      configured: Boolean(currentResetMailer()) });
  }

  async function saveMailSettings(context) {
    await tryForm(context, mailSettingsView, () => {
      if (!mailSettings) throw httpError(503, '当前运行环境不支持保存邮件设置。');
      const origin = URL.parse(context.form.publicUrl ?? '');
      const expected = URL.parse(mailDefaultOrigin);
      if (origin && connection.secureCookies && origin.protocol !== 'https:') {
        throw httpError(400, '请使用当前网站的 HTTPS 地址生成密码重置链接。');
      }
      if (origin && expected && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
        && origin.port !== expected.port) throw httpError(400, '网站地址的端口与当前网站不一致。');
      mailSettings.save(context.form);
      redirect(context.response, '/admin/mail?done=mailSaved');
    });
  }

  function getNews(id, publicOnly = false) {
    const article = news.get(id);
    if (!article || (publicOnly && article.visibility !== 'public')) throw httpError(404, '这条动态未公开或已撤下。');
    return article;
  }

  async function saveNews(context) {
    const { response, id } = context;
    await tryForm(context, newsForm, () => {
      news.save(context.form, id);
      const done = context.form.visibility === 'draft' ? 'draft' : id === null ? 'published' : 'updated';
      redirect(response, '/teacher?done=' + done + '#news-heading');
    });
  }

  function studentState(state, query) {
    if (state.user.reviewStatus !== 'approved') return state;
    const page = { ...state, featureContent: management.dashboard(state.user), dynamics: topics.dashboard(state.user) };
    if (state.user.reviewStatus === 'approved' && state.user.studentStatus !== 'graduated') {
      page.desk = studentDesk(page);
      page.calendarContent = calendar.dashboard(page, query);
      const needsDismissal = management.needsWelcome(state.user.id);
      if (needsDismissal || query.get('tour') === '1') page.tour = { needsDismissal };
    }
    return page;
  }

  function activeStudent(user) {
    if (user?.role !== 'student' || user.reviewStatus !== 'approved' || user.studentStatus === 'graduated') {
      throw httpError(403, '当前账号不能修改个人资料。');
    }
  }

  function renderStudentProfile(state, values) {
    return studentProfilePage({ ...state, path: '/student/profile', hasPhoto: photos.has(state.user.id) }, values);
  }

  const routes = [
    ['GET', /^\/$/, publicHome ? 'any' : 'guest', ({ response, state }) =>
      html(response, publicHome ? portalPage(state, news.publicList(), portalSite.publicContent()) : loginPage(state))],
    ['GET', /^\/portal$/, 'any', ({ response, state }) =>
      html(response, portalPage(state, news.publicList(), portalSite.publicContent()))],
    ['GET', /^\/about$/, 'any', ({ response, state }) =>
      html(response, aboutPage(state, portalSite.publicContent()))],
    ['GET', /^\/research$/, 'any', ({ response, state }) =>
      html(response, researchPage(state, portalSite.publicContent()))],
    ['GET', /^\/publications$/, 'any', ({ response, state, url }) =>
      html(response, publicationsPage(state, portalSite.publicContent(), url.searchParams))],
    ['GET', /^\/contact$/, 'any', ({ response, state }) =>
      html(response, contactPage(state, portalSite.publicContent()))],
    ['GET', /^\/news$/, 'any', ({ response, state, url }) =>
      html(response, newsArchive(state, news.publicList(), portalSite.publicContent(), url.searchParams))],
    ['GET', /^\/news\/(\d+)$/, 'any', ({ response, state, id }) =>
      html(response, publicArticlePage(state, getNews(id, true), portalSite.publicContent()))],
    ['GET', /^\/login$/, 'guest', ({ response, state, url }) => html(response, loginPage({ ...state,
      notice: url.searchParams.get('done') === 'password-reset' ? '密码已更新，请使用新密码登录。' : state.notice }))],
    ['POST', /^\/login$/, 'guest', login],
    ['GET', /^\/forgot-password$/, 'guest', ({ response, state, url }) => html(response,
      forgotPasswordPage({ ...recoveryState(state), recoverySent: Boolean(currentResetMailer()) && url.searchParams.get('sent') === '1' }))],
    ['POST', /^\/forgot-password$/, 'guest', requestPasswordReset],
    ['GET', /^\/reset-password$/, 'any', ({ response, state, url }) =>
      html(response, resetPage(state, { resetToken: url.searchParams.get('token') ?? '' }))],
    ['POST', /^\/reset-password$/, 'any', resetPassword],
    ['GET', /^\/teacher\/mail$/, 'admin', ({ response }) => redirect(response, '/admin/mail')],
    ['POST', /^\/teacher\/mail$/, 'admin', saveMailSettings],
    ['POST', /^\/teacher\/mail\/disable$/, 'admin', ({ response }) => redirect(response, '/admin/mail')],
    ['GET', /^\/admin\/mail$/, 'admin', ({ response, state }) => html(response, mailSettingsView(state))],
    ['POST', /^\/admin\/mail$/, 'admin', saveMailSettings],
    ['POST', /^\/admin\/mail\/disable$/, 'admin', (context) => tryForm(context, mailSettingsView, () => {
      if (!mailSettings) throw httpError(503, '当前运行环境不支持保存邮件设置。');
      mailSettings.disable();
      redirect(context.response, '/admin/mail?done=mailDisabled');
    })],
    ['GET', /^\/register$/, 'guest', ({ response, state }) => html(response, registrationPage(state))],
    ['POST', /^\/register$/, 'guest', register],
    ['GET', /^\/register\/teacher$/, 'guest', ({ response, state }) => html(response, teacherRegisterPage(state))],
    ['POST', /^\/register\/teacher$/, 'guest', registerTeacher],
    ['GET', /^\/teacher\/pending$/, 'teacher', ({ response, state }) => state.user.reviewStatus === 'approved' ? redirect(response, '/teacher') : html(response, teacherPendingPage(state))],
    ['POST', /^\/logout$/, 'any', ({ response, session }) => {
      if (session) accounts.deleteSession(session);
      setCookie(response, sessionName, '', '; Max-Age=0');
      setCookie(response, formCookie, '', '; Max-Age=0');
      redirect(response, '/');
    }],
    ['GET', /^\/student$/, 'student', ({ response, state, url }) =>
      html(response, studentPage(studentState(state, url.searchParams)))],
    ['GET', /^\/student\/profile$/, 'student', ({ response, state }) =>
      html(response, renderStudentProfile(state))],
    ['POST', /^\/student\/reapply$/, 'student', (context) => {
      if (context.state.user.reviewStatus !== 'rejected') throw httpError(403, '只有未通过的申请可以修改后重提。');
      return tryForm(context, studentPage, async () => {
        await accounts.updateStudent(context.state.user.id, context.form);
        redirect(context.response, '/student?done=reapplied');
      });
    }],
    ['POST', /^\/student\/profile$/, 'student', (context) => {
      const { user } = context.state;
      activeStudent(user);
      return tryForm(context, renderStudentProfile, async () => {
        const values = { ...context.form };
        if (!context.fields.has('activities') && values.profileFields !== '1') delete values.activities;
        const updated = accounts.updateProfile(user.id, values);
        redirect(context.response, updated.reviewStatus === 'pending'
          ? '/student?done=profileReview' : '/student/profile?done=profileUnchanged');
      });
    }],
    ['POST', /^\/student\/profile\/birthday$/, 'student', context => {
      activeStudent(context.state.user);
      return tryForm(context, renderStudentProfile, () => {
        accounts.updateBirthday(context.state.user.id, context.form);
        redirect(context.response, '/student/profile?done=birthday');
      });
    }],
    ['POST', /^\/student\/photo$/, 'student', (context) => {
      const { response, state, fields } = context;
      activeStudent(state.user);
      return tryForm(context, renderStudentProfile, async () => {
        const photo = await photos.readUpload(fields.get('photo'), httpError);
        activeStudent(accounts.getUser(state.user.id));
        photos.save(state.user.id, photo);
        redirect(response, '/student/profile?done=photo');
      });
    }],
    ['POST', /^\/student\/photo\/remove$/, 'student', ({ response, state }) => {
      activeStudent(state.user);
      photos.remove(state.user.id);
      redirect(response, '/student/profile?done=photoRemoved');
    }],
    ['GET', /^\/student\/photo\/(\d+)$/, 'any', ({ response, state, id }) => {
      const { user } = state;
      if (!user || (user.id !== id && !accounts.canManageStudent(user, id))) throw httpError(404, '未找到照片。');
      const photo = photos.get(id);
      if (!photo) throw httpError(404, '未找到照片。');
      response.writeHead(200, { 'Content-Type': photo.mime, 'Cache-Control': 'private, no-store' });
      response.end(photo.bytes);
    }],
    ['GET', /^\/teacher$/, 'teacher', ({ response, state, url }) => {
      const page = { ...state, photoOwners: photos.owners(), profileChanges: accounts.pendingProfileChanges(state.user), desk: teacherDesk(state),
        calendarContent: calendar.dashboard(state, url.searchParams) };
      html(response, teacherPage(page, accounts.teacherStudents(state.user), news.list(), url.searchParams));
    }],
    ['POST', /^\/teacher\/students\/(\d+)\/review$/, 'teacher', async ({ response, state, id, form }) => {
      await accounts.reviewStudent(state.user.id, id, form.decision, form.reason ?? '');
      redirect(response, '/teacher?done=reviewed');
    }],
    ['POST', /^\/teacher\/students\/(\d+)\/status$/, 'teacher', async ({ response, state, id, form }) => {
      await accounts.setStudentStatus(state.user.id, id, form.studentStatus, form.studentNumber);
      redirect(response, '/teacher?done=status');
    }],
    ['GET', /^\/teacher\/news\/new$/, 'teacher', ({ response, state }) => html(response, newsForm(state))],
    ['POST', /^\/teacher\/news\/new$/, 'teacher', saveNews],
    ['GET', /^\/teacher\/news\/(\d+)\/edit$/, 'teacher', ({ response, state, id }) => html(response, newsForm(state, getNews(id)))],
    ['POST', /^\/teacher\/news\/(\d+)\/edit$/, 'teacher', saveNews],
    ['POST', /^\/teacher\/news\/(\d+)\/delete$/, 'teacher', ({ response, id }) => {
      news.delete(id);
      redirect(response, '/teacher?done=deleted');
    }],
    ...admin.routes, ...weekly.routes, ...topics.routes, ...management.routes, ...calendar.routes, ...portalSite.routes, ...studentSite.routes
  ];

  async function dispatch(request, response) {
    try { connection.assert(request); }
    catch {
      response.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      response.end('请通过正确的 HTTPS 地址访问。');
      request.resume();
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/reset-password' || url.pathname === '/forgot-password') {
      response.setHeader('Referrer-Policy', 'no-referrer');
    }
    const method = request.method;
    if (['GET', 'HEAD'].includes(method) && url.pathname === '/lab-logo.png') {
      const current = portalSite.logo();
      const original = assets.get('/lab-logo.png');
      const bytes = current?.bytes ?? original.bytes;
      response.writeHead(200, { 'Content-Type': current?.mime ?? original.type,
        'Content-Length': bytes.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(method === 'HEAD' ? undefined : bytes);
      return;
    }
    const asset = assets.get(url.pathname);
    if (method === 'GET' && asset) {
      response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
      response.end(asset.bytes);
      return;
    }

    const profile = portalSite.profile();
    let state = { user: null, csrf: '', error: '', notice: '', path: url.pathname,
      siteName: profile.name, centerName: profile.centerName, preview, publicHome,
      publicHomePath: publicHome ? '/' : '/portal' };
    try {
      const matched = routes.find(([verb, pattern]) => verb === method && pattern.test(url.pathname));
      if (!matched) throw httpError(404, '没有找到这个页面。');
      const [, pattern, access, handler] = matched;
      const rawId = pattern.exec(url.pathname)[1];
      const id = rawId === undefined ? null : Number(rawId);
      if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw httpError(404, '没有找到这条记录。');

      const session = getCookie(request, sessionName);
      const guest = getCookie(request, formCookie);
      const upload = url.pathname === '/student/photo' ? 'photo' : url.pathname === '/student/weekly' ? 'weekly'
        : url.pathname === '/teacher/portal/logo' ? 'logo' : '';
      const fields = method === 'POST' ? await readForm(request, upload) : new URLSearchParams();
      const form = Object.fromEntries(fields);
      form.activities = fields.getAll('activities');
      const user = session ? accounts.findSession(session) : null;
      const csrfCookie = user ? session : guest || randomBytes(32).toString('base64url');
      if (!user && !guest) setCookie(response, formCookie, csrfCookie);

      state = { ...state, user, csrf: tokenFor(csrfCookie),
        pendingCount: user?.role === 'teacher' && user.reviewStatus === 'approved' ? accounts.teacherStudents(user).filter(student => student.reviewStatus === 'pending').length : 0 };
      const done = url.searchParams.get('done');
      const awaitingApproval = user?.role === 'student' && user.reviewStatus !== 'approved';
      if (user && Object.hasOwn(notices, done) && (!awaitingApproval || ['registered', 'reapplied', 'profileReview'].includes(done))) {
        state.notice = notices[done];
      }

      if (access === 'guest' && user) return redirect(response, workspace(user));
      if (['admin', 'teacher', 'student'].includes(access)) {
        if (!user && method === 'GET') return redirect(response, '/login');
        if (user?.role !== access) throw httpError(403, '当前账号没有此操作的权限。');
      }

      if (method === 'POST' && !equalTokens(form.csrf, state.csrf)) {
        throw httpError(403, '页面已过期，请返回并刷新后再试。');
      }
      // Registration creates a session for checking the application, not membership access.
      // Apply this to the whole student namespace so new routes cannot omit the review check.
      const applicationAccess = (method === 'GET' && url.pathname === '/student') ||
        (method === 'POST' && url.pathname === '/student/reapply' && user?.reviewStatus === 'rejected');
      if (awaitingApproval && /^\/student(?:\/|$)/.test(url.pathname) && !applicationAccess) {
        throw httpError(403, user.reviewStatus === 'rejected'
          ? '申请尚未通过审核，请返回注册进度页修改后重新提交。'
          : '申请已提交，请等待教师审核。审核通过后才能使用内部功能。');
      }
      if (user?.role === 'teacher' && user.reviewStatus !== 'approved' && /^\/teacher(?:\/|$)/.test(url.pathname) && url.pathname !== '/teacher/pending') {
        if (method === 'GET' && url.pathname === '/teacher') return redirect(response, '/teacher/pending');
        throw httpError(403, '教师申请尚未通过管理员审核，暂时无法使用内部功能。');
      }
      await handler({ request, response, state, form, session, id, url, fields });
    } catch (error) {
      if (error.statusCode === 413) {
        response.setHeader('Connection', 'close');
        request.resume();
      }
      const status = clientStatus(error);
      if (!status) console.error(error);
      html(response, messagePage(state, status ? '无法继续' : '服务暂不可用',
        status ? error.message : '请稍后再试。'), status || 500);
    }
  }

  const handleRequest = (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    dispatch(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  };
  const timeouts = { requestTimeout: 30_000, headersTimeout: 10_000 };
  const server = tls ? createHttpsServer({ ...timeouts, ...tls, minVersion: 'TLSv1.2' }, handleRequest)
    : createServer(timeouts, handleRequest);
  if (autoCalendar) server.once('listening', calendar.start);
  server.once('close', calendar.stop);
  return server;
}

async function tryForm({ response, state, form, id }, render, action) {
  try {
    await action();
  } catch (error) {
    const status = error.code === 'AUTH_CAPACITY' ? 503 : clientStatus(error);
    if (!status) throw error;
    if (Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0) response.setHeader('Retry-After', String(error.retryAfter));
    const { password, confirmPassword, smtpPassword, csrf, ...values } = form;
    if (id !== null) values.id = id;
    html(response, render({ ...state, error: error.message }, values), status);
  }
}

async function readForm(request, upload) {
  const type = request.headers['content-type'] ?? '';
  const multipart = /^multipart\/form-data;/i.test(type);
  const urlencoded = /^application\/x-www-form-urlencoded(?:;|$)/i.test(type);
  if (['photo', 'logo'].includes(upload) ? !multipart : upload === 'weekly' ? !multipart && !urlencoded : !urlencoded) {
    throw httpError(415, '无法读取表单，请返回页面重新提交。');
  }

  const limit = multipart ? (upload === 'weekly' ? attachmentLimit * maxWeeklyAttachments : photoLimit) + maxBody : maxBody;
  const tooLarge = upload === 'weekly' ? '提交内容过大。每份周报最多 5 个附件，每个附件不超过 5MB。'
    : upload === 'logo' ? '上传内容过大，Logo 图片不能超过 2 MB。' : '提交内容过长，请缩短后再试。';
  if (Number(request.headers['content-length']) > limit) throw httpError(413, tooLarge);

  let bytes = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw httpError(413, tooLarge);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (!multipart) return new URLSearchParams(body.toString('utf8'));
  try {
    const fields = await new Response(body, { headers: { 'Content-Type': type } }).formData();
    let textBytes = 0;
    for (const [name, value] of fields) {
      if (typeof value === 'string') textBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      else if ((upload === 'weekly' && name !== 'attachments') || (upload === 'photo' && name !== 'photo') || (upload === 'logo' && name !== 'logo')) {
        throw httpError(422, '上传字段无效，请返回页面重新选择文件。');
      }
    }
    if (textBytes > maxBody) throw httpError(413, '填写的文字过长，请缩短后再试。');
    return fields;
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(422, upload === 'weekly' ? '无法读取附件，请重新选择后上传。' : upload === 'logo' ? '无法读取 Logo，请重新选择后上传。' : '无法读取照片，请重新选择后上传。');
  }
}

function workspace(user) {
  return user.role === 'admin' ? '/admin' : user.role === 'teacher' ? (user.reviewStatus === 'approved' ? '/teacher' : '/teacher/pending') : '/student';
}

function getCookie(request, name) {
  const prefix = `${name}=`;
  const match = (request.headers.cookie ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  const token = match?.slice(prefix.length);
  return token && /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : '';
}

function equalTokens(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function clientStatus(error) {
  const status = error.statusCode;
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function redirect(response, path) {
  response.writeHead(303, { Location: path, 'Cache-Control': 'no-store' });
  response.end();
}

function html(response, body, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  });
  response.end(body);
}
