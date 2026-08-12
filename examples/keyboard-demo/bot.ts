/**
 * Every button and keyboard type this protocol supports, in one bot.
 *
 * Useful as a reference while implementing a client renderer: `/all` produces
 * one message exercising each inline button variant, including the ones that
 * are meant to render disabled.
 */

import {
  Bot,
  InlineKeyboard,
  Keyboard,
  forceReply,
  removeKeyboard,
} from '../../src/index.js';

type Session = {
  /** What `/ask` is waiting for, if anything. */
  awaiting?: 'path';
  counter: number;
};

const bot = new Bot<Session>({
  homeserverUrl: process.env.MATRIX_HOMESERVER!,
  userId: process.env.MATRIX_USER_ID!,
  ...(process.env.MATRIX_ACCESS_TOKEN ? { accessToken: process.env.MATRIX_ACCESS_TOKEN } : {}),
  ...(process.env.MATRIX_PASSWORD ? { password: process.env.MATRIX_PASSWORD } : {}),
  access: { ownerUserId: process.env.MATRIX_OWNER! },
  session: { initial: () => ({ counter: 0 }) },
});

await bot.setMyProfile({
  name: 'Keyboard Demo',
  short_description: 'Shows every button type',
});

await bot.setMyCommands([
  { command: 'start', description: 'Where to begin' },
  { command: 'all', description: 'Every inline button type at once' },
  { command: 'counter', description: 'A keyboard that edits itself' },
  { command: 'confirm', description: 'A destructive action with a danger button' },
  { command: 'quick', description: 'Show the quick-reply keyboard' },
  { command: 'hide', description: 'Remove the quick-reply keyboard' },
  { command: 'ask', description: 'Force-reply prompt for free text' },
]);

await bot.setChatMenuButton({ type: 'commands' });

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Try `/all`, `/counter`, `/confirm`, `/quick` or `/ask`.\n\n' +
      'On a client without button support every one of these still works — ' +
      'reply with the number shown in brackets.'
  );
});

bot.command('all', async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text('Callback', 'demo:callback')
    .primary('Primary', 'demo:primary')
    .danger('Danger', 'demo:danger')
    .row()
    .url('URL button', 'https://prinny.app')
    .copyText('Copy a token', 'tok_1234567890')
    .row()
    .switchInlineCurrent('Prefill the composer', '/counter')
    .build();

  // Hand-built, because the builder refuses to construct buttons a client
  // will render disabled — which is exactly what this row is demonstrating.
  keyboard.inline_keyboard.push([
    { text: 'Unsupported (renders disabled)' },
    { text: 'Ambiguous (renders disabled)', callback_data: 'x', url: 'https://prinny.app' },
  ]);

  await ctx.reply('Every inline button type:', { reply_markup: keyboard });
});

const counterKeyboard = (value: number) =>
  new InlineKeyboard()
    .text('-1', 'counter:dec')
    .text(String(value), 'counter:show')
    .text('+1', 'counter:inc')
    .row()
    .danger('Reset', 'counter:reset')
    .build();

bot.command('counter', async (ctx) => {
  await ctx.reply('Counter:', { reply_markup: counterKeyboard(ctx.session.counter) });
});

bot.callbackQuery(/^counter:(inc|dec|reset|show)$/, async (ctx) => {
  const action = ctx.match?.[1];
  const session = ctx.session;

  if (action === 'inc') session.counter += 1;
  if (action === 'dec') session.counter -= 1;
  if (action === 'reset') session.counter = 0;
  ctx.session = session;

  await ctx.answerCallbackQuery({ text: action === 'show' ? `It is ${session.counter}` : undefined });
  // Swapping just the markup keeps the text, which is what makes a counter
  // feel live rather than spamming a new message per press.
  await ctx.editMessageReplyMarkup(counterKeyboard(session.counter));
});

bot.command('confirm', async (ctx) => {
  await ctx.reply('Delete everything?', {
    reply_markup: new InlineKeyboard()
      .danger('Delete', 'confirm:yes')
      .text('Cancel', 'confirm:no')
      .build(),
  });
});

bot.callbackQuery(/^confirm:(yes|no)$/, async (ctx) => {
  const confirmed = ctx.match?.[1] === 'yes';
  await ctx.answerCallbackQuery({
    text: confirmed ? 'Nothing was deleted — this is a demo.' : 'Cancelled',
    show_alert: confirmed,
  });
  // Retire the keyboard so the prompt cannot be answered twice.
  await ctx.editMessageText(confirmed ? 'Confirmed.' : 'Cancelled.');
});

bot.command('quick', async (ctx) => {
  await ctx.reply('Quick replies are up. Press one — it sends as an ordinary message.', {
    reply_markup: new Keyboard()
      .text('Status')
      .text('Help')
      .row()
      .text('Hide keyboard')
      .resized()
      .placeholder('Pick an action'),
  });
});

bot.hears('Hide keyboard', async (ctx) => {
  await ctx.reply('Keyboard removed.', { reply_markup: removeKeyboard() });
});

bot.command('hide', async (ctx) => {
  await ctx.reply('Keyboard removed.', { reply_markup: removeKeyboard() });
});

bot.command('ask', async (ctx) => {
  ctx.session = { ...ctx.session, awaiting: 'path' };
  await ctx.reply('Which path should I use?', {
    reply_markup: forceReply({ placeholder: 'e.g. /srv/app' }),
  });
});

bot.on('message:text', async (ctx) => {
  if (ctx.command || ctx.session.awaiting !== 'path') return;
  const answer = ctx.text;
  ctx.session = { ...ctx.session, awaiting: undefined };
  await ctx.reply(`Got it: \`${answer}\``);
});

bot.catch((error, ctx) => {
  console.error(`handler failed in ${ctx.roomId}:`, error);
});

await bot.start();
