/**
 * Validation and sanitisation for `app.prinny.bot.*` v1.
 *
 * This module is deliberately dependency-free and side-effect-free, because it
 * runs in two very different places with the same obligations:
 *
 *  - in this library, checking what a bot author is about to send, and
 *  - in a Matrix client, checking what an arbitrary room member just sent.
 *
 * The second case is the one that matters. Every value reaching a renderer has
 * to survive this file first. Nothing here trusts its input.
 *
 * The policy throughout is *truncate, do not reject* — a keyboard with eleven
 * rows renders as ten rather than vanishing — with one exception: a markup
 * object that is ambiguous about what it even is gets dropped whole, because
 * partially applying an ambiguous instruction is worse than ignoring it.
 */

import { ALLOWED_URL_SCHEMES, Limits } from './constants.js';
import type {
  BotCommand,
  BotInfo,
  ButtonStyle,
  CallbackAnswerContent,
  ForceReply,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  KeyboardButton,
  MenuButton,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  ReplyMarkup,
  ReplyMarkupKind,
} from './types.js';

// ── Primitives ───────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Code points that must never reach a renderer.
 *
 * The bidi half is the interesting one. A bare U+202E (RIGHT-TO-LEFT OVERRIDE)
 * inside a button label is enough to make "Cancel" and "Deploy" render in
 * swapped positions, so the user clicks the one they were trying to avoid.
 * Stripping them costs nothing legitimate - no real label needs to reverse the
 * paragraph direction.
 *
 * Written as explicit code points rather than a regex character class because
 * a class of unprintable characters is unreviewable: you cannot tell by
 * reading it whether U+202E is in there or not.
 */
const isUnsafeCodePoint = (cp: number, keepBreaks: boolean): boolean => {
  if (keepBreaks && (cp === 0x09 || cp === 0x0a)) return false;
  if (cp <= 0x1f) return true; // C0 controls
  if (cp >= 0x7f && cp <= 0x9f) return true; // DEL and C1 controls
  if (cp === 0x200e || cp === 0x200f) return true; // LRM, RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embedding and override
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  return false;
};

/** Drop every unsafe code point. `keepBreaks` spares tab and newline. */
const stripUnsafe = (value: string, keepBreaks = false): string => {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isUnsafeCodePoint(cp, keepBreaks)) out += ch;
  }
  return out;
};

/**
 * A string stripped of control and bidi characters and capped at `max`.
 *
 * Line breaks go too - every caller is a label, a placeholder or a name, all
 * of which are one line by definition.
 */
const cleanString = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const trimmed = stripUnsafe(v).trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

const cleanBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Assign `value` to `target[key]` only when it is not undefined. */
const put = <T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) => {
  if (value !== undefined) target[key] = value;
};

// ── URLs ─────────────────────────────────────────────────────────────────────

/**
 * Whether a client may offer to open this URL.
 *
 * Scheme allowlist, not a blocklist: `javascript:`, `data:`, `file:` and
 * `vbscript:` are the obvious ones, but the set of dangerous schemes is open
 * and platform-specific, so only three are ever permitted.
 */
export const isAllowedButtonUrl = (raw: unknown): raw is string => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return (ALLOWED_URL_SCHEMES as readonly string[]).includes(parsed.protocol);
};

/** Host to show in a confirmation prompt, or the scheme for non-HTTP URLs. */
export const describeUrlTarget = (raw: string): string => {
  try {
    const parsed = new URL(raw);
    return parsed.host || parsed.protocol;
  } catch {
    return raw.slice(0, 64);
  }
};

// ── Buttons ──────────────────────────────────────────────────────────────────

const BUTTON_STYLES: readonly ButtonStyle[] = ['default', 'primary', 'danger'];

const cleanStyle = (v: unknown): ButtonStyle | undefined =>
  typeof v === 'string' && (BUTTON_STYLES as readonly string[]).includes(v)
    ? (v as ButtonStyle)
    : undefined;

/** What an inline button actually does, once the wire form has been checked. */
export type ButtonAction =
  | { kind: 'callback'; data: string }
  | { kind: 'url'; url: string }
  | { kind: 'copy'; text: string }
  | { kind: 'switch_inline'; query: string }
  /** Carries no action this version understands, or more than one. Render it,
   *  greyed out — dropping it would silently reflow the bot's layout. */
  | { kind: 'disabled'; reason: 'unsupported' | 'ambiguous' | 'invalid_url' };

/**
 * Resolve a sanitised button to its single action.
 *
 * A button with two action fields is `ambiguous`, not "the first one wins".
 * Telegram rejects those at send time; a client cannot, so it must not guess —
 * guessing is how a `url` button gets clicked as if it were a harmless
 * `callback_data` one.
 */
export const buttonAction = (button: InlineKeyboardButton): ButtonAction => {
  const present: ButtonAction[] = [];

  if (typeof button.callback_data === 'string') {
    present.push({ kind: 'callback', data: button.callback_data });
  }
  if (typeof button.url === 'string') {
    present.push(
      isAllowedButtonUrl(button.url)
        ? { kind: 'url', url: button.url }
        : { kind: 'disabled', reason: 'invalid_url' },
    );
  }
  if (isRecord(button.copy_text) && typeof button.copy_text.text === 'string') {
    present.push({ kind: 'copy', text: button.copy_text.text });
  }
  if (typeof button.switch_inline_query_current_chat === 'string') {
    present.push({ kind: 'switch_inline', query: button.switch_inline_query_current_chat });
  }

  if (present.length === 0) return { kind: 'disabled', reason: 'unsupported' };
  if (present.length > 1) return { kind: 'disabled', reason: 'ambiguous' };
  return present[0]!;
};

const sanitizeInlineButton = (raw: unknown): InlineKeyboardButton | null => {
  if (!isRecord(raw)) return null;
  const text = cleanString(raw.text, Limits.BUTTON_TEXT_MAX_LENGTH);
  if (!text) return null;

  const button: InlineKeyboardButton = { text };
  put(button, 'style', cleanStyle(raw.style));

  if (
    typeof raw.callback_data === 'string' &&
    utf8Bytes(raw.callback_data) <= Limits.CALLBACK_DATA_MAX_BYTES
  ) {
    // Not run through cleanString: callback_data is opaque machine payload that
    // is never rendered, and mangling it would break the bot's own dispatch.
    button.callback_data = raw.callback_data;
  }
  if (typeof raw.url === 'string' && raw.url.length <= 2048) {
    button.url = raw.url;
  }
  if (isRecord(raw.copy_text)) {
    const copy = cleanString(raw.copy_text.text, 4096);
    if (copy) button.copy_text = { text: copy };
  }
  if (typeof raw.switch_inline_query_current_chat === 'string') {
    const query = cleanString(raw.switch_inline_query_current_chat, 512);
    if (query) button.switch_inline_query_current_chat = query;
  }

  return button;
};

const sanitizeKeyboardButton = (raw: unknown): KeyboardButton | null => {
  // Telegram allows a bare string as shorthand for `{ text }`; accept both.
  if (typeof raw === 'string') {
    const text = cleanString(raw, Limits.BUTTON_TEXT_MAX_LENGTH);
    return text ? { text } : null;
  }
  if (!isRecord(raw)) return null;
  const text = cleanString(raw.text, Limits.BUTTON_TEXT_MAX_LENGTH);
  return text ? { text } : null;
};

/** Cap rows and per-row width, dropping rows that end up empty. */
const sanitizeRows = <T>(raw: unknown, sanitizeCell: (cell: unknown) => T | null): T[][] => {
  if (!Array.isArray(raw)) return [];
  const rows: T[][] = [];
  for (const rawRow of raw.slice(0, Limits.KEYBOARD_MAX_ROWS)) {
    if (!Array.isArray(rawRow)) continue;
    const row: T[] = [];
    for (const rawCell of rawRow.slice(0, Limits.KEYBOARD_MAX_BUTTONS_PER_ROW)) {
      const cell = sanitizeCell(rawCell);
      if (cell) row.push(cell);
    }
    if (row.length > 0) rows.push(row);
  }
  return rows;
};

// ── Reply markup ─────────────────────────────────────────────────────────────

/**
 * Which of the four shapes a raw markup object claims to be.
 *
 * Returns `null` when it claims to be none of them, or more than one. The
 * second case is the reason this returns rather than throwing: a bot that
 * sends `{ keyboard: [...], remove_keyboard: true }` has asked for two
 * contradictory things, and the only safe reading is neither.
 */
export const replyMarkupKind = (raw: unknown): ReplyMarkupKind | null => {
  if (!isRecord(raw)) return null;
  const kinds: ReplyMarkupKind[] = [];
  if (Array.isArray(raw.inline_keyboard)) kinds.push('inline_keyboard');
  if (Array.isArray(raw.keyboard)) kinds.push('keyboard');
  if (raw.remove_keyboard === true) kinds.push('remove_keyboard');
  if (raw.force_reply === true) kinds.push('force_reply');
  return kinds.length === 1 ? kinds[0]! : null;
};

/**
 * Sanitise arbitrary untrusted input into a `ReplyMarkup`, or `null`.
 *
 * A non-null return is safe to hand straight to a renderer: every string is
 * capped and control-character free, every array is bounded, and every URL
 * still needs `buttonAction()` to decide whether it may be opened at all.
 */
export const sanitizeReplyMarkup = (raw: unknown): ReplyMarkup | null => {
  const kind = replyMarkupKind(raw);
  if (!kind || !isRecord(raw)) return null;

  if (kind === 'inline_keyboard') {
    const inlineKeyboard = sanitizeRows(raw.inline_keyboard, sanitizeInlineButton);
    if (inlineKeyboard.length === 0) return null;
    return { inline_keyboard: inlineKeyboard } satisfies InlineKeyboardMarkup;
  }

  if (kind === 'keyboard') {
    const keyboard = sanitizeRows(raw.keyboard, sanitizeKeyboardButton);
    if (keyboard.length === 0) return null;
    const markup: ReplyKeyboardMarkup = { keyboard };
    put(markup, 'is_persistent', cleanBool(raw.is_persistent));
    put(markup, 'resize_keyboard', cleanBool(raw.resize_keyboard));
    put(markup, 'one_time_keyboard', cleanBool(raw.one_time_keyboard));
    put(
      markup,
      'input_field_placeholder',
      cleanString(raw.input_field_placeholder, Limits.PLACEHOLDER_MAX_LENGTH),
    );
    put(markup, 'selective', cleanBool(raw.selective));
    return markup;
  }

  if (kind === 'remove_keyboard') {
    const markup: ReplyKeyboardRemove = { remove_keyboard: true };
    put(markup, 'selective', cleanBool(raw.selective));
    return markup;
  }

  const markup: ForceReply = { force_reply: true };
  put(
    markup,
    'input_field_placeholder',
    cleanString(raw.input_field_placeholder, Limits.PLACEHOLDER_MAX_LENGTH),
  );
  put(markup, 'selective', cleanBool(raw.selective));
  return markup;
};

// ── Bot info ─────────────────────────────────────────────────────────────────

export const isValidCommandName = (name: unknown): name is string =>
  typeof name === 'string' && Limits.COMMAND_PATTERN.test(name);

/**
 * Coerce a human-written command name into a legal one, or `null`.
 *
 * Mirrors what Telegram would accept: lowercase, hyphens become underscores,
 * truncated to 32. `null` means there is no legal name in there at all, which
 * is a real outcome for commands named entirely in punctuation.
 */
export const normalizeCommandName = (raw: string): string | null => {
  const candidate = raw.toLowerCase().replace(/-/g, '_').slice(0, Limits.COMMAND_MAX_LENGTH);
  return Limits.COMMAND_PATTERN.test(candidate) ? candidate : null;
};

const sanitizeCommand = (raw: unknown): BotCommand | null => {
  if (!isRecord(raw)) return null;
  if (!isValidCommandName(raw.command)) return null;
  const description = cleanString(raw.description, Limits.DESCRIPTION_MAX_LENGTH) ?? '';
  const command: BotCommand = { command: raw.command, description };
  put(command, 'args', cleanString(raw.args, Limits.ARGS_MAX_LENGTH));
  return command;
};

const sanitizeMenuButton = (raw: unknown): MenuButton | undefined => {
  if (!isRecord(raw)) return undefined;
  if (raw.type === 'commands') return { type: 'commands' };
  if (raw.type === 'default') return { type: 'default' };
  if (raw.type === 'url') {
    const text = cleanString(raw.text, Limits.BUTTON_TEXT_MAX_LENGTH);
    if (text && isAllowedButtonUrl(raw.url)) return { type: 'url', text, url: raw.url };
  }
  return undefined;
};

/**
 * Sanitise an `app.prinny.bot.info` payload, or `null` if it is unusable.
 *
 * Duplicate command names are dropped after the first, so a bot cannot make
 * two different things appear under one name in a client's autocomplete.
 */
export const sanitizeBotInfo = (raw: unknown): BotInfo | null => {
  if (!isRecord(raw)) return null;

  const version = typeof raw.version === 'number' ? raw.version : 1;
  // Forward compatibility: a v2 payload may mean something else entirely by
  // these same field names, so refuse rather than half-render it.
  if (!Number.isInteger(version) || version < 1 || version > 1) return null;

  const info: BotInfo = { version };
  put(info, 'name', cleanString(raw.name, Limits.BUTTON_TEXT_MAX_LENGTH));
  put(
    info,
    'short_description',
    cleanString(raw.short_description, Limits.SHORT_DESCRIPTION_MAX_LENGTH),
  );
  put(info, 'description', cleanString(raw.description, Limits.BOT_DESCRIPTION_MAX_LENGTH));
  put(info, 'menu_button', sanitizeMenuButton(raw.menu_button));
  put(info, 'privacy_mode', cleanBool(raw.privacy_mode));

  if (Array.isArray(raw.commands)) {
    const seen = new Set<string>();
    const commands: BotCommand[] = [];
    for (const rawCommand of raw.commands) {
      if (commands.length >= Limits.COMMANDS_MAX) break;
      const command = sanitizeCommand(rawCommand);
      if (!command || seen.has(command.command)) continue;
      seen.add(command.command);
      commands.push(command);
    }
    if (commands.length > 0) info.commands = commands;
  }

  return info;
};

// ── Callback answers ─────────────────────────────────────────────────────────

/** Sanitise an incoming `app.prinny.bot.callback_answer`, or `null`. */
export const sanitizeCallbackAnswer = (
  raw: unknown,
): Omit<CallbackAnswerContent, 'm.relates_to'> | null => {
  if (!isRecord(raw)) return null;
  const id = cleanString(raw.id, 128);
  if (!id) return null;

  const answer: Omit<CallbackAnswerContent, 'm.relates_to'> = { id };
  // Line breaks survive here, unlike in a label: an alert body is a paragraph.
  if (typeof raw.text === 'string') {
    const text = stripUnsafe(raw.text, true).trim().slice(0, Limits.ANSWER_TEXT_MAX_LENGTH);
    if (text) answer.text = text;
  }
  put(answer, 'show_alert', cleanBool(raw.show_alert));
  if (isAllowedButtonUrl(raw.url)) answer.url = raw.url;

  return answer;
};

// ── Deep links ───────────────────────────────────────────────────────────────

export const isValidDeepLinkPayload = (payload: unknown): payload is string =>
  typeof payload === 'string' && Limits.DEEP_LINK_PAYLOAD_PATTERN.test(payload);
