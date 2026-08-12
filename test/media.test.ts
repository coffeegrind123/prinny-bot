import { describe, expect, it } from 'vitest';
import {
  decodeBase64,
  decryptEncryptedAttachment,
  encryptAttachment,
  imageDimensions,
  isAudioContent,
  isFileContent,
  isImageContent,
  isMediaContent,
  isSupportedImageMime,
  mimeFromFilename,
  sanitizeFilename,
  sniffMime,
} from '../src/matrix/media.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal PNG: signature, then an IHDR carrying the dimensions. */
const png = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
};

const gif = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'latin1');
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
};

/** SOI followed directly by a baseline SOF0 frame header. */
const jpeg = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(11);
  buf.writeUInt16BE(0xffd8, 0);
  buf.writeUInt16BE(0xffc0, 2);
  buf.writeUInt16BE(17, 4); // segment length
  buf.writeUInt8(8, 6); // sample precision
  buf.writeUInt16BE(h, 7);
  buf.writeUInt16BE(w, 9);
  return buf;
};

/** RIFF/WEBP with a VP8X chunk, whose canvas dimensions are stored minus one. */
const webp = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16);
  buf.writeUInt8(0, 20);
  const writeU24 = (value: number, offset: number) => {
    buf.writeUInt8(value & 0xff, offset);
    buf.writeUInt8((value >> 8) & 0xff, offset + 1);
    buf.writeUInt8((value >> 16) & 0xff, offset + 2);
  };
  writeU24(w - 1, 24);
  writeU24(h - 1, 27);
  return buf;
};

// ── Attachment crypto ────────────────────────────────────────────────────────

describe('attachment encryption', () => {
  const plaintext = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');

  it('round-trips through encrypt and decrypt', () => {
    const { ciphertext, file } = encryptAttachment(plaintext, 'text/plain');
    expect(ciphertext.equals(plaintext)).toBe(false);

    const decrypted = decryptEncryptedAttachment(ciphertext, { ...file, url: 'mxc://x/y' });
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('produces spec-shaped v2 metadata', () => {
    const { file } = encryptAttachment(plaintext, 'image/png');
    expect(file.v).toBe('v2');
    expect(file.key.alg).toBe('A256CTR');
    expect(file.key.kty).toBe('oct');
    expect(decodeBase64(file.key.k)).toHaveLength(32);
    expect(decodeBase64(file.iv)).toHaveLength(16);
    // The Matrix CTR convention: 8 random bytes, then 8 zero bytes of counter.
    // A random low half would overflow into the nonce partway through a file.
    expect(decodeBase64(file.iv).subarray(8).equals(Buffer.alloc(8))).toBe(true);
    expect(file.hashes.sha256).not.toMatch(/=$/);
  });

  it('rejects tampered ciphertext before decrypting it', () => {
    const { ciphertext, file } = encryptAttachment(plaintext, 'text/plain');
    ciphertext.writeUInt8(ciphertext.readUInt8(0) ^ 0xff, 0);
    expect(() => decryptEncryptedAttachment(ciphertext, { ...file, url: 'mxc://x/y' })).toThrow(
      /SHA-256 mismatch/
    );
  });

  it('rejects a key or IV of the wrong length', () => {
    const { ciphertext, file } = encryptAttachment(plaintext, 'text/plain');
    expect(() =>
      decryptEncryptedAttachment(ciphertext, {
        ...file,
        url: 'x',
        key: { ...file.key, k: Buffer.alloc(16).toString('base64url') },
      })
    ).toThrow(/key length/);
    expect(() =>
      decryptEncryptedAttachment(ciphertext, {
        ...file,
        url: 'x',
        iv: Buffer.alloc(8).toString('base64'),
      })
    ).toThrow(/IV length/);
  });

  it('accepts the base64url the key field is written in', () => {
    // `k` is base64url per the spec while `iv` and the hash are standard
    // base64; a decoder that only handled one of the two would fail on roughly
    // every fourth key, which is a memorable way to find out.
    const { ciphertext, file } = encryptAttachment(Buffer.alloc(64, 7), 'application/octet-stream');
    expect(decryptEncryptedAttachment(ciphertext, { ...file, url: 'x' })).toHaveLength(64);
  });

  it('handles an empty attachment', () => {
    const { ciphertext, file } = encryptAttachment(Buffer.alloc(0), 'text/plain');
    expect(decryptEncryptedAttachment(ciphertext, { ...file, url: 'x' })).toHaveLength(0);
  });
});

// ── MIME ─────────────────────────────────────────────────────────────────────

describe('sniffMime', () => {
  it('identifies formats by their magic bytes', () => {
    expect(sniffMime(png(1, 1))).toBe('image/png');
    expect(sniffMime(gif(1, 1))).toBe('image/gif');
    expect(sniffMime(jpeg(1, 1))).toBe('image/jpeg');
    expect(sniffMime(webp(1, 1))).toBe('image/webp');
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('OggS____'))).toBe('audio/ogg');
  });

  it('returns null for bytes it does not recognise', () => {
    expect(sniffMime(Buffer.from('just some text'))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('mimeFromFilename', () => {
  it('maps common extensions', () => {
    expect(mimeFromFilename('report.pdf')).toBe('application/pdf');
    expect(mimeFromFilename('CLIP.OGG')).toBe('audio/ogg');
  });

  it('falls back for anything unknown or extensionless', () => {
    expect(mimeFromFilename('binary')).toBe('application/octet-stream');
    expect(mimeFromFilename('a.qqq')).toBe('application/octet-stream');
  });
});

describe('isSupportedImageMime', () => {
  it('accepts the four renderable image types, with parameters', () => {
    expect(isSupportedImageMime('image/png')).toBe(true);
    expect(isSupportedImageMime('image/jpeg; charset=binary')).toBe(true);
    expect(isSupportedImageMime('image/svg+xml')).toBe(false);
    expect(isSupportedImageMime(undefined)).toBe(false);
  });
});

// ── Dimensions ───────────────────────────────────────────────────────────────

describe('imageDimensions', () => {
  it('reads PNG, GIF, JPEG and WebP headers', () => {
    expect(imageDimensions(png(800, 600))).toEqual({ w: 800, h: 600 });
    expect(imageDimensions(gif(120, 90))).toEqual({ w: 120, h: 90 });
    expect(imageDimensions(jpeg(1920, 1080))).toEqual({ w: 1920, h: 1080 });
    // VP8X stores canvas size minus one; off-by-one here is invisible until a
    // client lays out against it.
    expect(imageDimensions(webp(640, 480))).toEqual({ w: 640, h: 480 });
  });

  it('returns null rather than throwing on truncated or foreign bytes', () => {
    expect(imageDimensions(Buffer.from('not an image'))).toBeNull();
    expect(imageDimensions(png(10, 10).subarray(0, 12))).toBeNull();
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
  });
});

// ── Filenames ────────────────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('strips traversal and separators', () => {
    // A bot that saves what it is sent is one `../` from writing outside its
    // working directory, and the name comes from whoever uploaded the file.
    // Separators become underscores and any leading dots are dropped, so
    // nothing that comes out of here can climb out of a directory.
    expect(sanitizeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFilename('/abs/path.txt')).toBe('_abs_path.txt');
    expect(sanitizeFilename('..')).toBe('upload.bin');
  });

  it('keeps ordinary names intact', () => {
    expect(sanitizeFilename('Screenshot 2026-08-13.png')).toBe('Screenshot 2026-08-13.png');
  });

  it('caps length and substitutes for nothing usable', () => {
    expect(sanitizeFilename(`${'x'.repeat(300)}.png`)).toHaveLength(120);
    expect(sanitizeFilename(undefined)).toBe('upload.bin');
    expect(sanitizeFilename('!!!')).toBe('___');
  });
});

// ── Content predicates ───────────────────────────────────────────────────────

describe('content predicates', () => {
  const image = { msgtype: 'm.image', body: 'a.png', url: 'mxc://s/1' };
  const encryptedFile = { msgtype: 'm.file', body: 'a.zip', file: { url: 'mxc://s/2' } };
  const audio = { msgtype: 'm.audio', body: 'a.ogg', url: 'mxc://s/3' };

  it('recognises each kind, encrypted or not', () => {
    expect(isImageContent(image)).toBe(true);
    expect(isFileContent(encryptedFile)).toBe(true);
    expect(isAudioContent(audio)).toBe(true);
    expect(isMediaContent(image)).toBe(true);
    expect(isMediaContent(audio)).toBe(true);
  });

  it('rejects a media msgtype with nothing behind it', () => {
    // An image event with no url and no file has nothing to download; treating
    // it as media means a fetch that fails later instead of a check that fails
    // now.
    expect(isImageContent({ msgtype: 'm.image', body: 'a.png' })).toBe(false);
    expect(isFileContent({ msgtype: 'm.file' })).toBe(false);
  });

  it('rejects text and non-objects', () => {
    expect(isMediaContent({ msgtype: 'm.text', body: 'hello' })).toBe(false);
    expect(isImageContent(null)).toBe(false);
    expect(isImageContent('m.image')).toBe(false);
  });
});
