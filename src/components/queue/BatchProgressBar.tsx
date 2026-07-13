import type { BatchDoc } from '../../types';
import styles from './BatchProgressBar.module.css';

// Segmented delivery bar for a batch: viewed | sent | pending | failed,
// proportional to the batch size. Closed (expired/revoked) links just fall out
// of the bar as empty track.
export function BatchProgressBar({
  counts,
  size,
  running,
}: {
  counts: BatchDoc['counts'];
  size: number;
  running?: boolean;
}) {
  const total = Math.max(size, 1);
  const pct = (n: number) => `${(Math.max(0, n || 0) / total) * 100}%`;

  return (
    <div className={styles.bar} role="presentation">
      <div className={`${styles.seg} ${styles.viewed}`} style={{ width: pct(counts.viewed) }} />
      <div className={`${styles.seg} ${styles.sent}`} style={{ width: pct(counts.sent) }} />
      <div
        className={`${styles.seg} ${styles.pending} ${running ? styles.running : ''}`}
        style={{ width: pct(counts.pending) }}
      />
      <div className={`${styles.seg} ${styles.failed}`} style={{ width: pct(counts.failed) }} />
    </div>
  );
}
