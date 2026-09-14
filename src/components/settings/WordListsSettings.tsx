import { useState, useEffect } from 'react';
import {
  collection,
  query,
  orderBy,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../services/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';
import { Card, CardHeader, CardTitle, CardContent } from '../common/Card';
import { Button } from '../common/Button';
import { Input, Textarea } from '../common/Input';
import { SkeletonCard } from '../common/LoadingSkeleton';
import type { WordListDoc } from '../../types';
import styles from './Settings.module.css';

export function WordListsSettings() {
  const { user } = useAuth();
  const [wordLists, setWordLists] = useState<WordListDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const showSkeleton = useDelayedLoading(loading);
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formWords, setFormWords] = useState('');

  useEffect(() => {
    loadWordLists();
  }, []);

  const loadWordLists = async () => {
    try {
      const listsRef = collection(db, 'word_lists');
      const q = query(listsRef, orderBy('name'));
      const snapshot = await getDocs(q);

      const lists = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as WordListDoc[];

      setWordLists(lists);
    } catch (error) {
      console.error('Error loading word lists:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!formName.trim() || !formWords.trim()) return;

    setSaving(true);
    try {
      const words = formWords
        .split('\n')
        .map((w) => w.trim())
        .filter((w) => w);

      await addDoc(collection(db, 'word_lists'), {
        name: formName.trim(),
        words,
        createdBy: user?.id || '',
        updatedAt: serverTimestamp(),
      });

      resetForm();
      await loadWordLists();
    } catch (error) {
      console.error('Error adding word list:', error);
      alert('Failed to add word list');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (list: WordListDoc) => {
    setEditingId(list.id);
    setFormName(list.name);
    setFormWords(list.words.join('\n'));
    setShowAddForm(false);
  };

  const handleUpdate = async () => {
    if (!editingId || !formName.trim() || !formWords.trim()) return;

    setSaving(true);
    try {
      const words = formWords
        .split('\n')
        .map((w) => w.trim())
        .filter((w) => w);

      await updateDoc(doc(db, 'word_lists', editingId), {
        name: formName.trim(),
        words,
        updatedAt: serverTimestamp(),
      });

      resetForm();
      await loadWordLists();
    } catch (error) {
      console.error('Error updating word list:', error);
      alert('Failed to update word list');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (listId: string) => {
    if (!confirm('Are you sure you want to delete this word list?')) return;

    try {
      await deleteDoc(doc(db, 'word_lists', listId));
      await loadWordLists();
    } catch (error) {
      console.error('Error deleting word list:', error);
      alert('Failed to delete word list');
    }
  };

  const resetForm = () => {
    setShowAddForm(false);
    setEditingId(null);
    setFormName('');
    setFormWords('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle subtitle="Custom word lists for password generation">
          Word Lists
        </CardTitle>
        <Button
          variant="primary"
          onClick={() => {
            resetForm();
            setShowAddForm(true);
          }}
        >
          Add Word List
        </Button>
      </CardHeader>
      <CardContent>
        {/* Add/Edit form */}
        {(showAddForm || editingId) && (
          <div className={styles.formBox}>
            <h4>{editingId ? 'Edit Word List' : 'Add New Word List'}</h4>
            <div className={styles.formGrid}>
              <Input
                label="List Name"
                placeholder="e.g., Animals, Nature, School"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <Textarea
              label="Words (one per line)"
              placeholder="Tiger
Eagle
Mountain
River"
              value={formWords}
              onChange={(e) => setFormWords(e.target.value)}
              rows={10}
            />
            <p className={styles.helpText}>
              Enter words that will be used to generate memorable passwords.
              Aim for at least 20 words for good variety.
            </p>
            <div className={styles.formActions}>
              <Button
                variant="primary"
                onClick={editingId ? handleUpdate : handleAdd}
                loading={saving}
                disabled={!formName.trim() || !formWords.trim()}
              >
                {editingId ? 'Update' : 'Add'}
              </Button>
              <Button variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Word lists */}
        {showSkeleton ? (
          <SkeletonCard count={3} />
        ) : loading ? null : wordLists.length === 0 && !showAddForm ? (
          <div className={styles.empty}>
            <p>
              No word lists yet. Passwords are generated from the words in these
              lists, so add one to start generating.
            </p>
          </div>
        ) : (
          <div className={styles.wordListsGrid}>
            {wordLists.map((list) => (
              <div key={list.id} className={styles.wordListCard}>
                <div className={styles.wordListHeader}>
                  <h4>{list.name}</h4>
                  <span className={styles.wordCount}>{list.words.length} words</span>
                </div>
                <div className={styles.wordListPreview}>
                  {list.words.slice(0, 10).join(', ')}
                  {list.words.length > 10 && '...'}
                </div>
                <div className={styles.wordListActions}>
                  <Button variant="ghost" size="sm" onClick={() => handleEdit(list)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(list.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
