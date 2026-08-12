/**
 * Progress reactions.
 *
 * Ported from openclaude's `src/services/matrix/reactions.ts`. A bot that takes
 * ten seconds to answer looks broken; an emoji on the triggering message is the
 * cheapest possible "I heard you", and unlike a typing indicator it survives
 * the bot restarting and is visible in scrollback.
 *
 * Every operation is best-effort. A homeserver that rejects reactions, or a
 * power level that forbids them, must never take down the turn they were
 * decorating.
 */

import type { MatrixClient } from 'matrix-js-sdk';

export const REACTION_WORKING = '⏳';
export const REACTION_DONE = '✅';
export const REACTION_ERROR = '❌';

/** The annotation's event id, kept so it can be redacted later. */
export type ReactionHandle = string | null;

export const addReaction = async (
  client: MatrixClient,
  roomId: string,
  targetEventId: string,
  key: string
): Promise<ReactionHandle> => {
  try {
    const result = await client.sendEvent(roomId, 'm.reaction' as never, {
      'm.relates_to': { rel_type: 'm.annotation', event_id: targetEventId, key },
    } as never);
    return result.event_id ?? null;
  } catch {
    return null;
  }
};

export const removeReaction = async (
  client: MatrixClient,
  roomId: string,
  handle: ReactionHandle
): Promise<void> => {
  if (!handle) return;
  try {
    await client.redactEvent(roomId, handle);
  } catch {
    // Best-effort: a reaction that outlives its turn is untidy, not broken.
  }
};

export type TurnReactionsOptions = {
  working?: string;
  done?: string;
  error?: string;
  /** Off by default is wrong here — the caller constructs this to use it. */
  enabled?: boolean;
};

/**
 * The ⏳ → ✅/❌ lifecycle for one turn.
 *
 * `start()` marks the triggering message as being worked on; `finish(ok)`
 * redacts that and replaces it with the outcome. A no-op without a target
 * event, so a bot acting on its own schedule rather than in reply to anyone can
 * construct one unconditionally.
 */
export class TurnReactions {
  private working: ReactionHandle = null;

  private readonly keys: { working: string; done: string; error: string };

  private readonly enabled: boolean;

  constructor(
    private readonly client: MatrixClient,
    private readonly roomId: string,
    private readonly targetEventId: string | undefined,
    options: TurnReactionsOptions = {}
  ) {
    this.enabled = options.enabled ?? true;
    this.keys = {
      working: options.working ?? REACTION_WORKING,
      done: options.done ?? REACTION_DONE,
      error: options.error ?? REACTION_ERROR,
    };
  }

  async start(): Promise<void> {
    if (!this.enabled || !this.targetEventId) return;
    this.working = await addReaction(
      this.client,
      this.roomId,
      this.targetEventId,
      this.keys.working
    );
  }

  async finish(ok: boolean): Promise<void> {
    if (!this.enabled || !this.targetEventId) return;
    await removeReaction(this.client, this.roomId, this.working);
    this.working = null;
    await addReaction(
      this.client,
      this.roomId,
      this.targetEventId,
      ok ? this.keys.done : this.keys.error
    );
  }

  /**
   * Run `work` bracketed by the reactions.
   *
   * The `finally` is the point: a handler that throws still needs its ⏳
   * cleared, and remembering to do that at every throw site is how the spinner
   * ends up stuck on somebody's message forever.
   */
  async around<T>(work: () => Promise<T>): Promise<T> {
    await this.start();
    try {
      const result = await work();
      await this.finish(true);
      return result;
    } catch (error) {
      await this.finish(false);
      throw error;
    }
  }
}
