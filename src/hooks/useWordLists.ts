import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../services/firebase';
import type { WordListDoc } from '../types';

export interface WordListsState {
  /** Every word from every configured list, merged and de-duplicated. */
  words: string[];
  loading: boolean;
  /** True when the collection could not be read (offline, rules, etc.). */
  error: boolean;
}

// Live subscription to the word lists configured in Settings.
//
// A subscription rather than a one-off read so an edit in Settings reaches the
// generator immediately — the API's copy of this data is cached for five
// minutes (see functions/src/utils/wordLists.ts), but there is no reason for
// the browser to lag behind the admin who just saved the change.
//
// Words from every list are merged, matching what the API does when a request
// names no particular list. There is deliberately no fallback to a built-in
// list: passwords come from the configured vocabulary or the UI says none is
// configured. A silent fallback is what made edits here look like no-ops.
export function useWordLists(): WordListsState {
  const [lists, setLists] = useState<WordListDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'word_lists'),
      (snap) => {
        setLists(
          snap.docs.map((d) => ({ id: d.id, ...d.data() })) as WordListDoc[]
        );
        setError(false);
        setLoading(false);
      },
      (err) => {
        console.error('Failed to subscribe to word lists:', err);
        setError(true);
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  const words = useMemo(() => {
    const merged = lists.flatMap((list) =>
      Array.isArray(list.words) ? list.words : []
    );
    return Array.from(
      new Set(
        merged.filter((w): w is string => typeof w === 'string' && w.length > 0)
      )
    );
  }, [lists]);

  return { words, loading, error };
}
