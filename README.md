# Will You? 💖
Playful "will you be mine / go on a date / custom question" pages. Access is approved by you; answers are private.

## Run locally
```bash
npm install
copy .env.example .env     # (macOS/Linux: cp)  then set ADMIN_PASSWORD and ADMIN_PHONE
npm run dev
```
Open http://localhost:3000 — admin panel at http://localhost:3000/#admin
With TURSO_* blank, data is stored in `data/app.db`.

## Deploy on Vercel (free) with Turso
1. Create a free database at turso.tech; copy its URL (libsql://...) and create an auth token.
2. Push this repo to GitHub and import it in Vercel (Framework preset: Other, no build command).
3. Vercel -> Settings -> Environment Variables: ADMIN_PASSWORD, SESSION_SECRET, ADMIN_PHONE, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.
4. Redeploy. Tables are created automatically on first request.
