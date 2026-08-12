/**
 * An agent bot: long-running turns, live status, and questions asked as real
 * buttons.
 *
 * This is the shape openclaude's Matrix bot takes on top of this framework.
 * The agent itself is stubbed behind `runAgentTurn` — swap that one function
 * for a call into your engine and the rest stands.
 *
 * The interesting part is `askUser`. openclaude currently renders an
 * `AskUserQuestion` as a numbered list and then regex-matches whatever the
 * user types back (`src/services/matrix/askUserParse.ts`). With this schema the
 * options are buttons, and the fallback listing means the regex path still
 * exists for clients without them — it just is not the only path any more.
 */

import {
  Bot,
  InlineKeyboard,
  removeKeyboard,
  type Context,
} from '../../src/index.js';

type Session = {
  cwd: string;
  model: string;
  busy: boolean;
};

const bot = new Bot<Session>({
  homeserverUrl: process.env.MATRIX_HOMESERVER!,
  userId: process.env.MATRIX_USER_ID!,
  ...(process.env.MATRIX_ACCESS_TOKEN ? { accessToken: process.env.MATRIX_ACCESS_TOKEN } : {}),
  ...(process.env.MATRIX_PASSWORD ? { password: process.env.MATRIX_PASSWORD } : {}),
  access: { ownerUserId: process.env.MATRIX_OWNER! },
  session: { initial: () => ({ cwd: process.cwd(), model: 'default', busy: false }) },
});

await bot.setMyProfile({
  name: 'Agent',
  short_description: 'Runs an agent session in this room',
  description: 'Send a message to start a turn. Use /stop to interrupt one.',
  privacy_mode: true,
});

await bot.setMyCommands([
  { command: 'start', description: 'Greet and show the current session' },
  { command: 'help', description: 'List commands' },
  { command: 'status', description: 'Show session, cwd and model' },
  { command: 'stop', description: 'Interrupt the running turn' },
  { command: 'clear', description: 'Reset this conversation' },
  { command: 'cwd', description: 'Change the working directory', args: '<path>' },
  { command: 'model', description: 'Switch model', args: '<name>' },
]);

// ── The bit worth copying: a question, asked as buttons ──────────────────────

type Question = {
  question: string;
  options: Array<{ label: string; description?: string }>;
};

/** Answers still in flight, keyed by the room they were asked in. */
const pendingAnswers = new Map<string, (answer: string) => void>();

/**
 * Ask the user to pick an option, and wait.
 *
 * The returned promise settles from either direction: a button press, or a
 * plain "1" from someone on a client with no buttons — the framework resolves
 * that against the keyboard and delivers it to the same callback handler.
 *
 * A timeout is deliberate. An agent turn blocked forever on a question nobody
 * is going to answer is worse than one that picks the first option and says so.
 */
const askUser = async (
  ctx: Context<Session>,
  question: Question,
  timeoutMs = 5 * 60_000
): Promise<string> => {
  const keyboard = new InlineKeyboard();
  question.options.forEach((option, index) => {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(option.label, `ask:${index}`);
  });

  const described = question.options
    .map((option) => (option.description ? `**${option.label}** — ${option.description}` : null))
    .filter(Boolean)
    .join('\n');

  await ctx.reply(`**${question.question}**${described ? `\n\n${described}` : ''}`, {
    reply_markup: keyboard,
  });

  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      pendingAnswers.delete(ctx.roomId);
      resolve(question.options[0]?.label ?? '');
    }, timeoutMs);

    pendingAnswers.set(ctx.roomId, (answer) => {
      clearTimeout(timer);
      pendingAnswers.delete(ctx.roomId);
      resolve(answer);
    });
  });
};

bot.callbackQuery(/^ask:(\d+)$/, async (ctx) => {
  const resolve = pendingAnswers.get(ctx.roomId);
  const index = Number.parseInt(ctx.match?.[1] ?? '', 10);
  const label = ctx.callbackQuery?.message.reply_markup;

  await ctx.answerCallbackQuery({ text: 'Got it' });
  // Retire the keyboard so the question cannot be answered twice.
  await ctx.editMessageReplyMarkup();

  if (!resolve) return;
  // Read the label off the keyboard rather than trusting the index against a
  // list that may have changed since the question was asked.
  const flat =
    label && 'inline_keyboard' in label ? label.inline_keyboard.flat() : [];
  resolve(flat[index]?.text ?? String(index));
});

// ── Commands ────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  await ctx.reply(
    `Ready. Working in \`${ctx.session.cwd}\` on \`${ctx.session.model}\`.\n\n` +
      'Send a message to start a turn.'
  );
});

bot.command('help', async (ctx) => ctx.reply(bot.registry.renderHelp()));

bot.command('status', async (ctx) => {
  const { cwd, model, busy } = ctx.session;
  await ctx.reply(
    [`**cwd** \`${cwd}\``, `**model** \`${model}\``, `**state** ${busy ? 'running' : 'idle'}`].join(
      '\n'
    )
  );
});

bot.command('cwd', async (ctx) => {
  const path = ctx.command?.args ?? '';
  if (!path) {
    await ctx.reply(`Working directory is \`${ctx.session.cwd}\`.`);
    return;
  }
  ctx.session = { ...ctx.session, cwd: path };
  await ctx.reply(`Working directory is now \`${path}\`.`);
});

bot.command('model', async (ctx) => {
  const model = ctx.command?.args ?? '';
  if (!model) {
    await ctx.reply(`Model is \`${ctx.session.model}\`.`);
    return;
  }
  ctx.session = { ...ctx.session, model };
  await ctx.reply(`Model is now \`${model}\`.`);
});

bot.command('stop', async (ctx) => {
  if (!ctx.session.busy) {
    await ctx.reply('Nothing is running.');
    return;
  }
  ctx.session = { ...ctx.session, busy: false };
  await ctx.reply('Interrupted.', { reply_markup: removeKeyboard() });
});

bot.command('clear', async (ctx) => {
  ctx.session = { cwd: process.cwd(), model: 'default', busy: false };
  await ctx.reply('Conversation reset.', { reply_markup: removeKeyboard() });
});

// ── Turns ───────────────────────────────────────────────────────────────────

/** Stand-in for the real engine. */
const runAgentTurn = async (
  ctx: Context<Session>,
  input: string
): Promise<string> => {
  // A real turn would stream here; this shows the question round trip, which
  // is the part that is genuinely different from a Telegram bot.
  if (input.toLowerCase().includes('deploy')) {
    const choice = await askUser(ctx, {
      question: 'Which environment?',
      options: [
        { label: 'staging', description: 'Safe, resets nightly' },
        { label: 'production', description: 'Real users' },
      ],
    });
    return `Would deploy to **${choice}**.`;
  }
  return `Echoing: ${input}`;
};

bot.on('message:text', async (ctx) => {
  if (ctx.command) return;

  // A plain message while a question is open is an answer to it, not a new
  // turn. The framework already converted a recognised "1" into a callback, so
  // anything reaching here is free text the user typed instead of choosing.
  const waiting = pendingAnswers.get(ctx.roomId);
  if (waiting) {
    waiting(ctx.text);
    return;
  }

  if (ctx.session.busy) {
    await ctx.reply('Still working on the last message. `/stop` to interrupt.');
    return;
  }

  ctx.session = { ...ctx.session, busy: true };
  try {
    const reply = await ctx.withTyping(() => runAgentTurn(ctx, ctx.text));
    await ctx.reply(reply);
  } finally {
    ctx.session = { ...ctx.session, busy: false };
  }
});

bot.catch(async (error, ctx) => {
  console.error(`turn failed in ${ctx.roomId}:`, error);
  await ctx.reply('That turn failed. Check the bot log.').catch(() => undefined);
});

await bot.start();
