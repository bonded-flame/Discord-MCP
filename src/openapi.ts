// OpenAPI 3.0 spec for the Discord REST API layer
// Served at GET /api/{secret}/openapi.json

export function getOpenAPISpec(baseUrl: string): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Discord Bot REST API',
      version: '1.0.0',
      description: 'REST API for interacting with Discord through a bot. Supports reading/sending messages, reactions, threads, server info, and presence management.',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/channels/{channelId}/messages': {
        get: {
          operationId: 'discord_read_messages',
          summary: 'Read messages from a channel',
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 }, description: 'Number of messages to fetch' },
          ],
          responses: { '200': { description: 'Messages retrieved', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
        post: {
          operationId: 'discord_send',
          summary: 'Send a message to a channel, optionally as a reply or with embeds',
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['message'],
                  properties: {
                    message: { type: 'string', description: 'Message content' },
                    replyToMessageId: { type: 'string', description: 'Message ID to reply to' },
                    embeds: { type: 'array', items: { type: 'object' }, description: 'Discord embed objects' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Message sent', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/channels/{channelId}/messages/{messageId}': {
        patch: {
          operationId: 'discord_edit_message',
          summary: "Edit one of the bot's own messages",
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
            { name: 'messageId', in: 'path', required: true, schema: { type: 'string' }, description: 'Message ID to edit' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['content'],
                  properties: { content: { type: 'string', description: 'New message content' } },
                },
              },
            },
          },
          responses: { '200': { description: 'Message edited', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
        delete: {
          operationId: 'discord_delete_message',
          summary: "Delete one of the bot's own messages",
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
            { name: 'messageId', in: 'path', required: true, schema: { type: 'string' }, description: 'Message ID to delete' },
          ],
          responses: { '204': { description: 'Message deleted' } },
        },
      },
      '/channels/{channelId}/typing': {
        post: {
          operationId: 'discord_set_typing',
          summary: 'Show the bot typing in a channel for a few seconds',
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
          ],
          responses: { '200': { description: 'Typing indicator sent', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/channels/{channelId}/files': {
        post: {
          operationId: 'discord_send_file',
          summary: 'Send a file to a channel via URL',
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['fileUrl', 'filename'],
                  properties: {
                    fileUrl: { type: 'string', description: 'URL of the file to send' },
                    filename: { type: 'string', description: 'Filename for the attachment' },
                    content: { type: 'string', description: 'Optional message text' },
                    replyToMessageId: { type: 'string', description: 'Message ID to reply to' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'File sent', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/channels/{channelId}/mentions': {
        get: {
          operationId: 'discord_get_mentions',
          summary: 'Get messages that mention the bot in a channel',
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 }, description: 'Messages to scan' },
            { name: 'afterMessageId', in: 'query', schema: { type: 'string' }, description: 'Only get mentions after this message ID' },
          ],
          responses: { '200': { description: 'Mentions retrieved', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/channels/{channelId}/messages/{messageId}/reactions': {
        put: {
          operationId: 'discord_add_reaction',
          summary: 'Add a reaction to a message',
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
            { name: 'messageId', in: 'path', required: true, schema: { type: 'string' }, description: 'Message ID' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['emoji'],
                  properties: { emoji: { type: 'string', description: 'Unicode emoji or custom "name:id"' } },
                },
              },
            },
          },
          responses: { '200': { description: 'Reaction added', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/channels/{channelId}/messages/{messageId}/threads': {
        post: {
          operationId: 'discord_create_thread',
          summary: 'Create a thread from a message',
          parameters: [
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string' }, description: 'Channel ID' },
            { name: 'messageId', in: 'path', required: true, schema: { type: 'string' }, description: 'Message to create thread from' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', description: 'Thread name' },
                    autoArchiveDuration: { type: 'integer', enum: [60, 1440, 4320, 10080], default: 1440, description: 'Archive after N minutes' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Thread created', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/servers': {
        get: {
          operationId: 'discord_list_servers',
          summary: 'List all servers the bot is in',
          parameters: [],
          responses: { '200': { description: 'Server list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } },
        },
      },
      '/servers/{guildId}': {
        get: {
          operationId: 'discord_get_server_info',
          summary: 'Get server details including all channels',
          parameters: [
            { name: 'guildId', in: 'path', required: true, schema: { type: 'string' }, description: 'Server ID' },
          ],
          responses: { '200': { description: 'Server info', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/servers/{guildId}/threads': {
        get: {
          operationId: 'discord_get_active_threads',
          summary: 'Get all active threads in a server',
          parameters: [
            { name: 'guildId', in: 'path', required: true, schema: { type: 'string' }, description: 'Server ID' },
          ],
          responses: { '200': { description: 'Active threads', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/servers/{guildId}/messages/search': {
        get: {
          operationId: 'discord_search_messages',
          summary: 'Search for messages in a server',
          parameters: [
            { name: 'guildId', in: 'path', required: true, schema: { type: 'string' }, description: 'Server ID' },
            { name: 'content', in: 'query', schema: { type: 'string' }, description: 'Text to search for' },
            { name: 'authorId', in: 'query', schema: { type: 'string' }, description: 'Filter by author ID' },
            { name: 'channelId', in: 'query', schema: { type: 'string' }, description: 'Filter by channel ID' },
            { name: 'has', in: 'query', schema: { type: 'string', enum: ['link', 'embed', 'file', 'image', 'video'] }, description: 'Filter by attachment type' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 25 }, description: 'Max results' },
          ],
          responses: { '200': { description: 'Search results', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/presence': {
        post: {
          operationId: 'discord_set_presence',
          summary: 'Set bot online presence and optional activity text. Requires heartbeat service.',
          parameters: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: {
                    status: { type: 'string', enum: ['online', 'idle', 'dnd', 'offline', 'invisible'] },
                    activityName: { type: 'string', description: 'Optional activity/custom status text' },
                    activityType: { type: 'string', enum: ['playing', 'streaming', 'listening', 'watching', 'custom', 'competing'], description: 'Activity style, defaults to custom' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Presence updated', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/keepalive': {
        post: {
          operationId: 'discord_keepalive',
          summary: 'Reset the 20-minute presence auto-timeout. Call periodically in long sessions.',
          parameters: [],
          responses: { '200': { description: 'Keepalive acknowledged', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
    },
  };
}
