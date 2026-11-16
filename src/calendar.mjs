import { t, h, locale } from './i18n.mjs';
import { openCalendarSubscriptions } from './calendar-subscriptions.mjs';
import { fetchConferenceFeed } from './conference-feed.mjs';

const types = { birthday: '生日', graduation: '毕业任务', paper: '小论文', conference: '会议截止' };
const studentTypes = { weekly: '周报', graduation: '毕业任务', internship: '实习', conference: '会议日程' };
const defaultSubscriptionNames = { AI: '人工智能', CG: '图形学与多媒体', HI: '人机交互', MX: '交叉领域' };
function subscriptionLabel(id, name) {
  return defaultSubscriptionNames[id] === name ? t(name) : name;
}

const day = 86_400_000;
const shanghai = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const clock = { format: value => new Intl.DateTimeFormat(locale(), {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23'
}).format(value) };

function dateOnly(value) {
  return shanghai.format(value);
}

function validMonth(value) {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value ?? '') && value >= '0001-01';
}

function monthBounds(month) {
  const from = month + '-01';
  const last = new Date(from + 'T00:00:00Z');
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return { from, through: last.toISOString().slice(0, 10) };
}

function shiftMonth(month, offset) {
  const first = new Date(month + '-01T00:00:00Z');
  first.setUTCMonth(first.getUTCMonth() + offset);
  const result = first.toISOString().slice(0, 7);
  return validMonth(result) ? result : '';
}

function calendarFilters(query, today, student = false, sourceIds = []) {
  const view = query.get('view') === 'list' ? 'list' : 'month';
  const month = validMonth(query.get('month')) ? query.get('month') : today.slice(0, 7);
  const kind = Object.hasOwn(student ? studentTypes : types, query.get('kind')) ? query.get('kind') : '';
  const category = sourceIds.includes(query.get('category')) ? query.get('category') : '';
  const date = query.get('date');
  const { from, through } = monthBounds(month);
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && date >= from && date <= through ? date : '';
  return { view, month, kind, category, date: view === 'month' ? selected : '',
    rank: student && query.get('rank') !== 'all' ? 'A' : 'all' };
}

function calendarPath(student) {
  return student ? '/student/calendar' : '/teacher/calendar';
}

function calendarHref({ view, month, kind, category, date, rank }, student = false) {
  const query = new URLSearchParams();
  if (view === 'list') query.set('view', view);
  else if (month) query.set('month', month);
  if (kind) query.set('kind', kind);
  if (category) query.set('category', category);
  if (date) query.set('date', date);
  if (student && rank === 'all') query.set('rank', rank);
  return calendarPath(student) + (query.size ? '?' + query : '');
}

function unescapeText(value) {
  return value.replace(/\\([nN,;\\])/g, (_, code) => /^[nN]$/.test(code) ? '\n' : code);
}

function timestamp(value, zone) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) return null;
  const [, year, month, date, hour, minute, second, utc] = match;
  const plainDate = h`${year}-${month}-${date}`;
  if (!hour) return { localDate: plainDate, startsAt: '', zone: '仅日期' };
  const offset = utc ? '+00:00' : /^UTC([+-]\d{2}:\d{2})$/.exec(zone)?.[1];
  if (!offset) return { localDate: plainDate, startsAt: '', zone: zone || '未注明时区' };
  const time = new Date(`${plainDate}T${hour}:${minute}:${second}${offset}`);
  return Number.isFinite(+time) ? {
    localDate: dateOnly(time), startsAt: time.toISOString(), zone: utc ? 'UTC' : zone
  } : null;
}

export function parseCalendar(input) {
  const text = input.trim().replace(/\r?\n[ \t]/g, '');
  if (!/^BEGIN:VCALENDAR\r?\n/.test(text) || !/\r?\nEND:VCALENDAR$/.test(text)) throw new Error('文件不是有效的会议日历。');
  const events = new Map();
  for (const [, body] of text.matchAll(/(?:^|\r?\n)BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT(?=\r?\n|$)/g)) {
    const start = /(?:^|\r?\n)DTSTART(?:;TZID="([^"]+)"|;TZID=([^:\r\n]+)|;VALUE=DATE(?:-TIME)?)?:([^\r\n]+)/.exec(body);
    const time = start && timestamp(start[3], start[1] || start[2] || '');
    const get = (name) => new RegExp(`(?:^|\\r?\\n)${name}:([^\\r\\n]*)`).exec(body)?.[1] ?? '';
    const uid = get('UID');
    const title = unescapeText(get('SUMMARY'));
    if (get('STATUS') === 'CANCELLED') continue;
    if (!uid || !title || !time) throw new Error('会议日历含有无法识别的事件。');
    if (uid.length > 1024 || title.length > 500 || events.size >= 5000) throw new Error('会议日历内容超过限制。');
    const link = get('URL');
    const ccfRank = /^CCF\s+([ABC])(?=,|$)/m.exec(unescapeText(get('DESCRIPTION')))?.[1] ?? '';
    events.set(uid, { uid, title, ...time, ccfRank, link: /^https?:\/\//i.test(link) ? link : '' });
  }
  if (!events.size && text.includes('BEGIN:VEVENT') && !text.includes('STATUS:CANCELLED')) {
    throw new Error('未能读取会议事件。');
  }
  return [...events.values()];
}

async function readFeed(response) {
  if (!response.ok) throw new Error(`订阅源返回 HTTP ${response.status}。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error('订阅文件超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function openCalendar({ db, accounts, management, topics, weekly, ui, fetcher = fetchConferenceFeed }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conference_deadlines (
      category TEXT NOT NULL, uid TEXT NOT NULL, title TEXT NOT NULL,
      localDate TEXT NOT NULL, startsAt TEXT NOT NULL, zone TEXT NOT NULL, link TEXT NOT NULL, ccfRank TEXT,
      PRIMARY KEY(category, uid)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS conference_sync (
      category TEXT PRIMARY KEY, checkedAt TEXT NOT NULL, successfulAt TEXT, error TEXT NOT NULL
    ) STRICT;
  `);
  const columns = db.prepare('PRAGMA table_info(conference_deadlines)');
  if (!columns.all().some(column => column.name === 'ccfRank')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!columns.all().some(column => column.name === 'ccfRank')) {
        db.exec('ALTER TABLE conference_deadlines ADD COLUMN ccfRank TEXT');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const subscriptions = openCalendarSubscriptions({ db });
  const filtersFor = (query, student = false, today = dateOnly(new Date())) =>
    calendarFilters(query, today, student, subscriptions.list().map(source => source.id));
  const clear = db.prepare('DELETE FROM conference_deadlines WHERE category = ?');
  const insert = db.prepare(`INSERT INTO conference_deadlines
    (category, uid, title, localDate, startsAt, zone, link, ccfRank) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const unrankedCache = db.prepare(`SELECT 1 FROM conference_deadlines d
    JOIN conference_subscriptions s ON s.id=d.category WHERE d.ccfRank IS NULL LIMIT 1`);
  const syncState = db.prepare(`
    INSERT INTO conference_sync VALUES (?, ?, ?, ?)
    ON CONFLICT(category) DO UPDATE SET checkedAt=excluded.checkedAt,
      successfulAt=COALESCE(excluded.successfulAt, successfulAt), error=excluded.error
  `);
  const selectState = db.prepare('SELECT * FROM conference_sync WHERE category = ?');
  const selectEvents = db.prepare(`
    SELECT d.*, s.name AS subscriptionName FROM conference_deadlines d
    JOIN conference_subscriptions s ON s.id=d.category WHERE localDate BETWEEN ? AND ?
    AND (? = '' OR category = ?) AND (? = 0 OR ccfRank = 'A') ORDER BY localDate, startsAt, title
  `);
  const lifetime = new AbortController();
  const inFlight = new Map(), queue = [];
  let active = 0;
  const unchanged = source => {
    const current = subscriptions.get(source.id);
    return current?.revision === source.revision && current.url === source.url;
  };

  async function refresh(source) {
    const category = source.id;
    if (lifetime.signal.aborted || !unchanged(source)) return;
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(12_000)]);
      const events = parseCalendar(await readFeed(await fetcher(source.url, { signal })));
      if (lifetime.signal.aborted || !unchanged(source)) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        // A subscription can be edited/deleted while its previous network request is still pending.
        if (!unchanged(source)) { db.exec('ROLLBACK'); return; }
        clear.run(category);
        for (const entry of events) insert.run(category, entry.uid, entry.title, entry.localDate,
          entry.startsAt, entry.zone, entry.link, entry.ccfRank);
        const now = new Date().toISOString();
        syncState.run(category, now, now, '');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      if (!lifetime.signal.aborted && unchanged(source)) {
        const message = error.name === 'TimeoutError' ? '连接订阅源超时。'
          : error instanceof TypeError ? '暂时无法连接订阅源。' : error.message;
        syncState.run(category, new Date().toISOString(), null, message);
      }
    }
  }

  function drain() {
    while (active < 3 && queue.length) {
      const job = queue.shift(); active++;
      refresh(job.source).then(job.resolve, job.reject).finally(() => {
        active--;
        if (inFlight.get(job.source.id) === job) inFlight.delete(job.source.id);
        drain();
      });
    }
  }

  function schedule(source) {
    const current = inFlight.get(source.id);
    if (current?.source.revision === source.revision) return current.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { source, promise, resolve, reject };
    inFlight.set(source.id, job); queue.push(job); drain();
    return promise;
  }

  function sync(sourceId = '') {
    if (lifetime.signal.aborted) return Promise.resolve([]);
    const sources = sourceId ? [subscriptions.get(sourceId)] : subscriptions.list();
    if (sources.some(source => !source)) throw httpError(404, '没有找到这条会议订阅。');
    return Promise.all(sources.map(schedule));
  }

  function start() {
    function syncIfDue() {
      const threshold = Date.now() - 6 * 60 * 60 * 1000;
      const due = subscriptions.list().filter(source => !(Date.parse(selectState.get(source.id)?.checkedAt) > threshold));
      Promise.all(due.map(schedule)).catch(() => console.error('会议日历同步失败，请稍后重试。'));
    }
    if (unrankedCache.get()) sync()?.catch(error => console.error('会议日历同步失败', error.message));
    else syncIfDue();
    const timer = setInterval(syncIfDue, 60 * 60 * 1000);
    timer.unref();
    lifetime.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  }

  function birthdayReminders(now, actor) {
    const days = new Map(Array.from({ length: 15 }, (_, i) => {
      const date = dateOnly(new Date(+now + day * i));
      return [date.slice(5), date];
    }));
    return accounts.teacherStudents(actor)
      .filter(student => student.reviewStatus === 'approved' && student.studentStatus !== 'graduated' && days.has(student.birthday?.slice(5)))
      .map(student => ({ date: days.get(student.birthday.slice(5)), title: t('{name}的生日', { name: student.name }), detail: t('学生生日') }));
  }

  function studentEvents(user, from, through) {
    const graduation = db.prepare(`
      SELECT title, due_date, status FROM graduation_tasks WHERE student_id = ? AND due_date BETWEEN ? AND ?
    `).all(user.id, from, through).map(item => ({
      title: item.title, date: item.due_date, type: 'graduation',
      detail: { open: t('待完成'), submitted: t('待确认'), confirmed: t('已确认') }[item.status], href: '/student/graduation'
    }));
    const internships = user.level === 'graduate' ? db.prepare(`
      SELECT organization, start_date, end_date, status FROM internships
      WHERE student_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?
    `).all(user.id, through, from).flatMap(item => {
      const start = item.start_date < from ? from : item.start_date;
      const detail = h`${item.start_date} 至 ${item.end_date} · ${item.status === 'approved' ? t('已审核') : t('待审核')}`;
      const event = (date, label) => ({
        title: h`${t(label)} · ${item.organization}`, date, type: 'internship', detail,
        href: '/student/internships?month=' + date.slice(0, 7), linkLabel: t('查看实习')
      });
      return [event(start, start === item.start_date ? t('实习开始') : t('实习进行中')),
        ...(item.end_date > start && item.end_date <= through ? [event(item.end_date, t('实习结束'))] : [])];
    }) : [];
    const summary = weekly?.overview(user.id, weekly.currentWeek());
    const date = summary && Number.isFinite(summary.dueAt) ? dateOnly(new Date(summary.dueAt)) : '';
    const report = summary?.required && date >= from && date <= through ? [{
      title: t('本周周报截止'), date, type: 'weekly',
      detail: h`${clock.format(new Date(summary.dueAt))} · ${{
        submitted: t('已按时提交'), late: t('已逾期提交'), 'not-submitted': summary.overdue ? t('已逾期未提交') : t('待提交')
      }[summary.submission]}`,
      href: '/student/weekly?week=' + summary.week, linkLabel: t('查看周报')
    }] : [];
    return [...graduation, ...internships, ...report];
  }

  function conferenceEvents(from, through, category, rank) {
    return selectEvents.all(from, through, category, category, Number(rank === 'A')).map(item => ({
      ...item, type: 'conference', date: item.localDate,
      detail: item.startsAt ? t('{time}（北京时间，源时区 {zone}）', { time: clock.format(new Date(item.startsAt)), zone: t(item.zone) }) : item.zone
    }));
  }

  const { escapeHtml: e, layout, html, token, redirect, httpError } = ui;
  const studentAccess = user => user?.role === 'student' && user.reviewStatus === 'approved' && user.studentStatus !== 'graduated';

  function monthGrid(filters, byDay, today, selected, student) {
    const { month } = filters;
    const { from, through } = monthBounds(month);
    const start = (new Date(from + 'T00:00:00Z').getUTCDay() + 6) % 7;
    const count = Number(through.slice(8));
    const rows = Math.ceil((start + count) / 7);
    const cell = index => {
      const number = index - start + 1;
      if (number < 1 || number > count) return h`<td class="calendar-blank"></td>`;
      const date = month + '-' + String(number).padStart(2, '0');
      const items = byDay.get(date) ?? [];
      const preview = 'calendar-preview-' + (student ? 'student-' : 'teacher-') + date;
      return h`<td><a class="calendar-day${date === selected ? ' calendar-day--selected' : ''}"
        href="${e(calendarHref({ ...filters, date }, student))}#calendar-day-details"
        data-calendar-preview="${preview}"
        aria-label="${e(date)}，${items.length} 项提醒${date === selected ? t('，已选中') : ''}"
        ${date === today ? 'aria-current="date"' : ''}>
        <span class="calendar-day-number">${number}</span>
        ${items.slice(0, 2).map(item => h`<span class="calendar-item" data-kind="${item.type}">${e(item.title)}</span>`).join('')}
        ${items.length > 2 ? h`<span class="calendar-more">另有 ${items.length - 2} 项</span>` : ''}
        ${items.length ? h`<span class="calendar-mobile-count" data-kind="${items[0].type}">${items.length} 项</span>` : ''}
      </a></td>`;
    };
    const previews = Array.from({ length: count }, (_, index) => {
      const date = month + '-' + String(index + 1).padStart(2, '0');
      const items = byDay.get(date) ?? [];
      const id = 'calendar-preview-' + (student ? 'student-' : 'teacher-') + date;
      return h`<template id="${id}"><h3 class="calendar-preview-heading">${e(date)} 的事项</h3>
        <div class="calendar-preview-events">${eventList(items, t('当天暂无符合当前筛选条件的事项。'), false)}</div></template>`;
    }).join('');
    return h`<table class="calendar-grid" aria-label="${e(month)}月历">
      <thead><tr>${['周一','周二','周三','周四','周五','周六','周日'].map(label => h`<th scope="col">${t(label)}</th>`).join('')}</tr></thead>
      <tbody>${Array.from({ length: rows }, (_, row) =>
        h`<tr>${Array.from({ length: 7 }, (_, col) => cell(row * 7 + col)).join('')}</tr>`).join('')}</tbody>
    </table>${previews}`;
  }

  function eventList(items, empty, withDate = true) {
    if (!items.length) return h`<p class="empty">${empty}</p>`;
    return h`<ul class="record-list">${items.map(item => h`<li class="record">
      <div class="record-head"><strong>${e(item.title)}</strong><span class="badge" data-kind="${item.type}">${e(
        (item.subscriptionName ? subscriptionLabel(item.category, item.subscriptionName) : t(studentTypes[item.type] ?? types[item.type])) + (item.ccfRank ? ' · CCF ' + item.ccfRank : '')
      )}</span></div>
      <p>${withDate ? e(item.date) + ' · ' : ''}${e(item.detail)}</p>
      ${item.link ? h`<a href="${e(item.link)}" rel="noreferrer">会议官网</a>`
        : item.href ? h`<a href="${e(item.href)}">${e(t(item.linkLabel ?? '查看任务'))}</a>`
          : ''}</li>`).join('')}</ul>`;
  }

  function calendarBody(state, query, embedded = false) {
    const now = new Date();
    const today = dateOnly(now);
    const student = state.user?.role === 'student';
    const labels = student ? studentTypes : types;
    const filters = filtersFor(query, student, today);
    if (embedded) filters.view = 'month';
    const { view, month, kind, category, rank } = filters;
    const isMonth = view === 'month';
    const { from, through } = isMonth ? monthBounds(month) : { from: today, through: dateOnly(new Date(+now + 90 * day)) };
    const internal = (student ? studentEvents(state.user, from, through) : [
      ['birthday', birthdayReminders(now, state.user)],
      ['graduation', management.reminders?.(now, state.user) ?? []],
      ['paper', topics.reminders?.(now, state.user) ?? []]
    ].flatMap(([type, entries]) => entries.map(entry => ({ ...entry, type, title: type === 'paper' ? t(entry.title) : entry.title }))))
      .filter(item => (!kind || kind === item.type) && (!isMonth || (item.date >= from && item.date <= through)));
    const conferences = !kind || kind === 'conference' ? conferenceEvents(from, through, category, rank) : [];
    const items = [...internal, ...conferences].sort((a, b) => a.date.localeCompare(b.date));
    const byDay = new Map();
    for (const item of items) {
      if (!byDay.has(item.date)) byDay.set(item.date, []);
      byDay.get(item.date).push(item);
    }
    const selected = filters.date || (today.startsWith(month) ? today : items[0]?.date || from);
    const prev = shiftMonth(month, -1);
    const next = shiftMonth(month, 1);
    const href = changes => e(calendarHref({ ...filters, date: '', ...changes }, student));
    const rankInfo = student
      ? h`<p class="field-note">${rank === 'A' ? t('当前显示 CCF A 类会议') : t('当前显示全部等级会议')}，使用教师维护的会议订阅。未标注等级的日程可切换到「全部等级」查看，截止时间以会议官网为准。</p>`
      : '';
    const body = h`<section class="panel calendar-panel" aria-label="${student ? t('个人日历') : t('团队日历')}">
        <div class="calendar-toolbar">
          <div>
            <h2>${embedded ? (student ? t('个人日历 · ') : t('团队日历 · ')) : ''}${isMonth ? new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'long', timeZone: 'Asia/Shanghai' }).format(new Date(month + '-01T00:00:00+08:00')) : t('近期提醒')}</h2>
            ${isMonth ? h`<nav class="calendar-controls" aria-label="切换月份">
              ${prev ? h`<a class="button button--plain" href="${href({ month: prev })}">上个月</a>` : ''}
              <a class="button button--plain" href="${href({ month: today.slice(0, 7) })}">本月</a>
              ${next ? h`<a class="button button--plain" href="${href({ month: next })}">下个月</a>` : ''}
            </nav>` : h`<p class="field-note">会议显示未来 90 天。${student ? '' : t('毕业任务可包含尚未完成的逾期事项。')}</p>`}
          </div>
          ${embedded ? h`<div class="calendar-controls">
            <a class="button button--plain" href="${href({ view: 'month' })}">打开完整日历</a>
            ${student ? h`<a class="button button--plain" href="${href({ view: 'list', kind: 'conference' })}">近期会议日程</a>` : ''}
            ${student ? '' : h`<a class="button button--plain" href="/teacher/calendar#conference-subscriptions">管理会议订阅</a>`}
          </div>` : h`<nav class="calendar-controls calendar-switch" aria-label="日历视图">
            <a class="button button--plain" href="${href({ view: 'month' })}"${isMonth ? ' aria-current="page"' : ''}>月历</a>
            <a class="button button--plain" href="${href({ view: 'list' })}"${!isMonth ? ' aria-current="page"' : ''}>近期列表</a>
          </nav>`}
        </div>
        ${rankInfo}
        ${!embedded ? h`<form class="calendar-filters" method="get" action="${calendarPath(student)}">
          <input type="hidden" name="view" value="${view}">
          ${isMonth ? h`<label>跳转到月份<input type="month" name="month" value="${e(month)}"></label>` : ''}
          <label>事项<select name="kind"><option value="">全部事项</option>
            ${Object.entries(labels).map(([key, name]) => h`<option value="${key}"${key === kind ? ' selected' : ''}>${t(name)}</option>`).join('')}
          </select></label>
          <label>会议订阅<select name="category"><option value="">全部订阅</option>
            ${subscriptions.list().map(source => h`<option value="${e(source.id)}"${source.id === category ? ' selected' : ''}>${e(subscriptionLabel(source.id, source.name))}</option>`).join('')}
          </select></label>
          ${student ? h`<label>会议等级<select name="rank"><option value="A">仅 CCF A 类</option>
            <option value="all"${rank === 'all' ? ' selected' : ''}>全部等级</option></select></label>` : ''}
          <button class="button button--plain">筛选</button>
        </form>` : ''}
        ${isMonth ? h`<p class="field-note calendar-preview-hint">
          <span class="calendar-preview-hover-hint">将鼠标移到日期上可看当天事项，点击日期查看详情。</span>
          <span class="calendar-preview-touch-hint">点击日期，查看当天事项和会议截止。</span>
        </p>
        <ul class="calendar-legend" aria-label="事项类型">
          ${Object.entries(labels).map(([key, label]) => h`<li><span data-kind="${key}">${t(label)}</span></li>`).join('')}
        </ul>
        ${monthGrid(filters, byDay, today, selected, student)}
        <section id="calendar-day-details" class="calendar-day-details" aria-labelledby="calendar-day-title">
          <h3 id="calendar-day-title">${e(selected)} 的提醒</h3>
          ${eventList(byDay.get(selected) ?? [], t('当天没有符合条件的提醒。'))}
        </section>` : eventList(items, t('这段时间没有符合条件的事项。'))}
      </section>`;
    if (student || embedded) return body;
    return body + subscriptionPanel(state, query, filters);
  }

  function subscriptionPanel(state, query, filters) {
    const sources = subscriptions.list();
    const values = state.subscriptionForm?.values ?? {};
    const editing = state.subscriptionForm?.id ?? query.get('edit');
    const filterFields = Object.entries(filters).map(([key, value]) =>
      h`<input type="hidden" name="${key}" value="${e(value)}">`).join('');
    const back = calendarHref(filters);
    const editHref = id => back + (back.includes('?') ? '&' : '?') + 'edit=' + encodeURIComponent(id) + '#subscription-' + id;
    const fields = (source, prefix) => h`<div class="subscription-fields">
      <label for="${prefix}-name">订阅名称<input id="${prefix}-name" name="name" required maxlength="60"
        placeholder="例如：人工智能 A 类会议" value="${e(source.name ?? '')}"></label>
      <label for="${prefix}-url">订阅链接<input id="${prefix}-url" name="url" type="url" required maxlength="2048"
        placeholder="https://…/calendar.ics" spellcheck="false" value="${e(source.url ?? '')}"></label>
      </div>`;
    const rows = sources.map(source => {
      const syncRow = selectState.get(source.id);
      const successful = syncRow?.successfulAt ? clock.format(new Date(syncRow.successfulAt)) : '';
      const status = syncRow?.error ? t('同步失败') : successful ? t('已同步') : t('待同步');
      const isEditing = editing === source.id;
      return h`<li class="subscription-row" id="subscription-${e(source.id)}">
        <div class="subscription-row-heading"><h3>${e(subscriptionLabel(source.id, source.name))}</h3>
          <span class="subscription-status"${syncRow?.error ? ' data-error="true"' : ''}>${status}</span></div>
        <p class="subscription-address">${e(source.url)}</p>
        <p class="field-note subscription-time">${e(successful ? t('上次成功同步：') + successful : t('尚未同步，请点击「同步」获取会议日程。'))}
          ${syncRow?.error ? h`<span class="subscription-error">${e(t(syncRow.error))}${successful ? t(' 已保留上次同步的日程。') : ''}</span>` : ''}</p>
        <div class="subscription-actions">
          <form action="/teacher/calendar/sync" method="post">${token(state)}${filterFields}
            <input type="hidden" name="source" value="${e(source.id)}">
            <button class="button button--plain" aria-label="同步 ${e(subscriptionLabel(source.id, source.name))}">同步</button></form>
          <a class="button button--plain" href="${e(editHref(source.id))}" aria-label="编辑 ${e(subscriptionLabel(source.id, source.name))}">编辑</a>
          <details class="subscription-delete"><summary class="button button--danger" aria-label="删除 ${e(subscriptionLabel(source.id, source.name))}">删除</summary>
            <form action="/teacher/calendar/subscriptions/${e(source.id)}/delete" method="post">${token(state)}${filterFields}
              <input type="hidden" name="revision" value="${source.revision}">
              <p>删除「${e(subscriptionLabel(source.id, source.name))}」及它已同步的会议日程？</p>
              <button class="button button--danger">确认删除</button>
            </form></details>
        </div>
        ${isEditing ? h`<form class="subscription-edit stack" action="/teacher/calendar/subscriptions/${e(source.id)}" method="post">
          ${token(state)}${filterFields}<input type="hidden" name="revision" value="${e(values.revision ?? source.revision)}">
          ${fields(state.subscriptionForm?.id === source.id ? { ...source, ...values } : source, 'edit-' + source.id)}
          <p class="field-note">修改链接会清除这条订阅原有的会议日程，保存后请重新同步。</p>
          <div class="subscription-actions"><button class="button button--primary">保存修改</button>
            <a class="button button--plain" href="${e(back)}#subscription-${e(source.id)}">取消</a></div></form>` : ''}
      </li>`;
    }).join('');
    return h`<section class="panel conference-subscriptions" id="conference-subscriptions" aria-labelledby="conference-subscriptions-heading">
      <div class="subscriptions-heading"><div><h2 id="conference-subscriptions-heading">会议订阅</h2>
        <p class="field-note">教师维护的订阅供师生日历共同使用。每小时检查更新，距上次检查满 6 小时后同步。</p></div>
        ${sources.length ? h`<form action="/teacher/calendar/sync" method="post">${token(state)}${filterFields}
          <button class="button button--plain">全部同步</button></form>` : ''}</div>
      <p class="subscription-help">可前往 <a href="https://ccfddl.com/" target="_blank" rel="noopener noreferrer">CCFDDL 获取订阅链接</a>，复制需要的 ICS 日历订阅地址，粘贴到下方。支持 HTTPS 和 webcal 链接。</p>
      <details class="subscription-add"${state.subscriptionForm?.id === null ? ' open' : ''}>
        <summary class="button button--primary">新增订阅</summary>
        <form class="stack" action="/teacher/calendar/subscriptions" method="post">${token(state)}${filterFields}
          ${fields(state.subscriptionForm?.id === null ? values : {}, 'new-subscription')}
          <p class="field-note">请填写可在线更新的日历链接。保存后点击「同步」，即可在日历中查看会议日程。最多添加 20 条。</p>
          <button class="button button--primary">添加订阅</button></form>
      </details>
      ${sources.length ? h`<ul class="subscription-list">${rows}</ul>` : h`<p class="empty">暂无会议订阅。点击「新增订阅」添加一个日历。</p>`}
    </section>`;
  }

  function teacherPage(state, query) {
    const messages = { subscriptionAdded: t('会议订阅已添加，请同步获取日程。'), subscriptionSaved: t('会议订阅已保存。'),
      subscriptionDeleted: t('会议订阅及对应日程已删除。'), synced: t('同步检查已完成，结果见各条订阅。') };
    const notice = messages[query.get('done')];
    return layout(notice ? { ...state, notice } : state, t('提醒与日历'),
      h`<header class="page-heading"><h1>提醒与日历</h1><p>日历按北京时间显示。生日提醒提前 14 天出现。</p></header>
        ${calendarBody(state, query)}`);
  }

  async function changeSubscription(context, operation) {
    const sourceId = context.url.pathname.split('/')[4] ?? null;
    try {
      if (operation === 'delete') subscriptions.remove(sourceId, context.form.revision);
      else subscriptions.save(context.form, sourceId);
      const query = new URLSearchParams(filtersFor(context.fields));
      query.set('done', operation === 'delete' ? 'subscriptionDeleted' : sourceId ? 'subscriptionSaved' : 'subscriptionAdded');
      redirect(context.response, '/teacher/calendar?' + query + '#conference-subscriptions');
    } catch (error) {
      if (![400, 404, 409].includes(error.statusCode)) throw error;
      html(context.response, teacherPage({ ...context.state, error: error.message,
        subscriptionForm: { id: operation === 'delete' ? undefined : sourceId, values: context.form } }, context.fields), error.statusCode);
    }
  }

  return {
    routes: [
      ['GET', /^\/teacher\/calendar$/, 'teacher', ({ state, response, url }) => html(response, teacherPage(state, url.searchParams))],
      ['GET', /^\/student\/calendar$/, 'student', ({ state, response, url }) => {
        if (!studentAccess(state.user)) throw httpError(403, t('当前账号不能访问个人日历。'));
        return html(response, layout(state, t('个人日历'), h`
          <header class="page-heading"><h1>个人日历</h1><p>查看自己的任务和会议截止，时间按北京时间显示。</p></header>
          ${calendarBody(state, url.searchParams)}`));
      }],
      ['POST', /^\/teacher\/calendar\/subscriptions$/, 'teacher', context => changeSubscription(context, 'save')],
      ['POST', /^\/teacher\/calendar\/subscriptions\/(?:[A-Za-z0-9-]{1,64})$/, 'teacher', context => changeSubscription(context, 'save')],
      ['POST', /^\/teacher\/calendar\/subscriptions\/(?:[A-Za-z0-9-]{1,64})\/delete$/, 'teacher', context => changeSubscription(context, 'delete')],
      ['POST', /^\/teacher\/calendar\/sync$/, 'teacher', async ({ response, fields }) => {
        await sync(fields.get('source') || '');
        const back = calendarHref(filtersFor(fields));
        redirect(response, back + (back.includes('?') ? '&' : '?') + 'done=synced#conference-subscriptions');
      }]
    ],
    dashboard: (state, query = new URLSearchParams()) => state.user?.role === 'teacher' || studentAccess(state.user)
      ? calendarBody(state, query, true) : '',
    sync, start, stop: () => lifetime.abort()
  };
}
