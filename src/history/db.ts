/**
 * Local game history, in IndexedDB.
 *
 * Games with full per-move analysis outgrow localStorage's ~5 MB quota, and
 * there are only three stores here, so a wrapper library would cost more than
 * it saves.
 *
 * Everything stays on this machine. Nothing here is ever sent anywhere.
 */
import type { Verdict } from '../game/classify.js';
import type { Phase } from '../game/phase.js';
import type { Color, GameResult } from '../game/GameState.js';

const DB_NAME = 'chess-coach';
/**
 * Bump when the schema changes. Development wipes and rebuilds rather than
 * migrating: the data is a local practice log, and a broken migration that
 * silently corrupts your history is far worse than losing it.
 */
const DB_VERSION = 1;

export interface StoredGame {
  id: string;
  startedAt: number;
  endedAt: number | null;
  playerColor: Color;
  level: number;
  result: GameResult;
  pgn: string;
  moveCount: number;
  /** 0..100, from game/accuracy.ts. */
  accuracy: number;
  avgCpLoss: number;
  openingName: string | null;
}

export interface StoredMove {
  /** `${gameId}:${ply}` — lets a move be written repeatedly without duplicates. */
  id: string;
  gameId: string;
  ply: number;
  fenBefore: string;
  fenAfter: string;
  san: string;
  color: Color;
  phase: Phase;
  verdict: Verdict | null;
  cpLoss: number | null;
  /** Rule ids that fired. These are the keys the profile aggregates on. */
  triggeredRules: string[];
  bestMoveSan: string | null;
  /** The rendered coach text, so replay costs nothing and needs no engine. */
  explanation: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      // Rebuild from scratch on any version change.
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);

      const games = db.createObjectStore('games', { keyPath: 'id' });
      games.createIndex('startedAt', 'startedAt');

      const moves = db.createObjectStore('moves', { keyPath: 'id' });
      moves.createIndex('gameId', 'gameId');

      db.createObjectStore('meta', { keyPath: 'key' });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = action(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        tx.oncomplete = () => db.close();
      }),
  );
}

/**
 * Whether persistence is available at all.
 *
 * Private browsing and some embedded webviews expose `indexedDB` but throw on
 * use, so the app treats history as optional throughout rather than assuming
 * it works.
 */
export function isAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

export async function putGame(game: StoredGame): Promise<void> {
  await run('games', 'readwrite', (store) => store.put(game));
}

export async function putMove(move: StoredMove): Promise<void> {
  await run('moves', 'readwrite', (store) => store.put(move));
}

export async function putMoves(moves: StoredMove[]): Promise<void> {
  if (moves.length === 0) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('moves', 'readwrite');
    const store = tx.objectStore('moves');
    for (const move of moves) store.put(move);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
  });
}

export async function allGames(): Promise<StoredGame[]> {
  const games = await run<StoredGame[]>('games', 'readonly', (store) => store.getAll());
  return games.sort((a, b) => a.startedAt - b.startedAt);
}

export async function movesForGame(gameId: string): Promise<StoredMove[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('moves', 'readonly');
    const request = tx.objectStore('moves').index('gameId').getAll(gameId);
    request.onsuccess = () => resolve((request.result as StoredMove[]).sort((a, b) => a.ply - b.ply));
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
    tx.oncomplete = () => db.close();
  });
}

export async function allMoves(): Promise<StoredMove[]> {
  return run<StoredMove[]>('moves', 'readonly', (store) => store.getAll());
}

export async function clearAll(): Promise<void> {
  await run('games', 'readwrite', (store) => store.clear());
  await run('moves', 'readwrite', (store) => store.clear());
}

/** A short, sortable, collision-free id. */
export function newGameId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
