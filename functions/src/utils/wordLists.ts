// Cached access to the Firestore `word_lists` collection.
//
// Generation endpoints are public and can be called in tight loops, so reading
// the collection per request would put a Firestore read in the hot path for
// data that changes a few times a year. The cache is per instance and expires
// on a timer; edits in Settings take up to CACHE_TTL_MS to reach live traffic.

import * as admin from 'firebase-admin';
import { defaultWords } from './passwordGenerator';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface WordListCache {
  lists: { name: string; words: string[] }[];
  loadedAt: number;
}

let cache: WordListCache | null = null;

async function load(db: admin.firestore.Firestore): Promise<WordListCache> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;

  try {
    const snapshot = await db.collection('word_lists').get();
    const lists = snapshot.docs
      .map((doc) => {
        const data = doc.data();
        const words = Array.isArray(data.words)
          ? data.words.filter((w: unknown): w is string => typeof w === 'string' && w.length > 0)
          : [];
        return { name: String(data.name || doc.id), words };
      })
      .filter((list) => list.words.length > 0);
    cache = { lists, loadedAt: Date.now() };
  } catch (error) {
    console.error('Failed to load word lists, using defaults:', error);
    // Serve a stale cache if we have one; otherwise fall back to defaults so
    // generation keeps working through a Firestore blip.
    cache = cache ?? { lists: [], loadedAt: Date.now() };
  }

  return cache;
}

export interface WordListSelection {
  words: string[];
  /** The list actually used, or null when the built-in defaults were used. */
  listName: string | null;
  /** True when a specific list was requested but does not exist. */
  notFound: boolean;
}

/**
 * Resolve the word list for a request. With no `requested` name, every
 * configured list is merged so the API draws on the full vocabulary; with a
 * name, only that list is used.
 */
export async function resolveWords(
  db: admin.firestore.Firestore,
  requested?: string
): Promise<WordListSelection> {
  const { lists } = await load(db);

  if (requested) {
    const wanted = requested.trim().toLowerCase();
    const match = lists.find((list) => list.name.toLowerCase() === wanted);
    if (!match) return { words: defaultWords, listName: null, notFound: true };
    return { words: match.words, listName: match.name, notFound: false };
  }

  if (lists.length === 0) {
    return { words: defaultWords, listName: null, notFound: false };
  }

  const merged = Array.from(new Set(lists.flatMap((list) => list.words)));
  return { words: merged, listName: null, notFound: false };
}

/** Names of the configured lists, for the /wordlists discovery endpoint. */
export async function listNames(db: admin.firestore.Firestore): Promise<string[]> {
  const { lists } = await load(db);
  return lists.map((list) => list.name).sort();
}

/** Case-insensitive membership test across every configured list. */
export async function hasWord(db: admin.firestore.Firestore, word: string): Promise<boolean> {
  const { lists } = await load(db);
  const needle = word.trim().toLowerCase();
  if (!needle) return false;
  const pool = lists.length > 0 ? lists.flatMap((list) => list.words) : defaultWords;
  return pool.some((candidate) => candidate.toLowerCase() === needle);
}
