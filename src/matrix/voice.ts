/**
 * Voice messages (MSC3245) — sending, recognising, and decoding to PCM.
 *
 * A voice message is an `m.audio` carrying two extra keys: an empty
 * `org.matrix.msc3245.voice` marker, and an `org.matrix.msc1767.audio` block
 * with a duration and a waveform. Without the marker, clients render a generic
 * audio attachment instead of a voice bubble; without the waveform they draw a
 * flat line. Both are cheap to produce and neither is optional in practice.
 *
 * What is *not* here, deliberately: transcription. openclaude's
 * `src/services/matrix/voice.ts` runs faster-whisper out of a Python venv it
 * installs on first use — a real dependency chain (a venv, a model download,
 * PyAV) that has no business inside a chat library. The portable half of that
 * file, `hasFfmpeg` and `audioToPcm`, is ported below, and `Transcriber` is the
 * seam an application plugs its own engine into.
 */

import { spawn } from 'node:child_process';
import type { MatrixMediaInfo, UploadedAttachment } from './media.js';

/** MSC3245: an empty object marking an `m.audio` as a voice message. */
export const VOICE_MARKER = 'org.matrix.msc3245.voice';
/** MSC1767: the extensible-events audio block. */
export const AUDIO_INFO = 'org.matrix.msc1767.audio';

/** Waveform values are 0-1024, and clients expect 30-120 of them. */
export const WAVEFORM_MAX = 1024;
export const WAVEFORM_BUCKETS = 60;

export type AudioBlock = {
  /** Milliseconds. */
  duration?: number;
  /** 0-1024 amplitudes. */
  waveform?: number[];
};

export type VoiceMessageContent = {
  msgtype?: string;
  body?: string;
  info?: MatrixMediaInfo;
  [AUDIO_INFO]?: AudioBlock;
  [VOICE_MARKER]?: Record<string, never>;
};

/**
 * Whether this is a voice message rather than a music file someone attached.
 *
 * The marker is what separates the two, and treating every `m.audio` as a voice
 * message is how a bot ends up trying to transcribe an album.
 */
export const isVoiceMessage = (content: unknown): content is VoiceMessageContent => {
  if (!content || typeof content !== 'object') return false;
  const c = content as VoiceMessageContent;
  return c.msgtype === 'm.audio' && c[VOICE_MARKER] !== undefined;
};

/** Duration in ms, from wherever the sender put it. */
export const voiceDuration = (content: VoiceMessageContent): number | undefined =>
  content[AUDIO_INFO]?.duration ?? content.info?.duration;

// ── PCM ──────────────────────────────────────────────────────────────────────

/** Raw PCM shape everything here assumes: signed 16-bit LE, mono, 16 kHz. */
export const PCM_SAMPLE_RATE = 16_000;
export const PCM_BYTES_PER_SAMPLE = 2;

export const pcmDurationMs = (
  pcm: Buffer,
  sampleRate = PCM_SAMPLE_RATE,
  channels = 1
): number => Math.round((pcm.length / (PCM_BYTES_PER_SAMPLE * channels) / sampleRate) * 1000);

/**
 * Reduce PCM to the amplitude bars a client draws.
 *
 * RMS per bucket, not peak: peak makes every waveform look identical because a
 * single loud sample saturates the bar. Scaled against the loudest bucket so
 * quiet recordings still show shape rather than a flat line.
 */
export const computeWaveform = (pcm: Buffer, buckets = WAVEFORM_BUCKETS): number[] => {
  const sampleCount = Math.floor(pcm.length / PCM_BYTES_PER_SAMPLE);
  if (sampleCount === 0) return new Array(buckets).fill(0);

  const perBucket = Math.max(1, Math.floor(sampleCount / buckets));
  const levels: number[] = [];

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * perBucket;
    const end = Math.min(sampleCount, start + perBucket);
    if (start >= end) {
      levels.push(0);
      continue;
    }
    let sumSquares = 0;
    for (let i = start; i < end; i += 1) {
      const sample = pcm.readInt16LE(i * PCM_BYTES_PER_SAMPLE) / 32768;
      sumSquares += sample * sample;
    }
    levels.push(Math.sqrt(sumSquares / (end - start)));
  }

  const loudest = Math.max(...levels);
  if (loudest === 0) return levels.map(() => 0);
  return levels.map((level) => Math.round((level / loudest) * WAVEFORM_MAX));
};

// ── Decoding ─────────────────────────────────────────────────────────────────

let ffmpegAvailable: boolean | undefined;

/** Whether an `ffmpeg` binary is on PATH. Cached after the first probe. */
export const hasFfmpeg = async (): Promise<boolean> => {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable;
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    try {
      const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      probe.on('error', () => resolve(false));
      probe.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return ffmpegAvailable;
};

/**
 * Decode audio bytes to raw PCM via a system ffmpeg, over stdin and stdout.
 *
 * Voice messages arrive as OGG/Opus, which nothing in Node reads natively.
 * Rejects when ffmpeg is missing or exits non-zero — call `hasFfmpeg()` first
 * if you want to degrade rather than catch.
 */
export const audioToPcm = (
  input: Buffer,
  sampleRate = PCM_SAMPLE_RATE
): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    let proc;
    try {
      proc = spawn(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          '-i', 'pipe:0',
          '-f', 's16le', '-ac', '1', '-ar', String(sampleRate),
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`));
    });

    // EPIPE if ffmpeg dies before reading it all; the exit handler reports why.
    proc.stdin.on('error', () => undefined);
    proc.stdin.write(input);
    proc.stdin.end();
  });

// ── Sending ──────────────────────────────────────────────────────────────────

export type VoiceMetadata = {
  /** Milliseconds. Derived from the PCM when `pcm` is supplied instead. */
  duration?: number;
  waveform?: number[];
  /** Decoded audio to derive duration and waveform from. */
  pcm?: Buffer;
};

/**
 * Build the content for a voice message.
 *
 * Falls back to a flat waveform when no PCM or waveform is given: a voice
 * bubble with no bars still plays, whereas a missing marker downgrades it to a
 * file attachment. Getting the marker right matters more than the drawing.
 */
export const buildVoiceContent = (
  body: string,
  uploaded: UploadedAttachment,
  metadata: VoiceMetadata = {}
): Record<string, unknown> => {
  const duration =
    metadata.duration ?? (metadata.pcm ? pcmDurationMs(metadata.pcm) : undefined);
  const waveform =
    metadata.waveform ??
    (metadata.pcm ? computeWaveform(metadata.pcm) : new Array(WAVEFORM_BUCKETS).fill(0));

  const audio: AudioBlock = { waveform };
  if (duration !== undefined) audio.duration = duration;

  const info: MatrixMediaInfo = { mimetype: uploaded.mimeType, size: uploaded.size };
  if (duration !== undefined) info.duration = duration;

  const content: Record<string, unknown> = {
    msgtype: 'm.audio',
    body,
    info,
    [AUDIO_INFO]: audio,
    [VOICE_MARKER]: {},
  };
  if (uploaded.url) content.url = uploaded.url;
  if (uploaded.file) content.file = uploaded.file;
  return content;
};

// ── Transcription seam ───────────────────────────────────────────────────────

export type TranscribeResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * An application's speech-to-text engine.
 *
 * Deliberately narrow, and deliberately non-throwing: a bot that cannot
 * transcribe should say so in chat, not fall over. `pcm` is 16-bit LE mono at
 * 16 kHz — what every local STT engine wants, and what `audioToPcm` produces.
 */
export interface Transcriber {
  transcribe(pcm: Buffer): Promise<TranscribeResult>;
}

/**
 * Decode audio bytes and hand them to a transcriber.
 *
 * Reports the missing piece by name rather than a generic failure, because
 * "no ffmpeg on PATH" and "the model would not load" need different fixes and
 * a bot owner reading a log deserves to know which one they have.
 */
export const transcribeAudio = async (
  audio: Buffer,
  transcriber: Transcriber
): Promise<TranscribeResult> => {
  if (!(await hasFfmpeg())) {
    return { ok: false, reason: 'no ffmpeg on PATH to decode the audio' };
  }
  let pcm: Buffer;
  try {
    pcm = await audioToPcm(audio);
  } catch (error) {
    return {
      ok: false,
      reason: `could not decode audio: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    return await transcriber.transcribe(pcm);
  } catch (error) {
    return {
      ok: false,
      reason: `transcription failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
