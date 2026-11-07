import { describe, expect, it } from 'vitest';
import {
  applyProfileFallback,
  buildPerMessageProfile,
  escapeProfileHtml,
  normalizeDisplayName,
  profileId,
  stripProfileFallbackBody,
} from '../src/webhook/profile.js';

/**
 * The Prinny client's strip, copied from cinny `utils/perMessageProfile.ts`
 * (`stripProfileFallback`). The bot's fallback is only correct if this removes
 * it completely, so the two are tested against each other here.
 */
const clientEscapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clientStrip = (content: Record<string, unknown>, displayname: string) => {
  const next = { ...content };
  const prefix = `${displayname}: `;
  if (typeof content.body === 'string' && content.body.startsWith(prefix)) {
    next.body = content.body.slice(prefix.length);
  }
  if (typeof content.formatted_body === 'string') {
    const name = escapeRegExp(clientEscapeHtml(displayname));
    const fallback = new RegExp(
      `<strong\\s+data-mx-profile-fallback(?:="")?\\s*>${name}: </strong\\s*>`
    );
    next.formatted_body = content.formatted_body.replace(fallback, '');
  }
  return next;
};
/** The client's name cleaning, for the same reason. */
const clientCleanName = (value: string): string =>
  Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 80).join('');

describe('normalizeDisplayName', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeDisplayName('  CI \n\t bot ')).toBe('CI bot');
  });

  it('returns undefined when nothing is left', () => {
    expect(normalizeDisplayName(undefined)).toBeUndefined();
    expect(normalizeDisplayName(' \n ')).toBeUndefined();
  });

  it('caps at 80 characters and 255 bytes', () => {
    expect(Array.from(normalizeDisplayName('x'.repeat(200)) ?? '')).toHaveLength(80);
    const wide = normalizeDisplayName('漢'.repeat(80)) ?? '';
    expect(new TextEncoder().encode(wide).length).toBeLessThanOrEqual(255);
    expect(wide.length).toBe(80); // 3-byte characters: 240 bytes, fits
    const rockets = normalizeDisplayName('🚀'.repeat(80)) ?? '';
    expect(new TextEncoder().encode(rockets).length).toBeLessThanOrEqual(255);
    expect(Array.from(rockets)).toHaveLength(63); // 4 bytes each
  });

  it('agrees with what the client does to the same name', () => {
    for (const raw of ['Deploy', '  a  b ', 'y'.repeat(120), 'emoji 🚀 name']) {
      expect(normalizeDisplayName(raw)).toBe(clientCleanName(raw));
    }
  });
});

describe('profileId', () => {
  it('is stable per identity and distinct across identities and webhooks', () => {
    expect(profileId('1', 'CI')).toBe(profileId('1', 'CI'));
    expect(profileId('1', 'CI')).not.toBe(profileId('1', 'Deploy'));
    expect(profileId('1', 'CI')).not.toBe(profileId('1', 'CI', 'mxc://a/b'));
    expect(profileId('1', 'CI')).not.toBe(profileId('2', 'CI'));
    // "a\0" + "" must not collide with "" + "a" style splits
    expect(profileId('1', 'ab', '')).not.toBe(profileId('1', 'a', 'b'));
    expect(profileId('123', 'CI')).toMatch(/^123:[0-9a-f]{16}$/);
  });
});

describe('buildPerMessageProfile', () => {
  it('writes only the fields it has', () => {
    expect(buildPerMessageProfile({ webhookId: '9', avatarUrl: 'mxc://a/b' }, false)).toEqual({
      id: profileId('9', undefined, 'mxc://a/b'),
      avatar_url: 'mxc://a/b',
      has_fallback: false,
      'in.prinny.webhook': { id: '9' },
    });
  });
});

describe('applyProfileFallback', () => {
  it('prefixes body and formatted_body, inside a leading <p>', () => {
    const content: Record<string, unknown> = { body: 'hi', formatted_body: '<p>hi</p><p>2</p>' };
    expect(applyProfileFallback(content, 'CI')).toBe(true);
    expect(content).toEqual({
      body: 'CI: hi',
      formatted_body: '<p><strong data-mx-profile-fallback>CI: </strong>hi</p><p>2</p>',
    });
  });

  it('prefixes HTML without a leading <p> at the very start', () => {
    const content: Record<string, unknown> = { body: 'hi', formatted_body: '<b>hi</b>' };
    applyProfileFallback(content, 'CI');
    expect(content.formatted_body).toBe('<strong data-mx-profile-fallback>CI: </strong><b>hi</b>');
  });

  it('does nothing without text', () => {
    const content: Record<string, unknown> = { body: '' };
    expect(applyProfileFallback(content, 'CI')).toBe(false);
    expect(content).toEqual({ body: '' });
  });

  it('round-trips through the client strip, including awkward names', () => {
    for (const name of ['CI', `<O'Brien & "co">`, 'a.b*c(d)', 'emoji 🚀']) {
      const original = { body: 'text', formatted_body: '<p>text <em>x</em></p>' };
      const content: Record<string, unknown> = { ...original };
      applyProfileFallback(content, name);
      expect(clientStrip(content, name)).toEqual(original);
    }
  });

  it('escapes HTML like the client', () => {
    expect(escapeProfileHtml(`<a href="x">'&'</a>`)).toBe(clientEscapeHtml(`<a href="x">'&'</a>`));
  });
});

describe('stripProfileFallbackBody', () => {
  it('removes only an exact leading prefix', () => {
    expect(stripProfileFallbackBody('CI: hi', 'CI')).toBe('hi');
    expect(stripProfileFallbackBody('hi CI: x', 'CI')).toBe('hi CI: x');
    expect(stripProfileFallbackBody('CI: hi', undefined)).toBe('CI: hi');
  });
});
