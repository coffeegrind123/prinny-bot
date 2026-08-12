/**
 * Persistent IndexedDB crypto store for the Matrix bot under Bun/Node.
 *
 * matrix-js-sdk's Rust crypto persists Olm/megolm sessions + the device's Olm
 * account in IndexedDB. Bun has no IndexedDB, so historically we shipped a
 * hand-written file-backed shim (cryptoPolyfill.ts). That shim got the *hard*
 * parts of IndexedDB wrong — cursor `continue()` never re-fired `onsuccess`
 * (so session reads returned only the first record), and key ordering used
 * locale string compare instead of IndexedDB's byte-wise comparison — which
 * silently corrupted Olm/megolm session lookups and broke E2EE in both
 * directions while basic key/value reads (the device identity) still worked.
 *
 * This module replaces that shim with `fake-indexeddb` (the spec-compliant,
 * widely-used IndexedDB implementation) for correctness, and adds a JSON
 * snapshot layer so the crypto state survives process restarts — without
 * which a long-running bot would regenerate its Olm identity on every boot
 * (the "device keys changed" churn that blocks peers from sharing room keys).
 *
 * Import order matters: `fake-indexeddb/auto` installs the global IDB classes
 * at module-load time, before matrix-js-sdk ever touches `indexedDB`.
 */
import 'fake-indexeddb/auto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { dirname } from 'node:path'

// ── structured value/key (de)serialization ───────────────────────────────
// IndexedDB keys/values may contain Uint8Array / ArrayBuffer / Date / nested
// objects+arrays. JSON can't carry those, so tag-encode them.

type Tagged = { __t: string; d?: unknown }

export function encode(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (v instanceof Uint8Array) {
    return { __t: 'u8', d: Buffer.from(v).toString('base64') } satisfies Tagged
  }
  if (v instanceof ArrayBuffer) {
    return { __t: 'ab', d: Buffer.from(new Uint8Array(v)).toString('base64') } satisfies Tagged
  }
  if (ArrayBuffer.isView(v)) {
    // Other typed arrays (rare) — preserve constructor name + bytes.
    const view = v as ArrayBufferView
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    return { __t: 'tv', d: Buffer.from(bytes).toString('base64'), c: v.constructor.name } as Tagged & { c: string }
  }
  if (v instanceof Date) return { __t: 'date', d: v.getTime() } satisfies Tagged
  if (Array.isArray(v)) return v.map(encode)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = encode(val)
    return out
  }
  return v
}

export function decode(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) return v.map(decode)
  if (typeof v === 'object') {
    const t = (v as Tagged).__t
    if (t === 'u8') return Uint8Array.from(Buffer.from((v as Tagged).d as string, 'base64'))
    if (t === 'ab') return Uint8Array.from(Buffer.from((v as Tagged).d as string, 'base64')).buffer
    if (t === 'date') return new Date((v as Tagged).d as number)
    if (t === 'tv') {
      const bytes = Uint8Array.from(Buffer.from((v as Tagged).d as string, 'base64'))
      const Ctor = (globalThis as Record<string, unknown>)[(v as { c: string }).c] as
        | (new (b: ArrayBuffer) => ArrayBufferView)
        | undefined
      return Ctor ? new Ctor(bytes.buffer) : bytes
    }
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = decode(val)
    return out
  }
  return v
}

// ── snapshot format ───────────────────────────────────────────────────────

type StoreDump = {
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>
  records: Array<{ k?: unknown; v: unknown }>
}
type DbDump = { version: number; stores: Record<string, StoreDump> }
type Snapshot = { dbs: Record<string, DbDump> }

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

async function openExisting(name: string): Promise<IDBDatabase> {
  return reqDone(indexedDB.open(name))
}

async function dumpAll(): Promise<Snapshot> {
  const snapshot: Snapshot = { dbs: {} }
  const dbs = await indexedDB.databases()
  for (const { name, version } of dbs) {
    if (!name) continue
    const db = await openExisting(name)
    const stores: Record<string, StoreDump> = {}
    for (const storeName of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(storeName, 'readonly')
      const os = tx.objectStore(storeName)
      const dump: StoreDump = {
        keyPath: os.keyPath as string | string[] | null,
        autoIncrement: os.autoIncrement,
        indexes: Array.from(os.indexNames).map(n => {
          const ix = os.index(n)
          return {
            name: n,
            keyPath: ix.keyPath as string | string[],
            unique: ix.unique,
            multiEntry: ix.multiEntry,
          }
        }),
        records: [],
      }
      const inline = os.keyPath != null
      await new Promise<void>((res, rej) => {
        const cur = os.openCursor()
        cur.onsuccess = () => {
          const c = cur.result
          if (c) {
            dump.records.push(
              inline ? { v: encode(c.value) } : { k: encode(c.key), v: encode(c.value) },
            )
            c.continue()
          } else res()
        }
        cur.onerror = () => rej(cur.error)
      })
      stores[storeName] = dump
    }
    snapshot.dbs[name] = { version: version ?? 1, stores }
    db.close()
  }
  return snapshot
}

async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  for (const [name, dbDump] of Object.entries(snapshot.dbs)) {
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open(name, dbDump.version)
      req.onupgradeneeded = () => {
        const db = req.result
        for (const [storeName, s] of Object.entries(dbDump.stores)) {
          const os = db.createObjectStore(storeName, {
            keyPath: s.keyPath ?? undefined,
            autoIncrement: s.autoIncrement,
          })
          for (const ix of s.indexes) {
            os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry })
          }
        }
      }
      req.onsuccess = () => {
        const db = req.result
        const storeNames = Object.keys(dbDump.stores)
        if (storeNames.length === 0) {
          db.close()
          return res()
        }
        const tx = db.transaction(storeNames, 'readwrite')
        for (const [storeName, s] of Object.entries(dbDump.stores)) {
          const os = tx.objectStore(storeName)
          for (const r of s.records) {
            if (s.keyPath == null) os.put(decode(r.v), decode(r.k) as IDBValidKey)
            else os.put(decode(r.v))
          }
        }
        tx.oncomplete = () => {
          db.close()
          res()
        }
        tx.onerror = () => rej(tx.error)
      }
      req.onerror = () => rej(req.error)
    })
  }
}

// ── auto-snapshot (debounced write-through to disk) ───────────────────────

let snapshotPath: string | null = null
let dumpTimer: ReturnType<typeof setTimeout> | null = null
let dumping = false
let dirtyWhileDumping = false

function log(msg: string): void {
  process.stderr.write(`[matrix:cryptoStore] ${msg}\n`)
}

async function writeSnapshot(): Promise<void> {
  if (!snapshotPath) return
  if (dumping) {
    dirtyWhileDumping = true
    return
  }
  dumping = true
  try {
    const snap = await dumpAll()
    mkdirSync(dirname(snapshotPath), { recursive: true })
    const tmp = snapshotPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 })
    renameSync(tmp, snapshotPath)
  } catch (err) {
    log(`snapshot write failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    dumping = false
    if (dirtyWhileDumping) {
      dirtyWhileDumping = false
      scheduleSnapshot()
    }
  }
}

function scheduleSnapshot(): void {
  if (!snapshotPath) return
  if (dumpTimer) clearTimeout(dumpTimer)
  dumpTimer = setTimeout(() => {
    dumpTimer = null
    void writeSnapshot()
  }, 800)
}

let patched = false
function patchMutationsToSnapshot(): void {
  if (patched) return
  patched = true
  const proto = IDBObjectStore.prototype as unknown as Record<
    string,
    ((...a: unknown[]) => unknown) | undefined
  >
  for (const method of ['put', 'add', 'delete', 'clear'] as const) {
    const orig = proto[method]
    // A missing method means the IndexedDB implementation underneath is not
    // the one we expect. Wrapping `undefined` would turn every write into a
    // TypeError at the moment crypto state is being saved, so leave it alone.
    if (!orig) continue
    proto[method] = function (this: unknown, ...args: unknown[]) {
      const result = orig.apply(this, args)
      scheduleSnapshot()
      return result
    }
  }
}

// ── public API ────────────────────────────────────────────────────────────

let initialized = false

/**
 * Restore the crypto store from disk (if present) and start write-through
 * snapshotting. MUST be called (and awaited) before `client.initRustCrypto()`
 * so the device's Olm account + sessions are in place when crypto opens them.
 */
export async function initCryptoStore(path: string): Promise<void> {
  if (initialized) return
  initialized = true
  snapshotPath = path
  if (existsSync(path)) {
    try {
      const snap = JSON.parse(readFileSync(path, 'utf8')) as Snapshot
      if (snap && snap.dbs) {
        await restoreSnapshot(snap)
        const dbCount = Object.keys(snap.dbs).length
        log(`restored crypto store from ${path} (${dbCount} db${dbCount === 1 ? '' : 's'})`)
      }
    } catch (err) {
      log(`restore failed (${err instanceof Error ? err.message : String(err)}) — starting fresh`)
    }
  } else {
    log('no existing crypto snapshot — starting fresh')
  }
  patchMutationsToSnapshot()
}

/** Force a synchronous-ish final snapshot (await before exit). */
export async function flushCryptoStore(): Promise<void> {
  if (!snapshotPath) return
  if (dumpTimer) {
    clearTimeout(dumpTimer)
    dumpTimer = null
  }
  await writeSnapshot()
}
