import { describe, expect, it, vi } from 'vitest';
import { Composer, runMiddleware } from '../src/Composer.js';
import type { ContextLike } from '../src/Context.js';
import { AccessControl, RateLimiter } from '../src/access.js';

/** A context stub with just enough on it for routing decisions. */
const makeCtx = (overrides: Partial<ContextLike> = {}): ContextLike => ({
  kind: 'message',
  text: '',
  isOwner: false,
  command: undefined,
  callbackQuery: undefined,
  event: { getContent: () => ({ msgtype: 'm.text' }) } as unknown as ContextLike['event'],
  match: undefined,
  ...overrides,
});

describe('runMiddleware', () => {
  it('runs the stack in order and then the final handler', async () => {
    const order: string[] = [];
    await runMiddleware<ContextLike>(
      [
        async (_ctx, next) => {
          order.push('a:in');
          await next();
          order.push('a:out');
        },
        async (_ctx, next) => {
          order.push('b');
          await next();
        },
      ],
      makeCtx(),
      async () => {
        order.push('final');
      }
    );

    expect(order).toEqual(['a:in', 'b', 'final', 'a:out']);
  });

  it('stops when a middleware does not call next', async () => {
    const later = vi.fn();
    await runMiddleware<ContextLike>([async () => undefined, later], makeCtx(), async () => {});
    expect(later).not.toHaveBeenCalled();
  });

  it('throws when a middleware calls next twice', async () => {
    // Left unguarded this re-runs the rest of the chain, and the bot answers
    // twice for reasons that are very hard to see in a log.
    await expect(
      runMiddleware<ContextLike>(
        [
          async (_ctx, next) => {
            await next();
            await next();
          },
        ],
        makeCtx(),
        async () => {}
      )
    ).rejects.toThrow(/more than once/);
  });
});

describe('Composer routing', () => {
  it('runs a command handler only for its own command', async () => {
    const composer = new Composer<ContextLike>();
    const start = vi.fn();
    const help = vi.fn();
    composer.command('start', async () => start());
    composer.command('help', async () => help());

    await composer.dispatch(makeCtx({ command: { name: 'start', args: '' } }));

    expect(start).toHaveBeenCalledOnce();
    expect(help).not.toHaveBeenCalled();
  });

  it('exposes regex captures on ctx.match', async () => {
    const composer = new Composer<ContextLike>();
    let captured: string | undefined;
    composer.callbackQuery(/^vote:(\w+)$/, async (ctx) => {
      captured = ctx.match?.[1];
    });

    await composer.dispatch(
      makeCtx({
        kind: 'callback_query',
        callbackQuery: {
          id: '1',
          data: 'vote:yes',
          message: { event_id: '$m' },
          from: '@a:b.org',
        },
      })
    );

    expect(captured).toBe('yes');
  });

  it('matches hears exactly, not as a substring', async () => {
    const composer = new Composer<ContextLike>();
    const handler = vi.fn();
    composer.hears('ok', async () => handler());

    await composer.dispatch(makeCtx({ text: 'broken' }));
    expect(handler).not.toHaveBeenCalled();

    await composer.dispatch(makeCtx({ text: 'ok' }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('filters by update kind and msgtype', async () => {
    const composer = new Composer<ContextLike>();
    const onText = vi.fn();
    composer.on('message:text', async () => onText());

    await composer.dispatch(
      makeCtx({
        event: { getContent: () => ({ msgtype: 'm.image' }) } as unknown as ContextLike['event'],
      })
    );
    expect(onText).not.toHaveBeenCalled();

    await composer.dispatch(makeCtx());
    expect(onText).toHaveBeenCalledOnce();
  });

  it('gates ownerOnly handlers', async () => {
    const composer = new Composer<ContextLike>();
    const handler = vi.fn();
    composer.ownerOnly(async () => handler());

    await composer.dispatch(makeCtx({ isOwner: false }));
    expect(handler).not.toHaveBeenCalled();

    await composer.dispatch(makeCtx({ isOwner: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('confines errorBoundary to the handlers below it', async () => {
    const composer = new Composer<ContextLike>();
    const caught = vi.fn();
    const after = vi.fn();

    composer.errorBoundary(
      (error) => caught(error),
      async () => {
        throw new Error('boom');
      }
    );
    composer.use(async (_ctx, next) => {
      after();
      await next();
    });

    await composer.dispatch(makeCtx());
    expect(caught).toHaveBeenCalledOnce();
    // The boundary swallowed the error without consuming the rest of the chain.
    expect(after).toHaveBeenCalledOnce();
  });

  it('nests another composer', async () => {
    const inner = new Composer<ContextLike>();
    const handler = vi.fn();
    inner.command('go', async () => handler());

    const outer = new Composer<ContextLike>();
    outer.use(inner);

    await outer.dispatch(makeCtx({ command: { name: 'go', args: '' } }));
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('AccessControl', () => {
  it('refuses everyone when unclaimed and bootstrap is off', () => {
    const access = new AccessControl();
    expect(access.evaluate('@a:b.org')).toMatchObject({ allowed: false });
  });

  it('lets the first user claim ownership when bootstrap is on', () => {
    const persist = vi.fn();
    const access = new AccessControl({ allowBootstrap: true, persist });

    expect(access.evaluate('@first:b.org')).toEqual({
      allowed: true,
      isOwner: true,
      bootstrapped: true,
    });
    expect(persist).toHaveBeenCalledWith({
      ownerUserId: '@first:b.org',
      allowedUserIds: ['@first:b.org'],
    });
    expect(access.evaluate('@second:b.org')).toMatchObject({ allowed: false });
  });

  it('does not echo the sender back in a refusal', () => {
    // The refusal already confirms something is listening. No need to also
    // confirm that it read who asked.
    const access = new AccessControl({ ownerUserId: '@owner:b.org' });
    const decision = access.evaluate('@stranger:b.org');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).not.toContain('stranger');
  });

  it('allows the owner and the allowlist', () => {
    const access = new AccessControl({
      ownerUserId: '@owner:b.org',
      allowedUserIds: ['@friend:b.org'],
    });

    expect(access.evaluate('@owner:b.org')).toMatchObject({ allowed: true, isOwner: true });
    expect(access.evaluate('@friend:b.org')).toMatchObject({ allowed: true, isOwner: false });
  });

  it('refuses to remove the owner, which would orphan the bot', () => {
    const access = new AccessControl({ ownerUserId: '@owner:b.org' });
    expect(access.remove('@owner:b.org')).toBe(false);
    expect(access.isOwner('@owner:b.org')).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit then refuses', () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 });
    const now = 1_000_000;

    expect([0, 1, 2].map((i) => limiter.check('k', now + i))).toEqual([true, true, true]);
    expect(limiter.check('k', now + 3)).toBe(false);
  });

  it('slides, so an old hit stops counting', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });
    limiter.check('k', 1000);
    limiter.check('k', 1100);
    expect(limiter.check('k', 1200)).toBe(false);
    // First hit has aged out by now.
    expect(limiter.check('k', 2050)).toBe(true);
  });

  it('keys independently', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.check('a', 1000)).toBe(true);
    expect(limiter.check('b', 1000)).toBe(true);
    expect(limiter.check('a', 1000)).toBe(false);
  });

  it('reports when the caller may retry', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 5000 });
    limiter.check('k', 1000);
    expect(limiter.retryAfterSeconds('k', 2000)).toBe(4);
  });
});
