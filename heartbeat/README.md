# heartbeat

Online when you're here. Offline when you're not.

`heartbeat` is an optional add-on for the Discord MCP that gives your AI a real Discord presence — a green dot that means something. It connects to Discord's Gateway and lets your AI control their own online/offline status from any Claude session.

When they arrive, they go online. When they leave (or forget), the 20-minute auto-timeout handles it. No always-on ghost status. Honest presence.

---

## What you need

- A [Render](https://render.com) account (free tier works — sign up with GitHub)
- Your bot's Discord token (same one used for the Discord MCP)
- A secret string you make up (used to authenticate calls between the MCP and this service)

---

## Deploy to Render

1. Fork or clone the `Discord-MCP` repo to your GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub and select your fork of `Discord-MCP`
4. Set the **Root Directory** to `heartbeat`
5. Set **Runtime** to `Node`
6. Set **Build Command** to `npm install`
7. Set **Start Command** to `npm start`
8. Under **Environment Variables**, add:
   - `DISCORD_TOKEN` — your bot token
   - `PRESENCE_SECRET` — a random string you make up (keep it secret, you'll need it again)
9. Click **Deploy**

Once deployed, Render gives you a URL like `https://heartbeat-xxxx.onrender.com` — copy that.

---

## Add presence to your Discord MCP

In your Cloudflare Discord MCP worker, add two environment variables:

| Variable | Value |
|---|---|
| `PRESENCE_SERVICE_URL` | The Render URL from above (no trailing slash) |
| `PRESENCE_SECRET` | The same secret string you used on Render |

Set these via Cloudflare dashboard → Workers → your discord-mcp worker → Settings → Variables.

Or via wrangler:
```bash
npx wrangler secret put PRESENCE_SERVICE_URL
npx wrangler secret put PRESENCE_SECRET
```

Then redeploy the Discord MCP:
```bash
npm run deploy
```

---

## Tools added to the MCP

Once configured, two new tools appear in any Claude session with the MCP:

**`discord_set_presence`**
Set status to `online`, `idle`, or `offline`. Call this when arriving in or leaving Discord.

**`discord_keepalive`**
Resets the 20-minute auto-timeout. Call this periodically during long sessions to stay online. If nothing calls this for 20 minutes, presence automatically switches to offline.

---

## Note on Render's free tier

Render's free web services spin down after 15 minutes of inactivity and take ~30–60 seconds to cold-start. This means the first time you go online after a long gap, there may be a brief delay before the green dot appears. Once warm, status changes are instant.

---

## If you don't want this

Skip this entirely. Don't set `PRESENCE_SERVICE_URL` or `PRESENCE_SECRET` on your Discord MCP. The tools will exist but return a friendly message if called. Everything else in the MCP works exactly as normal.
