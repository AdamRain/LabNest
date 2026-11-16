// A small document format, never stored or accepted as HTML. Image references are
// resolved against this version's authorized attachments before persistence.
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const failure = message => Object.assign(new Error(message), { statusCode: 422 });
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function safeRichLink(value) {
  if (typeof value !== 'string' || value.length > 1500 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function normalizePlanRich(value, { attachments = [], uploads = [], resolve = false } = {}) {
  if (typeof value !== 'string' || value.length > 32000) throw failure('工作计划格式无效或内容过长，请简化后重试。');
  let document;
  try { document = JSON.parse(value); } catch { throw failure('工作计划格式无效，请刷新后重试。'); }
  if (!plainObject(document) || document.version !== 1 || !Array.isArray(document.blocks) || document.blocks.length > 50) throw failure('工作计划格式无效。');
  let characters = 0, textBlocks = 0, images = 0, runs = 0;
  const known = new Map(attachments.map(file => [Number(file.id), file]));
  const blocks = document.blocks.map(block => {
    if (!plainObject(block)) throw failure('工作计划格式无效。');
    if (block.type === 'image') {
      if (++images > 5) throw failure('工作计划最多插入 5 张图片，图片也计入附件数量。');
      const existing = Number.isSafeInteger(block.attachmentId) && block.attachmentId > 0;
      const upload = Number.isSafeInteger(block.uploadIndex) && block.uploadIndex >= 0;
      if (existing === upload) throw failure('图片引用无效，请重新插入图片。');
      if (!resolve) return existing ? { type: 'image', attachmentId: block.attachmentId } : { type: 'image', uploadIndex: block.uploadIndex };
      const file = existing ? known.get(block.attachmentId) : uploads[block.uploadIndex];
      if (!file || !imageMimes.has(file.mime)) throw failure('插图必须是本周报保留或新上传的图片附件，请重新插入图片。');
      return { type: 'image', attachmentId: Number(file.id) };
    }
    if (!['paragraph', 'bullet', 'number'].includes(block.type) || !Array.isArray(block.runs) || block.runs.length > 100) throw failure('工作计划格式无效。');
    const normalized = block.runs.map(run => {
      if (++runs > 500 || !plainObject(run) || typeof run.text !== 'string') throw failure('工作计划格式过于复杂，请简化后重试。');
      const text = run.text.replace(/\r\n?/g, '\n');
      // New lines are separate task blocks, not hidden extra tasks inside runs.
      if (/[\n\u0000]/.test(text)) throw failure('请将工作计划按每行一项填写。');
      characters += text.length;
      const result = { text };
      if (run.bold === true) result.bold = true;
      if (run.italic === true) result.italic = true;
      if (run.href !== undefined) {
        result.href = safeRichLink(run.href);
        if (!result.href) throw failure('链接仅支持完整的 HTTP 或 HTTPS 网址。');
      }
      return result;
    });
    if (normalized.some(run => run.text.trim())) textBlocks++;
    return { type: block.type, runs: normalized };
  });
  if (characters + Math.max(0, textBlocks - 1) > 2000 || textBlocks > 15) throw failure('工作计划最多填写 15 项、2000 个字符。');
  return { version: 1, blocks };
}

export function planRichText(document) {
  return document.blocks.filter(block => block.type !== 'image').map(block => block.runs.map(run => run.text).join('').trim()).filter(Boolean);
}

export function renderPlanRich(value, { imagePrefix = '/student' } = {}) {
  // Revalidate on output as well, including old/corrupted database records.
  let document;
  try { document = normalizePlanRich(JSON.stringify(value)); } catch { return ''; }
  const prefix = imagePrefix === '/teacher' ? '/teacher' : '/student';
  let list = null, result = '';
  const closeList = () => { if (list) result += `</${list}>`; list = null; };
  for (const block of document.blocks) {
    if (block.type === 'image') {
      closeList();
      if (block.attachmentId) result += `<figure><img src="${prefix}/weekly/images/${block.attachmentId}" data-attachment-id="${block.attachmentId}" alt="工作计划插图" loading="lazy"></figure>`;
      continue;
    }
    const body = block.runs.map(run => {
      let text = escape(run.text);
      if (run.bold) text = `<strong>${text}</strong>`;
      if (run.italic) text = `<em>${text}</em>`;
      if (run.href) text = `<a href="${escape(run.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      return text;
    }).join('');
    const nextList = block.type === 'bullet' ? 'ul' : block.type === 'number' ? 'ol' : null;
    if (list !== nextList) { closeList(); if (nextList) result += `<${nextList}>`; list = nextList; }
    result += nextList ? `<li>${body || '<br>'}</li>` : `<p>${body || '<br>'}</p>`;
  }
  closeList(); return result;
}
