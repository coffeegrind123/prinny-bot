/**
 * Fallback tests.
 *
 * The fallback is what a user on Element, FluffyChat or Nheko actually sees.
 * If it regresses, a bot silently becomes unusable for everyone not running
 * Prinny — and nothing in Prinny's own UI would ever show it.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFallbackBodies,
  flattenInlineKeyboard,
  matchFallbackReply,
  plainBodyOf,
  renderFallbackListing,
} from '../src/keyboard/fallback.js';
import { InlineKeyboard } from '../src/keyboard/InlineKeyboard.js';
import { Keyboard, forceReply, removeKeyboard } from '../src/keyboard/Keyboard.js';
import { BotContentKey } from '../src/protocol/constants.js';

const deployKeyboard = new InlineKeyboard()
  .text('Deploy', 'deploy:prod')
  .text('Cancel', 'cancel')
  .row()
  .url('Docs', 'https://prinny.app/docs')
  .build();

describe('renderFallbackListing', () => {
  it('numbers buttons in reading order and shows URLs', () => {
    expect(renderFallbackListing(deployKeyboard)).toBe(
      ['[1] Deploy', '[2] Cancel', '[3] Docs - https://prinny.app/docs'].join('\n')
    );
  });

  it('reveals copy-button payloads, which are useless otherwise', () => {
    // On a client with no buttons, the payload *is* the affordance.
    const markup = new InlineKeyboard().copyText('Copy token', 'tok_abc123').build();
    expect(renderFallbackListing(markup)).toBe('[1] Copy token - tok_abc123');
  });

  it('marks buttons this version cannot action', () => {
    expect(renderFallbackListing({ inline_keyboard: [[{ text: 'Pay' }]] })).toBe(
      '[1] Pay (unsupported)'
    );
  });

  it('lists reply-keyboard keys inline', () => {
    const markup = new Keyboard().text('Status').text('Help').row().text('Stop').build();
    expect(renderFallbackListing(markup)).toBe('Quick replies: Status | Help | Stop');
  });

  it('has nothing to say about remove_keyboard or force_reply', () => {
    expect(renderFallbackListing(removeKeyboard())).toBeNull();
    expect(renderFallbackListing(forceReply())).toBeNull();
  });
});

describe('buildFallbackBodies', () => {
  it('appends the listing to body and keeps a clean copy', () => {
    const bodies = buildFallbackBodies('Deploy to production?', undefined, deployKeyboard);

    expect(bodies.body).toBe(
      'Deploy to production?\n\n[1] Deploy\n[2] Cancel\n[3] Docs - https://prinny.app/docs'
    );
    expect(bodies[BotContentKey.PlainBody]).toBe('Deploy to production?');
  });

  it('builds the HTML listing alongside the plain one', () => {
    const bodies = buildFallbackBodies('Pick', '<b>Pick</b>', deployKeyboard);

    expect(bodies[BotContentKey.PlainFormattedBody]).toBe('<b>Pick</b>');
    expect(bodies.formatted_body).toContain('<b>Pick</b><br/><br/>');
    expect(bodies.formatted_body).toContain('<a href="https://prinny.app/docs">Docs</a>');
  });

  it('escapes HTML in labels rather than trusting them', () => {
    const markup = new InlineKeyboard().text('<img src=x onerror=alert(1)>', 'x').build();
    const bodies = buildFallbackBodies('Hi', 'Hi', markup);

    expect(bodies.formatted_body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(bodies.formatted_body).not.toContain('<img');
  });

  it('omits the plain copy when there is no listing to strip', () => {
    // Nothing was appended, so a supporting client can just render `body`.
    const bodies = buildFallbackBodies('Done', undefined, removeKeyboard());
    expect(bodies.body).toBe('Done');
    expect(bodies[BotContentKey.PlainBody]).toBeUndefined();
  });

  it('handles an empty caption without a leading blank line', () => {
    const bodies = buildFallbackBodies('', undefined, deployKeyboard);
    expect(bodies.body.startsWith('[1] Deploy')).toBe(true);
  });

  it('leaves a message with no markup completely alone', () => {
    expect(buildFallbackBodies('plain', undefined, undefined)).toEqual({ body: 'plain' });
  });
});

describe('matchFallbackReply', () => {
  it('resolves the printed number in the shapes people actually type', () => {
    for (const text of ['1', '[1]', '1.', ' 1 ']) {
      expect(matchFallbackReply(text, deployKeyboard)?.button.text).toBe('Deploy');
    }
  });

  it('resolves a label case-insensitively', () => {
    expect(matchFallbackReply('cancel', deployKeyboard)?.button.text).toBe('Cancel');
  });

  it('resolves raw callback_data', () => {
    expect(matchFallbackReply('deploy:prod', deployKeyboard)?.button.text).toBe('Deploy');
  });

  it('reports the button position so the bot can disambiguate', () => {
    const match = matchFallbackReply('3', deployKeyboard);
    expect(match).toMatchObject({ row: 1, col: 0, index: 3 });
  });

  it('refuses to guess between two buttons sharing a label', () => {
    const ambiguous = new InlineKeyboard().text('Go', 'a').text('Go', 'b').build();
    expect(matchFallbackReply('Go', ambiguous)).toBeNull();
    // The number still gets through — it is unambiguous by construction.
    expect(matchFallbackReply('2', ambiguous)?.button.callback_data).toBe('b');
  });

  it('does not fuzzy-match a partial label', () => {
    expect(matchFallbackReply('Dep', deployKeyboard)).toBeNull();
  });

  it('returns null for ordinary conversation', () => {
    expect(matchFallbackReply('what does deploy do?', deployKeyboard)).toBeNull();
    expect(matchFallbackReply('99', deployKeyboard)).toBeNull();
    expect(matchFallbackReply('', deployKeyboard)).toBeNull();
    expect(matchFallbackReply('1', undefined)).toBeNull();
  });

  it('ignores reply keyboards, whose keys arrive as ordinary messages', () => {
    expect(matchFallbackReply('1', new Keyboard().text('Status').build())).toBeNull();
  });
});

describe('flattenInlineKeyboard', () => {
  it('numbers from one across row boundaries', () => {
    expect(flattenInlineKeyboard(deployKeyboard).map((b) => [b.index, b.row, b.col])).toEqual([
      [1, 0, 0],
      [2, 0, 1],
      [3, 1, 0],
    ]);
  });
});

describe('plainBodyOf', () => {
  it('prefers the clean copy when the sender supplied one', () => {
    expect(
      plainBodyOf({ body: 'Pick\n\n[1] A', [BotContentKey.PlainBody]: 'Pick' })
    ).toBe('Pick');
  });

  it('falls back to body, and to empty for a bodyless event', () => {
    expect(plainBodyOf({ body: 'Pick' })).toBe('Pick');
    expect(plainBodyOf({})).toBe('');
  });
});
