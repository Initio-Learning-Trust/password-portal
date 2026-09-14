import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { Layout } from '../components/layout/Layout';
import { Card, CardContent } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { PasswordList } from '../components/common/PasswordList';
import { generatePassword, type PasswordMode } from '../utils/passwordGenerator';
import { useWordLists } from '../hooks/useWordLists';
import { useToast } from '../components/common/Toast';
import type { GeneratedPassword } from '../types';
import styles from './GeneratePasswordsPage.module.css';

let nextId = 0;

function generateBatchPasswords(
  count: number,
  words: string[],
  mode: PasswordMode
): GeneratedPassword[] {
  return Array.from({ length: count }, () => ({
    id: String(++nextId),
    value: generatePassword(words, mode),
    copied: false,
  }));
}

// Single source of truth for how each style is described. The hero card and
// the batch chooser both render from this, so they cannot drift apart.
const MODES: { id: PasswordMode; name: string; example: string; desc: string }[] = [
  { id: 'simple', name: 'Simple', example: 'TreeBridge47', desc: 'Easy to remember' },
  { id: 'secure', name: 'Secure', example: 'Movie3Cartoon)Bottle', desc: 'Higher entropy' },
  { id: 'word4', name: 'Word + 4 digits', example: 'Tiger4829', desc: 'Short and simple' },
];

const COUNT_PRESETS = [5, 10, 25, 50, 100];
const MIN_COUNT = 1;
const MAX_COUNT = 1000;
// The slider covers the common range only; larger counts are typed. A 1–1000
// linear slider would bury every useful value in the first 10% of the track.
const SLIDER_MAX = 100;

export function GeneratePasswordsPage() {
  const { showToast } = useToast();
  // Words come from the lists configured in Settings; there is no built-in
  // fallback, so every generate path below is gated on `canGenerate`.
  const { words, loading: wordsLoading, error: wordsError } = useWordLists();
  const canGenerate = words.length > 0;
  const [count, setCount] = useState(10);
  const [mode, setMode] = useState<PasswordMode>('simple');
  const [passwords, setPasswords] = useState<GeneratedPassword[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const hasResults = passwords.length > 0;

  // Click-to-generate hero. Seeded as soon as the word lists arrive so the
  // page opens with a usable password; null until then, because there is
  // nothing to generate from. Generated locally rather than through the API: a
  // reroll should feel instant, and there is no reason to spend a network
  // round-trip on something that takes microseconds.
  const [hero, setHero] = useState<string | null>(null);
  const [heroCopied, setHeroCopied] = useState(false);
  const heroCopyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(heroCopyTimer.current), []);

  const rerollHero = useCallback(
    (nextMode: PasswordMode) => {
      if (words.length === 0) return;
      setHero(generatePassword(words, nextMode));
      setHeroCopied(false);
      window.clearTimeout(heroCopyTimer.current);
    },
    [words]
  );

  // Seed the hero as soon as words are available. Re-runs if the lists change
  // under us (an admin saving an edit in another tab), so what is on screen is
  // always drawn from the current vocabulary.
  useEffect(() => {
    if (words.length === 0) {
      setHero(null);
      return;
    }
    setHero(generatePassword(words, mode));
    // `mode` is handled by selectMode, which rerolls explicitly; re-seeding on
    // every mode change here would double-roll the hero.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words]);

  // Style selection is shared: picking a style anywhere on the page updates
  // both the hero and the batch controls, and rerolls the hero so what is on
  // screen always matches the selected style.
  const selectMode = useCallback(
    (next: PasswordMode) => {
      setMode(next);
      rerollHero(next);
    },
    [rerollHero]
  );

  const handleCopyHero = async () => {
    if (!hero) return;
    try {
      await navigator.clipboard.writeText(hero);
      setHeroCopied(true);
      window.clearTimeout(heroCopyTimer.current);
      heroCopyTimer.current = window.setTimeout(() => setHeroCopied(false), 1500);
    } catch {
      showToast('Failed to copy', 'error');
    }
  };

  const handleGenerate = () => {
    if (!canGenerate) return;
    setIsGenerating(true);
    // Yield so the button press animation has time to render
    requestAnimationFrame(() => {
      setPasswords(generateBatchPasswords(count, words, mode));
      setIsGenerating(false);
    });
  };

  const handleCopy = async (id: string) => {
    const pw = passwords.find((p) => p.id === id);
    if (!pw) return;
    try {
      await navigator.clipboard.writeText(pw.value);
      setPasswords((prev) =>
        prev.map((p) => (p.id === id ? { ...p, copied: true } : p))
      );
      setTimeout(() => {
        setPasswords((prev) =>
          prev.map((p) => (p.id === id ? { ...p, copied: false } : p))
        );
      }, 1500);
    } catch {
      showToast('Failed to copy', 'error');
    }
  };

  const handleCopyAll = async () => {
    try {
      const text = passwords.map((p) => p.value).join('\n');
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${passwords.length} passwords to clipboard`, 'success');
    } catch {
      showToast('Failed to copy', 'error');
    }
  };

  const handleRegenerate = (id: string) => {
    if (!canGenerate) return;
    setPasswords((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, value: generatePassword(words, mode), copied: false }
          : p
      )
    );
  };

  const handleClear = () => {
    setPasswords([]);
  };

  // The text input keeps its own draft string so the user can freely clear
  // and retype (e.g. delete "1" to type "23") without the value snapping back
  // mid-keystroke. The numeric `count` is only committed on blur/Enter.
  const [draft, setDraft] = useState(String(count));
  // Mirror of `count` for hold-to-repeat timers, which would otherwise close
  // over a stale value.
  const countRef = useRef(count);
  const repeatRef = useRef<{ timeout?: number; interval?: number }>({});

  const clamp = (value: number) =>
    Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(value)));

  // Single source of truth for changing the count: keeps state, the ref, and
  // the input draft in sync.
  const applyCount = (value: number) => {
    const clamped = clamp(value);
    countRef.current = clamped;
    setCount(clamped);
    setDraft(String(clamped));
  };

  // Fold any uncommitted typed value into `count`, returning the base to step
  // from. Falls back to the last committed count if the draft isn't a number.
  const stepBase = () => (/^\d+$/.test(draft) ? clamp(Number(draft)) : count);

  const step = (delta: number) => applyCount(stepBase() + delta);

  const stopRepeat = () => {
    window.clearTimeout(repeatRef.current.timeout);
    window.clearInterval(repeatRef.current.interval);
    repeatRef.current = {};
  };

  // Press-and-hold on the +/- buttons to continuously step.
  const startRepeat = (delta: number) => {
    countRef.current = stepBase();
    applyCount(countRef.current + delta);
    repeatRef.current.timeout = window.setTimeout(() => {
      repeatRef.current.interval = window.setInterval(
        () => applyCount(countRef.current + delta),
        60
      );
    }, 400);
  };

  // Clean up any running timers on unmount.
  useEffect(() => stopRepeat, []);

  const handleDraftChange = (value: string) => {
    // Allow only digits or an empty field while typing; validate on commit.
    if (value === '' || /^\d+$/.test(value)) setDraft(value);
  };

  const commitDraft = () => applyCount(stepBase());

  const handleCountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitDraft();
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(e.shiftKey ? 10 : 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(e.shiftKey ? -10 : -1);
    }
  };

  // Why the generator is unavailable, or null when it is fine (including while
  // the lists are still loading — that resolves on its own in a moment).
  const noWordsMessage = useMemo(() => {
    if (canGenerate || wordsLoading) return null;
    if (wordsError) {
      return {
        title: 'Could not load the word lists',
        body: 'Passwords are built from the word lists in Settings, and those could not be read just now. Reload the page to try again.',
      };
    }
    return {
      title: 'No word lists configured',
      body: 'Passwords are built from the word lists in Settings. Add a list there and it will be used here straight away.',
    };
  }, [canGenerate, wordsLoading, wordsError]);

  const sliderFill = useMemo(
    () =>
      `${Math.min(100, ((count - MIN_COUNT) / (SLIDER_MAX - MIN_COUNT)) * 100)}%`,
    [count]
  );

  return (
    <Layout>
      <LayoutGroup>
        <motion.div
          className={styles.page}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <header className={styles.header}>
            <h1 className={styles.title}>Password Generator</h1>
            <p className={styles.subtitle}>
              Click for a single password, or generate a batch and copy them into a spreadsheet.
            </p>
          </header>

          <Card className={styles.heroCard}>
            <CardContent>
              <div className={styles.hero}>
                {noWordsMessage ? (
                  <div className={styles.noWords} role="status">
                    <h2 className={styles.noWordsTitle}>{noWordsMessage.title}</h2>
                    <p className={styles.noWordsBody}>{noWordsMessage.body}</p>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.heroPassword}
                      onClick={handleCopyHero}
                      disabled={!hero}
                      aria-label={hero ? `Copy password ${hero}` : 'Loading word lists'}
                    >
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.span
                          key={hero ?? 'loading'}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                        >
                          {hero ?? '\u2026'}
                        </motion.span>
                      </AnimatePresence>
                    </button>

                    {/* Announces each new password, and the copy confirmation, to
                        screen readers without stealing focus. */}
                    <p className={styles.heroStatus} aria-live="polite">
                      {heroCopied ? 'Copied to clipboard' : 'Click the password to copy it'}
                    </p>
                  </>
                )}

                <Button
                  variant="primary"
                  onClick={() => rerollHero(mode)}
                  disabled={!canGenerate}
                >
                  Another password, please
                </Button>

                <div
                  className={styles.heroStyles}
                  role="radiogroup"
                  aria-label="Password style"
                >
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={mode === m.id}
                      className={`${styles.heroStyleBtn} ${mode === m.id ? styles.heroStyleActive : ''}`}
                      onClick={() => selectMode(m.id)}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <motion.div layout transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
            <Card className={styles.controlsCard}>
              <CardContent>
                <div className={styles.controlsGrid}>
                  <div className={styles.fieldCount}>
                    <div className={styles.labelRow}>
                      <label htmlFor="count-input" className={styles.label}>
                        How many?
                      </label>
                      <div className={styles.stepper}>
                        <button
                          type="button"
                          className={styles.stepperBtn}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            startRepeat(-1);
                          }}
                          onPointerUp={stopRepeat}
                          onPointerLeave={stopRepeat}
                          onPointerCancel={stopRepeat}
                          disabled={count <= MIN_COUNT}
                          tabIndex={-1}
                          aria-label="Decrease count"
                        >
                          &minus;
                        </button>
                        <input
                          id="count-input"
                          type="text"
                          inputMode="numeric"
                          role="spinbutton"
                          aria-valuenow={count}
                          aria-valuemin={MIN_COUNT}
                          aria-valuemax={MAX_COUNT}
                          aria-describedby="count-help"
                          value={draft}
                          onChange={(e) => handleDraftChange(e.target.value)}
                          onKeyDown={handleCountKeyDown}
                          onBlur={commitDraft}
                          onFocus={(e) => e.currentTarget.select()}
                          className={styles.countInput}
                          aria-label="Number of passwords"
                        />
                        <button
                          type="button"
                          className={styles.stepperBtn}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            startRepeat(1);
                          }}
                          onPointerUp={stopRepeat}
                          onPointerLeave={stopRepeat}
                          onPointerCancel={stopRepeat}
                          disabled={count >= MAX_COUNT}
                          tabIndex={-1}
                          aria-label="Increase count"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <span id="count-help" className={styles.srOnly}>
                      Enter a number between {MIN_COUNT} and {MAX_COUNT}. Use the
                      arrow keys to adjust, or hold Shift for steps of 10.
                    </span>
                    <input
                      type="range"
                      min={MIN_COUNT}
                      max={SLIDER_MAX}
                      value={Math.min(count, SLIDER_MAX)}
                      onChange={(e) => applyCount(Number(e.target.value))}
                      className={styles.slider}
                      style={{ '--fill': sliderFill } as React.CSSProperties}
                      aria-label="Number of passwords slider"
                    />
                    <div className={styles.presets}>
                      {COUNT_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={`${styles.presetBtn} ${count === preset ? styles.presetActive : ''}`}
                          onClick={() => applyCount(preset)}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={styles.fieldMode}>
                    <span className={styles.label}>Password style</span>
                    <div className={styles.modeButtons} role="radiogroup" aria-label="Password style">
                      {MODES.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          role="radio"
                          aria-checked={mode === m.id}
                          className={`${styles.modeBtn} ${mode === m.id ? styles.modeActive : ''}`}
                          onClick={() => selectMode(m.id)}
                        >
                          <span className={styles.modeName}>{m.name}</span>
                          <span className={styles.modeExample}>{m.example}</span>
                          <span className={styles.modeDesc}>{m.desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.actionsRow}>
                  <Button
                    variant="primary"
                    onClick={handleGenerate}
                    loading={isGenerating}
                    disabled={!canGenerate}
                  >
                    Generate {count} password{count !== 1 ? 's' : ''}
                  </Button>
                  {hasResults && (
                    <Button variant="ghost" onClick={handleClear}>
                      Clear
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.div>

          <AnimatePresence mode="wait">
            {hasResults && (
              <motion.div
                key="results"
                layout
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <Card className={styles.resultsCard}>
                  <CardContent>
                    <PasswordList
                      passwords={passwords}
                      onCopy={handleCopy}
                      onCopyAll={handleCopyAll}
                      onRegenerate={handleRegenerate}
                    />
                    <div className={styles.hint}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span>Click "Copy All" to copy every password (one per line) into a spreadsheet.</span>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </LayoutGroup>
    </Layout>
  );
}
