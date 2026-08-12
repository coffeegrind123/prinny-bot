/**
 * Deep links: Telegram's `https://t.me/bot?start=payload`, for Matrix.
 *
 *     https://prinny.app/bot/@helper:example.org?start=invite_abc
 *
 * Opening one gets the user into a DM with the bot and sends `/start
 * invite_abc`. Everything a bot needs to hand out a link, and everything a
 * client needs to read one back.
 */

import {
  DEEP_LINK_ORIGIN,
  DEEP_LINK_PATH_PREFIX,
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

  if (!url.pathname.startsWith(DEEP_LINK_PATH_PREFIX)) return null;

  // Exactly one decode: the MXID was percent-encoded on the way in, and
  // decoding twice would let `%2540` smuggle an `@` past this check.
  const userId = decodeURIComponent(url.pathname.slice(DEEP_LINK_PATH_PREFIX.length));
  if (!MXID_PATTERN.test(userId)) return null;

  const payload = url.searchParams.get('start');
  if (payload === null) return { userId };
  if (!isValidDeepLinkPayload(payload)) return null;

  return { userId, payload };
};

/** The message a client sends after following a deep link. */
export const deepLinkStartMessage = (payload?: string): string =>
  payload ? `/start ${payload}` : '/start';
