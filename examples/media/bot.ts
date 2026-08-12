/**
 * Attachments: sending files, receiving them, and voice messages.
 *
 * Everything here works identically in an encrypted room — `uploadAttachment`
 * encrypts before upload and `download` decrypts after, so no handler below
 * has to know which kind of room it is in.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  Bot,
  InlineKeyboard,
  audioToPcm,
  computeWaveform,
  hasFfmpeg,
  imageDimensions,
  pcmDurationMs,
  sniffMime,
} from '../../src/index.js';

const bot = new Bot({
  homeserverUrl: process.env.MATRIX_HOMESERVER!,
  userId: process.env.MATRIX_USER_ID!,
  ...(process.env.MATRIX_ACCESS_TOKEN ? { accessToken: process.env.MATRIX_ACCESS_TOKEN } : {}),
  ...(process.env.MATRIX_PASSWORD ? { password: process.env.MATRIX_PASSWORD } : {}),
  access: { ownerUserId: process.env.MATRIX_OWNER! },
});

await bot.setMyProfile({ name: 'Media', short_description: 'Sends and reads attachments' });

await bot.setMyCommands([
  { command: 'send', description: 'Send a file from disk', args: '<path>' },
  { command: 'photo', description: 'Send an image from disk', args: '<path>' },
  { command: 'voice', description: 'Send an audio file as a voice message', args: '<path>' },
  { command: 'info', description: 'Describe the attachment you reply to' },
]);

// ── Sending ─────────────────────────────────────────────────────────────────

bot.command('send', async (ctx) => {
  const path = ctx.command?.args;
  if (!path) {
    await ctx.reply('Give me a path: `/send /var/log/syslog`');
    return;
  }
  // `{ path }` reads the file for you; `{ data, filename }` if you have bytes.
  await ctx.replyWithDocument({ path }, { caption: `Here is \`${basename(path)}\`.` });
});

bot.command('photo', async (ctx) => {
  const path = ctx.command?.args;
  if (!path) {
    await ctx.reply('Give me a path to an image.');
    return;
  }
  // Dimensions are read from the file header and sent as info.w/h, so the
  // timeline reserves the right space instead of jumping when it loads.
  await ctx.replyWithPhoto(
    { path },
    {
      caption: 'Rate it',
      reply_markup: new InlineKeyboard().text('👍', 'rate:up').text('👎', 'rate:down'),
    }
  );
});

bot.callbackQuery(/^rate:(up|down)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: ctx.match?.[1] === 'up' ? 'Glad you like it' : 'Noted' });
  await ctx.editMessageReplyMarkup();
});

bot.command('voice', async (ctx) => {
  const path = ctx.command?.args;
  if (!path) {
    await ctx.reply('Give me a path to an audio file.');
    return;
  }

  const data = readFileSync(path);

  // The waveform and duration are what make a client draw a voice bubble with
  // real bars. They need decoded PCM, which needs ffmpeg — so without it, send
  // the file as a voice message anyway rather than not at all.
  if (await hasFfmpeg()) {
    const pcm = await audioToPcm(data);
    await ctx.replyWithVoice(
      { data, filename: basename(path) },
      { voice: { duration: pcmDurationMs(pcm), waveform: computeWaveform(pcm) } }
    );
  } else {
    await ctx.replyWithVoice({ data, filename: basename(path) });
    await ctx.notify('Sent without a waveform — no ffmpeg on PATH to measure the audio.');
  }
});

// ── Receiving ───────────────────────────────────────────────────────────────

bot.command('info', async (ctx) => {
  const attachment = ctx.attachment;
  if (!attachment) {
    await ctx.reply('Reply to a message with an attachment, or send me one directly.');
    return;
  }
  const file = await ctx.download();
  await ctx.reply(
    [
      `**${file.filename}**`,
      `type: \`${file.mimeType}\``,
      `size: ${file.data.length} bytes`,
      attachment.file ? 'encrypted: yes (decrypted on the way in)' : 'encrypted: no',
    ].join('\n')
  );
});

// Anything sent as an image gets measured and described.
bot.on('message:image', async (ctx) => {
  const file = await ctx.download();
  const dimensions = imageDimensions(file.data);
  await ctx.replyTo(
    dimensions
      ? `${file.filename} — ${dimensions.w}x${dimensions.h}, ${sniffMime(file.data) ?? file.mimeType}`
      : `${file.filename} — ${file.data.length} bytes, format not recognised`
  );
});

bot.on('message:audio', async (ctx) => {
  if (!ctx.isVoiceMessage) {
    await ctx.replyTo('That is an audio file rather than a voice message.');
    return;
  }
  // Progress reactions rather than a typing indicator: transcription can take
  // a while, and ⏳ on the message survives a restart and stays in scrollback.
  await ctx.withReactions(async () => {
    const file = await ctx.download();
    if (!(await hasFfmpeg())) {
      await ctx.replyTo('I need ffmpeg on PATH to decode voice messages.');
      return;
    }
    const pcm = await audioToPcm(file.data);
    // A real bot would hand `pcm` to a Transcriber here. See the voice module:
    // the engine itself is deliberately the application's to choose.
    await ctx.replyTo(`Voice message: ${(pcmDurationMs(pcm) / 1000).toFixed(1)}s of audio.`);
  });
});

bot.catch((error, ctx) => {
  console.error(`handler failed in ${ctx.roomId}:`, error);
});

await bot.start();
