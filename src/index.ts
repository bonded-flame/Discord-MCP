// Discord MCP Worker - Discord access from anywhere via Cloudflare Workers
// Lightweight REST-based MCP for mobile Claude and browser clients

import { DiscordClient, DiscordEmbed } from './discord';

interface Env {
  DISCORD_TOKEN: string;
  MCP_SECRET: string;
  OWNER_DISCORD_ID: string;
  MENTION_DMS: string; // Set to "false" in Cloudflare vars to disable DM notifications
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
    name: 'discord_read_messages',
    description: 'Read messages from a Discord channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The channel ID to read from' },
        limit: { type: 'number', description: 'Number of messages (max 100)', default: 50 },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'discord_send',
    description: 'Send a message to a Discord channel, optionally with embeds or as a reply',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The channel ID to send to' },
        message: { type: 'string', description: 'The message content' },
        replyToMessageId: { type: 'string', description: 'Optional message ID to reply to' },
        embeds: {
          type: 'array',
          description: 'Optional array of embed objects for rich formatting',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              url: { type: 'string' },
              color: { type: 'number', description: 'Color as decimal integer (e.g. 5814783 for purple)' },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    value: { type: 'string' },
                    inline: { type: 'boolean' },
                  },
                  required: ['name', 'value'],
                },
              },
              footer: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  icon_url: { type: 'string' },
                },
              },
              image: { type: 'object', properties: { url: { type: 'string' } } },
              thumbnail: { type: 'object', properties: { url: { type: 'string' } } },
            },
          },
        },
      },
      required: ['channelId', 'message'],
    },
  },
  {
    name: 'discord_send_file',
    description: 'Send a file attachment to a Discord channel by providing a URL to the file',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The channel ID to send to' },
        fileUrl: { type: 'string', description: 'URL of the file to send' },
        filename: { type: 'string', description: 'Filename to use for the attachment' },
        content: { type: 'string', description: 'Optional message text to accompany the file' },
        replyToMessageId: { type: 'string', description: 'Optional message ID to reply to' },
      },
      required: ['channelId', 'fileUrl', 'filename'],
    },
  },
  {
    name: 'discord_get_mentions',
    description: 'Get messages that mention the bot in a channel — use this during autonomous time to check if anyone needs me',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The channel ID to check' },
        limit: { type: 'number', description: 'Number of recent messages to scan (max 100)', default: 50 },
        afterMessageId: { type: 'string', description: 'Only get mentions after this message ID (for checking new mentions only)' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'discord_search_messages',
    description: 'Search for messages in a Discord server',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'The server (guild) ID to search' },
        content: { type: 'string', description: 'Text to search for' },
        authorId: { type: 'string', description: 'Filter by author ID' },
        channelId: { type: 'string', description: 'Filter by channel ID' },
        has: { type: 'string', description: 'Filter by content type (link, embed, file, image, video)' },
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
        channelId: { type: 'string', description: 'The channel ID' },
        messageId: { type: 'string', description: 'The message ID to react to' },
        emoji: { type: 'string', description: 'The emoji to react with — unicode (e.g. "👋") or custom (e.g. "name:id")' },
      },
      required: ['channelId', 'messageId', 'emoji'],
    },
  },
  {
    name: 'discord_create_thread',
    description: 'Create a thread from an existing message',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The channel ID' },
        messageId: { type: 'string', description: 'The message to create a thread from' },
        name: { type: 'string', description: 'Thread name' },
        autoArchiveDuration: { type: 'number', description: 'Minutes until auto-archive: 60, 1440 (1 day), 4320 (3 days), 10080 (1 week)', default: 1440 },
      },
      required: ['channelId', 'messageId', 'name'],
    },
  },
  {
    name: 'discord_list_servers',
    description: 'List all Discord servers the bot is in',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'discord_get_server_info',
    description: 'Get detailed info about a Discord server including all channels',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'The server (guild) ID' },
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
        guildId: { type: 'string', description: 'The server (guild) ID' },
      },
      required: ['guildId'],
    },
  },
];

async function handleToolCall(
  client: DiscordClient,
  name: string,
  args: Record<string, any>
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
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const providedSecret = pathParts[1];
    if (providedSecret !== env.MCP_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (request.method === 'GET') {
      return new Response(JSON.stringify({ name: 'discord-mcp', version: '2.0.0', status: 'ok' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
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
            const result = await handleToolCall(client, body.params.name, body.params.arguments || {});
            response = { jsonrpc: '2.0', id: requestId, result };
          }
          break;

        default:
          response = { jsonrpc: '2.0', id: requestId, error: { code: -32601, message: `Unknown method: ${body.method}` } };
      }

      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
