/**
 * Slack-compatible Execute Webhook: `POST /webhooks/{id}/{token}/slack`.
 *
 * Discord accepts Slack's incoming-webhook payload and maps it onto its own, so
 * anything already pointed at a Slack webhook can be re-pointed without being
 * rewritten. This does the same mapping, against the same documented
 * exclusions: `channel`, `icon_emoji`, `mrkdwn` and `mrkdwn_in` are not
 * supported and are ignored rather than rejected - a payload carrying them is
 * still a valid post, and refusing it would break the very integrations the
 * endpoint exists to accept.
 */

import type { DiscordEmbed, ExecuteWebhookBody } from './types.js';

export type SlackAttachment = {
  fallback?: string;
  color?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: Array<{ title?: string; value?: string; short?: boolean }>;
  image_url?: string;
  thumb_url?: string;
  footer?: string;
  footer_icon?: string;
  ts?: number | string;
};

export type SlackWebhookBody = {
  text?: string;
  username?: string;
  icon_url?: string;
  attachments?: SlackAttachment[];
  /** Accepted and ignored, as on Discord. */
  channel?: string;
  icon_emoji?: string;
  mrkdwn?: boolean;
};

/**
 * Slack colours are `#rrggbb`, or one of three named levels. Discord wants an
 * integer, and an unparseable colour is dropped rather than guessed - a wrong
 * accent colour on an alert is worse than none.
 */
const slackColor = (color: string | undefined): number | undefined => {
  if (!color) return undefined;
  const named: Record<string, number> = {
    good: 0x2eb886,
    warning: 0xdaa038,
    danger: 0xa30200,
  };
  const lower = color.toLowerCase();
  if (lower in named) return named[lower];
  const hex = /^#?([0-9a-f]{6})$/i.exec(color);
  return hex?.[1] === undefined ? undefined : parseInt(hex[1], 16);
};

/**
 * Slack's `mrkdwn` link syntax `<url|label>` and bare `<url>`.
 *
 * Left as-is, `<https://example.com>` would be read by the Discord renderer as
 * an escaped-embed link and by the Matrix renderer as nothing at all, so the
 * translation has to happen here rather than downstream.
 */
const slackToDiscordText = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:\/\/[^|>]+)>/g, '$1')
    .replace(/<!channel>|<!here>/g, '@everyone');
};

const attachmentToEmbed = (attachment: SlackAttachment): DiscordEmbed => {
  const embed: DiscordEmbed = {};

  const description = [attachment.pretext, attachment.text].filter(Boolean).join('\n\n');
  const mapped = slackToDiscordText(description);
  if (mapped) embed.description = mapped;

  if (attachment.title) embed.title = attachment.title;
  if (attachment.title_link) embed.url = attachment.title_link;

  const color = slackColor(attachment.color);
  if (color !== undefined) embed.color = color;

  if (attachment.author_name) {
    embed.author = { name: attachment.author_name };
    if (attachment.author_link) embed.author.url = attachment.author_link;
    if (attachment.author_icon) embed.author.icon_url = attachment.author_icon;
  }

  if (attachment.fields && attachment.fields.length > 0) {
    embed.fields = attachment.fields.map((field) => ({
      name: field.title ?? '',
      value: slackToDiscordText(field.value) ?? '',
      inline: field.short ?? false,
    }));
  }

  if (attachment.image_url) embed.image = { url: attachment.image_url };
  if (attachment.thumb_url) embed.thumbnail = { url: attachment.thumb_url };

  if (attachment.footer) embed.footer = { text: attachment.footer };
  if (attachment.footer_icon && embed.footer) embed.footer.icon_url = attachment.footer_icon;

  if (attachment.ts !== undefined) {
    const seconds = typeof attachment.ts === 'string' ? Number(attachment.ts) : attachment.ts;
    if (Number.isFinite(seconds)) embed.timestamp = new Date(seconds * 1000).toISOString();
  }

  return embed;
};

export function slackToExecuteBody(payload: SlackWebhookBody): ExecuteWebhookBody {
  const body: ExecuteWebhookBody = {};

  const content = slackToDiscordText(payload.text);
  if (content) body.content = content;
  if (payload.username) body.username = payload.username;
  if (payload.icon_url) body.avatar_url = payload.icon_url;

  // Discord caps embeds at 10 and answers 400 above that. Slack has no such
  // limit, so the extras are dropped here rather than turning a working Slack
  // integration into a stream of rejected requests.
  const attachments = (payload.attachments ?? []).slice(0, 10);
  if (attachments.length > 0) body.embeds = attachments.map(attachmentToEmbed);

  return body;
}
