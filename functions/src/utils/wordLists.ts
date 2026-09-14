// Cached access to the Firestore `word_lists` collection.
//
// Generation endpoints are public and can be called in tight loops, so reading
// the collection per request would put a Firestore read in the hot path for
// data that changes a few times a year. The cache is per instance and expires
// on a timer; edits in Settings take up to CACHE_TTL_MS to reach live traffic.
//
// There is no built-in fallback list. Passwords come from the lists configured
// in Settings or the request fails saying so — generating from a vocabulary
// nobody chose is how a list edit ends up looking like it did nothing.

import * as admin from 'firebase-admin';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface WordListCache {
  lists: { name: string; words: string[] }[];
  loadedAt: number;
}

let cache: WordListCache | null = null;

/**
 * Thrown when the lists could not be read and there is no cached copy to serve
 * instead. Callers turn this into a 503 rather than generating without them.
 */
export class WordListsUnavailableError extends Error {
  constructor() {
    super('Word lists could not be read');
    this.name = 'WordListsUnavailableError';
  }
}

async function load(db: admin.firestore.Firestore): Promise<WordListCache> {
  const cached = cache;
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

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
    const fresh = { lists, loadedAt: Date.now() };
    cache = fresh;
    return fresh;
  } catch (error) {
    console.error('Failed to load word lists:', error);
    // Serve a stale cache through a Firestore blip — expired words beat no
    // words. With nothing cached the request fails instead, and the failure is
    // deliberately not cached so the next request retries rather than
    // inheriting a five-minute outage from one bad read.
    if (cached) return cached;
    throw new WordListsUnavailableError();
  }
}

export interface WordListSelection {
  words: string[];
  /** The list actually used, or null when every configured list was merged. */
  listName: string | null;
  /** True when a specific list was requested but does not exist. */
  notFound: boolean;
}

/**
 * Resolve the word list for a request. With no `requested` name, every
 * configured list is merged so the API draws on the full vocabulary; with a
 * name, only that list is used.
 *
 * Returns an empty `words` when no lists are configured. Callers must check
 * for that and report it — there is nothing to fall back to.
 */
export async function resolveWords(
  db: admin.firestore.Firestore,
  requested?: string
): Promise<WordListSelection> {
  const { lists } = await load(db);

  if (requested) {
    const wanted = requested.trim().toLowerCase();
    const match = lists.find((list) => list.name.toLowerCase() === wanted);
    if (!match) return { words: [], listName: null, notFound: true };
    return { words: match.words, listName: match.name, notFound: false };
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
  return lists.some((list) =>
    list.words.some((candidate) => candidate.toLowerCase() === needle)
  );
}
