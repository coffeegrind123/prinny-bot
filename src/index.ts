export { Bot, type BotOptions } from './Bot.js';
export {
  Api,
  type AnswerCallbackOptions,
  type AttachmentSource,
  type MediaOptions,
  type MessageOptions,
  type PendingCallback,
  type ReplyMarkupLike,
} from './Api.js';
export {
  Composer,
  matchesFilter,
  runMiddleware,
  type FilterQuery,
  type Middleware,
  type NextFunction,
} from './Composer.js';
export {
  Context,
  type CallbackQuery,
  type CommandMatch,
  type UpdateKind,
} from './Context.js';

export { InlineKeyboard } from './keyboard/InlineKeyboard.js';
export { Keyboard, forceReply, removeKeyboard } from './keyboard/Keyboard.js';
export {
  buildFallbackBodies,
  flattenInlineKeyboard,
  matchFallbackReply,
  plainBodyOf,
  renderFallbackListing,
  type FlatButton,
} from './keyboard/fallback.js';

export {
  CommandRegistry,
  isCommandForBot,
  parseCommand,
  type CommandDefinition,
} from './commands.js';
export {
  AccessControl,
  RateLimiter,
  type AccessDecision,
  type AccessOptions,
  type AccessState,
  type RateLimitOptions,
} from './access.js';
export {
  FileSessionStorage,
  MemorySessionStorage,
  SessionManager,
  type SessionOptions,
  type SessionStorage,
} from './session.js';
export {
  buildDeepLink,
  buildDeepLinkScheme,
  deepLinkStartMessage,
  parseDeepLink,
  type DeepLink,
} from './deeplink.js';

export {
  chunkMatrixText,
  formatForMatrix,
  markdownToMatrixHtml,
  stripHtml,
  validateSize,
} from './matrix/format.js';
export { flushCryptoStore, initCryptoStore } from './matrix/cryptoStore.js';

export {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  buildMediaContent,
  decodeBase64,
  decryptEncryptedAttachment,
  downloadAttachment,
  encryptAttachment,
  imageDimensions,
  isAudioContent,
  isFileContent,
  isImageContent,
  isMediaContent,
  isSupportedImageMime,
  isVideoContent,
  mimeFromFilename,
  roomIsEncrypted,
  sanitizeFilename,
  sniffMime,
  uploadAttachment,
  type AttachmentInput,
  type DownloadOptions,
  type DownloadedFile,
  type MatrixEncryptedFile,
  type MatrixMediaContent,
  type MatrixMediaInfo,
  type UploadedAttachment,
} from './matrix/media.js';

export {
  AUDIO_INFO,
  PCM_SAMPLE_RATE,
  VOICE_MARKER,
  WAVEFORM_BUCKETS,
  WAVEFORM_MAX,
  audioToPcm,
  buildVoiceContent,
  computeWaveform,
  hasFfmpeg,
  isVoiceMessage,
  pcmDurationMs,
  transcribeAudio,
  voiceDuration,
  type AudioBlock,
  type TranscribeResult,
  type Transcriber,
  type VoiceMessageContent,
  type VoiceMetadata,
} from './matrix/voice.js';

export {
  REACTION_DONE,
  REACTION_ERROR,
  REACTION_WORKING,
  TurnReactions,
  addReaction,
  removeReaction,
  type ReactionHandle,
  type TurnReactionsOptions,
} from './matrix/reactions.js';

export * from './protocol/index.js';

/**
 * The pieces of matrix-js-sdk a consumer needs to work with `bot.matrixClient`.
 *
 * Re-exported rather than left to the caller's own dependency because
 * matrix-js-sdk **throws on being loaded twice** ("Multiple matrix-js-sdk
 * entrypoints detected!"). An application that installs its own copy alongside
 * this one crashes at import, and the error names neither package. Importing
 * these from here guarantees a single instance.
 */
export {
  ClientEvent,
  EventTimeline,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
export type {
  IContent,
  MatrixClient,
  MatrixEvent,
  Room,
  RoomMember,
} from 'matrix-js-sdk';
