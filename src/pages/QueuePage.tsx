import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  getCountFromServer,
  doc,
  updateDoc,
  deleteDoc,
  increment,
  limit,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../services/firebase';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/common/Toast';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { useBatches } from '../hooks/useBatches';
import { normalizeSearchQuery } from '../utils/searchTokens';
import { Layout } from '../components/layout/Layout';
import { Button } from '../components/common/Button';
import { BatchGroupRow } from '../components/queue/BatchGroupRow';
import type { BatchDoc, PasswordDoc } from '../types';
import styles from './QueuePage.module.css';

type FilterStatus = 'all' | 'pending' | 'sent' | 'viewed' | 'failed' | 'closed';

// Convert a Firestore Timestamp | Date | plain object to millis for sorting the
// mixed stream of batches and single links.
function toMillis(value: unknown): number {
  if (!value) return 0;
  const v = value as { toMillis?: () => number; getTime?: () => number; seconds?: number };
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
}

// A row in the queue is either a batch group or a standalone link.
type StreamItem =
  | { kind: 'batch'; id: string; createdAt: unknown; batch: BatchDoc }
  | { kind: 'single'; id: string; createdAt: unknown; password: PasswordDoc };

// Cap for the baseline "most recent" query that powers the stat counters and
// the default view. When the user searches, we issue a separate array-contains
// query that is NOT subject to this cap — it's bounded by SEARCH_CAP instead.
const RESULTS_CAP = 500;
const SEARCH_CAP = 500;

// Floating info popover that explains how search works. Hover OR keyboard
// focus opens it; click-outside and Escape close it. Using framer-motion for
// a subtle scale+fade entry and a matching exit.
function SearchHelp() {
  const [open, setOpen] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const openNow = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setOpen(true);
  };
  const closeSoon = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <div
      className={styles.searchHelp}
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
    >
      <button
        type="button"
        className={styles.searchHelpButton}
        aria-label="How does search work?"
        aria-expanded={open}
        onFocus={openNow}
        onBlur={closeSoon}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="tooltip"
            className={styles.searchHelpPopover}
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className={styles.searchHelpArrow} />
            <h4>How this actually works</h4>
            <p>
              Type something. We find things that <strong>start with</strong>{' '}
              what you typed. Not inside — only the start. Firestore is very
              insistent on this.
            </p>
            <ul>
              <li>
                <code>john</code> → finds <code>john.doe@example.com</code> and{' '}
                <code>John Smith</code>
              </li>
              <li>
                <code>example</code> → finds everyone at{' '}
                <code>@example.com</code>
              </li>
              <li>
                <code>smith</code> → finds <code>Jane Smith</code>
              </li>
            </ul>
            <p className={styles.searchHelpLimit}>
              <strong>Why can't I search inside a word?</strong> Because
              Firestore is a database, not Google. It checks the start of words
              and calls it a day. Typing <code>elliott</code> won't find{' '}
              <code>helliott</code> — as far as Firestore is concerned, those
              are completely different planets. Real search (the kind that
              finds things in the middle of words) needs a whole separate
              service like Algolia or Typesense: more money, more servers, more
              things that can break at 2am. You'll survive.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function QueuePage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { batches } = useBatches();
  const [allPasswords, setAllPasswords] = useState<PasswordDoc[]>([]);
  const [searchResults, setSearchResults] = useState<PasswordDoc[] | null>(null);
  const [statCounts, setStatCounts] = useState({
    total: 0,
    pending: 0,
    sent: 0,
    viewed: 0,
    failed: 0,
    expired: 0,
    revoked: 0,
  });
  // Which batch groups are expanded, and which have a send request in flight
  // (before the batch doc's sendJob flips to "running").
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());
  const [batchSending, setBatchSending] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const showSkeleton = useDelayedLoading(loading);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [searchEmail, setSearchEmail] = useState('');
  const [debouncedSearchEmail, setDebouncedSearchEmail] = useState('');
  // Searching state: true whenever the raw input is ahead of the applied value,
  // OR while the server-side search query is in flight. Wrapped in
  // useDelayedLoading with a 500ms minimum so even an instant search still
  // feels deliberate rather than flashing on for a frame.
  const [searchFetching, setSearchFetching] = useState(false);
  const isSearching = searchEmail !== debouncedSearchEmail || searchFetching;
  const showSearching = useDelayedLoading(isSearching, {
    delayMs: 80,
    minDurationMs: 500,
  });
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const loadSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  // Client-side pagination state
  const [pageSize, setPageSize] = useState(25);
  const [pageIndex, setPageIndex] = useState(0);

  // Delete confirmation state (click-twice pattern)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const deleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (deleteTimeoutRef.current) clearTimeout(deleteTimeoutRef.current);
    };
  }, []);

  // Debounce searchEmail -> debouncedSearchEmail. Only the search value is
  // debounced; the load effect itself fires immediately on mount.
  useEffect(() => {
    if (searchEmail === debouncedSearchEmail) return;
    const timer = setTimeout(() => setDebouncedSearchEmail(searchEmail), 300);
    return () => clearTimeout(timer);
  }, [searchEmail, debouncedSearchEmail]);

  // Baseline fetch: the most recent RESULTS_CAP records across all statuses.
  // This is the default view when search is empty. Stat counters are computed
  // separately via count() aggregation queries so they reflect the whole
  // collection, not just the baseline 500. loadSeqRef guards against
  // StrictMode's duplicate-effect so only the latest fetch's result ever
  // reaches setState.
  useEffect(() => {
    loadPasswords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Server-side search effect. When the normalized search query is >= 2 chars,
  // issue a Firestore `array-contains` query on the `searchTokens` field. This
  // is NOT bounded by the 500-record baseline cap — it finds matches anywhere
  // in the collection, which is the whole point of moving search server-side.
  useEffect(() => {
    const normalized = normalizeSearchQuery(debouncedSearchEmail);
    if (!normalized) {
      setSearchResults(null);
      setSearchFetching(false);
      return;
    }

    let cancelled = false;
    const mySeq = ++searchSeqRef.current;
    setSearchFetching(true);

    (async () => {
      try {
        const passwordsRef = collection(db, 'passwords');
        const q = query(
          passwordsRef,
          where('searchTokens', 'array-contains', normalized.serverToken),
          orderBy('createdAt', 'desc'),
          limit(SEARCH_CAP)
        );
        const snapshot = await getDocs(q);
        if (cancelled || searchSeqRef.current !== mySeq) return;
        let results = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        })) as PasswordDoc[];

        // Client-side refine when the raw query has more than one word or
        // contains punctuation, e.g. "gmail.com" -> serverToken "gmail" +
        // client filter for the full "gmail.com" substring.
        if (normalized.needsClientRefine) {
          const filter = normalized.clientFilter;
          results = results.filter(
            (p) =>
              p.recipientEmail.toLowerCase().includes(filter) ||
              (p.recipientName?.toLowerCase().includes(filter) ?? false)
          );
        }

        setSearchResults(results);
      } catch (err) {
        if (cancelled || searchSeqRef.current !== mySeq) return;
        console.error('Search query failed:', err);
        showToast('Search failed — showing local results', 'error');
        // Fall back to client-side filtering over the baseline load.
        setSearchResults(null);
      } finally {
        if (!cancelled && searchSeqRef.current === mySeq) {
          setSearchFetching(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchEmail]);

  // Reset pagination when the filtered view changes.
  useEffect(() => {
    setPageIndex(0);
  }, [filterStatus, debouncedSearchEmail, pageSize]);

  // Honor the ?batch=<id> deep link from Batch Upload: expand that batch once
  // it has loaded, then drop the param so it doesn't re-trigger.
  const batchParamHandled = useRef(false);
  useEffect(() => {
    const batchParam = searchParams.get('batch');
    if (!batchParam || batchParamHandled.current) return;
    if (batches.some((b) => b.id === batchParam)) {
      batchParamHandled.current = true;
      setExpandedBatches((prev) => new Set(prev).add(batchParam));
      const next = new URLSearchParams(searchParams);
      next.delete('batch');
      setSearchParams(next, { replace: true });
    }
  }, [batches, searchParams, setSearchParams]);

  const loadPasswords = async () => {
    const mySeq = ++loadSeqRef.current;
    setLoading(true);
    // Kick off the count refresh in parallel — it's cheap and must stay in
    // sync with any mutation that triggers loadPasswords.
    loadStatCounts();
    try {
      const passwordsRef = collection(db, 'passwords');
      const q = query(
        passwordsRef,
        orderBy('createdAt', 'desc'),
        limit(RESULTS_CAP)
      );

      const snapshot = await getDocs(q);
      if (loadSeqRef.current !== mySeq) return;

      const results = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as PasswordDoc[];

      setAllPasswords(results);
    } catch (error) {
      if (loadSeqRef.current !== mySeq) return;
      console.error('Error loading passwords:', error);
    } finally {
      if (loadSeqRef.current === mySeq) setLoading(false);
    }
  };

  // True collection-wide counts via Firestore count() aggregation. Each count
  // is charged at ~1/1000 of a doc read, so six parallel counts is effectively
  // free. Called on mount and after any mutation (send/revoke/delete/bulk).
  const loadStatCounts = async () => {
    try {
      const passwordsRef = collection(db, 'passwords');
      const statuses = ['pending', 'sent', 'viewed', 'failed', 'expired', 'revoked'] as const;
      const [totalSnap, ...statusSnaps] = await Promise.all([
        getCountFromServer(query(passwordsRef)),
        ...statuses.map((s) =>
          getCountFromServer(query(passwordsRef, where('status', '==', s)))
        ),
      ]);
      setStatCounts({
        total: totalSnap.data().count,
        pending: statusSnaps[0].data().count,
        sent: statusSnaps[1].data().count,
        viewed: statusSnaps[2].data().count,
        failed: statusSnaps[3].data().count,
        expired: statusSnaps[4].data().count,
        revoked: statusSnaps[5].data().count,
      });
    } catch (error) {
      console.error('Error loading stat counts:', error);
    }
  };

  // In search mode we show a flat list of matching links (batch members
  // included) — hunting for a person shouldn't be gated behind a group.
  const isSearchMode = searchResults !== null;

  const singleMatchesFilter = (status: PasswordDoc['status']) => {
    if (filterStatus === 'all') return true;
    if (filterStatus === 'closed') return status === 'expired' || status === 'revoked';
    return status === filterStatus;
  };

  const batchMatchesFilter = (b: BatchDoc) => {
    const c = b.counts || ({} as BatchDoc['counts']);
    switch (filterStatus) {
      case 'all':
        return true;
      case 'closed':
        return (c.expired || 0) + (c.revoked || 0) > 0;
      default:
        return (c[filterStatus] || 0) > 0;
    }
  };

  // Standalone links only — batch members live under their batch group.
  const singlePasswords = useMemo(
    () => allPasswords.filter((p) => !p.batchId),
    [allPasswords]
  );

  // Non-search: interleave batch groups and single links by creation time.
  const streamItems = useMemo<StreamItem[]>(() => {
    const items: StreamItem[] = [];
    for (const b of batches) {
      if (batchMatchesFilter(b)) {
        items.push({ kind: 'batch', id: b.id, createdAt: b.createdAt, batch: b });
      }
    }
    for (const p of singlePasswords) {
      if (singleMatchesFilter(p.status)) {
        items.push({ kind: 'single', id: p.id, createdAt: p.createdAt, password: p });
      }
    }
    items.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches, singlePasswords, filterStatus]);

  // Search mode: flat, status-filtered results.
  const searchFiltered = useMemo(() => {
    if (searchResults === null) return null;
    if (filterStatus === 'all') return searchResults;
    return searchResults.filter((p) => singleMatchesFilter(p.status));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResults, filterStatus]);

  const activeLength = isSearchMode ? searchFiltered?.length ?? 0 : streamItems.length;
  const totalPages = Math.max(1, Math.ceil(activeLength / pageSize));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pageStart = safePageIndex * pageSize;
  const pageEnd = pageStart + pageSize;

  const pageStreamItems = useMemo(
    () => streamItems.slice(pageStart, pageEnd),
    [streamItems, pageStart, pageEnd]
  );
  const pageSearchResults = useMemo(
    () => (searchFiltered ? searchFiltered.slice(pageStart, pageEnd) : []),
    [searchFiltered, pageStart, pageEnd]
  );

  // Single-link ids visible on the current page — drives select-all.
  const pageSingleIds = useMemo(
    () =>
      isSearchMode
        ? pageSearchResults.map((p) => p.id)
        : pageStreamItems.filter((i) => i.kind === 'single').map((i) => i.id),
    [isSearchMode, pageSearchResults, pageStreamItems]
  );

  const isEmpty = isSearchMode
    ? pageSearchResults.length === 0
    : pageStreamItems.length === 0;
  const hasMore = safePageIndex < totalPages - 1;
  const hasPrev = safePageIndex > 0;

  const handleNextPage = () => {
    if (hasMore) setPageIndex((i) => i + 1);
  };

  const handlePrevPage = () => {
    if (hasPrev) setPageIndex((i) => Math.max(0, i - 1));
  };

  // Stats reflect the entire collection (see loadStatCounts), not just the
  // 500-record baseline load.
  const stats = statCounts;

  const allPageSelected =
    pageSingleIds.length > 0 && pageSingleIds.every((id) => selectedIds.has(id));

  const handleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageSingleIds.forEach((id) => next.delete(id));
      else pageSingleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const handleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleSendEmail = async (passwordId: string) => {
    setActionLoading(passwordId);
    try {
      const sendEmail = httpsCallable(functions, 'sendPasswordEmail');
      await sendEmail({ passwordId });
      await loadPasswords();
      showToast('Email sent successfully!', 'success');
    } catch (error: unknown) {
      console.error('Error sending email:', error);
      const firebaseError = error as { code?: string; message?: string; details?: unknown };
      const errorMessage = firebaseError.message || firebaseError.code || 'Unknown error';
      showToast(`Failed to send email: ${errorMessage}`, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  // Keep a batch's counters in sync when a member link is revoked/deleted
  // client-side. Best-effort: a counting error never blocks the main action.
  const adjustBatchCounts = async (
    batchId: string | undefined,
    changes: Record<string, ReturnType<typeof increment>>
  ) => {
    if (!batchId) return;
    try {
      await updateDoc(doc(db, 'batches', batchId), changes);
    } catch (err) {
      console.error('Failed to adjust batch counts:', err);
    }
  };

  const handleRevoke = async (password: PasswordDoc) => {
    if (!confirm('Are you sure you want to revoke this password link?')) return;

    setActionLoading(password.id);
    try {
      await updateDoc(doc(db, 'passwords', password.id), {
        status: 'revoked',
      });
      await adjustBatchCounts(password.batchId, {
        [`counts.${password.status}`]: increment(-1),
        'counts.revoked': increment(1),
      });
      await loadPasswords();
      showToast('Password link revoked', 'success');
    } catch (error) {
      console.error('Error revoking password:', error);
      showToast('Failed to revoke password', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteClick = (password: PasswordDoc) => {
    // If already confirming this item, perform the delete
    if (deleteConfirmId === password.id) {
      performDelete(password);
      return;
    }

    // Clear any existing timeout
    if (deleteTimeoutRef.current) {
      clearTimeout(deleteTimeoutRef.current);
    }

    // Set this item as pending confirmation
    setDeleteConfirmId(password.id);

    // Auto-reset after 3 seconds
    deleteTimeoutRef.current = setTimeout(() => {
      setDeleteConfirmId(null);
    }, 3000);
  };

  const performDelete = async (password: PasswordDoc) => {
    // Clear the confirmation state
    setDeleteConfirmId(null);
    if (deleteTimeoutRef.current) {
      clearTimeout(deleteTimeoutRef.current);
    }

    setActionLoading(password.id);
    try {
      await deleteDoc(doc(db, 'passwords', password.id));
      await adjustBatchCounts(password.batchId, {
        [`counts.${password.status}`]: increment(-1),
        size: increment(-1),
      });
      await loadPasswords();
      showToast('Record deleted', 'success');
    } catch (error) {
      console.error('Error deleting password:', error);
      showToast('Failed to delete password', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleBulkSend = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Send emails to ${selectedIds.size} recipients?`)) return;

    setActionLoading('bulk');
    // Per-item try/catch so one failure doesn't abort the rest of the batch —
    // and we report exactly how many succeeded/failed.
    const sendEmail = httpsCallable(functions, 'sendPasswordEmail');
    let sent = 0;
    let failed = 0;
    for (const id of selectedIds) {
      try {
        await sendEmail({ passwordId: id });
        sent += 1;
      } catch (error) {
        console.error(`Failed to send email for ${id}:`, error);
        failed += 1;
      }
    }
    setSelectedIds(new Set());
    await loadPasswords();
    setActionLoading(null);
    if (failed === 0) {
      showToast(`Sent ${sent} email${sent === 1 ? '' : 's'} successfully`, 'success');
    } else {
      showToast(`Sent ${sent}, ${failed} failed. Retry the failures individually.`, 'error');
    }
  };

  // Trigger the durable server-side batch send. Progress shows live via the
  // batch's sendJob (useBatches snapshot); this await resolves when the whole
  // job finishes for a final summary toast.
  const handleSendBatch = async (batchId: string, mode: 'remaining' | 'failed') => {
    setBatchSending((prev) => new Set(prev).add(batchId));
    try {
      // Server send can run for minutes; the callable client default is 70s.
      const sendBatchEmails = httpsCallable(functions, 'sendBatchEmails', {
        timeout: 540000,
      });
      const res = await sendBatchEmails({ batchId, mode });
      const { sent, failed } = (res.data || {}) as { sent?: number; failed?: number };
      if (failed) {
        showToast(`Batch send finished: ${sent ?? 0} sent, ${failed} failed`, 'error');
      } else {
        showToast(`Batch send finished: ${sent ?? 0} sent`, 'success');
      }
      loadStatCounts();
    } catch (error) {
      console.error('Batch send failed:', error);
      showToast('Batch send failed to start', 'error');
    } finally {
      setBatchSending((prev) => {
        const next = new Set(prev);
        next.delete(batchId);
        return next;
      });
    }
  };

  const toggleBatch = (batchId: string) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  // Clear the search and open a batch — used by the batch chip on search hits.
  const jumpToBatch = (batchId: string) => {
    setSearchEmail('');
    setExpandedBatches((prev) => new Set(prev).add(batchId));
  };

  // Batches currently mid-send drive the global "sending" strip.
  const runningBatches = useMemo(
    () => batches.filter((b) => b.sendJob?.state === 'running'),
    [batches]
  );
  const batchNameById = useMemo(() => {
    const map = new Map<string, string>();
    batches.forEach((b) => map.set(b.id, b.name));
    return map;
  }, [batches]);

  const formatDate = (date: Date | { toDate: () => Date } | undefined) => {
    if (!date) return '-';
    const d = date instanceof Date ? date : date.toDate();
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getRelativeTime = (date: Date | { toDate: () => Date } | undefined) => {
    if (!date) return '';
    const d = date instanceof Date ? date : date.toDate();
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return '';
  };

  // Renders one password link row. Used both for standalone links and for the
  // member rows revealed when a batch group is expanded (isMember indents them).
  const renderRow = (password: PasswordDoc, isMember: boolean) => (
    <tr
      key={password.id}
      className={`${selectedIds.has(password.id) ? styles.selected : ''} ${password.status === 'viewed' ? styles.rowViewed : ''} ${isMember ? styles.memberRow : ''}`}
    >
      <td className={styles.checkCol}>
        <input
          type="checkbox"
          checked={selectedIds.has(password.id)}
          onChange={() => handleSelect(password.id)}
        />
      </td>
      <td>
        <div className={styles.recipient}>
          <span className={styles.recipientName}>
            {password.recipientName || password.recipientEmail.split('@')[0]}
          </span>
          <span className={styles.recipientEmail}>{password.recipientEmail}</span>
          {!isMember && password.batchId && (
            <button
              type="button"
              className={styles.batchChip}
              onClick={() => jumpToBatch(password.batchId!)}
              title="Show this batch"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2 2 7l10 5 10-5-10-5Z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              {batchNameById.get(password.batchId) || 'Batch'}
            </button>
          )}
        </div>
      </td>
      <td>
        <div className={styles.dateInfo}>
          <span className={styles.dateMain}>{formatDate(password.createdAt)}</span>
          <span className={styles.dateRelative}>{getRelativeTime(password.createdAt)}</span>
        </div>
      </td>
      <td>
        <span className={`${styles.statusBadge} ${styles[`status-${password.status}`]}`}>
          {password.status === 'pending' && !password.emailSent && (
            <span className={styles.statusDot} />
          )}
          {password.status}
          {password.status === 'viewed' && password.viewedAt && (
            <span className={styles.statusMeta}>{formatDate(password.viewedAt)}</span>
          )}
        </span>
        {password.status === 'failed' && password.lastError && (
          <span className={styles.errorText} title={password.lastError}>
            {password.lastError}
          </span>
        )}
      </td>
      <td className={styles.actionsCol}>
        <div className={styles.actions}>
          {(password.status === 'pending' ||
            password.status === 'sent' ||
            password.status === 'failed') && (
            <>
              <button
                className={`${styles.actionBtn} ${styles.primary}`}
                onClick={() => handleSendEmail(password.id)}
                disabled={!!actionLoading}
                title={password.emailSent ? 'Resend email' : 'Send email'}
              >
                {actionLoading === password.id ? (
                  <span className={styles.spinner} />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13" />
                    <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                  </svg>
                )}
                {password.status === 'failed' ? 'Retry' : password.emailSent ? 'Resend' : 'Send'}
              </button>
              <button
                className={styles.actionBtn}
                onClick={() => handleRevoke(password)}
                disabled={!!actionLoading}
                title="Revoke link"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              </button>
            </>
          )}
          {user?.role === 'admin' && (
            <button
              className={`${styles.actionBtn} ${styles.danger} ${deleteConfirmId === password.id ? styles.confirmDelete : ''}`}
              onClick={() => handleDeleteClick(password)}
              disabled={!!actionLoading}
              title={deleteConfirmId === password.id ? 'Click again to confirm delete' : 'Delete'}
            >
              {deleteConfirmId === password.id ? (
                <span className={styles.confirmText}>Confirm?</span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3,6 5,6 21,6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              )}
            </button>
          )}
        </div>
      </td>
    </tr>
  );

  return (
    <Layout>
      <div className={styles.page}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.title}>Password Queue</h1>
            <span className={styles.subtitle}>{stats.total} total links</span>
          </div>
          <div className={styles.headerActions}>
            <Button variant="primary" onClick={() => navigate('/admin/create')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Create Link
            </Button>
          </div>
        </header>

        {/* Stats Row */}
        <div className={styles.statsRow}>
          <button
            className={`${styles.statCard} ${filterStatus === 'all' ? styles.active : ''}`}
            onClick={() => setFilterStatus('all')}
          >
            <span className={styles.statValue}>{stats.total}</span>
            <span className={styles.statLabel}>All</span>
          </button>
          <button
            className={`${styles.statCard} ${styles.pending} ${filterStatus === 'pending' ? styles.active : ''}`}
            onClick={() => setFilterStatus('pending')}
          >
            <span className={styles.statValue}>{stats.pending}</span>
            <span className={styles.statLabel}>Pending</span>
            {stats.pending > 0 && <span className={styles.statDot} />}
          </button>
          <button
            className={`${styles.statCard} ${styles.sent} ${filterStatus === 'sent' ? styles.active : ''}`}
            onClick={() => setFilterStatus('sent')}
          >
            <span className={styles.statValue}>{stats.sent}</span>
            <span className={styles.statLabel}>Sent</span>
          </button>
          <button
            className={`${styles.statCard} ${styles.viewed} ${filterStatus === 'viewed' ? styles.active : ''}`}
            onClick={() => setFilterStatus('viewed')}
          >
            <span className={styles.statValue}>{stats.viewed}</span>
            <span className={styles.statLabel}>Viewed</span>
          </button>
          <button
            className={`${styles.statCard} ${styles.failed} ${filterStatus === 'failed' ? styles.active : ''}`}
            onClick={() => setFilterStatus('failed')}
          >
            <span className={styles.statValue}>{stats.failed}</span>
            <span className={styles.statLabel}>Failed</span>
            {stats.failed > 0 && <span className={styles.statDot} />}
          </button>
          <button
            className={`${styles.statCard} ${styles.expired} ${filterStatus === 'closed' ? styles.active : ''}`}
            onClick={() => setFilterStatus('closed')}
          >
            <span className={styles.statValue}>{stats.expired + stats.revoked}</span>
            <span className={styles.statLabel}>Closed</span>
          </button>
        </div>

        {/* Search & Bulk Actions */}
        <div className={styles.toolbar}>
          <div className={styles.searchBox}>
            <div className={styles.searchIcon} aria-hidden="true">
              <AnimatePresence mode="wait" initial={false}>
                {showSearching ? (
                  <motion.svg
                    key="spin"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1, rotate: 360 }}
                    exit={{ opacity: 0, scale: 0.7 }}
                    transition={{
                      opacity: { duration: 0.15 },
                      scale: { duration: 0.15 },
                      rotate: { duration: 0.9, repeat: Infinity, ease: 'linear' },
                    }}
                  >
                    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                  </motion.svg>
                ) : (
                  <motion.svg
                    key="search"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.7 }}
                    transition={{ duration: 0.15 }}
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </motion.svg>
                )}
              </AnimatePresence>
            </div>
            <input
              type="search"
              placeholder="Start of a name or email…"
              value={searchEmail}
              onChange={(e) => setSearchEmail(e.target.value)}
              name="queue-search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
              aria-label="Search queue"
              aria-describedby="queue-search-hint"
              aria-busy={showSearching}
            />
            <span id="queue-search-hint" className={styles.srOnly}>
              Matches the start of any word in the recipient email or name. For
              example, "john" finds "john.doe@example.com" and "John Smith".
            </span>
            {searchEmail && (
              <button className={styles.clearSearch} onClick={() => setSearchEmail('')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            <SearchHelp />
          </div>

          <div className={styles.toolbarRight}>
            {selectedIds.size > 0 && (
              <div className={styles.bulkActions}>
                <span className={styles.selectedCount}>{selectedIds.size} selected</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleBulkSend}
                  loading={actionLoading === 'bulk'}
                >
                  Send All
                </Button>
                <button className={styles.clearSelection} onClick={() => setSelectedIds(new Set())}>
                  Clear
                </button>
              </div>
            )}
            <button className={styles.refreshBtn} onClick={() => loadPasswords()} title="Refresh">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23,4 23,10 17,10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>
        </div>

        {/* Global send-in-progress strip */}
        <AnimatePresence>
          {runningBatches.length > 0 && (
            <motion.div
              className={styles.sendingStrip}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
            >
              <span className={styles.sendingSpinner} />
              <span className={styles.sendingText}>
                {runningBatches.map((b, i) => {
                  const done = (b.sendJob?.sent || 0) + (b.sendJob?.failed || 0);
                  const total = b.sendJob?.total || 0;
                  return (
                    <span key={b.id}>
                      {i > 0 && ' · '}
                      Sending <strong>{b.name}</strong> — {done}/{total}
                      {b.sendJob && b.sendJob.failed > 0 && (
                        <span className={styles.sendingFailed}> ({b.sendJob.failed} failed)</span>
                      )}
                    </span>
                  );
                })}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        <motion.div
          className={styles.tableContainer}
          animate={{
            opacity: showSearching ? 0.55 : 1,
            filter: showSearching ? 'saturate(0.7)' : 'saturate(1)',
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ pointerEvents: showSearching ? 'none' : 'auto' }}
        >
          {showSkeleton ? (
            <div className={styles.skeletonTable}>
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className={styles.skeletonRow}>
                  <div className={styles.skeletonCell} style={{ width: '40px' }} />
                  <div className={styles.skeletonCell} style={{ flex: 2 }} />
                  <div className={styles.skeletonCell} style={{ flex: 1 }} />
                  <div className={styles.skeletonCell} style={{ width: '80px' }} />
                  <div className={styles.skeletonCell} style={{ width: '100px' }} />
                </div>
              ))}
            </div>
          ) : loading ? null : isEmpty ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                {debouncedSearchEmail ? (
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                ) : (
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                )}
              </div>
              {debouncedSearchEmail ? (
                <>
                  <h3>No matches for "{debouncedSearchEmail}"</h3>
                  <p className={styles.emptySearchHelp}>
                    Search matches the <strong>start</strong> of any word in the
                    recipient name or email. Try typing just the first few
                    letters — e.g. <code>john</code>, <code>smith</code>, or{' '}
                    <code>company</code>.
                  </p>
                  <div className={styles.emptyActions}>
                    <Button variant="ghost" onClick={() => setSearchEmail('')}>
                      Clear search
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h3>No password links found</h3>
                  <p>
                    {filterStatus !== 'all'
                      ? `No ${filterStatus} links. Try a different filter.`
                      : 'Create your first password link or upload a batch.'}
                  </p>
                  <div className={styles.emptyActions}>
                    <Button variant="primary" onClick={() => navigate('/admin/create')}>
                      Create Link
                    </Button>
                    <Button variant="secondary" onClick={() => navigate('/admin/batch')}>
                      Batch Upload
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.checkCol}>
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={handleSelectAll}
                    />
                  </th>
                  <th>Recipient</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th className={styles.actionsCol}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isSearchMode
                  ? pageSearchResults.map((p) => renderRow(p, false))
                  : pageStreamItems.map((item) =>
                      item.kind === 'batch' ? (
                        <BatchGroupRow
                          key={item.id}
                          batch={item.batch}
                          expanded={expandedBatches.has(item.id)}
                          sending={batchSending.has(item.id)}
                          onToggle={() => toggleBatch(item.id)}
                          onSend={(mode) => handleSendBatch(item.id, mode)}
                          renderRow={renderRow}
                          formatDate={formatDate}
                          getRelativeTime={getRelativeTime}
                        />
                      ) : (
                        renderRow(item.password, false)
                      )
                    )}
              </tbody>
            </table>
          )}
        </motion.div>

        {/* Pagination Controls */}
        {!loading && !isEmpty && (
          <div className={styles.pagination}>
            <div className={styles.paginationLeft}>
              <label className={styles.pageSizeLabel}>Show:</label>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className={styles.pageSizeSelect}
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
              <span className={styles.pageSizeLabel}>per page</span>
            </div>
            <div className={styles.paginationCenter}>
              <Button
                variant="ghost"
                size="sm"
                onClick={handlePrevPage}
                disabled={!hasPrev}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15,18 9,12 15,6" />
                </svg>
                Previous
              </Button>
              <span className={styles.pageInfo}>
                Page {safePageIndex + 1} of {totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleNextPage}
                disabled={!hasMore}
              >
                Next
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9,18 15,12 9,6" />
                </svg>
              </Button>
            </div>
            <div className={styles.paginationRight}>
              <span className={styles.itemCount}>
                {isSearchMode
                  ? `${activeLength} ${activeLength === 1 ? 'result' : 'results'}`
                  : (() => {
                      const batchCount = streamItems.filter((i) => i.kind === 'batch').length;
                      const linkCount = streamItems.length - batchCount;
                      return batchCount > 0
                        ? `${streamItems.length} items · ${batchCount} ${
                            batchCount === 1 ? 'batch' : 'batches'
                          }, ${linkCount} ${linkCount === 1 ? 'link' : 'links'}`
                        : `${linkCount} ${linkCount === 1 ? 'link' : 'links'}`;
                    })()}
              </span>
            </div>
          </div>
        )}
      </div>

    </Layout>
  );
}
