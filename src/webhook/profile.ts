import { createHash } from 'node:crypto';

/**
 * MSC4144 per-message profiles, as the webhook server writes them.
 *
 *   com.beeper.per_message_profile = {
 *     id,                      `<webhookId>:<16 hex>`, see `profileId`
 *     displayname?,            the webhook's username for this message
 *     avatar_url?,             mxc only (see webhookIdentity in server.ts)
 *     has_fallback,            true when `Name: ` was put in front of the body
 *     "in.prinny.webhook": { id: <webhookId> }   Prinny shows a WEBHOOK badge
 *   }
 *
 * The unstable key is the one mautrix bridges, Sable and gomuks read today;
 * the Prinny client reads it too (cinny `utils/perMessageProfile.ts`), and
 * that reader's normalisation and escaping are mirrored here exactly. If they
 * drift, readers that strip the `Name: ` fallback stop recognising it and show
 * the name twice.
 */
export const PER_MESSAGE_PROFILE_KEY_UNSTABLE = 'com.beeper.per_message_profile';

/** Nested in the profile so Prinny can tell a webhook from a bridged person. */
export const PROFILE_WEBHOOK_KEY = 'in.prinny.webhook';

/** MSC4144: `id` and `displayname` are at most 255 bytes. */
const MAX_FIELD_BYTES = 255;
/** The Prinny client cuts names here; a longer one would not match its strip. */
export const DISPLAY_NAME_MAX_CHARS = 80;
const ID_HASH_HEX_CHARS = 16;

const utf8 = new TextEncoder();
const byteLength = (value: string): number => utf8.encode(value).length;

/**
 * A username as every reader will see it: whitespace runs collapsed to one
 * space, trimmed, at most 80 characters and 255 bytes. Undefined when nothing
 * is left.
 */
export function normalizeDisplayName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed).slice(0, DISPLAY_NAME_MAX_CHARS);
  while (chars.length > 0 && byteLength(chars.join('')) > MAX_FIELD_BYTES) chars.pop();
  const name = chars.join('').trim();
  return name === '' ? undefined : name;
}

/**
 * Readers group consecutive messages by this id, so it must differ whenever
 * the shown identity differs (one webhook posting as "CI" and as "Deploy"),
 * and must never be shared by two webhooks. The webhook id is a snowflake, so
 * the whole id stays far below 255 bytes.
 */
export function profileId(webhookId: string, displayname?: string, avatarUrl?: string): string {
  const digest = createHash('sha256')
    .update(`${displayname ?? ''}\0${avatarUrl ?? ''}`)
    .digest('hex')
    .slice(0, ID_HASH_HEX_CHARS);
  return `${webhookId}:${digest}`;
}

export type WebhookProfile = {
  webhookId: string;
  displayname?: string;
  avatarUrl?: string;
};

export function buildPerMessageProfile(
  profile: WebhookProfile,
  hasFallback: boolean
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    id: profileId(profile.webhookId, profile.displayname, profile.avatarUrl),
  };
  if (profile.displayname) content.displayname = profile.displayname;
  if (profile.avatarUrl) content.avatar_url = profile.avatarUrl;
  content.has_fallback = hasFallback;
  content[PROFILE_WEBHOOK_KEY] = { id: profile.webhookId };
  return content;
}

/** Same five replacements as the Prinny client, so its strip regex matches. */
export const escapeProfileHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const LEADING_P = /^<p(\s[^>]*)?>/i;

/**
 * Puts `Name: ` in front of the text, MSC4144's fallback for clients that do
 * not know per-message profiles, so they still show who is speaking.
 *
 * `body` gets `Name: `; `formatted_body` gets
 * `<strong data-mx-profile-fallback>Name: </strong>`, inside a leading `<p>`
 * so it stays on the first line. Returns false (and changes nothing) when
 * there is no text to prefix.
 */
export function applyProfileFallback(content: Record<string, unknown>, displayname: string): boolean {
  if (typeof content.body !== 'string' || content.body === '') return false;

  content.body = `${displayname}: ${content.body}`;

  if (typeof content.formatted_body === 'string') {
    const strong = `<strong data-mx-profile-fallback>${escapeProfileHtml(displayname)}: </strong>`;
    const html = content.formatted_body;
    const p = LEADING_P.exec(html);
    content.formatted_body = p
      ? `${p[0]}${strong}${html.slice(p[0].length)}`
      : `${strong}${html}`;
  }
  return true;
}

/** `body` without the fallback, for handing text back over the Discord API. */
export function stripProfileFallbackBody(body: string, displayname: string | undefined): string {
  if (!displayname) return body;
  const prefix = `${displayname}: `;
  return body.startsWith(prefix) ? body.slice(prefix.length) : body;
}
