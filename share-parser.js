/* Chat2PDF - ChatGPT share-link reader.
   Works in the browser (global ShareParser) and in Node (require). It reads the conversation that
   chatgpt.com embeds inside the share page itself, so no private API or login is needed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShareParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ID_RE = /^[0-9a-f-]{20,64}$/i;
  const HEADERS = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'referer': 'https://chatgpt.com/'
  };
  const fail = code => Object.assign(new Error(code), { code });

  /* ---------- text cleanup ---------- */
  function clean(t) {
    return String(t)
      .replace(/\ue200entity\ue202(\[[^\ue201]*?\])\ue201/g, (m, j) => { try { const a = JSON.parse(j); return typeof a[1] === 'string' ? a[1] : ''; } catch (e) { return ''; } })
      .replace(/ ?\ue200[^\ue201]*\ue201/g, '')        // citations, file references, nav lists
      .replace(/[\ue000-\uf8ff]/g, '')
      .replace(/\r\n?/g, '\n');
  }

  /* ---------- decode the flattened "turbo-stream" list used by chatgpt.com ---------- */
  function decodeLoader(loader) {
    const cache = new Map();
    const keyOf = k => {
      if (typeof k === 'string' && /^_\d+$/.test(k)) { const c = loader[+k.slice(1)]; if (typeof c === 'string') return c; }
      return k;
    };
    function at(i) {
      if (i < 0) return null;
      if (i >= loader.length) return i;
      if (cache.has(i)) return cache.get(i);
      const raw = loader[i];
      if (raw && typeof raw === 'object') {
        if (Array.isArray(raw)) {
          const out = []; cache.set(i, out);
          for (const x of raw) out.push(Number.isInteger(x) ? at(x) : x);
          return out;
        }
        const out = {}; cache.set(i, out);
        for (const k of Object.keys(raw)) out[keyOf(k)] = Number.isInteger(raw[k]) ? at(raw[k]) : raw[k];
        return out;
      }
      cache.set(i, raw);
      return raw;
    }
    return at;
  }

  function findConversation(node, seen, depth) {
    seen = seen || new Set(); depth = depth || 0;
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 40) return null;
    seen.add(node);
    if (!Array.isArray(node) && node.mapping && typeof node.mapping === 'object' && (node.linear_conversation || node.current_node)) return node;
    for (const v of (Array.isArray(node) ? node : Object.values(node))) {
      const r = findConversation(v, seen, depth + 1);
      if (r) return r;
    }
    return null;
  }

  function conversationFromLoader(loader) {
    const at = decodeLoader(loader);
    let conv = findConversation(at(0));
    if (conv) return conv;
    for (let i = 1; i + 1 < loader.length && !conv; i += 2) {   // alternate layout: key, value pairs
      if (typeof loader[i] === 'string') conv = findConversation(at(i + 1));
    }
    for (let i = 0; i < loader.length && !conv; i++) {          // last resort: any object that looks like a conversation
      const raw = loader[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const keys = Object.keys(raw).map(k => (/^_\d+$/.test(k) && typeof loader[+k.slice(1)] === 'string') ? loader[+k.slice(1)] : k);
      if (keys.includes('mapping') && (keys.includes('linear_conversation') || keys.includes('current_node'))) conv = findConversation(at(i));
    }
    return conv;
  }

  /* ---------- pull the payload out of the share page ---------- */
  function readJsString(s, i) {
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === '"') { try { return { value: JSON.parse(s.slice(i, j + 1)), end: j + 1 }; } catch (e) { return null; } }
    }
    return null;
  }
  function loaderChunks(html) {
    const out = [], re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi; let m;
    while ((m = re.exec(html))) {
      const text = m[1], tag = 'streamController.enqueue(';
      let from = 0;
      while (text.includes(tag) && from < text.length) {
        const a = text.indexOf(tag, from); if (a < 0) break;
        let p = a + tag.length; while (p < text.length && /\s/.test(text[p])) p++;
        from = p;
        if (text[p] !== '"') continue;
        const lit = readJsString(text, p); if (!lit) continue;
        from = lit.end;
        const s = String(lit.value).trim();
        if (s.startsWith('[')) { try { const arr = JSON.parse(s); if (Array.isArray(arr)) out.push(arr); } catch (e) { /* skip */ } }
      }
    }
    return out;
  }

  /* ---------- conversation -> turns ---------- */
  function toTurns(conv) {
    const map = conv.mapping || {};
    let nodes = [];
    if (Array.isArray(conv.linear_conversation) && conv.linear_conversation.length) {
      nodes = conv.linear_conversation.map(e => (e && e.message) ? e : map[e && e.id]).filter(Boolean);
    } else {
      for (let id = conv.current_node, n = 0; id && map[id] && n < 5000; id = map[id].parent, n++) nodes.unshift(map[id]);
    }
    const turns = [];
    for (const node of nodes) {
      const m = node.message; if (!m || !m.content) continue;
      const role = m.author && m.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.recipient && m.recipient !== 'all') continue;
      if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
      const ct = m.content.content_type;
      if (ct !== 'text' && ct !== 'multimodal_text') continue;
      const bits = [];
      for (const p of (m.content.parts || [])) {
        if (typeof p === 'string') bits.push(clean(p));
        else if (p && /image/.test(String(p.content_type || '') + String(p.type || ''))) bits.push('*[Image]*');
      }
      const text = bits.join('\n\n').trim();
      if (text) turns.push({ role, text });
    }
    return turns;
  }
  function result(conv) {
    const turns = toTurns(conv);
    if (!turns.length) throw fail('parse');
    return { title: typeof conv.title === 'string' ? conv.title : '', turns };
  }

  function parseHtml(html) {
    for (const loader of loaderChunks(html)) {
      const conv = conversationFromLoader(loader);
      if (conv) return result(conv);
    }
    const nd = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);   // older pages
    if (nd) { try { const conv = findConversation(JSON.parse(nd[1])); if (conv) return result(conv); } catch (e) { /* fall through */ } }
    const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi; let m;
    while ((m = re.exec(html))) {
      const t = m[1].trim();
      if ((t[0] === '{' || t[0] === '[') && /"mapping"/.test(t)) { try { const conv = findConversation(JSON.parse(t)); if (conv) return result(conv); } catch (e) { /* skip */ } }
    }
    throw fail('parse');
  }
  const BLOCK_RE = /just a moment|cf-chl|cf_chl_opt|challenge-platform|enable javascript and cookies|attention required|verify you are human|captcha|access denied|unusual activity/i;
  const looksBlocked = html => BLOCK_RE.test(String(html).slice(0, 60000));
  const hasChatMarkers = html => /streamController|__NEXT_DATA__|data-message-author-role/.test(html);

  /* ---------- browser only: read a page that was saved after it had rendered ---------- */
  function domToMarkdown(root) {
    const inline = n => Array.from(n.childNodes).map(node).join('');
    const block = (s) => '\n\n' + s.trim() + '\n\n';
    function list(n) {
      const ord = n.tagName === 'OL'; let i = 0, out = '';
      for (const li of Array.from(n.children)) {
        if (li.tagName !== 'LI') continue;
        i++;
        const body = inline(li).trim().replace(/\n{2,}/g, '\n').replace(/\n/g, '\n   ');
        out += (ord ? i + '. ' : '- ') + body + '\n';
      }
      return block(out);
    }
    function table(n) {
      const rows = Array.from(n.querySelectorAll('tr')).map(tr => Array.from(tr.children).map(c => inline(c).trim().replace(/\|/g, '/').replace(/\n+/g, ' ')));
      if (!rows.length) return '';
      const w = Math.max(...rows.map(r => r.length)), pad = r => Array.from({ length: w }, (_, k) => r[k] || '');
      const line = r => '| ' + pad(r).join(' | ') + ' |';
      return block([line(rows[0]), '|' + ' --- |'.repeat(w)].concat(rows.slice(1).map(line)).join('\n'));
    }
    function node(n) {
      if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, ' ');
      if (n.nodeType !== 1) return '';
      const t = n.tagName;
      if (/^(SCRIPT|STYLE|BUTTON|SVG|NOSCRIPT|IMG|PICTURE)$/.test(t)) return '';
      if (t === 'BR') return '\n';
      if (t === 'STRONG' || t === 'B') { const s = inline(n).trim(); return s ? '**' + s + '**' : ''; }
      if (t === 'EM' || t === 'I') { const s = inline(n).trim(); return s ? '*' + s + '*' : ''; }
      if (t === 'CODE') return n.closest('pre') ? n.textContent : '`' + n.textContent + '`';
      if (/^H[1-6]$/.test(t)) return block('#'.repeat(+t[1]) + ' ' + inline(n).trim());
      if (t === 'P') return block(inline(n));
      if (t === 'UL' || t === 'OL') return list(n);
      if (t === 'TABLE') return table(n);
      if (t === 'HR') return '\n\n---\n\n';
      if (t === 'BLOCKQUOTE') return block(inline(n).trim().split('\n').map(l => '> ' + l).join('\n'));
      if (t === 'PRE') {
        const code = n.querySelector('code'), lang = ((code && code.className.match(/language-([\w+#-]+)/)) || [])[1] || '';
        return '\n\n```' + lang + '\n' + (code || n).textContent.replace(/\n+$/, '') + '\n```\n\n';
      }
      return /^(DIV|SECTION|ARTICLE|LI)$/.test(t) ? '\n' + inline(n) + '\n' : inline(n);
    }
    return inline(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function parseDom(html) {
    if (typeof DOMParser === 'undefined') throw fail('parse');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const els = Array.from(doc.querySelectorAll('[data-message-author-role]')).filter(e => /^(user|assistant)$/.test(e.getAttribute('data-message-author-role')));
    const turns = [];
    for (const e of els) {
      const role = e.getAttribute('data-message-author-role');
      const body = role === 'user' ? (e.querySelector('.whitespace-pre-wrap') || e).textContent : domToMarkdown(e.querySelector('.markdown') || e);
      const text = clean(body).trim();
      if (text) turns.push({ role, text });
    }
    if (!turns.length) throw fail('parse');
    const t = (doc.title || '').trim();
    return { title: /^chatgpt$/i.test(t) ? '' : t, turns };
  }
  function parseAny(html) {
    try { return parseHtml(html); } catch (e) { return parseDom(html); }
  }
  function parseJson(data) {
    const conv = findConversation(data);
    if (!conv) throw fail('parse');
    return result(conv);
  }
  const toText = turns => turns.map(t => (t.role === 'user' ? 'User' : 'ChatGPT') + ':\n' + t.text).join('\n\n');

  /* ---------- server side: fetch the share page (Node 18+) ---------- */
  async function fetchFromChatGPT(id) {
    let r;
    try { r = await fetch('https://chatgpt.com/share/' + id, { headers: HEADERS, redirect: 'follow' }); }
    catch (e) { throw fail('failed'); }
    if (r.status === 404) throw fail('not_found');
    let page = '';
    if (r.ok) { page = await r.text(); try { return parseHtml(page); } catch (e) { /* try the JSON endpoint below */ } }
    try {
      const j = await fetch('https://chatgpt.com/backend-api/share/' + id, { headers: Object.assign({}, HEADERS, { accept: 'application/json' }) });
      if (j.status === 404) throw fail('not_found');
      if (j.ok) return parseJson(await j.json());
    } catch (e) { if (e.code === 'not_found') throw e; }
    throw fail(r.ok && hasChatMarkers(page) && !looksBlocked(page) ? 'parse' : 'blocked');
  }
  async function handle(id) {
    if (!ID_RE.test(id)) return { status: 400, body: { error: 'bad_link' } };
    try {
      const r = await fetchFromChatGPT(id);
      return { status: 200, body: { title: r.title, turns: r.turns, text: toText(r.turns) } };
    } catch (e) {
      const code = e.code || 'failed';
      return { status: code === 'not_found' ? 404 : 502, body: { error: code } };
    }
  }

  return { ID_RE, parseHtml, parseDom, parseAny, parseJson, toText, looksBlocked, hasChatMarkers, fetchFromChatGPT, handle };
});
