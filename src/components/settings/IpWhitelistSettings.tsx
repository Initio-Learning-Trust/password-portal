import { useState, useEffect } from 'react';
import {
  collection,
  query,
  orderBy,
  getDocs,
  addDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../services/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';
import { Card, CardHeader, CardTitle, CardContent } from '../common/Card';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { SkeletonTable } from '../common/LoadingSkeleton';
import type { IpWhitelistDoc } from '../../types';
import { isValidIpOrCidr } from '../../utils/cidr';
import styles from './Settings.module.css';

// Mirrors the RATE_LIMIT_PUBLIC_PER_HOUR function config. Shown so an admin can
// see what a blank limit means without reading the deployment config.
const DEFAULT_PUBLIC_LIMIT = 1000;

export function IpWhitelistSettings() {
  const { user } = useAuth();
  const [ips, setIps] = useState<IpWhitelistDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const showSkeleton = useDelayedLoading(loading);
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newIp, setNewIp] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newLimit, setNewLimit] = useState('');
  const [newAllowApi, setNewAllowApi] = useState(false);

  useEffect(() => {
    loadIps();
  }, []);

  const loadIps = async () => {
    try {
      const ipsRef = collection(db, 'ip_whitelist');
      const q = query(ipsRef, orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);

      const ipList = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as IpWhitelistDoc[];

      setIps(ipList);
    } catch (error) {
      console.error('Error loading IP whitelist:', error);
    } finally {
      setLoading(false);
    }
  };

  // Validated here by the same parser the backend matches with, so anything
  // saved is guaranteed to be something the backend can act on.
  const trimmedIp = newIp.trim();
  const ipError = trimmedIp !== '' && !isValidIpOrCidr(trimmedIp)
    ? 'Enter a valid IP address or CIDR range'
    : undefined;
  const trimmedLimit = newLimit.trim();
  const limitError = trimmedLimit !== '' && !/^\d+$/.test(trimmedLimit)
    ? 'Enter a whole number of requests per hour'
    : undefined;
  const canSubmit = trimmedIp !== '' && !ipError && !limitError;

  const handleAdd = async () => {
    if (!canSubmit) return;

    setAdding(true);
    try {
      const limit = trimmedLimit === '' ? null : Number(trimmedLimit);
      await addDoc(collection(db, 'ip_whitelist'), {
        ip: trimmedIp,
        description: newDescription.trim(),
        // Defaults to off: adding an entry to raise a generation quota must
        // not quietly also grant the ability to create password links.
        allowApi: newAllowApi,
        generateLimit: limit && limit > 0 ? limit : null,
        createdBy: user?.id || '',
        createdByEmail: user?.email || '',
        createdAt: serverTimestamp(),
      });

      setNewIp('');
      setNewDescription('');
      setNewLimit('');
      setNewAllowApi(false);
      setShowAddForm(false);
      await loadIps();
    } catch (error) {
      console.error('Error adding IP:', error);
      alert('Failed to add IP');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (ipId: string) => {
    if (!confirm('Are you sure you want to remove this IP?')) return;

    try {
      await deleteDoc(doc(db, 'ip_whitelist', ipId));
      await loadIps();
    } catch (error) {
      console.error('Error deleting IP:', error);
      alert('Failed to delete IP');
    }
  };

  // An entry only gates the API if it grants API access. Entries that exist
  // purely to raise a generation quota leave the API gate exactly as it was.
  const apiEntryCount = ips.filter((entry) => entry.allowApi !== false).length;

  const formatDate = (date: Date | { toDate: () => Date } | undefined) => {
    if (!date) return '-';
    const d = date instanceof Date ? date : date.toDate();
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle subtitle="Control API access and raise generation rate limits by IP">
          IP Whitelist
        </CardTitle>
        <Button variant="primary" onClick={() => setShowAddForm(true)}>
          Add IP
        </Button>
      </CardHeader>
      <CardContent>
        {/* Add form */}
        {showAddForm && (
          <div className={styles.formBox}>
            <h4>Add IP Address</h4>
            <div className={styles.formGrid}>
              <Input
                label="IP Address"
                placeholder="e.g., 192.168.1.100 or 10.0.0.0/24"
                value={newIp}
                onChange={(e) => setNewIp(e.target.value)}
                error={ipError}
              />
              <Input
                label="Description"
                placeholder="e.g., Office server"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
              <Input
                label="Generation limit (per hour)"
                placeholder={`Leave blank for the default ${DEFAULT_PUBLIC_LIMIT.toLocaleString()}`}
                inputMode="numeric"
                value={newLimit}
                onChange={(e) => setNewLimit(e.target.value)}
                error={limitError}
              />
            </div>
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={newAllowApi}
                onChange={(e) => setNewAllowApi(e.target.checked)}
              />
              <span>
                Also allow password-link creation (<code>POST /api</code>) from this
                address
              </span>
            </label>
            <div className={styles.formActions}>
              <Button
                variant="primary"
                onClick={handleAdd}
                loading={adding}
                disabled={!canSubmit}
              >
                Add
              </Button>
              <Button variant="ghost" onClick={() => setShowAddForm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Info box */}
        <div className={styles.infoBox}>
          <p>
            <strong>API access:</strong>{' '}
            {apiEntryCount === 0
              ? `No entries grant API access, so POST /api accepts requests from any IP. Tick the checkbox when adding an entry to start restricting it.`
              : `${apiEntryCount} ${apiEntryCount === 1 ? 'entry grants' : 'entries grant'} API access. POST /api rejects every other IP.`}
          </p>
          <p>
            <strong>Generation limits:</strong> The public generation endpoints
            allow {DEFAULT_PUBLIC_LIMIT.toLocaleString()} requests per hour per IP.
            Set a limit on an entry to raise it for that address or range.
            Elevated limits require the deployment's proxy settings to be
            configured &mdash; see the API documentation.
          </p>
        </div>

        {/* IPs list */}
        {showSkeleton ? (
          <SkeletonTable rows={5} columns={[{ width: '150px' }, { flex: 2 }, { width: '110px' }, { width: '90px' }, { flex: 1 }, { width: '100px' }]} />
        ) : loading ? null : ips.length === 0 ? (
          <div className={styles.empty}>
            <p>
              No entries yet. The API is open to all IPs, and generation is
              limited to {DEFAULT_PUBLIC_LIMIT.toLocaleString()} requests per hour
              per IP.
            </p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>IP Address</th>
                <th>Description</th>
                <th>Generation limit</th>
                <th>API access</th>
                <th>Added By</th>
                <th>Added</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {ips.map((ip) => (
                <tr key={ip.id}>
                  <td>
                    <code>{ip.ip}</code>
                  </td>
                  <td>{ip.description || '-'}</td>
                  <td>
                    {ip.generateLimit
                      ? `${ip.generateLimit.toLocaleString()}/hr`
                      : `Default (${DEFAULT_PUBLIC_LIMIT.toLocaleString()}/hr)`}
                  </td>
                  <td>{ip.allowApi !== false ? 'Yes' : 'No'}</td>
                  <td>{ip.createdByEmail?.split('@')[0] || '-'}</td>
                  <td>{formatDate(ip.createdAt)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(ip.id)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
