import { describe, expect, it } from 'vitest';
import {
  AUDIO_INFO,
  VOICE_MARKER,
  WAVEFORM_BUCKETS,
  WAVEFORM_MAX,
  buildVoiceContent,
  computeWaveform,
  isVoiceMessage,
  pcmDurationMs,
  voiceDuration,
} from '../src/matrix/voice.js';
import type { UploadedAttachment } from '../src/matrix/media.js';

/** `samples` of 16-bit LE mono PCM, each at `amplitude` (0..1). */
const pcm = (samples: number, amplitude = 1): Buffer => {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(amplitude * 32767), i * 2);
  }
  return buf;
};

const uploaded: UploadedAttachment = {
  url: 'mxc://server/abc',
  mimeType: 'audio/ogg',
  size: 4096,
};

describe('pcmDurationMs', () => {
  it('measures against the sample rate', () => {
    // 16000 samples at 16 kHz is one second.
    expect(pcmDurationMs(pcm(16_000))).toBe(1000);
    expect(pcmDurationMs(pcm(8_000))).toBe(500);
    expect(pcmDurationMs(Buffer.alloc(0))).toBe(0);
  });
});

describe('computeWaveform', () => {
  it('returns the requested number of buckets', () => {
    expect(computeWaveform(pcm(16_000))).toHaveLength(WAVEFORM_BUCKETS);
    expect(computeWaveform(pcm(16_000), 30)).toHaveLength(30);
  });

  it('scales the loudest bucket to the maximum', () => {
    const wave = computeWaveform(pcm(1200), 10);
    expect(Math.max(...wave)).toBe(WAVEFORM_MAX);
    expect(Math.min(...wave)).toBeGreaterThan(0);
  });

  it('shows shape in a quiet recording rather than a flat line', () => {
    // Scaling against the loudest bucket rather than full scale is the whole
    // reason a quiet voice note does not render as a dead line.
    const quiet = computeWaveform(pcm(1200, 0.02), 10);
    expect(Math.max(...quiet)).toBe(WAVEFORM_MAX);
  });

  it('returns zeroes for silence and for no audio at all', () => {
    expect(computeWaveform(Buffer.alloc(2000), 10)).toEqual(new Array(10).fill(0));
    expect(computeWaveform(Buffer.alloc(0), 10)).toEqual(new Array(10).fill(0));
  });

  it('stays within 0 and 1024', () => {
    const wave = computeWaveform(pcm(5000, 1), 20);
    expect(wave.every((v) => v >= 0 && v <= WAVEFORM_MAX)).toBe(true);
  });
});

describe('isVoiceMessage', () => {
  it('requires the MSC3245 marker, not just m.audio', () => {
    // Without this distinction a bot tries to transcribe every album someone
    // drops in the room.
    expect(isVoiceMessage({ msgtype: 'm.audio', [VOICE_MARKER]: {} })).toBe(true);
    expect(isVoiceMessage({ msgtype: 'm.audio', body: 'song.mp3' })).toBe(false);
    expect(isVoiceMessage({ msgtype: 'm.file', [VOICE_MARKER]: {} })).toBe(false);
    expect(isVoiceMessage(null)).toBe(false);
  });
});

describe('voiceDuration', () => {
  it('prefers the audio block, falling back to info', () => {
    expect(voiceDuration({ [AUDIO_INFO]: { duration: 4200 }, info: { duration: 1 } })).toBe(4200);
    expect(voiceDuration({ info: { duration: 900 } })).toBe(900);
    expect(voiceDuration({})).toBeUndefined();
  });
});

describe('buildVoiceContent', () => {
  it('carries the marker and the audio block', () => {
    const content = buildVoiceContent('Voice message', uploaded, { pcm: pcm(32_000) });

    expect(content.msgtype).toBe('m.audio');
    expect(content[VOICE_MARKER]).toEqual({});
    expect(content.url).toBe('mxc://server/abc');

    const audio = content[AUDIO_INFO] as { duration: number; waveform: number[] };
    expect(audio.duration).toBe(2000);
    expect(audio.waveform).toHaveLength(WAVEFORM_BUCKETS);
    expect((content.info as { duration: number }).duration).toBe(2000);
  });

  it('accepts an explicit duration and waveform', () => {
    const content = buildVoiceContent('v', uploaded, { duration: 1234, waveform: [0, 512, 1024] });
    expect(content[AUDIO_INFO]).toEqual({ duration: 1234, waveform: [0, 512, 1024] });
  });

  it('still marks the message when nothing is known about the audio', () => {
    // A flat waveform plays fine; a missing marker downgrades the whole thing
    // to a file attachment, so the marker is the part that must not be lost.
    const content = buildVoiceContent('v', uploaded);
    expect(content[VOICE_MARKER]).toEqual({});
    expect((content[AUDIO_INFO] as { waveform: number[] }).waveform).toHaveLength(
      WAVEFORM_BUCKETS
    );
    expect((content[AUDIO_INFO] as { duration?: number }).duration).toBeUndefined();
  });

  it('uses the encrypted file reference when there is one', () => {
    const content = buildVoiceContent('v', {
      file: {
        url: 'mxc://server/enc',
        key: { k: 'x' },
        iv: 'y',
        hashes: { sha256: 'z' },
      },
      mimeType: 'audio/ogg',
      size: 10,
    });
    expect(content.url).toBeUndefined();
    expect((content.file as { url: string }).url).toBe('mxc://server/enc');
  });
});
