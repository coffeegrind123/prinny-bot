/**
 * Sanitiser tests.
 *
 * These are the tests that matter most in the repo: `sanitizeReplyMarkup` is
 * the only thing standing between an arbitrary room member and a client's
 * renderer, and it runs on input nobody controls.
 */

import { describe, expect, it } from 'vitest';
import {
  buttonAction,
  describeUrlTarget,
  isAllowedButtonUrl,
  normalizeCommandName,
  replyMarkupKind,
  sanitizeBotInfo,
  sanitizeCallbackAnswer,
  sanitizeReplyMarkup,
} from '../src/protocol/validate.js';
import { Limits } from '../src/protocol/constants.js';
import type { InlineKeyboardMarkup, ReplyKeyboardMarkup } from '../src/protocol/types.js';

// Built rather than written literally: a test about invisible characters is
// unreviewable if the characters under test are invisible in its source.
const NUL = String.fromCharCode(0x00);
const LF = String.fromCharCode(0x0a);
/** U+202E RIGHT-TO-LEFT OVERRIDE. */
const RLO = String.fromCharCode(0x202e);

describe('replyMarkupKind', () => {
  it('identifies each of the four shapes', () => {
    expect(replyMarkupKind({ inline_keyboard: [] })).toBe('inline_keyboard');
    expect(replyMarkupKind({ keyboard: [] })).toBe('keyboard');
    expect(replyMarkupKind({ remove_keyboard: true })).toBe('remove_keyboard');
    expect(replyMarkupKind({ force_reply: true })).toBe('force_reply');
  });

  it('rejects an object claiming to be two shapes at once', () => {
    // Contradictory instructions. Honouring either one is a guess.
    expect(replyMarkupKind({ keyboard: [], remove_keyboard: true })).toBeNull();
    expect(replyMarkupKind({ inline_keyboard: [], force_reply: true })).toBeNull();
  });

  it('rejects non-objects and empty objects', () => {
    expect(replyMarkupKind(null)).toBeNull();
    expect(replyMarkupKind('inline_keyboard')).toBeNull();
    expect(replyMarkupKind([])).toBeNull();
    expect(replyMarkupKind({})).toBeNull();
  });
});

describe('sanitizeReplyMarkup — inline keyboards', () => {
  it('keeps a well-formed keyboard intact', () => {
    const markup = sanitizeReplyMarkup({
      inline_keyboard: [
        [
          { text: 'Deploy', callback_data: 'deploy:prod', style: 'danger' },
          { text: 'Cancel', callback_data: 'cancel' },
        ],
        [{ text: 'Docs', url: 'https://prinny.app/docs' }],
      ],
    }) as InlineKeyboardMarkup;

    expect(markup.inline_keyboard).toHaveLength(2);
    expect(markup.inline_keyboard[0]?.[0]).toEqual({
      text: 'Deploy',
      callback_data: 'deploy:prod',
      style: 'danger',
    });
  });

  it('strips bidi overrides that would reorder labels on screen', () => {
    // U+202E makes the rest of the label render right-to-left, which is how a
    // "Cancel" button ends up sitting where the user expects "Deploy".
    const markup = sanitizeReplyMarkup({
      inline_keyboard: [[{ text: `Safe${RLO}Deploy`, callback_data: 'x' }]],
    }) as InlineKeyboardMarkup;

    expect(markup.inline_keyboard[0]?.[0]?.text).toBe('SafeDeploy');
    expect(markup.inline_keyboard[0]?.[0]?.text).not.toContain(RLO);
  });

  it('strips control characters and newlines from labels', () => {
    const markup = sanitizeReplyMarkup({
      inline_keyboard: [[{ text: `One${LF}Two${NUL}Three`, callback_data: 'x' }]],
    }) as InlineKeyboardMarkup;

    expect(markup.inline_keyboard[0]?.[0]?.text).toBe('OneTwoThree');
  });

  it('truncates rather than rejecting an oversized keyboard', () => {
    const rows = Array.from({ length: 25 }, () =>
      Array.from({ length: 20 }, (_, i) => ({ text: `b${i}`, callback_data: `d${i}` }))
    );
    const markup = sanitizeReplyMarkup({ inline_keyboard: rows }) as InlineKeyboardMarkup;

    expect(markup.inline_keyboard).toHaveLength(Limits.KEYBOARD_MAX_ROWS);
    expect(markup.inline_keyboard[0]).toHaveLength(Limits.KEYBOARD_MAX_BUTTONS_PER_ROW);
  });

  it('caps label length', () => {
    const markup = sanitizeReplyMarkup({
      inline_keyboard: [[{ text: 'x'.repeat(500), callback_data: 'd' }]],
    }) as InlineKeyboardMarkup;

    expect(markup.inline_keyboard[0]?.[0]?.text).toHaveLength(Limits.BUTTON_TEXT_MAX_LENGTH);
  });

  it('drops callback_data over the byte limit but keeps the button', () => {
    const markup = sanitizeReplyMarkup({
      inline_keyboard: [[{ text: 'Go', callback_data: 'x'.repeat(600) }]],
    }) as InlineKeyboardMarkup;

    const button = markup.inline_keyboard[0]?.[0];
    expect(button?.text).toBe('Go');
    expect(button?.callback_data).toBeUndefined();
    // With no action left, it renders disabled rather than silently reflowing
    // the row the bot laid out.
    expect(buttonAction(button!).kind).toBe('disabled');
  });

  it('measures callback_data in UTF-8 bytes, not code units', () => {
    // 200 emoji is 800 bytes but only 400 UTF-16 code units.
    const markup = sanitizeReplyMarkup({
      inline_keyboard: [[{ text: 'Go', callback_data: '\u{1F600}'.repeat(200) }]],
    }) as InlineKeyboardMarkup;

    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toBeUndefined();
  });

  it('drops rows that sanitise to nothing, and the keyboard if all do', () => {
    expect(sanitizeReplyMarkup({ inline_keyboard: [[{ text: '   ' }], []] })).toBeNull();
  });

  it('preserves callback_data verbatim, including whitespace', () => {
    // It is opaque machine payload the bot dispatches on. Trimming it would
    // break the bot's own routing for a cosmetic gain nobody can see.
    const markup = sanitizeReplyMarkup({
      inline_keyboard: [[{ text: 'Go', callback_data: '  spaced  ' }]],
    }) as InlineKeyboardMarkup;

    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toBe('  spaced  ');
  });

  it('ignores an unknown style rather than passing it through', () => {
    const markup = sanitizeReplyMarkup({
      inline_keyboard: [[{ text: 'Go', callback_data: 'd', style: 'explode' }]],
    }) as InlineKeyboardMarkup;

    expect(markup.inline_keyboard[0]?.[0]?.style).toBeUndefined();
  });
});

describe('sanitizeReplyMarkup — reply keyboards', () => {
  it('carries the Telegram option flags through', () => {
    const markup = sanitizeReplyMarkup({
      keyboard: [[{ text: 'Status' }, 'Help']],
      resize_keyboard: true,
      one_time_keyboard: true,
      is_persistent: false,
      input_field_placeholder: 'Pick an action',
      selective: true,
    }) as ReplyKeyboardMarkup;

    expect(markup.keyboard[0]).toEqual([{ text: 'Status' }, { text: 'Help' }]);
    expect(markup.resize_keyboard).toBe(true);
    expect(markup.one_time_keyboard).toBe(true);
    expect(markup.is_persistent).toBe(false);
    expect(markup.input_field_placeholder).toBe('Pick an action');
    expect(markup.selective).toBe(true);
  });

  it('ignores non-boolean flags instead of coercing them', () => {
    const markup = sanitizeReplyMarkup({
      keyboard: [['Go']],
      resize_keyboard: 'yes',
      one_time_keyboard: 1,
    }) as ReplyKeyboardMarkup;

    expect(markup.resize_keyboard).toBeUndefined();
    expect(markup.one_time_keyboard).toBeUndefined();
  });
});

describe('isAllowedButtonUrl', () => {
  it('allows http, https and matrix', () => {
    expect(isAllowedButtonUrl('https://prinny.app')).toBe(true);
    expect(isAllowedButtonUrl('http://localhost:8008')).toBe(true);
    expect(isAllowedButtonUrl('matrix:r/room:example.org')).toBe(true);
  });

  it('rejects script-bearing and local schemes', () => {
    expect(isAllowedButtonUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedButtonUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isAllowedButtonUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedButtonUrl('vbscript:msgbox')).toBe(false);
  });

  it('rejects malformed and oversized input', () => {
    expect(isAllowedButtonUrl('not a url')).toBe(false);
    expect(isAllowedButtonUrl('')).toBe(false);
    expect(isAllowedButtonUrl(null)).toBe(false);
    expect(isAllowedButtonUrl(`https://a.example/${'x'.repeat(3000)}`)).toBe(false);
  });

  it('reports the host a confirmation prompt should show', () => {
    // The whole point is that the user sees where they are actually going.
    expect(describeUrlTarget('https://evil.example/login?next=prinny.app')).toBe('evil.example');
  });
});

describe('buttonAction', () => {
  it('resolves each supported action', () => {
    expect(buttonAction({ text: 'a', callback_data: 'd' })).toEqual({ kind: 'callback', data: 'd' });
    expect(buttonAction({ text: 'a', url: 'https://x.example' })).toEqual({
      kind: 'url',
      url: 'https://x.example',
    });
    expect(buttonAction({ text: 'a', copy_text: { text: 'tok' } })).toEqual({
      kind: 'copy',
      text: 'tok',
    });
    expect(buttonAction({ text: 'a', switch_inline_query_current_chat: 'q' })).toEqual({
      kind: 'switch_inline',
      query: 'q',
    });
  });

  it('disables a button carrying two actions rather than picking one', () => {
    // Picking "the first one" is how a url button gets clicked as if it were
    // a harmless callback button.
    const action = buttonAction({ text: 'a', callback_data: 'd', url: 'https://evil.example' });
    expect(action).toEqual({ kind: 'disabled', reason: 'ambiguous' });
  });

  it('disables a button with an unopenable URL', () => {
    expect(buttonAction({ text: 'a', url: 'javascript:alert(1)' })).toEqual({
      kind: 'disabled',
      reason: 'invalid_url',
    });
  });

  it('disables a button carrying only fields this version does not implement', () => {
    expect(buttonAction({ text: 'Pay' })).toEqual({ kind: 'disabled', reason: 'unsupported' });
  });
});

describe('sanitizeBotInfo', () => {
  it('keeps valid commands and drops illegal names', () => {
    const info = sanitizeBotInfo({
      version: 1,
      name: 'OpenClaude',
      commands: [
        { command: 'start', description: 'Greet' },
        { command: 'Bad-Name', description: 'rejected' },
        { command: 'cwd', description: 'Change dir', args: '<path>' },
        { command: '', description: 'rejected' },
      ],
    });

    expect(info?.commands?.map((c) => c.command)).toEqual(['start', 'cwd']);
    expect(info?.commands?.[1]?.args).toBe('<path>');
  });

  it('drops duplicate command names after the first', () => {
    const info = sanitizeBotInfo({
      version: 1,
      commands: [
        { command: 'go', description: 'first' },
        { command: 'go', description: 'impostor' },
      ],
    });

    expect(info?.commands).toHaveLength(1);
    expect(info?.commands?.[0]?.description).toBe('first');
  });

  it('refuses a future schema version outright', () => {
    // v2 may reuse these field names for something else. Half-rendering it is
    // worse than showing nothing.
    expect(sanitizeBotInfo({ version: 2, name: 'Future' })).toBeNull();
  });

  it('only accepts a menu button URL a client would open', () => {
    expect(
      sanitizeBotInfo({ version: 1, menu_button: { type: 'url', text: 'Go', url: 'javascript:1' } })
        ?.menu_button
    ).toBeUndefined();
    expect(
      sanitizeBotInfo({
        version: 1,
        menu_button: { type: 'url', text: 'Go', url: 'https://prinny.app' },
      })?.menu_button
    ).toEqual({ type: 'url', text: 'Go', url: 'https://prinny.app' });
  });
});

describe('normalizeCommandName', () => {
  it('lowercases and converts hyphens, matching Telegram', () => {
    expect(normalizeCommandName('Think-Back')).toBe('think_back');
  });

  it('returns null when nothing legal is left', () => {
    expect(normalizeCommandName('???')).toBeNull();
  });
});

describe('sanitizeCallbackAnswer', () => {
  it('keeps text, alert flag and an openable url', () => {
    const answer = sanitizeCallbackAnswer({
      id: 'abc',
      text: 'Deployed',
      show_alert: true,
      url: 'https://ci.example/run/1',
    });

    expect(answer).toEqual({
      id: 'abc',
      text: 'Deployed',
      show_alert: true,
      url: 'https://ci.example/run/1',
    });
  });

  it('keeps line breaks in alert text, unlike a button label', () => {
    expect(sanitizeCallbackAnswer({ id: 'a', text: 'line one\nline two' })?.text).toBe(
      'line one\nline two'
    );
  });

  it('drops a url no client would open', () => {
    expect(sanitizeCallbackAnswer({ id: 'a', url: 'javascript:alert(1)' })?.url).toBeUndefined();
  });

  it('requires an id to correlate against', () => {
    expect(sanitizeCallbackAnswer({ text: 'orphan' })).toBeNull();
  });
});
