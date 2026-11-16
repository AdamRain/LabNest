// The editor progressively enhances the ordinary textarea. The server accepts a
// constrained document and validates attachment references independently.
(() => {
  const form = document.querySelector('form.weekly-editor');
  if (!form || !window.DataTransfer || !window.File) return;
  const textarea = form.elements.plan, shell = form.querySelector('[data-rich-shell]');
  const editor = shell?.querySelector('[data-rich-input]'), fileInput = form.elements.attachments;
  if (!textarea || !editor || !fileInput) return;
  const feedback = form.querySelector('[data-rich-feedback]');
  let selectedRange = null, fileSequence = 0;
  const staged = [], urls = new Set();
  const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const notify = message => { feedback.textContent = message; };
  const checkCount = () => {
    if (form.querySelectorAll('input[name="retainedAttachment"]:checked').length + staged.length > 5) throw new Error('每份周报最多保留 5 个附件，请先移除文件或取消保留。');
  };
  const link = value => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  };
  const remember = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) selectedRange = selection.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    editor.focus();
    const selection = window.getSelection();
    if (selectedRange && editor.contains(selectedRange.startContainer)) { selection.removeAllRanges(); selection.addRange(selectedRange); }
  };
  const insert = node => {
    restore();
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && editor.contains(range.commonAncestorContainer)) {
      range.deleteContents(); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range);
    } else editor.append(node);
    remember();
  };
  function documentValue() {
    const blocks = []; let current = { type: 'paragraph', runs: [] };
    const flush = () => { if (current.runs.length) blocks.push(current); current = { type: current.type, runs: [] }; };
    function walk(node, marks = {}, list = null) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent.replace(/\r\n?/g, '\n').split('\n').forEach((text, index) => {
          if (index) flush();
          if (text) current.runs.push({ text, ...marks });
        });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG'].includes(node.tagName)) return;
      const tag = node.tagName;
      if (tag === 'IMG') {
        flush();
        if (node.dataset.attachmentId && /^[1-9]\d*$/.test(node.dataset.attachmentId)) blocks.push({ type: 'image', attachmentId: Number(node.dataset.attachmentId) });
        else {
          const index = staged.findIndex(file => file.key === node.dataset.uploadKey);
          if (index < 0) throw new Error('这张图片未加入附件，请删除后重新插入。');
          blocks.push({ type: 'image', uploadIndex: index });
        }
        return;
      }
      if (tag === 'BR') { flush(); return; }
      if (tag === 'UL' || tag === 'OL') {
        flush(); for (const child of node.childNodes) walk(child, marks, tag === 'UL' ? 'bullet' : 'number'); flush(); return;
      }
      const boundary = ['DIV', 'P', 'LI', 'FIGURE'].includes(tag);
      if (boundary) { flush(); current.type = tag === 'LI' ? list ?? 'bullet' : 'paragraph'; }
      const inherited = { ...marks };
      if (tag === 'B' || tag === 'STRONG') inherited.bold = true;
      if (tag === 'I' || tag === 'EM') inherited.italic = true;
      if (tag === 'A') { const href = link(node.getAttribute('href')); if (href) inherited.href = href; }
      for (const child of node.childNodes) walk(child, inherited, list);
      if (boundary) { flush(); current.type = 'paragraph'; }
    }
    for (const child of editor.childNodes) walk(child);
    flush();
    return { version: 1, blocks };
  }
  function sync() {
    const value = documentValue();
    const lines = value.blocks.filter(block => block.type !== 'image').map(block => block.runs.map(run => run.text).join('').trim()).filter(Boolean);
    if (lines.length > 15 || lines.join('\n').length > 2000) throw new Error('工作计划最多填写 15 项、2000 个字符。');
    form.elements.planRich.value = JSON.stringify(value);
    textarea.value = lines.join('\n');
  }
  function syncFiles() {
    const transfer = new DataTransfer(); staged.forEach(item => transfer.items.add(item.file)); fileInput.files = transfer.files;
    fileList.replaceChildren();
    for (const item of staged) {
      const row = document.createElement('div'); row.className = 'weekly-staged-file';
      const name = document.createElement('span'); name.textContent = item.file.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.setAttribute('aria-label', `移除 ${item.file.name}`);
      remove.addEventListener('click', () => {
        const index = staged.indexOf(item); if (index >= 0) staged.splice(index, 1);
        editor.querySelectorAll('img[data-upload-key]').forEach(image => { if (image.dataset.uploadKey === item.key) image.remove(); });
        if (item.url) { URL.revokeObjectURL(item.url); urls.delete(item.url); }
        syncFiles(); try { sync(); } catch (error) { notify(error.message); }
      });
      row.append(name, remove); fileList.append(row);
    }
  }
  function stage(files, inline) {
    const retained = form.querySelectorAll('input[name="retainedAttachment"]:checked').length;
    if (retained + staged.length + files.length > 5) { notify('每份周报最多保留 5 个附件，请先移除不需要的附件。'); return; }
    if (files.some(file => file.size > 5 * 1024 * 1024)) { notify('每个附件不能超过 5 MB。'); return; }
    if (inline && files.some(file => !imageTypes.has(file.type))) { notify('插图支持 JPG、PNG、GIF 和 WebP。'); return; }
    for (const file of files) {
      const item = { key: String(++fileSequence), file }; staged.push(item);
      if (inline) {
        const figure = document.createElement('figure'), image = document.createElement('img');
        item.url = URL.createObjectURL(file); urls.add(item.url);
        image.src = item.url; image.alt = '工作计划插图'; image.dataset.uploadKey = item.key;
        figure.append(image); insert(figure);
      }
    }
    syncFiles(); try { sync(); notify(inline ? '图片已插入，保存周报时一并上传。' : '附件已添加。'); } catch (error) { notify(error.message); }
  }
  const fileList = document.createElement('div'); fileList.className = 'weekly-staged-files'; fileInput.closest('label').after(fileList);
  const imagePicker = document.createElement('input'); imagePicker.type = 'file'; imagePicker.accept = 'image/jpeg,image/png,image/gif,image/webp'; imagePicker.multiple = true; imagePicker.hidden = true; shell.append(imagePicker);
  imagePicker.addEventListener('change', () => { stage(Array.from(imagePicker.files), true); imagePicker.value = ''; });
  fileInput.addEventListener('change', () => stage(Array.from(fileInput.files), false));
  shell.querySelector('[data-rich-image]').addEventListener('click', () => imagePicker.click());
  shell.querySelectorAll('[data-rich-command]').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      restore(); document.execCommand(button.dataset.richCommand, false); remember();
      try { sync(); notify(''); } catch (error) { notify(error.message); }
    });
  });
  const linkPanel = shell.querySelector('[data-rich-link-panel]'), linkUrl = shell.querySelector('[data-rich-link-url]');
  shell.querySelector('[data-rich-link]').addEventListener('click', () => { remember(); linkPanel.hidden = false; linkUrl.focus(); });
  shell.querySelector('[data-rich-link-cancel]').addEventListener('click', () => { linkPanel.hidden = true; linkUrl.value = ''; restore(); });
  shell.querySelector('[data-rich-link-apply]').addEventListener('click', () => {
    const href = link(linkUrl.value.trim()); if (!href) { notify('请填写完整的 HTTP 或 HTTPS 网址。'); return; }
    restore();
    if (window.getSelection()?.isCollapsed) {
      const anchor = document.createElement('a'); anchor.href = href; anchor.textContent = href; insert(anchor);
    } else document.execCommand('createLink', false, href);
    linkPanel.hidden = true; linkUrl.value = ''; remember();
    try { sync(); notify(''); } catch (error) { notify(error.message); }
  });
  linkUrl.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); shell.querySelector('[data-rich-link-apply]').click(); } });
  editor.addEventListener('paste', event => {
    event.preventDefault(); remember();
    const images = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (images.length) { stage(images, true); return; }
    // Paste copied web/email text without importing third-party markup or images.
    const text = event.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
    remember(); try { sync(); } catch (error) { notify(error.message); }
  });
  editor.addEventListener('drop', event => { event.preventDefault(); remember(); const files = Array.from(event.dataTransfer?.files ?? []); if (files.length) stage(files, true); });
  editor.addEventListener('dragover', event => event.preventDefault());
  editor.addEventListener('input', () => { remember(); try { sync(); notify(''); } catch (error) { notify(error.message); } });
  editor.addEventListener('keyup', remember); editor.addEventListener('mouseup', remember); editor.addEventListener('focus', remember);
  form.querySelectorAll('input[name="retainedAttachment"]').forEach(input => input.addEventListener('change', () => {
    if (!input.checked) editor.querySelectorAll('img[data-attachment-id]').forEach(image => { if (image.dataset.attachmentId === input.value) image.remove(); });
    try { checkCount(); sync(); notify(''); } catch (error) { notify(error.message); }
  }));
  form.addEventListener('submit', event => {
    try { checkCount(); sync(); syncFiles(); }
    catch (error) { event.preventDefault(); notify(error.message); editor.focus(); }
  });
  if (!editor.textContent.trim() && !editor.querySelector('img') && textarea.value) {
    editor.replaceChildren(...textarea.value.split(/\r?\n/).map(line => { const paragraph = document.createElement('p'); paragraph.textContent = line; return paragraph; }));
  }
  textarea.hidden = true; shell.hidden = false; form.elements.richEditor.value = '1';
  form.querySelector('label[for="weekly-plan"]').addEventListener('click', event => { event.preventDefault(); editor.focus(); });
  window.addEventListener('pagehide', () => urls.forEach(url => URL.revokeObjectURL(url)));
})();
