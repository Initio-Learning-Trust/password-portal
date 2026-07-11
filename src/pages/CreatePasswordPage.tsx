import { useState, useEffect, useRef } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../services/firebase';
import { Layout } from '../components/layout/Layout';
import { Card, CardContent } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { Input, Textarea } from '../components/common/Input';
import { generatePassword, type PasswordMode } from '../utils/passwordGenerator';
import type { CreatePasswordForm, PasswordCreationResult } from '../types';
import styles from './CreatePasswordPage.module.css';

export function CreatePasswordPage() {
  const [form, setForm] = useState<CreatePasswordForm>({
    recipientEmail: '',
    recipientName: '',
    password: '',
    notes: '',
    sendNotification: false,
  });
  const [passwordMode, setPasswordMode] = useState<PasswordMode>('simple');
  const [result, setResult] = useState<PasswordCreationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'password' | 'link' | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-generate password on mount and when mode changes
  useEffect(() => {
    const newPassword = generatePassword({ mode: passwordMode });
    setForm((prev) => ({ ...prev, password: newPassword }));
  }, [passwordMode]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleRegenerate = () => {
    const newPassword = generatePassword({ mode: passwordMode });
    setForm({ ...form, password: newPassword });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const createPasswordLink = httpsCallable(functions, 'createPasswordLink');
      const response = await createPasswordLink({
        recipientEmail: form.recipientEmail,
        recipientName: form.recipientName,
        password: form.password,
        notes: form.notes,
        sendNotification: form.sendNotification,
      });

      const data = response.data as PasswordCreationResult;
      setResult(data);
    } catch {
      setError('Failed to create password link. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (type: 'password' | 'link') => {
    if (!result) return;

    const text = type === 'password' ? result.password : result.link;
    await navigator.clipboard.writeText(text);
    setCopied(type);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(null), 2000);
  };

  const handleReset = () => {
    setForm({
      recipientEmail: '',
      recipientName: '',
      password: generatePassword({ mode: passwordMode }),
      notes: '',
      sendNotification: false,
    });
    setResult(null);
    setError(null);
  };

  if (result) {
    return (
      <Layout>
        <div className={styles.page}>
          <Card className={styles.successCard}>
            <div className={styles.successIcon}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22,4 12,14.01 9,11.01" />
              </svg>
            </div>
            <h2 className={styles.successTitle}>Password Link Created</h2>
            <p className={styles.successSubtitle}>
              Link created for {result.recipientEmail}
            </p>

            <div className={styles.resultSection}>
              <label className={styles.resultLabel}>Password</label>
              <div className={styles.resultValue}>
                <code>{result.password}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy('password')}
                >
                  {copied === 'password' ? 'Copied!' : 'Copy'}
                </Button>
              </div>
            </div>

            <div className={styles.resultSection}>
              <label className={styles.resultLabel}>One-Time Link</label>
              <div className={styles.resultValue}>
                <code className={styles.linkCode}>{result.link}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy('link')}
                >
                  {copied === 'link' ? 'Copied!' : 'Copy'}
                </Button>
              </div>
            </div>

            <div className={styles.successActions}>
              <Button variant="secondary" onClick={handleReset}>
                Create Another
              </Button>
            </div>
          </Card>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className={styles.page}>
        <header className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Create Password Link</h1>
          <p className={styles.pageSubtitle}>
            Generate a secure one-time password and share it via a private link.
          </p>
        </header>

        <Card className={styles.formCard}>
          <CardContent>
            <form onSubmit={handleSubmit} className={styles.form}>
              <section className={styles.section}>
                <h3 className={styles.sectionLabel}>Recipient</h3>
                <div className={styles.formGrid}>
                  <Input
                    label="Email"
                    type="email"
                    value={form.recipientEmail}
                    onChange={(e) =>
                      setForm({ ...form, recipientEmail: e.target.value })
                    }
                    placeholder="user@example.com"
                    required
                  />
                  <Input
                    label="Name"
                    value={form.recipientName}
                    onChange={(e) =>
                      setForm({ ...form, recipientName: e.target.value })
                    }
                    placeholder="John Smith"
                  />
                </div>
              </section>

              <section className={styles.section}>
                <h3 className={styles.sectionLabel}>Password</h3>
                <div className={styles.passwordSection}>
                <div className={styles.passwordHeader}>
                  <label className={styles.passwordLabel}>Password</label>
                </div>

                {/* Mode Toggle */}
                <div className={styles.modeToggle}>
                  <button
                    type="button"
                    className={`${styles.modeBtn} ${passwordMode === 'simple' ? styles.active : ''}`}
                    onClick={() => setPasswordMode('simple')}
                  >
                    <span className={styles.modeIcon}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 12h8" />
                      </svg>
                    </span>
                    <span className={styles.modeContent}>
                      <span className={styles.modeName}>Simple</span>
                      <span className={styles.modeExample}>TreeBridge47</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.modeBtn} ${passwordMode === 'secure' ? styles.active : ''}`}
                    onClick={() => setPasswordMode('secure')}
                  >
                    <span className={styles.modeIcon}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </span>
                    <span className={styles.modeContent}>
                      <span className={styles.modeName}>Secure</span>
                      <span className={styles.modeExample}>Movie3Cartoon)Bottle</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.modeBtn} ${passwordMode === 'word4' ? styles.active : ''}`}
                    onClick={() => setPasswordMode('word4')}
                  >
                    <span className={styles.modeIcon}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 7V4h16v3" />
                        <path d="M9 20h6" />
                        <path d="M12 4v16" />
                      </svg>
                    </span>
                    <span className={styles.modeContent}>
                      <span className={styles.modeName}>Word + 4 digits</span>
                      <span className={styles.modeExample}>Tiger4829</span>
                    </span>
                  </button>
                </div>

                {/* Generated Password Display */}
                <div className={styles.generatedPassword}>
                  <code className={styles.passwordCode}>{form.password}</code>
                  <button
                    type="button"
                    className={styles.regenerateBtn}
                    onClick={handleRegenerate}
                    title="Generate new password"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="23,4 23,10 17,10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                  </button>
                </div>

                {/* Manual Override */}
                <details className={styles.manualOverride}>
                  <summary>Enter custom password</summary>
                  <Input
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="Enter a custom password"
                  />
                </details>
                </div>
              </section>

              <section className={styles.section}>
                <h3 className={styles.sectionLabel}>Delivery</h3>
                <Textarea
                  label="Notes (optional)"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Internal notes about this password (not shared with recipient)"
                  rows={3}
                />

                <div className={styles.checkboxWrapper}>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={form.sendNotification}
                      onChange={(e) =>
                        setForm({ ...form, sendNotification: e.target.checked })
                      }
                    />
                    <span className={styles.checkboxLabel}>
                      Send email notification to recipient
                    </span>
                  </label>
                </div>
              </section>

              {error && <div className={styles.error}>{error}</div>}

              <div className={styles.formActions}>
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={loading}
                >
                  Create Password Link
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
