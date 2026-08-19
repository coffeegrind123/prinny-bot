/**
 * The Discord object shapes this server speaks, verbatim.
 *
 * Field names, optionality and nullability track the Discord API reference
 * exactly — including the snake_case, including `?` vs `?: T | null`, which
 * Discord distinguishes (absent means "unchanged", null means "cleared"). A
 * client that works against Discord must work against this without a single
 * conditional, which is what "1:1" has to mean to be worth claiming.
 */

/** https://discord.com/developers/docs/resources/webhook#webhook-object-webhook-types */
export enum WebhookType {
  Incoming = 1,
  ChannelFollower = 2,
  Application = 3,
}

export type DiscordUser = {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string | null;
  avatar: string | null;
  bot?: boolean;
  system?: boolean;
  public_flags?: number;
};

export type DiscordWebhook = {
  id: string;
  type: WebhookType;
  guild_id?: string | null;
  channel_id: string | null;
  user?: DiscordUser;
  name: string | null;
  avatar: string | null;
  token?: string;
  application_id: string | null;
  source_guild?: { id: string; name: string; icon: string | null };
  source_channel?: { id: string; name: string };
  url?: string;
};

export type EmbedFooter = { text: string; icon_url?: string; proxy_icon_url?: string };
export type EmbedImage = { url: string; proxy_url?: string; height?: number; width?: number };
export type EmbedThumbnail = EmbedImage;
export type EmbedVideo = { url?: string; height?: number; width?: number };
export type EmbedProvider = { name?: string; url?: string };
export type EmbedAuthor = {
  name: string;
  url?: string;
  icon_url?: string;
  proxy_icon_url?: string;
};
export type EmbedField = { name: string; value: string; inline?: boolean };

export type DiscordEmbed = {
  title?: string;
  type?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: EmbedFooter;
  image?: EmbedImage;
  thumbnail?: EmbedThumbnail;
  video?: EmbedVideo;
  provider?: EmbedProvider;
  author?: EmbedAuthor;
  fields?: EmbedField[];
};

/** https://discord.com/developers/docs/resources/message#allowed-mentions-object */
export type AllowedMentions = {
  parse?: Array<'roles' | 'users' | 'everyone'>;
  roles?: string[];
  users?: string[];
  replied_user?: boolean;
};

export enum ComponentType {
  ActionRow = 1,
  Button = 2,
  StringSelect = 3,
  TextInput = 4,
  UserSelect = 5,
  RoleSelect = 6,
  MentionableSelect = 7,
  ChannelSelect = 8,
  Section = 9,
  TextDisplay = 10,
  Thumbnail = 11,
  MediaGallery = 12,
  File = 13,
  Separator = 14,
  Container = 17,
}

export enum ButtonStyle {
  Primary = 1,
  Secondary = 2,
  Success = 3,
  Danger = 4,
  Link = 5,
  Premium = 6,
}

export type PartialEmoji = { id?: string | null; name?: string | null; animated?: boolean };

export type ButtonComponent = {
  type: ComponentType.Button;
  style: ButtonStyle;
  label?: string;
  emoji?: PartialEmoji;
  custom_id?: string;
  sku_id?: string;
  url?: string;
  disabled?: boolean;
};

export type SelectOption = {
  label: string;
  value: string;
  description?: string;
  emoji?: PartialEmoji;
  default?: boolean;
};

export type SelectComponent = {
  type:
    | ComponentType.StringSelect
    | ComponentType.UserSelect
    | ComponentType.RoleSelect
    | ComponentType.MentionableSelect
    | ComponentType.ChannelSelect;
  custom_id: string;
  options?: SelectOption[];
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  disabled?: boolean;
};

export type TextDisplayComponent = { type: ComponentType.TextDisplay; content: string };

export type SeparatorComponent = {
  type: ComponentType.Separator;
  divider?: boolean;
  spacing?: number;
};

export type ActionRowComponent = {
  type: ComponentType.ActionRow;
  components: Array<ButtonComponent | SelectComponent>;
};

export type ContainerComponent = {
  type: ComponentType.Container;
  accent_color?: number | null;
  components: MessageComponent[];
};

export type MessageComponent =
  | ActionRowComponent
  | ButtonComponent
  | SelectComponent
  | TextDisplayComponent
  | SeparatorComponent
  | ContainerComponent;

export type AttachmentRequest = {
  id: string | number;
  filename?: string;
  description?: string;
  content_type?: string;
  /** Present on responses. */
  size?: number;
  url?: string;
  proxy_url?: string;
  height?: number | null;
  width?: number | null;
  duration_secs?: number;
  waveform?: string;
};

export type PollMedia = { text?: string; emoji?: PartialEmoji };

export type PollCreateRequest = {
  question: PollMedia;
  answers: Array<{ answer_id?: number; poll_media: PollMedia }>;
  duration?: number;
  allow_multiselect?: boolean;
  layout_type?: number;
};

/** https://discord.com/developers/docs/resources/message#message-object-message-flags */
export enum MessageFlags {
  Crossposted = 1 << 0,
  IsCrosspost = 1 << 1,
  SuppressEmbeds = 1 << 2,
  SourceMessageDeleted = 1 << 3,
  Urgent = 1 << 4,
  HasThread = 1 << 5,
  Ephemeral = 1 << 6,
  Loading = 1 << 7,
  FailedToMentionSomeRolesInThread = 1 << 8,
  SuppressNotifications = 1 << 12,
  IsVoiceMessage = 1 << 13,
  IsComponentsV2 = 1 << 15,
}

/** Body of POST /webhooks/{id}/{token} — Execute Webhook. */
export type ExecuteWebhookBody = {
  content?: string;
  username?: string;
  avatar_url?: string;
  tts?: boolean;
  embeds?: DiscordEmbed[];
  allowed_mentions?: AllowedMentions;
  components?: MessageComponent[];
  payload_json?: string;
  attachments?: AttachmentRequest[];
  flags?: number;
  thread_name?: string;
  applied_tags?: string[];
  poll?: PollCreateRequest;
};

/** Body of PATCH /webhooks/{id}/{token}/messages/{id} — every field nullable. */
export type EditWebhookMessageBody = {
  content?: string | null;
  embeds?: DiscordEmbed[] | null;
  flags?: number | null;
  allowed_mentions?: AllowedMentions | null;
  components?: MessageComponent[] | null;
  payload_json?: string | null;
  attachments?: AttachmentRequest[] | null;
  poll?: PollCreateRequest | null;
};

export type DiscordMessage = {
  id: string;
  type: number;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  tts: boolean;
  mention_everyone: boolean;
  mentions: DiscordUser[];
  mention_roles: string[];
  attachments: AttachmentRequest[];
  embeds: DiscordEmbed[];
  components?: MessageComponent[];
  pinned: boolean;
  webhook_id?: string;
  flags?: number;
  position?: number;
};

/** A file part of a multipart Execute Webhook request. */
export type UploadedFile = {
  /** `files[n]` → n, so `attachments[].id` can address it. */
  index: number;
  filename: string;
  contentType: string;
  data: Buffer;
};

export type DiscordErrorBody = {
  code: number;
  message: string;
  errors?: Record<string, unknown>;
};
