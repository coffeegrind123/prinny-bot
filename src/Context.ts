/**
 * The object every handler receives.
 *
 * Shaped after grammY's `Context`: the update that triggered the handler, plus
 * shorthand methods that already know which room and which message to act on.
 * `ctx.reply()` replies here; `ctx.api.sendMessage()` goes anywhere.
 */

import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import type {
  Api,
  AnswerCallbackOptions,
  AttachmentSource,
  MediaOptions,
  MessageOptions,
  PendingCallback,
} from './Api.js';
import {
  isMediaContent,
  type DownloadOptions,
  type DownloadedFile,
  type MatrixMediaContent,
} from './matrix/media.js';
import { isVoiceMessage, type VoiceMetadata } from './matrix/voice.js';
import { TurnReactions, type TurnReactionsOptions } from './matrix/reactions.js';
import { BotContentKey } from './protocol/constants.js';
import type { ReplyMarkup } from './protocol/types.js';
import { sanitizeReplyMarkup } from './protocol/validate.js';
import { plainBodyOf } from './keyboard/fallback.js';
import type { ReplyMarkupLike } from './Api.js';

/** A button press, in Telegram's `CallbackQuery` shape. */
export type CallbackQuery = {
  id: string;
  /** The `callback_data` of the pressed button. */
  data: string;
  /** Zero-based `[row, col]` of the button within its keyboard. */
  button?: [number, number];
  /** The message the keyboard was attached to. */
  message: {
    event_id: string;
    /** Reply markup as it stood when the press happened. */
    reply_markup?: ReplyMarkup;
  };
  from: string;
};

/** A parsed slash command. */
export type CommandMatch = {
  /** Without the leading slash, lowercased. */
  name: string;
  /** Everything after the command name, trimmed. */
  args: string;
  /**
   * The bot a `/cmd@bot` form was addressed to, if any.
   *
   * Telegram's group convention, and it carries over: in a room with two bots
   * that both offer `/status`, this is how each knows whether it was meant.
   */
  addressedTo?: string;
};

export type UpdateKind = 'message' | 'callback_query' | 'membership' | 'reaction' | 'other';

/**
 * The part of a context that routing cares about.
 *
 * `Composer` is generic over this rather than over `Context<S>` so that the
 * session type never has to flow through the middleware machinery. Without
 * it, every `Composer<C>` would need a session type parameter it does not use,
 * and `Context<S>` would fail to satisfy `Context<unknown>` anyway — a session
 * setter is contravariant in `S`.
 */
export type ContextLike = {
  readonly kind: UpdateKind;
  readonly text: string;
  readonly isOwner: boolean;
  readonly command: CommandMatch | undefined;
  readonly callbackQuery: CallbackQuery | undefined;
  readonly event: MatrixEvent;
  match: RegExpMatchArray | undefined;
};

export type ContextInit<S> = {
  api: Api;
  client: MatrixClient;
  event: MatrixEvent;
  room: Room;
  kind: UpdateKind;
  callbackQuery?: CallbackQuery;
  command?: CommandMatch;
  isOwner: boolean;
  getSession: () => S;
  setSession: (value: S) => void;
};

export class Context<S = unknown> {
  readonly api: Api;

  readonly client: MatrixClient;

  /** The raw event. Everything else here is derived from it. */
  readonly event: MatrixEvent;

  readonly room: Room;

  readonly kind: UpdateKind;

  readonly callbackQuery: CallbackQuery | undefined;

  readonly command: CommandMatch | undefined;

  /** Whether the sender owns this bot, per its access control. */
  readonly isOwner: boolean;

  /** Set by `.hears()` and by regex command/callback matches. */
  match: RegExpMatchArray | undefined;

  private readonly getSessionValue: () => S;

  private readonly setSessionValue: (value: S) => void;

  constructor(init: ContextInit<S>) {
    this.api = init.api;
    this.client = init.client;
    this.event = init.event;
    this.room = init.room;
    this.kind = init.kind;
    this.callbackQuery = init.callbackQuery;
    this.command = init.command;
    this.isOwner = init.isOwner;
    this.getSessionValue = init.getSession;
    this.setSessionValue = init.setSession;
  }

  get roomId(): string {
    return this.room.roomId;
  }

  /** MXID of whoever sent the triggering event. */
  get from(): string {
    return this.event.getSender() ?? '';
  }

  /** Room-specific display name, falling back to the MXID. */
  get fromName(): string {
    const member = this.room.getMember(this.from);
    return member?.name ?? this.from;
  }

  get messageId(): string {
    return this.event.getId() ?? '';
  }

  /**
   * The message text, with any fallback button listing removed.
   *
   * A bot reading this gets what the user meant, not the `[1] Yes [2] No`
   * block a previous turn generated.
   */
  get text(): string {
    return plainBodyOf(this.event.getContent() as Record<string, unknown>);
  }

  /** True in a two-person room — the closest thing Matrix has to a DM. */
  get isDirect(): boolean {
    return this.room.getJoinedMemberCount() === 2;
  }

  /**
   * The thread this event belongs to, if any.
   *
   * Replies default to going wherever the triggering message went, which is
   * what a user expects and what stops a bot from dragging a threaded
   * conversation back out into the main timeline.
   */
  get threadRootId(): string | undefined {
    const relation = this.event.getContent()['m.relates_to'] as
      | { rel_type?: string; event_id?: string }
      | undefined;
    if (relation?.rel_type === 'm.thread') return relation.event_id;
    return undefined;
  }

  /** Reply markup on the triggering event, sanitised. */
  get replyMarkup(): ReplyMarkup | null {
    const content = this.event.getContent() as Record<string, unknown>;
    return sanitizeReplyMarkup(content[BotContentKey.ReplyMarkup]);
  }

  get session(): S {
    return this.getSessionValue();
  }

  set session(value: S) {
    this.setSessionValue(value);
  }

  /** Default send options: same room, same thread. */
  private defaults(options: MessageOptions): MessageOptions {
    const merged: MessageOptions = { ...options };
    if (merged.message_thread_id === undefined && this.threadRootId) {
      merged.message_thread_id = this.threadRootId;
    }
    return merged;
  }

  /** Send a message to this room. Returns the ids of the events sent. */
  async reply(text: string, options: MessageOptions = {}): Promise<string[]> {
    return this.api.sendMessage(this.roomId, text, this.defaults(options));
  }

  /** Reply as a rich reply to the triggering message. */
  async replyTo(text: string, options: MessageOptions = {}): Promise<string[]> {
    return this.api.sendMessage(this.roomId, text, {
      ...this.defaults(options),
      reply_to_message_id: this.messageId,
    });
  }

  /** Reply with `m.notice`, which other bots are expected to ignore. */
  async notify(text: string, options: MessageOptions = {}): Promise<string[]> {
    return this.api.sendMessage(this.roomId, text, { ...this.defaults(options), notice: true });
  }

  /** Edit one of this bot's own messages. Defaults to the triggering one. */
  async editMessageText(
    text: string,
    options: MessageOptions & { message_id?: string } = {}
  ): Promise<string | null> {
    const { message_id: messageId, ...rest } = options;
    const target = messageId ?? this.callbackQuery?.message.event_id ?? this.messageId;
    return this.api.editMessageText(this.roomId, target, text, rest);
  }

  /**
   * Swap the buttons on a message, keeping its text.
   *
   * With no markup this removes the keyboard — the usual way to retire a
   * prompt once it has been answered, so it cannot be answered twice.
   */
  async editMessageReplyMarkup(
    markup?: ReplyMarkupLike,
    messageId?: string
  ): Promise<string | null> {
    const target = messageId ?? this.callbackQuery?.message.event_id ?? this.messageId;
    return this.api.editMessageReplyMarkup(this.roomId, target, markup);
  }

  /**
   * Answer the press that triggered this handler.
   *
   * Does nothing outside a callback handler, rather than throwing: a shared
   * middleware that answers every query should not blow up on a text message.
   */
  async answerCallbackQuery(options: AnswerCallbackOptions = {}): Promise<string | null> {
    if (!this.callbackQuery) return null;
    const pending: PendingCallback = {
      id: this.callbackQuery.id,
      roomId: this.roomId,
      callbackEventId: this.messageId,
    };
    return this.api.answerCallbackQuery(pending, options);
  }

  /** Redact a message. Defaults to the triggering one. */
  async deleteMessage(messageId?: string, reason?: string): Promise<void> {
    await this.api.deleteMessage(this.roomId, messageId ?? this.messageId, reason);
  }

  /** React to a message. Defaults to the triggering one. */
  async react(key: string, messageId?: string): Promise<string | null> {
    return this.api.react(this.roomId, messageId ?? this.messageId, key);
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  /**
   * The attachment on the triggering message, if it has one.
   *
   * Includes stickers and every media msgtype; `null` for ordinary text.
   */
  get attachment(): MatrixMediaContent | null {
    const content = this.event.getContent() as MatrixMediaContent;
    if (this.event.getType() === 'm.sticker' && (content.url || content.file)) return content;
    return isMediaContent(content) ? content : null;
  }

  /** Whether the triggering message is a voice message rather than an audio file. */
  get isVoiceMessage(): boolean {
    return isVoiceMessage(this.event.getContent());
  }

  /**
   * Download the attachment on the triggering message.
   *
   * Decrypts when the room is encrypted. Throws when there is nothing to
   * download — check `ctx.attachment` first, or use a `message:image` filter.
   */
  async download(options: DownloadOptions = {}): Promise<DownloadedFile> {
    const attachment = this.attachment;
    if (!attachment) throw new Error('This message has no attachment to download.');
    return this.api.downloadAttachment(attachment, options);
  }

  private mediaDefaults(options: MediaOptions): MediaOptions {
    const merged: MediaOptions = { ...options };
    if (merged.message_thread_id === undefined && this.threadRootId) {
      merged.message_thread_id = this.threadRootId;
    }
    return merged;
  }

  /** Telegram's `sendPhoto`, into this room. */
  async replyWithPhoto(photo: AttachmentSource, options: MediaOptions = {}) {
    return this.api.sendPhoto(this.roomId, photo, this.mediaDefaults(options));
  }

  /** Telegram's `sendDocument`, into this room. */
  async replyWithDocument(document: AttachmentSource, options: MediaOptions = {}) {
    return this.api.sendDocument(this.roomId, document, this.mediaDefaults(options));
  }

  /** Telegram's `sendAudio`, into this room. */
  async replyWithAudio(audio: AttachmentSource, options: MediaOptions = {}) {
    return this.api.sendAudio(this.roomId, audio, this.mediaDefaults(options));
  }

  /** Telegram's `sendVideo`, into this room. */
  async replyWithVideo(video: AttachmentSource, options: MediaOptions = {}) {
    return this.api.sendVideo(this.roomId, video, this.mediaDefaults(options));
  }

  /** Telegram's `sendVoice`, into this room. */
  async replyWithVoice(
    voice: AttachmentSource,
    options: MediaOptions & { voice?: VoiceMetadata } = {}
  ) {
    return this.api.sendVoice(this.roomId, voice, this.mediaDefaults(options));
  }

  /** Telegram's `sendSticker`, into this room. */
  async replyWithSticker(sticker: AttachmentSource, options: MediaOptions = {}) {
    return this.api.sendSticker(this.roomId, sticker, this.mediaDefaults(options));
  }

  // ── Progress ───────────────────────────────────────────────────────────────

  /** Telegram's `sendChatAction('typing')`. */
  async typing(active = true, timeoutMs = 20_000): Promise<void> {
    await this.api.sendTyping(this.roomId, active, timeoutMs);
  }

  /**
   * Progress reactions on the triggering message: ⏳ while `work` runs, then
   * ✅ or ❌.
   *
   * Unlike a typing indicator this survives a restart and stays in scrollback,
   * which is what you want for a turn measured in minutes rather than seconds.
   */
  async withReactions<T>(work: () => Promise<T>, options: TurnReactionsOptions = {}): Promise<T> {
    const reactions = new TurnReactions(
      this.client,
      this.roomId,
      this.messageId || undefined,
      options
    );
    return reactions.around(work);
  }

  /**
   * Show a typing indicator for as long as `work` runs.
   *
   * Clears it even when `work` throws — a stuck typing indicator is a common
   * and confusing bot bug, and the only reliable fix is to not rely on the
   * happy path.
   */
  async withTyping<T>(work: () => Promise<T>): Promise<T> {
    await this.typing(true);
    try {
      return await work();
    } finally {
      await this.typing(false).catch(() => undefined);
    }
  }
}
