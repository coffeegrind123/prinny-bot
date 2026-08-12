/**
 * Handler registration and the middleware chain.
 *
 * grammY's model: everything is middleware, handlers are middleware that only
 * run on a match, and `next()` passes control down the chain. `Bot` extends
 * this, so `bot.command(...)` and `composer.command(...)` are the same method.
 */

import type { ContextLike } from './Context.js';

export type NextFunction = () => Promise<void>;

export type Middleware<C> = (ctx: C, next: NextFunction) => unknown | Promise<unknown>;

/**
 * Update filters, in grammY's `noun:qualifier` style.
 *
 * `message` matches any `m.room.message`; `message:text` narrows to `m.text`
 * and `m.notice`, which is what a bot almost always means by "a text message".
 */
export type FilterQuery =
  | 'message'
  | 'message:text'
  | 'message:image'
  | 'message:video'
  | 'message:audio'
  | 'message:file'
  | 'message:location'
  | 'callback_query'
  | 'callback_query:data'
  | 'membership'
  | 'membership:join'
  | 'membership:leave'
  | 'membership:invite'
  | 'reaction';

const MSGTYPE_BY_FILTER: Partial<Record<FilterQuery, string[]>> = {
  'message:text': ['m.text', 'm.notice', 'm.emote'],
  'message:image': ['m.image'],
  'message:video': ['m.video'],
  'message:audio': ['m.audio'],
  'message:file': ['m.file'],
  'message:location': ['m.location'],
};

/** Whether a context satisfies a filter. */
export const matchesFilter = (ctx: ContextLike, filter: FilterQuery): boolean => {
  if (filter.startsWith('callback_query')) {
    if (ctx.kind !== 'callback_query') return false;
    if (filter === 'callback_query:data') return typeof ctx.callbackQuery?.data === 'string';
    return true;
  }

  if (filter.startsWith('membership')) {
    if (ctx.kind !== 'membership') return false;
    if (filter === 'membership') return true;
    const membership = ctx.event.getContent().membership as string | undefined;
    return filter === `membership:${membership}`;
  }

  if (filter === 'reaction') return ctx.kind === 'reaction';

  if (filter.startsWith('message')) {
    if (ctx.kind !== 'message') return false;
    if (filter === 'message') return true;
    const msgtype = ctx.event.getContent().msgtype as string | undefined;
    const allowed = MSGTYPE_BY_FILTER[filter];
    return allowed !== undefined && msgtype !== undefined && allowed.includes(msgtype);
  }

  return false;
};

/**
 * Run a middleware stack.
 *
 * Guards against a handler calling `next()` twice, which otherwise re-runs the
 * rest of the chain and produces duplicate replies — a bug that reads as "the
 * bot answered twice" and is miserable to trace back to its cause.
 */
export const runMiddleware = async <C>(
  stack: readonly Middleware<C>[],
  ctx: C,
  final: NextFunction
): Promise<void> => {
  let lastIndex = -1;

  const dispatch = async (index: number): Promise<void> => {
    if (index <= lastIndex) {
      throw new Error('next() was called more than once by a single middleware');
    }
    lastIndex = index;

    if (index === stack.length) {
      await final();
      return;
    }
    const middleware = stack[index];
    if (!middleware) return;
    await middleware(ctx, () => dispatch(index + 1));
  };

  await dispatch(0);
};

export type CommandTrigger = string | RegExp | Array<string | RegExp>;

export type TextTrigger = string | RegExp | Array<string | RegExp>;

const toArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

/**
 * Test a trigger against a value.
 *
 * A string trigger is an exact match, not a substring one. Substring matching
 * makes `hears('ok')` fire on "broken", which is never what the author meant.
 */
const testTrigger = (
  trigger: string | RegExp,
  value: string
): { hit: boolean; match?: RegExpMatchArray } => {
  if (typeof trigger === 'string') return { hit: trigger === value };
  const match = value.match(trigger);
  return match ? { hit: true, match } : { hit: false };
};

export class Composer<C extends ContextLike> {
  protected readonly stack: Middleware<C>[] = [];

  /** Append middleware, or another composer's whole chain. */
  use(...middleware: Array<Middleware<C> | Composer<C>>): this {
    for (const item of middleware) {
      if (item instanceof Composer) {
        const inner = item;
        this.stack.push((ctx, next) => runMiddleware(inner.stack, ctx, next));
      } else {
        this.stack.push(item);
      }
    }
    return this;
  }

  /** Run handlers only when `predicate` holds. */
  filter(predicate: (ctx: C) => boolean, ...handlers: Middleware<C>[]): this {
    this.stack.push(async (ctx, next) => {
      if (!predicate(ctx)) return next();
      return runMiddleware(handlers, ctx, next);
    });
    return this;
  }

  /** Run handlers only for updates matching `filter`. */
  on(filter: FilterQuery | FilterQuery[], ...handlers: Middleware<C>[]): this {
    const filters = toArray(filter);
    return this.filter(
      (ctx) => filters.some((one) => matchesFilter(ctx, one)),
      ...handlers
    );
  }

  /**
   * Handle a slash command.
   *
   * The `@bot` addressing check happens before this — by the time a command
   * context exists, it has already been established that the command was
   * meant for this bot.
   */
  command(trigger: CommandTrigger, ...handlers: Middleware<C>[]): this {
    const triggers = toArray(trigger);
    this.stack.push(async (ctx, next) => {
      const name = ctx.command?.name;
      if (name === undefined) return next();

      for (const one of triggers) {
        const { hit, match } = testTrigger(one, name);
        if (hit) {
          ctx.match = match;
          return runMiddleware(handlers, ctx, next);
        }
      }
      return next();
    });
    return this;
  }

  /** Handle a button press whose `callback_data` matches. */
  callbackQuery(trigger: CommandTrigger, ...handlers: Middleware<C>[]): this {
    const triggers = toArray(trigger);
    this.stack.push(async (ctx, next) => {
      const data = ctx.callbackQuery?.data;
      if (data === undefined) return next();

      for (const one of triggers) {
        const { hit, match } = testTrigger(one, data);
        if (hit) {
          ctx.match = match;
          return runMiddleware(handlers, ctx, next);
        }
      }
      return next();
    });
    return this;
  }

  /**
   * Handle a text message matching `trigger`.
   *
   * Matched against the clean body, so a user replying "1" to a fallback
   * listing reaches the same handler whether they clicked or typed.
   */
  hears(trigger: TextTrigger, ...handlers: Middleware<C>[]): this {
    const triggers = toArray(trigger);
    this.stack.push(async (ctx, next) => {
      if (ctx.kind !== 'message') return next();
      const text = ctx.text;
      if (!text) return next();

      for (const one of triggers) {
        const { hit, match } = testTrigger(one, text);
        if (hit) {
          ctx.match = match;
          return runMiddleware(handlers, ctx, next);
        }
      }
      return next();
    });
    return this;
  }

  /** Run handlers only for the bot's owner. */
  ownerOnly(...handlers: Middleware<C>[]): this {
    return this.filter((ctx) => ctx.isOwner, ...handlers);
  }

  /**
   * Catch errors thrown by `handlers`, and by anything downstream of them.
   *
   * Scoped rather than global: a failing `/deploy` handler should not take
   * down the middleware that answers callback queries.
   *
   * After the error handler returns, the chain resumes *after* the boundary —
   * so middleware registered later still runs. That matters for the things
   * people put last: audit logging, metrics, a catch-all reply. Swallowing the
   * error and the rest of the chain would mean one broken handler silently
   * disables all of them.
   */
  errorBoundary(
    onError: (error: unknown, ctx: C) => unknown | Promise<unknown>,
    ...handlers: Middleware<C>[]
  ): this {
    this.stack.push(async (ctx, next) => {
      let continued = false;
      const continueChain: NextFunction = async () => {
        continued = true;
        await next();
      };

      try {
        await runMiddleware(handlers, ctx, continueChain);
      } catch (error) {
        await onError(error, ctx);
        // Only resume if the throw happened before control passed downstream.
        // If it came from downstream, the rest of the chain has already had
        // its turn and re-entering it would run it twice.
        if (!continued) await next();
      }
    });
    return this;
  }

  /** Run this composer's chain against a context. */
  async dispatch(ctx: C, final: NextFunction = async () => undefined): Promise<void> {
    await runMiddleware(this.stack, ctx, final);
  }
}
