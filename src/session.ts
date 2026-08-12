/**
 * Per-conversation state, in grammY's shape: `ctx.session` is a plain mutable
 * object, created on first access and written back when the handler returns.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionStorage<T> {
  read(key: string): T | undefined;
  write(key: string, value: T): void;
  delete(key: string): void;
  keys(): string[];
}

export class MemorySessionStorage<T> implements SessionStorage<T> {
  private readonly map = new Map<string, T>();

  read(key: string): T | undefined {
    return this.map.get(key);
  }

  write(key: string, value: T): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

/**
 * JSON-file storage. Writes the whole file on every change.
 *
 * Fine for the scale this is built for — one bot, tens of conversations. It is
 * a bad fit for thousands, and the fix is to implement `SessionStorage`
 * against a real database rather than to make this one cleverer.
 */
export class FileSessionStorage<T> implements SessionStorage<T> {
  private data: Record<string, T>;

  constructor(private readonly path: string) {
    this.data = FileSessionStorage.load<T>(path);
  }

  private static load<T>(path: string): Record<string, T> {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>;
    } catch {
      // A corrupt session file must not stop the bot from starting. Losing
      // conversation state is recoverable; refusing to boot is not.
      return {};
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    // Rename so a crash mid-write leaves the previous file intact rather than
    // a truncated one that would parse as empty on the next boot.
    renameSync(tmp, this.path);
  }

  read(key: string): T | undefined {
    return this.data[key];
  }

  write(key: string, value: T): void {
    this.data[key] = value;
    this.flush();
  }

  delete(key: string): void {
    delete this.data[key];
    this.flush();
  }

  keys(): string[] {
    return Object.keys(this.data);
  }
}

export type SessionOptions<T> = {
  storage?: SessionStorage<T>;
  /** Initial value for a conversation with no session yet. */
  initial: () => T;
  /**
   * Conversation key. Defaults to the room id, which makes a session
   * per-conversation rather than per-user — matching how a Matrix room works,
   * and how Telegram's `chat_id` behaves in a group.
   */
  getKey?: (roomId: string, userId: string) => string;
};

export class SessionManager<T> {
  private readonly storage: SessionStorage<T>;

  private readonly initial: () => T;

  private readonly getKey: (roomId: string, userId: string) => string;

  constructor(options: SessionOptions<T>) {
    this.storage = options.storage ?? new MemorySessionStorage<T>();
    this.initial = options.initial;
    this.getKey = options.getKey ?? ((roomId) => roomId);
  }

  key(roomId: string, userId: string): string {
    return this.getKey(roomId, userId);
  }

  get(roomId: string, userId: string): T {
    const key = this.key(roomId, userId);
    const existing = this.storage.read(key);
    if (existing !== undefined) return existing;
    const fresh = this.initial();
    this.storage.write(key, fresh);
    return fresh;
  }

  set(roomId: string, userId: string, value: T): void {
    this.storage.write(this.key(roomId, userId), value);
  }

  clear(roomId: string, userId: string): void {
    this.storage.delete(this.key(roomId, userId));
  }

  keys(): string[] {
    return this.storage.keys();
  }
}
