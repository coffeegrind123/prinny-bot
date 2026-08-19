/**
 * Discord-compatible webhooks, backed by Matrix.
 *
 * Two directions, both of them Discord's:
 *
 * - **Incoming webhooks** - `WebhookServer` serves the whole Webhook Resource
 *   at Discord's paths, so anything already posting to a Discord webhook URL
 *   works against it by changing the host. Execute, the Slack- and
 *   GitHub-compatible variants, and webhook management and message editing.
 * - **Webhook events** - the outgoing direction, signed with Ed25519, with the
 *   PING handshake, signature verification and the retry policy Discord
 *   documents.
 */

export {
  SnowflakeGenerator,
  generateWebhookToken,
  isSnowflake,
  snowflakeTimestamp,
  type SnowflakeOptions,
} from './snowflake.js';

export {
  FileWebhookStore,
  MemoryWebhookStore,
  type StoredChannel,
  type StoredGuild,
  type StoredMessage,
  type StoredWebhook,
  type WebhookStore,
} from './store.js';

export {
  buildMentions,
  everyoneAllowed,
  renderComponents,
  renderDiscordText,
  renderEmbed,
  renderPoll,
  type ComponentRender,
  type DiscordTextRender,
  type RenderContext,
} from './render.js';

export { parseBoundary, parseMultipart, type MultipartField } from './multipart.js';

export { slackToExecuteBody, type SlackAttachment, type SlackWebhookBody } from './slack.js';

export { GITHUB_SUPPORTED_EVENTS, githubToExecuteBody } from './github.js';

export {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WebhookEventType,
  deliverWebhookEvent,
  handleWebhookEventRequest,
  signWebhookBody,
  verifyWebhookSignature,
  type DeliveryResult,
  type ReceiverResult,
  type WebhookEventBody,
  type WebhookEventDeliveryOptions,
  type WebhookEventPayload,
} from './events.js';

export { WebhookServer, WEBHOOK_IDENTITY_KEY, type WebhookServerOptions } from './server.js';

export * from './types.js';
