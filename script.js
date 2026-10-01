/* Chat2PDF - vanilla JS. All processing happens locally in the browser. */
(() => {
'use strict';

/* ============ State ============ */
const KEYS = { settings: 'chat2pdf.settings.v1', text: 'chat2pdf.text.v1' };
const DEFAULTS = { appearance: 'system', pageSize: 'a4', fontSize: 'medium', docTheme: 'clean', title: 'ChatGPT Notes', author: '', pageNumbers: true, date: true, toc: true, cover: true, labels: true, rememberText: false };
const PAGE_DIMS = { a4: { w: 794, h: 1123, css: 'A4' }, letter: { w: 816, h: 1056, css: 'letter' } };
const FONT_PX = { small: 13, medium: 14.5, large: 16 };
const MAX_CHARS = 300000;
const state = { settings: { ...DEFAULTS }, source: '', pages: [], plain: '', generated: false, dirty: false, busy: false };

/* ============ DOM elements ============ */
const ids = ['chatInput', 'charCount', 'exampleBtn', 'demoBtn', 'pasteBtn', 'clearBtn', 'genBtn', 'themeBtn', 'settingsBtn', 'customizeCard', 'previewSection', 'emptyState', 'previewBody', 'statusChip', 'pager', 'pages', 'downloadBtn', 'shareBtn', 'copyBtn', 'printBtn', 'barPreview', 'barCustomize', 'barDownload', 'printRoot', 'pageRule', 'toasts', 'settingsDlg', 'resetBtn', 'clearDataBtn', 'doneBtn', 'closeBtn', 'metaTheme'];
const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const iconUse = n => `<svg class="i"><use href="#i-${n}"/></svg>`;

/* ============ LocalStorage ============ */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};
function loadSettings() {
  const saved = store.get(KEYS.settings);
  if (saved && typeof saved === 'object') for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === typeof DEFAULTS[k]) state.settings[k] = saved[k];
}
const saveSettings = () => store.set(KEYS.settings, state.settings);

/* ============ Toasts ============ */
function toast(msg, type = 'ok', ms = 3000) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.setAttribute('role', 'status');
  t.innerHTML = iconUse(type === 'error' ? 'alert' : 'check') + '<span></span>';
  t.lastChild.textContent = msg;
  els.toasts.appendChild(t);
  while (els.toasts.children.length > 3) els.toasts.firstChild.remove();
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
}

/* ============ Sanitizer ============ */
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const nl = s => s.replace(/\n/g, '<br>');
const strip = s => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|[*`])/g, '').trim();

/* Escape first, then apply a small set of known-safe formatting tags. */
function inline(raw) {
  const slots = [];
  const hold = h => { slots.push(h); return `\u0000${slots.length - 1}\u0000`; };
  const emph = t => t
    .replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>])__([^\s_](?:[^_]*[^\s_])?)__(?=[\s).,;:!?<]|$)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(>])_([^\s_](?:[^_]*[^\s_])?)_(?=[\s).,;:!?<]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  let s = escapeHtml(String(raw).replace(/\u0000/g, ''));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, t, u) => SAFE_URL.test(u) ? hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${emph(t)}</a>`) : t);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)(?=[.,;:!?)]*(?:\s|$))/g, (m, p, u) => p + hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
  s = emph(s);
  for (let k = 0; k < 3; k++) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i] ?? '');
  return s;
}

/* ============ Parser ============ */
const ROLE_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(user|you|human|q|assistant|chatgpt|chat\s?gpt|ai|gpt|a|bot)(?:\s+said)?(?:\*\*)?\s*:\s*(?:\*\*)?(.*)$/i;
const ROLE_ALONE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(user|you|human|assistant|chatgpt)(?:\*\*)?\s*$/i;
const RE = {
  fence: /^\s*(```|~~~)\s*([\w+#.-]*)/,
  hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  h: /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/,
  li: /^(\s*)([-*\u2022+]|\d{1,3}[.)])\s+(.*)$/,
  quote: /^\s*>\s?(.*)$/,
  sep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
};
const isTableAt = (L, i) => L[i].includes('|') && i + 1 < L.length && L[i + 1].includes('-') && RE.sep.test(L[i + 1]);
const isStart = (L, i) => RE.fence.test(L[i]) || RE.hr.test(L[i]) || RE.h.test(L[i]) || RE.li.test(L[i]) || RE.quote.test(L[i]) || isTableAt(L, i);
const roleOf = w => /^(user|you|human|q)$/i.test(w.trim()) ? 'user' : 'assistant';

/* Split raw text into speaker turns (ignores role-looking lines inside code fences). */
function splitTurns(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n');
  const turns = []; let cur = null, fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && (line.match(ROLE_RE) || line.match(ROLE_ALONE));
    if (m) { cur = { role: roleOf(m[1]), lines: [] }; turns.push(cur); if (m[2] && m[2].trim()) cur.lines.push(m[2]); continue; }
    if (!cur) { if (!line.trim()) continue; cur = { role: 'assistant', lines: [], implicit: true }; turns.push(cur); }
    cur.lines.push(line);
  }
  return turns.filter(t => t.lines.some(l => l.trim()));
}

/* Markdown-like text -> block descriptors. */
function parseBlocks(L) {
  const out = []; let i = 0, m;
  while (i < L.length) {
    const line = L[i];
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(RE.fence))) {
      const code = []; i++;
      while (i < L.length && !L[i].trim().startsWith(m[1])) { code.push(L[i]); i++; }
      i++; out.push({ type: 'code', lang: m[2] || '', code }); continue;
    }
    if (RE.hr.test(line)) { out.push({ type: 'hr' }); i++; continue; }
    if ((m = line.match(RE.h))) { out.push({ type: 'h', level: m[1].length, text: m[2] }); i++; continue; }
    if (isTableAt(L, i)) {
      const row = s => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const head = row(line); i += 2; const rows = [];
      while (i < L.length && L[i].trim() && L[i].includes('|')) { rows.push(row(L[i])); i++; }
      out.push({ type: 'table', head, rows }); continue;
    }
    if (RE.quote.test(line)) {
      const inner = [];
      while (i < L.length && RE.quote.test(L[i])) { inner.push(L[i].match(RE.quote)[1]); i++; }
      out.push({ type: 'quote', children: parseBlocks(inner) }); continue;
    }
    if (RE.li.test(line)) {
      while (i < L.length) {
        const mm = L[i].match(RE.li);
        if (mm) {
          out.push({ type: 'li', ord: /\d/.test(mm[2]), n: parseInt(mm[2], 10), lvl: Math.min(2, Math.floor(mm[1].replace(/\t/g, '  ').length / 2)), text: mm[3] });
          i++; continue;
        }
        if (!L[i].trim()) {
          let j = i; while (j < L.length && !L[j].trim()) j++;
          if (j < L.length && RE.li.test(L[j])) { i = j; continue; }
          break;
        }
        if (/^\s{2,}\S/.test(L[i]) && !isStart(L, i)) { out[out.length - 1].text += '\n' + L[i].trim(); i++; continue; }
        break;
      }
      continue;
    }
    const buf = [line.trim()]; i++;
    while (i < L.length && L[i].trim() && !isStart(L, i)) { buf.push(L[i].trim()); i++; }
    out.push({ type: 'p', text: buf.join('\n') });
  }
  return out;
}

/* ============ Document renderer ============ */
function splitSentences(t, max) {
  const s = t.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [t];
  const out = []; let cur = '';
  for (const x of s) { if (cur && (cur + x).length > max) { out.push(cur.trim()); cur = ''; } cur += x; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const chunk = (arr, n) => { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; };

/* Block descriptors -> {html, plain, keep, toc, expand}. `keep` = keep with next block. */
function toBlocks(list, o = {}) {
  const out = [], q = o.q ? ' q' : '';
  for (const b of list) {
    switch (b.type) {
      case 'h': {
        const lvl = b.level <= 2 ? 3 : 4, t = strip(b.text);
        out.push({ html: `<h${lvl}>${inline(b.text)}</h${lvl}>`, plain: t, keep: true, toc: lvl === 3 && !o.q ? { lvl: 2, text: t } : null });
        break;
      }
      case 'p': {
        const lead = !b.text.includes('\n') && /:\s*\**$/.test(b.text.trim()) && b.text.length < 90;
        const call = !lead && /^\W{0,4}(important|key\s*(point|takeaway)|note|remember|tip|warning)s?\b[^:\n]{0,20}:/i.test(b.text);
        const cls = ((call ? 'note ' : '') + (lead ? 'lead ' : '') + (o.q ? 'q' : '')).trim();
        const mk = t => `<p${cls ? ` class="${cls}"` : ''}>${nl(inline(t))}</p>`;
        const blk = { html: mk(b.text), plain: strip(b.text), keep: lead };
        if (b.text.length > 700) blk.expand = splitSentences(b.text, 450).map(t => ({ html: mk(t), plain: strip(t), keep: false }));
        out.push(blk); break;
      }
      case 'li': {
        const mk = b.ord ? b.n + '.' : '\u2022';
        out.push({ html: `<div class="li l${b.lvl}${q}"><span class="mk">${mk}</span><div class="lt">${nl(inline(b.text))}</div></div>`, plain: '  '.repeat(b.lvl) + mk + ' ' + strip(b.text), keep: false, li: true });
        break;
      }
      case 'code': {
        const mk = ls => ({ html: `<pre class="code"${b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : ''}><code>${escapeHtml(ls.join('\n'))}</code></pre>`, plain: ls.join('\n'), keep: false });
        const blk = mk(b.code);
        if (b.code.length > 26) blk.expand = chunk(b.code, 26).map(mk);
        out.push(blk); break;
      }
      case 'table': {
        const cols = Math.max(b.head.length, 1, ...b.rows.map(r => r.length));
        const pad = r => Array.from({ length: cols }, (_, i) => r[i] ?? '');
        const cell = (tag, t) => `<${tag}>${inline(t)}</${tag}>`;
        const mk = rows => ({
          html: `<div class="tbl"><table><thead><tr>${pad(b.head).map(c => cell('th', c)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${pad(r).map(c => cell('td', c)).join('')}</tr>`).join('')}</tbody></table></div>`,
          plain: [b.head, ...rows].map(r => r.join(' | ')).join('\n'), keep: false
        });
        const blk = mk(b.rows);
        if (b.rows.length > 9) blk.expand = chunk(b.rows, 9).map(mk);
        out.push(blk); break;
      }
      case 'quote': {
        const kids = toBlocks(b.children);
        out.push({ html: `<blockquote>${kids.map(k => k.html).join('')}</blockquote>`, plain: kids.map(k => k.plain).join('\n'), keep: false });
        break;
      }
      case 'hr': out.push({ html: '<hr>', plain: '', keep: false }); break;
    }
  }
  return out;
}

function deriveTitle(text, idx) {
  let t = strip(text.split('\n').find(l => l.trim()) || '')
    .replace(/^(please\s+)?(can you\s+)?(explain|describe|define|what\s+(is|are)|tell me about|write about|summari[sz]e|give me)\s+(the\s+|an?\s+)?/i, '')
    .replace(/[?.!:\s]+$/, '');
  if (t.length > 64) { t = t.slice(0, 64); const sp = t.lastIndexOf(' '); t = t.slice(0, sp > 30 ? sp : 64) + '\u2026'; }
  return t ? t[0].toUpperCase() + t.slice(1) : `Section ${idx + 1}`;
}

/* Conversation -> flat list of document blocks (Question / Answer sections). */
function buildContent(text, s) {
  const turns = splitTurns(text);
  if (!turns.length) throw new Error('empty');
  const sections = []; let cur = null;
  for (const t of turns) {
    if (t.role === 'user') { cur = { q: [...t.lines], a: [] }; sections.push(cur); }
    else { if (!cur) { cur = { q: null, a: [] }; sections.push(cur); } cur.a.push('', ...t.lines); }
  }
  const blocks = [];
  sections.forEach((sec, i) => {
    const qb = sec.q ? parseBlocks(sec.q) : [];
    let ab = parseBlocks(sec.a), title;
    if (ab[0] && ab[0].type === 'h' && ab[0].level <= 2) { title = strip(ab[0].text); ab = ab.slice(1); }
    else title = deriveTitle(sec.q ? sec.q.join('\n') : sec.a.join('\n'), i);
    blocks.push({ html: `<h2>${escapeHtml(title)}</h2>`, plain: title, keep: true, toc: { lvl: 1, text: title } });
    if (qb.length) {
      if (s.labels) blocks.push({ html: '<div class="lbl q">Question</div>', plain: 'Question', keep: true });
      blocks.push(...toBlocks(qb, { q: true }));
    }
    if (ab.length) {
      if (s.labels && qb.length) blocks.push({ html: '<div class="lbl a">Answer</div>', plain: 'Answer', keep: true });
      blocks.push(...toBlocks(ab));
    }
  });
  return { blocks, count: sections.length };
}

/* ============ Pagination ============ */
function makeCtx(s) {
  const d = PAGE_DIMS[s.pageSize] || PAGE_DIMS.a4;
  return { d, cls: 't-' + (s.docTheme || 'clean'), style: `--pw:${d.w}px;--ph:${d.h}px;--fs:${FONT_PX[s.fontSize] || 14.5}px` };
}

/* Fill pages by measuring real layout in an off-screen page of identical size. */
function paginate(blocks, ctx) {
  const m = document.createElement('div');
  m.className = `page measure ${ctx.cls}`; m.style.cssText = ctx.style; m.innerHTML = '<div class="pg-body"></div>';
  document.body.appendChild(m);
  const body = m.firstElementChild;
  const pages = []; let cur = [];
  const reset = arr => { body.innerHTML = arr.map(b => b.html).join(''); };
  const fits = () => body.scrollHeight <= body.clientHeight + 1;
  const queue = blocks.slice();
  try {
    while (queue.length) {
      const b = queue.shift();
      body.insertAdjacentHTML('beforeend', b.html);
      if (fits()) { cur.push(b); continue; }
      if (b.expand) {                       // oversized block: split into parts if it can't fit a page alone
        body.innerHTML = b.html; const alone = fits(); reset(cur);
        if (!alone) { queue.unshift(...b.expand); continue; }
      }
      if (!cur.length) { cur = [b]; reset(cur); continue; }
      const carry = [b];                    // never leave headings/labels stranded at the page bottom
      while (cur.length && cur[cur.length - 1].keep) carry.unshift(cur.pop());
      if (cur.length) pages.push(cur);
      cur = carry; reset(cur);
    }
    if (cur.length) pages.push(cur);
  } finally { m.remove(); }
  return pages;
}

function buildPages(src, s) {
  const ctx = makeCtx(s);
  const title = s.title.trim() || DEFAULTS.title;
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const { blocks: content, count } = buildContent(src, s);
  const entries = content.filter(b => b.toc).map(b => b.toc);
  const tocBlocks = nums => [{ html: '<h2 class="toc-h">Contents</h2>', plain: '', keep: true }].concat(entries.map((e, i) => ({
    html: `<div class="toc-row l${e.lvl}"><span class="tt">${escapeHtml(e.text)}</span><span class="dots"></span><span class="tn">${nums ? nums[i] : 0}</span></div>`, plain: '', keep: false
  })));
  const wantToc = s.toc && entries.length > 0;
  const tocCount = wantToc ? paginate(tocBlocks(null), ctx).length : 0;
  const contentPages = paginate(content, ctx);
  const offset = (s.cover ? 1 : 0) + tocCount;
  const nums = [];
  contentPages.forEach((pg, pi) => pg.forEach(b => { if (b.toc) nums.push(offset + pi + 1); }));
  const tocPages = wantToc ? paginate(tocBlocks(nums), ctx) : [];
  const total = offset + contentPages.length;
  const wrap = (blks, n) => `<div class="page ${ctx.cls}" style="${ctx.style}"><div class="pg-body">${blks.map(b => b.html).join('')}</div><div class="pg-foot"><span>${escapeHtml(title)}</span>${s.date ? `<span>${escapeHtml(dateStr)}</span>` : ''}${s.pageNumbers ? `<span>Page ${n} of ${total}</span>` : ''}</div></div>`;
  const pages = [];
  if (s.cover) pages.push(`<div class="page cover ${ctx.cls}" style="${ctx.style}"><div class="cv"><div class="cv-bar"></div><h1>${escapeHtml(title)}</h1>${s.author.trim() ? `<p class="cv-by">${escapeHtml(s.author.trim())}</p>` : ''}<p class="cv-sub">${count} ${count === 1 ? 'section' : 'sections'} from a ChatGPT conversation</p>${s.date ? `<p class="cv-date">${escapeHtml(dateStr)}</p>` : ''}</div></div>`);
  tocPages.forEach(pg => pages.push(wrap(pg, pages.length + 1)));
  contentPages.forEach(pg => pages.push(wrap(pg, pages.length + 1)));
  // Plain-text version for Copy / Share
  let plain = title + (s.author.trim() ? '\nBy ' + s.author.trim() : '') + '\n', prevLi = false;
  content.forEach(b => { if (!b.plain) return; plain += (b.li && prevLi ? '\n' : '\n\n') + b.plain; prevLi = !!b.li; });
  return { pages, plain: plain.trim() + '\n' };
}

/* ============ Preview ============ */
const dimsNow = () => PAGE_DIMS[state.settings.pageSize] || PAGE_DIMS.a4;
function renderPreview() {
  const d = dimsNow();
  els.pages.style.setProperty('--pw', d.w + 'px');
  els.pages.style.setProperty('--ph', d.h + 'px');
  els.pages.innerHTML = state.pages.map((h, i) => `<figure class="frame"><figcaption>Page ${i + 1}</figcaption><div class="frame-box">${h}</div></figure>`).join('');
  fitPreview(); updatePager();
}
function fitPreview() {
  const w = els.pages.clientWidth;
  if (w) els.pages.style.setProperty('--s', (w / dimsNow().w).toFixed(4));
}
function updatePager() {
  if (!state.generated) return;
  const fr = $$('.frame', els.pages); let cur = 0; const y = innerHeight * 0.4;
  fr.forEach((f, i) => { if (f.getBoundingClientRect().top <= y) cur = i; });
  els.pager.textContent = `Page ${cur + 1} of ${fr.length}`;
}
function setStatus() {
  const c = els.statusChip;
  c.hidden = !state.generated;
  c.className = 'status' + (state.dirty ? ' warn' : '');
  c.innerHTML = state.dirty ? iconUse('alert') + '<span>Text changed. Generate again.</span>' : iconUse('check') + '<span>Document ready</span>';
}
function showDoc(scroll) {
  els.emptyState.hidden = state.generated;
  els.previewBody.hidden = !state.generated;
  setStatus();
  if (state.generated) {
    renderPreview();
    els.pages.classList.remove('pop'); void els.pages.offsetWidth; els.pages.classList.add('pop');
    if (scroll) els.previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ============ Generate ============ */
async function generate() {
  if (state.busy) return false;
  const text = els.chatInput.value;
  if (!text.trim()) { toast('Please paste a conversation first.', 'error'); els.chatInput.focus(); return false; }
  if (text.length > MAX_CHARS) { toast(`That is too long. Keep it under ${MAX_CHARS.toLocaleString()} characters.`, 'error'); return false; }
  state.busy = true; els.genBtn.disabled = true; els.genBtn.classList.add('busy');
  els.genBtn.querySelector('span').textContent = 'Generating...';
  await new Promise(r => setTimeout(r, 40));       // let the UI paint before heavy work
  try {
    state.source = text; compile();
    state.generated = true; state.dirty = false; showDoc(true);
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message === 'empty' ? 'We could not find any readable text. Check what you pasted.' : 'Something went wrong while formatting. Try a shorter conversation.', 'error');
    return false;
  } finally {
    state.busy = false; els.genBtn.disabled = false; els.genBtn.classList.remove('busy');
    els.genBtn.querySelector('span').textContent = 'Generate Preview';
  }
}
function compile() { const r = buildPages(state.source, state.settings); state.pages = r.pages; state.plain = r.plain; }
async function ensureDoc() {
  if (state.generated && (!state.dirty || !els.chatInput.value.trim())) return true;
  if (!els.chatInput.value.trim()) { toast('Please paste a conversation first.', 'error'); els.chatInput.focus(); return false; }
  return generate();
}
let rerenderTimer = 0;
function scheduleRerender() {
  if (!state.generated) return;
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => { try { compile(); showDoc(false); } catch (e) { console.error(e); toast('Could not update the preview.', 'error'); } }, 300);
}

/* ============ Input / Clipboard ============ */
let sizeRaf = 0, saveTimer = 0;
function onInput() {
  const v = els.chatInput.value;
  els.charCount.textContent = v.length.toLocaleString();
  if (state.generated) { const d = v !== state.source; if (d !== state.dirty) { state.dirty = d; setStatus(); } }
  if (!sizeRaf) sizeRaf = requestAnimationFrame(() => {
    sizeRaf = 0; const t = els.chatInput; t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight + 2, Math.round(innerHeight * 0.6)) + 'px';
  });
  clearTimeout(saveTimer); saveTimer = setTimeout(persistText, 500);
}
function persistText() {
  if (state.settings.rememberText) store.set(KEYS.text, els.chatInput.value); else store.del(KEYS.text);
}
function setInput(t) { els.chatInput.value = t; onInput(); }
async function pasteFromClipboard() {
  const fail = () => { toast('Clipboard unavailable. Long-press the box and choose Paste.', 'error'); els.chatInput.focus(); };
  if (!navigator.clipboard || !navigator.clipboard.readText) return fail();
  try {
    const t = await navigator.clipboard.readText();
    if (!t.trim()) return toast('Your clipboard is empty.', 'error');
    setInput(t); toast('Pasted');
  } catch { fail(); }
}
function clearInput() {
  setInput(''); state.generated = false; state.dirty = false; state.pages = []; state.source = '';
  showDoc(false); toast('Cleared'); els.chatInput.focus();
}
async function copyText(t) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); return true; } } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

/* ============ PDF / Print / Share ============ */
const fileName = () => (state.settings.title.trim() || DEFAULTS.title).replace(/[\\/:*?"<>|]+/g, '').slice(0, 80);
async function printDoc() {
  if (!(await ensureDoc())) return;
  if (typeof window.print !== 'function') return toast('Printing is not available in this browser. Try Chrome or Safari.', 'error');
  els.pageRule.textContent = `@page{size:${dimsNow().css};margin:0}`;
  els.printRoot.innerHTML = state.pages.join('');
  const prev = document.title; document.title = fileName();
  const restore = () => { document.title = prev; els.printRoot.innerHTML = ''; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  toast('PDF ready. Choose "Save as PDF" in the print dialog.');
  setTimeout(() => { try { window.print(); } catch (e) { restore(); toast('Your browser blocked printing. Try Chrome or Safari.', 'error'); } }, 250);
}
async function shareDoc() {
  if (!(await ensureDoc())) return;
  if (!navigator.share) return toast('Sharing is not supported here. Download the PDF, then share the saved file.', 'error');
  try { await navigator.share({ title: fileName(), text: state.plain }); }
  catch (e) { if (e && e.name !== 'AbortError') toast('Sharing failed. Try Download PDF instead.', 'error'); }
}
async function copyDoc() {
  if (!(await ensureDoc())) return;
  (await copyText(state.plain)) ? toast('Copied') : toast('Could not copy. Select the text manually.', 'error');
}

/* ============ Theme ============ */
const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : { matches: true };
const resolvedTheme = () => state.settings.appearance === 'system' ? (mq.matches ? 'dark' : 'light') : state.settings.appearance;
function applyTheme(animate) {
  const root = document.documentElement, r = resolvedTheme();
  if (animate) { root.classList.add('theming'); setTimeout(() => root.classList.remove('theming'), 350); }
  root.dataset.theme = r;
  els.metaTheme.setAttribute('content', r === 'dark' ? '#0a0f1f' : '#f4f5fb');
}
if (mq.addEventListener) mq.addEventListener('change', () => { if (state.settings.appearance === 'system') applyTheme(true); });

/* ============ Settings ============ */
let settingsTouched = false;
function syncControls() {
  document.querySelectorAll('[data-setting]').forEach(el => {
    const v = state.settings[el.dataset.setting];
    if (el.type === 'radio') el.checked = el.value === v;
    else if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v;
  });
}
function onSettingInput(e) {
  const el = e.target.closest && e.target.closest('[data-setting]');
  if (!el) return;
  const k = el.dataset.setting;
  state.settings[k] = el.type === 'checkbox' ? el.checked : el.value;
  settingsTouched = true;
  if (k === 'appearance') applyTheme(true);
  if (k === 'rememberText') persistText();
  syncControls(); saveSettings();
  if (k !== 'appearance' && k !== 'rememberText') scheduleRerender();
}
function resetSettings() {
  state.settings = { ...DEFAULTS }; saveSettings(); store.del(KEYS.text);
  applyTheme(true); syncControls(); scheduleRerender(); toast('Settings reset');
}
function clearSavedData() {
  store.del(KEYS.settings); store.del(KEYS.text);
  state.settings = { ...DEFAULTS }; applyTheme(true); syncControls(); scheduleRerender(); toast('Saved data cleared');
}
function openSettings() {
  settingsTouched = false;
  if (els.settingsDlg.showModal) els.settingsDlg.showModal(); else els.settingsDlg.setAttribute('open', '');
}
function closeSettings() { if (els.settingsDlg.close) els.settingsDlg.close(); else els.settingsDlg.removeAttribute('open'); }

/* ============ Sample content ============ */
const EXAMPLE = `User:
Explain photosynthesis.

A:
Photosynthesis is the process by which green plants convert light energy into chemical energy.

Important points:

- It occurs mainly in chloroplasts.
- Chlorophyll absorbs light energy.
- Carbon dioxide and water are used.
- Oxygen is released.

User:
Write the overall equation.

A:
**6CO2 + 6H2O + light energy -> C6H12O6 + 6O2**`;

const DEMO = `User:
Explain national income for my Class 12 Economics notes.

ChatGPT:
## National Income

National income is the total value of all final goods and services produced by a country's normal residents in a year, valued at market prices, plus net factor income from abroad.

> **Key point:** National income measures the economic performance of a country. It is the base for planning, policy and comparing living standards.

## Important Concepts

- **GDP**: value of all final goods and services produced within the domestic territory.
- **GNP**: GDP plus net factor income from abroad.
- **NNP**: GNP minus depreciation (consumption of fixed capital).
- **Per capita income**: national income divided by population.

Important: Only *final* goods are counted, otherwise the same output would be counted twice.

User:
What are the methods of measuring national income?

ChatGPT:
## Methods of Measuring National Income

There are three equivalent methods:

1. **Product (value added) method**: sum of value added by all producing units.
2. **Income method**: sum of factor incomes such as rent, wages, interest and profit.
3. **Expenditure method**: sum of consumption, investment, government spending and net exports.

| Method | What is added | Formula |
|---|---|---|
| Product | Value added | GVA = Output - Intermediate consumption |
| Income | Factor incomes | NDP(FC) = W + R + I + P + mixed income |
| Expenditure | Final spending | GDP(MP) = C + I + G + (X - M) |

> **Remember:** In theory all three methods give the same result, because one person's expenditure is another person's income.

User:
Give me 3 likely exam questions with short answers.

ChatGPT:
## Practice Questions

1. **Why is the sale of second-hand goods not included in national income?**
   Because their value was already counted in the year they were produced.
2. **Differentiate between GDP and GNP.**
   GDP counts output within the territory; GNP adds net factor income from abroad.
3. **Why are transfer payments excluded?**
   They are not payments for any productive service, so no output is created.

Tip: Practise the formulas with small numerical examples before the exam.`;

/* ============ Event listeners ============ */
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast('Something went wrong. Please try again.', 'error'); } };
const on = (el, ev, fn, opt) => el.addEventListener(ev, safe(fn), opt);
const scrollTo = el => el.scrollIntoView({ behavior: 'smooth', block: 'start' });

on(els.chatInput, 'input', onInput);
on(els.chatInput, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generate(); });
on(els.pasteBtn, 'click', pasteFromClipboard);
on(els.clearBtn, 'click', clearInput);
on(els.genBtn, 'click', generate);
on(els.exampleBtn, 'click', () => { setInput(EXAMPLE); toast('Example added. Tap Generate Preview.'); });
on(els.demoBtn, 'click', () => { setInput(DEMO); return generate(); });
on(els.downloadBtn, 'click', printDoc);
on(els.barDownload, 'click', printDoc);
on(els.printBtn, 'click', printDoc);
on(els.shareBtn, 'click', shareDoc);
on(els.copyBtn, 'click', copyDoc);
on(els.barPreview, 'click', () => (els.chatInput.value.trim() && (!state.generated || state.dirty)) ? generate() : scrollTo(els.previewSection));
on(els.barCustomize, 'click', () => scrollTo(els.customizeCard));
on(els.themeBtn, 'click', () => { state.settings.appearance = resolvedTheme() === 'dark' ? 'light' : 'dark'; applyTheme(true); syncControls(); saveSettings(); });
on(els.settingsBtn, 'click', openSettings);
on(els.closeBtn, 'click', closeSettings);
on(els.doneBtn, 'click', closeSettings);
on(els.resetBtn, 'click', resetSettings);
on(els.clearDataBtn, 'click', clearSavedData);
els.settingsDlg.addEventListener('click', e => { if (e.target === els.settingsDlg) closeSettings(); });
els.settingsDlg.addEventListener('close', () => { if (settingsTouched) { toast('Settings saved'); settingsTouched = false; } });
document.addEventListener('input', onSettingInput);
document.addEventListener('change', onSettingInput);

let scrollRaf = 0;
addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updatePager(); }); }, { passive: true });
if (window.ResizeObserver) new ResizeObserver(fitPreview).observe(els.pages); else addEventListener('resize', fitPreview);
addEventListener('error', () => toast('Something went wrong. Please reload the page.', 'error'));

/* ============ Init ============ */
loadSettings();
applyTheme(false);
syncControls();
if (state.settings.rememberText) { const t = store.get(KEYS.text); if (typeof t === 'string') setInput(t); }
onInput();
showDoc(false);
})();
