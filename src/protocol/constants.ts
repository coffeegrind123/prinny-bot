/**
 * Wire constants for `app.prinny.bot.*` v1.
 *
 * Anything in here is load-bearing across two independent implementations
 * (this library and the Prinny Client renderer), so treat every value as
 * part of the public contract. Changing one is a schema version bump.
 *
 * See spec/app.prinny.bot.md.
 */

export const PRINNY_BOT_NS = 'app.prinny.bot' as const;

export const SCHEMA_VERSION = 1;

/** Event types. */
export const BotEventType = {
  /** Bot advertisement. State event (state_key = bot MXID) or timeline fallback. */
  Info: 'app.prinny.bot.info',
  /** Client -> bot: a button was pressed. */
  Callback: 'app.prinny.bot.callback',
  /** Bot -> client: the answer to a press. */
  CallbackAnswer: 'app.prinny.bot.callback_answer',
} as const;

/** Relation types. Deliberately not `m.reference`, so callback traffic stays
 *  out of a client's reference-aggregation UI. */
export const BotRelType = {
  Callback: 'app.prinny.bot.callback',
  CallbackAnswer: 'app.prinny.bot.callback_answer',
} as const;

/** Content keys that ride on an otherwise ordinary event. */
export const BotContentKey = {
  ReplyMarkup: 'app.prinny.bot.reply_markup',
  /** Body with the plain-text fallback listing stripped out. */
  PlainBody: 'app.prinny.bot.plain_body',
  PlainFormattedBody: 'app.prinny.bot.plain_formatted_body',
  /** Marks the sender as a bot from inside `m.room.member` content. */
  MemberFlag: 'app.prinny.bot',
} as const;

/** Room account data key holding the active reply keyboard, keyed by bot MXID. */
export const BOT_KEYBOARD_ACCOUNT_DATA = 'app.prinny.bot.keyboard' as const;

/**
 * Limits. Telegram's where Telegram has one, ours where the constraint only
 * exists because a hostile event must not be able to produce an unbounded
 * render.
 */
export const Limits = {
  /** Telegram: 1-32 chars, lowercase latin, digits, underscore. */
  COMMAND_PATTERN: /^[a-z0-9_]{1,32}$/,
  COMMAND_MAX_LENGTH: 32,
  /** Telegram: `BotCommand.description`. */
  DESCRIPTION_MAX_LENGTH: 256,
  /** Prinny: usage hint, no Telegram equivalent. */
  ARGS_MAX_LENGTH: 64,
  /** Telegram: 100 commands per scope. */
  COMMANDS_MAX: 100,
  /** Telegram: `callback_data` is 1-64 bytes. We allow more because Matrix
   *  events are not size-constrained the way Telegram updates are, but cap it
   *  well below the 64 KiB event limit. */
  CALLBACK_DATA_MAX_BYTES: 512,
  /** Prinny. Telegram does not document a button label cap. */
  BUTTON_TEXT_MAX_LENGTH: 64,
  KEYBOARD_MAX_ROWS: 10,
  KEYBOARD_MAX_BUTTONS_PER_ROW: 8,
  PLACEHOLDER_MAX_LENGTH: 64,
  SHORT_DESCRIPTION_MAX_LENGTH: 120,
  BOT_DESCRIPTION_MAX_LENGTH: 512,
  ANSWER_TEXT_MAX_LENGTH: 200,
  /** Telegram: `start` payload is 1-64 chars of `[A-Za-z0-9_-]`. */
  DEEP_LINK_PAYLOAD_PATTERN: /^[A-Za-z0-9_-]{1,64}$/,
} as const;

/** URL schemes a client may open from a button. Everything else renders disabled. */
export const ALLOWED_URL_SCHEMES = ['https:', 'http:', 'matrix:'] as const;

/** How long a client waits for a `callback_answer` before clearing the spinner. */
export const CALLBACK_ANSWER_TIMEOUT_MS = 15_000;

/**
 * Deep links. Two forms, both valid:
 *
 *   https://prinny.app/bot/{mxid}?start={payload}
 *   prinny://bot/{mxid}?start={payload}
 *
 * The https form is the shareable one. The custom scheme exists because an
 * https link opened outside the app goes to the browser — reaching an
 * installed client needs a registered scheme, and that is far less work than
 * the hosted-file setup Android App Links and Apple universal links require.
 */
export const DEEP_LINK_ORIGIN = 'https://prinny.app';
export const DEEP_LINK_PATH_PREFIX = '/bot/';
export const DEEP_LINK_SCHEME = 'prinny:';
export const DEEP_LINK_SCHEME_HOST = 'bot';
