/**
 * Discord message payloads -> Matrix event content.
 *
 * Pure: nothing here touches the network or a Matrix client, so every mapping
 * decision is unit-testable against a literal payload. Uploads, mxc URLs and
 * sending live in the server, which passes what it resolved in through
 * `RenderContext`.
 */

import { randomBytes } from 'node:crypto';
import { markdownToMatrixHtml, stripHtml } from '../matrix/format.js';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from '../protocol/types.js';
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type AllowedMentions,
  type DiscordEmbed,
  type MessageComponent,
  type PollCreateRequest,
} from './types.js';

/**
 * What the caller was able to resolve about the Discord ids in a payload.
 *
 * All optional, and all fail soft: an unresolved mention renders as readable
 * text rather than disappearing or leaving `<@1234>` on screen. A webhook
 * posting from a system with no Discord guild behind it - a CI job, a monitor -
 * resolves nothing at all, and that is the common case, not the degraded one.
 */
export type RenderContext = {
  resolveUser?: (id: string) => { userId?: string; displayName?: string } | undefined;
  resolveChannel?: (id: string) => { roomId?: string; alias?: string; name?: string } | undefined;
  resolveRole?: (id: string) => { name?: string } | undefined;
  /** An `mxc://` URI for a custom emoji, if one has been uploaded. */
  resolveEmoji?: (emoji: { id: string; name: string; animated: boolean }) => string | undefined;
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Sentinels carry pre-rendered HTML through the markdown parser untouched.
 *
 * `markdownToMatrixHtml` escapes raw HTML on purpose (a bot must not be able to
 * inject markup by writing it), so Discord-only constructs cannot be turned
 * into HTML before parsing. They are replaced by opaque markers instead, and
 * substituted back once the parser has run.
 *
 * The marker is a run of letters and digits with a per-render random prefix.
 * Letters and digits because markdown gives a bare word no meaning — an
 * underscore or an asterisk in the marker would itself be parsed as emphasis —
 * and random because the marker has to be something the message could not have
 * contained already. A fixed marker is a hole: content that happened to spell
 * it would be replaced by HTML chosen by whoever wrote that content.
 */
class Sentinels {
  private readonly parts: string[] = [];

  private readonly prefix = `zz${randomBytes(8).toString('hex')}zz`;

  put(html: string): string {
    this.parts.push(html);
    return `${this.prefix}${this.parts.length - 1}z`;
  }

  restore(rendered: string): string {
    return rendered.replace(
      new RegExp(`${this.prefix}(\\d+)z`, 'g'),
      (_match, index: string) => this.parts[Number(index)] ?? ''
    );
  }
}

/**
 * Splits text into code and non-code runs.
 *
 * Discord's own syntax - spoilers, mentions, emoji, timestamps - is inert
 * inside a code span or fence, and rewriting it there would corrupt the one
 * kind of content people paste precisely because they want it left alone.
 */
const CODE_SPLIT = /(```[\s\S]*?```|``[\s\S]*?``|`[^`\n]*`)/g;

const splitCode = (text: string): Array<{ code: boolean; text: string }> =>
  text
    .split(CODE_SPLIT)
    .filter((part) => part !== '')
    .map((part) => ({ code: /^`/.test(part), text: part }));

const TIMESTAMP_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  t: { hour: '2-digit', minute: '2-digit' },
  T: { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  d: { year: 'numeric', month: '2-digit', day: '2-digit' },
  D: { year: 'numeric', month: 'long', day: 'numeric' },
  f: { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  F: {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
};

const relativeTime = (seconds: number, now: number): string => {
  const delta = seconds * 1000 - now;
  const abs = Math.abs(delta);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
    ['second', 1000],
  ];
  const found = units.find(([, ms]) => abs >= ms) ?? { 0: 'second' as const, 1: 1000 };
  const unit = found[0] as Intl.RelativeTimeFormatUnit;
  const ms = found[1] as number;
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(delta / ms), unit);
};

/**
 * `<t:1700000000:F>` - a Unix timestamp rendered in the *reader's* locale.
 *
 * Matrix has no equivalent, so it is resolved to text here. That loses the
 * per-reader localisation, which is the whole point of the syntax; leaving the
 * raw `<t:...>` on screen loses the meaning entirely, so the trade is one-way.
 */
const renderTimestamp = (seconds: number, style: string | undefined, now: number): string => {
  if (!Number.isFinite(seconds)) return '';
  if (style === 'R') return relativeTime(seconds, now);
  const options = TIMESTAMP_STYLES[style ?? 'f'] ?? TIMESTAMP_STYLES.f;
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(
    new Date(seconds * 1000)
  );
};

const matrixToUser = (userId: string, label: string): string =>
  `<a href="https://matrix.to/#/${encodeURIComponent(userId)}">${escapeHtml(label)}</a>`;

const matrixToRoom = (roomIdOrAlias: string, label: string): string =>
  `<a href="https://matrix.to/#/${encodeURIComponent(roomIdOrAlias)}">${escapeHtml(label)}</a>`;

type InlineOptions = {
  /** `@everyone`/`@here` only become `@room` when the payload allows it. */
  allowEveryone: boolean;
  now: number;
};

/**
 * Rewrites Discord-only inline syntax into sentinels, leaving everything the
 * markdown parser already understands (bold, italics, links, lists, quotes,
 * headings, strikethrough) exactly as written.
 */
function replaceDiscordInline(
  text: string,
  ctx: RenderContext,
  sentinels: Sentinels,
  options: InlineOptions
): string {
  let out = text;

  // Spoilers first: their delimiters are `||`, which nothing else uses, and
  // doing them before mentions means a spoilered mention still resolves.
  out = out.replace(/\|\|([\s\S]+?)\|\|/g, (_m, inner: string) => {
    const rendered = replaceDiscordInline(inner, ctx, sentinels, options);
    return sentinels.put(`<span data-mx-spoiler>${escapeHtml(stripHtml(rendered))}</span>`);
  });

  // Discord's `__x__` is underline, not bold. GFM would make it `<strong>`,
  // so it has to be taken out of the parser's hands.
  out = out.replace(/__([^_\n]+?)__/g, (_m, inner: string) =>
    sentinels.put(`<u>${escapeHtml(inner)}</u>`)
  );

  // Custom emoji: `<:name:id>` and `<a:name:id>`.
  out = out.replace(
    /<(a?):([A-Za-z0-9_]{2,32}):(\d+)>/g,
    (_m, animated: string, name: string, id: string) => {
      const mxc = ctx.resolveEmoji?.({ id, name, animated: animated === 'a' });
      if (!mxc) return sentinels.put(escapeHtml(`:${name}:`));
      return sentinels.put(
        `<img data-mx-emoticon src="${escapeHtml(mxc)}" alt=":${escapeHtml(
          name
        )}:" title=":${escapeHtml(name)}:" height="32" />`
      );
    }
  );

  // User mentions: `<@id>` and the legacy `<@!id>`.
  out = out.replace(/<@!?(\d+)>/g, (_m, id: string) => {
    const user = ctx.resolveUser?.(id);
    if (user?.userId) {
      return sentinels.put(matrixToUser(user.userId, user.displayName ?? user.userId));
    }
    return sentinels.put(escapeHtml(`@${user?.displayName ?? 'unknown-user'}`));
  });

  // Role mentions have no Matrix counterpart - there are no roles to link to.
  out = out.replace(/<@&(\d+)>/g, (_m, id: string) => {
    const role = ctx.resolveRole?.(id);
    return sentinels.put(escapeHtml(`@${role?.name ?? 'role'}`));
  });

  // Channel mentions become room pills where the channel maps to a room.
  out = out.replace(/<#(\d+)>/g, (_m, id: string) => {
    const channel = ctx.resolveChannel?.(id);
    const target = channel?.alias ?? channel?.roomId;
    if (target) return sentinels.put(matrixToRoom(target, `#${channel?.name ?? target}`));
    return sentinels.put(escapeHtml(`#${channel?.name ?? 'unknown-channel'}`));
  });

  out = out.replace(/<t:(-?\d+)(?::([tTdDfFR]))?>/g, (_m, seconds: string, style?: string) =>
    sentinels.put(escapeHtml(renderTimestamp(Number(seconds), style, options.now)))
  );

  // `@everyone`/`@here` becomes Matrix's room mention, and only when the
  // payload's allowed_mentions permits it. Rendering the pill regardless would
  // ping a room the sender explicitly asked not to ping.
  out = out.replace(/@(everyone|here)\b/g, (match) =>
    options.allowEveryone ? sentinels.put('@room') : sentinels.put(escapeHtml(match))
  );

  return out;
}

export type DiscordTextRender = { html: string; text: string };

/**
 * Discord-flavoured markdown -> Matrix HTML plus a plain-text fallback.
 */
export function renderDiscordText(
  input: string,
  ctx: RenderContext = {},
  options: Partial<InlineOptions> = {}
): DiscordTextRender {
  if (!input) return { html: '', text: '' };

  const sentinels = new Sentinels();
  const inlineOptions: InlineOptions = {
    allowEveryone: options.allowEveryone ?? false,
    now: options.now ?? Date.now(),
  };

  const prepared = splitCode(input)
    .map((part) =>
      part.code ? part.text : replaceDiscordInline(part.text, ctx, sentinels, inlineOptions)
    )
    .join('');

  const html = sentinels.restore(markdownToMatrixHtml(prepared));
  return { html, text: stripHtml(html) };
}

const embedColorHex = (color: number | undefined): string | undefined => {
  if (typeof color !== 'number' || !Number.isFinite(color)) return undefined;
  const clamped = Math.max(0, Math.min(0xffffff, Math.trunc(color)));
  return `#${clamped.toString(16).padStart(6, '0')}`;
};

const stripParagraph = (html: string): string => html.replace(/^<p>/, '').replace(/<\/p>$/, '');

/**
 * One embed -> one blockquote.
 *
 * Matrix HTML has no box with a coloured left edge, which is what an embed
 * looks like on Discord. A blockquote is the closest thing every Matrix client
 * already renders with a left rule, and `<font color>` - which the spec's
 * allowed-tag list includes precisely for this kind of thing - puts the accent
 * colour on that rule's stand-in. Clients that ignore `font` lose the colour
 * and keep the structure, which is the right way round.
 */
export function renderEmbed(embed: DiscordEmbed, ctx: RenderContext = {}): DiscordTextRender {
  const lines: string[] = [];
  const plain: string[] = [];
  const color = embedColorHex(embed.color);

  if (embed.author?.name) {
    const name = escapeHtml(embed.author.name);
    lines.push(
      embed.author.url
        ? `<b><a href="${escapeHtml(embed.author.url)}">${name}</a></b>`
        : `<b>${name}</b>`
    );
    plain.push(embed.author.name);
  }

  if (embed.title) {
    const title = stripParagraph(renderDiscordText(embed.title, ctx).html);
    lines.push(
      embed.url ? `<b><a href="${escapeHtml(embed.url)}">${title}</a></b>` : `<b>${title}</b>`
    );
    plain.push(embed.title);
  }

  if (embed.description) {
    const description = renderDiscordText(embed.description, ctx);
    lines.push(description.html);
    plain.push(description.text);
  }

  (embed.fields ?? []).forEach((field) => {
    const name = stripParagraph(renderDiscordText(field.name, ctx).html);
    const value = stripParagraph(renderDiscordText(field.value, ctx).html);
    lines.push(`<b>${name}</b><br/>${value}`);
    plain.push(`${field.name}: ${field.value}`);
  });

  // Images ride as links rather than `<img>`: an embed image is an arbitrary
  // remote URL, and a Matrix client that loaded it would leak the reader's IP
  // to whoever the webhook named. `<img>` is reserved for mxc content.
  if (embed.image?.url) {
    lines.push(`<a href="${escapeHtml(embed.image.url)}">${escapeHtml(embed.image.url)}</a>`);
    plain.push(embed.image.url);
  }
  if (embed.thumbnail?.url) {
    lines.push(
      `<a href="${escapeHtml(embed.thumbnail.url)}">${escapeHtml(embed.thumbnail.url)}</a>`
    );
    plain.push(embed.thumbnail.url);
  }

  const footerBits: string[] = [];
  if (embed.footer?.text) footerBits.push(embed.footer.text);
  if (embed.timestamp) footerBits.push(embed.timestamp);
  if (footerBits.length > 0) {
    lines.push(`<sub>${escapeHtml(footerBits.join(' - '))}</sub>`);
    plain.push(footerBits.join(' - '));
  }

  const body = lines.join('<br/>');
  const html = color
    ? `<blockquote><font color="${color}">${body}</font></blockquote>`
    : `<blockquote>${body}</blockquote>`;

  return { html, text: plain.join('\n') };
}

export type ComponentRender = {
  markup?: InlineKeyboardMarkup;
  /** Content from components-v2 display components, which are not buttons. */
  html: string;
  text: string;
};

const buttonStyleFor = (style: ButtonStyle): InlineKeyboardButton['style'] => {
  switch (style) {
    case ButtonStyle.Primary:
    case ButtonStyle.Success:
      return 'primary';
    case ButtonStyle.Danger:
      return 'danger';
    default:
      return 'default';
  }
};

const buttonLabel = (
  label: string | undefined,
  emoji: { name?: string | null } | undefined
): string => {
  const emojiText = emoji?.name ? `${emoji.name} ` : '';
  return `${emojiText}${label ?? ''}`.trim() || 'Button';
};

/**
 * Discord components -> a Prinny inline keyboard.
 *
 * These two models line up almost exactly: an action row is a keyboard row, a
 * button with `custom_id` is a callback button, a link button is a url button.
 * A client that renders Prinny keyboards therefore renders Discord components
 * as real buttons rather than as a list of dead labels.
 *
 * Select menus have no counterpart, so each option becomes its own button
 * carrying `custom_id:value` - the same callback the select would have sent.
 * That is a worse UI for a 25-option menu and a working one for the three- or
 * four-option menus webhooks actually send, which beats dropping the control.
 */
export function renderComponents(
  components: MessageComponent[] | undefined,
  ctx: RenderContext = {}
): ComponentRender {
  if (!components || components.length === 0) return { html: '', text: '' };

  const rows: InlineKeyboardButton[][] = [];
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  const walk = (list: MessageComponent[]) => {
    list.forEach((component) => {
      switch (component.type) {
        case ComponentType.ActionRow: {
          const row: InlineKeyboardButton[] = [];
          component.components.forEach((child) => {
            if (child.type === ComponentType.Button) {
              const button: InlineKeyboardButton = {
                text: buttonLabel(child.label, child.emoji),
                style: buttonStyleFor(child.style),
              };
              if (child.style === ButtonStyle.Link && child.url) button.url = child.url;
              else if (child.custom_id) button.callback_data = child.custom_id;
              row.push(button);
              return;
            }
            (child.options ?? []).forEach((option) => {
              row.push({
                text: buttonLabel(option.label, option.emoji),
                callback_data: `${child.custom_id}:${option.value}`,
              });
            });
          });
          if (row.length > 0) rows.push(row);
          break;
        }
        case ComponentType.TextDisplay: {
          const rendered = renderDiscordText(component.content, ctx);
          htmlParts.push(rendered.html);
          textParts.push(rendered.text);
          break;
        }
        case ComponentType.Separator:
          htmlParts.push('<hr>');
          textParts.push('---');
          break;
        case ComponentType.Container:
          walk(component.components);
          break;
        default:
          break;
      }
    });
  };

  walk(components);

  return {
    markup: rows.length > 0 ? { inline_keyboard: rows } : undefined,
    html: htmlParts.join(''),
    text: textParts.join('\n'),
  };
}

/**
 * `allowed_mentions` -> `m.mentions`.
 *
 * Discord's default - absent `allowed_mentions` means "parse everything in the
 * content" - is deliberately NOT reproduced. Matrix pushes on `m.mentions`
 * alone, so a webhook that never thought about mentions would otherwise notify
 * every user it happened to name. Discord's own guidance is to send
 * `allowed_mentions` explicitly; this makes the safe reading the default and
 * honours the field exactly when it is present.
 */
export function buildMentions(
  allowed: AllowedMentions | undefined,
  resolvedUsers: string[],
  flags: number | undefined
): { user_ids: string[]; room?: true } {
  if (flags !== undefined && (flags & MessageFlags.SuppressNotifications) !== 0) {
    return { user_ids: [] };
  }
  if (!allowed) return { user_ids: [] };

  const parse = new Set(allowed.parse ?? []);
  const users = new Set<string>();

  if (parse.has('users')) resolvedUsers.forEach((id) => users.add(id));
  (allowed.users ?? []).forEach((id) => users.add(id));

  const mentions: { user_ids: string[]; room?: true } = { user_ids: [...users] };
  if (parse.has('everyone')) mentions.room = true;
  return mentions;
}

/** Whether `@everyone`/`@here` in the content should render as `@room`. */
export const everyoneAllowed = (allowed: AllowedMentions | undefined): boolean =>
  (allowed?.parse ?? []).includes('everyone');

/**
 * A Discord poll -> MSC3381 `m.poll.start` content.
 *
 * `duration` (hours) and `layout_type` have no MSC3381 counterpart and are
 * dropped; `allow_multiselect` maps onto `max_selections`, which is the field
 * that actually changes what a voter can do.
 */
export function renderPoll(poll: PollCreateRequest): Record<string, unknown> {
  const question = poll.question.text ?? '';
  const answers = poll.answers
    .map((answer, index) => ({
      id: String(answer.answer_id ?? index + 1),
      'org.matrix.msc1767.text': answer.poll_media.text ?? '',
    }))
    .filter((answer) => answer['org.matrix.msc1767.text'] !== '');

  return {
    'org.matrix.msc3381.poll.start': {
      question: { 'org.matrix.msc1767.text': question },
      kind: 'org.matrix.msc3381.poll.disclosed',
      max_selections: poll.allow_multiselect ? answers.length : 1,
      answers,
    },
    'org.matrix.msc1767.text': [question, ...answers.map((a) => a['org.matrix.msc1767.text'])]
      .map((line, index) => (index === 0 ? line : `${index}. ${line}`))
      .join('\n'),
  };
}
