import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './ViewedTooltip.module.css';

type DateLike = Date | { toDate: () => Date };

function asDate(value: DateLike): Date {
  return value instanceof Date ? value : value.toDate();
}

// A precise, human date: "12 July 2026 at 14:32".
function formatFull(d: Date): string {
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${date} at ${time}`;
}

// Relative time that keeps going past a week (unlike the row's short version).
function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

// Wraps the "viewed" status badge and shows an animated tooltip on hover/focus
// with exactly when — and from where — the recipient opened their link.
// Rendered through a portal so the queue's clipped, scrollable table can't crop
// it.
export function ViewedTooltip({
  viewedAt,
  viewedFromIP,
  children,
}: {
  viewedAt: DateLike;
  viewedFromIP?: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ x: r.left + r.width / 2, y: r.top - 8 });
  };
  const hide = () => setCoords(null);

  const date = asDate(viewedAt);

  return (
    <span
      ref={anchorRef}
      className={styles.anchor}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {createPortal(
        <AnimatePresence>
          {coords && (
            <motion.div
              className={styles.popover}
              style={{ left: coords.x, top: coords.y }}
              initial={{ opacity: 0, y: 4, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.94 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              role="tooltip"
            >
              <div className={styles.head}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                Opened by recipient
              </div>
              <div className={styles.date}>{formatFull(date)}</div>
              <div className={styles.relative}>{formatRelative(date)}</div>
              {viewedFromIP && viewedFromIP !== 'unknown' && (
                <div className={styles.ip}>from {viewedFromIP}</div>
              )}
              <span className={styles.arrow} />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </span>
  );
}
