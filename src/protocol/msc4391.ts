/**
 * MSC4391 (simplified in-room bot commands), alongside `app.prinny.bot.info`.
 *
 * A bot describes each command in its own state event, and a client that
 * supports the MSC sends the invocation as a structured block next to the
 * text. gomuks, mautrix-go and others speak it, so publishing it makes this
 * library's commands show up in their menus too, and reading it lets their
 * users invoke commands without matching our text syntax.
 *
 * `app.prinny.bot.info` stays the source of the profile, menu button, privacy
 * flag and command order, and the only form a bot without state power can
 * publish. MSC4391 has no timeline fallback.
 *
 * Like validate.ts, this module is dependency-free: a client mirrors it to
 * read what an arbitrary room member published. The state key needs SHA-256,
 * which the caller supplies (`node:crypto` in the bot, SubtleCrypto in a
 * browser).
 *
 * Proposal text: https://github.com/matrix-org/matrix-spec-proposals/pull/4391
 * Wire shapes follow the proposal's examples and mautrix-go's
 * `event/cmdschema`, which is the reference implementation.
 */

import { cleanString, isValidCommandName } from './validate.js';
import type { BotCommand } from './types.js';

/** Unstable identifiers, per the proposal's "Unstable prefix" section. */
export const Msc4391 = {
  /** State event, `state_key` = `stateKeyInput(command, mxid)` hashed. */
  CommandDescription: 'org.matrix.msc4391.command_description',
  /** Content block on the invoking `m.room.message`. */
  Command: 'org.matrix.msc4391.command',
  /**
   * mautrix-go extension: the parameter that takes the rest of the line when
   * a client parses typed text. Harmless to clients that do not know it.
   */
  TailParameter: 'fi.mau.tail_parameter',
} as const;

/** The parameter a usage-hint-only command (`args`) is published with. */
export const ARGS_PARAMETER_KEY = 'args';

/**
 * Caps on what a client will read from a description. The proposal sets none;
 * these exist so a hostile description cannot produce an unbounded menu.
 */
export const Msc4391Limits = {
  /** Room for subcommands ("rooms add") as the proposal allows. */
  COMMAND_MAX_LENGTH: 128,
  PARAMETERS_MAX: 32,
  KEY_MAX_LENGTH: 64,
  DESCRIPTION_MAX_LENGTH: 256,
  UNION_VARIANTS_MAX: 64,
  LITERAL_STRING_MAX_LENGTH: 256,
} as const;

export type Msc4391PrimitiveType =
  | 'string'
  | 'integer'
  | 'boolean'
  | 'user_id'
  | 'server_name'
  | 'room_alias'
  | 'room_id'
  | 'event_id';

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set<Msc4391PrimitiveType>([
  'string',
  'integer',
  'boolean',
  'user_id',
  'server_name',
  'room_alias',
  'room_id',
  'event_id',
]);

export type Msc4391PrimitiveSchema = { schema_type: 'primitive'; type: Msc4391PrimitiveType };
export type Msc4391LiteralSchema = { schema_type: 'literal'; value: string | number | boolean };
/** Variants are primitives or literals only: the proposal forbids nesting. */
export type Msc4391UnionSchema = {
  schema_type: 'union';
  variants: (Msc4391PrimitiveSchema | Msc4391LiteralSchema)[];
};
/** Top level only; items are a primitive, a literal or a union. */
export type Msc4391ArraySchema = {
  schema_type: 'array';
  items: Msc4391PrimitiveSchema | Msc4391LiteralSchema | Msc4391UnionSchema;
};
export type Msc4391Schema =
  | Msc4391PrimitiveSchema
  | Msc4391LiteralSchema
  | Msc4391UnionSchema
  | Msc4391ArraySchema;

/** MSC1767 `m.text`, as the proposal uses for descriptions. */
export type Msc4391Text = { 'm.text': { body: string; mimetype?: string }[] };

export type Msc4391Parameter = {
  key: string;
  schema: Msc4391Schema;
  optional?: boolean;
  description?: Msc4391Text;
};

export type Msc4391CommandDescription = {
  /** May contain spaces, for subcommands. */
  command: string;
  parameters?: Msc4391Parameter[];
  description?: Msc4391Text;
  [Msc4391.TailParameter]?: string;
};

/** A `room_id` or `event_id` argument. */
export type Msc4391RoomReference = {
  type: 'room_id' | 'event_id';
  id: string;
  via?: string[];
  event_id?: string;
};

export type Msc4391Invocation = {
  command: string;
  arguments: Record<string, unknown>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What to hash for a description's `state_key`: the command, then the MXID,
 * with nothing between them. The key is the padded standard base64 of its
 * SHA-256 digest (the proposal's invariant, and what mautrix-go writes).
 */
export const stateKeyInput = (command: string, userId: string): string => command + userId;

/** Padded standard base64 of a digest, without Buffer, so a browser can use it too. */
export const digestToStateKey = (digest: Uint8Array): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < digest.length; i += 3) {
    const a = digest[i]!;
    const b = digest[i + 1];
    const c = digest[i + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : alphabet[c & 0x3f];
  }
  return out;
};

export const textOf = (body: string): Msc4391Text => ({ 'm.text': [{ body }] });

/** The plain body of an `m.text` block, preferring a `text/plain` representation. */
export const plainTextOf = (raw: unknown, max: number): string | undefined => {
  if (!isRecord(raw)) return undefined;
  const reps = raw['m.text'];
  if (!Array.isArray(reps)) return undefined;
  const records = reps.filter(isRecord);
  const plain =
    records.find((r) => r.mimetype === undefined || r.mimetype === 'text/plain') ?? records[0];
  return plain ? cleanString(plain.body, max) : undefined;
};

// ── Building (bot side) ──────────────────────────────────────────────────────

/** A command as a bot author defines it: `app.prinny.bot.info` fields plus structured parameters. */
export type Msc4391CommandSource = BotCommand & { parameters?: Msc4391Parameter[] };

/**
 * The description a command is published with.
 *
 * Structured `parameters` are used as given. A command that only has the
 * `args` usage hint becomes one optional string parameter named `args`, which
 * is also the tail parameter, so a client that parses typed text hands the
 * whole rest of the line to the bot exactly as our own text parser does.
 */
export const describeCommand = (source: Msc4391CommandSource): Msc4391CommandDescription => {
  const description: Msc4391CommandDescription = { command: source.command };
  if (source.description) description.description = textOf(source.description);

  if (source.parameters && source.parameters.length > 0) {
    description.parameters = source.parameters;
  } else if (source.args) {
    description.parameters = [
      {
        key: ARGS_PARAMETER_KEY,
        schema: { schema_type: 'primitive', type: 'string' },
        optional: true,
        description: textOf(source.args),
      },
    ];
    description[Msc4391.TailParameter] = ARGS_PARAMETER_KEY;
  }
  return description;
};

// ── Validation (client side, and the bot checking its author) ────────────────

const sanitizeLeafSchema = (
  raw: unknown
): Msc4391PrimitiveSchema | Msc4391LiteralSchema | null => {
  if (!isRecord(raw)) return null;
  if (raw.schema_type === 'primitive') {
    return typeof raw.type === 'string' && PRIMITIVE_TYPES.has(raw.type)
      ? { schema_type: 'primitive', type: raw.type as Msc4391PrimitiveType }
      : null;
  }
  if (raw.schema_type === 'literal') {
    const { value } = raw;
    if (typeof value === 'boolean') return { schema_type: 'literal', value };
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return { schema_type: 'literal', value };
    }
    if (typeof value === 'string' && value.length <= Msc4391Limits.LITERAL_STRING_MAX_LENGTH) {
      return { schema_type: 'literal', value };
    }
  }
  return null;
};

const sanitizeUnion = (raw: Record<string, unknown>): Msc4391UnionSchema | null => {
  if (!Array.isArray(raw.variants) || raw.variants.length === 0) return null;
  if (raw.variants.length > Msc4391Limits.UNION_VARIANTS_MAX) return null;
  const variants = raw.variants.map(sanitizeLeafSchema);
  if (variants.some((v) => v === null)) return null;
  return {
    schema_type: 'union',
    variants: variants as (Msc4391PrimitiveSchema | Msc4391LiteralSchema)[],
  };
};

/**
 * A schema the proposal allows, or `null`.
 *
 * Unlike the truncating policy in validate.ts, an invalid schema is rejected
 * whole: a menu that prompts for the wrong type of value is worse than one
 * that does not offer the command.
 */
export const sanitizeSchema = (raw: unknown): Msc4391Schema | null => {
  if (!isRecord(raw)) return null;
  switch (raw.schema_type) {
    case 'primitive':
    case 'literal':
      return sanitizeLeafSchema(raw);
    case 'union':
      return sanitizeUnion(raw);
    case 'array': {
      if (!isRecord(raw.items)) return null;
      const items =
        raw.items.schema_type === 'union' ? sanitizeUnion(raw.items) : sanitizeLeafSchema(raw.items);
      return items ? { schema_type: 'array', items } : null;
    }
    default:
      return null;
  }
};

const COMMAND_WORD = /^[^\s/]+$/;

/** A description's `command`: words separated by single spaces, none starting with a slash. */
const sanitizeCommandName = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > Msc4391Limits.COMMAND_MAX_LENGTH) return null;
  const words = raw.split(' ');
  if (words.some((w) => !COMMAND_WORD.test(w) || cleanString(w, w.length) !== w)) return null;
  return raw;
};

/**
 * A command description safe to put in a menu, or `null` if the proposal says
 * to hide it (duplicate parameter keys) or it is unusable.
 *
 * An empty content (`{}`) is how a bot withdraws a command, so it returns
 * `null` as well.
 */
export const sanitizeCommandDescription = (raw: unknown): Msc4391CommandDescription | null => {
  if (!isRecord(raw)) return null;
  const command = sanitizeCommandName(raw.command);
  if (!command) return null;

  const out: Msc4391CommandDescription = { command };
  const description = plainTextOf(raw.description, Msc4391Limits.DESCRIPTION_MAX_LENGTH);
  if (description) out.description = textOf(description);

  if (raw.parameters !== undefined) {
    if (!Array.isArray(raw.parameters)) return null;
    if (raw.parameters.length > Msc4391Limits.PARAMETERS_MAX) return null;
    const keys = new Set<string>();
    const parameters: Msc4391Parameter[] = [];
    for (const rawParam of raw.parameters) {
      if (!isRecord(rawParam)) return null;
      const { key } = rawParam;
      if (typeof key !== 'string' || key.length === 0) return null;
      if (key.length > Msc4391Limits.KEY_MAX_LENGTH) return null;
      if (keys.has(key)) return null;
      keys.add(key);
      const schema = sanitizeSchema(rawParam.schema);
      if (!schema) return null;
      const param: Msc4391Parameter = { key, schema };
      if (rawParam.optional === true) param.optional = true;
      const paramDescription = plainTextOf(
        rawParam.description,
        Msc4391Limits.DESCRIPTION_MAX_LENGTH
      );
      if (paramDescription) param.description = textOf(paramDescription);
      parameters.push(param);
    }
    if (parameters.length > 0) out.parameters = parameters;
  }

  const tail = raw[Msc4391.TailParameter];
  if (typeof tail === 'string' && out.parameters?.some((p) => p.key === tail)) {
    out[Msc4391.TailParameter] = tail;
  }
  return out;
};

// ── Invocations ──────────────────────────────────────────────────────────────

export type InvocationTarget =
  /** The block names this bot in `m.mentions`. */
  | { kind: 'ours'; invocation: Msc4391Invocation }
  /** The block names other users only: someone else's command. */
  | { kind: 'other' };

/**
 * Read the structured invocation off a message, if there is one.
 *
 * Returns `null` when the message has no usable block, or when its mentions
 * say nothing about who it is for; the caller then parses the text as before.
 * The proposal asks bots to check the mention, so a block mentioning only
 * other users is someone else's, even when the command name matches.
 */
export const invocationTarget = (
  content: Record<string, unknown>,
  botUserId: string
): InvocationTarget | null => {
  const block = content[Msc4391.Command];
  if (!isRecord(block)) return null;
  const command = sanitizeCommandName(block.command);
  if (!command) return null;
  const args = block.arguments === undefined ? {} : block.arguments;
  if (!isRecord(args)) return null;

  const mentions = content['m.mentions'];
  const userIds =
    isRecord(mentions) && Array.isArray(mentions.user_ids)
      ? mentions.user_ids.filter((u): u is string => typeof u === 'string')
      : [];
  if (userIds.length === 0) return null;
  if (!userIds.includes(botUserId)) return { kind: 'other' };
  return { kind: 'ours', invocation: { command, arguments: args } };
};

/** The block a client sends; `arguments` keyed by parameter key. */
export const buildInvocation = (
  command: string,
  args: Record<string, unknown> = {}
): Record<string, unknown> => ({ [Msc4391.Command]: { command, arguments: args } });

/** Whether an invocation's command can be one of ours, which never contain spaces. */
export const isSingleWordCommand = (command: string): boolean =>
  isValidCommandName(command.toLowerCase());

// ── Arguments as text ────────────────────────────────────────────────────────

const percent = (s: string): string => encodeURIComponent(s);

/**
 * A `room_id` / `event_id` argument as a `matrix:` URI (MSC2312), or `null`.
 *
 * `matrix:roomid/<id>[/e/<event>][?via=...]`, sigils dropped. The URI is what
 * a handler reading text args can pass straight back to a client.
 */
export const roomReferenceToUri = (raw: unknown): string | null => {
  if (!isRecord(raw)) return null;
  const { type, id, via, event_id: eventId } = raw;
  if (typeof id !== 'string' || !id.startsWith('!') || id.length < 2) return null;
  let uri = `matrix:roomid/${percent(id.slice(1))}`;
  if (type === 'event_id') {
    if (typeof eventId !== 'string' || !eventId.startsWith('$') || eventId.length < 2) {
      return null;
    }
    uri += `/e/${percent(eventId.slice(1))}`;
  } else if (type !== 'room_id') {
    return null;
  }
  const servers = Array.isArray(via) ? via.filter((v): v is string => typeof v === 'string') : [];
  if (servers.length > 0) uri += `?${servers.map((s) => `via=${percent(s)}`).join('&')}`;
  return uri;
};

const quote = (s: string): string =>
  s === '' || /[\s"\\]/.test(s) ? `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"` : s;

const argumentText = (value: unknown, quoted: boolean): string | null => {
  if (typeof value === 'string') return quoted ? quote(value) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : null;
  if (typeof value === 'boolean') return String(value);
  return roomReferenceToUri(value);
};

/**
 * An invocation's arguments as the text our parser would have produced, for
 * `ctx.command.args`.
 *
 * Parameters come in their declared order. The tail parameter (or the last
 * one) is passed through verbatim; earlier strings with spaces are quoted, as
 * mautrix-go's stringifier does. Arrays become space-separated items. Values
 * of unknown parameters are appended in key order, so nothing the user typed
 * is silently lost when the bot's description and the client disagree.
 */
export const argumentsToText = (
  args: Record<string, unknown>,
  description?: Pick<Msc4391CommandDescription, 'parameters' | typeof Msc4391.TailParameter>
): string => {
  const params = description?.parameters ?? [];
  const known = new Set(params.map((p) => p.key));
  const keys = [
    ...params.map((p) => p.key),
    ...Object.keys(args)
      .filter((k) => !known.has(k))
      .sort(),
  ];
  const tail = description?.[Msc4391.TailParameter] ?? keys[keys.length - 1];

  const parts: string[] = [];
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const verbatim = key === tail;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const text = argumentText(item, !verbatim);
      if (text !== null && text !== '') parts.push(text);
    }
  }
  return parts.join(' ');
};
