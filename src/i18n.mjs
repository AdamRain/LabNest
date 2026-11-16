import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync } from 'node:fs';

// Locale belongs to a request, never to the process or to a user's stored content.
const context = new AsyncLocalStorage();
export const supportedLocales = ['zh-CN', 'en'];
export const languageCookie = 'lab_language';
const catalogs = readdirSync(new URL('./locales/', import.meta.url))
  .filter(name => /^en-[\w-]+\.json$/.test(name)).sort()
  .map(name => JSON.parse(readFileSync(new URL('./locales/' + name, import.meta.url), 'utf8')));
const english = Object.assign(Object.create(null), ...catalogs);
const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const normalized = new Map(Object.entries(english).map(([key, value]) => [normalize(key), value]));
const regexEscape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(english).filter(([key]) => /\{\w+\}/.test(key)).map(([key, value]) => {
  const names = [];
  let index = 0, source = '';
  for (const match of key.matchAll(/\{(\w+)\}/g)) {
    source += regexEscape(key.slice(index, match.index)) + '([\\s\\S]+?)';
    names.push(match[1]); index = match.index + match[0].length;
  }
  source += regexEscape(key.slice(index));
  return { pattern: new RegExp('^' + source + '$'), names, value };
});
const fill = (text, params) => text.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);

export function locale() { return context.getStore()?.locale ?? 'zh-CN'; }
export function withLocale(language, callback, request = {}) {
  return context.run({ ...request, locale: supportedLocales.includes(language) ? language : 'zh-CN' }, callback);
}
export function requestLocale(request) {
  const value = /(?:^|;\s*)lab_language=([^;]*)/.exec(request.headers.cookie ?? '')?.[1];
  return value === 'en' ? 'en' : 'zh-CN';
}
export function t(message, params = {}) {
  const original = String(message ?? '');
  if (locale() !== 'en') return fill(original, params);
  let translated = english[original] ?? normalized.get(normalize(original));
  if (translated === undefined) {
    for (const candidate of patterns) {
      const match = candidate.pattern.exec(original);
      if (!match) continue;
      translated = fill(candidate.value, Object.fromEntries(candidate.names.map((name, i) => [name, english[match[i + 1]] ?? match[i + 1]])));
      break;
    }
  }
  return fill(translated ?? original, params);
}
function escape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function decode(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, code) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[code]);
}
function translateText(text) {
  const core = text.trim();
  if (!core) return text;
  const source = decode(core), result = t(source);
  if (source === result) return text;
  return text.slice(0, text.indexOf(core)) + escape(result) + text.slice(text.indexOf(core) + core.length);
}
const marker = /\u0000(\d+)\u0000/g;
function translateParts(text) { return text.split(/(\u0000\d+\u0000)/g).map(part => /^\u0000/.test(part) ? part : translateText(part)).join(''); }
function translateSkeleton(text) {
  // Translate literal display text only. Values, names, URLs and user-supplied
  // interpolations remain byte-for-byte unchanged, including Chinese enum values.
  return text.replace(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g, part => {
    if (part.startsWith('<!--')) return part;
    if (!part.startsWith('<')) return translateParts(part);
    return part.replace(/(\s)(aria-label|aria-description|title|placeholder|alt|label)=("([^"]*)"|'([^']*)')/g,
      (whole, space, name, quoted, double, single) => space + name + '=' + quoted[0] + translateParts(double ?? single) + quoted[0]);
  });
}
const templates = new WeakMap();
export function h(strings, ...values) {
  if (locale() !== 'en') return strings.reduce((result, part, index) => result + (index ? String(values[index - 1]) : '') + part, '');
  let translated = templates.get(strings);
  if (!translated) {
    translated = translateSkeleton(strings.map((part, index) => (index ? '\u0000' + (index - 1) + '\u0000' : '') + part).join(''));
    templates.set(strings, translated);
  }
  return translated.replace(marker, (_, index) => String(values[Number(index)]));
}

export function safeReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const target = new URL(value, 'https://lab.invalid');
    if (target.origin !== 'https://lab.invalid' || target.pathname === '/language') return '/';
    return target.pathname + target.search + target.hash;
  } catch { return '/'; }
}
export function languageControl() {
  const target = locale() === 'en' ? 'zh-CN' : 'en';
  const path = safeReturnPath(context.getStore()?.returnTo ?? '/');
  const href = '/language?' + new URLSearchParams({ lang: target, returnTo: path });
  return `<a class="language-control" data-language-switch href="${escape(href)}" lang="${target}" hreflang="${target}" aria-label="${locale() === 'en' ? 'Switch to Chinese' : '切换为英文'}" title="${locale() === 'en' ? 'Switch to Chinese' : '切换为英文'}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h12M9 3v2m-4 0c1 6 4 9 9 12M13 5c-1 6-4 9-9 12m11 3 4-11 4 11m-6.5-4h5"/></svg><span>${target === 'en' ? 'English' : '中文'}</span></a>`;
}
export function clientMessages() {
  const path = new URL('./locales/en-client.json', import.meta.url);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}
