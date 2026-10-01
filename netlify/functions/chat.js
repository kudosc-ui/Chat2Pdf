// Netlify function: GET /api/chat?id=<share id> (see netlify.toml)
const { handle } = require('../../share-parser.js');
exports.handler = async (event) => {
  const out = await handle(String((event.queryStringParameters || {}).id || ''));
  return { statusCode: out.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out.body) };
};
