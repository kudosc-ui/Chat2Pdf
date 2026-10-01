// Vercel serverless function: GET /api/chat?id=<share id>
// Loads a public ChatGPT share link and returns { title, text } in "User: / ChatGPT:" form.
export default async function handler(req, res) {
  const id = String(req.query.id || '');
  if (!/^[0-9a-f-]{20,64}$/i.test(id)) return res.status(400).json({ error: 'bad_link' });
  try {
    const r = await fetch(`https://chatgpt.com/backend-api/share/${id}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' }
    });
    if (r.status === 404) return res.status(404).json({ error: 'not_found' });
    if (!r.ok) return res.status(502).json({ error: 'blocked' });
    const d = await r.json();
    const map = d.mapping || {}, chain = [];
    for (let n = d.current_node; n && map[n]; n = map[n].parent) chain.unshift(map[n]);
    const turns = [];
    for (const { message: m } of chain) {
      const role = m && m.author && m.author.role;
      if (!m || !m.content || (role !== 'user' && role !== 'assistant')) continue;
      if (m.recipient && m.recipient !== 'all') continue;
      if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
      const text = (m.content.parts || []).filter(p => typeof p === 'string').join('\n').replace(/\ue200[^\ue201]*\ue201/g, '').trim();
      if (text) turns.push(`${role === 'user' ? 'User' : 'ChatGPT'}:\n${text}`);
    }
    if (!turns.length) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.status(200).json({ title: d.title || '', text: turns.join('\n\n') });
  } catch (e) {
    return res.status(502).json({ error: 'failed' });
  }
}
