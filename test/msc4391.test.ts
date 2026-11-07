/**
 * MSC4391: commands published as one state event each, and invocations read
 * from a structured block. gomuks, mautrix-go and others only see a bot's
 * commands through this, so a wrong state key or a malformed description
 * means the commands silently vanish from their menus.
 */

import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { Api, commandStateKey } from '../src/Api.js';
import { CommandRegistry, commandOfMessage } from '../src/commands.js';
import {
  Msc4391,
  argumentsToText,
  buildInvocation,
  describeCommand,
  digestToStateKey,
  invocationTarget,
  roomReferenceToUri,
  sanitizeCommandDescription,
  sanitizeSchema,
  type Msc4391CommandDescription,
} from '../src/protocol/msc4391.js';

const BOT = '@bot:hs';

describe('state key', () => {
  it("matches the proposal's own example", () => {
    // sha256("ban" + "@draupnir:draupnir.space"), padded standard base64
    expect(commandStateKey('ban', '@draupnir:draupnir.space')).toBe(
      'JBDLR6YMe+72yqsEMi/MVdTmjN3ynPThMz+M7QLATZQ='
    );
  });

  it('encodes base64 with padding for every remainder, as Buffer does', () => {
    for (let length = 0; length < 8; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + 250) % 256);
      expect(digestToStateKey(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('describeCommand', () => {
  it('publishes a usage hint as one optional string parameter that takes the whole line', () => {
    expect(describeCommand({ command: 'echo', description: 'Repeat', args: '<text>' })).toEqual({
      command: 'echo',
      description: { 'm.text': [{ body: 'Repeat' }] },
      parameters: [
        {
          key: 'args',
          schema: { schema_type: 'primitive', type: 'string' },
          optional: true,
          description: { 'm.text': [{ body: '<text>' }] },
        },
      ],
      [Msc4391.TailParameter]: 'args',
    });
  });

  it('publishes a command without arguments with no parameters', () => {
    expect(describeCommand({ command: 'ping', description: 'Pong' })).toEqual({
      command: 'ping',
      description: { 'm.text': [{ body: 'Pong' }] },
    });
  });

  it('prefers structured parameters over the hint', () => {
    const description = describeCommand({
      command: 'ban',
      description: 'Ban someone',
      args: '<user> [reason]',
      parameters: [
        { key: 'user', schema: { schema_type: 'primitive', type: 'user_id' } },
        { key: 'reason', schema: { schema_type: 'primitive', type: 'string' }, optional: true },
      ],
    });
    expect(description.parameters?.map((p) => p.key)).toEqual(['user', 'reason']);
    expect(description[Msc4391.TailParameter]).toBeUndefined();
  });
});

describe('sanitizeCommandDescription', () => {
  const valid: Msc4391CommandDescription = {
    command: 'rooms add',
    description: { 'm.text': [{ body: 'Add a room' }] },
    parameters: [
      { key: 'room', schema: { schema_type: 'primitive', type: 'room_id' } },
      {
        key: 'mode',
        schema: {
          schema_type: 'union',
          variants: [
            { schema_type: 'literal', value: 'fast' },
            { schema_type: 'literal', value: 'slow' },
          ],
        },
        optional: true,
      },
      {
        key: 'users',
        schema: {
          schema_type: 'array',
          items: { schema_type: 'primitive', type: 'user_id' },
        },
      },
    ],
  };

  it('keeps a valid description, subcommands included', () => {
    expect(sanitizeCommandDescription(valid)).toEqual(valid);
  });

  it('hides a description with duplicate parameter keys, as the proposal says', () => {
    const duplicated = {
      ...valid,
      parameters: [valid.parameters![0], valid.parameters![0]],
    };
    expect(sanitizeCommandDescription(duplicated)).toBeNull();
  });

  it('treats an emptied description as withdrawn', () => {
    expect(sanitizeCommandDescription({})).toBeNull();
  });

  it('rejects commands with a slash, blank words or control characters', () => {
    for (const command of ['/ban', 'rooms  add', ' ban', '', 'ban‮', 'x'.repeat(129)]) {
      expect(sanitizeCommandDescription({ command })).toBeNull();
    }
  });

  it('rejects schemas the proposal forbids', () => {
    const primitive = { schema_type: 'primitive', type: 'string' };
    // unknown primitive
    expect(sanitizeSchema({ schema_type: 'primitive', type: 'float' })).toBeNull();
    // nested union
    expect(
      sanitizeSchema({
        schema_type: 'union',
        variants: [{ schema_type: 'union', variants: [primitive] }],
      })
    ).toBeNull();
    // union of arrays
    expect(
      sanitizeSchema({
        schema_type: 'union',
        variants: [{ schema_type: 'array', items: primitive }],
      })
    ).toBeNull();
    // array of arrays
    expect(
      sanitizeSchema({ schema_type: 'array', items: { schema_type: 'array', items: primitive } })
    ).toBeNull();
    // literal floats cannot survive canonical JSON
    expect(sanitizeSchema({ schema_type: 'literal', value: 1.5 })).toBeNull();
    expect(sanitizeSchema({ schema_type: 'array', items: primitive })).toEqual({
      schema_type: 'array',
      items: primitive,
    });
  });

  it('keeps the tail parameter only when it names a parameter', () => {
    const withTail = { ...describeCommand({ command: 'echo', description: 'x', args: '<t>' }) };
    expect(sanitizeCommandDescription(withTail)?.[Msc4391.TailParameter]).toBe('args');
    expect(
      sanitizeCommandDescription({ command: 'ping', [Msc4391.TailParameter]: 'args' })?.[
        Msc4391.TailParameter
      ]
    ).toBeUndefined();
  });

  it('reads the plain-text representation of a description and strips bidi overrides', () => {
    const out = sanitizeCommandDescription({
      command: 'ping',
      description: {
        'm.text': [
          { body: '<b>Pong</b>', mimetype: 'text/html' },
          { body: 'Po‮ng' },
        ],
      },
    });
    expect(out?.description).toEqual({ 'm.text': [{ body: 'Pong' }] });
  });
});

describe('invocationTarget', () => {
  const invocation = (mentions: unknown) => ({
    body: 'whatever the client chose',
    ...buildInvocation('ban', { user: '@spam:hs' }),
    ...(mentions === undefined ? {} : { 'm.mentions': mentions }),
  });

  it('is ours when the block mentions this bot', () => {
    expect(invocationTarget(invocation({ user_ids: [BOT] }), BOT)).toEqual({
      kind: 'ours',
      invocation: { command: 'ban', arguments: { user: '@spam:hs' } },
    });
  });

  it("is someone else's when it mentions only other users", () => {
    expect(invocationTarget(invocation({ user_ids: ['@other:hs'] }), BOT)).toEqual({
      kind: 'other',
    });
  });

  it('says nothing without mentions, so the text decides', () => {
    expect(invocationTarget(invocation(undefined), BOT)).toBeNull();
    expect(invocationTarget(invocation({}), BOT)).toBeNull();
  });

  it('ignores a malformed block', () => {
    const base = { 'm.mentions': { user_ids: [BOT] } };
    expect(invocationTarget({ ...base, [Msc4391.Command]: 'ban' }, BOT)).toBeNull();
    expect(invocationTarget({ ...base, [Msc4391.Command]: { command: 7 } }, BOT)).toBeNull();
    expect(
      invocationTarget({ ...base, [Msc4391.Command]: { command: 'ban', arguments: [] } }, BOT)
    ).toBeNull();
  });
});

describe('argumentsToText', () => {
  it('passes the tail parameter through verbatim', () => {
    const description = describeCommand({ command: 'echo', description: 'x', args: '<t>' });
    expect(argumentsToText({ args: 'hello  "world"' }, description)).toBe('hello  "world"');
  });

  it('orders by the declared parameters and quotes earlier strings with spaces', () => {
    const description: Msc4391CommandDescription = {
      command: 'kick',
      parameters: [
        { key: 'user', schema: { schema_type: 'primitive', type: 'user_id' } },
        { key: 'room', schema: { schema_type: 'primitive', type: 'room_id' } },
        { key: 'notify', schema: { schema_type: 'primitive', type: 'boolean' } },
        { key: 'reason', schema: { schema_type: 'primitive', type: 'string' } },
      ],
    };
    expect(
      argumentsToText(
        {
          reason: 'too much spam',
          notify: true,
          room: { type: 'room_id', id: '!abc:hs', via: ['hs', 'other.hs'] },
          user: '@spam:hs',
        },
        description
      )
    ).toBe('@spam:hs matrix:roomid/abc%3Ahs?via=hs&via=other.hs true too much spam');
  });

  it('spreads arrays and keeps values for parameters the bot did not declare', () => {
    expect(argumentsToText({ users: ['@a:hs', 'b c'], count: 3 })).toBe('3 @a:hs b c');
  });

  it('turns event references into matrix: URIs and drops what it cannot read', () => {
    expect(
      roomReferenceToUri({ type: 'event_id', id: '!r:hs', event_id: '$e', via: ['hs'] })
    ).toBe('matrix:roomid/r%3Ahs/e/e?via=hs');
    expect(roomReferenceToUri({ type: 'room_id', id: 'not-a-room' })).toBeNull();
    expect(argumentsToText({ a: { nested: true }, b: 'kept' })).toBe('kept');
  });
});

describe('CommandRegistry and MSC4391', () => {
  it('describes published commands only, and keeps parameters out of app.prinny.bot.info', () => {
    const registry = new CommandRegistry();
    registry.setCommands([
      {
        command: 'ban',
        description: 'Ban',
        parameters: [{ key: 'user', schema: { schema_type: 'primitive', type: 'user_id' } }],
      },
      { command: 'debug', description: 'Debug', hidden: true },
    ]);
    expect(registry.getDescriptions().map((d) => d.command)).toEqual(['ban']);
    expect(registry.toBotInfo().commands).toEqual([{ command: 'ban', description: 'Ban' }]);
  });

  it('refuses parameters the proposal would make clients hide', () => {
    const registry = new CommandRegistry();
    const user = { key: 'user', schema: { schema_type: 'primitive', type: 'user_id' } } as const;
    expect(() =>
      registry.setCommands([{ command: 'ban', description: 'Ban', parameters: [user, user] }])
    ).toThrow(RangeError);
  });
});

describe('commandOfMessage', () => {
  const registry = new CommandRegistry();
  registry.setCommands([
    { command: 'echo', description: 'Repeat', args: '<text>' },
    {
      command: 'ban',
      description: 'Ban',
      parameters: [
        { key: 'user', schema: { schema_type: 'primitive', type: 'user_id' } },
        { key: 'reason', schema: { schema_type: 'primitive', type: 'string' }, optional: true },
      ],
    },
  ]);
  const mentionsBot = { 'm.mentions': { user_ids: [BOT] } };

  it('prefers the structured invocation over the text', () => {
    const match = commandOfMessage(
      {
        body: '!ban spam please',
        ...mentionsBot,
        ...buildInvocation('ban', { user: '@spam:hs', reason: 'spam' }),
      },
      BOT,
      registry
    );
    expect(match).toEqual({
      name: 'ban',
      args: '@spam:hs spam',
      addressedTo: BOT,
      arguments: { user: '@spam:hs', reason: 'spam' },
    });
  });

  it('gives a usage-hint command its line back as args', () => {
    const match = commandOfMessage(
      { body: '/echo hi there', ...mentionsBot, ...buildInvocation('echo', { args: 'hi there' }) },
      BOT,
      registry
    );
    expect(match).toMatchObject({ name: 'echo', args: 'hi there' });
  });

  it("leaves another bot's invocation alone, even when the text looks like ours", () => {
    expect(
      commandOfMessage(
        {
          body: '/echo hi',
          'm.mentions': { user_ids: ['@other:hs'] },
          ...buildInvocation('echo', { args: 'hi' }),
        },
        BOT,
        registry
      )
    ).toBe('other');
  });

  it('falls back to the text without mentions, and for subcommands', () => {
    expect(
      commandOfMessage({ body: '/echo typed', ...buildInvocation('echo') }, BOT, registry)
    ).toMatchObject({ name: 'echo', args: 'typed' });
    expect(
      commandOfMessage(
        { body: '/echo typed', ...mentionsBot, ...buildInvocation('rooms add') },
        BOT,
        registry
      )
    ).toMatchObject({ name: 'echo', args: 'typed' });
  });

  it('keeps the text rules: /cmd@other is not ours, plain text is no command', () => {
    expect(commandOfMessage({ body: '/echo@other hi' }, BOT, registry)).toBe('other');
    expect(commandOfMessage({ body: 'hello' }, BOT, registry)).toBeNull();
  });
});

describe('Api.publishCommandDescriptions', () => {
  type StateEvent = { key: string; sender: string; content: Record<string, unknown> };

  const fakeClient = (state: StateEvent[]) => {
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$1' });
    const client = {
      getUserId: () => BOT,
      getRoom: () => ({
        getLiveTimeline: () => ({
          getState: () => ({
            getStateEvents: (type: string) =>
              type === Msc4391.CommandDescription
                ? state.map((e) => ({
                    getStateKey: () => e.key,
                    getSender: () => e.sender,
                    getContent: () => e.content,
                  }))
                : [],
          }),
        }),
      }),
      sendStateEvent,
    } as unknown as MatrixClient;
    return { client, sendStateEvent };
  };

  const ping = describeCommand({ command: 'ping', description: 'Pong' });
  const echo = describeCommand({ command: 'echo', description: 'Repeat', args: '<text>' });

  it('writes one state event per command, keyed by command and bot', async () => {
    const { client, sendStateEvent } = fakeClient([]);
    const result = await new Api(client).publishCommandDescriptions('!r:hs', [ping, echo]);

    expect(result).toEqual({ sent: 2, unchanged: 0, blanked: 0, ok: true });
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      Msc4391.CommandDescription,
      ping,
      commandStateKey('ping', BOT)
    );
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      Msc4391.CommandDescription,
      echo,
      commandStateKey('echo', BOT)
    );
  });

  it('skips what is already published, whatever order the keys came back in', async () => {
    const reordered = Object.fromEntries(Object.entries(echo).reverse());
    const { client, sendStateEvent } = fakeClient([
      { key: commandStateKey('echo', BOT), sender: BOT, content: reordered },
    ]);
    const result = await new Api(client).publishCommandDescriptions('!r:hs', [echo]);

    expect(result).toEqual({ sent: 0, unchanged: 1, blanked: 0, ok: true });
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it("withdraws its own stale commands, and leaves other bots' and blanked ones alone", async () => {
    const { client, sendStateEvent } = fakeClient([
      { key: commandStateKey('old', BOT), sender: BOT, content: { command: 'old' } },
      { key: commandStateKey('gone', BOT), sender: BOT, content: {} },
      { key: commandStateKey('theirs', '@other:hs'), sender: '@other:hs', content: { command: 'x' } },
    ]);
    const result = await new Api(client).publishCommandDescriptions('!r:hs', [ping]);

    expect(result).toEqual({ sent: 1, unchanged: 0, blanked: 1, ok: true });
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      Msc4391.CommandDescription,
      {},
      commandStateKey('old', BOT)
    );
    expect(sendStateEvent).toHaveBeenCalledTimes(2);
  });

  it('stops at the first refusal', async () => {
    const { client, sendStateEvent } = fakeClient([]);
    sendStateEvent.mockRejectedValue(new Error('M_FORBIDDEN'));
    const result = await new Api(client).publishCommandDescriptions('!r:hs', [ping, echo]);

    expect(result.ok).toBe(false);
    expect(sendStateEvent).toHaveBeenCalledTimes(1);
  });
});
