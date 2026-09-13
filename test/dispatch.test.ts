// The dispatch seam: handleToolCall calls judgeSend exactly once, before the
// client call, for the three sending cases (discord_send, discord_edit_message,
// discord_send_file); every non-sending case calls it zero times. A hold
// returns the tool result text and the client is never called.
// Lantern cutover design — the Discord send path, decisions 2 and 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleToolCall, type Env } from '../src/index.ts';
import { DiscordClient } from '../src/discord.ts';
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
  const sentFiles: Array<[string, string, string, string | undefined, string | undefined]> = [];
  return {
    calls,
    sentFiles,
    readMessages: async () => { calls.push('readMessages'); return []; },
    setTyping: async () => { calls.push('setTyping'); },
    sendMessage: async () => { calls.push('sendMessage'); },
    editMessage: async () => { calls.push('editMessage'); return { id: 'm1' }; },
    deleteMessage: async () => { calls.push('deleteMessage'); },
    sendFile: async (channelId: string, fileUrl: string, filename: string, content?: string, replyToMessageId?: string) => {
      calls.push('sendFile');
      sentFiles.push([channelId, fileUrl, filename, content, replyToMessageId]);
      return { id: 'm2' };
    },
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
    const { judge, calls } = fakeJudge({ send: true, mouthChecked: true });
    const client = fakeClient();
    await handleToolCall(client, name, args, env, judge);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, name);
    assert.ok(client.calls.length > 0, 'client should have been called after clearance');
  });

  test(`handleToolCall: ${name} held by the judge -> client never called, hold text returned`, async () => {
    const { judge, calls } = fakeJudge({ send: false, reason: 'crosses a sphere line', mouthChecked: true });
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
    const { judge, calls } = fakeJudge({ send: true, mouthChecked: true });
    const client = fakeClient();
    await handleToolCall(client, name, args, env, judge);
    assert.equal(calls.length, 0);
  });
}

test('handleToolCall: unknown tool never calls judgeSend', async () => {
  const { judge, calls } = fakeJudge({ send: true, mouthChecked: true });
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
    const { judge, ctxSeen } = fakeJudge({ send: true, mouthChecked: true });
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

test('discord_send_file: private judgmentText reaches Mouth while Discord receives only empty content and an accepted receipt', async () => {
  const client = fakeClient();
  const { judge, calls } = fakeJudge({ send: true, mouthChecked: true });
  const result = await handleToolCall(client, 'discord_send_file', {
    channelId: 'voice-channel',
    fileUrl: 'https://home.example/voice-delivery/pickup/token',
    filename: 'voice-note.wav',
    content: '',
    judgmentText: 'Words that must stay out of Discord text',
  }, env, judge);

  assert.equal(calls[0].draft, 'Words that must stay out of Discord text');
  assert.deepEqual(client.sentFiles, [[
    'voice-channel',
    'https://home.example/voice-delivery/pickup/token',
    'voice-note.wav',
    '',
    undefined,
  ]]);
  assert.match(result.content[0].text, /^File "voice-note\.wav" sent to voice-channel \(message id: m2\)$/);
  assert.deepEqual(result.structuredContent, {
    schema: 'bf.discord.delivery.v1',
    delivery: { status: 'accepted', message_id: 'm2', mouth_checked: true },
  });
});

test('discord_send_file: real DiscordClient multipart payload keeps explicit empty content and excludes private judgmentText', async () => {
  const originalFetch = globalThis.fetch;
  const privateWords = 'private artifact words must not reach Discord';
  let discordPayload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === 'https://discord.com/api/v10/channels/c1/typing') {
      assert.equal(init?.method, 'POST');
      return new Response(null, { status: 204 });
    }
    if (url === 'https://home.example/voice-delivery/pickup/token') {
      return new Response('RIFF private bytes', { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }
    assert.equal(url, 'https://discord.com/api/v10/channels/c1/messages');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.body instanceof FormData);
    const payloadJson = String((init.body as FormData).get('payload_json'));
    assert.doesNotMatch(payloadJson, /judgmentText|private artifact words/);
    discordPayload = JSON.parse(payloadJson) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'real-message-id' }), { status: 200 });
  }) as typeof fetch;

  try {
    const { judge, calls } = fakeJudge({ send: true, mouthChecked: true });
    const result = await handleToolCall(new DiscordClient('token'), 'discord_send_file', {
      channelId: 'c1',
      fileUrl: 'https://home.example/voice-delivery/pickup/token',
      filename: 'voice-note.wav',
      content: '',
      judgmentText: privateWords,
    }, env, judge);

    assert.equal(calls[0].draft, privateWords);
    assert.deepEqual(discordPayload, { content: '', attachments: [{ id: '0', filename: 'voice-note.wav' }] });
    assert.deepEqual(result.structuredContent, {
      schema: 'bf.discord.delivery.v1',
      delivery: { status: 'accepted', message_id: 'real-message-id', mouth_checked: true },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('discord_send_file: a Mouth hold is structured and does not call Discord', async () => {
  const client = fakeClient();
  const { judge, calls } = fakeJudge({ send: false, reason: 'privacy hold', mouthChecked: true });
  const result = await handleToolCall(client, 'discord_send_file', {
    channelId: 'voice-channel', fileUrl: 'https://x/voice.wav', filename: 'voice.wav', content: '', judgmentText: 'private words',
  }, env, judge);

  assert.equal(calls[0].draft, 'private words');
  assert.deepEqual(client.calls, []);
  assert.match(result.content[0].text, /^Held: privacy hold/);
  assert.doesNotMatch(result.content[0].text, /private words/);
  assert.match(result.content[0].text, /Draft: voice\.wav$/);
  assert.deepEqual(result.structuredContent, {
    schema: 'bf.discord.delivery.v1',
    delivery: { status: 'held', reason: 'privacy hold', mouth_checked: true },
  });
});

test('discord_send_file: configuration-unavailable policy still sends, marked unjudged', async () => {
  const client = fakeClient();
  const result = await handleToolCall(client, 'discord_send_file', {
    channelId: 'c1', fileUrl: 'https://x/file.wav', filename: 'file.wav', content: '',
  });

  assert.deepEqual(result.structuredContent, {
    schema: 'bf.discord.delivery.v1',
    delivery: { status: 'accepted', message_id: 'm2', mouth_checked: false },
  });
  assert.equal(client.sentFiles[0][3], '');
});

test('discord_send_file: an explicit Discord 4xx refusal is a structured rejection', async () => {
  const client = fakeClient();
  client.sendFile = async () => { throw new Error('Discord API error 403: Missing Permissions'); };
  const { judge } = fakeJudge({ send: true, mouthChecked: true });
  const result = await handleToolCall(client, 'discord_send_file', {
    channelId: 'c1', fileUrl: 'https://x/file.wav', filename: 'file.wav', content: '',
  }, env, judge);

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Rejected: Discord rejected file delivery (HTTP 403)');
  assert.deepEqual(result.structuredContent, {
    schema: 'bf.discord.delivery.v1',
    delivery: { status: 'rejected', reason: 'Discord rejected file delivery (HTTP 403)', mouth_checked: true },
  });
});

test('discord_send_file: a malformed Discord success response cannot produce an accepted receipt', async () => {
  const client = fakeClient();
  client.sendFile = async () => ({});
  const { judge } = fakeJudge({ send: true, mouthChecked: true });
  const result = await handleToolCall(client, 'discord_send_file', {
    channelId: 'c1', fileUrl: 'https://x/file.wav', filename: 'file.wav', content: '',
  }, env, judge);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content[0].text, 'Error: Discord file delivery response missing message id');
});

test('discord_send_file: existing human text compatibility keeps a visible caption and sends it to Discord', async () => {
  const client = fakeClient();
  const { judge, calls } = fakeJudge({ send: true, mouthChecked: true });
  const result = await handleToolCall(client, 'discord_send_file', {
    channelId: 'c1', fileUrl: 'https://x/image.png', filename: 'image.png', content: 'old caller caption',
  }, env, judge);

  assert.equal(calls[0].draft, 'old caller caption');
  assert.equal(client.sentFiles[0][3], 'old caller caption');
  assert.equal(result.content[0].text, 'File "image.png" sent to c1 (message id: m2)');
});

test('discord_send_file: a transport failure remains the existing MCP isError result without a false delivery receipt', async () => {
  const client = fakeClient();
  client.sendFile = async () => { throw new TypeError('network connection lost'); };
  const { judge } = fakeJudge({ send: true, mouthChecked: true });
  const result = await handleToolCall(client, 'discord_send_file', {
    channelId: 'c1', fileUrl: 'https://x/file.wav', filename: 'file.wav', content: '',
  }, env, judge);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content[0].text, 'Error: network connection lost');
});

test('tools/list exposes optional judgmentText on discord_send_file', async () => {
  const response = await worker.fetch(new Request('https://discord.example/mcp/s', { method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/list',
  }) }), env, {} as ExecutionContext);
  const body = await response.json() as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } };
  const sendFile = body.result.tools.find((tool) => tool.name === 'discord_send_file');
  assert.ok(sendFile);
  assert.ok(sendFile.inputSchema.properties.judgmentText);
});
