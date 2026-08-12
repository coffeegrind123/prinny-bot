/**
 * Matrix attachments: download, decrypt, encrypt, upload.
 *
 * Ported from openclaude's `src/services/matrix/media.ts`, minus the parts that
 * were about feeding images to Claude — `resizeForVision` (a `sharp`
 * dependency) and the Anthropic `ContentBlockParam` builders. Those are an
 * application's business, not a bot framework's.
 *
 * Added here, because a framework that can only receive attachments is half a
 * framework: the upload side, and a dependency-free image header parser so
 * outgoing images carry the `info.w`/`info.h` that clients need to reserve
 * layout space before the bytes arrive.
 *
 * The EncryptedFile crypto is implemented inline with `node:crypto` rather than
 * pulling in a library. The format (v2, AES-256-CTR with a SHA-256 over the
 * *ciphertext*) is short, fully specified and stable.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { MatrixClient } from 'matrix-js-sdk';

// ── Types ────────────────────────────────────────────────────────────────────

/** Matrix EncryptedFile, spec v2. */
export type MatrixEncryptedFile = {
  url: string;
  key: { kty?: string; alg?: string; k: string; ext?: boolean; key_ops?: string[] };
  iv: string;
  hashes: { sha256: string };
  v?: string;
  mimetype?: string;
};

export type MatrixMediaInfo = {
  mimetype?: string;
  size?: number;
  w?: number;
  h?: number;
  /** Milliseconds. Audio and video. */
  duration?: number;
};

/** The media-bearing subset of an `m.room.message` content. */
export type MatrixMediaContent = {
  msgtype?: string;
  body?: string;
  filename?: string;
  url?: string;
  file?: MatrixEncryptedFile;
  info?: MatrixMediaInfo;
};

export type DownloadedFile = {
  data: Buffer;
  filename: string;
  mimeType: string;
};

/** Default caps. Generous, but a bot should never be handed an unbounded read. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// ── base64 ───────────────────────────────────────────────────────────────────

/** Decode base64 or base64url. Matrix mixes both across its media fields. */
export const decodeBase64 = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Unpadded standard base64 — how Matrix encodes hashes. */
const base64Unpadded = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '');

// ── Attachment crypto ────────────────────────────────────────────────────────

/**
 * Decrypt a Matrix EncryptedFile body and verify its SHA-256.
 *
 * The hash covers the *ciphertext*, and it is checked before decrypting — so a
 * tampered attachment is rejected without its bytes ever being run through the
 * cipher. Throws on a bad key or IV length, or on a hash mismatch.
 */
export const decryptEncryptedAttachment = (
  ciphertext: Buffer,
  file: MatrixEncryptedFile
): Buffer => {
  const key = decodeBase64(file.key?.k ?? '');
  if (key.length !== 32) {
    throw new Error(`bad AES key length ${key.length} (expected 32)`);
  }
  const iv = decodeBase64(file.iv ?? '');
  if (iv.length !== 16) {
    throw new Error(`bad IV length ${iv.length} (expected 16)`);
  }

  const expected = file.hashes?.sha256;
  if (expected) {
    const actual = base64Unpadded(createHash('sha256').update(ciphertext).digest());
    if (actual !== expected.replace(/=+$/, '')) {
      throw new Error('attachment SHA-256 mismatch (corrupt or tampered)');
    }
  }

  const decipher = createDecipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

/**
 * Encrypt a buffer into a Matrix EncryptedFile. The inverse of the above.
 *
 * Returns the ciphertext to upload plus the `file` metadata to put in the
 * message content — minus `url`, which is only known after the upload.
 */
export const encryptAttachment = (
  data: Buffer,
  mimetype: string
): { ciphertext: Buffer; file: Omit<MatrixEncryptedFile, 'url'> } => {
  const key = randomBytes(32);
  // CTR IV: 8 random bytes high, 8 zero bytes low. The low half is the block
  // counter, so starting it at zero is what lets the stream be seekable — and
  // random bytes there would silently overflow into the nonce on a long file.
  const iv = Buffer.concat([randomBytes(8), Buffer.alloc(8)]);
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);

  return {
    ciphertext,
    file: {
      key: {
        kty: 'oct',
        alg: 'A256CTR',
        k: key.toString('base64url'),
        ext: true,
        key_ops: ['encrypt', 'decrypt'],
      },
      iv: iv.toString('base64'),
      hashes: { sha256: base64Unpadded(createHash('sha256').update(ciphertext).digest()) },
      v: 'v2',
      mimetype,
    },
  };
};

// ── MIME ─────────────────────────────────────────────────────────────────────

const EXTENSION_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  csv: 'text/csv',
  log: 'text/plain',
  html: 'text/html',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  patch: 'text/x-patch',
  diff: 'text/x-patch',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

export const mimeFromFilename = (name: string): string => {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return EXTENSION_MIME[ext] ?? 'application/octet-stream';
};

/**
 * Identify a file from its leading bytes.
 *
 * Preferred over the filename wherever both are available: an extension is a
 * claim by whoever named the file, the magic bytes are what it actually is.
 */
export const sniffMime = (buf: Buffer): string | null => {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return 'application/zip';
  return null;
};

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Whether `data` is an image format `imageDimensions` can measure. */
export const isSupportedImageMime = (mime: string | undefined): boolean =>
  mime !== undefined && IMAGE_MIMES.has(mime.split(';')[0]!.trim().toLowerCase());

// ── Image dimensions ─────────────────────────────────────────────────────────

const jpegDimensions = (buf: Buffer): { w: number; h: number } | null => {
  // Walk the segment chain looking for a Start Of Frame. Everything else is
  // skipped by its declared length, which is why this does not need a decoder.
  let offset = 2;
  // Width lives at offset+7..8, so offset+8 must be readable — no more than
  // that. Requiring an extra byte silently fails on a JPEG whose frame header
  // is the last thing in the buffer.
  while (offset + 8 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1]!;
    // SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc), which are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(offset + 5), w: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
};

const webpDimensions = (buf: Buffer): { w: number; h: number } | null => {
  const format = buf.subarray(12, 16).toString('latin1');
  if (format === 'VP8 ' && buf.length >= 30) {
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (format === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X' && buf.length >= 30) {
    // 24-bit little-endian, stored as one less than the real value.
    const w = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1;
    const h = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1;
    return { w, h };
  }
  return null;
};

/**
 * Read an image's pixel dimensions from its header, or null.
 *
 * Header parsing rather than a decoder dependency: clients use `info.w`/`info.h`
 * to reserve space before the bytes arrive, so an image sent without them makes
 * the timeline jump when it loads. That is worth a hundred lines; it is not
 * worth adding `sharp` to a chat library.
 */
export const imageDimensions = (buf: Buffer): { w: number; h: number } | null => {
  try {
    const mime = sniffMime(buf);
    if (mime === 'image/png' && buf.length >= 24) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buf.length >= 10) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') return jpegDimensions(buf);
    if (mime === 'image/webp') return webpDimensions(buf);
  } catch {
    // A truncated or malformed header is not worth failing a send over; the
    // message still goes, the client just reflows when the image loads.
  }
  return null;
};

// ── Content predicates ───────────────────────────────────────────────────────

const hasMedia = (c: MatrixMediaContent): boolean => !!c.url || !!c.file?.url;

export const isImageContent = (content: unknown): content is MatrixMediaContent => {
  if (!content || typeof content !== 'object') return false;
  const c = content as MatrixMediaContent;
  return c.msgtype === 'm.image' && hasMedia(c);
};

export const isFileContent = (content: unknown): content is MatrixMediaContent => {
  if (!content || typeof content !== 'object') return false;
  const c = content as MatrixMediaContent;
  return (
    (c.msgtype === 'm.file' || c.msgtype === 'm.audio' || c.msgtype === 'm.video') && hasMedia(c)
  );
};

export const isAudioContent = (content: unknown): content is MatrixMediaContent => {
  if (!content || typeof content !== 'object') return false;
  const c = content as MatrixMediaContent;
  return c.msgtype === 'm.audio' && hasMedia(c);
};

export const isVideoContent = (content: unknown): content is MatrixMediaContent => {
  if (!content || typeof content !== 'object') return false;
  const c = content as MatrixMediaContent;
  return c.msgtype === 'm.video' && hasMedia(c);
};

/** Any downloadable attachment, including stickers. */
export const isMediaContent = (content: unknown): content is MatrixMediaContent =>
  isImageContent(content) || isFileContent(content);

/**
 * Strip path separators and traversal out of an attachment filename.
 *
 * A bot that saves what it is sent is one `../` away from writing outside its
 * working directory, and the name comes from whoever uploaded the file.
 */
export const sanitizeFilename = (name: string | undefined): string => {
  const base = (name ?? 'upload.bin').replace(/[/\\]/g, '_').replace(/^\.+/, '');
  const cleaned = base
    .replace(/[^\w.\- ]/g, '_')
    .slice(0, 120)
    .trim();
  return cleaned || 'upload.bin';
};

// ── Download ─────────────────────────────────────────────────────────────────

/**
 * Fetch the bytes behind an `mxc://` URL.
 *
 * Tries the authenticated media endpoint first, because modern Synapse requires
 * it, and falls back to the legacy unauthenticated one on 401/404 for older
 * homeservers. `maxBytes` is enforced after the read, so a server that lies
 * about `Content-Length` still cannot hand back something unbounded.
 */
const fetchMxc = async (
  client: MatrixClient,
  mxc: string,
  accessToken: string | undefined,
  doFetch: typeof fetch,
  maxBytes: number
): Promise<Buffer> => {
  const attempts: Array<{ url: string; auth: boolean }> = [];
  const authed = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
  if (authed) attempts.push({ url: authed, auth: true });
  const legacy = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, false);
  if (legacy && legacy !== authed) attempts.push({ url: legacy, auth: false });
  if (attempts.length === 0) throw new Error(`cannot resolve mxc url: ${mxc}`);

  let lastError: Error | undefined;
  for (const attempt of attempts) {
    try {
      const headers: Record<string, string> = {};
      if (attempt.auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
      // Sequential: the second attempt only exists as a fallback for what the
      // first one might reject, so racing them would double every request.
      const response = await doFetch(attempt.url, { headers });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} for ${attempt.url}`);
        if (attempt.auth && (response.status === 401 || response.status === 404)) continue;
        throw lastError;
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > maxBytes) {
        throw new Error(`attachment too large (${buf.length} bytes > ${maxBytes})`);
      }
      return buf;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('media download failed');
};

export type DownloadOptions = {
  maxBytes?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  accessToken?: string;
};

/**
 * Download an attachment, decrypting it when the room was encrypted.
 *
 * The declared size is checked before the request so an obviously oversized
 * attachment costs nothing to refuse, and again after, because the declaration
 * is the sender's claim rather than a fact.
 */
export const downloadAttachment = async (
  client: MatrixClient,
  content: MatrixMediaContent,
  options: DownloadOptions = {}
): Promise<DownloadedFile> => {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const doFetch = options.fetchImpl ?? fetch;
  const accessToken = options.accessToken ?? client.getAccessToken() ?? undefined;

  const encrypted = content.file;
  const mxc = encrypted?.url ?? content.url;
  if (!mxc) throw new Error('attachment has no mxc url');

  const declaredSize = content.info?.size;
  if (typeof declaredSize === 'number' && declaredSize > maxBytes) {
    throw new Error(`attachment too large (${declaredSize} bytes > ${maxBytes})`);
  }

  const raw = await fetchMxc(client, mxc, accessToken, doFetch, maxBytes);
  const data = encrypted ? decryptEncryptedAttachment(raw, encrypted) : raw;
  if (data.length > maxBytes) {
    throw new Error(`attachment too large (${data.length} bytes > ${maxBytes})`);
  }

  const filename = sanitizeFilename(content.filename ?? content.body);
  return {
    data,
    filename,
    mimeType:
      sniffMime(data) ??
      encrypted?.mimetype ??
      content.info?.mimetype ??
      mimeFromFilename(filename),
  };
};

// ── Upload ───────────────────────────────────────────────────────────────────

export type AttachmentInput = {
  data: Buffer;
  filename: string;
  /** Inferred from the bytes, then the filename, when omitted. */
  mimeType?: string;
};

export type UploadedAttachment = {
  /** `url` for an unencrypted room, `file` for an encrypted one. */
  url?: string;
  file?: MatrixEncryptedFile;
  mimeType: string;
  size: number;
};

/** Whether this room's messages must be encrypted. */
export const roomIsEncrypted = (client: MatrixClient, roomId: string): boolean =>
  client.getRoom(roomId)?.hasEncryptionStateEvent?.() ?? false;

/**
 * Upload an attachment, encrypting it first when the room is encrypted.
 *
 * The encrypted path uploads ciphertext under `application/octet-stream` — the
 * real type belongs in the `file` metadata, and announcing it to the media repo
 * would leak what an encrypted attachment is to anyone who can see the upload.
 */
export const uploadAttachment = async (
  client: MatrixClient,
  roomId: string,
  input: AttachmentInput
): Promise<UploadedAttachment> => {
  const filename = sanitizeFilename(input.filename);
  const mimeType = input.mimeType ?? sniffMime(input.data) ?? mimeFromFilename(filename);
  const size = input.data.length;

  if (roomIsEncrypted(client, roomId)) {
    const { ciphertext, file } = encryptAttachment(input.data, mimeType);
    const upload = await client.uploadContent(new Uint8Array(ciphertext), {
      name: filename,
      type: 'application/octet-stream',
    });
    return { file: { ...file, url: upload.content_uri }, mimeType, size };
  }

  // Buffer -> Uint8Array view: matrix-js-sdk types `uploadContent` against the
  // browser BufferSource overload, which a Node Buffer does not satisfy.
  const upload = await client.uploadContent(new Uint8Array(input.data), {
    name: filename,
    type: mimeType,
  });
  return { url: upload.content_uri, mimeType, size };
};

/** Message content for an uploaded attachment. */
export const buildMediaContent = (
  msgtype: 'm.image' | 'm.file' | 'm.audio' | 'm.video',
  body: string,
  uploaded: UploadedAttachment,
  extraInfo: MatrixMediaInfo = {}
): Record<string, unknown> => {
  const content: Record<string, unknown> = {
    msgtype,
    body,
    filename: body,
    info: { mimetype: uploaded.mimeType, size: uploaded.size, ...extraInfo },
  };
  if (uploaded.url) content.url = uploaded.url;
  if (uploaded.file) content.file = uploaded.file;
  return content;
};
