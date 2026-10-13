import type { Scene } from "../domain/types";
const DB = "futvr-drafts";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("drafts");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveLocalDraft(scene: Scene) {
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put(scene, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}
export async function loadLocalDraft(): Promise<Scene | null> {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const r = d.transaction("drafts").objectStore("drafts").get("current");
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}
export async function clearLocalDraft() {
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("drafts", "readwrite");
      tx.objectStore("drafts").delete("current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}
export function readSession() {
  try {
    return JSON.parse(localStorage.getItem("futvr-session") || "null");
  } catch {
    return null;
  }
}
