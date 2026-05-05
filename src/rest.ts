// REST API layer for ChatGPT Actions (and any other OpenAPI consumer)
// Thin route handlers that delegate to the same handleToolCall used by MCP

import { DiscordClient } from './discord';

interface Env {
  DISCORD_TOKEN: string;
  MCP_SECRET: string;
  OWNER_DISCORD_ID: string;
  MENTION_DMS: string;
  PRESENCE_SERVICE_URL: string;
  PRESENCE_SECRET: string;
  WATCH_CHANNELS: string;
}

type ToolHandler = (
  client: DiscordClient,
  name: string,
  args: Record<string, any>,
  env?: Env
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  toolName: string;
  // Status code on success (default 200)
  successStatus?: number;
}

const routes: Route[] = [
  // Messages
  { method: 'GET',    pattern: /^channels\/([^/]+)\/messages$/, paramNames: ['channelId'], toolName: 'discord_read_messages' },
  { method: 'POST',   pattern: /^channels\/([^/]+)\/messages$/, paramNames: ['channelId'], toolName: 'discord_send', successStatus: 201 },
  { method: 'POST',   pattern: /^channels\/([^/]+)\/typing$/, paramNames: ['channelId'], toolName: 'discord_set_typing' },
  { method: 'PATCH',  pattern: /^channels\/([^/]+)\/messages\/([^/]+)$/, paramNames: ['channelId', 'messageId'], toolName: 'discord_edit_message' },
  { method: 'DELETE', pattern: /^channels\/([^/]+)\/messages\/([^/]+)$/, paramNames: ['channelId', 'messageId'], toolName: 'discord_delete_message', successStatus: 204 },
  // Files
  { method: 'POST',   pattern: /^channels\/([^/]+)\/files$/, paramNames: ['channelId'], toolName: 'discord_send_file', successStatus: 201 },
  // Mentions
  { method: 'GET',    pattern: /^channels\/([^/]+)\/mentions$/, paramNames: ['channelId'], toolName: 'discord_get_mentions' },
  // Reactions
  { method: 'PUT',    pattern: /^channels\/([^/]+)\/messages\/([^/]+)\/reactions$/, paramNames: ['channelId', 'messageId'], toolName: 'discord_add_reaction' },
  // Threads
  { method: 'POST',   pattern: /^channels\/([^/]+)\/messages\/([^/]+)\/threads$/, paramNames: ['channelId', 'messageId'], toolName: 'discord_create_thread', successStatus: 201 },
  // Servers
  { method: 'GET',    pattern: /^servers$/, paramNames: [], toolName: 'discord_list_servers' },
  { method: 'GET',    pattern: /^servers\/([^/]+)$/, paramNames: ['guildId'], toolName: 'discord_get_server_info' },
  { method: 'GET',    pattern: /^servers\/([^/]+)\/threads$/, paramNames: ['guildId'], toolName: 'discord_get_active_threads' },
  { method: 'GET',    pattern: /^servers\/([^/]+)\/messages\/search$/, paramNames: ['guildId'], toolName: 'discord_search_messages' },
  // Presence
  { method: 'POST',   pattern: /^presence$/, paramNames: [], toolName: 'discord_set_presence' },
  { method: 'POST',   pattern: /^keepalive$/, paramNames: [], toolName: 'discord_keepalive' },
];

// Query param names that map to tool args for GET endpoints
const queryParamMap: Record<string, string[]> = {
  discord_read_messages: ['limit'],
  discord_get_mentions: ['limit', 'afterMessageId'],
  discord_search_messages: ['content', 'authorId', 'channelId', 'has', 'limit'],
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

function parseErrorStatus(errorMessage: string): number {
  const match = errorMessage.match(/Discord API error (\d+)/);
  if (match) return parseInt(match[1], 10);
  return 500;
}

export async function handleRestRequest(
  request: Request,
  env: Env,
  pathAfterSecret: string,
  toolHandler: ToolHandler
): Promise<Response> {
  const method = request.method;

  // Match route
  let matched: Route | null = null;
  let pathParams: Record<string, string> = {};

  for (const route of routes) {
    if (route.method !== method) continue;
    const m = pathAfterSecret.match(route.pattern);
    if (m) {
      matched = route;
      route.paramNames.forEach((name, i) => {
        pathParams[name] = m[i + 1];
      });
      break;
    }
  }

  if (!matched) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  // Build args from path params + query params (GET) or body (POST/PATCH/PUT/DELETE)
  const args: Record<string, any> = { ...pathParams };

  if (method === 'GET') {
    const url = new URL(request.url);
    const allowedParams = queryParamMap[matched.toolName] || [];
    for (const param of allowedParams) {
      const value = url.searchParams.get(param);
      if (value !== null) {
        // Parse numeric params
        if (param === 'limit') {
          args[param] = parseInt(value, 10);
        } else {
          args[param] = value;
        }
      }
    }
  } else {
    // Parse JSON body for non-GET requests (ignore empty bodies)
    try {
      const body = await request.text();
      if (body) {
        const parsed = JSON.parse(body);
        Object.assign(args, parsed);
      }
    } catch {
      // No body or invalid JSON — proceed with path params only
    }
  }

  // Call the tool handler
  const client = new DiscordClient(env.DISCORD_TOKEN);

  try {
    const result = await toolHandler(client, matched.toolName, args, env);

    if (result.isError) {
      const errorText = result.content[0]?.text || 'Unknown error';
      const status = parseErrorStatus(errorText);
      return jsonResponse({ error: errorText }, status >= 400 ? status : 400);
    }

    const text = result.content[0]?.text || '';
    const successStatus = matched.successStatus || 200;

    if (successStatus === 204) {
      return jsonResponse(null, 204);
    }

    // Try to parse as JSON, otherwise return as text
    try {
      const data = JSON.parse(text);
      return jsonResponse(data, successStatus);
    } catch {
      return jsonResponse({ message: text }, successStatus);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = parseErrorStatus(message);
    return jsonResponse({ error: message }, status >= 400 ? status : 500);
  }
}
