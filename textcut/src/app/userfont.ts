/**
 * The user's own caption font: a .ttf / .otf they picked, kept in this browser
 * (IndexedDB) and registered with the captions under its family name. One font at
 * a time; picking another replaces it.
 */

import { registerFont, unregisterFont } from "../core/captions";
import { parseFontFile } from "../core/fontfile";
import { refreshFontOptions } from "../core/ops";

interface Stored {
  file: string;
  bytes: ArrayBuffer;
}

const DB = "textcut", STORE = "kv", KEY = "userfont";
let current: { name: string; file: string; url: string } | null = null;

function store<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => { reject(req.error); db.close(); };
    };
  });
}

function register(s: Stored): string {
  const bytes = new Uint8Array(s.bytes);
  const info = parseFontFile(bytes);
  forget();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "font/otf" }));
  // a file name that is safe in a command line and keeps its extension
  const file = s.file.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "font.ttf";
  const name = registerFont(info.family, { url, lh: info.lh, upper: info.upper, lower: info.lower, file, local: true });
  current = { name, file, url };
  refreshFontOptions();
  return name;
}

function forget(): void {
  if (!current) return;
  unregisterFont(current.name);
  URL.revokeObjectURL(current.url);
  current = null;
  refreshFontOptions();
}

/** The user's font, if they have set one: its family name and file name. */
export function userFont(): { name: string; file: string } | null {
  return current;
}

let restored: Promise<void> | null = null;

/** Register the font kept from an earlier visit. Never throws: without it, the built-in fonts remain. */
export function restoreUserFont(): Promise<void> {
  return (restored ??= (async () => {
    try {
      const s = await store<Stored | undefined>("readonly", (st) => st.get(KEY));
      if (s?.bytes) register(s);
    } catch { /* no storage, or a file that no longer reads: carry on without it */ }
  })());
}

/** Use this file as the user's font from now on. Returns its family name; throws when it isn't a usable font. */
export async function setUserFont(f: File): Promise<string> {
  const s: Stored = { file: f.name, bytes: await f.arrayBuffer() };
  const name = register(s);
  // Kept for next time when the browser allows it; it works for this visit either way.
  await store("readwrite", (st) => st.put(s, KEY)).catch(() => undefined);
  return name;
}

export async function removeUserFont(): Promise<void> {
  forget();
  await store("readwrite", (st) => st.delete(KEY)).catch(() => undefined);
}
