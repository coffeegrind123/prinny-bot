# @prinny/bot

Telegram-style bots for Matrix: a published command menu, inline keyboards with
callback queries, reply keyboards, force-reply prompts — and a plain-text
fallback so all of it still works for people whose client has never heard of any
of it.

If you have written a Telegram bot, the API will look familiar on purpose. Field
names track the [Telegram Bot API](https://core.telegram.org/bots/api) wherever
an equivalent exists, and the builder methods follow
[grammY](https://grammy.dev)'s shape.

```ts
import { Bot, InlineKeyboard } from '@prinny/bot';

const bot = new Bot({
  homeserverUrl: 'https://matrix.example.org',
  userId: '@helper:example.org',
  password: process.env.MATRIX_PASSWORD,
  access: { ownerUserId: '@you:example.org' },
});

await bot.setMyCommands([
  { command: 'start', description: 'Say hello' },
  { command: 'deploy', description: 'Ship it', args: '<env>' },
]);

bot.command('deploy', async (ctx) => {
  await ctx.reply(`Deploy to ${ctx.command?.args || 'production'}?`, {
    reply_markup: new InlineKeyboard()
      .danger('Deploy', 'deploy:yes')
      .text('Cancel', 'deploy:no'),
  });
});

bot.callbackQuery(/^deploy:(yes|no)$/, async (ctx) => {
  const go = ctx.match?.[1] === 'yes';
  await ctx.answerCallbackQuery({ text: go ? 'Shipping…' : 'Cancelled' });
  await ctx.editMessageText(go ? 'Deploying.' : 'Cancelled.');
});

await bot.start();
```

## Why this exists

Matrix has no `setMyCommands`, no inline keyboards, and no callback queries. The
only prior art is [MSC1485 "Hint buttons in
messages"](https://github.com/matrix-org/matrix-spec-proposals/issues/3812),
which is a stub pointing at a Google Doc and an abandoned riot-web PR — no
schema, no implementations. `mautrix-telegram` does not forward Telegram's
`reply_markup` either, so even bridged Telegram bots arrive with their keyboards
stripped.

So this defines a schema — `app.prinny.bot.*`, specified in
[`spec/app.prinny.bot.md`](spec/app.prinny.bot.md) — and implements both halves:
this library sends it, and [Prinny Client](https://github.com/coffeegrind123/prinny-client)
renders it.

## The fallback is the point

Every keyboard message also carries a numbered listing in its `body`:

```
Deploy to production?

[1] Deploy
[2] Cancel
```

Someone on Prinny sees buttons and never sees that list. Someone on Element sees
the list and replies `1`. `Bot` resolves that reply against the keyboard it most
recently sent and hands your `callbackQuery` handler a normal callback context —
so **one handler serves both**, and you do not write the text path yourself.

This is on by default (`matchFallbackReplies`). It is the single most important
thing in the library: without it, deploying a bot built on this schema would
quietly break it for everyone not running one specific client.

## What you get

| Telegram | Here |
|---|---|
| `setMyCommands` | `bot.setMyCommands([...])` — published per room as `app.prinny.bot.info` |
| `setMyDescription`, `setMyName` | `bot.setMyProfile({...})` |
| `setChatMenuButton` | `bot.setChatMenuButton({ type: 'commands' })` |
| `InlineKeyboardMarkup` | `new InlineKeyboard().text().url().row()` |
| `ReplyKeyboardMarkup` | `new Keyboard().text().resized().oneTime()` |
| `ReplyKeyboardRemove` | `removeKeyboard()` |
| `ForceReply` | `forceReply({ placeholder })` |
| `answerCallbackQuery` | `ctx.answerCallbackQuery({ text, show_alert })` |
| `editMessageText` / `editMessageReplyMarkup` | same names — standard Matrix `m.replace` edits underneath |
| `sendChatAction('typing')` | `ctx.typing()`, or `ctx.withTyping(fn)` |
| deep links (`t.me/bot?start=x`) | `buildDeepLink(userId, payload)` |

Beyond Telegram: a `style` on inline buttons (`primary` / `danger`), an `args`
usage hint on commands, and `/cmd@bot` addressing that a client can resolve for
the user instead of making them type it.

Not implemented, because they describe Telegram platform features with no Matrix
meaning: `web_app`, `login_url`, `pay`, `callback_game`, inline mode.

## Handlers

grammY's model — everything is middleware.

```ts
bot.use(async (ctx, next) => { console.log(ctx.from, ctx.text); await next(); });

bot.command('start', handler);              // /start
bot.command(['help', 'h'], handler);        // either
bot.callbackQuery(/^vote:(\w+)$/, handler); // ctx.match holds the captures
bot.hears('ping', handler);                 // exact text match
bot.on('message:image', handler);           // filter queries
bot.ownerOnly(handler);                     // access-controlled
bot.errorBoundary(onError, ...handlers);    // scoped error handling
bot.catch(onError);                         // global
```

`ctx.session` is a plain mutable object, per room by default, backed by memory
or `FileSessionStorage`.

## Encryption, and the things that silently break without it

The bot runs E2EE by default and **refuses to start if crypto fails to
initialise** — pass `allowUnencrypted: true` to override. A crypto failure that
silently downgraded the bot to plaintext, in rooms everyone believed were
encrypted, is worse than a bot that does not start.

Two things learned the hard way, both ported from
[openclaude](https://github.com/coffeegrind123/openclaude)'s Matrix bot:

- **The crypto store must survive restarts.** It is `fake-indexeddb` plus a JSON
  snapshot, restored *before* `initRustCrypto()`. Restore afterwards and the bot
  mints a new Olm identity on every boot, and peers stop sharing room keys with
  a device whose keys keep changing.
- **The bot's device must be cross-signed.** Otherwise it reads as
  unverified-by-its-own-user and modern clients exclude it from megolm key
  sharing — so it receives events it can never decrypt. This needs
  user-interactive auth, so it only works if you start the bot with a `password`
  at least once. The symptom otherwise is "the bot ignores me", with nothing in
  the logs.

SAS verification is auto-accepted, but only from the owner or an allowlisted
user. Confirming blind for anyone would let a stranger get the bot to
cryptographically vouch for their device.

## Access control

```ts
new Bot({
  access: {
    ownerUserId: '@you:example.org',
    allowedUserIds: ['@friend:example.org'],
    persist: (state) => fs.writeFileSync('allow.json', JSON.stringify(state)),
  },
  rateLimit: { max: 10, windowMs: 5 * 60_000 },  // owner exempt; `false` disables
});
```

`allowBootstrap: true` lets the first user who talks to the bot claim it. It is
off by default, unlike openclaude's version: it is a real race, and anyone on
the homeserver who learns the bot's MXID before its owner does wins it.

## Examples

- [`examples/echo`](examples/echo) — the smallest useful bot
- [`examples/keyboard-demo`](examples/keyboard-demo) — every button and keyboard
  type, including the ones meant to render disabled

```bash
MATRIX_HOMESERVER=https://matrix.example.org \
MATRIX_USER_ID=@echo:example.org \
MATRIX_PASSWORD=… \
MATRIX_OWNER=@you:example.org \
npx tsx examples/echo/bot.ts
```

## Development

```bash
npm install
npm run check    # lint, typecheck, test
```

## Licence

**Undecided — pick one before publishing.** The package is marked `private` and
`UNLICENSED` so it cannot be published under a licence nobody chose.

The Matrix internals here are ported from
[openclaude](https://github.com/coffeegrind123/openclaude), which carries no
`LICENSE` file and no `license` field in its `package.json`. Since that is the
same author's repository the choice is yours to make, but it does need making:
without it, nobody else can legally use this, and npm will refuse to publish.
