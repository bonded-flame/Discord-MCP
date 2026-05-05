// Discord REST API wrapper - no discord.js dependency
// Pure fetch-based client for Cloudflare Workers

const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordMessage {
  id: string;
  content: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot: boolean;
  };
  timestamp: string;
  edited_timestamp?: string | null;
  attachments: any[];
  embeds: any[];
  mentions: { id: string; username: string }[];
  mention_everyone: boolean;
  reactions?: { count: number; emoji: { id?: string; name?: string; animated?: boolean } }[];
  sticker_items?: { id: string; name: string; format_type: number }[];
  pinned?: boolean;
  message_reference?: {
    message_id: string;
  };
  thread?: {
    id: string;
    name: string;
  };
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  member_count?: number;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  topic?: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  timestamp?: string;
}

export class DiscordClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${DISCORD_API}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error ${response.status}: ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }

  // ============ MESSAGES ============

  async readMessages(channelId: string, limit: number = 50): Promise<DiscordMessage[]> {
    const messages = await this.request<DiscordMessage[]>(
      `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`
    );
    return messages.reverse();
  }

  async setTyping(channelId: string): Promise<void> {
    await this.request<void>(
      `/channels/${channelId}/typing`,
      { method: 'POST' }
    );
  }

  async sendMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string,
    embeds?: DiscordEmbed[]
  ): Promise<DiscordMessage> {
    const body: any = { content };

    if (replyToMessageId) {
      body.message_reference = { message_id: replyToMessageId };
      body.allowed_mentions = { replied_user: true };
    }

    if (embeds && embeds.length > 0) {
      body.embeds = embeds;
    }

    return this.request<DiscordMessage>(
      `/channels/${channelId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
  }

  async sendFile(
    channelId: string,
    fileUrl: string,
    filename: string,
    content?: string,
    replyToMessageId?: string
  ): Promise<DiscordMessage> {
    // Fetch the file from the URL
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to fetch file: ${fileResponse.status}`);
    }
    const fileBlob = await fileResponse.blob();

    const formData = new FormData();

    const payload: any = {};
    if (content) payload.content = content;
    if (replyToMessageId) {
      payload.message_reference = { message_id: replyToMessageId };
    }
    payload.attachments = [{ id: '0', filename }];

    formData.append('payload_json', JSON.stringify(payload));
    formData.append('files[0]', fileBlob, filename);

    const url = `${DISCORD_API}/channels/${channelId}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error ${response.status}: ${error}`);
    }

    return response.json();
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<DiscordMessage> {
    return this.request<DiscordMessage>(
      `/channels/${channelId}/messages/${messageId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      }
    );
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request<void>(
      `/channels/${channelId}/messages/${messageId}`,
      { method: 'DELETE' }
    );
  }

  async searchMessages(
    guildId: string,
    params: {
      content?: string;
      author_id?: string;
      channel_id?: string;
      has?: string;
      limit?: number;
    }
  ): Promise<{ messages: DiscordMessage[][]; total_results: number }> {
    const searchParams = new URLSearchParams();

    if (params.content) searchParams.set('content', params.content);
    if (params.author_id) searchParams.set('author_id', params.author_id);
    if (params.channel_id) searchParams.set('channel_id', params.channel_id);
    if (params.has) searchParams.set('has', params.has);
    if (params.limit) searchParams.set('limit', String(Math.min(params.limit, 25)));

    return this.request<{ messages: DiscordMessage[][]; total_results: number }>(
      `/guilds/${guildId}/messages/search?${searchParams.toString()}`
    );
  }

  // ============ MENTIONS ============

  async getMentions(
    channelId: string,
    botUserId: string,
    limit: number = 50,
    afterMessageId?: string
  ): Promise<DiscordMessage[]> {
    let endpoint = `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`;
    if (afterMessageId) {
      endpoint += `&after=${afterMessageId}`;
    }

    const messages = await this.request<DiscordMessage[]>(endpoint);

    // Filter to only messages that mention the bot
    const mentions = messages.filter(m =>
      m.mentions?.some(u => u.id === botUserId) ||
      m.mention_everyone
    );

    return mentions.reverse();
  }

  async getBotUser(): Promise<{ id: string; username: string }> {
    return this.request<{ id: string; username: string }>('/users/@me');
  }

  // ============ REACTIONS ============

  async addReaction(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<void> {
    const encodedEmoji = encodeURIComponent(emoji);

    await this.request<void>(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      { method: 'PUT' }
    );
  }

  // ============ THREADS ============

  async createThread(
    channelId: string,
    messageId: string,
    name: string,
    autoArchiveDuration: number = 1440
  ): Promise<DiscordChannel> {
    return this.request<DiscordChannel>(
      `/channels/${channelId}/messages/${messageId}/threads`,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          auto_archive_duration: autoArchiveDuration,
        }),
      }
    );
  }

  async createStandaloneThread(
    channelId: string,
    name: string,
    autoArchiveDuration: number = 1440
  ): Promise<DiscordChannel> {
    return this.request<DiscordChannel>(
      `/channels/${channelId}/threads`,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          auto_archive_duration: autoArchiveDuration,
          type: 11, // GUILD_PUBLIC_THREAD
        }),
      }
    );
  }

  async getActiveThreads(guildId: string): Promise<{ threads: DiscordChannel[] }> {
    return this.request<{ threads: DiscordChannel[] }>(
      `/guilds/${guildId}/threads/active`
    );
  }

  // ============ SERVERS ============

  async listGuilds(): Promise<DiscordGuild[]> {
    return this.request<DiscordGuild[]>('/users/@me/guilds');
  }

  async getGuild(guildId: string): Promise<DiscordGuild> {
    return this.request<DiscordGuild>(`/guilds/${guildId}?with_counts=true`);
  }

  async getGuildChannels(guildId: string): Promise<DiscordChannel[]> {
    return this.request<DiscordChannel[]>(`/guilds/${guildId}/channels`);
  }
}
