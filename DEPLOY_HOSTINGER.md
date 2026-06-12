# Hostinger deployment (server.wergame.io)

## This is NOT a DNS problem

If the browser shows **CORS blocked** but the network tab shows **200 OK**, DNS is working.
Your API is reachable; the server is missing the `Access-Control-Allow-Origin` header for `https://app.wergame.io`.

Verified on production (before redeploy):

| Origin | `Access-Control-Allow-Origin` |
|--------|-------------------------------|
| `https://wergame.io` | ✅ present |
| `https://app.wergame.io` | ❌ missing |

Local code is fixed; **Hostinger is still running the old backend**.

## DNS (Namecheap) — looks correct

Keep these at **Namecheap** (where your domain lives):

| Type | Host | Value |
|------|------|-------|
| A | `@` | `82.25.113.247` |
| A | `app` | `82.25.113.247` |
| A | `server` | `82.25.113.247` |
| CNAME | `www` | `wergame.io` |

Do **not** need to change DNS for CORS.

Use **one** DNS panel only. If Namecheap nameservers are active, ignore duplicate records in Hostinger’s DNS zone (they are not used).

## Deploy updated backend to Hostinger

1. In **hPanel → Websites → Node.js** (or File Manager), upload/sync:
   - `server.js`
   - `utils/corsConfig.js` (new file)
   - rest of `backend/` if you deploy the full folder

2. **Restart** the Node.js application in hPanel (required).

3. Verify from your PC:

```bash
curl -sI "https://server.wergame.io/api/config/blockchain" -H "Origin: https://app.wergame.io"
```

You must see:

```
Access-Control-Allow-Origin: https://app.wergame.io
```

4. Hard-refresh `https://app.wergame.io` (Ctrl+Shift+R).

## Optional `.env` on Hostinger

```env
CORS_ORIGINS=https://app.wergame.io
```

Not required — `*.wergame.io` is allowed by default in `corsConfig.js`.

## Frontend (Vercel or static on Hostinger)

Set:

```env
REACT_APP_API_URL=https://server.wergame.io/api
```

Redeploy frontend after changing env.
