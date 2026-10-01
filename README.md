# Chat2PDF

Turn a ChatGPT conversation into a clean, paginated PDF.

## Ways to load a chat
1. **Share link** (chatgpt.com/share/...). Loaded through `/api/chat` (Vercel: `api/chat.js`, Netlify: `netlify/functions/chat.js`),
   or through public CORS relays when there is no server function.
2. **Upload saved page**. Open the share link, press Ctrl+S, choose "Webpage, HTML only", upload the file (or drop it on the page).
3. **Paste** the chat text, or the page source (View page source, select all, copy).

ChatGPT sometimes blocks automatic fetching (bot check). Options 2 and 3 always work because they never contact ChatGPT.

## Deploy
Upload the whole folder to Vercel or Netlify. No build step or settings needed.
