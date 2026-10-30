// IndexedDB storage for element markers (URL -> marked selectors)
// Uses the shared IndexedDbClient for robust transaction handling.

import { browserMetadataPolicy } from 'humanchrome-shared';
import { ensureRustKernel } from '@/shared/rust-kernel';
import { IndexedDbClient } from '@/utils/indexeddb-client';
import type { ElementMarker, UpsertMarkerRequest } from '@/common/element-marker-types';

const DB_NAME = 'element_marker_storage';
const DB_VERSION = 1;
const STORE = 'markers';

const idb = new IndexedDbClient(DB_NAME, DB_VERSION, (db, oldVersion) => {
  switch (oldVersion) {
    case 0: {
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      // Useful indexes for lookups
      store.createIndex('by_host', 'host', { unique: false });
      store.createIndex('by_origin', 'origin', { unique: false });
      store.createIndex('by_path', 'path', { unique: false });
    }
  }
});

function now(): number {
  return Date.now();
}

export async function listAllMarkers(): Promise<ElementMarker[]> {
  return idb.getAll<ElementMarker>(STORE);
}

export async function listMarkersForUrl(url: string): Promise<ElementMarker[]> {
  await ensureRustKernel();
  const current = browserMetadataPolicy.normalizeMarkerUrl(url);
  const all = await idb.getAll<ElementMarker>(STORE);
  return browserMetadataPolicy.matchingMarkerIndexes(all, current).map((index) => all[index]!);
}

export async function saveMarker(req: UpsertMarkerRequest): Promise<ElementMarker> {
  const { url: rawUrl, selector } = req;
  if (!rawUrl || !selector) throw new Error('url and selector are required');
  await ensureRustKernel();
  const { url, origin, host, path } = browserMetadataPolicy.normalizeMarkerUrl(rawUrl);
  const ts = now();
  const marker: ElementMarker = {
    id: req.id || (globalThis.crypto?.randomUUID?.() ?? `${ts}_${Math.random()}`),
    url,
    origin,
    host,
    path,
    matchType: req.matchType || 'prefix',
    name: req.name || selector,
    selector,
    selectorType: req.selectorType || 'css',
    listMode: req.listMode || false,
    action: req.action || 'custom',
    createdAt: ts,
    updatedAt: ts,
  };
  await idb.put<ElementMarker>(STORE, marker);
  return marker;
}

export async function updateMarker(marker: ElementMarker): Promise<void> {
  const existing = await idb.get<ElementMarker>(STORE, marker.id);
  if (!existing) throw new Error('marker not found');

  // Preserve createdAt from existing record, only update updatedAt
  const updated: ElementMarker = {
    ...marker,
    createdAt: existing.createdAt, // Never overwrite createdAt
    updatedAt: now(),
  };
  await idb.put<ElementMarker>(STORE, updated);
}

export async function deleteMarker(id: string): Promise<void> {
  await idb.delete(STORE, id);
}
