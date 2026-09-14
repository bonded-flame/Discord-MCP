// Discord MCP Worker - Discord access from anywhere via Cloudflare Workers
// Lightweight REST-based MCP for mobile Claude and browser clients

import { DiscordClient, type DiscordEmbed } from './discord.ts';
import { handleRestRequest } from './rest.ts';
import { getOpenAPISpec } from './openapi.ts';
import { judgeSend, type JudgeSendInput, type JudgeVerdict } from './mouth.ts';

export interface Env {
  DISCORD_TOKEN: string;
  MCP_SECRET: string;
  // Service binding to the voices worker — the Mouth's config and judge live
  // there; Discord-mcp binds no KV of its own (CONTRACTS.md section A).
  VOICES?: Fetcher;
  VOICES_GATE_SECRET?: string;
}

type JudgeSendFn = (env: Env, input: JudgeSendInput, ctx?: ExecutionContext) => Promise<JudgeVerdict>;

interface MCPRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, any>;
  };
}

interface MCPResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: 'discord_read_messages',
    description: 'Read messages from a channel',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        limit: { type: 'number', description: 'Number of messages (max 100)', default: 50 },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'discord_send',
    description: 'Send a message to a channel, optionally with embeds or as a reply',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        message: { type: 'string', description: 'Message content' },
        replyToMessageId: { type: 'string', description: 'Message ID to reply to' },
        embeds: { type: 'array', items: { type: 'object' }, description: 'Optional Discord embed objects (title, description, color, fields, footer, image, thumbnail)' },
      },
      required: ['channelId', 'message'],
    },
  },
  {
    name: 'discord_set_typing',
    description: 'Show the bot typing in a channel for a few seconds',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'discord_edit_message',
    description: 'Edit one of the bot\'s own messages',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        messageId: { type: 'string', description: 'Message ID to edit' },
        content: { type: 'string', description: 'New message content' },
      },
      required: ['channelId', 'messageId', 'content'],
    },
  },
  {
    name: 'discord_delete_message',
    description: 'Delete one of the bot\'s own messages',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        messageId: { type: 'string', description: 'Message ID to delete' },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'discord_send_file',
    description: 'Send a file to a channel via URL',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        fileUrl: { type: 'string', description: 'URL of the file' },
        filename: { type: 'string', description: 'Filename for the attachment' },
        content: { type: 'string', description: 'Optional message text' },
        replyToMessageId: { type: 'string', description: 'Message ID to reply to' },
      },
      required: ['channelId', 'fileUrl', 'filename'],
    },
  },
  {
    name: 'discord_get_mentions',
    description: 'Get messages that mention the bot in a channel',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        limit: { type: 'number', description: 'Messages to scan (max 100)', default: 50 },
        afterMessageId: { type: 'string', description: 'Only get mentions after this message ID' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'discord_search_messages',
    description: 'Search for messages in a server',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Server ID' },
        content: { type: 'string', description: 'Text to search for' },
        authorId: { type: 'string', description: 'Filter by author ID' },
        channelId: { type: 'string', description: 'Filter by channel ID' },
        has: { type: 'string', description: 'Filter by type: link, embed, file, image, video' },
        limit: { type: 'number', description: 'Max results (default 25)' },
      },
      required: ['guildId'],
    },
  },
  {
    name: 'discord_add_reaction',
    description: 'Add a reaction to a message',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        messageId: { type: 'string', description: 'Message ID' },
        emoji: { type: 'string', description: 'Unicode emoji or custom "name:id"' },
      },
      required: ['channelId', 'messageId', 'emoji'],
    },
  },
  {
    name: 'discord_create_thread',
    description: 'Create a thread from a message',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        messageId: { type: 'string', description: 'Message to thread from' },
        name: { type: 'string', description: 'Thread name' },
        autoArchiveDuration: { type: 'number', description: 'Archive after N minutes: 60, 1440, 4320, 10080', default: 1440 },
      },
      required: ['channelId', 'messageId', 'name'],
    },
  },
  {
    name: 'discord_list_servers',
    description: 'List all servers the bot is in',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'discord_get_server_info',
    description: 'Get server details including all channels',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Server ID' },
      },
      required: ['guildId'],
    },
  },
  {
    name: 'discord_get_active_threads',
    description: 'Get all active threads in a server',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Server ID' },
      },
      required: ['guildId'],
    },
  },
];

interface DiscordDeliveryStructuredContent {
  schema: 'bf.discord.delivery.v1';
  delivery: {
    status: 'accepted' | 'held' | 'rejected';
    message_id?: string;
    reason?: string;
    mouth_checked: boolean;
  };
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: DiscordDeliveryStructuredContent;
}

function discordDeliveryResult(
  status: DiscordDeliveryStructuredContent['delivery']['status'],
  mouthChecked: boolean,
  options: { messageId?: string; reason?: string } = {},
): DiscordDeliveryStructuredContent {
  return {
    schema: 'bf.discord.delivery.v1',
    delivery: {
      status,
      ...(options.messageId === undefined ? {} : { message_id: options.messageId }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      mouth_checked: mouthChecked,
    },
  };
}

function explicitDiscordRejection(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = /^Discord API error (4\d\d):/.exec(error.message);
  return match ? Number(match[1]) : null;
}

export async function handleToolCall(
  client: DiscordClient,
  name: string,
  args: Record<string, any>,
  env?: Env,
  judge: JudgeSendFn = judgeSend,
  ctx?: ExecutionContext
): Promise<ToolResult> {
  const activeEnv: Env = env ?? ({} as Env);
  try {
    switch (name) {
      case 'discord_read_messages': {
        const messages = await client.readMessages(args.channelId, args.limit || 50);
        const formatted = messages.map((m) => ({
          id: m.id,
          content: m.content,
          author: { id: m.author.id, username: m.author.username, globalName: m.author.global_name || null, bot: m.author.bot },
          timestamp: m.timestamp,
          editedAt: m.edited_timestamp || null,
          pinned: Boolean(m.pinned),
          attachments: (m.attachments || []).map((a) => ({
            id: a.id,
            filename: a.filename,
            contentType: a.content_type || null,
            size: a.size,
            url: a.url,
            duration: a.duration_secs || null,
            waveform: a.waveform || null,
            flags: a.flags || 0,
          })),
          embeds: (m.embeds || []).map((e) => ({
            title: e.title || null,
            description: e.description || null,
            url: e.url || null,
            type: e.type || null,
          })),
          stickers: (m.sticker_items || []).map((s) => ({ id: s.id, name: s.name, formatType: s.format_type })),
          reactions: (m.reactions || []).map((r) => ({
            count: r.count,
            emoji: {
              id: r.emoji.id || null,
              name: r.emoji.name || null,
              animated: Boolean(r.emoji.animated),
            },
          })),
          mentions: m.mentions?.map(u => u.username) || [],
          replyTo: m.message_reference?.message_id || null,
          thread: m.thread ? { id: m.thread.id, name: m.thread.name } : null,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ channelId: args.channelId, messageCount: formatted.length, messages: formatted }, null, 2) }],
        };
      }

      case 'discord_send': {
        const verdict = await judge(activeEnv, { tool: name, channelId: args.channelId, draft: args.message, context: '' }, ctx);
        if (!verdict.send) {
          return { content: [{ type: 'text', text: `Held: ${verdict.reason}\n\nDraft: ${args.message}` }] };
        }
        await client.setTyping(args.channelId);
        await client.sendMessage(args.channelId, args.message, args.replyToMessageId, args.embeds);
        const response = args.replyToMessageId
          ? `Message sent to ${args.channelId} as reply to ${args.replyToMessageId}`
          : `Message sent to ${args.channelId}`;
        return { content: [{ type: 'text', text: response }] };
      }

      case 'discord_set_typing': {
        await client.setTyping(args.channelId);
        return { content: [{ type: 'text', text: `Typing indicator sent to ${args.channelId}` }] };
      }

      case 'discord_edit_message': {
        const verdict = await judge(activeEnv, { tool: name, channelId: args.channelId, draft: args.content, context: '' }, ctx);
        if (!verdict.send) {
          return { content: [{ type: 'text', text: `Held: ${verdict.reason}\n\nDraft: ${args.content}` }] };
        }
        const edited = await client.editMessage(args.channelId, args.messageId, args.content);
        return { content: [{ type: 'text', text: `Message ${edited.id} updated.` }] };
      }

      case 'discord_delete_message': {
        await client.deleteMessage(args.channelId, args.messageId);
        return { content: [{ type: 'text', text: `Message ${args.messageId} deleted.` }] };
      }

      case 'discord_send_file': {
        const draft = args.content || args.filename || '';
        const verdict = await judge(activeEnv, { tool: name, channelId: args.channelId, draft, context: '' }, ctx);
        if (!verdict.send) {
          return {
            content: [{ type: 'text', text: `Held: ${verdict.reason}\n\nDraft: ${draft}` }],
            structuredContent: discordDeliveryResult('held', verdict.mouthChecked, { reason: verdict.reason }),
          };
        }
        await client.setTyping(args.channelId);
        try {
          const result = await client.sendFile(args.channelId, args.fileUrl, args.filename, args.content, args.replyToMessageId);
          if (typeof result?.id !== 'string' || result.id.trim() === '') {
            throw new Error('Discord file delivery response missing message id');
          }
          return {
            content: [{ type: 'text', text: `File "${args.filename}" sent to ${args.channelId} (message id: ${result.id})` }],
            structuredContent: discordDeliveryResult('accepted', verdict.mouthChecked, { messageId: result.id }),
          };
        } catch (error) {
          const status = explicitDiscordRejection(error);
          if (status !== null) {
            const reason = `Discord rejected file delivery (HTTP ${status})`;
            return {
              content: [{ type: 'text', text: `Rejected: ${reason}` }],
              structuredContent: discordDeliveryResult('rejected', verdict.mouthChecked, { reason }),
            };
          }
          // Network faults, timeouts, and malformed responses have no
          // accepted/rejected receipt. The existing MCP error boundary emits
          // its normal isError result so the caller can mark delivery unknown.
          throw error;
        }
      }

      case 'discord_get_mentions': {
        const botUser = await client.getBotUser();
        const mentions = await client.getMentions(args.channelId, botUser.id, args.limit || 50, args.afterMessageId);
        if (mentions.length === 0) {
          return { content: [{ type: 'text', text: 'No mentions found in the specified range.' }] };
        }
        const formatted = mentions.map((m) => ({
          id: m.id,
          content: m.content,
          author: { id: m.author.id, username: m.author.username },
          timestamp: m.timestamp,
          replyTo: m.message_reference?.message_id || null,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ mentionCount: formatted.length, botId: botUser.id, mentions: formatted }, null, 2) }],
        };
      }

      case 'discord_search_messages': {
        const results = await client.searchMessages(args.guildId, {
          content: args.content,
          author_id: args.authorId,
          channel_id: args.channelId,
          has: args.has,
          limit: args.limit,
        });
        const totalResults = results.total_results ?? 0;
        const messages = results.messages ?? [];
        if (totalResults === 0 && messages.length === 0) {
          return { content: [{ type: 'text', text: 'No results found. Note: Discord\'s search index can take a few seconds to update after new messages are sent.' }] };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ totalResults, messages }, null, 2) }],
        };
      }

      case 'discord_add_reaction': {
        await client.addReaction(args.channelId, args.messageId, args.emoji);
        return { content: [{ type: 'text', text: `Added reaction ${args.emoji} to message ${args.messageId}` }] };
      }

      case 'discord_create_thread': {
        const thread = await client.createThread(args.channelId, args.messageId, args.name, args.autoArchiveDuration);
        return { content: [{ type: 'text', text: JSON.stringify({ threadId: thread.id, name: thread.name }, null, 2) }] };
      }

      case 'discord_list_servers': {
        const guilds = await client.listGuilds();
        return {
          content: [{ type: 'text', text: JSON.stringify(guilds.map((g) => ({ id: g.id, name: g.name })), null, 2) }],
        };
      }

      case 'discord_get_server_info': {
        const [guild, channels] = await Promise.all([
          client.getGuild(args.guildId),
          client.getGuildChannels(args.guildId),
        ]);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            id: guild.id,
            name: guild.name,
            memberCount: guild.member_count,
            channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
          }, null, 2) }],
        };
      }

      case 'discord_get_active_threads': {
        const result = await client.getActiveThreads(args.guildId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.threads.map(t => ({ id: t.id, name: t.name, type: t.type })), null, 2) }],
        };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

// Convert timestamp to Discord snowflake ID (for filtering messages after a point in time)
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    if (pathParts.length < 2 || (pathParts[0] !== 'mcp' && pathParts[0] !== 'api')) {
      return new Response(JSON.stringify({ error: 'Invalid path. Use /mcp/YOUR_SECRET or /api/YOUR_SECRET/...' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    }

    const providedSecret = pathParts[1];
    if (providedSecret !== env.MCP_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    }

    // ============ REST API (for ChatGPT Actions / OpenAPI consumers) ============
    if (pathParts[0] === 'api') {
      const remainingPath = pathParts.slice(2).join('/');

      // Serve OpenAPI spec
      if (remainingPath === 'openapi.json' && request.method === 'GET') {
        const baseUrl = `${url.protocol}//${url.host}/api/${env.MCP_SECRET}`;
        return new Response(JSON.stringify(getOpenAPISpec(baseUrl), null, 2), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
        });
      }

      return handleRestRequest(request, env, remainingPath, handleToolCall, ctx);
    }

    // ============ MCP Protocol (for Claude) ============
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ name: 'discord-mcp', version: '2.0.0', status: 'ok' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    }

    const client = new DiscordClient(env.DISCORD_TOKEN);

    try {
      const body: MCPRequest = await request.json();
      const requestId = body.id ?? 1;
      let response: MCPResponse;

      switch (body.method) {
        case 'initialize':
          response = {
            jsonrpc: '2.0',
            id: requestId,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: 'discord-mcp', version: '2.0.0' },
            },
          };
          break;

        // Notifications — no response needed, return empty acknowledgment
        case 'notifications/initialized':
        case 'notifications/cancelled':
          response = { jsonrpc: '2.0', id: requestId, result: {} };
          break;

        case 'tools/list':
          response = { jsonrpc: '2.0', id: requestId, result: { tools: TOOLS } };
          break;

        case 'tools/call':
          if (!body.params?.name) {
            response = { jsonrpc: '2.0', id: requestId, error: { code: -32602, message: 'Missing tool name' } };
          } else {
            const result = await handleToolCall(client, body.params.name, body.params.arguments || {}, env, undefined, ctx);
            response = { jsonrpc: '2.0', id: requestId, result };
          }
          break;

        // Resources and prompts — we don't use these, return empty lists
        case 'resources/list':
          response = { jsonrpc: '2.0', id: requestId, result: { resources: [] } };
          break;

        case 'resources/templates/list':
          response = { jsonrpc: '2.0', id: requestId, result: { resourceTemplates: [] } };
          break;

        case 'prompts/list':
          response = { jsonrpc: '2.0', id: requestId, result: { prompts: [] } };
          break;

        case 'ping':
          response = { jsonrpc: '2.0', id: requestId, result: {} };
          break;

        default:
          response = { jsonrpc: '2.0', id: requestId, error: { code: -32601, message: `Unknown method: ${body.method}` } };
      }

      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    }
  },
};
