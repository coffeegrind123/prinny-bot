/**
 * Persistence for webhooks and for the Discord-id ↔ Matrix-id mapping.
 *
 * Two maps, and both are needed for the API to be answerable:
 *
 * - Webhooks, so a URL handed to a CI job keeps working across restarts. A
 *   webhook that only lived in memory would make every deploy silently break
 *   every integration pointed at it.
 * - Messages, because Get/Edit/Delete Webhook Message address a message by the
 *   snowflake we returned, and only this map knows which Matrix event that was.
 *
 * The interface is deliberately the same shape as `SessionStorage`: a consumer
 * that has already implemented one against a real database can implement this
 * one the same way.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DiscordWebhook } from './types.js';

/** A webhook plus the Matrix identity it stands for. */
export type StoredWebhook = {
  webhook: DiscordWebhook;
  /** Matrix room this webhook posts into. */
  roomId: string;
  /** Matrix space the room belongs to, when one was given. Discord's guild. */
  spaceId?: string;
  /** Secret half of the URL. Never returned by endpoints that omit the token. */
  token: string;
  createdAt: number;
};

/**
 * A Discord channel id standing for a Matrix room.
 *
 * Minted rather than derived, for the same reason message ids are: a Matrix
 * room id is not a snowflake, and a client that sorts or timestamps channel ids
 * would break on one. The mapping is the only place the two identities meet.
 */
export type StoredChannel = {
  id: string;
  roomId: string;
  /** The space the room belongs to. Discord's guild. */
  guildId?: string;
  name?: string;
};

/** A Discord guild id standing for a Matrix space. */
export type StoredGuild = {
  id: string;
  spaceId: string;
  name?: string;
};

/** The Matrix event behind a message snowflake. */
export type StoredMessage = {
  id: string;
  webhookId: string;
  roomId: string;
  eventId: string;
  /** Matrix thread root, when the message was sent into a thread. */
  threadId?: string;
  channelId: string;
  createdAt: number;
};

export interface WebhookStore {
  getWebhook(id: string): StoredWebhook | undefined;
  listWebhooks(): StoredWebhook[];
  putWebhook(entry: StoredWebhook): void;
  deleteWebhook(id: string): void;

  getChannel(id: string): StoredChannel | undefined;
  findChannelByRoom(roomId: string): StoredChannel | undefined;
  putChannel(entry: StoredChannel): void;

  getGuild(id: string): StoredGuild | undefined;
  findGuildBySpace(spaceId: string): StoredGuild | undefined;
  putGuild(entry: StoredGuild): void;

  getMessage(id: string): StoredMessage | undefined;
  /** Reverse lookup, so an edit arriving by Matrix event id can find its id. */
  findMessageByEvent(eventId: string): StoredMessage | undefined;
  putMessage(entry: StoredMessage): void;
  deleteMessage(id: string): void;
}

type StoreData = {
  webhooks: Record<string, StoredWebhook>;
  messages: Record<string, StoredMessage>;
  channels: Record<string, StoredChannel>;
  guilds: Record<string, StoredGuild>;
};

const emptyData = (): StoreData => ({ webhooks: {}, messages: {}, channels: {}, guilds: {} });

export class MemoryWebhookStore implements WebhookStore {
  protected data: StoreData = emptyData();

  protected flush(): void {
    // Nothing to do — overridden by the file-backed store.
  }

  getWebhook(id: string): StoredWebhook | undefined {
    return this.data.webhooks[id];
  }

  listWebhooks(): StoredWebhook[] {
    return Object.values(this.data.webhooks);
  }

  putWebhook(entry: StoredWebhook): void {
    this.data.webhooks[entry.webhook.id] = entry;
    this.flush();
  }

  deleteWebhook(id: string): void {
    delete this.data.webhooks[id];
    // Messages outlive their webhook in Discord too (the message stays in the
    // channel), but they are no longer addressable through it, and keeping
    // them would leak room ids for a webhook the owner has revoked.
    Object.values(this.data.messages)
      .filter((message) => message.webhookId === id)
      .forEach((message) => {
        delete this.data.messages[message.id];
      });
    this.flush();
  }

  getChannel(id: string): StoredChannel | undefined {
    return this.data.channels[id];
  }

  findChannelByRoom(roomId: string): StoredChannel | undefined {
    return Object.values(this.data.channels).find((channel) => channel.roomId === roomId);
  }

  putChannel(entry: StoredChannel): void {
    this.data.channels[entry.id] = entry;
    this.flush();
  }

  getGuild(id: string): StoredGuild | undefined {
    return this.data.guilds[id];
  }

  findGuildBySpace(spaceId: string): StoredGuild | undefined {
    return Object.values(this.data.guilds).find((guild) => guild.spaceId === spaceId);
  }

  putGuild(entry: StoredGuild): void {
    this.data.guilds[entry.id] = entry;
    this.flush();
  }

  getMessage(id: string): StoredMessage | undefined {
    return this.data.messages[id];
  }

  findMessageByEvent(eventId: string): StoredMessage | undefined {
    return Object.values(this.data.messages).find((message) => message.eventId === eventId);
  }

  putMessage(entry: StoredMessage): void {
    this.data.messages[entry.id] = entry;
    this.flush();
  }

  deleteMessage(id: string): void {
    delete this.data.messages[id];
    this.flush();
  }
}

/**
 * JSON-file storage, written whole on every change and renamed into place.
 *
 * Same trade as `FileSessionStorage`, and the same warning: correct for one bot
 * with tens of webhooks, wrong for thousands. The fix there is a real database
 * behind `WebhookStore`, not a cleverer file format.
 *
 * Mode 0600 is not incidental — this file contains webhook tokens in the clear,
 * and each one is a bearer credential that can post into a room.
 */
export class FileWebhookStore extends MemoryWebhookStore {
  constructor(private readonly path: string) {
    super();
    this.data = FileWebhookStore.load(path);
  }

  private static load(path: string): StoreData {
    if (!existsSync(path)) return emptyData();
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreData>;
      return {
        webhooks: parsed.webhooks ?? {},
        messages: parsed.messages ?? {},
        channels: parsed.channels ?? {},
        guilds: parsed.guilds ?? {},
      };
    } catch {
      // A corrupt file must not stop the server booting. Losing the mapping
      // costs edit/delete on old messages; refusing to start costs everything.
      return emptyData();
    }
  }

  protected override flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
