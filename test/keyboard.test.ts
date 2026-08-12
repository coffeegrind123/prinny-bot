import { describe, expect, it } from 'vitest';
import { InlineKeyboard } from '../src/keyboard/InlineKeyboard.js';
import { Keyboard, forceReply, removeKeyboard } from '../src/keyboard/Keyboard.js';
import { Limits } from '../src/protocol/constants.js';

describe('InlineKeyboard', () => {
  it('builds rows in the order they were declared', () => {
    const markup = new InlineKeyboard()
      .text('Yes', 'v:y')
      .text('No', 'v:n')
      .row()
      .url('Docs', 'https://prinny.app')
      .build();

    expect(markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Yes', callback_data: 'v:y' },
          { text: 'No', callback_data: 'v:n' },
        ],
        [{ text: 'Docs', url: 'https://prinny.app' }],
      ],
    });
  });

  it('defaults callback_data to the label, as grammY does', () => {
    expect(InlineKeyboard.text('Retry').build().inline_keyboard[0]?.[0]).toEqual({
      text: 'Retry',
      callback_data: 'Retry',
    });
  });

  it('tags primary and danger buttons', () => {
    const markup = new InlineKeyboard().primary('Ship', 'go').danger('Delete', 'rm').build();
    expect(markup.inline_keyboard[0]?.[0]?.style).toBe('primary');
    expect(markup.inline_keyboard[0]?.[1]?.style).toBe('danger');
  });

  it('ignores a redundant .row() rather than emitting an empty row', () => {
    const markup = new InlineKeyboard().row().text('A', 'a').row().row().build();
    expect(markup.inline_keyboard).toEqual([[{ text: 'A', callback_data: 'a' }]]);
  });

  it('lays out a grid without hand-written .row() calls', () => {
    const markup = InlineKeyboard.grid(
      ['a', 'b', 'c', 'd', 'e'].map((k) => ({ text: k.toUpperCase(), callback_data: k })),
      2
    ).build();

    expect(markup.inline_keyboard.map((row) => row.length)).toEqual([2, 2, 1]);
  });

  it('round-trips through .from()', () => {
    const original = new InlineKeyboard().text('A', 'a').row().text('B', 'b').build();
    expect(InlineKeyboard.from(original).build()).toEqual(original);
  });

  // The point of validating in the builder is that the author finds out at the
  // line that caused it, instead of from a button that silently disappears
  // inside a client's sanitiser three hops later.
  it('rejects oversized callback_data at build time', () => {
    expect(() => new InlineKeyboard().text('Go', 'x'.repeat(600))).toThrow(/callback_data is 600/);
  });

  it('rejects a URL no client would open', () => {
    expect(() => new InlineKeyboard().url('Click', 'javascript:alert(1)')).toThrow(/no client/);
  });

  it('rejects an empty or oversized label', () => {
    expect(() => new InlineKeyboard().text('')).toThrow(/cannot be empty/);
    expect(() => new InlineKeyboard().text('x'.repeat(80), 'd')).toThrow(/limit is 64/);
  });

  it('rejects a row wider than the limit', () => {
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < Limits.KEYBOARD_MAX_BUTTONS_PER_ROW; i += 1) keyboard.text(`b${i}`, `${i}`);
    expect(() => keyboard.text('overflow', 'x')).toThrow(/at most 8 buttons/);
  });

  it('refuses to build nothing', () => {
    expect(() => new InlineKeyboard().build()).toThrow(/empty inline keyboard/);
  });
});

describe('Keyboard', () => {
  it('maps the fluent options onto Telegram field names', () => {
    const markup = new Keyboard()
      .text('Status')
      .text('Help')
      .row()
      .text('Stop')
      .resized()
      .oneTime()
      .persistent(false)
      .placeholder('Pick an action')
      .selected()
      .build();

    expect(markup).toEqual({
      keyboard: [[{ text: 'Status' }, { text: 'Help' }], [{ text: 'Stop' }]],
      resize_keyboard: true,
      one_time_keyboard: true,
      is_persistent: false,
      input_field_placeholder: 'Pick an action',
      selective: true,
    });
  });

  it('truncates an overlong placeholder instead of throwing', () => {
    const markup = new Keyboard().text('A').placeholder('p'.repeat(200)).build();
    expect(markup.input_field_placeholder).toHaveLength(Limits.PLACEHOLDER_MAX_LENGTH);
  });

  it('points at removeKeyboard() when asked to build nothing', () => {
    expect(() => new Keyboard().build()).toThrow(/removeKeyboard/);
  });

  it('round-trips options through .from()', () => {
    const original = new Keyboard().text('A').resized().placeholder('go').build();
    expect(Keyboard.from(original).build()).toEqual(original);
  });
});

describe('removeKeyboard / forceReply', () => {
  it('emits the Telegram shapes', () => {
    expect(removeKeyboard()).toEqual({ remove_keyboard: true });
    expect(removeKeyboard(true)).toEqual({ remove_keyboard: true, selective: true });
    expect(forceReply()).toEqual({ force_reply: true });
    expect(forceReply({ placeholder: 'Path?', selective: true })).toEqual({
      force_reply: true,
      input_field_placeholder: 'Path?',
      selective: true,
    });
  });
});
