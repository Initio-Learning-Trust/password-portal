import type { ReactNode } from 'react';
import type { BatchDoc, PasswordDoc } from '../../types';
import { useBatchMembers } from '../../hooks/useBatchMembers';
import { BatchProgressBar } from './BatchProgressBar';
import styles from './BatchGroupRow.module.css';

interface BatchGroupRowProps {
  batch: BatchDoc;
  expanded: boolean;
  sending: boolean;
  onToggle: () => void;
  onSend: (mode: 'remaining' | 'failed') => void;
  renderRow: (password: PasswordDoc, isMember: boolean) => ReactNode;
  formatDate: (date: Date | { toDate: () => Date } | undefined) => string;
  getRelativeTime: (date: Date | { toDate: () => Date } | undefined) => string;
}

export function BatchGroupRow({
  batch,
  expanded,
  sending,
  onToggle,
  onSend,
  renderRow,
  formatDate,
  getRelativeTime,
}: BatchGroupRowProps) {
  const { members, loading: membersLoading } = useBatchMembers(
    expanded ? batch.id : null
  );
  const counts = batch.counts || {
    pending: 0,
    sent: 0,
    viewed: 0,
    failed: 0,
    expired: 0,
    revoked: 0,
  };
  const running = batch.sendJob?.state === 'running';
  const busy = running || sending;

  const renderAction = () => {
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
        <button
          className={`${styles.primaryBtn} ${styles.retryBtn}`}
          onClick={(e) => {
            e.stopPropagation();
            onSend('failed');
          }}
        >
          Retry {counts.failed} failed
        </button>
      );
    }
    if (counts.pending > 0) {
      return (
        <button
          className={styles.primaryBtn}
          onClick={(e) => {
            e.stopPropagation();
            onSend('remaining');
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 2L11 13" />
            <path d="M22 2L15 22L11 13L2 9L22 2Z" />
          </svg>
          Send {counts.pending}
        </button>
      );
    }
    return <span className={styles.done}>All sent</span>;
  };

  return (
    <>
      <tr className={styles.batchRow} onClick={onToggle}>
        <td />
        <td>
          <div className={styles.identity}>
            <svg
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polyline points="9,6 15,12 9,18" />
            </svg>
            <svg className={styles.icon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2 2 7l10 5 10-5-10-5Z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            <div className={styles.nameWrap}>
              <span className={styles.name}>
                {batch.name}
                <span className={styles.size}>{batch.size} recipients</span>
              </span>
              {batch.createdByEmail && (
                <span className={styles.creator}>by {batch.createdByEmail}</span>
              )}
            </div>
          </div>
        </td>
        <td>
          <div>
            <div>{formatDate(batch.createdAt)}</div>
            <div className={styles.creator}>{getRelativeTime(batch.createdAt)}</div>
          </div>
        </td>
        <td>
          <div className={styles.statusCell}>
            <BatchProgressBar counts={counts} size={batch.size} running={running} />
            <span className={styles.countLine}>
              {counts.sent} sent · {counts.viewed} viewed · {counts.pending} pending
              {counts.failed > 0 && (
                <span className={styles.failedCount}> · {counts.failed} failed</span>
              )}
            </span>
          </div>
        </td>
        <td>
          <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
            {renderAction()}
          </div>
        </td>
      </tr>
      {expanded &&
        (membersLoading && members.length === 0 ? (
          <tr>
            <td />
            <td colSpan={4} className={styles.creator} style={{ padding: '0.75rem 0' }}>
              Loading recipients…
            </td>
          </tr>
        ) : (
          members.map((m) => renderRow(m, true))
        ))}
    </>
  );
}
