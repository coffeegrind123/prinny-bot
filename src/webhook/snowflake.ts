/**
 * Discord snowflake ids.
 *
 * Every id in the Discord API is a 64-bit integer serialised as a decimal
 * string: 42 bits of milliseconds since the Discord epoch, 5 bits of worker,
 * 5 bits of process, 12 bits of per-millisecond sequence. Clients are entitled
 * to treat them as opaque, but enough of them do not — sorting by id to order
 * messages, or extracting the timestamp from one — that handing out ids of any
 * other shape would break a "1:1 compatible" claim in exactly the places that
 * are hardest to debug.
 *
 * So Matrix ids are never exposed as Discord ids. A snowflake is minted for
 * every object we hand out and mapped back to its Matrix identity in the store.
 */

import { randomBytes } from 'node:crypto';

const DISCORD_EPOCH = 1420070400000n;

const WORKER_BITS = 5n;
const PROCESS_BITS = 5n;
const SEQUENCE_BITS = 12n;

const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

export type SnowflakeOptions = {
  /** 0-31. Distinguishes concurrent generators sharing a clock. */
  workerId?: number;
  /** 0-31. */
  processId?: number;
};

/**
 * Monotonic within a process, and monotonic across restarts as long as the
 * clock is.
 *
 * The sequence counter is what makes ids minted in the same millisecond
 * distinct AND ordered; when it overflows the generator busy-waits for the next
 * millisecond rather than wrapping, because a wrapped sequence produces an id
 * that sorts before one issued earlier — which is the one property everything
 * downstream assumes.
 */
export class SnowflakeGenerator {
  private readonly workerId: bigint;

  private readonly processId: bigint;

  private lastTimestamp = -1n;

  private sequence = 0n;

  constructor(options: SnowflakeOptions = {}) {
    this.workerId = BigInt((options.workerId ?? 0) & 0x1f);
    this.processId = BigInt((options.processId ?? process.pid ?? 0) & 0x1f);
  }

  next(now: number = Date.now()): string {
    let timestamp = BigInt(now) - DISCORD_EPOCH;
    if (timestamp < 0n) timestamp = 0n;

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        // Sequence exhausted for this millisecond. Wait it out rather than
        // reusing ids or letting them go backwards.
        let spin = Date.now();
        while (BigInt(spin) - DISCORD_EPOCH <= this.lastTimestamp) spin = Date.now();
        timestamp = BigInt(spin) - DISCORD_EPOCH;
      }
    } else if (timestamp < this.lastTimestamp) {
      // The clock moved back (NTP step, VM resume). Staying on the last
      // timestamp keeps ids monotonic at the cost of being slightly ahead of
      // wall time, which is the lesser problem of the two.
      timestamp = this.lastTimestamp;
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const id =
      (timestamp << (WORKER_BITS + PROCESS_BITS + SEQUENCE_BITS)) |
      (this.workerId << (PROCESS_BITS + SEQUENCE_BITS)) |
      (this.processId << SEQUENCE_BITS) |
      this.sequence;

    return id.toString();
  }
}

/** The wall-clock time an id was minted, in milliseconds. */
export function snowflakeTimestamp(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return NaN;
  }
}

/** Whether a string is shaped like a snowflake — decimal digits, ≤ 20 of them. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value);
}

/**
 * The token half of a webhook URL.
 *
 * Discord's are 68 URL-safe characters. The length is not load-bearing but the
 * entropy is: this token is the ONLY credential on the execute endpoint, so it
 * is generated from the CSPRNG and compared in constant time (see the server).
 */
export function generateWebhookToken(bytes = 51): string {
  // 51 bytes → 68 base64url characters, matching Discord's shape exactly.
  return randomBytes(bytes).toString('base64url');
}
