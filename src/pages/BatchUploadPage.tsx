import { useState, useRef } from 'react';
import { httpsCallable } from 'firebase/functions';
import { doc, setDoc, updateDoc, increment, Timestamp } from 'firebase/firestore';
import { db, functions } from '../services/firebase';
import { useAuth } from '../hooks/useAuth';
import { Layout } from '../components/layout/Layout';
import { Card, CardHeader, CardTitle, CardContent } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { generatePassword } from '../utils/passwordGenerator';
import styles from './BatchUploadPage.module.css';

interface BatchRow {
  email: string;
  name: string;
  password: string;
  notes: string;
  valid: boolean;
  error?: string;
}

interface UploadResult {
  email: string;
  name: string;
  success: boolean;
  link?: string;
  error?: string;
  emailSent?: boolean;
}

// Example CSV data for preview
const EXAMPLE_CSV_DATA = [
  { email: 'john.smith@example.com', name: 'John Smith', password: 'Sunset-Tiger-42', notes: 'New starter' },
  { email: 'jane.doe@example.com', name: 'Jane Doe', password: 'Ocean-Mountain-88', notes: '' },
  { email: 'bob.wilson@example.com', name: 'Bob Wilson', password: '', notes: 'Password reset' },
];

export function BatchUploadPage() {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [step, setStep] = useState<'upload' | 'preview' | 'results'>('upload');
  const [sendEmails, setSendEmails] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      parseCSV(text);
    };
    reader.readAsText(file);
  };

  const parseCSV = (text: string) => {
    const lines = text.split('\n').filter((line) => line.trim());
    const parsedRows: BatchRow[] = [];

    // Skip header row
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const [email, name, password, notes] = values;

      const row: BatchRow = {
        email: email || '',
        name: name || '',
        password: password || generatePassword(),
        notes: notes || '',
        valid: true,
      };

      // Validate email
      if (!row.email || !row.email.includes('@')) {
        row.valid = false;
        row.error = 'Invalid email';
      }

      parsedRows.push(row);
    }

    setRows(parsedRows);
    setStep('preview');
  };

  const handleGeneratePassword = (index: number) => {
    const newRows = [...rows];
    newRows[index].password = generatePassword();
    setRows(newRows);
  };

  const handleGenerateAllPasswords = () => {
    const newRows = rows.map((row) => ({
      ...row,
      password: row.password || generatePassword(),
    }));
    setRows(newRows);
  };

  const handleRemoveRow = (index: number) => {
    setRows(rows.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    const validRows = rows.filter((r) => r.valid);
    if (validRows.length === 0) return;

    setUploading(true);
    const uploadResults: UploadResult[] = [];
    const newBatchId = crypto.randomUUID();
    const batchName =
      fileName ||
      `CSV batch — ${new Date().toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}`;
    setBatchId(newBatchId);
    setUploadProgress({ current: 0, total: validRows.length });

    try {
      // Create the batch record first so the queue can group these links and
      // track send progress. Counts start with everything pending.
      await setDoc(doc(db, 'batches', newBatchId), {
        name: batchName,
        size: validRows.length,
        createdBy: user?.id || '',
        createdByEmail: user?.email || '',
        createdAt: Timestamp.now(),
        counts: {
          pending: validRows.length,
          sent: 0,
          viewed: 0,
          failed: 0,
          expired: 0,
          revoked: 0,
        },
      });

      const createPasswordLink = httpsCallable(functions, 'createPasswordLink');

      // Create the links (never send inline — sending is a separate, durable,
      // throttled server job so 300+ recipients don't trip Gmail's rate limit).
      let createFailures = 0;
      for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];
        setUploadProgress({ current: i + 1, total: validRows.length });

        try {
          const response = await createPasswordLink({
            recipientEmail: row.email,
            recipientName: row.name,
            password: row.password,
            notes: row.notes,
            sendNotification: false,
            batchId: newBatchId,
          });

          const data = response.data as { link: string };
          uploadResults.push({
            email: row.email,
            name: row.name,
            success: true,
            link: data.link,
            emailSent: sendEmails,
          });
        } catch (error) {
          createFailures++;
          uploadResults.push({
            email: row.email,
            name: row.name,
            success: false,
            error: 'Failed to create link',
          });
        }
      }

      // Correct the batch counts if any link failed to create.
      if (createFailures > 0) {
        await updateDoc(doc(db, 'batches', newBatchId), {
          size: increment(-createFailures),
          'counts.pending': increment(-createFailures),
        });
      }

      // Kick off the durable server-side send. We don't await it — it runs to
      // completion server-side and the queue shows live progress.
      if (sendEmails && uploadResults.some((r) => r.success)) {
        // Long-running server job; raise the callable timeout past the 70s
        // default. Fire-and-forget — the queue shows live progress.
        const sendBatchEmails = httpsCallable(functions, 'sendBatchEmails', {
          timeout: 540000,
        });
        sendBatchEmails({ batchId: newBatchId }).catch((err) => {
          console.error('Failed to start batch send:', err);
        });
      }

      setResults(uploadResults);
      setStep('results');
    } catch (error) {
      console.error('Batch upload error:', error);
      alert('Batch upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDownloadTemplate = () => {
    const template = 'email,name,password,notes\nuser@example.com,John Smith,,Optional notes\n';
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'password-batch-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadResults = () => {
    const csv = [
      'email,success,link,error',
      ...results.map(
        (r) => `${r.email},${r.success},${r.link || ''},${r.error || ''}`
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'password-batch-results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setRows([]);
    setResults([]);
    setStep('upload');
    setSendEmails(false);
    setBatchId(null);
    setFileName('');
    setUploadProgress({ current: 0, total: 0 });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const validCount = rows.filter((r) => r.valid).length;
  const invalidCount = rows.filter((r) => !r.valid).length;
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  return (
    <Layout>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Batch Upload</h1>
        </div>

        {step === 'upload' && (
          <div className={styles.uploadGrid}>
            <Card>
              <CardHeader>
                <CardTitle subtitle="Upload a CSV file to create multiple password links">
                  Upload CSV
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={styles.uploadArea}>
                  <div className={styles.uploadIcon}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17,8 12,3 7,8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </div>
                  <p>Drag and drop a CSV file here, or click to browse</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    onChange={handleFileSelect}
                    className={styles.fileInput}
                  />
                  <div className={styles.uploadActions}>
                    <Button
                      variant="primary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Browse Files
                    </Button>
                    <Button variant="ghost" onClick={handleDownloadTemplate}>
                      Download Template
                    </Button>
                  </div>
                </div>

                <div className={styles.formatInfo}>
                  <h4>CSV Format</h4>
                  <p>Your CSV should have these columns:</p>
                  <ul>
                    <li><strong>email</strong> (required) - Recipient email address</li>
                    <li><strong>name</strong> - Recipient name</li>
                    <li><strong>password</strong> - Leave blank to auto-generate</li>
                    <li><strong>notes</strong> - Internal notes</li>
                  </ul>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle subtitle="This is what your CSV should look like">
                  Example CSV Preview
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={styles.exampleCsv}>
                  <div className={styles.csvHeader}>
                    <span>email</span>
                    <span>name</span>
                    <span>password</span>
                    <span>notes</span>
                  </div>
                  {EXAMPLE_CSV_DATA.map((row, i) => (
                    <div key={i} className={styles.csvRow}>
                      <span>{row.email}</span>
                      <span>{row.name}</span>
                      <span className={styles.csvPassword}>{row.password || <em className={styles.autoGen}>(auto-generated)</em>}</span>
                      <span>{row.notes || <em className={styles.empty}>-</em>}</span>
                    </div>
                  ))}
                </div>
                <div className={styles.exampleTips}>
                  <h4>Tips for Success</h4>
                  <ul>
                    <li>Leave the password column empty to auto-generate secure passwords</li>
                    <li>Make sure email addresses are valid - invalid ones will be flagged</li>
                    <li>You can review and edit all entries before creating links</li>
                    <li>After upload, you can send all emails at once or individually from the queue</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {step === 'preview' && (
          <>
            <Card className={styles.summaryCard}>
              <div className={styles.summary}>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryValue}>{rows.length}</span>
                  <span className={styles.summaryLabel}>Total Rows</span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={`${styles.summaryValue} ${styles.success}`}>
                    {validCount}
                  </span>
                  <span className={styles.summaryLabel}>Valid</span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={`${styles.summaryValue} ${styles.error}`}>
                    {invalidCount}
                  </span>
                  <span className={styles.summaryLabel}>Invalid</span>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle subtitle="Review and edit before uploading">
                  Preview
                </CardTitle>
                <div className={styles.previewActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleGenerateAllPasswords}
                  >
                    Generate All Passwords
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Name</th>
                        <th>Password</th>
                        <th>Notes</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr key={index} className={!row.valid ? styles.invalidRow : ''}>
                          <td>{row.email}</td>
                          <td>{row.name || '-'}</td>
                          <td>
                            <code className={styles.password}>{row.password}</code>
                          </td>
                          <td>{row.notes || '-'}</td>
                          <td>
                            {row.valid ? (
                              <span className={styles.validBadge}>Valid</span>
                            ) : (
                              <span className={styles.invalidBadge}>{row.error}</span>
                            )}
                          </td>
                          <td>
                            <div className={styles.rowActions}>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleGeneratePassword(index)}
                              >
                                ↻
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveRow(index)}
                              >
                                ×
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className={styles.uploadOptions}>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={sendEmails}
                      onChange={(e) => setSendEmails(e.target.checked)}
                    />
                    <span className={styles.checkboxMark}></span>
                    <span className={styles.checkboxLabel}>
                      Send notification emails immediately
                      <span className={styles.checkboxHint}>
                        Recipients will receive an email with their password link
                      </span>
                    </span>
                  </label>
                </div>

                {uploading && (
                  <div className={styles.progressBar}>
                    <div className={styles.progressLabel}>
                      Creating links... {uploadProgress.current} of {uploadProgress.total}
                    </div>
                    <div className={styles.progressTrack}>
                      <div
                        className={styles.progressFill}
                        style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className={styles.formActions}>
                  <Button variant="ghost" onClick={handleReset} disabled={uploading}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleUpload}
                    loading={uploading}
                    disabled={validCount === 0}
                  >
                    {sendEmails
                      ? `Create & Send ${validCount} Password Links`
                      : `Create ${validCount} Password Links`
                    }
                  </Button>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {step === 'results' && (
          <>
            <Card className={styles.summaryCard}>
              <div className={styles.summary}>
                <div className={styles.summaryItem}>
                  <span className={`${styles.summaryValue} ${styles.success}`}>
                    {successCount}
                  </span>
                  <span className={styles.summaryLabel}>Links Created</span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={`${styles.summaryValue} ${sendEmails ? styles.success : ''}`}>
                    {results.filter(r => r.emailSent).length}
                  </span>
                  <span className={styles.summaryLabel}>Emails Queued</span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={`${styles.summaryValue} ${styles.error}`}>
                    {failCount}
                  </span>
                  <span className={styles.summaryLabel}>Failed</span>
                </div>
              </div>
            </Card>

            {sendEmails && successCount > 0 && (
              <Card className={styles.nextStepsCard}>
                <div className={styles.nextSteps}>
                  <div className={styles.nextStepsIcon}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 2L11 13M22 2L15 22 11 13 2 9 22 2Z" />
                    </svg>
                  </div>
                  <div className={styles.nextStepsContent}>
                    <h4>Emails are sending…</h4>
                    <p>
                      Your {successCount} links were created and are being emailed in the
                      background — throttled so large batches send reliably. Track live
                      progress, and resend any failures, from the Queue.
                    </p>
                    <a href={`/admin/queue?batch=${batchId}`} className={styles.nextStepsLink}>
                      <Button variant="primary">
                        View Send Progress in Queue
                      </Button>
                    </a>
                  </div>
                </div>
              </Card>
            )}

            {!sendEmails && successCount > 0 && (
              <Card className={styles.nextStepsCard}>
                <div className={styles.nextSteps}>
                  <div className={styles.nextStepsIcon}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 2L11 13M22 2L15 22 11 13 2 9 22 2Z" />
                    </svg>
                  </div>
                  <div className={styles.nextStepsContent}>
                    <h4>Ready to send emails?</h4>
                    <p>
                      Your password links have been created. You can send notification emails
                      to all recipients from the Queue page.
                    </p>
                    <a href={`/admin/queue?batch=${batchId}`} className={styles.nextStepsLink}>
                      <Button variant="primary">
                        Go to Queue to Send Emails
                      </Button>
                    </a>
                  </div>
                </div>
              </Card>
            )}

            <Card>
              <CardHeader
                action={
                  <Button variant="secondary" onClick={handleDownloadResults}>
                    Download Results CSV
                  </Button>
                }
              >
                <CardTitle subtitle={sendEmails ? "Links created and emails sent" : "Download results to share links with recipients"}>
                  Results
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Recipient</th>
                        <th>Status</th>
                        <th>Email Sent</th>
                        <th>Link</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((result, index) => (
                        <tr key={index}>
                          <td>
                            <div className={styles.recipientCell}>
                              <span className={styles.recipientName}>{result.name || '-'}</span>
                              <span className={styles.recipientEmail}>{result.email}</span>
                            </div>
                          </td>
                          <td>
                            {result.success ? (
                              <span className={styles.validBadge}>Created</span>
                            ) : (
                              <span className={styles.invalidBadge}>{result.error}</span>
                            )}
                          </td>
                          <td>
                            {result.success ? (
                              result.emailSent ? (
                                <span className={styles.sentBadge}>Queued</span>
                              ) : (
                                <span className={styles.pendingBadge}>Pending</span>
                              )
                            ) : '-'}
                          </td>
                          <td>
                            {result.link ? (
                              <code className={styles.linkCode}>{result.link}</code>
                            ) : (
                              '-'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className={styles.formActions}>
                  <Button variant="primary" onClick={handleReset}>
                    Upload Another Batch
                  </Button>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </Layout>
  );
}
