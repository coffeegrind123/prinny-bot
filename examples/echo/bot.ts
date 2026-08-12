/**
 * The smallest useful bot: a command menu, one keyboard, one callback.
 *
 * Run it:
 *
 *   MATRIX_HOMESERVER=https://matrix.example.org \
 *   MATRIX_USER_ID=@echo:example.org \
 *   MATRIX_PASSWORD=hunter2 \
 *   MATRIX_OWNER=@you:example.org \
 *   npx tsx examples/echo/bot.ts
 *
 * Pass a password on first run so the bot can bootstrap cross-signing — see
 * `Bot.ensureCrossSigning` for why skipping that makes the bot look broken in
 * encrypted rooms.
 */

import { Bot, InlineKeyboard } from '../../src/index.js';

const bot = new Bot({
  homeserverUrl: process.env.MATRIX_HOMESERVER!,
  userId: process.env.MATRIX_USER_ID!,
  ...(process.env.MATRIX_ACCESS_TOKEN ? { accessToken: process.env.MATRIX_ACCESS_TOKEN } : {}),
  ...(process.env.MATRIX_PASSWORD ? { password: process.env.MATRIX_PASSWORD } : {}),
  access: { ownerUserId: process.env.MATRIX_OWNER! },
  onCredentials: ({ accessToken, deviceId }) => {
    // Store these and skip the password next time.
    console.log(`MATRIX_ACCESS_TOKEN=${accessToken}`);
    console.log(`MATRIX_DEVICE_ID=${deviceId ?? ''}`);
  },
});

await bot.setMyProfile({
  name: 'Echo',
  short_description: 'Repeats what you say',
  description: 'A demonstration bot. Send it anything and it says it back.',
});

// This is the setMyCommands equivalent. Prinny merges these into its slash
// command autocomplete; other clients ignore them.
await bot.setMyCommands([
  { command: 'start', description: 'Say hello' },
  { command: 'help', description: 'List commands' },
  { command: 'shout', description: 'Echo in capitals', args: '<text>' },
]);

bot.command('start', async (ctx) => {
  await ctx.reply(`Hello ${ctx.fromName}. Send me anything and I will repeat it.`, {
    reply_markup: new InlineKeyboard().text('Show commands', 'help'),
  });
});

// One handler, two entry points: the button above and the typed command both
// land here, and so does a plain "1" from a user on a client with no buttons.
bot.command('help', async (ctx) => ctx.reply(bot.registry.renderHelp()));
bot.callbackQuery('help', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(bot.registry.renderHelp());
});

bot.command('shout', async (ctx) => {
  const text = ctx.command?.args ?? '';
  await ctx.reply(text ? text.toUpperCase() : 'Give me something to shout.');
});

// Anything that is not a command.
bot.on('message:text', async (ctx) => {
  if (ctx.command) return;
  await ctx.reply(ctx.text);
});

bot.catch((error, ctx) => {
  console.error(`handler failed in ${ctx.roomId}:`, error);
});

await bot.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void bot.stop().then(() => process.exit(0));
  });
}
