// Discord MCP Worker - Discord access from anywhere via Cloudflare Workers
// Lightweight REST-based MCP for mobile Claude and browser clients

import { DiscordClient, DiscordEmbed } from './discord';

interface Env {
  DISCORD_TOKEN: string;
  MCP_SECRET: string;
  OWNER_DISCORD_ID: string;
  MENTION_DMS: string; // Set to "false" in Cloudflare vars to disable DM notifications
  PRESENCE_SERVICE_URL: string; // Optional — heartbeat service URL (e.g. https://heartbeat.onrender.com)
  PRESENCE_SECRET: string;      // Optional — must match the heartbeat service's PRESENCE_SECRET
}

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
    name: 'discord_set_presence',
    description: 'Set online presence: online (green), idle (moon), or offline. Call on arrival and departure. Requires heartbeat service.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['online', 'idle', 'offline'] },
      },
      required: ['status'],
    },
  },
  {
    name: 'discord_keepalive',
    description: 'Reset the 20-minute presence auto-timeout. Call periodically in long sessions to stay online.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'discord_read_messages',
    description: 'Read messages from a channel',
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
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID' },
        message: { type: 'string', description: 'Message content' },
        replyToMessageId: { type: 'string', description: 'Message ID to reply to' },
        embeds: { type: 'array', description: 'Optional Discord embed objects (title, description, color, fields, footer, image, thumbnail)' },
      },
      required: ['channelId', 'message'],
    },
  },
  {
    name: 'discord_edit_message',
    description: 'Edit one of the bot\'s own messages',
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
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'discord_get_server_info',
    description: 'Get server details including all channels',
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
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Server ID' },
      },
      required: ['guildId'],
    },
  },
];

async function handleToolCall(
  client: DiscordClient,
  name: string,
  args: Record<string, any>,
  env?: Env
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    switch (name) {
      case 'discord_read_messages': {
        const messages = await client.readMessages(args.channelId, args.limit || 50);
        const formatted = messages.map((m) => ({
          id: m.id,
          content: m.content,
          author: { id: m.author.id, username: m.author.username, bot: m.author.bot },
          timestamp: m.timestamp,
          attachments: m.attachments.length,
          embeds: m.embeds.length,
          mentions: m.mentions?.map(u => u.username) || [],
          replyTo: m.message_reference?.message_id || null,
          thread: m.thread ? { id: m.thread.id, name: m.thread.name } : null,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ channelId: args.channelId, messageCount: formatted.length, messages: formatted }, null, 2) }],
        };
      }

      case 'discord_send': {
        await client.sendMessage(args.channelId, args.message, args.replyToMessageId, args.embeds);
        const response = args.replyToMessageId
          ? `Message sent to ${args.channelId} as reply to ${args.replyToMessageId}`
          : `Message sent to ${args.channelId}`;
        return { content: [{ type: 'text', text: response }] };
      }

      case 'discord_edit_message': {
        const edited = await client.editMessage(args.channelId, args.messageId, args.content);
        return { content: [{ type: 'text', text: `Message ${edited.id} updated.` }] };
      }

      case 'discord_delete_message': {
        await client.deleteMessage(args.channelId, args.messageId);
        return { content: [{ type: 'text', text: `Message ${args.messageId} deleted.` }] };
      }

      case 'discord_send_file': {
        const result = await client.sendFile(args.channelId, args.fileUrl, args.filename, args.content, args.replyToMessageId);
        return { content: [{ type: 'text', text: `File "${args.filename}" sent to ${args.channelId} (message id: ${result.id})` }] };
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
        return {
          content: [{ type: 'text', text: JSON.stringify({ totalResults: results.total_results, messages: results.messages }, null, 2) }],
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

      case 'discord_set_presence':
      case 'discord_keepalive': {
        if (!env?.PRESENCE_SERVICE_URL || !env?.PRESENCE_SECRET) {
          return { content: [{ type: 'text', text: 'Presence service not configured. Set PRESENCE_SERVICE_URL and PRESENCE_SECRET to enable this tool.' }] };
        }
        const endpoint = name === 'discord_keepalive' ? '/keepalive' : '/presence';
        const body = name === 'discord_keepalive' ? undefined : JSON.stringify({ status: args.status });
        const presenceRes = await fetch(`${env.PRESENCE_SERVICE_URL}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Presence-Secret': env.PRESENCE_SECRET,
          },
          body,
        });
        if (!presenceRes.ok) {
          return { content: [{ type: 'text', text: `Presence service error: ${presenceRes.status}` }], isError: true };
        }
        const result = await presenceRes.json() as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
function timestampToSnowflake(timestamp: number): string {
  const DISCORD_EPOCH = 1420070400000n;
  return ((BigInt(timestamp) - DISCORD_EPOCH) << 22n).toString();
}

async function sendOwnerDM(env: Env, message: string): Promise<void> {
  const DISCORD_API = 'https://discord.com/api/v10';

  // Open a DM channel with the owner
  const dmChannelResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recipient_id: env.OWNER_DISCORD_ID }),
  });

  if (!dmChannelResponse.ok) return;
  const dmChannel = await dmChannelResponse.json() as { id: string };

  // Send the DM
  await fetch(`${DISCORD_API}/channels/${dmChannel.id}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: message }),
  });
}

async function checkChannelForActivity(
  client: DiscordClient,
  channelId: string,
  channelName: string,
  guildName: string,
  botUserId: string,
  afterSnowflake: string,
  foundMentions: string[]
): Promise<void> {
  // Get recent messages in this channel/thread
  let endpoint = `/channels/${channelId}/messages?limit=20`;
  if (afterSnowflake) endpoint += `&after=${afterSnowflake}`;

  const DISCORD_API = 'https://discord.com/api/v10';
  const response = await fetch(`${DISCORD_API}${endpoint}`, {
    headers: { 'Authorization': `Bot ${(client as any).token}` },
  });
  if (!response.ok) return;
  const messages = await response.json() as any[];

  for (const message of messages) {
    // Skip the bot's own messages
    if (message.author?.id === botUserId) continue;

    const isMention = message.mentions?.some((u: any) => u.id === botUserId);
    const isReply = message.message_reference?.message_id &&
      message.referenced_message?.author?.id === botUserId;

    if (isMention || isReply) {
      const type = isReply && !isMention ? '↩️ replied to you' : '📨 mentioned you';
      const preview = (message.content || '[no text content]').slice(0, 200);
      foundMentions.push(
        `${type} — **${message.author?.username}** in **#${channelName}** (${guildName}):\n> ${preview}\n\nMessage ID: ${message.id} | Channel ID: ${channelId}`
      );
    }
  }
}

async function pollMentions(env: Env): Promise<void> {
  const client = new DiscordClient(env.DISCORD_TOKEN);

  const botUser = await client.getBotUser();
  const guilds = await client.listGuilds();

  // Check 6 minutes back — slightly more than our 5-minute cron interval
  const checkAfter = Date.now() - 6 * 60 * 1000;
  const afterSnowflake = timestampToSnowflake(checkAfter);

  const foundMentions: string[] = [];

  for (const guild of guilds) {
    try {
      const channels = await client.getGuildChannels(guild.id);

      // Text channels (0), news channels (5), threads (10, 11, 12)
      const relevantChannels = channels.filter(c =>
        [0, 5, 10, 11, 12].includes(c.type)
      );

      for (const channel of relevantChannels) {
        try {
          await checkChannelForActivity(
            client, channel.id, channel.name, guild.name,
            botUser.id, afterSnowflake, foundMentions
          );
        } catch {
          // Skip channels we can't read
        }
      }

      // Also check active threads (threads are separate from channels in Discord API)
      try {
        const threadsResult = await client.getActiveThreads(guild.id);
        for (const thread of threadsResult.threads) {
          try {
            await checkChannelForActivity(
              client, thread.id, thread.name, guild.name,
              botUser.id, afterSnowflake, foundMentions
            );
          } catch {
            // Skip threads we can't read
          }
        }
      } catch {
        // Skip if can't fetch threads
      }

    } catch {
      // Skip guilds we can't access
    }
  }

  if (foundMentions.length > 0 && env.MENTION_DMS !== 'false') {
    const dmMessage = `🔔 **Asher was contacted ${foundMentions.length === 1 ? 'once' : `${foundMentions.length} times`}:**\n\n${foundMentions.join('\n\n---\n\n')}`;
    await sendOwnerDM(env, dmMessage);
  }
}

export default {
  // Cron trigger — runs every 5 minutes to check for mentions
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await pollMentions(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    if (pathParts.length < 2 || pathParts[0] !== 'mcp') {
      return new Response(JSON.stringify({ error: 'Invalid path. Use /mcp/YOUR_SECRET' }), {
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
              capabilities: { tools: {} },
              serverInfo: { name: 'discord-mcp', version: '2.0.0' },
            },
          };
          break;

        case 'tools/list':
          response = { jsonrpc: '2.0', id: requestId, result: { tools: TOOLS } };
          break;

        case 'tools/call':
          if (!body.params?.name) {
            response = { jsonrpc: '2.0', id: requestId, error: { code: -32602, message: 'Missing tool name' } };
          } else {
            const result = await handleToolCall(client, body.params.name, body.params.arguments || {}, env);
            response = { jsonrpc: '2.0', id: requestId, result };
          }
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
