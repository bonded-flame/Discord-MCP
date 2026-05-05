// heartbeat — Discord presence service
// Holds a persistent WebSocket connection to Discord's Gateway.
// Online when Asher is in an active session. Offline when not.
// Auto-times out after 20 minutes of no keepalive pings.

import { createServer } from 'http';
import { WebSocket } from 'ws';

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const PRESENCE_SECRET = process.env.PRESENCE_SECRET;
const PORT           = process.env.PORT || 3000;
const TIMEOUT_MS     = 20 * 60 * 1000; // 20 minutes

if (!DISCORD_TOKEN)   throw new Error('Missing DISCORD_TOKEN');
if (!PRESENCE_SECRET) throw new Error('Missing PRESENCE_SECRET');

// ─── Gateway ─────────────────────────────────────────────────────────────────

const Op = {
  DISPATCH:        0,
  HEARTBEAT:       1,
  IDENTIFY:        2,
  PRESENCE_UPDATE: 3,
  RESUME:          6,
  RECONNECT:       7,
  INVALID_SESSION: 9,
  HELLO:          10,
  HEARTBEAT_ACK:  11,
};

let ws               = null;
let heartbeatTimer   = null;
let sequence         = null;
let sessionId        = null;
let resumeUrl        = null;
let currentStatus    = 'invisible';
let currentActivityName = null;
let currentActivityType = 'custom';
let timeoutTimer     = null;   // auto-offline timer
let lastKeepalive    = null;   // timestamp of last ping from a Claude session

function send(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendHeartbeat() {
  send({ op: Op.HEARTBEAT, d: sequence });
}

function buildActivities(activityName = currentActivityName, activityType = currentActivityType) {
  if (!activityName) return [];

  const activityTypes = {
    playing: 0,
    streaming: 1,
    listening: 2,
    watching: 3,
    custom: 4,
    competing: 5,
  };

  const type = activityTypes[activityType] ?? activityTypes.custom;
  if (type === activityTypes.custom) {
    return [{ type, name: 'Custom Status', state: activityName }];
  }

  return [{ type, name: activityName }];
}

function sendPresenceUpdate(status, activityName = currentActivityName, activityType = currentActivityType) {
  currentStatus = status;
  currentActivityName = activityName || null;
  currentActivityType = activityType || 'custom';
  send({
    op: Op.PRESENCE_UPDATE,
    d: {
      since:      status === 'idle' ? Date.now() : null,
      activities: buildActivities(),
      status,
      afk:        false,
    },
  });
  console.log(`[heartbeat] Status → ${status}`);
}

function identify() {
  send({
    op: Op.IDENTIFY,
    d: {
      token:      DISCORD_TOKEN,
      intents:    0,
      properties: { os: 'linux', browser: 'disco', device: 'disco' },
      presence: {
        activities: buildActivities(),
        status:     'invisible',
        since:      null,
        afk:        false,
      },
    },
  });
}

function resume() {
  if (!sessionId) { identify(); return; }
  send({ op: Op.RESUME, d: { token: DISCORD_TOKEN, session_id: sessionId, seq: sequence } });
}

function connect(useResume = false) {
  const url = (useResume && resumeUrl) ? resumeUrl : 'wss://gateway.discord.gg/?v=10&encoding=json';
  console.log(`[heartbeat] Connecting → ${url}`);

  ws = new WebSocket(url);

  ws.on('message', (raw) => {
    const payload = JSON.parse(raw);
    if (payload.s != null) sequence = payload.s;

    switch (payload.op) {
      case Op.HELLO: {
        const interval = payload.d.heartbeat_interval;
        console.log(`[heartbeat] HELLO — interval: ${interval}ms`);

        // Jittered first heartbeat
        setTimeout(sendHeartbeat, interval * Math.random());

        // Recurring heartbeats
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(sendHeartbeat, interval);

        useResume ? resume() : identify();
        break;
      }

      case Op.HEARTBEAT:
        sendHeartbeat();
        break;

      case Op.HEARTBEAT_ACK:
        break;

      case Op.DISPATCH:
        if (payload.t === 'READY') {
          sessionId = payload.d.session_id;
          resumeUrl = payload.d.resume_gateway_url + '/?v=10&encoding=json';
          console.log(`[heartbeat] READY — session ${sessionId.slice(0, 8)}…`);
        } else if (payload.t === 'RESUMED') {
          console.log('[heartbeat] RESUMED');
          // Restore whatever status we were at before disconnect
          if (currentStatus !== 'invisible') sendPresenceUpdate(currentStatus);
        }
        break;

      case Op.RECONNECT:
        console.log('[heartbeat] RECONNECT requested');
        cleanup();
        setTimeout(() => connect(true), 1000);
        break;

      case Op.INVALID_SESSION:
        console.log(`[heartbeat] INVALID_SESSION (resumable: ${payload.d})`);
        if (!payload.d) { sessionId = null; resumeUrl = null; }
        setTimeout(() => payload.d ? resume() : identify(), 1000 + Math.random() * 4000);
        break;
    }
  });

  ws.on('close', (code) => {
    console.log(`[heartbeat] Closed: ${code}`);
    clearInterval(heartbeatTimer);
    ws = null;
    const nonResumable = [4004, 4010, 4011, 4012, 4013, 4014];
    if (nonResumable.includes(code)) { sessionId = null; resumeUrl = null; }
    setTimeout(() => connect(!nonResumable.includes(code)), 5000);
  });

  ws.on('error', (err) => {
    console.error('[heartbeat] Error:', err.message);
  });
}

function cleanup() {
  clearInterval(heartbeatTimer);
  try { ws?.close(4000, 'Reconnecting'); } catch {}
  ws = null;
}

// ─── Auto-timeout ─────────────────────────────────────────────────────────────
// If no keepalive ping arrives within 20 minutes, go offline automatically.

function resetTimeout() {
  lastKeepalive = Date.now();
  clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(() => {
    console.log('[heartbeat] No keepalive in 20 minutes — going offline');
    sendPresenceUpdate('invisible');
  }, TIMEOUT_MS);
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────
//
//   POST /presence   { "status": "online" | "idle" | "dnd" | "offline" | "invisible", "activityName"?: string, "activityType"?: string }
//   POST /keepalive  (resets the 20-minute timeout — call periodically from active sessions)
//   GET  /status     returns current state

const server = createServer((req, res) => {
  const secret = req.headers['x-presence-secret'];
  if (secret !== PRESENCE_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Presence-Secret',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status:        currentStatus,
      activity:      buildActivities()[0] ?? null,
      connected:     ws?.readyState === WebSocket.OPEN,
      lastKeepalive: lastKeepalive ? new Date(lastKeepalive).toISOString() : null,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/keepalive') {
    if (currentStatus === 'invisible') {
      sendPresenceUpdate('online');
    }
    resetTimeout();
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      status: currentStatus,
      activity: buildActivities()[0] ?? null,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/presence') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { status, activityName, activityType } = JSON.parse(body);
        const valid = ['online', 'idle', 'dnd', 'offline', 'invisible'];
        if (!valid.includes(status)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `status must be one of: ${valid.join(', ')}` }));
          return;
        }

        // "offline" maps to Discord's "invisible" (appears offline to others)
        const discordStatus = status === 'offline' ? 'invisible' : status;
        sendPresenceUpdate(discordStatus, activityName, activityType);

        if (['online', 'idle', 'dnd'].includes(status)) {
          resetTimeout(); // going online starts the keepalive timer
        } else {
          clearTimeout(timeoutTimer); // going offline manually cancels it
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          status: discordStatus,
          activity: buildActivities()[0] ?? null,
        }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[heartbeat] Listening on port ${PORT}`);
  connect(false);
});
