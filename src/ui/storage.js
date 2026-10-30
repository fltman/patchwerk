// Remembers the last track between visits (IndexedDB) — the patch itself lives in localStorage.
const DB = 'patchwerk';
const STORE = 'tracks';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTrack(name, data) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ name, data }, 'last');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadTrack() {
  const db = await open();
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get('last');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function forgetTrack() {
  const db = await open();
  db.transaction(STORE, 'readwrite').objectStore(STORE).delete('last');
}
