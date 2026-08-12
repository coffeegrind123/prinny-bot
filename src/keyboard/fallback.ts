/**
 * Plain-text fallback.
 *
 * This is the file that makes the whole schema safe to deploy on a federated
 * network. A keyboard is invisible to a client that does not implement
 * `app.prinny.bot.*` — which today is every client except Prinny — so every
 * keyboard message also carries a numbered listing in its `body`, and the
 * clean text goes in `app.prinny.bot.plain_body` for clients that render the
 * real thing.
 *
 * The result: an Element user sees
 *
 *     Deploy to production?
 *
 *     [1] Deploy
 *     [2] Cancel
 *
 * and replies "1". `matchFallbackReply()` turns that back into the button they
 * meant, so the bot's callback handler and its text handler are one code path.
 */

import { BotContentKey } from '../protocol/constants.js';
import { buttonAction } from '../protocol/validate.js';
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  ReplyKeyboardMarkup,
  ReplyMarkup,
} from '../protocol/types.js';
import { isInlineKeyboardMarkup, isReplyKeyboardMarkup } from '../protocol/types.js';

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A button with its position, as the fallback listing numbers it. */
export type FlatButton = {
  button: InlineKeyboardButton;
  row: number;
  col: number;
  /** 1-based, as printed. */
  index: number;
};

/** Flatten a keyboard in reading order, which is the order the listing uses. */
export const flattenInlineKeyboard = (markup: InlineKeyboardMarkup): FlatButton[] => {
  const flat: FlatButton[] = [];
  markup.inline_keyboard.forEach((row, rowIndex) => {
    row.forEach((button, colIndex) => {
      flat.push({ button, row: rowIndex, col: colIndex, index: flat.length + 1 });
    });
  });
  return flat;
};

/**
 * One listing line for a button.
 *
 * URL and copy buttons print their payload, because on a client with no
 * buttons that payload *is* the affordance — a "Copy token" line the user
 * cannot copy from is worse than useless.
 */
const describeButton = ({ button, index }: FlatButton): string => {
  const action = buttonAction(button);
  switch (action.kind) {
    case 'url':
      return `[${index}] ${button.text} - ${action.url}`;
    case 'copy':
      return `[${index}] ${button.text} - ${action.text}`;
    case 'switch_inline':
      return action.query
        ? `[${index}] ${button.text} - ${action.query}`
        : `[${index}] ${button.text}`;
    case 'callback':
      return `[${index}] ${button.text}`;
    default:
      return `[${index}] ${button.text} (unsupported)`;
  }
};

const describeButtonHtml = (flat: FlatButton): string => {
  const { button, index } = flat;
  const action = buttonAction(button);
  const label = escapeHtml(button.text);
  if (action.kind === 'url') {
    return `[${index}] <a href="${escapeHtml(action.url)}">${label}</a>`;
  }
  if (action.kind === 'copy') {
    return `[${index}] ${label} - <code>${escapeHtml(action.text)}</code>`;
  }
  return `[${index}] ${label}`;
};

/** The listing appended to a body, without the leading blank line. */
export const renderFallbackListing = (markup: ReplyMarkup): string | null => {
  if (isInlineKeyboardMarkup(markup)) {
    const flat = flattenInlineKeyboard(markup);
    if (flat.length === 0) return null;
    return flat.map(describeButton).join('\n');
  }
  if (isReplyKeyboardMarkup(markup)) {
    const labels = markup.keyboard.flat().map((button) => button.text);
    if (labels.length === 0) return null;
    return `Quick replies: ${labels.join(' | ')}`;
  }
  // remove_keyboard and force_reply have nothing to show a plain client.
  return null;
};

const renderFallbackListingHtml = (markup: ReplyMarkup): string | null => {
  if (isInlineKeyboardMarkup(markup)) {
    const flat = flattenInlineKeyboard(markup);
    if (flat.length === 0) return null;
    return flat.map(describeButtonHtml).join('<br/>');
  }
  if (isReplyKeyboardMarkup(markup)) {
    const labels = (markup as ReplyKeyboardMarkup).keyboard.flat().map((b) => escapeHtml(b.text));
    if (labels.length === 0) return null;
    return `Quick replies: ${labels.join(' | ')}`;
  }
  return null;
};

export type FallbackBodies = {
  body: string;
  formatted_body?: string;
  [BotContentKey.PlainBody]?: string;
  [BotContentKey.PlainFormattedBody]?: string;
};

/**
 * Build the body fields for a message carrying `markup`.
 *
 * Returns `body`/`formatted_body` with the listing appended, plus the clean
 * copies under `app.prinny.bot.plain_body`. When the markup has nothing to
 * list, the plain copies are omitted — there is nothing to strip, so a
 * supporting client can just render `body`.
 */
export const buildFallbackBodies = (
  text: string,
  formattedText: string | undefined,
  markup: ReplyMarkup | undefined
): FallbackBodies => {
  const bodies: FallbackBodies = { body: text };
  if (formattedText !== undefined) bodies.formatted_body = formattedText;
  if (!markup) return bodies;

  const listing = renderFallbackListing(markup);
  if (!listing) return bodies;

  bodies[BotContentKey.PlainBody] = text;
  bodies.body = text.length > 0 ? `${text}\n\n${listing}` : listing;

  if (formattedText !== undefined) {
    const listingHtml = renderFallbackListingHtml(markup);
    if (listingHtml) {
      bodies[BotContentKey.PlainFormattedBody] = formattedText;
      bodies.formatted_body =
        formattedText.length > 0 ? `${formattedText}<br/><br/>${listingHtml}` : listingHtml;
    }
  }

  return bodies;
};

/**
 * Resolve a plain-text reply back to the button the user meant.
 *
 * Tried in order: the printed number, an exact case-insensitive label match,
 * then an exact `callback_data` match. Label matching is last-resort-free —
 * it will not fuzzy-match, because guessing which of "Deploy" and "Deploy to
 * staging" someone meant is exactly the moment to guess nothing.
 *
 * Returns `null` when the text is not a button reference, which is the normal
 * case for ordinary conversation and must stay cheap.
 */
export const matchFallbackReply = (
  text: string,
  markup: ReplyMarkup | undefined
): FlatButton | null => {
  if (!markup || !isInlineKeyboardMarkup(markup)) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;

  const flat = flattenInlineKeyboard(markup);
  if (flat.length === 0) return null;

  // "2" or "[2]" or "2." — the shapes people actually type.
  const numeric = trimmed.match(/^\[?(\d{1,3})\]?\.?$/);
  if (numeric) {
    const index = Number.parseInt(numeric[1]!, 10);
    return flat.find((entry) => entry.index === index) ?? null;
  }

  const lowered = trimmed.toLowerCase();
  const byLabel = flat.filter((entry) => entry.button.text.toLowerCase() === lowered);
  // Two buttons sharing a label is ambiguous; the number is the only way in.
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) return null;

  const byData = flat.filter((entry) => entry.button.callback_data === trimmed);
  return byData.length === 1 ? byData[0]! : null;
};

/**
 * The clean body of a received message: `plain_body` when the sender supplied
 * one, otherwise `body` unchanged.
 *
 * A bot reading its own conversation history wants this, not the listing it
 * generated three turns ago.
 */
export const plainBodyOf = (content: Record<string, unknown>): string => {
  const plain = content[BotContentKey.PlainBody];
  if (typeof plain === 'string') return plain;
  return typeof content.body === 'string' ? content.body : '';
};
