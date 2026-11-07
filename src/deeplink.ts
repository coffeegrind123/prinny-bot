/**
 * Deep links: Telegram's `https://t.me/bot?start=payload`, for Matrix.
 *
 *     https://prinny.app/bot/@helper:example.org?start=invite_abc
 *
 * Opening one gets the user into a DM with the bot and sends `/start
 * invite_abc`. Everything a bot needs to hand out a link, and everything a
 * client needs to read one back.
 *
 * Three forms, all read by `parseDeepLink`: the https one above, `prinny://`
 * for an installed client, and a standard `matrix:` URI (MSC2312) that any
 * client can open as a chat, with the payload in our own parameter:
 *
 *     matrix:u/helper:example.org?action=chat&app.prinny.bot.start=invite_abc
 */

import {
  DEEP_LINK_MATRIX_START_PARAM,
  DEEP_LINK_ORIGIN,
  DEEP_LINK_PATH_PREFIX,
  DEEP_LINK_SCHEME,
  DEEP_LINK_SCHEME_HOST,
  Limits,
} from './protocol/constants.js';
import { isValidDeepLinkPayload } from './protocol/validate.js';

export type DeepLink = {
  /** The bot to open a conversation with. */
  userId: string;
  /** The `/start` argument, if the link carried one. */
  payload?: string;
};

const MXID_PATTERN = /^@[^\s:]+:[^\s/]+$/;

/**
 * Build a deep link to a bot.
 *
 * Throws on an illegal payload rather than silently emitting a link that every
 * client will refuse — Telegram's rule is 1-64 characters of `A-Za-z0-9_-`,
 * and it exists because the payload has to survive being a URL parameter.
 */
export const buildDeepLink = (userId: string, payload?: string): string => {
  if (!MXID_PATTERN.test(userId)) {
    throw new RangeError(`Not a Matrix user ID: ${userId}`);
  }
  if (payload !== undefined && !isValidDeepLinkPayload(payload)) {
    throw new RangeError(
      `Deep link payload must match ${Limits.DEEP_LINK_PAYLOAD_PATTERN} (Telegram's rule): ${payload}`
    );
  }

  const url = new URL(`${DEEP_LINK_PATH_PREFIX}${encodeURIComponent(userId)}`, DEEP_LINK_ORIGIN);
  if (payload !== undefined) url.searchParams.set('start', payload);
  return url.toString();
};

/**
 * The custom-scheme form of the same link.
 *
 * Share the https one; use this where the target is known to be an installed
 * client, since an https link opened outside the app goes to the browser.
 */
export const buildDeepLinkScheme = (userId: string, payload?: string): string => {
  const https = new URL(buildDeepLink(userId, payload));
  const url = new URL(
    `${DEEP_LINK_SCHEME}//${DEEP_LINK_SCHEME_HOST}${https.pathname.slice(
      DEEP_LINK_PATH_PREFIX.length - 1
    )}`
  );
  url.search = https.search;
  return url.toString();
};

/** MSC2312 path segments: percent-encoded, but `:` is a legal pchar and kept. */
const encodeMatrixSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/%3A/gi, ':');

/**
 * The `matrix:` URI form (MSC2312): `matrix:u/<bot>?action=chat`, which any
 * client that speaks the scheme opens as a DM. Clients that know our
 * parameter also send `/start <payload>`; the rest still open the chat.
 *
 * Without a payload this is a plain chat link, which `parseDeepLink` does not
 * read back: nothing in it says the target is a bot, so a client must not
 * send `/start` to whoever it names.
 */
export const buildDeepLinkMatrixUri = (userId: string, payload?: string): string => {
  // Same checks, same errors as the https form
  buildDeepLink(userId, payload);
  const params = new URLSearchParams({ action: 'chat' });
  if (payload !== undefined) params.set(DEEP_LINK_MATRIX_START_PARAM, payload);
  return `matrix:u/${encodeMatrixSegment(userId.slice(1))}?${params.toString()}`;
};

/**
 * The user and payload of a `matrix:u/...?action=chat` URI, or null.
 *
 * Only with our payload parameter: a bare chat link can point at a person,
 * and following it must not make the client send them `/start`.
 */
const parseMatrixUri = (url: URL): DeepLink | null => {
  // Non-special scheme: everything after `matrix:` up to `?` is the path.
  const match = /^u\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  // Only a chat link means "open a DM"; a bare user link is a profile.
  if (url.searchParams.get('action') !== 'chat') return null;

  let userId: string;
  try {
    userId = `@${decodeURIComponent(match[1]!)}`;
  } catch {
    return null;
  }
  if (!MXID_PATTERN.test(userId)) return null;

  const payload = url.searchParams.get(DEEP_LINK_MATRIX_START_PARAM);
  if (payload === null || !isValidDeepLinkPayload(payload)) return null;
  return { userId, payload };
};

/**
 * Parse a deep link, or return null.
 *
 * Rejects an out-of-spec payload instead of passing it through, because the
 * receiving client turns this into a message it sends on the user's behalf —
 * so this is a place where "be liberal in what you accept" is the wrong rule.
 */
export const parseDeepLink = (link: string): DeepLink | null => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }

  if (url.protocol === 'matrix:') return parseMatrixUri(url);

  let encodedUserId: string;
  if (url.protocol === DEEP_LINK_SCHEME) {
    // A custom scheme has no meaningful `origin` — it parses as "null" — so
    // the host is checked directly instead.
    if (url.host !== DEEP_LINK_SCHEME_HOST) return null;
    encodedUserId = url.pathname.replace(/^\//, '');
  } else {
    if (url.origin !== DEEP_LINK_ORIGIN) return null;
    if (!url.pathname.startsWith(DEEP_LINK_PATH_PREFIX)) return null;
    encodedUserId = url.pathname.slice(DEEP_LINK_PATH_PREFIX.length);
  }

  // Exactly one decode: the MXID was percent-encoded on the way in, and
  // decoding twice would let `%2540` smuggle an `@` past this check.
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUserId);
  } catch {
    return null;
  }
  if (!MXID_PATTERN.test(userId)) return null;

  const payload = url.searchParams.get('start');
  if (payload === null) return { userId };
  if (!isValidDeepLinkPayload(payload)) return null;

  return { userId, payload };
};

/** The message a client sends after following a deep link. */
export const deepLinkStartMessage = (payload?: string): string =>
  payload ? `/start ${payload}` : '/start';
