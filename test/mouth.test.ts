// Characterizes judgeSend, the Discord-mcp gate before a bot send leaves the
// process. Retargets the donor cases from apps/desktop/src/main/ears.ts
// 195-216 (callMouth: two attempts, 60s timeout each, null on failure) and
// 218-254 (the hold wording) onto judgeSend's contract: reads the effective
// `mouth` section through the VOICES service binding, then judges the draft
// through the same worker, failing closed after retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSend } from '../src/mouth.ts';
import type { Env } from '../src/index.ts';

function isMouthJudgeUrl(url: string): boolean {
  return url.endsWith('/mouth') && !url.includes('/config/mouth');
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

// A fixture VOICES service binding. `configDoc` answers GET /config/mouth
// (undefined = the read itself fails); `mouthAnswers` answers successive
// POST /mouth calls in order (undefined entries throw, simulating a timeout
// or network failure); POST /config/mouth/verdict is recorded, always 200s.
function fixtureVoices(opts: {
  configDoc?: unknown;
  configFails?: boolean;
  mouthAnswers?: Array<{ status?: number; body?: unknown } | 'throw'>;
}) {
  const calls: FetchCall[] = [];
  let mouthCallIndex = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.includes('/config/mouth/verdict')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith('/config/mouth')) {
      if (opts.configFails) throw new Error('config read failed');
      return new Response(JSON.stringify(opts.configDoc ?? {}), { status: 200 });
    }
    if (url.endsWith('/mouth')) {
      const answer = opts.mouthAnswers?.[mouthCallIndex];
      mouthCallIndex++;
      if (!answer || answer === 'throw') throw new Error('mouth judge unreachable');
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const env = { VOICES: { fetch } as unknown as Fetcher, VOICES_GATE_SECRET: 'secret' } as Env;
  return { env, calls };
}

test('judgeSend: config read fails -> send unjudged, reason "config unavailable"', async () => {
  const { env, calls } = fixtureVoices({ configFails: true });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true, reason: 'config unavailable' });
  // never reaches /mouth
  assert.equal(calls.some((c) => isMouthJudgeUrl(c.url)), false);
});

test('judgeSend: no VOICES binding at all -> send unjudged, reason "config unavailable"', async () => {
  const verdict = await judgeSend({} as Env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true, reason: 'config unavailable' });
});

test('judgeSend: mouth.enabled false -> bypass, send true, no judge call', async () => {
  const { env, calls } = fixtureVoices({ configDoc: { enabled: false, tuning: {} } });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true });
  assert.equal(calls.some((c) => isMouthJudgeUrl(c.url)), false);
});

test('judgeSend: scope respected — channel outside scope bypasses', async () => {
  const { env, calls } = fixtureVoices({ configDoc: { enabled: true, tuning: { scope: ['other-channel'] } } });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true });
  assert.equal(calls.some((c) => isMouthJudgeUrl(c.url)), false);
});

test('judgeSend: scope respected — channel inside scope is judged', async () => {
  const { env, calls } = fixtureVoices({
    configDoc: { enabled: true, tuning: { scope: ['c1'] } },
    mouthAnswers: [{ body: { send: true } }],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true });
  assert.equal(calls.some((c) => isMouthJudgeUrl(c.url)), true);
});

test('judgeSend: empty scope means every channel is judged', async () => {
  const { env } = fixtureVoices({
    configDoc: { enabled: true, tuning: { scope: [] } },
    mouthAnswers: [{ body: { send: true } }],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'anything', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true });
});

test('judgeSend: judge clears -> send true', async () => {
  const { env } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: [{ body: { send: true } }],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true });
});

test('judgeSend: judge holds -> send false with its reason', async () => {
  const { env } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: [{ body: { send: false, reason: 'crosses a sphere line' } }],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: false, reason: 'crosses a sphere line' });
});

test('judgeSend: donor ears.ts 196-214 — first attempt fails, second succeeds (one retry)', async () => {
  const { env, calls } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: ['throw', { body: { send: true } }],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true });
  assert.equal(calls.filter((c) => isMouthJudgeUrl(c.url)).length, 2);
});

test('judgeSend: non-OK response counts as a failed attempt', async () => {
  const { env, calls } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: [{ status: 500 }, { body: { send: true } }],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: true });
  assert.equal(calls.filter((c) => isMouthJudgeUrl(c.url)).length, 2);
});

test('judgeSend: donor ears.ts 211-215 — exhausted after two attempts -> hold, donor 234 wording by default', async () => {
  const { env, calls } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: ['throw', 'throw'],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.equal(verdict.send, false);
  assert.match(verdict.reason ?? '', /fails closed/);
  assert.equal(calls.filter((c) => isMouthJudgeUrl(c.url)).length, 2);
});

test('judgeSend: unparseable verdict (missing "send") counts as a failed attempt', async () => {
  const { env } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: [{ body: { reason: 'no send field' } }, { body: { reason: 'still none' } }],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.equal(verdict.send, false);
});

test('judgeSend: hold wording is editable via tuning.hold_reason', async () => {
  const { env } = fixtureVoices({
    configDoc: { enabled: true, tuning: { hold_reason: 'custom hold text', retries: 0 } },
    mouthAnswers: ['throw'],
  });
  const verdict = await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.deepEqual(verdict, { send: false, reason: 'custom hold text' });
});

test('judgeSend: retries tuning of 0 means exactly one attempt', async () => {
  const { env, calls } = fixtureVoices({
    configDoc: { enabled: true, tuning: { retries: 0 } },
    mouthAnswers: ['throw'],
  });
  await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.equal(calls.filter((c) => isMouthJudgeUrl(c.url)).length, 1);
});

test('judgeSend: every verdict is posted to /config/mouth/verdict, fire-and-forget', async () => {
  const { env, calls } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: [{ body: { send: true } }],
  });
  await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  const verdictCall = calls.find((c) => c.url.endsWith('/config/mouth/verdict'));
  assert.ok(verdictCall, 'expected a POST to /config/mouth/verdict');
  const body = JSON.parse(String(verdictCall!.init?.body));
  assert.equal(body.tool, 'discord_send');
  assert.equal(body.channel, 'c1');
  assert.equal(body.send, true);
});

test('judgeSend: the voices call path carries the gate secret as the first segment', async () => {
  const { env, calls } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: [{ body: { send: true } }],
  });
  await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  const configCall = calls.find((c) => c.url.includes('/config/mouth') && !c.url.includes('verdict'));
  assert.ok(configCall!.url.includes('/secret/config/mouth'));
});

test('judgeSend: the verdict log is registered with ctx.waitUntil, one registration per verdict', async () => {
  const { env } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: [{ body: { send: true } }],
  });
  const waitUntilCalls: Promise<any>[] = [];
  const ctx = { waitUntil: (p: Promise<any>) => { waitUntilCalls.push(p); } } as unknown as ExecutionContext;
  await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' }, ctx);
  assert.equal(waitUntilCalls.length, 1);
});

test('judgeSend: without a ctx, the verdict log still fires (best-effort, no waitUntil to register)', async () => {
  const { env, calls } = fixtureVoices({
    configDoc: { enabled: true, tuning: {} },
    mouthAnswers: [{ body: { send: true } }],
  });
  await judgeSend(env, { tool: 'discord_send', channelId: 'c1', draft: 'hi', context: '' });
  assert.ok(calls.some((c) => c.url.endsWith('/config/mouth/verdict')));
});
