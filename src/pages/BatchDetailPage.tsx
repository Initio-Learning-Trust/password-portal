import { useState, useMemo, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, updateDoc, deleteDoc, increment } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../services/firebase';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/common/Toast';
import { useBatches } from '../hooks/useBatches';
import { useBatchMembers } from '../hooks/useBatchMembers';
import { Layout } from '../components/layout/Layout';
import { Button } from '../components/common/Button';
import { BatchProgressBar } from '../components/queue/BatchProgressBar';
import { ViewedTooltip } from '../components/queue/ViewedTooltip';
import type { PasswordDoc } from '../types';
import styles from './BatchDetailPage.module.css';
import q from './QueuePage.module.css';

type FilterStatus = 'all' | 'pending' | 'sent' | 'viewed' | 'failed' | 'closed';
const FILTERS: FilterStatus[] = ['all', 'pending', 'sent', 'viewed', 'failed', 'closed'];

function formatDate(date: Date | { toDate: () => Date } | undefined) {
  if (!date) return '-';
  const d = date instanceof Date ? date : date.toDate();
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getRelativeTime(date: Date | { toDate: () => Date } | undefined) {
  if (!date) return '';
  const d = date instanceof Date ? date : date.toDate();
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return '';
}

export function BatchDetailPage() {
  const { batchId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showToast } = useToast();
  const { batches, loading: batchesLoading } = useBatches();
  const { members, loading: membersLoading } = useBatchMembers(batchId ?? null);

  const batch = batches.find((b) => b.id === batchId);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [pageSize, setPageSize] = useState(25);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [batchSending, setBatchSending] = useState(false);
  const deleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (deleteTimeoutRef.current) clearTimeout(deleteTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    setPageIndex(0);
  }, [search, statusFilter, pageSize]);

  const filtered = useMemo(() => {
    let list = members;
    const s = search.trim().toLowerCase();
    if (s) {
      list = list.filter(
        (m) =>
          m.recipientEmail.toLowerCase().includes(s) ||
          (m.recipientName?.toLowerCase().includes(s) ?? false)
      );
    }
    if (statusFilter !== 'all') {
      list = list.filter((m) =>
        statusFilter === 'closed'
          ? m.status === 'expired' || m.status === 'revoked'
          : m.status === statusFilter
      );
    }
    return list;
  }, [members, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pageMembers = useMemo(
    () => filtered.slice(safePageIndex * pageSize, (safePageIndex + 1) * pageSize),
    [filtered, safePageIndex, pageSize]
  );
  const pageIds = pageMembers.map((m) => m.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  // Best-effort batch counter adjustment (mirrors the queue's client updates).
  const adjustCounts = async (changes: Record<string, ReturnType<typeof increment>>) => {
    if (!batchId) return;
    try {
      await updateDoc(doc(db, 'batches', batchId), changes);
    } catch (err) {
      console.error('Failed to adjust batch counts:', err);
    }
  };

  const handleSendEmail = async (id: string) => {
    setActionLoading(id);
    try {
      await httpsCallable(functions, 'sendPasswordEmail')({ passwordId: id });
      showToast('Email sent', 'success');
    } catch (error: unknown) {
      const e = error as { message?: string };
      showToast(`Failed to send: ${e.message || 'error'}`, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevoke = async (p: PasswordDoc) => {
    if (!confirm('Revoke this password link?')) return;
    setActionLoading(p.id);
    try {
      await updateDoc(doc(db, 'passwords', p.id), { status: 'revoked' });
      await adjustCounts({
        [`counts.${p.status}`]: increment(-1),
        'counts.revoked': increment(1),
      });
      showToast('Link revoked', 'success');
    } catch {
      showToast('Failed to revoke', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteClick = (p: PasswordDoc) => {
    if (deleteConfirmId === p.id) {
      performDelete(p);
      return;
    }
    if (deleteTimeoutRef.current) clearTimeout(deleteTimeoutRef.current);
    setDeleteConfirmId(p.id);
    deleteTimeoutRef.current = setTimeout(() => setDeleteConfirmId(null), 3000);
  };

  const performDelete = async (p: PasswordDoc) => {
    setDeleteConfirmId(null);
    if (deleteTimeoutRef.current) clearTimeout(deleteTimeoutRef.current);
    setActionLoading(p.id);
    try {
      await deleteDoc(doc(db, 'passwords', p.id));
      await adjustCounts({
        [`counts.${p.status}`]: increment(-1),
        size: increment(-1),
      });
      showToast('Record deleted', 'success');
    } catch {
      showToast('Failed to delete', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleBulkSend = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Send emails to ${selectedIds.size} recipients?`)) return;
    setActionLoading('bulk');
    const send = httpsCallable(functions, 'sendPasswordEmail');
    let sent = 0;
    let failed = 0;
    for (const id of selectedIds) {
      try {
        await send({ passwordId: id });
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    setSelectedIds(new Set());
    setActionLoading(null);
    showToast(
      failed === 0 ? `Sent ${sent} emails` : `Sent ${sent}, ${failed} failed`,
      failed === 0 ? 'success' : 'error'
    );
  };

  const handleSendBatch = async (mode: 'remaining' | 'failed') => {
    if (!batchId) return;
    setBatchSending(true);
    try {
      const res = await httpsCallable(functions, 'sendBatchEmails', { timeout: 540000 })({
        batchId,
        mode,
      });
      const { sent, failed } = (res.data || {}) as { sent?: number; failed?: number };
      showToast(
        failed ? `Sent ${sent ?? 0}, ${failed} failed` : `Sent ${sent ?? 0}`,
        failed ? 'error' : 'success'
      );
    } catch {
      showToast('Batch send failed', 'error');
    } finally {
      setBatchSending(false);
    }
  };

  const handleExport = () => {
    const origin = window.location.origin;
    const csv = [
      'email,name,status,link',
      ...members.map(
        (m) =>
          `${m.recipientEmail},${m.recipientName || ''},${m.status},${origin}/p/${m.id}`
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${batch?.name || 'batch'}-recipients.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const goBack = () => navigate('/admin/queue?tab=batches');

  if (!batch) {
    return (
      <Layout>
        <div className={styles.page}>
          <button className={styles.back} onClick={goBack}>
            ← Back to queue
          </button>
          <div className={styles.notFound}>
            {batchesLoading ? 'Loading batch…' : 'Batch not found.'}
          </div>
        </div>
      </Layout>
    );
  }

  const counts = batch.counts;
  const running = batch.sendJob?.state === 'running';
  const busy = running || batchSending;

  const renderHeaderAction = () => {
    if (busy) {
      const done = (batch.sendJob?.sent || 0) + (batch.sendJob?.failed || 0);
      const total = batch.sendJob?.total || 0;
      return (
        <span className={styles.sending}>
          <span className={styles.spinner} />
          {total ? `Sending ${done}/${total}…` : 'Sending…'}
        </span>
      );
    }
    if (counts.failed > 0) {
      return (
        <button className={`${styles.primaryBtn} ${styles.retryBtn}`} onClick={() => handleSendBatch('failed')}>
          Retry {counts.failed} failed
        </button>
      );
    }
    if (counts.pending > 0) {
      return (
        <button className={styles.primaryBtn} onClick={() => handleSendBatch('remaining')}>
          Send {counts.pending} remaining
        </button>
      );
    }
    return <span className={styles.done}>All sent</span>;
  };

  const renderRow = (p: PasswordDoc) => (
    <tr
      key={p.id}
      className={`${selectedIds.has(p.id) ? q.selected : ''} ${p.status === 'viewed' ? q.rowViewed : ''}`}
    >
      <td className={q.checkCol}>
        <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelect(p.id)} />
      </td>
      <td>
        <div className={q.recipient}>
          <span className={q.recipientName}>
            {p.recipientName || p.recipientEmail.split('@')[0]}
          </span>
          <span className={q.recipientEmail}>{p.recipientEmail}</span>
        </div>
      </td>
      <td>
        <div className={q.dateInfo}>
          <span className={q.dateMain}>{formatDate(p.createdAt)}</span>
          <span className={q.dateRelative}>{getRelativeTime(p.createdAt)}</span>
        </div>
      </td>
      <td>
        {p.status === 'viewed' && p.viewedAt ? (
          <ViewedTooltip viewedAt={p.viewedAt} viewedFromIP={p.viewedFromIP}>
            <span className={`${q.statusBadge} ${q['status-viewed']} viewedInteractive`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              viewed
            </span>
          </ViewedTooltip>
        ) : (
          <span className={`${q.statusBadge} ${q[`status-${p.status}`]}`}>
            {p.status === 'pending' && !p.emailSent && <span className={q.statusDot} />}
            {p.status}
          </span>
        )}
        {p.status === 'failed' && p.lastError && (
          <span className={q.errorText} title={p.lastError}>
            {p.lastError}
          </span>
        )}
      </td>
      <td className={q.actionsCol}>
        <div className={q.actions}>
          {(p.status === 'pending' || p.status === 'sent' || p.status === 'failed') && (
            <>
              <button
                className={`${q.actionBtn} ${q.primary}`}
                onClick={() => handleSendEmail(p.id)}
                disabled={!!actionLoading}
                title={p.emailSent ? 'Resend email' : 'Send email'}
              >
                {actionLoading === p.id ? (
                  <span className={q.spinner} />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13" />
                    <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                  </svg>
                )}
                {p.status === 'failed' ? 'Retry' : p.emailSent ? 'Resend' : 'Send'}
              </button>
              <button
                className={q.actionBtn}
                onClick={() => handleRevoke(p)}
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
              className={`${q.actionBtn} ${q.danger} ${deleteConfirmId === p.id ? q.confirmDelete : ''}`}
              onClick={() => handleDeleteClick(p)}
              disabled={!!actionLoading}
              title={deleteConfirmId === p.id ? 'Click again to confirm' : 'Delete'}
            >
              {deleteConfirmId === p.id ? (
                <span className={q.confirmText}>Confirm?</span>
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
        <button className={styles.back} onClick={goBack}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <polyline points="15,18 9,12 15,6" />
          </svg>
          Back to queue
        </button>

        {/* Header */}
        <div className={styles.headerCard}>
          <div className={styles.headerTop}>
            <div className={styles.titleWrap}>
              <svg className={styles.icon} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 2 2 7l10 5 10-5-10-5Z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              <div>
                <h1 className={styles.title}>{batch.name}</h1>
                <div className={styles.meta}>
                  {batch.size} recipients · created {formatDate(batch.createdAt)}
                  {batch.createdByEmail ? ` · by ${batch.createdByEmail}` : ''}
                </div>
              </div>
            </div>
            <div className={styles.headerActions}>{renderHeaderAction()}</div>
          </div>

          <div className={styles.progressRow}>
            <BatchProgressBar counts={counts} size={batch.size} running={running} />
            <div className={styles.countLine}>
              {counts.sent} sent · {counts.viewed} viewed · {counts.pending} pending
              {counts.failed > 0 && (
                <span className={styles.failedCount}> · {counts.failed} failed</span>
              )}
              {(counts.expired > 0 || counts.revoked > 0) &&
                ` · ${counts.expired + counts.revoked} closed`}
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              placeholder="Search this batch by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search batch recipients"
            />
          </div>
          <button className={styles.exportBtn} onClick={handleExport}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7,10 12,15 17,10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export CSV
          </button>
        </div>

        <div className={styles.filters}>
          {FILTERS.map((f) => (
            <button
              key={f}
              className={`${styles.chip} ${statusFilter === f ? styles.chipActive : ''}`}
              onClick={() => setStatusFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>

        {selectedIds.size > 0 && (
          <div className={styles.bulkBar}>
            <span>{selectedIds.size} selected</span>
            <Button variant="secondary" size="sm" onClick={handleBulkSend} loading={actionLoading === 'bulk'}>
              Send selected
            </Button>
            <button className={styles.back} onClick={() => setSelectedIds(new Set())}>
              Clear
            </button>
          </div>
        )}

        {/* Members table */}
        <div className={q.tableContainer}>
          {membersLoading && members.length === 0 ? (
            <div className={q.emptyState}>Loading recipients…</div>
          ) : pageMembers.length === 0 ? (
            <div className={q.emptyState}>
              <h3>No matching recipients</h3>
              <p>Try a different search or filter.</p>
            </div>
          ) : (
            <table className={q.table}>
              <thead>
                <tr>
                  <th className={q.checkCol}>
                    <input type="checkbox" checked={allPageSelected} onChange={toggleSelectAll} />
                  </th>
                  <th>Recipient</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th className={q.actionsCol}>Actions</th>
                </tr>
              </thead>
              <tbody>{pageMembers.map(renderRow)}</tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {filtered.length > 0 && (
          <div className={q.pagination}>
            <div className={q.paginationLeft}>
              <label className={q.pageSizeLabel}>Show:</label>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className={q.pageSizeSelect}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
              <span className={q.pageSizeLabel}>per page</span>
            </div>
            <div className={q.paginationCenter}>
              <Button variant="ghost" size="sm" onClick={() => setPageIndex((i) => Math.max(0, i - 1))} disabled={safePageIndex === 0}>
                Previous
              </Button>
              <span className={q.pageInfo}>
                Page {safePageIndex + 1} of {totalPages}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setPageIndex((i) => i + 1)} disabled={safePageIndex >= totalPages - 1}>
                Next
              </Button>
            </div>
            <div className={q.paginationRight}>
              <span className={q.itemCount}>
                {filtered.length} of {members.length} recipients
              </span>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
