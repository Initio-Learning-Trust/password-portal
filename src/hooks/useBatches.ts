import { useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../services/firebase';
import type { BatchDoc } from '../types';

// Live subscription to the batches collection. Batch summary rows (counts +
// send progress) update in real time from here, so the queue reflects an
// in-flight send without polling.
export function useBatches() {
  const [batches, setBatches] = useState<BatchDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'batches'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setBatches(
          snap.docs.map((d) => ({ id: d.id, ...d.data() })) as BatchDoc[]
        );
        setLoading(false);
      },
      (err) => {
        console.error('Failed to subscribe to batches:', err);
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  return { batches, loading };
}
