/**
 * Type definitions for `app.prinny.bot.*` v1.
 *
 * Field names track the Telegram Bot API exactly wherever an equivalent
 * exists. Where a field is ours and has no Telegram counterpart it is marked
 * "Prinny extension" — those are the only names a Telegram bot author will not
 * already recognise.
 *
 * See spec/app.prinny.bot.md.
 */

// ── Bot advertisement ────────────────────────────────────────────────────────

/** Telegram's `BotCommand`, plus a usage hint Telegram has no room to show. */
export type BotCommand = {
  /** Without the leading slash. `^[a-z0-9_]{1,32}$`. */
  command: string;
  description: string;
  /** Prinny extension. Usage hint, e.g. `<path>` or `[on|off]`. */
  args?: string;
};

/** Telegram's `MenuButton`, minus `web_app` (no Matrix equivalent) plus `url`. */
export type MenuButton =
  | { type: 'commands' }
  | { type: 'default' }
  /** Prinny extension, standing in for Telegram's `MenuButtonWebApp`. */
  | { type: 'url'; text: string; url: string };

/**
 * Content of the `app.prinny.bot.info` state event (state_key = bot MXID), or
 * of the identical timeline event a bot sends when it lacks power to set state.
 */
export type BotInfo = {
  version: number;
  name?: string;
  /** Telegram's `setMyShortDescription`. */
  short_description?: string;
  /** Telegram's `setMyDescription`. */
  description?: string;
  /** Telegram's `setMyCommands`, scoped to this room. */
  commands?: BotCommand[];
  /** Telegram's `setChatMenuButton`. */
  menu_button?: MenuButton;
  /** Advisory only. Clients surface it; they do not enforce it. */
  privacy_mode?: boolean;
};

// ── Keyboards ────────────────────────────────────────────────────────────────

/** Prinny extension. Telegram has no button styling. */
export type ButtonStyle = 'default' | 'primary' | 'danger';

/** Telegram's `CopyTextButton`, minus its redundant discriminating `type`. */
export type CopyTextButton = {
  text: string;
};

/**
 * Telegram's `InlineKeyboardButton`. `text` plus exactly one action field.
 *
 * `web_app`, `login_url`, `pay`, `callback_game`, `switch_inline_query` and
 * `switch_inline_query_chosen_chat` are absent by design — they describe
 * Telegram platform features with no Matrix meaning. A button carrying only
 * those renders disabled rather than vanishing, so the bot's intended layout
 * survives on a client that cannot honour it.
 */
export type InlineKeyboardButton = {
  text: string;
  style?: ButtonStyle;

  /** Sends an `app.prinny.bot.callback`. Max 512 bytes UTF-8. */
  callback_data?: string;
  /** Opens a URL, behind a client confirmation. */
  url?: string;
  /** Copies text to the clipboard. */
  copy_text?: CopyTextButton;
  /** Prefills the composer in the current room. */
  switch_inline_query_current_chat?: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

/**
 * Telegram's `KeyboardButton`. The request-* variants (`request_users`,
 * `request_chat`, `request_contact`, `request_location`, `request_poll`) and
 * `web_app` are not in v1; such a button renders as plain text.
 */
export type KeyboardButton = {
  text: string;
};

/** Telegram's `ReplyKeyboardMarkup`, field-for-field. */
export type ReplyKeyboardMarkup = {
  keyboard: KeyboardButton[][];
  is_persistent?: boolean;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
  /** Show only to users named in the message's `m.mentions`. */
  selective?: boolean;
};

/** Telegram's `ReplyKeyboardRemove`. */
export type ReplyKeyboardRemove = {
  remove_keyboard: true;
  selective?: boolean;
};

/** Telegram's `ForceReply`. */
export type ForceReply = {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
};

/**
 * The value of the `app.prinny.bot.reply_markup` content key. Discriminated by
 * which key is present; an object with more than one discriminator is invalid
 * and is ignored whole rather than partially applied.
 */
export type ReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply;

// ── Callback queries ─────────────────────────────────────────────────────────

/** Content of an `app.prinny.bot.callback` event, sent by the client. */
export type CallbackContent = {
  'm.relates_to': {
    rel_type: 'app.prinny.bot.callback';
    event_id: string;
  };
  /** Client-generated, unique per press. Correlates the answer. */
  id: string;
  /** Verbatim `callback_data` of the pressed button. */
  data: string;
  /** Zero-based `[row, col]`. Distinguishes identically-labelled buttons. */
  button?: [number, number];
};

/** Content of an `app.prinny.bot.callback_answer`. Telegram's `answerCallbackQuery`. */
export type CallbackAnswerContent = {
  'm.relates_to': {
    rel_type: 'app.prinny.bot.callback_answer';
    event_id: string;
  };
  id: string;
  /** Transient toast. */
  text?: string;
  /** Promote the toast to a modal the user must dismiss. */
  show_alert?: boolean;
  /** Offered behind the same confirmation as a URL button. Never auto-opened. */
  url?: string;
};

// ── Message content ──────────────────────────────────────────────────────────

/**
 * The additive shape a bot message takes on. Everything here is optional from
 * the wire's point of view — a plain `m.room.message` is still valid.
 */
export type BotMessageContentExtras = {
  'app.prinny.bot.reply_markup'?: ReplyMarkup;
  /** `body` with the plain-text fallback listing removed. */
  'app.prinny.bot.plain_body'?: string;
  'app.prinny.bot.plain_formatted_body'?: string;
};

// ── Narrowing helpers ────────────────────────────────────────────────────────

export const isInlineKeyboardMarkup = (m: ReplyMarkup): m is InlineKeyboardMarkup =>
  Array.isArray((m as InlineKeyboardMarkup).inline_keyboard);

export const isReplyKeyboardMarkup = (m: ReplyMarkup): m is ReplyKeyboardMarkup =>
  Array.isArray((m as ReplyKeyboardMarkup).keyboard);

export const isReplyKeyboardRemove = (m: ReplyMarkup): m is ReplyKeyboardRemove =>
  (m as ReplyKeyboardRemove).remove_keyboard === true;

export const isForceReply = (m: ReplyMarkup): m is ForceReply =>
  (m as ForceReply).force_reply === true;

/** Which of the four shapes this is, or `null` if it is not exactly one. */
export type ReplyMarkupKind = 'inline_keyboard' | 'keyboard' | 'remove_keyboard' | 'force_reply';
