import { useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../services/firebase';
import type { PasswordDoc } from '../types';

// Live subscription to the password links inside one batch. Only active while a
// batch is expanded (pass null to disable), so a 300-row batch costs zero reads
// until someone opens it. Member rows flip pending -> sent/failed live during a
// send because this stays subscribed while expanded.
export function useBatchMembers(batchId: string | null) {
  const [members, setMembers] = useState<PasswordDoc[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!batchId) {
      setMembers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const q = query(
      collection(db, 'passwords'),
      where('batchId', '==', batchId),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setMembers(
          snap.docs.map((d) => ({ id: d.id, ...d.data() })) as PasswordDoc[]
        );
        setLoading(false);
      },
      (err) => {
        console.error('Failed to subscribe to batch members:', err);
        setLoading(false);
      }
    );
    return unsub;
  }, [batchId]);

  return { members, loading };
}
