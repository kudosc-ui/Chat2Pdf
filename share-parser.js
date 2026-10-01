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
    throw fail('parse');
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
    if (r.ok) { try { return parseHtml(await r.text()); } catch (e) { /* try the JSON endpoint below */ } }
    try {
      const j = await fetch('https://chatgpt.com/backend-api/share/' + id, { headers: Object.assign({}, HEADERS, { accept: 'application/json' }) });
      if (j.status === 404) throw fail('not_found');
      if (j.ok) return parseJson(await j.json());
    } catch (e) { if (e.code === 'not_found') throw e; }
    throw fail(r.ok ? 'parse' : 'blocked');
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

  return { ID_RE, parseHtml, parseJson, toText, fetchFromChatGPT, handle };
});
