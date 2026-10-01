// Vercel function: GET /api/chat?id=<share id>
const { handle } = require('../share-parser.js');
module.exports = async (req, res) => {
  const out = await handle(String((req.query && req.query.id) || ''));
  if (out.status === 200) res.setHeader('Cache-Control', 's-maxage=300');
  res.status(out.status).json(out.body);
};
