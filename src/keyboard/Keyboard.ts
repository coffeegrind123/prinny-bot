/**
 * Reply keyboard builder, plus the two markup shapes that have nothing to
 * build: `removeKeyboard()` and `forceReply()`.
 *
 * Method names are grammY's — `.resized()`, `.oneTime()`, `.persistent()`,
 * `.placeholder()`, `.selected()` — mapping onto Telegram's underscore field
 * names on the wire.
 */

import { Limits } from '../protocol/constants.js';
import type {
  ForceReply,
  KeyboardButton,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
} from '../protocol/types.js';

const assertLabel = (label: string): string => {
  if (label.length === 0) throw new RangeError('Keyboard button text cannot be empty');
  if (label.length > Limits.BUTTON_TEXT_MAX_LENGTH) {
    throw new RangeError(
      `Keyboard button text is ${label.length} characters, limit is ${Limits.BUTTON_TEXT_MAX_LENGTH}`
    );
  }
  return label;
};

export class Keyboard {
  private readonly rows: KeyboardButton[][] = [];

  private current: KeyboardButton[] = [];

  private options: Omit<ReplyKeyboardMarkup, 'keyboard'> = {};

  constructor(rows?: KeyboardButton[][]) {
    if (rows) {
      for (const row of rows) {
        this.rows.push(row.map((button) => ({ text: assertLabel(button.text) })));
      }
    }
  }

  /**
   * A quick-reply key.
   *
   * Pressing it sends `label` as an ordinary message — the bot's plain text
   * handler sees it, not its callback handler. That is Telegram's behaviour
   * and the reason reply keyboards work on every client: to a client that
   * has never heard of this schema, the user simply typed the words.
   */
  text(label: string): this {
    if (this.current.length >= Limits.KEYBOARD_MAX_BUTTONS_PER_ROW) {
      throw new RangeError(
        `A row holds at most ${Limits.KEYBOARD_MAX_BUTTONS_PER_ROW} keys. Call .row() first.`
      );
    }
    this.current.push({ text: assertLabel(label) });
    return this;
  }

  row(): this {
    if (this.current.length > 0) {
      if (this.rows.length >= Limits.KEYBOARD_MAX_ROWS) {
        throw new RangeError(`A keyboard holds at most ${Limits.KEYBOARD_MAX_ROWS} rows.`);
      }
      this.rows.push(this.current);
      this.current = [];
    }
    return this;
  }

  /** Shrink the keyboard to fit its keys. Telegram's `resize_keyboard`. */
  resized(value = true): this {
    this.options.resize_keyboard = value;
    return this;
  }

  /** Hide after one press. Telegram's `one_time_keyboard`. */
  oneTime(value = true): this {
    this.options.one_time_keyboard = value;
    return this;
  }

  /** Keep it open rather than collapsing. Telegram's `is_persistent`. */
  persistent(value = true): this {
    this.options.is_persistent = value;
    return this;
  }

  /** Composer placeholder while the keyboard is up. */
  placeholder(text: string): this {
    this.options.input_field_placeholder = text.slice(0, Limits.PLACEHOLDER_MAX_LENGTH);
    return this;
  }

  /** Show only to users the message mentions. Telegram's `selective`. */
  selected(value = true): this {
    this.options.selective = value;
    return this;
  }

  build(): ReplyKeyboardMarkup {
    const keyboard = this.current.length > 0 ? [...this.rows, this.current] : [...this.rows];
    if (keyboard.length === 0) {
      throw new RangeError('Cannot build an empty reply keyboard. Use removeKeyboard() instead.');
    }
    return { keyboard, ...this.options };
  }

  toJSON(): ReplyKeyboardMarkup {
    return this.build();
  }

  static text(label: string): Keyboard {
    return new Keyboard().text(label);
  }

  /** Lay keys out in a grid `columns` wide. */
  static grid(labels: string[], columns = 2): Keyboard {
    const keyboard = new Keyboard();
    labels.forEach((label, index) => {
      if (index > 0 && index % columns === 0) keyboard.row();
      keyboard.text(label);
    });
    return keyboard;
  }

  static from(markup: ReplyKeyboardMarkup): Keyboard {
    const keyboard = new Keyboard(markup.keyboard);
    const { keyboard: _ignored, ...options } = markup;
    keyboard.options = options;
    return keyboard;
  }
}

/** Clear the active reply keyboard. Telegram's `ReplyKeyboardRemove`. */
export const removeKeyboard = (selective?: boolean): ReplyKeyboardRemove => {
  const markup: ReplyKeyboardRemove = { remove_keyboard: true };
  if (selective !== undefined) markup.selective = selective;
  return markup;
};

/**
 * Arm the user's composer as a reply to this message. Telegram's `ForceReply`.
 *
 * Use it when the next thing you need is free text that a keyboard cannot
 * enumerate — a path, a commit message, a search term.
 */
export const forceReply = (options?: {
  placeholder?: string;
  selective?: boolean;
}): ForceReply => {
  const markup: ForceReply = { force_reply: true };
  if (options?.placeholder) {
    markup.input_field_placeholder = options.placeholder.slice(0, Limits.PLACEHOLDER_MAX_LENGTH);
  }
  if (options?.selective !== undefined) markup.selective = options.selective;
  return markup;
};
