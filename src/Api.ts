/**
 * The low-level send surface. `ctx.api` in a handler; `bot.api` outside one.
 *
 * Every method that can carry a keyboard routes its body through
 * `buildFallbackBodies()`, so a bot author cannot accidentally ship a keyboard
 * that is invisible on Element. Getting that wrong is silent and only shows up
 * as "the bot doesn't work for half my users", so it is not left to the caller.
 */

import { EventTimeline, type MatrixClient } from 'matrix-js-sdk';
import { BotContentKey, BotEventType, BotRelType } from './protocol/constants.js';
import type { BotInfo, MenuButton, ReplyMarkup } from './protocol/types.js';
import type { BotCommand } from './protocol/types.js';
import { buildFallbackBodies } from './keyboard/fallback.js';
import { formatForMatrix, stripHtml } from './matrix/format.js';
import { buildThreadRelation } from './matrix/send.js';

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
  private render(text: string, parseMode: NonNullable<MessageOptions['parse_mode']>) {
    if (parseMode === 'HTML') return [{ body: stripHtml(text), html: text }];
    if (parseMode === 'None') return [{ body: text, html: undefined }];
    return formatForMatrix(text).map((chunk) => ({
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
    const parts = this.render(text, options.parse_mode ?? 'Markdown');
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
    const parts = this.render(text, options.parse_mode ?? 'Markdown');

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
      await this.client.sendStateEvent(
        roomId,
        BotEventType.Info as never,
        info as never,
        userId
      );
      return 'state';
    } catch {
      // Fall through: almost always M_FORBIDDEN for lack of power.
    }

    try {
      await this.client.sendEvent(roomId, BotEventType.Info as never, info as never);
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
