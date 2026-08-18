import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useIsAdmin } from '../hooks/useAuth';
import { Layout } from '../components/layout/Layout';
import { Card } from '../components/common/Card';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { ApiKeysSettings } from '../components/settings/ApiKeysSettings';
import { ApiDocsSettings } from '../components/settings/ApiDocsSettings';
import { IpWhitelistSettings } from '../components/settings/IpWhitelistSettings';
import { WordListsSettings } from '../components/settings/WordListsSettings';
import { UsersSettings } from '../components/settings/UsersSettings';
import { EmailTemplatesSettings } from '../components/settings/EmailTemplatesSettings';
import { AuditLogSettings } from '../components/settings/AuditLogSettings';
import styles from './SettingsPage.module.css';

type SettingsTab = 'api-docs' | 'api-keys' | 'ip-whitelist' | 'word-lists' | 'users' | 'email-templates' | 'audit-log';

export function SettingsPage() {
  const isAdmin = useIsAdmin();
  const [activeTab, setActiveTab] = useState<SettingsTab>('api-keys');

  if (!isAdmin) {
    return (
      <Layout>
        <div className={styles.page}>
          <Card className={styles.accessDenied}>
            <h2>Access Denied</h2>
            <p>You need admin privileges to access settings.</p>
          </Card>
        </div>
      </Layout>
    );
  }

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'api-docs', label: 'API Docs' },
    { id: 'api-keys', label: 'API Keys' },
    { id: 'ip-whitelist', label: 'IP Whitelist' },
    { id: 'word-lists', label: 'Word Lists' },
    { id: 'users', label: 'Users' },
    { id: 'email-templates', label: 'Email Templates' },
    { id: 'audit-log', label: 'Audit Log' },
  ];

  return (
    <Layout>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Settings</h1>
        </div>

        <div className={styles.container}>
          <nav className={styles.sidebar}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`${styles.tabButton} ${activeTab === tab.id ? styles.active : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                {activeTab === 'api-docs' && (
                  <ErrorBoundary>
                    <ApiDocsSettings />
                  </ErrorBoundary>
                )}
                {activeTab === 'api-keys' && (
                  <ErrorBoundary>
                    <ApiKeysSettings />
                  </ErrorBoundary>
                )}
                {activeTab === 'ip-whitelist' && (
                  <ErrorBoundary>
                    <IpWhitelistSettings />
                  </ErrorBoundary>
                )}
                {activeTab === 'word-lists' && (
                  <ErrorBoundary>
                    <WordListsSettings />
                  </ErrorBoundary>
                )}
                {activeTab === 'users' && (
                  <ErrorBoundary>
                    <UsersSettings />
                  </ErrorBoundary>
                )}
                {activeTab === 'email-templates' && (
                  <ErrorBoundary>
                    <EmailTemplatesSettings />
                  </ErrorBoundary>
                )}
                {activeTab === 'audit-log' && (
                  <ErrorBoundary>
                    <AuditLogSettings />
                  </ErrorBoundary>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </Layout>
  );
}
