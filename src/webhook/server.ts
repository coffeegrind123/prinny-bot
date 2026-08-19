/**
 * A Discord-compatible webhook server backed by Matrix.
 *
 * Every route below is Discord's, at Discord's path, with Discord's request and
 * response bodies. The point is that a tool already pointed at
 * `https://discord.com/api/webhooks/{id}/{token}` works against this by
 * changing the host and nothing else - no field renamed, no status code
 * different, no extra header. Anywhere the two could not be made identical is
 * commented with why.
 *
 * Mapping, once, so the rest reads plainly:
 *
 *   Discord guild   -> Matrix space
 *   Discord channel -> Matrix room
 *   Discord message -> Matrix event
 *
 * Ids are minted as snowflakes and mapped in the store; Matrix ids are never
 * handed out as Discord ids (see snowflake.ts for why).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { MatrixClient } from 'matrix-js-sdk';
import { buildMediaContent, uploadAttachment } from '../matrix/media.js';
import { BotContentKey } from '../protocol/constants.js';
import { buildFallbackBodies } from '../keyboard/fallback.js';
import { generateWebhookToken, SnowflakeGenerator } from './snowflake.js';
import {
  MemoryWebhookStore,
  type StoredChannel,
  type StoredGuild,
  type StoredMessage,
  type StoredWebhook,
  type WebhookStore,
} from './store.js';
import { parseBoundary, parseMultipart } from './multipart.js';
import { slackToExecuteBody, type SlackWebhookBody } from './slack.js';
import { githubToExecuteBody } from './github.js';
import {
  buildMentions,
  everyoneAllowed,
  renderComponents,
  renderDiscordText,
  renderEmbed,
  renderPoll,
  type RenderContext,
} from './render.js';
import {
  MessageFlags,
  WebhookType,
  type AttachmentRequest,
  type DiscordMessage,
  type DiscordUser,
  type DiscordWebhook,
  type EditWebhookMessageBody,
  type ExecuteWebhookBody,
  type UploadedFile,
} from './types.js';

export type WebhookServerOptions = {
  client: MatrixClient;
  /**
   * Bearer credentials for the management endpoints, in Discord's
   * `Authorization: Bot <token>` form. Discord gates these on the
   * MANAGE_WEBHOOKS permission; there is no Discord permission model here, so
   * holding one of these tokens IS that permission.
   *
   * Empty disables every management route rather than leaving them open - an
   * unauthenticated Create Webhook is a way to make the bot post anywhere it is
   * joined, and defaulting that on would be indefensible.
   */
  authTokens?: string[];
  store?: WebhookStore;
  /** Public origin the webhook URLs are built from, e.g. `https://prinny.example`. */
  publicUrl?: string;
  /** Identity reported as the webhook's creator. */
  applicationId?: string;
  /** Body size cap. Discord's own limit is 25 MB for the default boost level. */
  maxBodyBytes?: number;
  render?: RenderContext;
  snowflakes?: SnowflakeGenerator;
};

type RouteParams = Record<string, string>;

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: RouteParams,
  body: Buffer,
  url: URL
) => Promise<void>;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

/** Discord's error envelope. Codes are theirs where one applies. */
const DiscordError = {
  UnknownWebhook: { status: 404, code: 10015, message: 'Unknown Webhook' },
  UnknownMessage: { status: 404, code: 10008, message: 'Unknown Message' },
  UnknownChannel: { status: 404, code: 10003, message: 'Unknown Channel' },
  Unauthorized: { status: 401, code: 0, message: '401: Unauthorized' },
  InvalidToken: { status: 401, code: 50027, message: 'Invalid Webhook Token Provided' },
  CannotSendEmpty: { status: 400, code: 50006, message: 'Cannot send an empty message' },
  InvalidFormBody: { status: 400, code: 50035, message: 'Invalid Form Body' },
  RequestTooLarge: { status: 413, code: 40005, message: 'Request entity too large' },
  MethodNotAllowed: { status: 405, code: 0, message: '405: Method Not Allowed' },
  NotFound: { status: 404, code: 0, message: '404: Not Found' },
} as const;

type DiscordErrorSpec = { status: number; code: number; message: string };

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const sendEmpty = (res: ServerResponse, status: number): void => {
  res.writeHead(status);
  res.end();
};

const sendError = (res: ServerResponse, spec: DiscordErrorSpec, errors?: unknown): void => {
  sendJson(res, spec.status, { code: spec.code, message: spec.message, errors });
};

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak the
 * length, so the lengths are compared first and the result folded in - the
 * comparison still runs on equal-length buffers either way.
 */
const tokensMatch = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare against itself so the work done does not depend on the input.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

/**
 * Whether a channel id is a Matrix room id written directly.
 *
 * Accepting one is a convenience the Discord API has no equivalent for, and it
 * is what makes the server usable without a registration step: point a webhook
 * at `!abc:server` and it works.
 */
const isMatrixRoomId = (value: string): boolean => value.startsWith('!') || value.startsWith('#');

const compilePath = (path: string): { pattern: RegExp; keys: string[] } => {
  const keys: string[] = [];
  const pattern = path.replace(/:([A-Za-z_]+)/g, (_m, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  // The `/api` and `/v10` prefixes are optional so both the bare webhook URL
  // and the versioned API path resolve to the same route, exactly as on Discord.
  return { pattern: new RegExp(`^(?:/api)?(?:/v\\d+)?${pattern}/?$`), keys };
};


/** JSON body, or undefined for anything that does not parse as an object. */
const parseJsonBody = <T>(body: Buffer): T | undefined => {
  if (body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `m.thread` relation for a message posted into a thread.
 *
 * `is_falling_back` with the reply pointing at the root is the documented shape
 * for a threaded message that is not a reply to any particular message in it -
 * which is what a webhook post always is.
 */
const threadRelation = (rootEventId: string): Record<string, unknown> => ({
  rel_type: 'm.thread',
  event_id: rootEventId,
  is_falling_back: true,
  'm.in_reply_to': { event_id: rootEventId },
});

/** The msgtype a media event should carry, from the sniffed mime type. */
const msgtypeFor = (mimeType: string): 'm.image' | 'm.video' | 'm.audio' | 'm.file' => {
  if (mimeType.startsWith('image/')) return 'm.image';
  if (mimeType.startsWith('video/')) return 'm.video';
  if (mimeType.startsWith('audio/')) return 'm.audio';
  return 'm.file';
};

/**
 * Where a webhook's per-message identity rides.
 *
 * Namespaced under `in.prinny` rather than reusing an `m.` key: this is not a
 * Matrix feature, and squatting an unstable spec name would collide the day one
 * is standardised.
 */
export const WEBHOOK_IDENTITY_KEY = 'in.prinny.webhook';

export class WebhookServer {
  private readonly client: MatrixClient;

  private readonly store: WebhookStore;

  private readonly authTokens: string[];

  private readonly publicUrl: string;

  private readonly applicationId: string;

  private readonly maxBodyBytes: number;

  private readonly renderCtx: RenderContext;

  private readonly snowflakes: SnowflakeGenerator;

  private readonly routes: Route[] = [];

  private server?: Server;

  constructor(options: WebhookServerOptions) {
    this.client = options.client;
    this.store = options.store ?? new MemoryWebhookStore();
    this.authTokens = options.authTokens ?? [];
    this.publicUrl = (options.publicUrl ?? 'http://localhost').replace(/\/+$/, '');
    this.applicationId = options.applicationId ?? '0';
    this.maxBodyBytes = options.maxBodyBytes ?? 25 * 1024 * 1024;
    this.renderCtx = options.render ?? {};
    this.snowflakes = options.snowflakes ?? new SnowflakeGenerator();
    this.registerRoutes();
  }

  /**
   * Gives a Matrix room a Discord channel id, or returns the one it has.
   *
   * Idempotent by room: calling it twice never mints two ids for one room,
   * which would split a channel's webhooks across two identities.
   */
  registerChannel(roomId: string, options: { spaceId?: string; name?: string } = {}): StoredChannel {
    const existing = this.store.findChannelByRoom(roomId);
    if (existing) return existing;
    const guild = options.spaceId ? this.registerGuild(options.spaceId) : undefined;
    const channel: StoredChannel = { id: this.snowflakes.next(), roomId };
    if (guild) channel.guildId = guild.id;
    if (options.name !== undefined) channel.name = options.name;
    this.store.putChannel(channel);
    return channel;
  }

  /** Gives a Matrix space a Discord guild id, or returns the one it has. */
  registerGuild(spaceId: string, name?: string): StoredGuild {
    const existing = this.store.findGuildBySpace(spaceId);
    if (existing) return existing;
    const guild: StoredGuild = { id: this.snowflakes.next(), spaceId };
    if (name !== undefined) guild.name = name;
    this.store.putGuild(guild);
    return guild;
  }

  listen(port: number, host = '127.0.0.1'): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise((resolve) => {
      this.server?.listen(port, host, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /** The node request handler, exposed so it can be mounted in another server. */
  get requestListener(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.handle(req, res);
    };
  }

  private route(method: string, path: string, handler: Handler): void {
    const { pattern, keys } = compilePath(path);
    this.routes.push({ method, pattern, keys, handler });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendError(res, DiscordError.NotFound);
      return;
    }

    const path = decodeURI(url.pathname);
    const matches = this.routes
      .map((route) => ({ route, match: route.pattern.exec(path) }))
      .filter((entry) => entry.match !== null);

    if (matches.length === 0) {
      sendError(res, DiscordError.NotFound);
      return;
    }

    const chosen = matches.find((entry) => entry.route.method === (req.method ?? 'GET'));
    if (!chosen || !chosen.match) {
      sendError(res, DiscordError.MethodNotAllowed);
      return;
    }

    const params: RouteParams = {};
    chosen.route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(chosen.match?.[index + 1] ?? '');
    });

    let body: Buffer;
    try {
      body = await this.readBody(req);
    } catch {
      sendError(res, DiscordError.RequestTooLarge);
      return;
    }

    try {
      await chosen.route.handler(req, res, params, body, url);
    } catch (e) {
      // A handler that throws is a bug here, not a client error. Answering 500
      // with Discord's envelope keeps clients on their normal error path
      // instead of making them parse an HTML stack trace.
      if (!res.headersSent) {
        sendJson(res, 500, { code: 0, message: e instanceof Error ? e.message : 'Internal error' });
      }
    }
  }

  /**
   * Reads the body, refusing anything over the cap.
   *
   * The cap is enforced while reading rather than after: buffering an
   * unbounded upload and then rejecting it is a way to be knocked over by a
   * single request.
   */
  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          reject(new Error('too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }


  private registerRoutes(): void {
    // ── Management ───────────────────────────────────────────────────────────
    this.route('POST', '/channels/:channel/webhooks', async (req, res, params, body) => {
      if (!this.authorized(req)) {
        sendError(res, DiscordError.Unauthorized);
        return;
      }
      const channel = this.resolveChannel(params.channel ?? '');
      if (!channel) {
        sendError(res, DiscordError.UnknownChannel);
        return;
      }
      const payload = parseJsonBody<{ name?: string; avatar?: string | null }>(body);
      const name = payload?.name?.trim() ?? '';
      // Discord rejects names containing "clyde" or "discord", and names
      // outside 1-80 characters. Reproduced so a client's own validation and
      // ours agree about what will be refused.
      if (name.length < 1 || name.length > 80 || /clyde|discord/i.test(name)) {
        sendError(res, DiscordError.InvalidFormBody, {
          name: { _errors: [{ code: 'WEBHOOK_NAME_INVALID', message: 'Invalid webhook name' }] },
        });
        return;
      }

      const id = this.snowflakes.next();
      const token = generateWebhookToken();
      const webhook: DiscordWebhook = {
        id,
        type: WebhookType.Incoming,
        channel_id: channel.id,
        name,
        avatar: payload?.avatar ?? null,
        application_id: this.applicationId,
        user: this.selfUser(),
      };
      if (channel.guildId) webhook.guild_id = channel.guildId;

      const entry: StoredWebhook = { webhook, roomId: channel.roomId, token, createdAt: Date.now() };
      const guild = channel.guildId ? this.store.getGuild(channel.guildId) : undefined;
      if (guild) entry.spaceId = guild.spaceId;
      this.store.putWebhook(entry);

      sendJson(res, 200, this.webhookObject(entry, true));
    });

    this.route('GET', '/channels/:channel/webhooks', async (req, res, params) => {
      if (!this.authorized(req)) {
        sendError(res, DiscordError.Unauthorized);
        return;
      }
      const channel = this.resolveChannel(params.channel ?? '', false);
      if (!channel) {
        sendError(res, DiscordError.UnknownChannel);
        return;
      }
      const list = this.store
        .listWebhooks()
        .filter((entry) => entry.roomId === channel.roomId)
        .map((entry) => this.webhookObject(entry, true));
      sendJson(res, 200, list);
    });

    this.route('GET', '/guilds/:guild/webhooks', async (req, res, params) => {
      if (!this.authorized(req)) {
        sendError(res, DiscordError.Unauthorized);
        return;
      }
      const guildId = params.guild ?? '';
      const guild = this.store.getGuild(guildId) ?? this.store.findGuildBySpace(guildId);
      if (!guild) {
        sendJson(res, 200, []);
        return;
      }
      const list = this.store
        .listWebhooks()
        .filter((entry) => entry.spaceId === guild.spaceId)
        .map((entry) => this.webhookObject(entry, true));
      sendJson(res, 200, list);
    });

    this.route('GET', '/webhooks/:id', async (req, res, params) => {
      if (!this.authorized(req)) {
        sendError(res, DiscordError.Unauthorized);
        return;
      }
      const entry = this.store.getWebhook(params.id ?? '');
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      sendJson(res, 200, this.webhookObject(entry, true));
    });

    this.route('GET', '/webhooks/:id/:token', async (_req, res, params) => {
      const entry = this.authWebhook(params.id, params.token);
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      // "Same as above, except this call does not require authentication and
      // returns no user in the webhook object."
      sendJson(res, 200, this.webhookObject(entry, false));
    });

    this.route('PATCH', '/webhooks/:id', async (req, res, params, body) => {
      if (!this.authorized(req)) {
        sendError(res, DiscordError.Unauthorized);
        return;
      }
      const entry = this.store.getWebhook(params.id ?? '');
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      const payload = parseJsonBody<{
        name?: string;
        avatar?: string | null;
        channel_id?: string;
      }>(body);
      this.applyWebhookPatch(entry, payload ?? {}, true);
      sendJson(res, 200, this.webhookObject(entry, true));
    });

    this.route('PATCH', '/webhooks/:id/:token', async (_req, res, params, body) => {
      const entry = this.authWebhook(params.id, params.token);
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      const payload = parseJsonBody<{ name?: string; avatar?: string | null }>(body);
      // Token form: no channel_id accepted, no user returned.
      this.applyWebhookPatch(entry, payload ?? {}, false);
      sendJson(res, 200, this.webhookObject(entry, false));
    });

    this.route('DELETE', '/webhooks/:id', async (req, res, params) => {
      if (!this.authorized(req)) {
        sendError(res, DiscordError.Unauthorized);
        return;
      }
      if (!this.store.getWebhook(params.id ?? '')) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      this.store.deleteWebhook(params.id ?? '');
      sendEmpty(res, 204);
    });

    this.route('DELETE', '/webhooks/:id/:token', async (_req, res, params) => {
      const entry = this.authWebhook(params.id, params.token);
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      this.store.deleteWebhook(entry.webhook.id);
      sendEmpty(res, 204);
    });

    // ── Execute ──────────────────────────────────────────────────────────────
    this.route('POST', '/webhooks/:id/:token', async (req, res, params, body, url) => {
      const entry = this.authWebhook(params.id, params.token);
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      const parsed = this.parseExecuteRequest(req, body);
      if (!parsed) {
        sendError(res, DiscordError.InvalidFormBody);
        return;
      }
      await this.execute(res, entry, parsed.payload, parsed.files, url);
    });

    this.route('POST', '/webhooks/:id/:token/slack', async (req, res, params, body, url) => {
      const entry = this.authWebhook(params.id, params.token);
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      const slack = parseJsonBody<SlackWebhookBody>(body);
      if (!slack) {
        sendError(res, DiscordError.InvalidFormBody);
        return;
      }
      // Slack's endpoint defaults `wait` to true, unlike the native one.
      await this.execute(res, entry, slackToExecuteBody(slack), [], url, true);
    });

    this.route('POST', '/webhooks/:id/:token/github', async (req, res, params, body, url) => {
      const entry = this.authWebhook(params.id, params.token);
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      const payload = parseJsonBody<Record<string, unknown>>(body);
      if (!payload) {
        sendError(res, DiscordError.InvalidFormBody);
        return;
      }
      const event = req.headers['x-github-event'];
      const executeBody = githubToExecuteBody(
        Array.isArray(event) ? event[0] : event,
        payload
      );
      if (!executeBody) {
        // Nothing to say for this event - including `ping`, which GitHub sends
        // when the hook is saved. 204 tells GitHub the delivery succeeded,
        // which is true: it was received and deliberately not rendered.
        sendEmpty(res, 204);
        return;
      }
      await this.execute(res, entry, executeBody, [], url, true);
    });

    // ── Webhook messages ─────────────────────────────────────────────────────
    this.route('GET', '/webhooks/:id/:token/messages/:message', async (_req, res, params) => {
      const entry = this.authWebhook(params.id, params.token);
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      const stored = this.lookupMessage(entry, params.message ?? '');
      if (!stored) {
        sendError(res, DiscordError.UnknownMessage);
        return;
      }
      sendJson(res, 200, await this.messageObject(entry, stored));
    });

    this.route(
      'PATCH',
      '/webhooks/:id/:token/messages/:message',
      async (req, res, params, body) => {
        const entry = this.authWebhook(params.id, params.token);
        if (!entry) {
          sendError(res, DiscordError.UnknownWebhook);
          return;
        }
        const stored = this.lookupMessage(entry, params.message ?? '');
        if (!stored) {
          sendError(res, DiscordError.UnknownMessage);
          return;
        }
        const parsed = this.parseExecuteRequest(req, body);
        if (!parsed) {
          sendError(res, DiscordError.InvalidFormBody);
          return;
        }
        await this.editMessage(res, entry, stored, parsed.payload as EditWebhookMessageBody);
      }
    );

    this.route('DELETE', '/webhooks/:id/:token/messages/:message', async (_req, res, params) => {
      const entry = this.authWebhook(params.id, params.token);
      if (!entry) {
        sendError(res, DiscordError.UnknownWebhook);
        return;
      }
      const stored = this.lookupMessage(entry, params.message ?? '');
      if (!stored) {
        sendError(res, DiscordError.UnknownMessage);
        return;
      }
      await this.client.redactEvent(stored.roomId, stored.eventId);
      this.store.deleteMessage(stored.id);
      sendEmpty(res, 204);
    });
  }

  private selfUser(): DiscordUser {
    const userId = this.client.getUserId() ?? '@bot:localhost';
    return {
      id: this.applicationId,
      username: userId.replace(/^@/, '').split(':')[0] ?? 'bot',
      discriminator: '0000',
      avatar: null,
      bot: true,
    };
  }

  private webhookObject(entry: StoredWebhook, withUser: boolean): DiscordWebhook {
    const webhook: DiscordWebhook = { ...entry.webhook };
    webhook.token = entry.token;
    webhook.url = `${this.publicUrl}/api/webhooks/${webhook.id}/${entry.token}`;
    if (!withUser) delete webhook.user;
    return webhook;
  }

  /**
   * A channel id, a Matrix room id, or nothing.
   *
   * `create` decides whether an unknown Matrix room id is registered on the
   * spot. Listing must not register - a GET that mints an id would create a
   * channel for every typo anyone probes the server with.
   */
  private resolveChannel(value: string, create = true): StoredChannel | undefined {
    const known = this.store.getChannel(value);
    if (known) return known;
    if (!isMatrixRoomId(value)) return undefined;
    const byRoom = this.store.findChannelByRoom(value);
    if (byRoom) return byRoom;
    return create ? this.registerChannel(value) : undefined;
  }

  private authWebhook(id: string | undefined, token: string | undefined): StoredWebhook | undefined {
    if (!id || !token) return undefined;
    const entry = this.store.getWebhook(id);
    if (!entry) return undefined;
    // Unknown id and wrong token deliberately answer the same 404: a different
    // response for "exists but wrong token" turns the endpoint into an oracle
    // for which webhook ids are real.
    return tokensMatch(entry.token, token) ? entry : undefined;
  }

  private applyWebhookPatch(
    entry: StoredWebhook,
    payload: { name?: string; avatar?: string | null; channel_id?: string },
    allowChannelMove: boolean
  ): void {
    if (typeof payload.name === 'string') entry.webhook.name = payload.name;
    if (payload.avatar !== undefined) entry.webhook.avatar = payload.avatar;
    if (allowChannelMove && typeof payload.channel_id === 'string') {
      const channel = this.resolveChannel(payload.channel_id);
      if (channel) {
        entry.webhook.channel_id = channel.id;
        entry.roomId = channel.roomId;
      }
    }
    this.store.putWebhook(entry);
  }

  private lookupMessage(entry: StoredWebhook, messageId: string): StoredMessage | undefined {
    const stored = this.store.getMessage(messageId);
    if (!stored || stored.webhookId !== entry.webhook.id) return undefined;
    return stored;
  }


  /**
   * Reads an Execute Webhook body in either of its two forms.
   *
   * JSON is the simple case. `multipart/form-data` is the one that carries
   * files, and there the JSON lives in the `payload_json` part while the files
   * arrive as `files[n]` - the index being what `attachments[].id` refers to,
   * which is how a caller says which attachment description belongs to which
   * uploaded file.
   */
  private parseExecuteRequest(
    req: IncomingMessage,
    body: Buffer
  ): { payload: ExecuteWebhookBody; files: UploadedFile[] } | undefined {
    const contentType = req.headers['content-type'];
    const boundary = parseBoundary(Array.isArray(contentType) ? contentType[0] : contentType);

    if (boundary === null) {
      if (body.length === 0) return { payload: {}, files: [] };
      const payload = parseJsonBody<ExecuteWebhookBody>(body);
      return payload ? { payload, files: [] } : undefined;
    }

    const fields = parseMultipart(body, boundary);
    const files: UploadedFile[] = [];
    let payload: ExecuteWebhookBody = {};

    fields.forEach((field) => {
      if (field.name === 'payload_json') {
        payload = parseJsonBody<ExecuteWebhookBody>(field.data) ?? {};
        return;
      }
      const match = /^files?\[(\d+)\]$/.exec(field.name);
      // `file` with no index is the legacy single-file form and still in the
      // wild; it is treated as index 0 rather than dropped.
      const index = match?.[1] !== undefined ? Number(match[1]) : field.name === 'file' ? 0 : -1;
      if (index < 0) return;
      files.push({
        index,
        filename: field.filename ?? `file-${index}`,
        contentType: field.contentType ?? 'application/octet-stream',
        data: field.data,
      });
    });

    return { payload, files };
  }

  /**
   * Turns an Execute Webhook payload into Matrix events.
   *
   * One text event carries content, embeds and components together, because
   * they are one message on Discord and splitting them would break both the
   * reply target and the "edit this message" contract. Files are separate
   * events - Matrix has no multi-attachment message - and the text event is the
   * one the returned message id refers to, so editing works.
   */
  private async execute(
    res: ServerResponse,
    entry: StoredWebhook,
    payload: ExecuteWebhookBody,
    files: UploadedFile[],
    url: URL,
    waitDefault = false
  ): Promise<void> {
    const waitParam = url.searchParams.get('wait');
    const wait = waitParam === null ? waitDefault : waitParam === 'true' || waitParam === '1';
    const withComponents = url.searchParams.get('with_components') === 'true';

    // `payload_json` inside a JSON body is not a thing, but a client that sends
    // the multipart shape with a JSON content-type is, and honouring it costs
    // one line and saves an unexplainable 400.
    const merged: ExecuteWebhookBody = payload.payload_json
      ? { ...payload, ...(parseJsonBody<ExecuteWebhookBody>(Buffer.from(payload.payload_json)) ?? {}) }
      : payload;

    const componentsV2 = ((merged.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
    if (componentsV2 && (merged.content || merged.embeds?.length || merged.poll)) {
      // Discord answers 400 for exactly this combination.
      sendError(res, DiscordError.InvalidFormBody, {
        flags: {
          _errors: [
            {
              code: 'COMPONENTS_V2_EXCLUSIVE',
              message: 'A components v2 message may only contain components',
            },
          ],
        },
      });
      return;
    }

    const hasSomething =
      Boolean(merged.content) ||
      (merged.embeds?.length ?? 0) > 0 ||
      (merged.components?.length ?? 0) > 0 ||
      files.length > 0 ||
      Boolean(merged.poll);
    if (!hasSomething) {
      sendError(res, DiscordError.CannotSendEmpty);
      return;
    }

    const threadRoot = this.resolveThread(entry, url.searchParams.get('thread_id'));
    const roomId = entry.roomId;

    // A forum-style `thread_name` creates the thread by posting its root, then
    // everything else lands underneath it.
    let rootEventId = threadRoot;
    if (!rootEventId && merged.thread_name) {
      const created = await this.client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: merged.thread_name,
      } as never);
      rootEventId = created.event_id;
    }

    const content = this.buildMessageContent(entry, merged, withComponents);

    let primaryEventId: string | undefined;
    if (content) {
      if (rootEventId) content['m.relates_to'] = threadRelation(rootEventId);
      const sent = await this.client.sendMessage(roomId, content as never);
      primaryEventId = sent.event_id;
    }

    if (merged.poll) {
      const pollContent = renderPoll(merged.poll);
      if (rootEventId) pollContent['m.relates_to'] = threadRelation(rootEventId);
      const sent = await this.client.sendEvent(
        roomId,
        'org.matrix.msc3381.poll.start' as never,
        pollContent as never
      );
      primaryEventId = primaryEventId ?? sent.event_id;
    }

    for (const file of files) {
      const described = (merged.attachments ?? []).find(
        (attachment) => String(attachment.id) === String(file.index)
      );
      const uploaded = await uploadAttachment(this.client, roomId, {
        data: file.data,
        filename: described?.filename ?? file.filename,
        mimeType: file.contentType,
      });
      const mediaContent = buildMediaContent(
        msgtypeFor(uploaded.mimeType),
        described?.filename ?? file.filename,
        uploaded
      );
      if (described?.description) mediaContent.body = described.description;
      if (rootEventId) mediaContent['m.relates_to'] = threadRelation(rootEventId);
      const sent = await this.client.sendMessage(roomId, mediaContent as never);
      primaryEventId = primaryEventId ?? sent.event_id;
    }

    if (!primaryEventId) {
      sendError(res, DiscordError.CannotSendEmpty);
      return;
    }

    const stored: StoredMessage = {
      id: this.snowflakes.next(),
      webhookId: entry.webhook.id,
      roomId,
      eventId: primaryEventId,
      channelId: entry.webhook.channel_id ?? '',
      createdAt: Date.now(),
    };
    if (rootEventId) stored.threadId = rootEventId;
    this.store.putMessage(stored);

    if (!wait) {
      sendEmpty(res, 204);
      return;
    }
    sendJson(res, 200, await this.messageObject(entry, stored, merged));
  }

  /**
   * `thread_id` is a channel id on Discord and a thread ROOT EVENT on Matrix.
   *
   * Both spellings are accepted: a message id previously returned by this
   * server (its event is the thread root), or a registered channel id whose
   * room is the one being posted to.
   */
  private resolveThread(entry: StoredWebhook, threadId: string | null): string | undefined {
    if (!threadId) return undefined;
    // A message id this server handed out: its event is the thread root, or
    // it is already inside one.
    const message = this.store.getMessage(threadId);
    if (message && message.roomId === entry.roomId) return message.threadId ?? message.eventId;
    // A raw Matrix event id names a thread root directly, which is the form
    // anything Matrix-aware will have.
    if (threadId.startsWith('$')) return threadId;
    // Anything else - a channel id, an id from another room, a stale thread -
    // posts to the room rather than to the wrong thread.
    return undefined;
  }

  /**
   * The one text event: content, embeds and components together.
   *
   * Returns undefined when there is nothing but files or a poll to send, so the
   * caller does not post an empty message before the attachment.
   */
  private buildMessageContent(
    entry: StoredWebhook,
    payload: ExecuteWebhookBody,
    withComponents: boolean
  ): Record<string, unknown> | undefined {
    const allowEveryone = everyoneAllowed(payload.allowed_mentions);
    const rendered = payload.content
      ? renderDiscordText(payload.content, this.renderCtx, { allowEveryone })
      : { html: '', text: '' };

    const suppressEmbeds = ((payload.flags ?? 0) & MessageFlags.SuppressEmbeds) !== 0;
    const embeds = suppressEmbeds
      ? []
      : (payload.embeds ?? []).slice(0, 10).map((embed) => renderEmbed(embed, this.renderCtx));

    // Non-application webhooks only get components when `with_components` is
    // set, which is Discord's rule and not an invention here.
    const components = withComponents
      ? renderComponents(payload.components, this.renderCtx)
      : { html: '', text: '', markup: undefined };

    const htmlParts = [rendered.html, ...embeds.map((embed) => embed.html), components.html].filter(
      (part) => part !== ''
    );
    const textParts = [rendered.text, ...embeds.map((embed) => embed.text), components.text].filter(
      (part) => part !== ''
    );

    if (htmlParts.length === 0) return undefined;

    const html = htmlParts.join('<br/>');
    const text = textParts.join('\n');
    const bodies = buildFallbackBodies(text, html, components.markup);

    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      format: 'org.matrix.custom.html',
      ...bodies,
      'm.mentions': buildMentions(payload.allowed_mentions, [], payload.flags),
    };
    if (components.markup) content[BotContentKey.ReplyMarkup] = components.markup;

    const identity = this.webhookIdentity(entry, payload);
    if (identity) content[WEBHOOK_IDENTITY_KEY] = identity;

    return content;
  }

  /**
   * `username` and `avatar_url` - a per-message sender identity.
   *
   * Matrix has no such thing: a message is from the account that sent it, full
   * stop, and only an application service can speak as a ghost user. Rather
   * than silently dropping the fields (so every CI job posts as "prinny-bot")
   * or renaming the bot account per message (a race, and visible to everyone in
   * the room), they ride in a content key the Prinny client renders as the
   * message's author - which is exactly what Discord shows for a webhook.
   *
   * Clients that do not know the key show the bot's own name, which is true.
   * The name is also prefixed into the fallback body for the same reason.
   */
  private webhookIdentity(
    entry: StoredWebhook,
    payload: ExecuteWebhookBody
  ): Record<string, unknown> | undefined {
    const username = payload.username ?? entry.webhook.name ?? undefined;
    if (!username && !payload.avatar_url) return undefined;
    const identity: Record<string, unknown> = { id: entry.webhook.id };
    if (username) identity.username = username;
    if (payload.avatar_url) identity.avatar_url = payload.avatar_url;
    return identity;
  }

  /** Discord's message object for a message this server sent. */
  private async messageObject(
    entry: StoredWebhook,
    stored: StoredMessage,
    payload?: ExecuteWebhookBody
  ): Promise<DiscordMessage> {
    const event = await this.fetchEvent(stored);
    const content = (event?.content ?? {}) as Record<string, unknown>;
    const username = (payload?.username ?? entry.webhook.name) ?? 'webhook';

    return {
      id: stored.id,
      type: 0,
      channel_id: stored.channelId,
      author: {
        id: entry.webhook.id,
        username,
        discriminator: '0000',
        avatar: null,
        bot: true,
      },
      content: typeof content.body === 'string' ? content.body : (payload?.content ?? ''),
      timestamp: new Date(stored.createdAt).toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: Boolean((content['m.mentions'] as { room?: boolean } | undefined)?.room),
      mentions: [],
      mention_roles: [],
      attachments: (payload?.attachments ?? []) as AttachmentRequest[],
      embeds: payload?.embeds ?? [],
      components: payload?.components ?? [],
      pinned: false,
      webhook_id: entry.webhook.id,
      flags: payload?.flags ?? 0,
    };
  }

  private async fetchEvent(
    stored: StoredMessage
  ): Promise<{ content?: unknown } | undefined> {
    try {
      const event = await this.client.fetchRoomEvent(stored.roomId, stored.eventId);
      return event as { content?: unknown };
    } catch {
      // The event may be gone (redacted) or unreadable. The message object is
      // still worth returning: its id, channel and author are all known here.
      return undefined;
    }
  }

  /**
   * Edit Webhook Message.
   *
   * Discord replaces the fields present in the body and leaves absent ones
   * alone, with `null` meaning "clear". Matrix edits are whole-content
   * replacements, so the new content is rebuilt from the merged payload rather
   * than patched onto the old event.
   */
  private async editMessage(
    res: ServerResponse,
    entry: StoredWebhook,
    stored: StoredMessage,
    payload: EditWebhookMessageBody
  ): Promise<void> {
    const executeBody: ExecuteWebhookBody = {};
    if (payload.content !== undefined && payload.content !== null) {
      executeBody.content = payload.content;
    }
    if (payload.embeds !== undefined && payload.embeds !== null) executeBody.embeds = payload.embeds;
    if (payload.components !== undefined && payload.components !== null) {
      executeBody.components = payload.components;
    }
    if (payload.allowed_mentions !== undefined && payload.allowed_mentions !== null) {
      executeBody.allowed_mentions = payload.allowed_mentions;
    }
    if (payload.flags !== undefined && payload.flags !== null) executeBody.flags = payload.flags;

    const content = this.buildMessageContent(entry, executeBody, true);
    if (!content) {
      sendError(res, DiscordError.CannotSendEmpty);
      return;
    }

    const newContent = { ...content };
    delete newContent['m.relates_to'];

    await this.client.sendMessage(stored.roomId, {
      ...content,
      body: `* ${String(content.body ?? '')}`,
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: stored.eventId },
    } as never);

    sendJson(res, 200, await this.messageObject(entry, stored, executeBody));
  }

  private authorized(req: IncomingMessage): boolean {
    if (this.authTokens.length === 0) return false;
    const header = req.headers.authorization ?? '';
    const provided = header.replace(/^Bot\s+/i, '').trim();
    if (provided === '') return false;
    return this.authTokens.some((token) => tokensMatch(token, provided));
  }
}
