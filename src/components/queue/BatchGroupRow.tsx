import type { BatchDoc } from '../../types';
import { BatchProgressBar } from './BatchProgressBar';
import styles from './BatchGroupRow.module.css';

interface BatchGroupRowProps {
  batch: BatchDoc;
  sending: boolean;
  onOpen: () => void;
  onSend: (mode: 'remaining' | 'failed') => void;
  formatDate: (date: Date | { toDate: () => Date } | undefined) => string;
  getRelativeTime: (date: Date | { toDate: () => Date } | undefined) => string;
}

// One batch summary row in the Batches tab. Clicking it (or Open) drills into
// the dedicated, paginated batch detail page — batches are never expanded
// inline, so a 300-recipient batch can't flood the list.
export function BatchGroupRow({
  batch,
  sending,
  onOpen,
  onSend,
  formatDate,
  getRelativeTime,
}: BatchGroupRowProps) {
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

  const renderSendAction = () => {
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
    <tr className={styles.batchRow} onClick={onOpen}>
      <td />
      <td>
        <div className={styles.identity}>
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
          {renderSendAction()}
          <button className={styles.openBtn} onClick={onOpen}>
            Open
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <polyline points="9,6 15,12 9,18" />
            </svg>
          </button>
        </div>
      </td>
    </tr>
  );
}
