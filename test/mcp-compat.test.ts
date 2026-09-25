import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest } from '../src/mcp.ts';
const tools = [{ name: 'discord_send', description: 'existing', inputSchema: { type: 'object', properties: {} } }];
const originalResult = { content: [{ type: 'text', text: 'original result' }] };
function call(body: unknown, handler = async (_name: string, _args: Record<string, any>) => originalResult) {
  return handleMcpRequest(new Request('https://example.test/mcp/PRIVATE_SECRET', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body)
  }), tools, handler);
}
test('initialize preserves existing protocol version and capabilities', async () => {
  const r = await call({ id: 0, method: 'initialize' });
  assert.deepEqual(await r.json(), { jsonrpc: '2.0', id: 0, result: {
    protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} },
    serverInfo: { name: 'discord-mcp', version: '2.0.0' }
  } });
});
for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/other']) {
  test(`${method} returns empty 202, not an invented request-1 response`, async () => {
    const r = await call({ jsonrpc: '2.0', method });
    assert.equal(r.status, 202); assert.equal(await r.text(), '');
  });
}
test('no-ID messages never execute a sending tool', async () => {
  let invoked = 0;
  const r = await call({ method: 'tools/call', params: { name: 'discord_send' } }, async () => { invoked++; return originalResult; });
  assert.equal(r.status, 202); assert.equal(invoked, 0);
});
test('accepted client responses return empty 202', async () => {
  const r = await call({ id: 1, result: {} });
  assert.equal(r.status, 202); assert.equal(await r.text(), '');
});
for (const accept of ['text/event-stream', 'application/json, text/event-stream']) {
  test(`GET stream probe ${accept} gets 405`, async () => {
    const r = await handleMcpRequest(new Request('https://example.test/mcp/s', { headers: { Accept: accept } }), tools, async () => originalResult);
    assert.equal(r.status, 405); assert.equal(r.headers.get('Allow'), 'POST');
  });
}
test('legacy ordinary health GET response is preserved', async () => {
  const r = await handleMcpRequest(new Request('https://example.test/mcp/s'), tools, async () => originalResult);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { name: 'discord-mcp', version: '2.0.0', status: 'ok' });
});
test('tools/list returns the exact existing catalog, without additions or filtering', async () => {
  const data = await (await call({ id: 1, method: 'tools/list' })).json() as any;
  assert.deepEqual(data.result, { tools });
});
for (const [method, result] of [['ping', {}], ['resources/list', { resources: [] }], ['resources/templates/list', { resourceTemplates: [] }], ['prompts/list', { prompts: [] }]]) {
  test(`${method} preserves its successful response`, async () => {
    assert.deepEqual(await (await call({ id: 'existing-id', method })).json(), { jsonrpc: '2.0', id: 'existing-id', result });
  });
}
test('dispatch receives identical names and arguments once; successful, held and error results pass through unchanged', async () => {
  for (const result of [originalResult, { content: [{ type: 'text', text: 'Held: existing reason' }] }, { content: [{ type: 'text', text: 'Error: existing reason' }], isError: true }]) {
    let invoked = 0;
    const args = { channelId: 'c', message: 'unchanged', embeds: [{ arbitrary: true }] };
    const r = await call({ id: 1, method: 'tools/call', params: { name: 'discord_send', arguments: args } }, async (name, received) => {
      invoked++; assert.equal(name, 'discord_send'); assert.deepEqual(received, args); return result;
    });
    assert.equal(invoked, 1); assert.deepEqual(await r.json(), { jsonrpc: '2.0', id: 1, result });
  }
});
test('the existing dispatcher still owns unknown-tool behavior', async () => {
  let invoked = 0;
  await call({ id: 1, method: 'tools/call', params: { name: 'not-in-catalog' } }, async (name) => { assert.equal(name, 'not-in-catalog'); invoked++; return originalResult; });
  assert.equal(invoked, 1);
});
for (const [body, code] of [
  ['{broken', -32700], [null, -32600], [[], -32600], [{ id: 1 }, -32600],
  [{ id: 1, method: 'unknown' }, -32601], [{ id: 1, method: 'tools/call' }, -32602],
  [{ id: 1, method: 'ping', params: [] }, -32602],
  [{ id: 1, method: 'tools/call', params: { name: 'discord_send', arguments: [] } }, -32602]
] as const) {
  test(`protocol failure ${code}: ${JSON.stringify(body)}`, async () => {
    const data = await (await call(body)).json() as any;
    assert.equal(data.error.code, code);
  });
}
test('thrown tool failures do not retry or expose private data; receive and failure records correlate', async () => {
  const logs: string[] = []; const original = console.info;
  console.info = (s: string) => { logs.push(s); };
  let invoked = 0; let r: Response;
  try {
    r = await call({ id: 'PRIVATE_ID', method: 'tools/call', params: { name: 'discord_send', arguments: { message: 'PRIVATE_MESSAGE' } } }, async () => { invoked++; throw new Error('PRIVATE_EXCEPTION'); });
  } finally { console.info = original; }
  const data = await r!.json() as any;
  assert.equal(invoked, 1); assert.equal(data.result.isError, true); assert.equal(data.error, undefined);
  assert.ok(data.result.content[0].text.includes(r!.headers.get('X-MCP-Request-Id')));
  assert.equal(r!.headers.get('X-MCP-Transport-Revision'), '2026-09-25.1');
  assert.doesNotMatch(logs.join('\n'), /PRIVATE_/);
  assert.doesNotMatch(data.result.content[0].text, /PRIVATE_/);
  assert.ok(logs.some(s => JSON.parse(s).outcome === 'started'));
  assert.ok(logs.some(s => JSON.parse(s).outcome === 'tool_error'));
});
