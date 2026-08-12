import { describe, expect, it } from 'vitest';
import { CommandRegistry, isCommandForBot, parseCommand } from '../src/commands.js';
import { buildDeepLink, deepLinkStartMessage, parseDeepLink } from '../src/deeplink.js';

describe('parseCommand', () => {
  it('splits the name from its arguments', () => {
    expect(parseCommand('/cwd /srv/app')).toEqual({ name: 'cwd', args: '/srv/app' });
    expect(parseCommand('/start')).toEqual({ name: 'start', args: '' });
  });

  it('lowercases the name, as Telegram does', () => {
    expect(parseCommand('/Start')?.name).toBe('start');
  });

  it('reads Telegram-style @bot addressing', () => {
    expect(parseCommand('/status@helper:example.org now')).toEqual({
      name: 'status',
      args: 'now',
      addressedTo: 'helper:example.org',
    });
  });

  it('keeps multi-line arguments intact', () => {
    // A bot taking a commit message or a patch needs the newlines.
    expect(parseCommand('/note line one\nline two')?.args).toBe('line one\nline two');
  });

  it('ignores things that only look like commands', () => {
    expect(parseCommand('not /a command')).toBeNull();
    expect(parseCommand('//escaped')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/x'.repeat(40))).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('tolerates leading whitespace', () => {
    expect(parseCommand('  /help')?.name).toBe('help');
  });
});

describe('isCommandForBot', () => {
  const bot = '@helper:example.org';

  it('treats an unaddressed command as everyone’s', () => {
    expect(isCommandForBot({ name: 'status', args: '' }, bot)).toBe(true);
  });

  it('accepts the localpart, which is what people actually type', () => {
    expect(isCommandForBot({ name: 'status', args: '', addressedTo: 'helper' }, bot)).toBe(true);
  });

  it('accepts the full MXID with or without the sigil', () => {
    expect(
      isCommandForBot({ name: 'status', args: '', addressedTo: '@helper:example.org' }, bot)
    ).toBe(true);
    expect(
      isCommandForBot({ name: 'status', args: '', addressedTo: 'helper:example.org' }, bot)
    ).toBe(true);
  });

  it('rejects a command aimed at a different bot', () => {
    // Without this, every bot in the room answers the same /status.
    expect(isCommandForBot({ name: 'status', args: '', addressedTo: 'other' }, bot)).toBe(false);
  });
});

describe('CommandRegistry', () => {
  it('publishes commands and hides the hidden ones', () => {
    const registry = new CommandRegistry();
    registry.setCommands([
      { command: 'start', description: 'Greet' },
      { command: 'debug', description: 'Internals', hidden: true },
    ]);

    expect(registry.getCommands().map((c) => c.command)).toEqual(['start']);
    expect(registry.getAllCommands()).toHaveLength(2);
    expect(registry.has('debug')).toBe(true);
  });

  it('normalises a name Telegram would reject', () => {
    const registry = new CommandRegistry();
    registry.setCommands([{ command: 'Think-Back', description: 'x' }]);
    expect(registry.getCommands()[0]?.command).toBe('think_back');
  });

  it('refuses a name with nothing usable in it', () => {
    const registry = new CommandRegistry();
    expect(() => registry.setCommands([{ command: '???', description: 'x' }])).toThrow(
      /not a usable command name/
    );
  });

  it('refuses duplicates rather than letting one shadow the other', () => {
    const registry = new CommandRegistry();
    expect(() =>
      registry.setCommands([
        { command: 'go', description: 'a' },
        { command: 'go', description: 'b' },
      ])
    ).toThrow(/Duplicate command "go"/);
  });

  it('builds the info payload from commands and profile', () => {
    const registry = new CommandRegistry();
    registry.setProfile({ name: 'Helper', short_description: 'Helps' });
    registry.setMenuButton({ type: 'commands' });
    registry.setCommands([{ command: 'go', description: 'Go' }]);

    expect(registry.toBotInfo()).toEqual({
      version: 1,
      name: 'Helper',
      short_description: 'Helps',
      menu_button: { type: 'commands' },
      commands: [{ command: 'go', description: 'Go' }],
    });
  });

  it('omits an empty command list from the payload', () => {
    expect(new CommandRegistry().toBotInfo()).toEqual({ version: 1 });
  });

  it('renders help from the published list, including usage hints', () => {
    const registry = new CommandRegistry();
    registry.setCommands([
      { command: 'cwd', description: 'Change directory', args: '<path>' },
      { command: 'stop', description: 'Interrupt' },
    ]);

    expect(registry.renderHelp()).toBe(
      '`/cwd <path>` — Change directory\n`/stop` — Interrupt'
    );
  });
});

describe('deep links', () => {
  it('round-trips a bot and payload', () => {
    const link = buildDeepLink('@helper:example.org', 'invite_abc');
    expect(link).toBe('https://prinny.app/bot/%40helper%3Aexample.org?start=invite_abc');
    expect(parseDeepLink(link)).toEqual({ userId: '@helper:example.org', payload: 'invite_abc' });
  });

  it('works without a payload', () => {
    const link = buildDeepLink('@helper:example.org');
    expect(parseDeepLink(link)).toEqual({ userId: '@helper:example.org' });
  });

  it('rejects a payload outside Telegram’s character set', () => {
    // The client turns this into a message it sends for the user, so a
    // permissive parser here is a way to put arbitrary text in their mouth.
    expect(() => buildDeepLink('@a:b.org', 'has spaces')).toThrow(/payload/);
    expect(parseDeepLink('https://prinny.app/bot/%40a%3Ab.org?start=has%20spaces')).toBeNull();
  });

  it('rejects a malformed or foreign link', () => {
    expect(parseDeepLink('https://prinny.app/not-a-bot')).toBeNull();
    expect(parseDeepLink('https://prinny.app/bot/not-an-mxid')).toBeNull();
    expect(parseDeepLink('nonsense')).toBeNull();
  });

  it('decodes exactly once, so double encoding cannot smuggle an MXID', () => {
    expect(parseDeepLink('https://prinny.app/bot/%2540a%253Ab.org')).toBeNull();
  });

  it('builds the message the client sends', () => {
    expect(deepLinkStartMessage('abc')).toBe('/start abc');
    expect(deepLinkStartMessage()).toBe('/start');
  });
});
