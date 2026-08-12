# `app.prinny.bot.*` — Telegram-style bot interaction over Matrix

Version 1. Status: implemented by [`@prinny/bot`](../README.md) and
[Prinny Client](https://github.com/coffeegrind123/prinny-client).

Matrix has no equivalent of the Telegram Bot API's `setMyCommands`, inline
keyboards, or callback queries. The only prior art is
[MSC1485 "Hint buttons in messages"](https://github.com/matrix-org/matrix-spec-proposals/issues/3812),
which is a stub linking to a Google Doc and an abandoned riot-web PR — no
schema, no implementations. `mautrix-telegram` does not forward Telegram's
`reply_markup` to Matrix either, so bridged bot keyboards arrive as nothing at
all.

This document defines the schema Prinny uses. Field names mirror the
[Telegram Bot API](https://core.telegram.org/bots/api) exactly wherever an
equivalent exists, so that porting a bot is a matter of changing the transport
and not the shape of the code.

## Design rules

1. **Telegram names win.** If Telegram has a field for a concept, we use its
   name and its semantics — `one_time_keyboard`, not `hideAfterUse`.
2. **Degrade to text, always.** A client that has never heard of this schema
   must still show the user something they can act on. See
   [Plain-text fallback](#plain-text-fallback).
3. **Never trust a keyboard.** Anyone in a room can send these events. Clients
   render them under the constraints in [Client obligations](#client-obligations).
4. **Reuse Matrix where Matrix already works.** Editing a keyboard is an
   `m.replace` edit, not a bespoke event. Typing indicators, receipts, replies
   and redactions are all stock Matrix.

## Namespace and limits

All event types and content keys are prefixed `app.prinny.bot.`.

| Limit | Value | Source |
|-------|-------|--------|
| `command` pattern | `^[a-z0-9_]{1,32}$` | Telegram |
| `description` length | 256 | Telegram |
| `callback_data` length | 512 bytes UTF-8 | Telegram |
| Button `text` length | 64 | Prinny |
| Rows per keyboard | 10 | Prinny |
| Buttons per row | 8 | Prinny |
| Commands per bot | 100 | Telegram |

Prinny limits exist so a hostile event cannot produce an unbounded render.
Clients MUST truncate rather than refuse when a limit is exceeded, except where
stated otherwise.

---

## 1. Bot advertisement — `app.prinny.bot.info`

The `setMyCommands` / `setMyDescription` / `setChatMenuButton` equivalent.

**Primary form: a state event**, `type` = `app.prinny.bot.info`, `state_key` =
the bot's own MXID. A bot MUST NOT set this state event with a `state_key` other
than its own MXID, and clients MUST ignore it if it does.

```json5
{
  "version": 1,
  "name": "OpenClaude",
  "short_description": "Code with Claude in chat",
  "description": "Runs an agentic coding session in this room. Send a message to start.",
  "commands": [
    { "command": "start",  "description": "Greet / claim ownership" },
    { "command": "status", "description": "Show session, cwd, and model" },
    { "command": "cwd",    "description": "Change the working directory", "args": "<path>" }
  ],
  "menu_button": { "type": "commands" },
  "privacy_mode": true
}
```

| Field | Type | Notes |
|-------|------|-------|
| `version` | integer | Schema version. `1`. Clients ignore events with an unknown major version. |
| `name` | string | Display name for the bot card. Falls back to the room member displayname. |
| `short_description` | string | One line, ≤120 chars. Telegram's `setMyShortDescription`. |
| `description` | string | Longer blurb for the profile card. Telegram's `setMyDescription`. |
| `commands` | array | See below. Ordered; clients preserve order. |
| `menu_button` | object | `{ "type": "commands" }`, `{ "type": "default" }`, or `{ "type": "url", "text": "…", "url": "…" }`. |
| `privacy_mode` | boolean | Advisory. Declares the bot only reads messages addressed to it. Clients MAY surface this; they do not enforce it. |

`commands[]` entries are Telegram's `BotCommand` plus one addition:

| Field | Type | Notes |
|-------|------|-------|
| `command` | string | Without the leading `/`. Matches `^[a-z0-9_]{1,32}$`. |
| `description` | string | ≤256 chars. |
| `args` | string | **Prinny extension.** Usage hint, e.g. `<path>` or `[on\|off]`. Telegram has no room to display this; Matrix autocomplete does. |

### Scopes

The state event is per-room, which is exactly Telegram's
`BotCommandScopeChat`. A bot wanting the `BotCommandScopeDefault` behaviour
publishes identical content in every room it joins. There is deliberately no
global registry: Matrix has no server-side per-bot storage other than the bot's
own profile, and reading another user's profile extensions is not portable
across homeservers.

### Fallback when the bot cannot send state

Publishing state requires power level 50 by default. A bot in a public room
usually has PL 0. In that case the bot sends **the same content as a normal
timeline event** of type `app.prinny.bot.info` (no `state_key`).

Clients that see such an event cache it keyed by `(room_id, sender)`, keeping
only the most recent, and treat it exactly as they would the state event. The
state event, when present, always wins.

A bot SHOULD re-send the timeline form on join and whenever its command list
changes. Clients MUST NOT paginate history looking for one; a bot that never
re-advertises simply has no published commands, and that is a correct outcome.

---

## 2. Keyboards — `app.prinny.bot.reply_markup`

A **content key**, not an event type. It attaches to any event the bot sends —
normally an `m.room.message`, but an `m.image` or a custom type works equally
well.

The value is one of Telegram's four `reply_markup` shapes, discriminated by
which key is present. A markup object containing more than one discriminator is
invalid and MUST be ignored entirely (not partially applied).

### 2.1 `InlineKeyboardMarkup` — buttons under the message

```json5
{
  "msgtype": "m.text",
  "body": "Deploy to production?\n\n[1] Deploy\n[2] Cancel\n[3] Docs",
  "app.prinny.bot.plain_body": "Deploy to production?",
  "app.prinny.bot.reply_markup": {
    "inline_keyboard": [
      [ { "text": "Deploy", "callback_data": "deploy:prod", "style": "primary" },
        { "text": "Cancel", "callback_data": "cancel",      "style": "danger"  } ],
      [ { "text": "Docs", "url": "https://prinny.app/docs" } ]
    ]
  }
}
```

`InlineKeyboardButton` — `text` plus **exactly one** action field:

| Field | Type | Behaviour |
|-------|------|-----------|
| `callback_data` | string | Sends [`app.prinny.bot.callback`](#3-callback-queries). ≤512 bytes. |
| `url` | string | Opens a URL. `https:`, `http:` and `matrix:` only. Client confirms first — see [Client obligations](#client-obligations). |
| `copy_text` | `{ "text": "…" }` | Copies to clipboard. Telegram's `CopyTextButton`, minus its redundant `type` field. |
| `switch_inline_query_current_chat` | string | Prefills the composer in the current room with this text. |

Plus one presentational extension:

| Field | Type | Behaviour |
|-------|------|-----------|
| `style` | `"default"` \| `"primary"` \| `"danger"` | **Prinny extension.** Telegram has no button styling; Matrix clients can afford it and destructive actions benefit from looking destructive. Unknown values render as `default`. |

Telegram fields deliberately **not** supported in v1, because they have no
meaning outside Telegram's platform: `web_app`, `login_url`, `pay`,
`callback_game`, `switch_inline_query`, `switch_inline_query_chosen_chat`.
Clients MUST render a button carrying only unsupported action fields as
disabled rather than dropping it, so the layout the bot intended survives.

### 2.2 `ReplyKeyboardMarkup` — quick replies above the composer

```json5
{
  "app.prinny.bot.reply_markup": {
    "keyboard": [
      [ { "text": "Status" }, { "text": "Help" } ],
      [ { "text": "Stop" } ]
    ],
    "is_persistent": false,
    "resize_keyboard": true,
    "one_time_keyboard": true,
    "input_field_placeholder": "Pick an action",
    "selective": false
  }
}
```

Field names and meanings are Telegram's verbatim. Pressing a key sends its
`text` as an ordinary `m.text` message — the bot receives a normal message, not
a callback, exactly as on Telegram.

`selective: true` means "show only to the users this message mentions", resolved
against the event's `m.mentions`.

Telegram's `KeyboardButton` request fields (`request_users`, `request_chat`,
`request_contact`, `request_location`, `request_poll`, `web_app`) are not in v1.
A button carrying only those renders as a plain text button.

**Persistence.** A reply keyboard outlives the message that delivered it. The
client stores the active keyboard in **room account data** under
`app.prinny.bot.keyboard`, keyed by bot MXID, so it survives a reload and
follows the user across devices.

### 2.3 `ReplyKeyboardRemove`

```json5
{ "app.prinny.bot.reply_markup": { "remove_keyboard": true, "selective": false } }
```

Clears the stored reply keyboard for that bot in that room.

### 2.4 `ForceReply`

```json5
{
  "app.prinny.bot.reply_markup": {
    "force_reply": true,
    "input_field_placeholder": "Enter the absolute path",
    "selective": false
  }
}
```

The client focuses the composer, pre-arms it as a reply to this event, and shows
the placeholder. The user can still dismiss it.

---

## 3. Callback queries

### 3.1 `app.prinny.bot.callback` — sent by the client

```json5
{
  "m.relates_to": {
    "rel_type": "app.prinny.bot.callback",
    "event_id": "$the_message_carrying_the_keyboard"
  },
  "id": "c8a1f0e2-…",
  "data": "deploy:prod",
  "button": [0, 0]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Client-generated, unique per click. Correlates the answer. |
| `data` | string | Verbatim `callback_data` from the pressed button. |
| `button` | `[row, col]` | Zero-based position. Lets a bot tell two identically-labelled buttons apart without encoding the position into `callback_data`. |

The relation uses a custom `rel_type` rather than `m.reference` so that callback
traffic never lands in a client's reference-aggregation UI.

### 3.2 `app.prinny.bot.callback_answer` — sent by the bot

Telegram's `answerCallbackQuery`.

```json5
{
  "m.relates_to": {
    "rel_type": "app.prinny.bot.callback_answer",
    "event_id": "$the_callback_event"
  },
  "id": "c8a1f0e2-…",
  "text": "Deploying to production…",
  "show_alert": false,
  "url": "https://ci.example/run/42"
}
```

`text` shows as a transient toast; `show_alert: true` promotes it to a modal the
user must dismiss. `url`, if present, is offered to the user behind the same
confirmation as a URL button — never opened automatically.

Every field except `m.relates_to` and `id` is optional. An answer with no `text`
simply clears the button's pending state, which is the common case.

### 3.3 Lifecycle

1. User clicks. Client sends `app.prinny.bot.callback` and marks the button
   pending.
2. Bot handles it and sends `app.prinny.bot.callback_answer`.
3. Client clears the pending state and shows `text` if given.
4. If no answer arrives within **15 seconds**, the client clears the pending
   state and shows an unobtrusive "no response" hint. It does not retry.

Bots SHOULD answer every callback even when there is nothing to say, because the
spinner is the user's only feedback that the click registered.

### 3.4 Updating a keyboard

There is no bespoke edit event. `editMessageText` and `editMessageReplyMarkup`
are both a standard Matrix edit:

```json5
{
  "msgtype": "m.text",
  "body": "* Deploying…",
  "m.new_content": {
    "msgtype": "m.text",
    "body": "Deploying…",
    "app.prinny.bot.reply_markup": { "inline_keyboard": [[{ "text": "Cancel", "callback_data": "abort" }]] }
  },
  "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
}
```

Clients MUST read `reply_markup` from the most recent edit, and MUST ignore
edits whose sender differs from the original event's sender. Omitting
`reply_markup` from `m.new_content` removes the keyboard.

---

## 4. Plain-text fallback

**This is not optional, and it is what makes the schema safe to deploy on a
federated network.** A user on Element must still be able to act on a bot
message that a Prinny user answers with a button.

For an inline keyboard, the sending library writes a numbered listing of the
callback and URL buttons into `body` (and `formatted_body`), and puts the
unannotated text in `app.prinny.bot.plain_body` (and
`app.prinny.bot.plain_formatted_body`):

```
Deploy to production?

[1] Deploy
[2] Cancel
[3] Docs — https://prinny.app/docs
```

A client that renders the keyboard displays `plain_body` and never shows the
listing. A client that does not renders `body` and the user replies `1`.

The duplication costs a few hundred bytes per keyboard message. The alternative
— a count of trailing lines for the client to trim — is smaller but fails
silently and unrecoverably when a bot miscounts, leaving the user staring at a
stray `[2] Cancel`. An explicit clean copy cannot desynchronise.

Reply keyboards get the same treatment, listing the key labels. `remove_keyboard`
and `force_reply` need no fallback.

Bot libraries SHOULD provide a matcher that resolves a plain reply — `1`,
`deploy`, or `Deploy` — back to the button the user meant, so a bot's callback
handler and its text handler are the same code path. `@prinny/bot` exposes this
as `matchFallbackReply()`.

---

## 5. Client obligations

A client rendering this schema MUST:

- **Render markup only from the event's own sender.** An edit from a different
  user cannot introduce or alter a keyboard.
- **Treat every string as text.** Button labels, `input_field_placeholder`, and
  callback answer `text` are never parsed as HTML or Markdown. A label is a
  label.
- **Confirm before opening any URL**, showing the fully-resolved host. This
  applies to `url` buttons and to `url` on a callback answer. Never open one
  without an explicit second interaction.
- **Restrict URL schemes** to `https:`, `http:` and `matrix:`. Everything else
  renders disabled.
- **Enforce the limits table**, truncating excess rows, buttons and characters.
- **Confine callbacks to the originating room**, addressed to the original
  sender.
- **Debounce clicks** so a held or double-clicked button produces one callback.
- **Offer an off switch.** A per-account setting to stop rendering bot keyboards
  entirely, falling back to `body`.

A client MUST NOT auto-click, prefetch `url` targets, or send a callback for any
reason other than a direct user action.

## 6. Deep links

Telegram's `https://t.me/bot?start=payload`:

```
https://prinny.app/bot/{mxid}?start={payload}
```

Opening one joins or creates a DM with `{mxid}` and sends `/start {payload}` as
an ordinary message. `{payload}` is limited to 64 characters of
`[A-Za-z0-9_-]`, matching Telegram, and the client URL-decodes it exactly once.

The client MUST show the target bot's MXID and require confirmation before
creating a room or sending anything. A link is an invitation, not an
instruction.

## 7. Identifying a bot

There is no Matrix-wide notion of a bot account. A client treats a user as a bot
in a given room if either holds:

- an `app.prinny.bot.info` state event or cached timeline advertisement exists
  for that user in that room, or
- their `m.room.member` content carries `"app.prinny.bot": true`.

The badge is per-room and derived from what that user actually published there.
It is a hint about behaviour, not a verified identity claim, and clients should
not present it as one.
