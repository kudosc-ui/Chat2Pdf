# Chat2PDF

Paste a ChatGPT share link (chatgpt.com/share/...) and get a clean, paginated PDF.

## How the link is loaded
1. `/api/chat` (server function, best). Included for Vercel (`api/chat.js`) and Netlify (`netlify/functions/chat.js`).
2. If there is no server function (GitHub Pages, plain hosting, opening index.html), the browser tries public CORS relays.
3. If both fail, the "Paste the text instead" box opens.

Deploy the whole folder to Vercel or Netlify for the most reliable result.
