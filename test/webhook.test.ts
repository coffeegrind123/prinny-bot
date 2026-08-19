import { describe, expect, it } from 'vitest';
import { SnowflakeGenerator, isSnowflake, snowflakeTimestamp } from '../src/webhook/snowflake.js';
import { parseBoundary, parseMultipart } from '../src/webhook/multipart.js';
import {
  buildMentions,
  everyoneAllowed,
  renderComponents,
  renderDiscordText,
  renderEmbed,
  renderPoll,
} from '../src/webhook/render.js';
import { slackToExecuteBody } from '../src/webhook/slack.js';
import { githubToExecuteBody } from '../src/webhook/github.js';
import { ButtonStyle, ComponentType, MessageFlags } from '../src/webhook/types.js';
import { MemoryWebhookStore } from '../src/webhook/store.js';

describe('snowflake', () => {
  it('mints decimal ids that carry their timestamp', () => {
    const gen = new SnowflakeGenerator({ workerId: 1, processId: 2 });
    const id = gen.next(1700000000000);
    expect(isSnowflake(id)).toBe(true);
    expect(snowflakeTimestamp(id)).toBe(1700000000000);
  });

  it('stays strictly increasing within one millisecond', () => {
    const gen = new SnowflakeGenerator();
    const ids = Array.from({ length: 50 }, () => gen.next(1700000000000));
    const sorted = [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not go backwards when the clock does', () => {
    const gen = new SnowflakeGenerator();
    const first = gen.next(1700000000000);
    const second = gen.next(1699999999000);
    expect(BigInt(second) > BigInt(first)).toBe(true);
  });
});

describe('multipart', () => {
  const boundary = 'abc123';

  const build = (parts: Array<{ headers: string; body: Buffer }>): Buffer =>
    Buffer.concat([
      ...parts.map((part) =>
        Buffer.concat([
          Buffer.from(`--${boundary}\r\n${part.headers}\r\n\r\n`),
          part.body,
          Buffer.from('\r\n'),
        ])
      ),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

  it('reads the boundary out of the content type', () => {
    expect(parseBoundary('multipart/form-data; boundary=abc123')).toBe('abc123');
    expect(parseBoundary('multipart/form-data; boundary="a b c"')).toBe('a b c');
    expect(parseBoundary('application/json')).toBeNull();
  });

  it('keeps binary part bodies byte-exact', () => {
    // Bytes that are not valid UTF-8: a string round trip would replace these.
    const binary = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const body = build([
      { headers: 'Content-Disposition: form-data; name="payload_json"', body: Buffer.from('{"content":"hi"}') },
      {
        headers:
          'Content-Disposition: form-data; name="files[0]"; filename="a.jpg"\r\nContent-Type: image/jpeg',
        body: binary,
      },
    ]);

    const fields = parseMultipart(body, boundary);
    expect(fields).toHaveLength(2);
    expect(fields[0]?.data.toString()).toBe('{"content":"hi"}');
    expect(fields[1]?.filename).toBe('a.jpg');
    expect(fields[1]?.contentType).toBe('image/jpeg');
    expect(Buffer.compare(fields[1]?.data ?? Buffer.alloc(0), binary)).toBe(0);
  });

  it('does not append the boundary CRLF to a part body', () => {
    const body = build([
      { headers: 'Content-Disposition: form-data; name="f"; filename="x.bin"', body: Buffer.from([1, 2, 3]) },
    ]);
    expect(parseMultipart(body, boundary)[0]?.data.length).toBe(3);
  });
});

describe('discord text', () => {
  it('renders Discord-only syntax that markdown does not have', () => {
    const { html } = renderDiscordText('||secret|| and __underlined__');
    expect(html).toContain('data-mx-spoiler');
    expect(html).toContain('<u>underlined</u>');
  });

  it('leaves Discord syntax alone inside code', () => {
    const { html } = renderDiscordText('`||not a spoiler||` and ```\n<@123>\n```');
    expect(html).not.toContain('data-mx-spoiler');
    expect(html).toContain('&lt;@123&gt;');
  });

  it('resolves user mentions to matrix.to pills when the user is known', () => {
    const { html } = renderDiscordText('hi <@123>', {
      resolveUser: () => ({ userId: '@bob:example.org', displayName: 'Bob' }),
    });
    expect(html).toContain('https://matrix.to/#/%40bob%3Aexample.org');
    expect(html).toContain('Bob');
  });

  it('leaves an unresolved mention readable rather than raw', () => {
    const { html } = renderDiscordText('hi <@123>');
    expect(html).not.toContain('<@123>');
    expect(html).toContain('@unknown-user');
  });

  it('only turns @everyone into @room when the payload allows it', () => {
    expect(renderDiscordText('@everyone', {}, { allowEveryone: false }).text).toContain('@everyone');
    expect(renderDiscordText('@everyone', {}, { allowEveryone: true }).text).toContain('@room');
  });

  it('resolves timestamps to text', () => {
    const { text } = renderDiscordText('<t:1700000000:D>', {}, { now: 1700000000000 });
    expect(text).toContain('2023');
  });

  it('cannot be made to emit markup by writing it', () => {
    const { html } = renderDiscordText('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('embeds', () => {
  it('carries title, fields, colour and footer', () => {
    const { html, text } = renderEmbed({
      title: 'Build failed',
      url: 'https://ci.example/1',
      description: 'Step 3 exited 1',
      color: 0xff0000,
      fields: [{ name: 'Branch', value: 'main' }],
      footer: { text: 'CI' },
    });
    expect(html).toContain('<blockquote>');
    expect(html).toContain('color="#ff0000"');
    expect(html).toContain('https://ci.example/1');
    expect(html).toContain('<b>Branch</b>');
    expect(text).toContain('Build failed');
    expect(text).toContain('Branch: main');
  });

  it('links embed images rather than embedding them', () => {
    const { html } = renderEmbed({ image: { url: 'https://tracker.example/pixel.png' } });
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://tracker.example/pixel.png"');
  });
});

describe('components', () => {
  it('maps action rows onto inline keyboard rows', () => {
    const { markup } = renderComponents([
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Danger, label: 'Stop', custom_id: 'stop' },
          { type: ComponentType.Button, style: ButtonStyle.Link, label: 'Logs', url: 'https://ci' },
        ],
      },
    ]);
    expect(markup?.inline_keyboard).toHaveLength(1);
    expect(markup?.inline_keyboard[0]?.[0]).toEqual({
      text: 'Stop',
      style: 'danger',
      callback_data: 'stop',
    });
    expect(markup?.inline_keyboard[0]?.[1]?.url).toBe('https://ci');
  });

  it('turns select options into buttons carrying the same callback', () => {
    const { markup } = renderComponents([
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: 'env',
            options: [
              { label: 'Prod', value: 'prod' },
              { label: 'Staging', value: 'staging' },
            ],
          },
        ],
      },
    ]);
    expect(markup?.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual([
      'env:prod',
      'env:staging',
    ]);
  });
});

describe('mentions', () => {
  it('notifies nobody when allowed_mentions is absent', () => {
    expect(buildMentions(undefined, ['@a:x'], undefined)).toEqual({ user_ids: [] });
  });

  it('honours an explicit user list', () => {
    expect(buildMentions({ users: ['@a:x'] }, [], undefined)).toEqual({ user_ids: ['@a:x'] });
  });

  it('marks a room mention only when everyone is parsed', () => {
    expect(buildMentions({ parse: ['everyone'] }, [], undefined).room).toBe(true);
    expect(everyoneAllowed({ parse: ['everyone'] })).toBe(true);
    expect(everyoneAllowed({ parse: ['users'] })).toBe(false);
  });

  it('suppresses everything when the flag says so', () => {
    expect(
      buildMentions({ parse: ['everyone'], users: ['@a:x'] }, [], MessageFlags.SuppressNotifications)
    ).toEqual({ user_ids: [] });
  });
});

describe('polls', () => {
  it('maps a Discord poll onto MSC3381', () => {
    const content = renderPoll({
      question: { text: 'Deploy?' },
      answers: [{ poll_media: { text: 'Yes' } }, { poll_media: { text: 'No' } }],
      allow_multiselect: false,
    });
    const start = content['org.matrix.msc3381.poll.start'] as Record<string, unknown>;
    expect((start.question as Record<string, string>)['org.matrix.msc1767.text']).toBe('Deploy?');
    expect(start.max_selections).toBe(1);
    expect((start.answers as unknown[]).length).toBe(2);
  });
});

describe('slack compatibility', () => {
  it('maps text and attachments onto the native body', () => {
    const body = slackToExecuteBody({
      text: 'Deploy <https://ci.example|finished>',
      username: 'ci',
      attachments: [
        { color: 'good', title: 'v1.2.3', text: 'All green', fields: [{ title: 'env', value: 'prod', short: true }] },
      ],
    });
    expect(body.content).toBe('Deploy [finished](https://ci.example)');
    expect(body.username).toBe('ci');
    expect(body.embeds?.[0]?.color).toBe(0x2eb886);
    expect(body.embeds?.[0]?.fields?.[0]).toEqual({ name: 'env', value: 'prod', inline: true });
  });

  it('caps embeds at the Discord limit rather than being rejected', () => {
    const body = slackToExecuteBody({
      attachments: Array.from({ length: 15 }, (_, i) => ({ text: `a${i}` })),
    });
    expect(body.embeds).toHaveLength(10);
  });
});

describe('github compatibility', () => {
  it('renders a push as an embed', () => {
    const body = githubToExecuteBody('push', {
      ref: 'refs/heads/main',
      compare: 'https://github.com/o/r/compare/a...b',
      repository: { full_name: 'o/r' },
      sender: { login: 'alice', html_url: 'https://github.com/alice' },
      commits: [{ id: 'abcdef1234', message: 'fix thing\n\nbody', url: 'https://github.com/o/r/commit/abcdef1234' }],
    });
    expect(body?.embeds?.[0]?.title).toContain('o/r:main');
    expect(body?.embeds?.[0]?.description).toContain('fix thing');
    expect(body?.embeds?.[0]?.description).not.toContain('body');
  });

  it('says nothing for ping, or for a push with no commits', () => {
    expect(githubToExecuteBody('ping', { zen: 'hi' })).toBeUndefined();
    expect(githubToExecuteBody('push', { commits: [] })).toBeUndefined();
  });
});

describe('store', () => {
  it('drops a webhook messages when the webhook is deleted', () => {
    const store = new MemoryWebhookStore();
    store.putWebhook({
      webhook: {
        id: '1',
        type: 1,
        channel_id: '2',
        name: 'w',
        avatar: null,
        application_id: null,
      },
      roomId: '!r:x',
      token: 't',
      createdAt: 0,
    });
    store.putMessage({
      id: '10',
      webhookId: '1',
      roomId: '!r:x',
      eventId: '$e',
      channelId: '2',
      createdAt: 0,
    });
    expect(store.findMessageByEvent('$e')?.id).toBe('10');
    store.deleteWebhook('1');
    expect(store.getMessage('10')).toBeUndefined();
  });
});
