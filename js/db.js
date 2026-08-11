/* =========================================================================
 * DB - IndexedDB store for converted cards and settings
 * =========================================================================
 * Two stores in one database, kept entirely separate from Casual Character
 * Chat's own database (different name, different origin path) so this tool
 * can never touch the app's characters.
 *
 *   cards     one converted card each: the CCC character plus a little
 *             provenance so the results list can show where it came from
 *   settings  per-platform tokens and UI preferences
 * ========================================================================= */

const DB_NAME = 'roleplay-card-converter';
const DB_VERSION = 1;
const STORE_CARDS = 'cards';
const STORE_SETTINGS = 'settings';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_CARDS)) {
        const store = db.createObjectStore(STORE_CARDS, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB could not be opened'));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction([store], mode);
    const s = t.objectStore(store);
    let result;
    try {
      result = fn(s);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  }));
}

/* ---------- cards ---------- */

/**
 * @param {Object} record
 * @param {string} record.id           same id as the CCC character inside
 * @param {string} record.name
 * @param {string} record.platform
 * @param {string} record.sourceUrl
 * @param {string} record.thumbnail    small data URL for the results list
 * @param {Object} record.character    the CCC character object
 */
export async function saveCard(record) {
  const row = { savedAt: Date.now(), ...record };
  await tx(STORE_CARDS, 'readwrite', s => s.put(row));
  return row;
}

/**
 * Metadata for the results list, without the character bodies.
 *
 * A card with a full gallery can run to several megabytes, so `getAll` on a
 * large collection would hold every one of them in memory at once just to
 * draw a list of names. Walking a cursor keeps only the light fields and lets
 * each heavy record be collected as soon as the cursor moves on; the full
 * record is re-read from `getCard` only when something is actually downloaded.
 */
export async function listCardsLight() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction([STORE_CARDS], 'readonly').objectStore(STORE_CARDS).openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) {
        out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        return resolve(out);
      }
      const r = cursor.value;
      out.push({
        id: r.id,
        name: r.name,
        platform: r.platform,
        sourceUrl: r.sourceUrl,
        savedAt: r.savedAt,
        thumbnail: r.thumbnail || '',
        galleryCount: Array.isArray(r.character?.gallery) ? r.character.gallery.length : 0,
        scenarioCount: Array.isArray(r.character?.scenarios) ? r.character.scenarios.length : 0,
        loreEntryCount: Array.isArray(r.character?.loreEntries) ? r.character.loreEntries.length : 0,
        partial: !!r.partial,
      });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getCard(id) {
  return tx(STORE_CARDS, 'readonly', s => s.get(id));
}

export async function deleteCard(id) {
  return tx(STORE_CARDS, 'readwrite', s => s.delete(id));
}

export async function clearCards() {
  return tx(STORE_CARDS, 'readwrite', s => s.clear());
}

export async function countCards() {
  const n = await tx(STORE_CARDS, 'readonly', s => s.count());
  return typeof n === 'number' ? n : 0;
}

/* ---------- settings ---------- */

export async function getSetting(key, fallback = null) {
  const row = await tx(STORE_SETTINGS, 'readonly', s => s.get(key));
  return row && row.value !== undefined ? row.value : fallback;
}

export async function setSetting(key, value) {
  return tx(STORE_SETTINGS, 'readwrite', s => s.put({ key, value }));
}
