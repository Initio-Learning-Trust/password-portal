import { useState, useMemo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { Layout } from '../components/layout/Layout';
import { Card, CardContent } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { PasswordList } from '../components/common/PasswordList';
import { generatePassword, type PasswordMode } from '../utils/passwordGenerator';
import { useToast } from '../components/common/Toast';
import type { GeneratedPassword } from '../types';
import styles from './GeneratePasswordsPage.module.css';

let nextId = 0;

function generateBatchPasswords(count: number, mode: PasswordMode): GeneratedPassword[] {
  return Array.from({ length: count }, () => ({
    id: String(++nextId),
    value: generatePassword({ mode }),
    copied: false,
  }));
}

const COUNT_PRESETS = [5, 10, 25, 50, 100];
const MIN_COUNT = 1;
const MAX_COUNT = 1000;

export function GeneratePasswordsPage() {
  const { showToast } = useToast();
  const [count, setCount] = useState(10);
  const [mode, setMode] = useState<PasswordMode>('simple');
  const [passwords, setPasswords] = useState<GeneratedPassword[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const hasResults = passwords.length > 0;

  const handleGenerate = () => {
    setIsGenerating(true);
    // Yield so the button press animation has time to render
    requestAnimationFrame(() => {
      setPasswords(generateBatchPasswords(count, mode));
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
    setPasswords((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, value: generatePassword({ mode }), copied: false }
          : p
      )
    );
  };

  const handleClear = () => {
    setPasswords([]);
  };

  const handleCountChange = (value: number) => {
    const clamped = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(value)));
    setCount(clamped);
  };

  const sliderFill = useMemo(
    () => `${((count - MIN_COUNT) / (MAX_COUNT - MIN_COUNT)) * 100}%`,
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
              Generate a batch of passwords, then copy them into a spreadsheet or paste individually.
            </p>
          </header>

          <motion.div layout transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
            <Card className={styles.controlsCard}>
              <CardContent>
                <div className={styles.controlsGrid}>
                  <div className={styles.fieldCount}>
                    <div className={styles.labelRow}>
                      <label htmlFor="count-input" className={styles.label}>
                        How many?
                      </label>
                      <input
                        id="count-input"
                        type="number"
                        min={MIN_COUNT}
                        max={MAX_COUNT}
                        value={count}
                        onChange={(e) => handleCountChange(Number(e.target.value))}
                        className={styles.countInput}
                        aria-label="Number of passwords"
                      />
                    </div>
                    <input
                      type="range"
                      min={MIN_COUNT}
                      max={MAX_COUNT}
                      value={count}
                      onChange={(e) => handleCountChange(Number(e.target.value))}
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
                          onClick={() => handleCountChange(preset)}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={styles.fieldMode}>
                    <span className={styles.label}>Password style</span>
                    <div className={styles.modeButtons} role="radiogroup" aria-label="Password style">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={mode === 'simple'}
                        className={`${styles.modeBtn} ${mode === 'simple' ? styles.modeActive : ''}`}
                        onClick={() => setMode('simple')}
                      >
                        <span className={styles.modeName}>Simple</span>
                        <span className={styles.modeExample}>TreeBridge47</span>
                        <span className={styles.modeDesc}>Easy to remember</span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={mode === 'secure'}
                        className={`${styles.modeBtn} ${mode === 'secure' ? styles.modeActive : ''}`}
                        onClick={() => setMode('secure')}
                      >
                        <span className={styles.modeName}>Secure</span>
                        <span className={styles.modeExample}>Movie3Cartoon)Bottle</span>
                        <span className={styles.modeDesc}>Higher entropy</span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={mode === 'word4'}
                        className={`${styles.modeBtn} ${mode === 'word4' ? styles.modeActive : ''}`}
                        onClick={() => setMode('word4')}
                      >
                        <span className={styles.modeName}>Word + 4 digits</span>
                        <span className={styles.modeExample}>Tiger4829</span>
                        <span className={styles.modeDesc}>Short and simple</span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className={styles.actionsRow}>
                  <Button
                    variant="primary"
                    onClick={handleGenerate}
                    loading={isGenerating}
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
