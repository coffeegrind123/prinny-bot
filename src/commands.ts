/**
 * Slash command parsing and the `setMyCommands` equivalent.
 *
 * Matrix has no server-side place to register a bot's commands, so publishing
 * them means writing an `app.prinny.bot.info` event into each room. `Bot`
 * drives that; this module owns the list and the parsing.
 */

import { Limits, SCHEMA_VERSION } from './protocol/constants.js';
import {
  argumentsToText,
  describeCommand,
  invocationTarget,
  isSingleWordCommand,
  sanitizeCommandDescription,
  type Msc4391CommandDescription,
  type Msc4391Invocation,
  type Msc4391Parameter,
} from './protocol/msc4391.js';
import { plainBodyOf } from './keyboard/fallback.js';
import type { BotCommand, BotInfo, MenuButton } from './protocol/types.js';
import { isValidCommandName, normalizeCommandName } from './protocol/validate.js';
import type { CommandMatch } from './Context.js';

/**
 * Parse a leading slash command out of message text.
 *
 * Accepts Telegram's `/cmd@botname` addressing, which matters in a room with
 * more than one bot: without it, every bot offering `/status` answers at once.
 *
 * Returns `null` for anything that is not a command, including `//escaped`
 * and a bare `/` — both of which people type by accident often enough that
 * treating them as commands is a bug.
 */
export const parseCommand = (text: string): CommandMatch | null => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;

  const match = trimmed.match(/^\/([A-Za-z0-9_]{1,32})(@[^\s]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const name = match[1]!.toLowerCase();
  if (!isValidCommandName(name)) return null;

  const parsed: CommandMatch = { name, args: (match[3] ?? '').trim() };
  if (match[2]) parsed.addressedTo = match[2].slice(1);
  return parsed;
};

/**
 * Whether a command addressed to `addressedTo` is meant for `botUserId`.
 *
 * An unaddressed command is for everyone. An addressed one matches either the
 * full MXID or its localpart, since users type `@bot` far more often than
 * `@bot:example.org`.
 */
export const isCommandForBot = (match: CommandMatch, botUserId: string): boolean => {
  if (!match.addressedTo) return true;
  const target = match.addressedTo.toLowerCase();
  const full = botUserId.toLowerCase();
  const localpart = full.replace(/^@/, '').split(':')[0] ?? '';
  return target === full || target === full.replace(/^@/, '') || target === localpart;
};

/**
 * A structured MSC4391 invocation as a command match, or `null` to fall back
 * to the text. Our commands are single words, so a subcommand ("rooms add")
 * cannot be one of ours and is left to the text parser.
 */
const commandOfInvocation = (
  invocation: Msc4391Invocation,
  botUserId: string,
  registry: CommandRegistry
): CommandMatch | null => {
  if (!isSingleWordCommand(invocation.command)) return null;
  const name = invocation.command.toLowerCase();
  const definition = registry.get(name);
  return {
    name,
    args: argumentsToText(invocation.arguments, definition && describeCommand(definition)),
    addressedTo: botUserId,
    arguments: invocation.arguments,
  };
};

/**
 * The command a message carries for this bot.
 *
 * An MSC4391 invocation that mentions the bot wins over the text, since a
 * client's text form need not match our syntax at all. One that mentions only
 * other users, or a `/cmd@other` text command, is someone else's: `'other'`.
 * `null` means the message is not a command.
 */
export const commandOfMessage = (
  content: Record<string, unknown>,
  botUserId: string,
  registry: CommandRegistry
): CommandMatch | 'other' | null => {
  const structured = invocationTarget(content, botUserId);
  if (structured?.kind === 'other') return 'other';
  if (structured?.kind === 'ours') {
    const invoked = commandOfInvocation(structured.invocation, botUserId, registry);
    if (invoked) return invoked;
  }
  const parsed = parseCommand(plainBodyOf(content));
  if (!parsed) return null;
  return isCommandForBot(parsed, botUserId) ? parsed : 'other';
};

export type CommandDefinition = BotCommand & {
  /** Keep it out of the published list. Telegram has no equivalent. */
  hidden?: boolean;
  /**
   * Typed parameters for clients that speak MSC4391 (gomuks and others), which
   * build a form from them and send the values as structured arguments.
   * Without them, `args` is published as one optional string parameter.
   */
  parameters?: Msc4391Parameter[];
};

/**
 * The bot's advertised identity: name, descriptions, commands, menu button.
 *
 * Mutable, because `setMyCommands` is a runtime call — openclaude's bot, for
 * one, rebuilds its command list whenever the working directory changes and
 * a different set of project commands becomes available.
 */
export class CommandRegistry {
  private commands: CommandDefinition[] = [];

  private profile: Omit<BotInfo, 'version' | 'commands'> = {};

  /** Telegram's `setMyCommands`. Replaces the whole list. */
  setCommands(commands: CommandDefinition[]): void {
    const seen = new Set<string>();
    const accepted: CommandDefinition[] = [];

    for (const command of commands) {
      const name = isValidCommandName(command.command)
        ? command.command
        : normalizeCommandName(command.command);
      if (!name) {
        throw new RangeError(
          `"${command.command}" is not a usable command name. Telegram's rule is ` +
            `1-32 characters of a-z, 0-9 and underscore, and clients enforce it.`
        );
      }
      if (seen.has(name)) {
        throw new RangeError(`Duplicate command "${name}".`);
      }
      seen.add(name);
      if (command.parameters && !sanitizeCommandDescription(describeCommand(command))) {
        throw new RangeError(
          `The parameters of "${name}" are not a valid MSC4391 description: ` +
            'each needs a unique key and a schema the proposal allows.'
        );
      }
      accepted.push({ ...command, command: name });
    }

    if (accepted.filter((c) => !c.hidden).length > Limits.COMMANDS_MAX) {
      throw new RangeError(`At most ${Limits.COMMANDS_MAX} published commands.`);
    }

    this.commands = accepted;
  }

  /** Telegram's `getMyCommands`. Published entries only. */
  getCommands(): BotCommand[] {
    return this.commands
      .filter((command) => !command.hidden)
      .map(({ hidden: _hidden, parameters: _parameters, ...command }) => command);
  }

  /** One MSC4391 description per published command, in published order. */
  getDescriptions(): Msc4391CommandDescription[] {
    return this.commands.filter((command) => !command.hidden).map(describeCommand);
  }

  /** A command by name, hidden ones included. */
  get(name: string): CommandDefinition | undefined {
    return this.commands.find((command) => command.command === name);
  }

  /** Every command, hidden ones included. */
  getAllCommands(): CommandDefinition[] {
    return [...this.commands];
  }

  has(name: string): boolean {
    return this.commands.some((command) => command.command === name);
  }

  /** `setMyName` / `setMyDescription` / `setMyShortDescription` in one call. */
  setProfile(profile: Omit<BotInfo, 'version' | 'commands'>): void {
    this.profile = { ...this.profile, ...profile };
  }

  /** Telegram's `setChatMenuButton`, applied to every room. */
  setMenuButton(menuButton: MenuButton): void {
    this.profile.menu_button = menuButton;
  }

  /** The payload to publish into a room. */
  toBotInfo(): BotInfo {
    const info: BotInfo = { version: SCHEMA_VERSION, ...this.profile };
    const commands = this.getCommands();
    if (commands.length > 0) info.commands = commands;
    return info;
  }

  /**
   * A `/help` body built from the published list.
   *
   * Every bot writes this by hand otherwise, and every hand-written one drifts
   * from the real command list the first time somebody adds a command.
   */
  renderHelp(): string {
    const commands = this.getCommands();
    if (commands.length === 0) return 'This bot has no commands.';
    return commands
      .map((command) => {
        const usage = command.args ? `/${command.command} ${command.args}` : `/${command.command}`;
        return command.description ? `\`${usage}\` — ${command.description}` : `\`${usage}\``;
      })
      .join('\n');
  }
}
