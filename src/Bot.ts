/**
 * The bot: client lifecycle, event routing, and command publishing.
 *
 * The Matrix plumbing here — crypto store, cross-signing bootstrap, the
 * decrypt-aware dispatcher, SAS auto-verification — is ported from
 * openclaude's `src/services/matrix/bot.ts`, which learned each of these the
 * hard way. The comments explaining *why* each one exists are the valuable
 * part; none of them are obvious from the matrix-js-sdk API.
 */

import {
  ClientEvent,
  MatrixEventEvent,
  RoomEvent,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowSasCallbacks,
  type VerificationRequest,
} from 'matrix-js-sdk/lib/crypto-api/index.js';

import { Api } from './Api.js';
import { Composer } from './Composer.js';
import { Context, type CallbackQuery, type CommandMatch, type UpdateKind } from './Context.js';
import { AccessControl, RateLimiter, type AccessOptions, type RateLimitOptions } from './access.js';
import { CommandRegistry, isCommandForBot, parseCommand, type CommandDefinition } from './commands.js';
import { flushCryptoStore, initCryptoStore } from './matrix/cryptoStore.js';
import { BotContentKey, BotEventType, BotRelType } from './protocol/constants.js';
import type { BotInfo, MenuButton, ReplyMarkup } from './protocol/types.js';
import { isInlineKeyboardMarkup } from './protocol/types.js';
import { sanitizeReplyMarkup } from './protocol/validate.js';
import { matchFallbackReply, plainBodyOf } from './keyboard/fallback.js';
import { SessionManager, type SessionOptions } from './session.js';

export type BotOptions<S> = {
  homeserverUrl: string;
  userId: string;
  /** Either this or `password`. A token avoids a login round trip on boot. */
  accessToken?: string;
  /**
   * Password login, used once to mint a token.
   *
   * Also the only way to bootstrap cross-signing, which needs user-interactive
   * auth — see `ensureCrossSigning`.
   */
  password?: string;
  deviceId?: string;

  /** Rust crypto database prefix. Default `.prinny-bot/store`. */
  storePath?: string;
  /** JSON snapshot of the crypto store. Default `.prinny-bot/crypto-store.json`. */
  cryptoSnapshotPath?: string;
  /** Encrypts the crypto store at rest. A store is not portable across this setting. */
  storePassphrase?: string;
  /**
   * Run even if E2EE could not be initialised.
   *
   * Off by default and it should stay off: without this guard a crypto failure
   * silently downgrades the bot to plaintext in rooms everyone believes are
   * encrypted.
   */
  allowUnencrypted?: boolean;

  /** Accept room invites automatically. Default true. */
  autoJoin?: boolean;
  /** Publish the command list into rooms as they are joined. Default true. */
  autoPublishCommands?: boolean;
  /**
   * Treat a plain "1" or "Deploy" reply as a press of the matching button on
   * the bot's most recent keyboard in that room. Default true.
   *
   * This is what makes one handler serve both Prinny users, who click, and
   * everyone else, who types.
   */
  matchFallbackReplies?: boolean;

  /**
   * Pass `false` to let every sender through, because the application gates
   * instead — a channel bridge with its own allowlist, for example. Without
   * that, the built-in control refuses unknown senders *and says so*, which a
   * bridge doing silent drops does not want.
   */
  access?: AccessOptions | false;
  /** Pass `false` to disable. Default 10 messages per 5 minutes, owner exempt. */
  rateLimit?: RateLimitOptions | false;
  session?: SessionOptions<S>;

  initialSyncLimit?: number;
  /**
   * Also deliver messages sent at or after this timestamp, even though they
   * predate this run.
   *
   * By default a bot ignores everything older than its own startup, so a
   * restart never re-answers a conversation it already handled. That is the
   * right default and the wrong one for a bridge, which must pick up whatever
   * arrived while it was down. Pass the watermark of the last message you
   * actually delivered.
   *
   * Bounded by `initialSyncLimit`: the catch-up can only see what the initial
   * sync returns per room, so raise that alongside this for longer outages.
   */
  catchUpFrom?: number;
  /** Called after a password login mints new credentials worth storing. */
  onCredentials?: (credentials: { accessToken: string; deviceId?: string }) => void;
  logger?: (message: string) => void;
};

const DEFAULT_STORE_PATH = '.prinny-bot/store';
const DEFAULT_SNAPSHOT_PATH = '.prinny-bot/crypto-store.json';

/** How far back to look for the keyboard a plain-text reply refers to. */
const FALLBACK_SCAN_DEPTH = 40;

export class Bot<S = Record<string, unknown>> extends Composer<Context<S>> {
  readonly registry = new CommandRegistry();

  readonly access: AccessControl;

  private client!: MatrixClient;

  private apiInstance: Api | undefined;

  private readonly options: BotOptions<S>;

  private readonly rateLimiter: RateLimiter | null;

  private readonly sessions: SessionManager<S>;

  private readonly log: (message: string) => void;

  /**
   * Event ids already handled.
   *
   * The timeline listener and the late-decryption listener can both deliver
   * the same event, and without this the bot answers twice.
   */
  private readonly processed = new Set<string>();

  private startupTs = 0;

  private running = false;

  private errorHandler: ((error: unknown, ctx: Context<S>) => unknown | Promise<unknown>) | undefined;

  constructor(options: BotOptions<S>) {
    super();
    this.options = options;
    this.log = options.logger ?? ((message) => process.stderr.write(`[prinny-bot] ${message}\n`));
    this.access = new AccessControl(
      options.access === false ? { allowAll: true } : options.access
    );
    this.rateLimiter =
      options.rateLimit === false ? null : new RateLimiter(options.rateLimit ?? {});
    this.sessions = new SessionManager<S>(
      options.session ?? { initial: () => ({}) as S }
    );
  }

  get api(): Api {
    if (!this.apiInstance) {
      throw new Error('Bot has not been started yet — call await bot.start() first.');
    }
    return this.apiInstance;
  }

  get matrixClient(): MatrixClient {
    if (!this.client) {
      throw new Error('Bot has not been started yet — call await bot.start() first.');
    }
    return this.client;
  }

  get userId(): string {
    return this.options.userId;
  }

  /** Global error handler. Scoped alternative: `errorBoundary()`. */
  catch(handler: (error: unknown, ctx: Context<S>) => unknown | Promise<unknown>): this {
    this.errorHandler = handler;
    return this;
  }

  // ── Advertisement ──────────────────────────────────────────────────────────

  /**
   * Telegram's `setMyCommands`.
   *
   * Republishes into every joined room, because Matrix has no central place to
   * register commands — the list only exists where the bot has written it.
   */
  async setMyCommands(commands: CommandDefinition[]): Promise<void> {
    this.registry.setCommands(commands);
    if (this.running) await this.publishToAllRooms();
  }

  /** Telegram's `setMyName` / `setMyDescription` / `setMyShortDescription`. */
  async setMyProfile(profile: {
    name?: string;
    description?: string;
    short_description?: string;
    privacy_mode?: boolean;
  }): Promise<void> {
    this.registry.setProfile(profile);
    if (this.running) await this.publishToAllRooms();
  }

  /** Telegram's `setChatMenuButton`, applied everywhere. */
  async setChatMenuButton(menuButton: MenuButton): Promise<void> {
    this.registry.setMenuButton(menuButton);
    if (this.running) await this.publishToAllRooms();
  }

  botInfo(): BotInfo {
    return this.registry.toBotInfo();
  }

  /**
   * Advertise the command list into one room.
   *
   * Public because a bot that turns `autoJoin` off and joins on its own terms
   * still has to publish after each join, and republishing everywhere for one
   * new room is the wrong shape.
   */
  async publishTo(roomId: string): Promise<void> {
    const result = await this.api.publishBotInfo(roomId, this.botInfo());
    if (result === 'timeline') {
      this.log(
        `published commands to ${roomId} as a timeline event — no power to set state there, ` +
          'so clients that join later will not see them until the bot re-advertises'
      );
    } else if (result === 'failed') {
      this.log(`could not publish commands to ${roomId}`);
    }
  }

  /**
   * Advertise into every joined room, one at a time.
   *
   * Sequential rather than `Promise.all`: firing a send per room at once is
   * exactly the shape a homeserver rate-limits, and a bot in four rooms had
   * three of its four publishes rejected with `M_LIMIT_EXCEEDED`. The retry in
   * `publishBotInfo` recovers from a burst, but not creating the burst is
   * cheaper — this runs once at startup and once per join, so the latency
   * costs nothing.
   */
  private async publishToAllRooms(): Promise<void> {
    const rooms = this.client.getRooms().filter((room) => room.getMyMembership() === 'join');
    for (const room of rooms) {
      await this.publishTo(room.roomId).catch(() => undefined);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const { homeserverUrl, userId } = this.options;
    if (!homeserverUrl) throw new Error('homeserverUrl is required');
    if (!userId) throw new Error('userId is required');

    let accessToken = this.options.accessToken;
    let deviceId = this.options.deviceId;

    if (!accessToken && this.options.password) {
      this.log('logging in with password…');
      const temp = createClient({ baseUrl: homeserverUrl });
      const login = await temp.loginWithPassword(userId, this.options.password);
      accessToken = login.access_token;
      deviceId = login.device_id ?? deviceId;
      this.log(`login OK, device ${deviceId ?? '(unknown)'}`);
      this.options.onCredentials?.({ accessToken, deviceId });
    }

    if (!accessToken) {
      throw new Error('No access token. Pass `accessToken`, or `password` to log in once.');
    }

    this.client = createClient({ baseUrl: homeserverUrl, accessToken, userId, deviceId });
    this.apiInstance = new Api(this.client);

    await this.initCrypto();
    await this.ensureCrossSigning();
    this.wireVerification();
    this.wireEvents();

    this.startupTs = Date.now();
    await this.client.startClient({ initialSyncLimit: this.options.initialSyncLimit ?? 10 });
    this.running = true;
    this.log('sync started');

    if (this.options.autoPublishCommands !== false) {
      // Wait for the first sync, or there are no rooms to publish into yet.
      await this.onceSynced();
      await this.publishToAllRooms();
    }
  }

  private onceSynced(): Promise<void> {
    return new Promise((resolve) => {
      const onSync = (state: string) => {
        if (state !== 'PREPARED' && state !== 'SYNCING') return;
        this.client.off(ClientEvent.Sync, onSync);
        resolve();
      };
      this.client.on(ClientEvent.Sync, onSync);
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.client.stopClient();
    // Flush before exit or the last few minutes of Olm state — including
    // sessions for messages already received — is lost, and peers have to
    // re-key on the next boot.
    await flushCryptoStore().catch(() => undefined);
    this.log('stopped');
  }

  private async initCrypto(): Promise<void> {
    const storePath = this.options.storePath ?? DEFAULT_STORE_PATH;
    const snapshotPath = this.options.cryptoSnapshotPath ?? DEFAULT_SNAPSHOT_PATH;

    // Must precede initRustCrypto: the snapshot restores the Olm account into
    // IndexedDB, and crypto reads it at init. Restore afterwards and the bot
    // has already minted a new device identity.
    await initCryptoStore(snapshotPath);

    let encrypted = false;
    try {
      await this.client.initRustCrypto({
        cryptoDatabasePrefix: storePath,
        ...(this.options.storePassphrase
          ? { storagePassword: this.options.storePassphrase }
          : {}),
      });
      encrypted = true;
      this.log(
        `crypto ready (store: ${storePath}${this.options.storePassphrase ? ', encrypted at rest' : ''})`
      );
    } catch (error) {
      this.log(`initRustCrypto failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!encrypted && !this.options.allowUnencrypted) {
      throw new Error(
        'E2EE could not be initialised, and refusing to run unencrypted. ' +
          'Fix the crypto store, or pass allowUnencrypted: true to override.'
      );
    }
    if (!encrypted) {
      this.log('WARNING: running without end-to-end encryption — messages are NOT encrypted.');
    }
  }

  /**
   * Self-sign the bot's device.
   *
   * Without cross-signing the device reads as unverified-by-its-own-user, and
   * modern clients exclude it from megolm key sharing — so the bot receives
   * encrypted events it can never decrypt, which presents as "the bot ignores
   * me" with nothing in the logs. Needs UIA, so it only works with a password.
   */
  private async ensureCrossSigning(): Promise<void> {
    const crypto = this.client.getCrypto?.();
    if (!crypto) return;

    try {
      if (await crypto.isCrossSigningReady()) return;
      const { password, userId } = this.options;
      if (!password) {
        this.log(
          'cross-signing is not set up and no password is available — peers may exclude this ' +
            'device from key sharing. Start once with a password to bootstrap it.'
        );
        return;
      }
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (makeRequest) => {
          await makeRequest({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: userId },
            user: userId,
            password,
          } as never);
        },
      });
      this.log('cross-signing bootstrapped — this device is now self-signed');
    } catch (error) {
      this.log(
        `cross-signing bootstrap failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Auto-accept SAS verification, but only from the owner or an allowlisted user.
   *
   * A bot cannot look at emoji, so it confirms blind. Confirming blind for
   * *anyone* would let a stranger get the bot to cryptographically vouch for
   * their device — trust laundering — so everyone else is cancelled.
   */
  private wireVerification(): void {
    const crypto = this.client.getCrypto?.();
    if (!crypto) return;

    this.client.on(CryptoEvent.VerificationRequestReceived, async (request: VerificationRequest) => {
      const other = request.otherUserId;
      if (!this.access.isOwner(other) && !this.access.isAllowed(other)) {
        this.log(`refusing verification from non-allowlisted ${other}`);
        await request.cancel({ reason: 'not authorized', code: 'm.user' }).catch(() => undefined);
        return;
      }

      let attached = false;
      const attachVerifier = async () => {
        const verifier = request.verifier;
        if (!verifier || attached) return;
        attached = true;
        verifier.on(VerifierEvent.ShowSas, (sas: ShowSasCallbacks) => {
          void sas.confirm();
        });
        try {
          await verifier.verify();
          this.log(`verification complete with ${other}`);
        } catch (error) {
          this.log(`verify failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      try {
        if (request.phase === VerificationPhase.Requested) await request.accept();
        request.on(VerificationRequestEvent.Change, () => void attachVerifier());
        await attachVerifier();
      } catch (error) {
        this.log(`verification error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  // ── Event routing ──────────────────────────────────────────────────────────

  private wireEvents(): void {
    this.client.on(RoomEvent.MyMembership, async (room: Room, membership: string) => {
      if (membership === 'invite' && this.options.autoJoin !== false) {
        this.log(`invited to ${room.roomId}, joining`);
        try {
          await this.client.joinRoom(room.roomId);
          if (this.options.autoPublishCommands !== false) await this.publishTo(room.roomId);
        } catch (error) {
          this.log(
            `join ${room.roomId} failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    });

    this.client.on(
      RoomEvent.Timeline,
      (
        event: MatrixEvent,
        room: Room | undefined,
        _toStart?: boolean,
        _removed?: boolean,
        data?: { liveEvent?: boolean }
      ) => {
        void this.dispatchEvent(event, room, !(data && data.liveEvent === false));
      }
    );

    // An event that arrived encrypted decrypts once its megolm key shows up,
    // often a beat later. RoomEvent.Timeline does not fire again, so without
    // this the bot silently drops the first message after every key rotation.
    this.client.on(MatrixEventEvent.Decrypted, (event: MatrixEvent) => {
      const roomId = event.getRoomId();
      const room = roomId ? (this.client.getRoom(roomId) ?? undefined) : undefined;
      void this.dispatchEvent(event, room, true);
    });
  }

  private async dispatchEvent(
    event: MatrixEvent,
    room: Room | undefined,
    live: boolean
  ): Promise<void> {
    if (!room || !live) return;
    if (event.getSender() === this.options.userId) return;

    // Normally nothing older than startup is delivered, so a restart does not
    // re-answer old conversations. `catchUpFrom` lowers that floor for a
    // caller that tracks what it has already handled.
    const floor =
      this.options.catchUpFrom !== undefined
        ? Math.min(this.options.catchUpFrom, this.startupTs)
        : this.startupTs;
    const ts = event.getTs();
    if (typeof ts === 'number' && ts < floor) return;

    if (event.isEncrypted()) {
      try {
        await this.client.decryptEventIfNeeded(event);
      } catch {
        // Leave it; the Decrypted listener picks it up if the key arrives.
      }
      if (event.isDecryptionFailure()) return;
    }

    const eventId = event.getId();
    if (!eventId || this.processed.has(eventId)) return;
    this.processed.add(eventId);
    // Bounded so a long-lived bot does not accumulate every event id it has
    // ever seen. Far larger than any plausible redelivery window.
    if (this.processed.size > 5000) {
      const oldest = this.processed.values().next().value;
      if (oldest !== undefined) this.processed.delete(oldest);
    }

    try {
      await this.route(event, room);
    } catch (error) {
      this.log(`handler error: ${error instanceof Error ? error.stack : String(error)}`);
    }
  }

  private kindOf(event: MatrixEvent): UpdateKind {
    switch (event.getType()) {
      case 'm.room.message':
        return 'message';
      case BotEventType.Callback:
        return 'callback_query';
      case 'm.room.member':
        return 'membership';
      case 'm.reaction':
        return 'reaction';
      default:
        return 'other';
    }
  }

  /** Read sanitised reply markup off an event, or null. */
  private markupOf(event: MatrixEvent | undefined): ReplyMarkup | null {
    if (!event) return null;
    const content = event.getContent() as Record<string, unknown>;
    return sanitizeReplyMarkup(content[BotContentKey.ReplyMarkup]);
  }

  /** Build a `CallbackQuery` from an `app.prinny.bot.callback` event. */
  private callbackQueryOf(event: MatrixEvent, room: Room): CallbackQuery | undefined {
    const content = event.getContent() as Record<string, unknown>;
    const relation = content['m.relates_to'] as
      | { rel_type?: string; event_id?: string }
      | undefined;
    if (relation?.rel_type !== BotRelType.Callback || !relation.event_id) return undefined;
    if (typeof content.id !== 'string' || typeof content.data !== 'string') return undefined;

    const target = room.findEventById(relation.event_id);
    // Only honour a press against a message this bot actually sent. Otherwise
    // any member could forge a callback naming someone else's message and have
    // the bot act on it.
    if (target && target.getSender() !== this.options.userId) return undefined;

    const query: CallbackQuery = {
      id: content.id,
      data: content.data,
      message: { event_id: relation.event_id },
      from: event.getSender() ?? '',
    };
    const markup = this.markupOf(target);
    if (markup) query.message.reply_markup = markup;
    if (
      Array.isArray(content.button) &&
      content.button.length === 2 &&
      content.button.every((n) => typeof n === 'number')
    ) {
      query.button = content.button as [number, number];
    }
    return query;
  }

  /**
   * Resolve a plain-text reply against the bot's most recent keyboard.
   *
   * Scans back a bounded number of events for the last message this bot sent
   * carrying an inline keyboard, then asks `matchFallbackReply` whether the
   * text names one of its buttons. This is the whole reason a bot written
   * against this library works on Element without extra code.
   */
  private synthesiseFallbackCallback(event: MatrixEvent, room: Room): CallbackQuery | undefined {
    const text = plainBodyOf(event.getContent() as Record<string, unknown>);
    if (!text) return undefined;

    const timeline = room.getLiveTimeline().getEvents();
    for (let i = timeline.length - 1, scanned = 0; i >= 0 && scanned < FALLBACK_SCAN_DEPTH; i -= 1, scanned += 1) {
      const candidate = timeline[i];
      if (!candidate || candidate.getSender() !== this.options.userId) continue;
      const markup = this.markupOf(candidate);
      if (!markup || !isInlineKeyboardMarkup(markup)) continue;

      const hit = matchFallbackReply(text, markup);
      // The most recent keyboard is the one in play. If the text does not name
      // one of its buttons it is ordinary conversation, not a press of some
      // older keyboard the user has long since scrolled past.
      if (!hit) return undefined;

      const data = hit.button.callback_data;
      if (typeof data !== 'string') return undefined;

      return {
        id: `fallback:${event.getId() ?? ''}`,
        data,
        button: [hit.row, hit.col],
        message: { event_id: candidate.getId() ?? '', reply_markup: markup },
        from: event.getSender() ?? '',
      };
    }
    return undefined;
  }

  private async route(event: MatrixEvent, room: Room): Promise<void> {
    const sender = event.getSender();
    if (!sender) return;

    const kind = this.kindOf(event);
    if (kind === 'other') return;

    // Membership and reaction updates are informational: they are delivered to
    // handlers, but they are not "someone talking to the bot", so they neither
    // consume rate-limit budget nor get refused for it.
    const isConversational = kind === 'message' || kind === 'callback_query';

    if (isConversational) {
      const decision = this.access.evaluate(sender);
      if (!decision.allowed) {
        // Reply once per sender per window rather than every time, so a refusal
        // cannot be turned into an amplifier.
        if (!this.rateLimiter || this.rateLimiter.check(`refuse:${sender}`)) {
          await this.api
            .sendMessage(room.roomId, decision.reason, { notice: true })
            .catch(() => undefined);
        }
        return;
      }
      if (decision.bootstrapped) {
        this.log(`ownership claimed by ${sender}`);
      }

      if (this.rateLimiter && !decision.isOwner) {
        if (!this.rateLimiter.check(`${room.roomId}:${sender}`)) {
          const retry = this.rateLimiter.retryAfterSeconds(`${room.roomId}:${sender}`);
          await this.api
            .sendMessage(room.roomId, `Rate limit reached. Try again in ${retry}s.`, {
              notice: true,
            })
            .catch(() => undefined);
          return;
        }
      }
    }

    let callbackQuery: CallbackQuery | undefined;
    let command: CommandMatch | undefined;

    if (kind === 'callback_query') {
      callbackQuery = this.callbackQueryOf(event, room);
      if (!callbackQuery) return;
    } else if (kind === 'message') {
      const text = plainBodyOf(event.getContent() as Record<string, unknown>);
      const parsed = parseCommand(text);
      if (parsed) {
        // A command addressed to another bot in the room is not ours to answer.
        if (!isCommandForBot(parsed, this.options.userId)) return;
        command = parsed;
      } else if (this.options.matchFallbackReplies !== false) {
        callbackQuery = this.synthesiseFallbackCallback(event, room);
      }
    }

    const ctx = new Context<S>({
      api: this.api,
      client: this.client,
      event,
      room,
      // A typed "1" becomes a press, so handlers written against
      // `callbackQuery` fire for both without knowing the difference.
      kind: callbackQuery ? 'callback_query' : kind,
      ...(callbackQuery ? { callbackQuery } : {}),
      ...(command ? { command } : {}),
      isOwner: this.access.isOwner(sender),
      getSession: () => this.sessions.get(room.roomId, sender),
      setSession: (value) => this.sessions.set(room.roomId, sender, value),
    });

    try {
      await this.dispatch(ctx);
    } catch (error) {
      if (!this.errorHandler) throw error;
      await this.errorHandler(error, ctx);
    }
  }
}
