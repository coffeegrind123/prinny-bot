/**
 * The low-level send surface. `ctx.api` in a handler; `bot.api` outside one.
 *
 * Every method that can carry a keyboard routes its body through
 * `buildFallbackBodies()`, so a bot author cannot accidentally ship a keyboard
 * that is invisible on Element. Getting that wrong is silent and only shows up
 * as "the bot doesn't work for half my users", so it is not left to the caller.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { EventTimeline, type MatrixClient } from 'matrix-js-sdk';
import { BotContentKey, BotEventType, BotRelType } from './protocol/constants.js';
import type { BotInfo, MenuButton, ReplyMarkup } from './protocol/types.js';
import type { BotCommand } from './protocol/types.js';
import { buildFallbackBodies, renderFallbackListing } from './keyboard/fallback.js';
import { chunkMatrixText, formatForMatrix, stripHtml } from './matrix/format.js';
import { buildThreadRelation } from './matrix/send.js';
import {
  buildMediaContent,
  downloadAttachment,
  imageDimensions,
  isSupportedImageMime,
  mimeFromFilename,
  sanitizeFilename,
  sniffMime,
  uploadAttachment,
  type AttachmentInput,
  type DownloadOptions,
  type DownloadedFile,
  type MatrixMediaContent,
  type MatrixMediaInfo,
} from './matrix/media.js';
import { buildVoiceContent, type VoiceMetadata } from './matrix/voice.js';

/**
 * Retry a send that the homeserver rate-limited.
 *
 * Synapse answers `M_LIMIT_EXCEEDED` with a `retry_after_ms` it expects to be
 * honoured, and matrix-js-sdk surfaces that straight to the caller for state
 * and custom events. Without this, a bot advertising its commands across a
 * handful of rooms has most of them rejected — visible only as a log line, and
 * the command menu is then simply missing for those rooms.
 *
 * Only 429 is retried. Anything else, `M_FORBIDDEN` above all, is a real
 * answer and retrying it just delays the fallback.
 */
const withRateLimitRetry = async <T>(send: () => Promise<T>, attempts = 3): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const err = error as { errcode?: string; data?: { retry_after_ms?: number } };
      if (err?.errcode !== 'M_LIMIT_EXCEEDED' || attempt >= attempts) throw error;
      // Trust the server's number, with a floor so a missing value cannot spin.
      const waitMs = Math.min(Math.max(err.data?.retry_after_ms ?? 1000, 250), 10_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
};

/** Anything that can produce a `ReplyMarkup` — the wire form or a builder. */
export type ReplyMarkupLike = ReplyMarkup | { toJSON(): ReplyMarkup };

const resolveMarkup = (markup: ReplyMarkupLike | undefined): ReplyMarkup | undefined => {
  if (!markup) return undefined;
  if ('toJSON' in markup && typeof markup.toJSON === 'function') return markup.toJSON();
  return markup as ReplyMarkup;
};

export type MessageOptions = {
  /** An `InlineKeyboard`/`Keyboard` builder, or a raw markup object. */
  reply_markup?: ReplyMarkupLike;
  /** How to interpret `text`. Default `Markdown`. */
  parse_mode?: 'Markdown' | 'HTML' | 'None';
  /** Rich reply target. Telegram's name. */
  reply_to_message_id?: string;
  /** Matrix thread root. Telegram's forum-topic field, same idea. */
  message_thread_id?: string;
  /**
   * Send as `m.notice` instead of `m.text`.
   *
   * The Matrix convention for automated output — other bots ignore `m.notice`,
   * which is what stops two bots in a room from answering each other forever.
   */
  notice?: boolean;
  /**
   * Chunk ceiling in characters. Capped at the Matrix event limit either way;
   * lower it when whatever reads the room is stricter than Matrix is.
   */
  chunk_limit?: number;
};

/**
 * A file to send: bytes in hand, or a path to read.
 *
 * Telegram accepts both, and so does this — `{ path }` is what a bot answering
 * "send me the log" actually has.
 */
export type AttachmentSource =
  | AttachmentInput
  | { path: string; filename?: string; mimeType?: string };

export type MediaOptions = Omit<MessageOptions, 'parse_mode' | 'notice'> & {
  /** Shown with the attachment. Telegram's name. */
  caption?: string;
  /** Overrides the name taken from the source. */
  filename?: string;
  /** Merged into `info`. Duration, dimensions, anything else a client uses. */
  info?: MatrixMediaInfo;
};

export type AnswerCallbackOptions = {
  text?: string;
  /** Promote the toast to a modal the user has to dismiss. */
  show_alert?: boolean;
  /** Offered behind a confirmation. Never opened automatically. */
  url?: string;
};

/** Everything needed to answer a press, carried on the context. */
export type PendingCallback = {
  id: string;
  roomId: string;
  callbackEventId: string;
};

export class Api {
  constructor(private readonly client: MatrixClient) {}

  /** The underlying matrix-js-sdk client, for anything not wrapped here. */
  get matrix(): MatrixClient {
    return this.client;
  }

  /**
   * Render text under `parse_mode` into the pieces a Matrix event needs.
   *
   * Markdown comes back pre-chunked, because a long markdown reply has to be
   * split at boundaries the renderer chose — splitting rendered HTML at an
   * arbitrary offset produces unbalanced tags.
   */
  private render(
    text: string,
    parseMode: NonNullable<MessageOptions['parse_mode']>,
    chunkLimit?: number
  ) {
    if (parseMode === 'HTML') return [{ body: stripHtml(text), html: text }];
    if (parseMode === 'None') {
      return chunkMatrixText(text, chunkLimit).map((piece) => ({ body: piece, html: undefined }));
    }
    return formatForMatrix(text, chunkLimit).map((chunk) => ({
      body: chunk.body,
      // Markdown that rendered to nothing but its own plain text is not worth
      // a formatted_body: it doubles the event for no visible difference.
      html: chunk.html === chunk.body ? undefined : chunk.html,
    }));
  }

  /** Assemble event content from already-rendered body and HTML. */
  private assemble(
    body: string,
    html: string | undefined,
    options: MessageOptions
  ): Record<string, unknown> {
    const markup = resolveMarkup(options.reply_markup);
    const bodies = buildFallbackBodies(body, html, markup);

    const content: Record<string, unknown> = {
      msgtype: options.notice ? 'm.notice' : 'm.text',
      body: bodies.body,
    };
    if (bodies.formatted_body !== undefined) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = bodies.formatted_body;
    }
    if (bodies[BotContentKey.PlainBody] !== undefined) {
      content[BotContentKey.PlainBody] = bodies[BotContentKey.PlainBody];
    }
    if (bodies[BotContentKey.PlainFormattedBody] !== undefined) {
      content[BotContentKey.PlainFormattedBody] = bodies[BotContentKey.PlainFormattedBody];
    }
    if (markup) content[BotContentKey.ReplyMarkup] = markup;

    const relation = buildThreadRelation(options.message_thread_id, options.reply_to_message_id);
    if (relation) {
      content['m.relates_to'] = relation;
    } else if (options.reply_to_message_id) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: options.reply_to_message_id } };
    }

    return content;
  }

  /**
   * Turn text plus options into event content.
   *
   * Exposed because a caller building a custom event type still wants the
   * keyboard and fallback handling to be identical to a plain message's. Long
   * text is not split here — use `sendMessage` for that.
   */
  buildContent(text: string, options: MessageOptions = {}): Record<string, unknown> {
    const parts = this.render(text, options.parse_mode ?? 'Markdown', options.chunk_limit);
    const first = parts[0] ?? { body: text, html: undefined };
    return this.assemble(first.body, first.html, options);
  }

  /**
   * Send a message, splitting it when it exceeds the Matrix event size limit.
   *
   * Returns every event id produced. A keyboard rides on the last chunk only —
   * buttons belong under the end of what they refer to, and duplicating them
   * per chunk would mean one press per copy.
   */
  async sendMessage(roomId: string, text: string, options: MessageOptions = {}): Promise<string[]> {
    const parts = this.render(text, options.parse_mode ?? 'Markdown', options.chunk_limit);

    const eventIds: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const partOptions: MessageOptions = { ...options };
      if (!isLast) delete partOptions.reply_markup;

      const content = this.assemble(part.body, part.html, partOptions);
      // Sequential on purpose: chunks of one message must arrive in order, and
      // firing them concurrently reorders them for everyone in the room.
      const result = await this.client.sendMessage(roomId, content as never);
      if (result.event_id) eventIds.push(result.event_id);
    }
    return eventIds;
  }

  /** Telegram's `editMessageText`. A standard Matrix `m.replace` edit. */
  async editMessageText(
    roomId: string,
    eventId: string,
    text: string,
    options: MessageOptions = {}
  ): Promise<string | null> {
    const newContent = this.buildContent(text, options);
    // A replacement must not carry the original's relation, or the edit joins
    // the thread a second time.
    delete newContent['m.relates_to'];

    const content: Record<string, unknown> = {
      ...newContent,
      body: `* ${newContent.body as string}`,
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    };
    if (typeof newContent.formatted_body === 'string') {
      content.formatted_body = `* ${newContent.formatted_body}`;
    }

    const result = await this.client.sendMessage(roomId, content as never);
    return result.event_id ?? null;
  }

  /**
   * Telegram's `editMessageReplyMarkup`: swap the buttons, keep the text.
   *
   * Passing no markup removes the keyboard, which is the usual way to retire
   * a one-shot prompt once it has been answered.
   */
  async editMessageReplyMarkup(
    roomId: string,
    eventId: string,
    markup?: ReplyMarkupLike
  ): Promise<string | null> {
    const event = this.client.getRoom(roomId)?.findEventById(eventId);
    const original = event?.getContent() as Record<string, unknown> | undefined;
    if (!original) return null;

    // Rebuild from the clean body so the fallback listing tracks the new
    // buttons instead of accumulating the old ones.
    const plainBody = (original[BotContentKey.PlainBody] as string) ?? (original.body as string) ?? '';
    const plainFormatted =
      (original[BotContentKey.PlainFormattedBody] as string) ??
      (original.formatted_body as string | undefined);

    const resolved = resolveMarkup(markup);
    const bodies = buildFallbackBodies(plainBody, plainFormatted, resolved);

    const newContent: Record<string, unknown> = {
      msgtype: original.msgtype ?? 'm.text',
      body: bodies.body,
    };
    if (bodies.formatted_body !== undefined) {
      newContent.format = 'org.matrix.custom.html';
      newContent.formatted_body = bodies.formatted_body;
    }
    if (bodies[BotContentKey.PlainBody] !== undefined) {
      newContent[BotContentKey.PlainBody] = bodies[BotContentKey.PlainBody];
    }
    if (bodies[BotContentKey.PlainFormattedBody] !== undefined) {
      newContent[BotContentKey.PlainFormattedBody] = bodies[BotContentKey.PlainFormattedBody];
    }
    if (resolved) newContent[BotContentKey.ReplyMarkup] = resolved;

    const content: Record<string, unknown> = {
      ...newContent,
      body: `* ${bodies.body}`,
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    };

    const result = await this.client.sendMessage(roomId, content as never);
    return result.event_id ?? null;
  }

  /**
   * Telegram's `answerCallbackQuery`.
   *
   * Answer every press, even with nothing to say: the spinner on the button is
   * the only feedback the user has that their click registered at all.
   */
  async answerCallbackQuery(
    pending: PendingCallback,
    options: AnswerCallbackOptions = {}
  ): Promise<string | null> {
    const content: Record<string, unknown> = {
      'm.relates_to': {
        rel_type: BotRelType.CallbackAnswer,
        event_id: pending.callbackEventId,
      },
      id: pending.id,
    };
    if (options.text !== undefined) content.text = options.text;
    if (options.show_alert !== undefined) content.show_alert = options.show_alert;
    if (options.url !== undefined) content.url = options.url;

    const result = await this.client.sendEvent(
      pending.roomId,
      BotEventType.CallbackAnswer as never,
      content as never
    );
    return result.event_id ?? null;
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  /** Resolve a source to bytes, reading from disk when given a path. */
  private static resolveSource(source: AttachmentSource): AttachmentInput {
    if ('data' in source) return source;
    const data = readFileSync(source.path);
    const input: AttachmentInput = {
      data,
      filename: source.filename ?? basename(source.path),
    };
    if (source.mimeType) input.mimeType = source.mimeType;
    return input;
  }

  /**
   * Upload and send an attachment.
   *
   * The caption/filename split follows MSC2530: `filename` is always the real
   * name, and `body` carries the caption when there is one. That separation is
   * what lets a keyboard's fallback listing live in `body` without destroying
   * the name a client shows on the download button.
   */
  private async sendAttachment(
    roomId: string,
    msgtype: 'm.image' | 'm.file' | 'm.audio' | 'm.video',
    source: AttachmentSource,
    options: MediaOptions
  ): Promise<string | null> {
    const input = Api.resolveSource(source);
    const filename = sanitizeFilename(options.filename ?? input.filename);
    const uploaded = await uploadAttachment(this.client, roomId, { ...input, filename });

    const info: MatrixMediaInfo = { ...options.info };
    // Clients reserve layout space from these before the bytes arrive; without
    // them the timeline jumps when the image loads.
    if (msgtype === 'm.image' && info.w === undefined && info.h === undefined) {
      const dimensions = imageDimensions(input.data);
      if (dimensions) {
        info.w = dimensions.w;
        info.h = dimensions.h;
      }
    }

    const content = buildMediaContent(msgtype, filename, uploaded, info);
    content.filename = filename;

    const markup = resolveMarkup(options.reply_markup);
    const caption = options.caption ?? '';
    const listing = markup ? renderFallbackListing(markup) : null;

    if (caption || listing) {
      // `body` becomes the caption (plus any fallback listing); `filename`
      // keeps the real name.
      const bodies = buildFallbackBodies(caption, undefined, markup ?? undefined);
      content.body = bodies.body || filename;
      if (bodies[BotContentKey.PlainBody] !== undefined) {
        content[BotContentKey.PlainBody] = bodies[BotContentKey.PlainBody];
      }
    }
    if (markup) content[BotContentKey.ReplyMarkup] = markup;

    const relation = buildThreadRelation(options.message_thread_id, options.reply_to_message_id);
    if (relation) content['m.relates_to'] = relation;
    else if (options.reply_to_message_id) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: options.reply_to_message_id } };
    }

    const result = await this.client.sendMessage(roomId, content as never);
    return result.event_id ?? null;
  }

  /** Telegram's `sendPhoto`. */
  async sendPhoto(
    roomId: string,
    photo: AttachmentSource,
    options: MediaOptions = {}
  ): Promise<string | null> {
    const input = Api.resolveSource(photo);
    const mime = input.mimeType ?? sniffMime(input.data) ?? mimeFromFilename(input.filename);
    if (!isSupportedImageMime(mime)) {
      // Sent as a file rather than silently as a broken image: a client that
      // renders `m.image` for a PDF shows an empty box and no download button.
      return this.sendDocument(roomId, photo, options);
    }
    return this.sendAttachment(roomId, 'm.image', photo, options);
  }

  /** Telegram's `sendDocument`. */
  async sendDocument(
    roomId: string,
    document: AttachmentSource,
    options: MediaOptions = {}
  ): Promise<string | null> {
    return this.sendAttachment(roomId, 'm.file', document, options);
  }

  /** Telegram's `sendAudio` — a music file, not a voice message. */
  async sendAudio(
    roomId: string,
    audio: AttachmentSource,
    options: MediaOptions = {}
  ): Promise<string | null> {
    return this.sendAttachment(roomId, 'm.audio', audio, options);
  }

  /** Telegram's `sendVideo`. */
  async sendVideo(
    roomId: string,
    video: AttachmentSource,
    options: MediaOptions = {}
  ): Promise<string | null> {
    return this.sendAttachment(roomId, 'm.video', video, options);
  }

  /**
   * Telegram's `sendVoice` — a voice message, not an audio file.
   *
   * Carries the MSC3245 marker and an MSC1767 waveform, which is what makes a
   * client draw a voice bubble instead of a generic audio attachment. Pass
   * `voice: { pcm }` and the duration and waveform are computed for you.
   */
  async sendVoice(
    roomId: string,
    voice: AttachmentSource,
    options: MediaOptions & { voice?: VoiceMetadata } = {}
  ): Promise<string | null> {
    const input = Api.resolveSource(voice);
    const filename = sanitizeFilename(options.filename ?? input.filename);
    const uploaded = await uploadAttachment(this.client, roomId, { ...input, filename });

    const content = buildVoiceContent(options.caption || filename, uploaded, options.voice ?? {});

    const markup = resolveMarkup(options.reply_markup);
    if (markup) content[BotContentKey.ReplyMarkup] = markup;

    const relation = buildThreadRelation(options.message_thread_id, options.reply_to_message_id);
    if (relation) content['m.relates_to'] = relation;

    const result = await this.client.sendMessage(roomId, content as never);
    return result.event_id ?? null;
  }

  /** Telegram's `sendSticker`. An `m.sticker`, which is its own event type. */
  async sendSticker(
    roomId: string,
    sticker: AttachmentSource,
    options: MediaOptions = {}
  ): Promise<string | null> {
    const input = Api.resolveSource(sticker);
    const filename = sanitizeFilename(options.filename ?? input.filename);
    const uploaded = await uploadAttachment(this.client, roomId, { ...input, filename });

    const info: MatrixMediaInfo = { ...options.info };
    if (info.w === undefined && info.h === undefined) {
      const dimensions = imageDimensions(input.data);
      if (dimensions) {
        info.w = dimensions.w;
        info.h = dimensions.h;
      }
    }

    const content = buildMediaContent('m.image', options.caption || filename, uploaded, info);
    // m.sticker has no msgtype; it is the event type that carries the meaning.
    delete content.msgtype;

    const result = await this.client.sendEvent(roomId, 'm.sticker' as never, content as never);
    return result.event_id ?? null;
  }

  /**
   * Telegram's `getFile` plus the download it implies.
   *
   * Decrypts on the way out when the room was encrypted, so a caller never has
   * to know whether it was.
   */
  async downloadAttachment(
    content: MatrixMediaContent,
    options: DownloadOptions = {}
  ): Promise<DownloadedFile> {
    return downloadAttachment(this.client, content, options);
  }

  async deleteMessage(roomId: string, eventId: string, reason?: string): Promise<void> {
    await this.client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
  }

  async react(roomId: string, eventId: string, key: string): Promise<string | null> {
    const result = await this.client.sendEvent(roomId, 'm.reaction' as never, {
      'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
    } as never);
    return result.event_id ?? null;
  }

  /** Telegram's `sendChatAction('typing')`. */
  async sendTyping(roomId: string, typing: boolean, timeoutMs = 20_000): Promise<void> {
    await this.client.sendTyping(roomId, typing, timeoutMs);
  }

  // ── Advertisement ──────────────────────────────────────────────────────────

  /**
   * Publish this bot's info into one room.
   *
   * Tries the state event first, which is the authoritative form. Power level
   * 50 is the default requirement for state, and a bot in a public room
   * usually has 0 — so on failure it falls back to the identical payload as a
   * timeline event, which any member can send.
   *
   * Returns which form landed, because "commands published" and "commands
   * published in the fragile way" are worth telling apart in a log.
   */
  async publishBotInfo(roomId: string, info: BotInfo): Promise<'state' | 'timeline' | 'failed'> {
    const userId = this.client.getUserId();
    if (!userId) return 'failed';

    try {
      await withRateLimitRetry(() =>
        this.client.sendStateEvent(roomId, BotEventType.Info as never, info as never, userId)
      );
      return 'state';
    } catch {
      // Fall through: almost always M_FORBIDDEN for lack of power.
    }

    try {
      await withRateLimitRetry(() =>
        this.client.sendEvent(roomId, BotEventType.Info as never, info as never)
      );
      return 'timeline';
    } catch {
      return 'failed';
    }
  }

  /** Telegram's `setChatMenuButton`, for one room. */
  async setChatMenuButton(roomId: string, info: BotInfo, menuButton: MenuButton): Promise<void> {
    await this.publishBotInfo(roomId, { ...info, menu_button: menuButton });
  }

  /** Read back what this bot published in a room, if anything. */
  getPublishedInfo(roomId: string): BotInfo | null {
    const userId = this.client.getUserId();
    const room = this.client.getRoom(roomId);
    if (!userId || !room) return null;
    const event = room
      .getLiveTimeline()
      .getState(EventTimeline.FORWARDS)
      ?.getStateEvents(BotEventType.Info, userId);
    return (event?.getContent() as BotInfo | undefined) ?? null;
  }
}

export type { BotCommand };
