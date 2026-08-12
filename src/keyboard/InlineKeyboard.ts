/**
 * Inline keyboard builder.
 *
 * The API is grammY's, deliberately: `.text()`, `.url()`, `.row()`, chained,
 * with static shorthands. Someone porting a Telegram bot should be able to
 * paste their keyboard construction across unchanged.
 */

import { Limits } from '../protocol/constants.js';
import { isAllowedButtonUrl } from '../protocol/validate.js';
import type { ButtonStyle, InlineKeyboardButton, InlineKeyboardMarkup } from '../protocol/types.js';

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Validate at build time, not send time.
 *
 * A bot author who writes a 700-byte `callback_data` should find out at the
 * line that did it, not from a keyboard that silently loses a button three
 * hops later inside a client's sanitiser.
 */
const assertButton = (button: InlineKeyboardButton): InlineKeyboardButton => {
  if (button.text.length === 0) {
    throw new RangeError('Button text cannot be empty');
  }
  if (button.text.length > Limits.BUTTON_TEXT_MAX_LENGTH) {
    throw new RangeError(
      `Button text is ${button.text.length} characters, limit is ${Limits.BUTTON_TEXT_MAX_LENGTH}: ${JSON.stringify(button.text)}`
    );
  }
  if (button.callback_data !== undefined) {
    const bytes = utf8Bytes(button.callback_data);
    if (bytes > Limits.CALLBACK_DATA_MAX_BYTES) {
      throw new RangeError(
        `callback_data is ${bytes} bytes, limit is ${Limits.CALLBACK_DATA_MAX_BYTES}. ` +
          'Store the payload yourself and put a key in the button.'
      );
    }
  }
  if (button.url !== undefined && !isAllowedButtonUrl(button.url)) {
    throw new RangeError(
      `Button URL is not an http(s) or matrix URL and no client will open it: ${button.url}`
    );
  }
  return button;
};

export class InlineKeyboard {
  /** Completed rows. The row under construction is `current`. */
  private readonly rows: InlineKeyboardButton[][] = [];

  private current: InlineKeyboardButton[] = [];

  constructor(rows?: InlineKeyboardButton[][]) {
    if (rows) {
      for (const row of rows) {
        this.rows.push(row.map(assertButton));
      }
    }
  }

  private add(button: InlineKeyboardButton): this {
    if (this.current.length >= Limits.KEYBOARD_MAX_BUTTONS_PER_ROW) {
      throw new RangeError(
        `A row holds at most ${Limits.KEYBOARD_MAX_BUTTONS_PER_ROW} buttons. Call .row() first.`
      );
    }
    this.current.push(assertButton(button));
    return this;
  }

  /** A button that sends `callback_data` back to the bot when pressed. */
  text(label: string, callbackData: string = label, style?: ButtonStyle): this {
    const button: InlineKeyboardButton = { text: label, callback_data: callbackData };
    if (style) button.style = style;
    return this.add(button);
  }

  /** Emphasised button. Sugar for `.text(label, data, 'primary')`. */
  primary(label: string, callbackData: string = label): this {
    return this.text(label, callbackData, 'primary');
  }

  /** Destructive button. Sugar for `.text(label, data, 'danger')`. */
  danger(label: string, callbackData: string = label): this {
    return this.text(label, callbackData, 'danger');
  }

  /** A button that opens a URL, behind a client-side confirmation. */
  url(label: string, url: string): this {
    return this.add({ text: label, url });
  }

  /** A button that copies text to the clipboard. Telegram's `copy_text`. */
  copyText(label: string, text: string): this {
    return this.add({ text: label, copy_text: { text } });
  }

  /** A button that prefills the composer in the current room. */
  switchInlineCurrent(label: string, query = ''): this {
    return this.add({ text: label, switch_inline_query_current_chat: query });
  }

  /** Start a new row. A no-op when the current row is empty, so trailing and
   *  doubled `.row()` calls cannot produce empty rows. */
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

  /** The wire form. */
  build(): InlineKeyboardMarkup {
    const rows = this.current.length > 0 ? [...this.rows, this.current] : [...this.rows];
    if (rows.length === 0) {
      throw new RangeError('Cannot build an empty inline keyboard');
    }
    if (rows.length > Limits.KEYBOARD_MAX_ROWS) {
      throw new RangeError(`A keyboard holds at most ${Limits.KEYBOARD_MAX_ROWS} rows.`);
    }
    return { inline_keyboard: rows };
  }

  /** So a builder can be passed anywhere the wire form is expected. */
  toJSON(): InlineKeyboardMarkup {
    return this.build();
  }

  // ── Static shorthands ──────────────────────────────────────────────────────

  static text(label: string, callbackData: string = label, style?: ButtonStyle): InlineKeyboard {
    return new InlineKeyboard().text(label, callbackData, style);
  }

  static url(label: string, url: string): InlineKeyboard {
    return new InlineKeyboard().url(label, url);
  }

  /**
   * Lay buttons out in a grid `columns` wide.
   *
   * The common case for a bot generating options from a list, where writing
   * the `.row()` calls by hand is all boilerplate.
   */
  static grid(buttons: InlineKeyboardButton[], columns = 2): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    buttons.forEach((button, index) => {
      if (index > 0 && index % columns === 0) keyboard.row();
      keyboard.add(button);
    });
    return keyboard;
  }

  /** Rebuild from an existing markup, e.g. to edit one button and resend. */
  static from(markup: InlineKeyboardMarkup): InlineKeyboard {
    return new InlineKeyboard(markup.inline_keyboard);
  }
}
