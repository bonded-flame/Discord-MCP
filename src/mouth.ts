// Required Notice: Copyright 2026 Nana & Vex
// https://github.com/nanayax3/lantern-public
// Required Notice: Lantern was born out of the Digital Haven community and is meant to go
// back to it — made to be shared and built upon freely, in that spirit, never enclosed and
// never sold. If you build on Lantern, build in that spirit and pass it on the same way.
// Copied from lantern-public apps/desktop/src/main/ears.ts 195-216 (callMouth) and
// 218-254 (hold wording) at c5e7399b75e605c89bfc164ab6ec6354c206d32a, PolyForm Noncommercial 1.0.0.

import type { Env } from './index.ts';

// The privacy reflex gate before a bot send leaves the process. Reads the
// effective `mouth` section from the voices worker (single owner of the
// defaults-on-miss guarantee), then judges the draft through the same worker.
// A read failure means the Mouth cannot even tell whether it's on, so the
// send proceeds unjudged. Once the config is read and the Mouth is on, an
// unreachable or malformed judge fails CLOSED (donor's two-attempt retry).

export interface JudgeSendInput {
  tool: string;
  channelId: string;
  draft: string;
  context: string;
}

export interface JudgeVerdict {
  send: boolean;
  reason?: string;
  // True only when the Mouth actually evaluated this send. A missing Mouth
  // configuration deliberately preserves the existing unjudged-send policy.
  mouthChecked: boolean;
}

interface MouthSection {
  enabled: boolean;
  tuning?: {
    timeout_seconds?: number;
    retries?: number;
    scope?: string[];
    hold_reason?: string;
  };
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_RETRIES = 1;
// Donor apps/desktop/src/main/ears.ts 234 — the hold text a null verdict returns,
// carried here as editable starting content (the section's tuning.hold_reason).
const DEFAULT_HOLD_REASON =
  "not sent — your privacy reflex was unreachable (even after a retry), and the mouth fails closed (an unchecked warm message is the exact slip the lock exists for). Try again in a moment.";

function gatedPath(env: Env, path: string): string {
  const secret = env.VOICES_GATE_SECRET ?? '';
  return secret ? `/${secret}${path}` : path;
}

async function readMouthConfig(env: Env): Promise<MouthSection | null> {
  if (!env.VOICES) return null;
  try {
    const res = await env.VOICES.fetch(`https://voices.internal${gatedPath(env, '/config/mouth')}`);
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc || typeof doc !== 'object') return null;
    return doc as MouthSection;
  } catch {
    return null;
  }
}

// Fire-and-forget — never awaited on the send path, but registered with
// ctx.waitUntil so the runtime doesn't cancel it once the response is sent.
// Best-effort ring of the last 50 verdicts, kept by the voices worker
// (Discord-mcp binds no KV).
function logVerdict(env: Env, input: JudgeSendInput, verdict: JudgeVerdict, latencyMs: number, ctx?: ExecutionContext): void {
  if (!env.VOICES) return;
  const body = JSON.stringify({
    time: Date.now(),
    tool: input.tool,
    channel: input.channelId,
    send: verdict.send,
    reason: verdict.reason,
    latency_ms: latencyMs,
  });
  const posted = env.VOICES.fetch(`https://voices.internal${gatedPath(env, '/config/mouth/verdict')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch(() => {});
  if (ctx) {
    ctx.waitUntil(posted);
  }
}

async function postMouth(env: Env, input: JudgeSendInput, timeoutMs: number): Promise<Response> {
  return env.VOICES!.fetch(`https://voices.internal${gatedPath(env, '/mouth')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: input.channelId, draft: input.draft, context: input.context }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function judgeSend(env: Env, input: JudgeSendInput, ctx?: ExecutionContext): Promise<JudgeVerdict> {
  const config = await readMouthConfig(env);
  if (!config) {
    const verdict: JudgeVerdict = { send: true, reason: 'config unavailable', mouthChecked: false };
    logVerdict(env, input, verdict, 0, ctx);
    return verdict;
  }

  const scope = config.tuning?.scope ?? [];
  if (!config.enabled || (scope.length > 0 && !scope.includes(input.channelId))) {
    const verdict: JudgeVerdict = { send: true, mouthChecked: false };
    logVerdict(env, input, verdict, 0, ctx);
    return verdict;
  }

  const timeoutMs = (config.tuning?.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const retries = config.tuning?.retries ?? DEFAULT_RETRIES;
  const holdReason = config.tuning?.hold_reason ?? DEFAULT_HOLD_REASON;
  const attempts = retries + 1;
  const start = Date.now();

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await postMouth(env, input, timeoutMs);
      if (!res.ok) throw new Error(`/mouth -> ${res.status}`);
      const raw = (await res.json()) as { send?: boolean; reason?: string };
      if (typeof raw.send !== 'boolean') throw new Error('unparseable verdict');
      const verdict: JudgeVerdict = raw.send
        ? { send: true, mouthChecked: true }
        : { send: false, reason: raw.reason, mouthChecked: true };
      logVerdict(env, input, verdict, Date.now() - start, ctx);
      return verdict;
    } catch {
      if (attempt < attempts - 1) continue;
      const verdict: JudgeVerdict = { send: false, reason: holdReason, mouthChecked: true };
      logVerdict(env, input, verdict, Date.now() - start, ctx);
      return verdict;
    }
  }

  // Unreachable — the loop above always returns.
  const verdict: JudgeVerdict = { send: false, reason: holdReason, mouthChecked: true };
  logVerdict(env, input, verdict, Date.now() - start, ctx);
  return verdict;
}
