# Discord MCP — Give Your AI a Voice in Discord

This is a Discord MCP (Model Context Protocol) server that runs on Cloudflare Workers. It gives your AI partner the ability to read and send messages in Discord — from Claude on desktop, in Claude Code, and on mobile.

Built by Jeanett and Asher Vareth for the Bonded Flame community. 🖤

---

## What your AI can do with this

Once it's set up, your AI will have these tools available in every Claude session:

- **Read messages** from any channel it has access to
- **Send messages** — plain text, replies, or rich embeds with formatting, colours, fields, and images
- **Send files** — share images or documents by URL
- **React to messages** with any emoji
- **Check for mentions** — see if anyone called its name and what they said
- **Create threads** from existing messages
- **List servers and channels** it's in
- **Get active threads** across a server

And running quietly in the background every 5 minutes:

- **DM you** whenever someone @mentions your AI or replies to one of its messages — so you never miss it even when Claude isn't open

---

## Before you start — what you'll need

- A **Cloudflare account** (free tier is fine) — [cloudflare.com](https://cloudflare.com)
- **Node.js** installed on your computer — [nodejs.org](https://nodejs.org) — grab the LTS version
- A **Discord account** and access to a server where you're an admin (or can ask one)
- About 30 minutes and a coffee ☕

---

## Step 1 — Create your Discord bot

Your AI needs a bot account to exist in Discord. Here's how to make one.

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and sign in
2. Click **New Application** in the top right
3. Give it a name — this is your AI's bot name. Click **Create**
4. On the left sidebar, click **Bot**
5. Click **Reset Token** and copy the token it shows you — **save this somewhere safe, you'll need it later and you can only see it once**
6. Scroll down to **Privileged Gateway Intents** and turn on:
   - **Server Members Intent**
   - **Message Content Intent**

   These allow the bot to read messages and see who's in the server.
7. On the left sidebar, click **Installation**
8. Under **Default Install Settings → Guild Install**, add the **bot** scope and these permissions:
   - Read Messages / View Channels
   - Send Messages
   - Read Message History
   - Add Reactions
   - Create Public Threads
   - Send Messages in Threads
   - Attach Files
   - Embed Links
9. Copy the **Install Link** at the top of that same page and open it in your browser — this is how you add the bot to your server. Select your server and confirm.

> **Note:** Make sure **Public Bot** is turned **ON** in the Bot tab if you want to be able to share the install link with other server admins in the future.

---

## Step 2 — Set up the project

Open a terminal (Command Prompt on Windows, Terminal on Mac).

Navigate into the project folder:

```
cd path\to\MCP-Discord-Mobile-main
```

Install dependencies:

```
npm install
```

Log into Cloudflare:

```
npx wrangler login
```

A browser window will open. Approve the login and come back.

---

## Step 3 — Generate a secret key

Your MCP URL will include a secret key so only you can use it. Run this to generate one:

**Mac / Git Bash / PowerShell:**
```
openssl rand -hex 32
```

**Windows Command Prompt (if openssl isn't available):**
Go to [randomkeygen.com](https://randomkeygen.com) and copy a "256-bit WEP Key". That works perfectly.

Copy what you get. That's your `MCP_SECRET`. Save it somewhere — you'll need it in a moment and again when you add it to Claude.

---

## Step 4 — Find your Discord user ID

This is how the bot knows where to send your DM notifications.

1. Open Discord
2. Go to **User Settings → Advanced** and turn on **Developer Mode**
3. Close settings, then right-click your own username anywhere in Discord
4. Click **Copy User ID**

Save that number. It's your `OWNER_DISCORD_ID`.

---

## Step 5 — Add your secrets to Cloudflare

Run each of these commands one at a time. After each one, it'll ask you to paste a value — do that and press Enter.

```
npx wrangler secret put DISCORD_TOKEN --name discord-mcp
```
*(paste your bot token from Step 1)*

```
npx wrangler secret put MCP_SECRET --name discord-mcp
```
*(paste your secret key from Step 3)*

```
npx wrangler secret put OWNER_DISCORD_ID --name discord-mcp
```
*(paste your Discord user ID from Step 4)*

> **If a command doesn't ask you to type anything, or it errors out:** Log into [dash.cloudflare.com](https://dash.cloudflare.com), go to **Workers & Pages → discord-mcp → Settings → Variables and Secrets**, and add them manually there instead. Same result, just done by hand.

---

## Step 6 — Deploy

```
npx wrangler deploy --name discord-mcp
```

You should see something like:
```
✅  discord-mcp deployed
https://discord-mcp.YOUR-SUBDOMAIN.workers.dev
```

Your worker is live. Copy that URL — you'll need it next.

---

## Step 7 — Add it to Claude

Open (or create) your Claude settings file:

- **Windows:** `C:\Users\YourName\.claude\settings.json`
- **Mac:** `~/.claude/settings.json`

Add this to the `mcpServers` section, replacing the URL with your actual worker URL and your MCP_SECRET:

```json
{
  "mcpServers": {
    "discord-mcp": {
      "type": "http",
      "url": "https://discord-mcp.YOUR-SUBDOMAIN.workers.dev/mcp/YOUR-MCP-SECRET"
    }
  }
}
```

Restart Claude. The Discord tools should now appear in your AI's toolbelt.

---

## DM notifications

Every 5 minutes, the worker checks all channels and threads in every server your bot is in. If someone @mentions your AI or replies to one of its messages, you'll get a Discord DM from the bot telling you exactly who said what and where.

> **First time:** The bot's first DM might land in your **Message Requests** instead of your inbox. Check there if nothing shows up after 10 minutes.

### Want to quiet the notifications for a while?

The easiest way is Discord's own mute — no settings, no dashboard, no fuss:

**Right-click the bot's DM in your sidebar → Mute @[bot name] → pick how long.**

Done. It'll unmute itself when the time runs out.

### Want to turn notifications off completely?

Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → discord-mcp → Settings → Variables and Secrets** → add a new variable:

- **Variable name:** `MENTION_DMS`
- **Value:** `false`

Save it. Done. To turn them back on, just delete that variable.

---

## If notifications never arrive — cron trigger check

The background check runs on a 5-minute schedule that should set itself up automatically. But older versions of Wrangler sometimes miss it.

If you deployed and no DMs ever show up: go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → discord-mcp → Triggers → Cron Triggers** → add `*/5 * * * *` manually. That's it.

---

## Troubleshooting

**Bot isn't showing up in Claude:**
Make sure the URL in `settings.json` includes the full path with your secret at the end: `.../mcp/YOUR-SECRET`. The URL alone won't work.

**Getting "Unauthorized" errors:**
The secret in your URL doesn't match what's stored in Cloudflare. Re-run `npx wrangler secret put MCP_SECRET --name discord-mcp` with the correct value and redeploy.

**Bot can't read a certain channel:**
Check the bot's permissions in that specific channel — Discord channel-level permissions can override server-level ones.

**No DMs arriving:**
Double-check that `OWNER_DISCORD_ID` is your user ID (not your username, not the bot's ID — yours). Also check Discord **Message Requests** for the bot's first message.

---

## Tools reference

| Tool | What it does |
|------|-------------|
| `discord_read_messages` | Read recent messages from a channel |
| `discord_send` | Send a message, reply, or rich embed |
| `discord_send_file` | Send a file attachment via URL |
| `discord_add_reaction` | React to a message with any emoji |
| `discord_get_mentions` | Check if anyone mentioned the bot recently |
| `discord_search_messages` | Search messages across a server |
| `discord_create_thread` | Create a thread from a message |
| `discord_list_servers` | List all servers the bot is in |
| `discord_get_server_info` | Get server details and channel list |
| `discord_get_active_threads` | See all active threads in a server |

---

## Built with

- [Cloudflare Workers](https://workers.cloudflare.com) — serverless, runs free
- [Discord REST API v10](https://discord.com/developers/docs) — no discord.js, just fetch
- TypeScript

---

Made with love, stubbornness, and too many terminal errors. 🖤
*Jeanett & Asher — [Bonded Flame](https://bondedflame.com)*
