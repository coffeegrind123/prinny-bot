import { describe, expect, it } from 'vitest';
import { AccessControl, RateLimiter } from '../src/access.js';

describe('access control', () => {
  it('refuses everyone when nobody owns the bot and bootstrap is off', () => {
    const access = new AccessControl();
    expect(access.evaluate('@a:x').allowed).toBe(false);
  });

  it('lets the first sender claim ownership only when bootstrap is on', () => {
    const access = new AccessControl({ allowBootstrap: true });
    const first = access.evaluate('@a:x');
    expect(first).toEqual({ allowed: true, isOwner: true, bootstrapped: true });
    expect(access.evaluate('@b:x').allowed).toBe(false);
  });

  it('will not remove the owner', () => {
    const access = new AccessControl({ ownerUserId: '@owner:x' });
    expect(access.remove('@owner:x')).toBe(false);
    expect(access.isAllowed('@owner:x')).toBe(true);
  });
});

describe('rate limiter', () => {
  it('allows up to max in a window and refuses the next', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });
    expect(limiter.check('k', 0)).toBe(true);
    expect(limiter.check('k', 1)).toBe(true);
    expect(limiter.check('k', 2)).toBe(false);
    // A refused caller still has a window on record to report a retry from.
    expect(limiter.retryAfterSeconds('k', 2)).toBe(1);
  });

  it('lets a caller through again once its window has passed', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.check('k', 0)).toBe(true);
    expect(limiter.check('k', 500)).toBe(false);
    expect(limiter.check('k', 2000)).toBe(true);
  });

  it('forgets keys whose hits have all aged out', () => {
    const limiter = new RateLimiter({ max: 5, windowMs: 1000 });
    for (let i = 0; i < 50; i += 1) limiter.check(`sender-${i}`, 0);
    expect(limiter.size).toBe(50);

    // One call a window later is enough to sweep the rest: the keys are never
    // revisited, so nothing else would ever collect them.
    limiter.check('someone-else', 5000);
    expect(limiter.size).toBe(1);
  });

  it('caps the key space against a flood inside a single window', () => {
    const limiter = new RateLimiter({ max: 5, windowMs: 60_000, maxKeys: 100 });
    // Every one of these is a distinct refused sender, which is exactly the
    // shape of the attack: the map must not grow with the attacker's account
    // count.
    for (let i = 0; i < 5000; i += 1) limiter.check(`@attacker-${i}:evil.example`, 1000);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('keeps the key it is currently answering for when the cap evicts', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000, maxKeys: 10 });
    for (let i = 0; i < 200; i += 1) limiter.check(`k${i}`, 1000);
    // The most recent caller is over budget and must still be able to be told
    // how long to wait.
    expect(limiter.check('k199', 1000)).toBe(false);
    expect(limiter.retryAfterSeconds('k199', 1000)).toBeGreaterThan(0);
  });
});
