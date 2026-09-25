// HTTP/MCP compatibility only. Authentication and REST routing remain in index.ts;
// all Discord actions and Mouth decisions stay in the existing tool handler.
interface ToolDefinition {
  name: string;
  [key: string]: unknown;
}
interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type CallTool = (name: string, args: Record<string, any>) => Promise<ToolResult>;
const REVISION = '2026-09-25.1';
const METHODS = new Set([
  'initialize', 'ping', 'tools/list', 'tools/call',
  'resources/list', 'resources/templates/list', 'prompts/list',
]);
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function handleMcpRequest(
  request: Request, tools: ToolDefinition[], callTool: CallTool
): Promise<Response> {
  const reference = crypto.randomUUID();
  const started = Date.now();
  let method = 'unknown';
  let tool = 'none';
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-MCP-Request-Id': reference,
    'X-MCP-Transport-Revision': REVISION,
  };
  // Never include secrets, URLs, arguments, results, exception messages, or
  // caller-supplied request IDs in diagnostic records.
  const log = (outcome: string) => console.info(JSON.stringify({
    event: 'mcp_request', request_id: reference, transport_revision: REVISION,
    method, tool, outcome, duration_ms: Date.now() - started, tool_count: tools.length,
  }));
  const reply = (body: unknown, outcome = 'ok', status = 200) => {
    log(outcome);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const fail = (id: string | number | null, code: number, message: string) =>
    reply({ jsonrpc: '2.0', id, error: { code, message } }, `protocol_error:${code}`);

  if (request.method === 'GET') {
    if ((request.headers.get('Accept') || '').toLowerCase().includes('text/event-stream')) {
      // No optional GET stream is offered. Keep ordinary legacy health GETs
      // working instead of changing their existing response contract.
      log('stream_not_offered');
      return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
    }
    return reply({ name: 'discord-mcp', version: '2.0.0', status: 'ok' });
  }
  if (request.method !== 'POST') {
    log('method_not_allowed');
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...headers, Allow: 'POST' },
    });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return fail(null, -32700, 'Invalid JSON request'); }
  if (!isRecord(body)) return fail(null, -32600, 'Expected a JSON-RPC object');
  const id = typeof body.id === 'number' || typeof body.id === 'string' ? body.id : null;
  if (typeof body.method !== 'string') {
    if ('id' in body && ('result' in body || 'error' in body)) {
      log('client_response');
      return new Response(null, { status: 202, headers });
    }
    return fail(id, -32600, 'Method must be a string');
  }
  method = METHODS.has(body.method) ? body.method : 'unknown';
  if (body.method.startsWith('notifications/') || body.id === undefined) {
    log('notification');
    return new Response(null, { status: 202, headers });
  }
  const params = body.params ?? {};
  if (!isRecord(params)) return fail(id, -32602, 'Parameters must be an object');

  switch (body.method) {
    case 'initialize':
      // Preserve the version and capabilities understood by existing clients.
      return reply({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'discord-mcp', version: '2.0.0' },
      } });
    case 'ping':
      return reply({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return reply({ jsonrpc: '2.0', id, result: { tools } });
    case 'resources/list':
      return reply({ jsonrpc: '2.0', id, result: { resources: [] } });
    case 'resources/templates/list':
      return reply({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } });
    case 'prompts/list':
      return reply({ jsonrpc: '2.0', id, result: { prompts: [] } });
    case 'tools/call': {
      if (typeof params.name !== 'string' || !params.name) return fail(id, -32602, 'Missing tool name');
      const args = params.arguments ?? {};
      if (!isRecord(args)) return fail(id, -32602, 'Tool arguments must be an object');
      // Catalog membership is used only to prevent untrusted strings entering
      // logs, not as a second permission/dispatch policy.
      tool = tools.some(t => t.name === params.name) ? params.name : 'unknown';
      log('started');
      try {
        const result = await callTool(params.name, args);
        return reply({ jsonrpc: '2.0', id, result }, result.isError ? 'tool_error' : 'ok');
      } catch {
        return reply({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: `Discord tool execution failed. Reference: ${reference}. The server received this call; the MCP layer did not retry it.` }],
          isError: true,
        } }, 'tool_error');
      }
    }
    default:
      return fail(id, -32601, 'Method not found');
  }
}
