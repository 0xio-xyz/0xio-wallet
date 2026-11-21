import { logger } from 'src/utils/logger';

const DB_NAME = '0xio-circle-assets';
const DB_VERSION = 2;
const BLOBS = 'blobs';
const META = 'meta';
const LRU_INDEX = 'lastAccess';

const MAX_BYTES = 80 * 1024 * 1024;
const EVICT_TARGET = 64 * 1024 * 1024;

export interface CachedAsset {
  bytes: Uint8Array;
  contentType: string;
}

interface BlobRecord {
  key: string;
  bytes: ArrayBuffer;
  contentType: string;
}

interface MetaRecord {
  key: string;
  size: number;
  lastAccess: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of [BLOBS, META]) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        }
        db.createObjectStore(BLOBS, { keyPath: 'key' });
        db.createObjectStore(META, { keyPath: 'key' }).createIndex(LRU_INDEX, 'lastAccess');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        logger.debug('[circleCache] IndexedDB open failed, caching disabled');
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function clearCircleAssetCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await (dbPromise ?? Promise.resolve(null));
    db?.close();
  } catch {}
  dbPromise = null;
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getCachedAsset(key: string): Promise<CachedAsset | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const rec = await new Promise<BlobRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(BLOBS, 'readonly');
      const r = tx.objectStore(BLOBS).get(key);
      r.onsuccess = () => resolve(r.result as BlobRecord | undefined);
      r.onerror = () => reject(r.error);
    });
    if (!rec) return null;
    touch(key);
    return { bytes: new Uint8Array(rec.bytes), contentType: rec.contentType };
  } catch {
    return null;
  }
}

export async function putCachedAsset(key: string, asset: CachedAsset): Promise<void> {
  const db = await openDb();
  if (!db) return;
  // Copy into an exact-sized ArrayBuffer so a subarray doesn't drag its whole
  // backing buffer to disk (and to avoid a SharedArrayBuffer leaking in).
  const buf = new ArrayBuffer(asset.bytes.byteLength);
  new Uint8Array(buf).set(asset.bytes);
  const blob: BlobRecord = { key, bytes: buf, contentType: asset.contentType };
  const meta: MetaRecord = { key, size: asset.bytes.byteLength, lastAccess: Date.now() };
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOBS, META], 'readwrite');
      tx.objectStore(BLOBS).put(blob);
      tx.objectStore(META).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    void enforceBudget();
  } catch {}
}

export async function deleteCachedAsset(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOBS, META], 'readwrite');
      tx.objectStore(BLOBS).delete(key);
      tx.objectStore(META).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {}
}

function touch(key: string): void {
  void openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(META, 'readwrite');
      const store = tx.objectStore(META);
      const r = store.get(key);
      r.onsuccess = () => {
        const rec = r.result as MetaRecord | undefined;
        if (rec) {
          rec.lastAccess = Date.now();
          store.put(rec);
        }
      };
    } catch {}
  });
}

let evicting = false;
async function enforceBudget(): Promise<void> {
  if (evicting) return;
  evicting = true;
  try {
    const db = await openDb();
    if (!db) return;
    const total = await sumSizes(db);
    if (total <= MAX_BYTES) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction([BLOBS, META], 'readwrite');
      const metaStore = tx.objectStore(META);
      const blobStore = tx.objectStore(BLOBS);
      const cursorReq = metaStore.index(LRU_INDEX).openCursor();
      let running = total;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || running <= EVICT_TARGET) return;
        const rec = cursor.value as MetaRecord;
        running -= rec.size;
        blobStore.delete(rec.key);
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
  } finally {
    evicting = false;
  }
}

function sumSizes(db: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    let total = 0;
    try {
      const tx = db.transaction(META, 'readonly');
      const cursorReq = tx.objectStore(META).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        total += (cursor.value as MetaRecord).size || 0;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(total);
      tx.onerror = () => resolve(total);
    } catch {
      resolve(total);
    }
  });
}
