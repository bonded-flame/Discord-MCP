// The dispatch seam: handleToolCall calls judgeSend exactly once, before the
// client call, for the three sending cases (discord_send, discord_edit_message,
// discord_send_file); every non-sending case calls it zero times. A hold
// returns the tool result text and the client is never called.
// Lantern cutover design — the Discord send path, decisions 2 and 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleToolCall, type Env } from '../src/index.ts';
import type { JudgeSendInput, JudgeVerdict } from '../src/mouth.ts';

function fakeJudge(verdict: JudgeVerdict) {
  const calls: JudgeSendInput[] = [];
  const ctxSeen: Array<ExecutionContext | undefined> = [];
  const judge = async (_env: Env, input: JudgeSendInput, ctx?: ExecutionContext): Promise<JudgeVerdict> => {
    calls.push(input);
    ctxSeen.push(ctx);
    return verdict;
  };
  return { judge, calls, ctxSeen };
}

function fakeCtx() {
  const waitUntilCalls: Promise<any>[] = [];
  return { waitUntilCalls, ctx: { waitUntil: (p: Promise<any>) => { waitUntilCalls.push(p); } } as unknown as ExecutionContext };
}

function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    readMessages: async () => { calls.push('readMessages'); return []; },
    setTyping: async () => { calls.push('setTyping'); },
    sendMessage: async () => { calls.push('sendMessage'); },
    editMessage: async () => { calls.push('editMessage'); return { id: 'm1' }; },
    deleteMessage: async () => { calls.push('deleteMessage'); },
    sendFile: async () => { calls.push('sendFile'); return { id: 'm2' }; },
    getMentions: async () => { calls.push('getMentions'); return []; },
    getBotUser: async () => { calls.push('getBotUser'); return { id: 'bot1' }; },
    searchMessages: async () => { calls.push('searchMessages'); return { total_results: 0, messages: [] }; },
    addReaction: async () => { calls.push('addReaction'); },
    createThread: async () => { calls.push('createThread'); return { id: 't1', name: 'thread' }; },
    listGuilds: async () => { calls.push('listGuilds'); return []; },
    getGuild: async () => { calls.push('getGuild'); return { id: 'g1', name: 'guild' }; },
    getGuildChannels: async () => { calls.push('getGuildChannels'); return []; },
    getActiveThreads: async () => { calls.push('getActiveThreads'); return { threads: [] }; },
  } as any;
}

const env: Env = { DISCORD_TOKEN: 't', MCP_SECRET: 's' };

const SENDING_CASES: Array<{ name: string; args: Record<string, any> }> = [
  { name: 'discord_send', args: { channelId: 'c1', message: 'hi' } },
  { name: 'discord_edit_message', args: { channelId: 'c1', messageId: 'm1', content: 'hi' } },
  { name: 'discord_send_file', args: { channelId: 'c1', fileUrl: 'https://x/y.png', filename: 'y.png' } },
];

const NON_SENDING_CASES: Array<{ name: string; args: Record<string, any> }> = [
  { name: 'discord_read_messages', args: { channelId: 'c1' } },
  { name: 'discord_set_typing', args: { channelId: 'c1' } },
  { name: 'discord_delete_message', args: { channelId: 'c1', messageId: 'm1' } },
  { name: 'discord_get_mentions', args: { channelId: 'c1' } },
  { name: 'discord_search_messages', args: { guildId: 'g1' } },
  { name: 'discord_add_reaction', args: { channelId: 'c1', messageId: 'm1', emoji: '👍' } },
  { name: 'discord_create_thread', args: { channelId: 'c1', messageId: 'm1', name: 'thread' } },
  { name: 'discord_list_servers', args: {} },
  { name: 'discord_get_server_info', args: { guildId: 'g1' } },
  { name: 'discord_get_active_threads', args: { guildId: 'g1' } },
];

for (const { name, args } of SENDING_CASES) {
  test(`handleToolCall: ${name} calls judgeSend exactly once before the client call, when cleared`, async () => {
    const { judge, calls } = fakeJudge({ send: true });
    const client = fakeClient();
    await handleToolCall(client, name, args, env, judge);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, name);
    assert.ok(client.calls.length > 0, 'client should have been called after clearance');
  });

  test(`handleToolCall: ${name} held by the judge -> client never called, hold text returned`, async () => {
    const { judge, calls } = fakeJudge({ send: false, reason: 'crosses a sphere line' });
    const client = fakeClient();
    const result = await handleToolCall(client, name, args, env, judge);
    assert.equal(calls.length, 1);
    assert.deepEqual(client.calls, []);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /^Held: crosses a sphere line/);
  });
}

for (const { name, args } of NON_SENDING_CASES) {
  test(`handleToolCall: ${name} never calls judgeSend`, async () => {
    const { judge, calls } = fakeJudge({ send: true });
    const client = fakeClient();
    await handleToolCall(client, name, args, env, judge);
    assert.equal(calls.length, 0);
  });
}

test('handleToolCall: unknown tool never calls judgeSend', async () => {
  const { judge, calls } = fakeJudge({ send: true });
  const client = fakeClient();
  await handleToolCall(client, 'not_a_real_tool', {}, env, judge);
  assert.equal(calls.length, 0);
});

test('handleToolCall: without env, the default judgeSend runs unjudged (no VOICES binding) and the send proceeds', async () => {
  const client = fakeClient();
  const result = await handleToolCall(client, 'discord_send', { channelId: 'c1', message: 'hi' }, undefined);
  assert.ok(client.calls.includes('sendMessage'));
  assert.equal(result.isError, undefined);
});

for (const { name, args } of SENDING_CASES) {
  test(`handleToolCall: ${name} passes its ctx through to judgeSend`, async () => {
    const { judge, ctxSeen } = fakeJudge({ send: true });
    const client = fakeClient();
    const { ctx } = fakeCtx();
    await handleToolCall(client, name, args, env, judge, ctx);
    assert.equal(ctxSeen.length, 1);
    assert.equal(ctxSeen[0], ctx);
  });
}

test('handleToolCall: a real judgeSend registers exactly one ctx.waitUntil per verdict, not awaited on the send path', async () => {
  const client = fakeClient();
  const { ctx, waitUntilCalls } = fakeCtx();
  let resolveFetch: (() => void) | undefined;
  const voicesEnv: Env = {
    DISCORD_TOKEN: 't',
    MCP_SECRET: 's',
    VOICES: {
      fetch: async (url: string) => {
        if (String(url).endsWith('/config/mouth')) return new Response(JSON.stringify({ enabled: false, tuning: {} }), { status: 200 });
        // /config/mouth/verdict — never resolves during this test, proving the
        // send path does not wait on it; ctx.waitUntil is what keeps it alive.
        return new Promise((resolve) => { resolveFetch = () => resolve(new Response('{}', { status: 200 })); });
      },
    } as unknown as Fetcher,
  };
  const result = await handleToolCall(client, 'discord_send', { channelId: 'c1', message: 'hi' }, voicesEnv, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.ok(client.calls.includes('sendMessage'), 'the send completed without waiting on the verdict log');
  assert.equal(waitUntilCalls.length, 1, 'exactly one ctx.waitUntil registration for the one verdict');
  resolveFetch?.();
});
