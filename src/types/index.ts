// Firestore document types

export interface PasswordDoc {
  id: string;
  encryptedPassword: string;
  iv: string;
  recipientEmail: string;
  recipientName?: string;
  notes?: string;
  createdBy: string;
  createdByEmail: string;
  createdAt: Date;
  status: 'pending' | 'sent' | 'viewed' | 'expired' | 'revoked' | 'failed';
  viewedAt?: Date;
  viewedFromIP?: string;
  emailSent: boolean;
  emailSentAt?: Date;
  source: 'dashboard' | 'api' | 'batch';
  apiKeyId?: string;
  batchId?: string;
  lastError?: string;
  regeneratedFrom?: string;
  regeneratedTo?: string;
  searchTokens?: string[];
}

export type BatchCountStatus =
  | 'pending'
  | 'sent'
  | 'viewed'
  | 'failed'
  | 'expired'
  | 'revoked';

export interface BatchSendJob {
  state: 'running' | 'done' | 'cancelled';
  total: number;
  sent: number;
  failed: number;
  startedAt?: Date;
  finishedAt?: Date;
  requestedBy?: string;
}

export interface BatchDoc {
  id: string;
  name: string;
  size: number;
  createdBy: string;
  createdByEmail: string;
  createdAt: Date;
  counts: Record<BatchCountStatus, number>;
  sendJob?: BatchSendJob;
}

export interface ApiKeyDoc {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string; // First 8 chars for display
  createdBy: string;
  createdByEmail: string;
  createdAt: Date;
  lastUsed?: Date;
  active: boolean;
}

export interface IpWhitelistDoc {
  id: string;
  ip: string;
  description: string;
  createdBy: string;
  createdByEmail: string;
  createdAt: Date;
}

export interface WordListDoc {
  id: string;
  name: string;
  words: string[];
  createdBy: string;
  updatedAt: Date;
}

export interface UserDoc {
  id: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: 'admin' | 'technician';
  createdAt: Date;
  lastLogin: Date;
  pending?: boolean; // True if user was pre-added but hasn't signed in yet
}

export interface AuditLogDoc {
  id: string;
  action: 'create' | 'view' | 'send_email' | 'revoke' | 'regenerate' | 'api_call' | 'settings_change';
  actorId?: string;
  actorEmail?: string;
  targetId?: string;
  details: Record<string, unknown>;
  ip: string;
  timestamp: Date;
}

export interface EmailTemplateDoc {
  id: string;
  name: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  updatedBy: string;
  updatedAt: Date;
}

// UI State types

export interface GeneratedPassword {
  id: string;
  value: string;
  copied: boolean;
}

export interface CreatePasswordForm {
  recipientEmail: string;
  recipientName: string;
  password: string;
  notes: string;
  sendNotification: boolean;
}

export interface PasswordCreationResult {
  id: string;
  password: string;
  link: string;
  recipientEmail: string;
  recipientName?: string;
}

export interface DashboardStats {
  todayCount: number;
  pendingCount: number;
  viewedToday: number;
  weekCount: number;
}

// Auth context type
export interface AuthContextType {
  user: UserDoc | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}
