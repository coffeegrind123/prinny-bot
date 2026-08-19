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
| `sendPhoto` / `sendDocument` / `sendAudio` / `sendVideo` / `sendVoice` / `sendSticker` | same names on `bot.api`, or `ctx.replyWithPhoto(...)` and friends |
| `getFile` + download | `ctx.download()`, `ctx.attachment` |
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

## Attachments

```ts
await ctx.replyWithPhoto({ path: '/tmp/chart.png' }, { caption: 'Last week' });
await ctx.replyWithDocument({ data: buffer, filename: 'report.pdf' });

const file = await ctx.download();   // decrypted, whatever the room
```

Uploads are encrypted automatically in an encrypted room and downloads are
decrypted on the way in, so no handler needs to know which kind of room it is
in. The EncryptedFile crypto (AES-256-CTR, SHA-256 over the ciphertext,
verified *before* decrypting) is implemented against the spec with
`node:crypto` — no extra dependency.

Two details that are easy to skip and visible when you do:

- **Images carry `info.w`/`info.h`.** Clients use them to reserve layout space
  before the bytes arrive; without them the timeline jumps when the image
  loads. Dimensions are read straight out of the PNG/GIF/JPEG/WebP header, so
  this costs no image library.
- **Voice messages carry the MSC3245 marker and an MSC1767 waveform.** Without
  the marker a client renders a generic audio attachment instead of a voice
  bubble. Pass decoded PCM and `sendVoice` computes the duration and waveform;
  `audioToPcm` will decode OGG/Opus for you if ffmpeg is on PATH.

**Transcription is not included.** openclaude's voice pipeline installs a Python
venv and downloads a faster-whisper model on first use, which has no business
inside a chat library. `Transcriber` is the one-method interface to plug an
engine into, and `transcribeAudio()` handles the decode and the failure
reporting around it.

## Progress reactions

```ts
await ctx.withReactions(() => runLongJob());   // ⏳ then ✅ or ❌
```

On the triggering message, so unlike a typing indicator it survives a restart
and stays in scrollback. The `finally` is inside `withReactions`, because
remembering to clear ⏳ at every throw site is how a spinner ends up stuck on
someone's message permanently.

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

## Discord-compatible webhooks

`@prinny/bot/webhook` serves Discord's Webhook API, at Discord's paths, with
Discord's request and response bodies — backed by Matrix. Anything already
posting to `https://discord.com/api/webhooks/{id}/{token}` works against it by
changing the host and nothing else.

```ts
import { Bot } from '@prinny/bot';
import { FileWebhookStore, WebhookServer } from '@prinny/bot/webhook';

const bot = new Bot({ /* … */ });
await bot.start();

const webhooks = new WebhookServer({
  client: bot.matrixClient,
  store: new FileWebhookStore('./webhooks.json'),
  authTokens: [process.env.WEBHOOK_ADMIN_TOKEN!],
  publicUrl: 'https://prinny.example',
});

// A Matrix room can be addressed directly — no registration step.
const channel = webhooks.registerChannel('!room:example.org', { name: 'ci' });
await webhooks.listen(8080);
```

Then, from anywhere:

```bash
curl -X POST "https://prinny.example/api/webhooks/$ID/$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"username":"CI","content":"Build **passed** on `main`"}'
```

### What is implemented

| Endpoint | Notes |
|---|---|
| `POST /channels/{channel}/webhooks` | `channel` may be a channel id or a Matrix room id |
| `GET /channels/{channel}/webhooks` | |
| `GET /guilds/{guild}/webhooks` | guild = Matrix space |
| `GET`/`PATCH`/`DELETE` `/webhooks/{id}` | bot-token authenticated |
| `GET`/`PATCH`/`DELETE` `/webhooks/{id}/{token}` | token authenticated, no user returned |
| `POST /webhooks/{id}/{token}` | Execute — `wait`, `thread_id`, `with_components` |
| `POST /webhooks/{id}/{token}/slack` | Slack incoming-webhook payloads |
| `POST /webhooks/{id}/{token}/github` | 18 GitHub events, rendered as embeds |
| `GET`/`PATCH`/`DELETE` `/webhooks/{id}/{token}/messages/{id}` | edit is an `m.replace` |

`content`, `embeds`, `components`, `poll`, `files[n]` + `payload_json`,
`attachments`, `allowed_mentions`, `flags`, `username`, `avatar_url`,
`thread_name` and `applied_tags` are all read. The `/api` and `/v10` path
prefixes are optional, as on Discord.

### How Discord concepts land on Matrix

| Discord | Matrix |
|---|---|
| guild | space |
| channel | room |
| message | event |
| embed | `<blockquote>` with a `<font color>` accent |
| components (buttons) | `app.prinny.bot.reply_markup` inline keyboard |
| select menu | one button per option, same callback |
| poll | MSC3381 `m.poll.start` |
| `username` / `avatar_url` | `in.prinny.webhook`, rendered by the Prinny client |
| `thread_id` / `thread_name` | `m.thread` relation |
| `@everyone` | `@room`, only when `allowed_mentions` permits it |

Ids handed out are real snowflakes, minted and mapped in the store — a Matrix
room id is not a snowflake, and clients that sort or timestamp ids would break
on one.

### Deliberate differences

These are the only places the two APIs do not agree, and each is a decision
rather than a gap:

- **No `allowed_mentions` means no mentions.** Discord's default is to parse
  everything in the content; Matrix pushes on `m.mentions`, so that default
  would notify every user a webhook happened to name. Send `allowed_mentions`
  explicitly — which is Discord's own guidance anyway.
- **`tts` is ignored.** Matrix has no text-to-speech flag.
- **Embed images are linked, not embedded.** An embed image is an arbitrary
  remote URL; rendering it would leak every reader's IP address to whoever holds
  the webhook token. The same rule applies to `avatar_url`, where only `mxc://`
  is honoured.
- **Management endpoints need a bot token from `authTokens`.** There is no
  Discord permission model here, so holding one of those tokens *is*
  MANAGE_WEBHOOKS. With none configured, every management route is closed — an
  unauthenticated Create Webhook would let anyone post into any room the bot is
  in.

### Webhook events (the outgoing direction)

The same module signs, sends, verifies and acknowledges Discord's webhook
events — Ed25519, the `PING` handshake, and the documented retry policy.

```ts
import {
  deliverWebhookEvent,
  handleWebhookEventRequest,
} from '@prinny/bot/webhook';

// Receiving: verify FIRST, parse second. Discord probes endpoints with
// deliberately invalid signatures and removes any URL that accepts one.
const result = handleWebhookEventRequest({
  publicKey,
  signature: req.headers['x-signature-ed25519'],
  timestamp: req.headers['x-signature-timestamp'],
  body: rawBody,
});
res.writeHead(result.status).end();

// Sending: retries 5xx and network failures with doubling backoff for ten
// minutes, and gives up on a 4xx immediately — that will not become a 2xx.
await deliverWebhookEvent(payload, { url, privateKey });
```

## Examples

- [`examples/echo`](examples/echo) — the smallest useful bot
- [`examples/keyboard-demo`](examples/keyboard-demo) — every button and keyboard
  type, including the ones meant to render disabled
- [`examples/media`](examples/media) — sending and reading attachments, and
  voice messages
- [`examples/agent`](examples/agent) — long-running turns, progress reactions,
  and a question asked as buttons
- [`examples/webhook`](examples/webhook) — a Discord-compatible webhook server
  in front of a Matrix room

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

MIT. See [LICENSE](LICENSE).

The Matrix internals are ported from
[openclaude](https://github.com/coffeegrind123/openclaude) by the same author.
