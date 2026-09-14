import * as admin from 'firebase-admin';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { defineString, defineSecret } from 'firebase-functions/params';
import { v4 as uuidv4 } from 'uuid';
import * as nodemailer from 'nodemailer';
import { encryptPassword, decryptPassword, hashApiKey, generateApiKey } from './utils/encryption';
import { buildSearchTokens } from './utils/searchTokens';
import type { Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { Timestamp } from 'firebase-admin/firestore';
import { normalizeIp, parseCidrList } from './utils/cidr';
import { resolveClient, type ProxyConfig, type ResolvedClient } from './utils/clientIp';
import { bucketKey, consume, rateLimitHeaders } from './utils/rateLimit';
import { checkApiAccess, findEntry } from './utils/allowlist';
import { generateMany, isPasswordMode, PASSWORD_MODES, type PasswordMode } from './utils/passwordGenerator';
import {
  hasWord,
  listNames,
  resolveWords,
  WordListsUnavailableError,
} from './utils/wordLists';

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// Environment parameters
const encryptionKey = defineSecret('PASSWORD_ENCRYPTION_KEY');
const appUrl = defineString('APP_URL', { default: 'https://password.initiolearning.org' });

// SMTP configuration (using Google Workspace)
const smtpUser = defineSecret('SMTP_USER');
const smtpPass = defineSecret('SMTP_PASS');
const smtpHost = defineString('SMTP_HOST', { default: 'smtp.gmail.com' });
const smtpPort = defineString('SMTP_PORT', { default: '587' });

// Rate limiting / proxy trust. See docs/API.md "Operating the API" for how to
// determine the two proxy values; until they are set, elevated allowlist tiers
// stay disabled and every caller receives the public limit.
const rateLimitPublic = defineString('RATE_LIMIT_PUBLIC_PER_HOUR', { default: '1000' });
const rateLimitProxyHops = defineString('RATE_LIMIT_PROXY_HOPS', { default: '' });
const rateLimitTrustedProxies = defineString('RATE_LIMIT_TRUSTED_PROXIES', { default: '' });

// Types
interface PasswordDoc {
  id: string;
  encryptedPassword: string;
  iv: string;
  authTag: string;
  recipientEmail: string;
  recipientName?: string;
  notes?: string;
  createdBy: string;
  createdByEmail: string;
  createdAt: admin.firestore.Timestamp;
  status: 'pending' | 'sent' | 'viewed' | 'expired' | 'revoked' | 'failed';
  viewedAt?: admin.firestore.Timestamp;
  viewedFromIP?: string;
  emailSent: boolean;
  emailSentAt?: admin.firestore.Timestamp;
  source: 'dashboard' | 'api' | 'batch';
  apiKeyId?: string;
  batchId?: string;
  lastError?: string;
  searchTokens?: string[];
}

// Statuses tracked as counters on a batch document.
type BatchCountStatus = 'pending' | 'sent' | 'viewed' | 'failed' | 'expired' | 'revoked';

// Adjust a batch's denormalized status counters. Best-effort: a counting error
// must never break the underlying password operation, so callers swallow throws.
// `from`/`to` are status buckets; pass null to skip that side of the move.
async function adjustBatchCounts(
  batchId: string | undefined,
  from: BatchCountStatus | null,
  to: BatchCountStatus | null
): Promise<void> {
  if (!batchId || from === to) return;
  const updates: Record<string, admin.firestore.FieldValue> = {};
  if (from) updates[`counts.${from}`] = admin.firestore.FieldValue.increment(-1);
  if (to) updates[`counts.${to}`] = admin.firestore.FieldValue.increment(1);
  if (Object.keys(updates).length === 0) return;
  try {
    await db.collection('batches').doc(batchId).update(updates);
  } catch (err) {
    console.error(`Failed to adjust batch counts for ${batchId}:`, err);
  }
}

// ==================== Email helpers ====================

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Load the default email template from Firestore, falling back to the built-in
// defaults for any missing field.
async function loadEmailTemplate(): Promise<{ subject: string; htmlBody: string; textBody: string }> {
  const templateDoc = await db.collection('email_templates').doc('default').get();
  let subject = 'Your New Password - {{recipientName}}';
  let htmlBody = getDefaultHtmlTemplate();
  let textBody = getDefaultTextTemplate();
  if (templateDoc.exists) {
    const t = templateDoc.data();
    if (t) {
      subject = t.subject || subject;
      htmlBody = t.htmlBody || htmlBody;
      textBody = t.textBody || textBody;
    }
  }
  return { subject, htmlBody, textBody };
}

// Substitute the template variables for one recipient.
function renderEmail(
  template: { subject: string; htmlBody: string; textBody: string },
  recipientEmail: string,
  recipientName: string | undefined,
  link: string
): RenderedEmail {
  const name = recipientName || recipientEmail.split('@')[0];
  const sub = (s: string) =>
    s
      .replace(/{{recipientName}}/g, name)
      .replace(/{{recipientEmail}}/g, recipientEmail)
      .replace(/{{link}}/g, link);
  return {
    subject: sub(template.subject),
    html: sub(template.htmlBody),
    text: sub(template.textBody),
  };
}

// Classify a nodemailer/SMTP error as transient (worth retrying) vs permanent.
// Gmail defers with 4xx codes (421 "too many connections", 454 rate limit) and
// connection errors are transient; 5xx (bad mailbox) is permanent.
function isTransientMailError(err: unknown): boolean {
  const e = err as { responseCode?: number; code?: string };
  if (typeof e?.responseCode === 'number') {
    return e.responseCode >= 400 && e.responseCode < 500;
  }
  const transientCodes = ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNRESET', 'EDNS', 'EAI_AGAIN'];
  return !!e?.code && transientCodes.includes(e.code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a password link (callable function for authenticated users)
 */
export const createPasswordLink = onCall(
  { region: 'europe-west2', secrets: [encryptionKey, smtpUser, smtpPass], invoker: 'public' },
  async (request) => {
    // Check authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const { recipientEmail, recipientName, password, notes, sendNotification, batchId } = request.data;

    // Validate input
    if (!recipientEmail || !password) {
      throw new HttpsError('invalid-argument', 'Email and password are required');
    }

    try {
      // Get user info
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists) {
        throw new HttpsError('permission-denied', 'User not found');
      }
      const userData = userDoc.data();
      if (!userData || !['admin', 'technician'].includes(userData.role)) {
        throw new HttpsError('permission-denied', 'Insufficient permissions');
      }

      // Generate UUID for the link
      const linkId = uuidv4();

      // Encrypt the password
      const encrypted = encryptPassword(password, encryptionKey.value());

      // Create password document
      const passwordDoc: Omit<PasswordDoc, 'id'> = {
        encryptedPassword: encrypted.encryptedPassword,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        recipientEmail,
        recipientName: recipientName || '',
        notes: notes || '',
        createdBy: request.auth.uid,
        createdByEmail: userData.email || '',
        createdAt: admin.firestore.Timestamp.now(),
        status: 'pending',
        emailSent: false,
        source: batchId ? 'batch' : 'dashboard',
        searchTokens: buildSearchTokens(recipientEmail, recipientName),
        ...(batchId ? { batchId } : {}),
      };

      await db.collection('passwords').doc(linkId).set(passwordDoc);

      // Create audit log
      await db.collection('audit_logs').add({
        action: 'create',
        actorId: request.auth.uid,
        actorEmail: userData.email,
        targetId: linkId,
        details: {
          recipientEmail,
          recipientName,
          source: 'dashboard',
        },
        ip: request.rawRequest?.ip || 'unknown',
        timestamp: admin.firestore.Timestamp.now(),
      });

      const link = `${appUrl.value()}/p/${linkId}`;

      // Send email notification if requested
      if (sendNotification) {
        try {
          // Get email template
          const templateDoc = await db.collection('email_templates').doc('default').get();
          let subject = 'Your New Password - {{recipientName}}';
          let htmlBody = getDefaultHtmlTemplate();
          let textBody = getDefaultTextTemplate();

          if (templateDoc.exists) {
            const templateData = templateDoc.data();
            if (templateData) {
              subject = templateData.subject || subject;
              htmlBody = templateData.htmlBody || htmlBody;
              textBody = templateData.textBody || textBody;
            }
          }

          // Replace template variables
          const name = recipientName || recipientEmail.split('@')[0];
          subject = subject.replace(/{{recipientName}}/g, name);
          subject = subject.replace(/{{recipientEmail}}/g, recipientEmail);
          htmlBody = htmlBody.replace(/{{recipientName}}/g, name);
          htmlBody = htmlBody.replace(/{{recipientEmail}}/g, recipientEmail);
          htmlBody = htmlBody.replace(/{{link}}/g, link);
          textBody = textBody.replace(/{{recipientName}}/g, name);
          textBody = textBody.replace(/{{recipientEmail}}/g, recipientEmail);
          textBody = textBody.replace(/{{link}}/g, link);

          // Create transporter and send
          const transporter = nodemailer.createTransport({
            host: smtpHost.value(),
            port: parseInt(smtpPort.value(), 10),
            secure: false,
            auth: {
              user: smtpUser.value(),
              pass: smtpPass.value(),
            },
          });

          await transporter.sendMail({
            from: `"Password Portal" <${smtpUser.value()}>`,
            to: recipientEmail,
            subject,
            text: textBody,
            html: htmlBody,
          });

          // Update password document with email sent status
          await db.collection('passwords').doc(linkId).update({
            status: 'sent',
            emailSent: true,
            emailSentAt: admin.firestore.Timestamp.now(),
          });
          await adjustBatchCounts(batchId, 'pending', 'sent');
        } catch (emailError) {
          console.error('Failed to send email on creation:', emailError);
          // Don't fail the whole operation, just log - email can be resent from queue
        }
      }

      return {
        id: linkId,
        password, // Return password so technician can copy it
        link,
        recipientEmail,
        recipientName,
      };
    } catch (error) {
      console.error('Error creating password link:', error);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', 'Failed to create password link');
    }
  }
);

/**
 * Check if a password link is valid (callable function for public access)
 */
export const checkPasswordLink = onCall(
  { region: 'europe-west2', invoker: 'public' },
  async (request) => {
    const { id } = request.data;

    if (!id) {
      throw new HttpsError('invalid-argument', 'Link ID is required');
    }

    try {
      const doc = await db.collection('passwords').doc(id).get();

      if (!doc.exists) {
        return { valid: false };
      }

      const data = doc.data() as PasswordDoc;

      // Check if link has been used or expired
      if (data.status === 'viewed' || data.status === 'expired' || data.status === 'revoked') {
        return { valid: false };
      }

      return {
        valid: true,
        recipientName: data.recipientName,
      };
    } catch (error) {
      console.error('Error checking password link:', error);
      throw new HttpsError('internal', 'Failed to check link');
    }
  }
);

/**
 * View password (callable function - marks as viewed and deletes)
 */
export const viewPassword = onCall(
  { region: 'europe-west2', secrets: [encryptionKey], invoker: 'public' },
  async (request) => {
    const { id } = request.data;

    if (!id) {
      throw new HttpsError('invalid-argument', 'Link ID is required');
    }

    try {
      // Use transaction to ensure atomic read and update
      const result = await db.runTransaction(async (transaction) => {
        const docRef = db.collection('passwords').doc(id);
        const doc = await transaction.get(docRef);

        if (!doc.exists) {
          throw new HttpsError('not-found', 'Password link not found');
        }

        const data = doc.data() as PasswordDoc;

        // Check if already viewed
        if (data.status === 'viewed' || data.status === 'expired' || data.status === 'revoked') {
          throw new HttpsError('failed-precondition', 'This link has already been used');
        }

        // Decrypt password
        const password = decryptPassword(
          data.encryptedPassword,
          data.iv,
          data.authTag,
          encryptionKey.value()
        );

        // Mark as viewed and clear encrypted data
        transaction.update(docRef, {
          status: 'viewed',
          viewedAt: admin.firestore.Timestamp.now(),
          viewedFromIP: request.rawRequest?.ip || 'unknown',
          // Clear encrypted password data for security
          encryptedPassword: '',
          iv: '',
          authTag: '',
        });

        return {
          password,
          recipientName: data.recipientName,
          batchId: data.batchId,
          priorStatus: data.status,
        };
      });

      // Keep batch counters in sync: the link moved out of its prior bucket
      // (pending or sent) into viewed.
      await adjustBatchCounts(
        result.batchId,
        result.priorStatus === 'sent' ? 'sent' : 'pending',
        'viewed'
      );

      // Create audit log (outside transaction)
      await db.collection('audit_logs').add({
        action: 'view',
        targetId: id,
        details: {},
        ip: request.rawRequest?.ip || 'unknown',
        timestamp: admin.firestore.Timestamp.now(),
      });

      // Only expose the fields the viewer needs — not internal batch metadata.
      return { password: result.password, recipientName: result.recipientName };
    } catch (error) {
      console.error('Error viewing password:', error);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', 'Failed to retrieve password');
    }
  }
);

/**
 * Regenerate password link (create new link for same password)
 */
export const regeneratePasswordLink = onCall(
  { region: 'europe-west2', secrets: [encryptionKey], invoker: 'public' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const { originalId, password } = request.data;

    if (!originalId || !password) {
      throw new HttpsError('invalid-argument', 'Original ID and password are required');
    }

    try {
      // Get user info
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists) {
        throw new HttpsError('permission-denied', 'User not found');
      }
      const userData = userDoc.data();
      if (!userData || !['admin', 'technician'].includes(userData.role)) {
        throw new HttpsError('permission-denied', 'Insufficient permissions');
      }

      // Get original password doc
      const originalDoc = await db.collection('passwords').doc(originalId).get();
      if (!originalDoc.exists) {
        throw new HttpsError('not-found', 'Original password link not found');
      }
      const originalData = originalDoc.data() as PasswordDoc;

      // Generate new link ID
      const newLinkId = uuidv4();

      // Encrypt the password
      const encrypted = encryptPassword(password, encryptionKey.value());

      // Create new password document
      const passwordDoc: Omit<PasswordDoc, 'id'> = {
        encryptedPassword: encrypted.encryptedPassword,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        recipientEmail: originalData.recipientEmail,
        recipientName: originalData.recipientName,
        notes: originalData.notes,
        createdBy: request.auth.uid,
        createdByEmail: userData.email || '',
        createdAt: admin.firestore.Timestamp.now(),
        status: 'pending',
        emailSent: false,
        source: 'dashboard',
        searchTokens: buildSearchTokens(
          originalData.recipientEmail,
          originalData.recipientName
        ),
      };

      // Use transaction to update original and create new
      await db.runTransaction(async (transaction) => {
        // Mark original as revoked
        transaction.update(db.collection('passwords').doc(originalId), {
          status: 'revoked',
          regeneratedTo: newLinkId,
        });

        // Create new document
        transaction.set(db.collection('passwords').doc(newLinkId), {
          ...passwordDoc,
          regeneratedFrom: originalId,
        });
      });

      // Create audit log
      await db.collection('audit_logs').add({
        action: 'regenerate',
        actorId: request.auth.uid,
        actorEmail: userData.email,
        targetId: newLinkId,
        details: {
          originalId,
          recipientEmail: originalData.recipientEmail,
        },
        ip: request.rawRequest?.ip || 'unknown',
        timestamp: admin.firestore.Timestamp.now(),
      });

      const link = `${appUrl.value()}/p/${newLinkId}`;

      return {
        id: newLinkId,
        password,
        link,
        recipientEmail: originalData.recipientEmail,
        recipientName: originalData.recipientName,
      };
    } catch (error) {
      console.error('Error regenerating password link:', error);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', 'Failed to regenerate password link');
    }
  }
);

// ==================== External API ====================

/**
 * External API for creating password links (for Salamander automation)
 */
// ==================== Public generation API ====================

/** Largest `n` accepted on a single generation request. */
const MAX_BATCH = 100;

/** Hourly quota applied when the caller is not on an elevated allowlist tier. */
const FALLBACK_PUBLIC_LIMIT = 1000;

/**
 * Proxy trust configuration, parsed once per instance. Deployment-specific and
 * therefore configured rather than assumed — see docs/API.md.
 */
let proxyConfigCache: { raw: string; config: ProxyConfig } | null = null;

function getProxyConfig(): ProxyConfig {
  const hopsRaw = rateLimitProxyHops.value().trim();
  const proxiesRaw = rateLimitTrustedProxies.value().trim();
  const raw = `${hopsRaw}|${proxiesRaw}`;
  if (proxyConfigCache && proxyConfigCache.raw === raw) return proxyConfigCache.config;

  const hops = /^\d+$/.test(hopsRaw) ? Number(hopsRaw) : null;
  const config: ProxyConfig = { hops, trustedProxies: parseCidrList(proxiesRaw) };
  proxyConfigCache = { raw, config };

  if (hops === null && hopsRaw !== '') {
    console.warn(`RATE_LIMIT_PROXY_HOPS="${hopsRaw}" is not a number; elevated tiers disabled`);
  }
  return config;
}

function getPublicLimit(): number {
  const raw = rateLimitPublic.value().trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : FALLBACK_PUBLIC_LIMIT;
}

/**
 * Reduce the request path to a route key. Firebase Hosting forwards the full
 * `/api/...` path while the direct function URL omits the prefix, so strip it
 * and normalise the edges.
 */
function routePath(rawPath: string): string {
  let path = (rawPath || '/').split('?')[0];
  if (path === '/api' || path.startsWith('/api/')) path = path.slice(4);
  path = path.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

type Format = 'text' | 'json';

interface BadRequest {
  error: string;
}

function parseCount(raw: string | undefined): number | BadRequest {
  if (raw === undefined || raw === '') return 1;
  if (!/^\d+$/.test(raw)) return { error: 'n must be a whole number' };
  const n = Number(raw);
  if (n < 1 || n > MAX_BATCH) return { error: `n must be between 1 and ${MAX_BATCH}` };
  return n;
}

function parseFormat(raw: string | undefined): Format | BadRequest {
  if (raw === undefined || raw === '') return 'text';
  if (raw === 'text' || raw === 'json') return raw;
  return { error: "format must be 'text' or 'json'" };
}

function isBadRequest(value: unknown): value is BadRequest {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/** CORS for the read-only public routes. */
function setCors(res: Response): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

/** Throttle events already audited by this instance, to keep 429s from flooding audit_logs. */
const auditedThrottles = new Set<string>();

/** Emitted once per instance so the log records it without repeating per request. */
let warnedUntrusted = false;

async function auditThrottle(client: ResolvedClient, limit: number, resetAt: number): Promise<void> {
  const marker = `${client.key ?? 'unresolved'}_${resetAt}`;
  if (auditedThrottles.has(marker)) return;
  if (auditedThrottles.size > 5000) auditedThrottles.clear();
  auditedThrottles.add(marker);

  try {
    await db.collection('audit_logs').add({
      action: 'rate_limit_exceeded',
      details: { limit, resetAt, trusted: client.trusted },
      ip: client.ip,
      timestamp: Timestamp.now(),
    });
  } catch (error) {
    console.error('Failed to write rate limit audit entry:', error);
  }
}

interface Throttled {
  client: ResolvedClient;
  ok: boolean;
}

/**
 * Resolve the caller, pick their tier, and record the request.
 *
 * Elevated quota requires a *trusted* resolution. An address we cannot vouch
 * for still gets counted — it just never gets promoted, so forging
 * X-Forwarded-For buys nothing.
 */
async function applyRateLimit(req: Request, res: Response): Promise<Throttled> {
  const client = resolveClient(req, getProxyConfig());

  // Without trusted proxy configuration the caller cannot be identified, so
  // counters key off whichever proxy address terminated the request. That
  // address varies between requests, which fragments the buckets and leaves
  // the public limit effectively unenforced. Elevated tiers are off in this
  // state by design, but the limit being soft is worth saying out loud.
  if (!client.trusted && !warnedUntrusted) {
    warnedUntrusted = true;
    console.warn(
      `Rate limiting is running without trusted proxy configuration (${client.reason}). ` +
        'Counters may fragment across requests and the public limit will not be reliably ' +
        'enforced. Set RATE_LIMIT_PROXY_HOPS and RATE_LIMIT_TRUSTED_PROXIES — see the ' +
        '"Operating the API" section of the README.'
    );
  }

  let limit = getPublicLimit();

  if (client.trusted) {
    try {
      const entry = await findEntry(db, client.ip);
      if (entry?.generateLimit) limit = entry.generateLimit;
    } catch (error) {
      // Allowlist unavailable: serve the public limit rather than fail.
      console.error('Allowlist lookup failed; applying public limit:', error);
    }
  }

  const decision = await consume(db, bucketKey(client.key ?? 'unresolved'), limit);
  res.set(rateLimitHeaders(decision));

  if (!decision.allowed) {
    await auditThrottle(client, limit, decision.resetAt);
    res.status(429).json({
      error: 'Rate limit exceeded',
      limit,
      retryAfter: decision.retryAfter,
    });
    return { client, ok: false };
  }

  return { client, ok: true };
}

async function handleGeneratePasswords(
  req: Request,
  res: Response,
  mode: PasswordMode
): Promise<void> {
  const count = parseCount(firstQueryValue(req.query.n));
  if (isBadRequest(count)) {
    res.status(400).json(count);
    return;
  }

  const format = parseFormat(firstQueryValue(req.query.format));
  if (isBadRequest(format)) {
    res.status(400).json(format);
    return;
  }

  const requestedList = firstQueryValue(req.query.list);
  const selection = await resolveWords(db, requestedList);
  if (selection.notFound) {
    res.status(404).json({ error: `Unknown word list: ${requestedList}` });
    return;
  }

  // No built-in fallback list: with nothing configured there is nothing to
  // generate from, and saying so beats inventing a vocabulary.
  if (selection.words.length === 0) {
    res.status(503).json({
      error: 'No word lists are configured',
      detail: 'Add a word list in Settings > Word Lists before generating passwords.',
    });
    return;
  }

  const passwords = generateMany(count, selection.words, mode);

  // Generated credentials must never be cached by a proxy or the browser.
  res.set('Cache-Control', 'no-store');

  if (format === 'json') {
    res.status(200).json({
      passwords,
      count: passwords.length,
      type: mode,
      ...(selection.listName ? { list: selection.listName } : {}),
    });
    return;
  }

  res.status(200).type('text/plain').send(passwords.join('\n'));
}

async function handleHasWord(req: Request, res: Response): Promise<void> {
  const word = firstQueryValue(req.query.word);
  if (!word) {
    res.status(400).json({ error: 'word is required' });
    return;
  }

  const format = parseFormat(firstQueryValue(req.query.format));
  if (isBadRequest(format)) {
    res.status(400).json(format);
    return;
  }

  const found = await hasWord(db, word);
  if (format === 'json') {
    res.status(200).json({ word, found });
    return;
  }
  res.status(200).type('text/plain').send(String(found));
}

async function handleWordLists(res: Response): Promise<void> {
  const names = await listNames(db);
  res.status(200).json({ lists: names, count: names.length });
}

function handleIndex(res: Response): void {
  res.status(200).json({
    endpoints: {
      'GET /api/password/simple': 'Word + Word + 2 digits, e.g. TreeBridge47',
      'GET /api/password/secure': 'Word + digit + Word + symbol + Word, e.g. Movie3Cartoon)Bottle',
      'GET /api/password/word4': 'Word + 4 digits, e.g. Tiger4829',
      'GET /api/password': "As above, with ?style=simple|secure|word4",
      'GET /api/hasword': 'Is ?word= present in the configured word lists',
      'GET /api/wordlists': 'Names of the configured word lists',
      'POST /api': 'Create a password link (requires X-API-Key)',
    },
    parameters: {
      n: `1-${MAX_BATCH}, default 1`,
      format: 'text (default) or json',
      list: 'optional word list name',
    },
    documentation: 'Settings > API Docs in the Password Portal',
  });
}

/**
 * Diagnostic that reports how this deployment sees the request chain, so an
 * operator can determine the correct RATE_LIMIT_PROXY_HOPS and
 * RATE_LIMIT_TRUSTED_PROXIES values.
 *
 * Requires an API key: the response exposes the internal proxy addresses. It
 * deliberately skips the IP allowlist, since its whole purpose is configuring
 * the IP handling that gate depends on.
 */
async function handleWhoami(req: Request, res: Response): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(401).json({ error: 'API key required' });
    return;
  }

  const keysSnapshot = await db
    .collection('api_keys')
    .where('keyHash', '==', hashApiKey(apiKey))
    .where('active', '==', true)
    .get();

  if (keysSnapshot.empty) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const config = getProxyConfig();
  const client = resolveClient(req, config);

  // What each candidate hop count would resolve to, so the correct value can
  // be read straight off the response.
  const candidates: Record<string, string> = {};
  for (let hops = 0; hops < client.chain.length; hops++) {
    candidates[String(hops)] = client.chain[client.chain.length - 1 - hops];
  }

  res.status(200).json({
    resolved: { ip: client.ip, trusted: client.trusted, reason: client.reason ?? null },
    chain: client.chain,
    socketAddress: normalizeIp(String(req.ip || '')) ?? null,
    candidatesByHopCount: candidates,
    configured: {
      hops: config.hops,
      trustedProxies: config.trustedProxies.map((cidr) => cidr.source),
      publicLimitPerHour: getPublicLimit(),
    },
    hint:
      client.chain.length === 0
        ? 'No X-Forwarded-For header was present on this request.'
        : 'Set RATE_LIMIT_PROXY_HOPS to the key in candidatesByHopCount whose value is your real client IP, and RATE_LIMIT_TRUSTED_PROXIES to the prefixes covering every entry to its right.',
  });
}

async function handleGet(path: string, req: Request, res: Response): Promise<void> {
  setCors(res);

  if (path === '/whoami') {
    await handleWhoami(req, res);
    return;
  }

  const throttle = await applyRateLimit(req, res);
  if (!throttle.ok) return;

  if (path === '/') {
    handleIndex(res);
    return;
  }
  if (path === '/hasword') {
    await handleHasWord(req, res);
    return;
  }
  if (path === '/wordlists') {
    await handleWordLists(res);
    return;
  }

  if (path === '/password') {
    const style = firstQueryValue(req.query.style) ?? 'simple';
    if (!isPasswordMode(style)) {
      res.status(400).json({ error: `style must be one of: ${PASSWORD_MODES.join(', ')}` });
      return;
    }
    await handleGeneratePasswords(req, res, style);
    return;
  }

  const match = /^\/password\/([a-z0-9]+)$/.exec(path);
  if (match) {
    const style = match[1];
    if (!isPasswordMode(style)) {
      res.status(404).json({ error: `Unknown password style: ${style}` });
      return;
    }
    await handleGeneratePasswords(req, res, style);
    return;
  }

  res.status(404).json({ error: 'Not found' });
}

/**
 * Single HTTP entry point. Firebase Hosting rewrites /api/** here, and the
 * function is also reachable at its own URL.
 */
export const api = onRequest(
  {
    region: 'europe-west2',
    cors: false,
    maxInstances: 20,
    secrets: [encryptionKey, smtpUser, smtpPass],
  },
  async (req, res) => {
    const path = routePath(req.path);

    try {
      if (req.method === 'OPTIONS') {
        setCors(res);
        res.status(204).send('');
        return;
      }

      if (req.method === 'GET') {
        await handleGet(path, req, res);
        return;
      }

      if (req.method === 'POST' && path === '/') {
        await handleCreateLink(req, res);
        return;
      }

      res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      if (error instanceof WordListsUnavailableError) {
        // Already logged with its cause where the read failed.
        console.error(`Word lists unavailable on ${req.method} ${path}`);
        if (!res.headersSent) {
          res.status(503).json({ error: 'Word lists are temporarily unavailable' });
        }
        return;
      }
      console.error(`Unhandled error on ${req.method} ${path}:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api - create a password link. Unchanged behaviour: API key required,
 * IP allowlist enforced when one is configured.
 */
async function handleCreateLink(req: Request, res: Response): Promise<void> {
    // Check API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      res.status(401).json({ error: 'API key required' });
      return;
    }

    try {
      // Validate API key
      const keyHash = hashApiKey(apiKey);
      const keysSnapshot = await db
        .collection('api_keys')
        .where('keyHash', '==', keyHash)
        .where('active', '==', true)
        .get();

      if (keysSnapshot.empty) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }

      const apiKeyDoc = keysSnapshot.docs[0];
      const apiKeyData = apiKeyDoc.data();

      // Check IP allowlist. Entries now support CIDR prefixes, and only those
      // with allowApi grant access here.
      //
      // The gate tests every address this request could plausibly be
      // attributed to, not just the strictly-resolved one. Before CIDR support
      // this check compared against `req.ip || x-forwarded-for`, so existing
      // allowlist rows were written to match whatever that produced; narrowing
      // to a single resolution would lock out working integrations on deploy.
      // That is acceptable here and only here: this endpoint is already
      // authenticated by API key, so the IP test is defence in depth rather
      // than the primary control. The generation endpoints, where an IP alone
      // grants elevated quota, use the strict resolution only.
      const resolved = resolveClient(req, getProxyConfig());
      const clientIP = resolved.ip;
      const candidates = Array.from(
        new Set(
          [
            resolved.ip,
            normalizeIp(String(req.ip || '')),
            resolved.chain[0],
            resolved.chain[resolved.chain.length - 1],
          ].filter((candidate): candidate is string => !!candidate)
        )
      );

      let gateConfigured = false;
      let gateAllowed = false;
      for (const candidate of candidates) {
        const gate = await checkApiAccess(db, candidate);
        gateConfigured = gate.configured;
        if (!gate.configured || gate.allowed) {
          gateAllowed = true;
          break;
        }
      }

      if (gateConfigured && !gateAllowed) {
        res.status(403).json({ error: 'IP not whitelisted' });
        return;
      }

      // Parse request body
      const { recipientEmail, recipientName, password, notes, sendEmail } = req.body;

      if (!recipientEmail || !password) {
        res.status(400).json({ error: 'recipientEmail and password are required' });
        return;
      }

      // Generate link ID
      const linkId = uuidv4();

      // Encrypt password
      const encrypted = encryptPassword(password, encryptionKey.value());

      // Create password document
      const passwordDoc = {
        encryptedPassword: encrypted.encryptedPassword,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        recipientEmail,
        recipientName: recipientName || '',
        notes: notes || '',
        createdBy: 'api',
        createdByEmail: `API: ${apiKeyData.name}`,
        createdAt: Timestamp.now(),
        status: sendEmail ? 'sent' : 'pending',
        emailSent: !!sendEmail,
        source: 'api',
        apiKeyId: apiKeyDoc.id,
        searchTokens: buildSearchTokens(recipientEmail, recipientName),
        ...(sendEmail && { emailSentAt: Timestamp.now() }),
      };

      await db.collection('passwords').doc(linkId).set(passwordDoc);

      // Update API key last used
      await apiKeyDoc.ref.update({
        lastUsed: Timestamp.now(),
      });

      // Create audit log
      await db.collection('audit_logs').add({
        action: 'api_call',
        targetId: linkId,
        details: {
          apiKeyId: apiKeyDoc.id,
          apiKeyName: apiKeyData.name,
          recipientEmail,
          action: 'create',
        },
        ip: clientIP as string,
        timestamp: Timestamp.now(),
      });

      const link = `${appUrl.value()}/p/${linkId}`;

      // Send email if requested
      if (sendEmail) {
        try {
          // Get email template
          const templateDoc = await db.collection('email_templates').doc('default').get();
          let subject = 'Your New Password - {{recipientName}}';
          let htmlBody = getDefaultHtmlTemplate();
          let textBody = getDefaultTextTemplate();

          if (templateDoc.exists) {
            const templateData = templateDoc.data();
            if (templateData) {
              subject = templateData.subject || subject;
              htmlBody = templateData.htmlBody || htmlBody;
              textBody = templateData.textBody || textBody;
            }
          }

          // Replace template variables
          const name = recipientName || recipientEmail.split('@')[0];
          subject = subject.replace(/{{recipientName}}/g, name);
          subject = subject.replace(/{{recipientEmail}}/g, recipientEmail);
          htmlBody = htmlBody.replace(/{{recipientName}}/g, name);
          htmlBody = htmlBody.replace(/{{recipientEmail}}/g, recipientEmail);
          htmlBody = htmlBody.replace(/{{link}}/g, link);
          textBody = textBody.replace(/{{recipientName}}/g, name);
          textBody = textBody.replace(/{{recipientEmail}}/g, recipientEmail);
          textBody = textBody.replace(/{{link}}/g, link);

          // Create transporter and send
          const transporter = nodemailer.createTransport({
            host: smtpHost.value(),
            port: parseInt(smtpPort.value(), 10),
            secure: false,
            auth: {
              user: smtpUser.value(),
              pass: smtpPass.value(),
            },
          });

          await transporter.sendMail({
            from: `"Password Portal" <${smtpUser.value()}>`,
            to: recipientEmail,
            subject,
            text: textBody,
            html: htmlBody,
          });
        } catch (emailError) {
          console.error('Failed to send email via API:', emailError);
          // Don't fail the request, just log - the link was still created
        }
      }

      res.status(201).json({
        success: true,
        id: linkId,
        link,
        status: passwordDoc.status,
      });
    } catch (error) {
      console.error('API error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
}

// ==================== Admin Functions ====================

/**
 * Backfill `searchTokens` on existing password documents. Admin-only.
 * Idempotent — run it as many times as you want; it only touches docs that
 * are missing or have an empty `searchTokens` field. Processes in batches of
 * 400 to stay within Firestore's 500-op batch write limit.
 */
export const backfillSearchTokens = onCall(
  { region: 'europe-west2', invoker: 'public', timeoutSeconds: 540 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data()?.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Admin access required');
    }

    const snapshot = await db.collection('passwords').get();
    let updated = 0;
    let skipped = 0;
    let batch = db.batch();
    let opsInBatch = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const existing = data.searchTokens as string[] | undefined;
      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }
      const tokens = buildSearchTokens(
        data.recipientEmail || '',
        data.recipientName
      );
      batch.update(doc.ref, { searchTokens: tokens });
      opsInBatch++;
      updated++;

      if (opsInBatch >= 400) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }

    if (opsInBatch > 0) {
      await batch.commit();
    }

    await db.collection('audit_logs').add({
      action: 'settings_change',
      actorId: request.auth.uid,
      actorEmail: userDoc.data()?.email,
      details: { operation: 'backfillSearchTokens', updated, skipped },
      ip: request.rawRequest?.ip || 'unknown',
      timestamp: admin.firestore.Timestamp.now(),
    });

    return {
      total: snapshot.size,
      updated,
      skipped,
    };
  }
);

/**
 * Create a new API key (admin only)
 */
export const createApiKey = onCall(
  { region: 'europe-west2', invoker: 'public' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const { name } = request.data;

    if (!name) {
      throw new HttpsError('invalid-argument', 'Name is required');
    }

    try {
      // Check if user is admin
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists || userDoc.data()?.role !== 'admin') {
        throw new HttpsError('permission-denied', 'Admin access required');
      }

      // Generate API key
      const apiKey = generateApiKey();
      const keyHash = hashApiKey(apiKey);
      const keyPrefix = apiKey.substring(0, 8);

      // Create API key document
      const docRef = await db.collection('api_keys').add({
        name,
        keyHash,
        keyPrefix,
        createdBy: request.auth.uid,
        createdByEmail: userDoc.data()?.email || '',
        createdAt: admin.firestore.Timestamp.now(),
        active: true,
      });

      // Create audit log
      await db.collection('audit_logs').add({
        action: 'settings_change',
        actorId: request.auth.uid,
        actorEmail: userDoc.data()?.email,
        targetId: docRef.id,
        details: {
          type: 'api_key_created',
          name,
        },
        ip: request.rawRequest?.ip || 'unknown',
        timestamp: admin.firestore.Timestamp.now(),
      });

      // Return the API key (only time it's visible)
      return {
        id: docRef.id,
        apiKey, // Only returned once!
        name,
        keyPrefix,
      };
    } catch (error) {
      console.error('Error creating API key:', error);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', 'Failed to create API key');
    }
  }
);

// ==================== Email Functions ====================

/**
 * Send password notification email
 */
export const sendPasswordEmail = onCall(
  {
    region: 'europe-west2',
    secrets: [smtpUser, smtpPass],
    invoker: 'public',
  },
  async (request) => {
    console.log('sendPasswordEmail called');

    if (!request.auth) {
      console.log('No auth');
      throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const { passwordId } = request.data;
    console.log('passwordId:', passwordId);

    if (!passwordId) {
      throw new HttpsError('invalid-argument', 'Password ID is required');
    }

    try {
      // Check user permissions
      console.log('Checking user permissions for:', request.auth.uid);
      const userDoc = await db.collection('users').doc(request.auth.uid).get();
      if (!userDoc.exists || !['admin', 'technician'].includes(userDoc.data()?.role)) {
        console.log('Permission denied');
        throw new HttpsError('permission-denied', 'Insufficient permissions');
      }
      console.log('User has permission');

      // Get password document to retrieve recipient info
      console.log('Getting password document');
      const passwordDoc = await db.collection('passwords').doc(passwordId).get();
      if (!passwordDoc.exists) {
        console.log('Password not found');
        throw new HttpsError('not-found', 'Password not found');
      }
      const passwordData = passwordDoc.data() as PasswordDoc;
      const recipientEmail = passwordData.recipientEmail;
      const recipientName = passwordData.recipientName || '';
      const priorStatus = passwordData.status;
      const link = `${appUrl.value()}/p/${passwordId}`;
      console.log('Sending to:', recipientEmail, 'Link:', link);

      // Get email template
      const templateDoc = await db.collection('email_templates').doc('default').get();
      let subject = 'Your New Password - {{recipientName}}';
      let htmlBody = getDefaultHtmlTemplate();
      let textBody = getDefaultTextTemplate();

      if (templateDoc.exists) {
        const templateData = templateDoc.data();
        if (templateData) {
          subject = templateData.subject || subject;
          htmlBody = templateData.htmlBody || htmlBody;
          textBody = templateData.textBody || textBody;
        }
      }

      // Replace template variables
      const name = recipientName || recipientEmail.split('@')[0];
      subject = subject.replace(/{{recipientName}}/g, name);
      subject = subject.replace(/{{recipientEmail}}/g, recipientEmail);
      htmlBody = htmlBody.replace(/{{recipientName}}/g, name);
      htmlBody = htmlBody.replace(/{{recipientEmail}}/g, recipientEmail);
      htmlBody = htmlBody.replace(/{{link}}/g, link);
      textBody = textBody.replace(/{{recipientName}}/g, name);
      textBody = textBody.replace(/{{recipientEmail}}/g, recipientEmail);
      textBody = textBody.replace(/{{link}}/g, link);

      // Create transporter
      console.log('Creating SMTP transporter with host:', smtpHost.value(), 'port:', smtpPort.value());
      console.log('SMTP user:', smtpUser.value());
      const transporter = nodemailer.createTransport({
        host: smtpHost.value(),
        port: parseInt(smtpPort.value(), 10),
        secure: false, // Use TLS
        auth: {
          user: smtpUser.value(),
          pass: smtpPass.value(),
        },
      });

      // Send email
      console.log('Sending email...');
      await transporter.sendMail({
        from: `"Password Portal" <${smtpUser.value()}>`,
        to: recipientEmail,
        subject,
        text: textBody,
        html: htmlBody,
      });
      console.log('Email sent successfully');

      // Update password document
      await db.collection('passwords').doc(passwordId).update({
        status: 'sent',
        emailSent: true,
        emailSentAt: admin.firestore.Timestamp.now(),
        lastError: admin.firestore.FieldValue.delete(),
      });

      // Keep batch counters in sync when resending a batch member. A resend of
      // an already-sent link doesn't move buckets; a first send from
      // pending/failed does.
      if (priorStatus !== 'sent' && priorStatus !== 'viewed') {
        await adjustBatchCounts(
          passwordData.batchId,
          priorStatus === 'failed' ? 'failed' : 'pending',
          'sent'
        );
      }

      // Create audit log
      await db.collection('audit_logs').add({
        action: 'send_email',
        actorId: request.auth.uid,
        actorEmail: userDoc.data()?.email,
        targetId: passwordId,
        details: {
          recipientEmail,
          recipientName: name,
        },
        ip: request.rawRequest?.ip || 'unknown',
        timestamp: admin.firestore.Timestamp.now(),
      });

      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      console.error('Error sending email:', err.message);
      console.error('Error stack:', err.stack);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', `Failed to send email: ${err.message}`);
    }
  }
);

/**
 * Send every not-yet-delivered email in a batch, durably and throttled.
 *
 * Runs entirely server-side so closing the tab can't abort it. Uses ONE pooled
 * SMTP connection with a send-rate cap, retries transient Gmail deferrals
 * (421/454) with exponential backoff, and records per-recipient success/failure
 * on each password doc (`status: 'failed'` + `lastError`). A single failure
 * never aborts the rest of the batch. Progress is written to the batch's
 * `sendJob` so the queue UI can show it live. Re-running picks up whatever is
 * still pending/failed, so it's safely resumable.
 */
export const sendBatchEmails = onCall(
  {
    region: 'europe-west2',
    secrets: [smtpUser, smtpPass],
    invoker: 'public',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const { batchId, mode } = request.data as {
      batchId?: string;
      mode?: 'remaining' | 'failed';
    };
    if (!batchId) {
      throw new HttpsError('invalid-argument', 'batchId is required');
    }

    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || !['admin', 'technician'].includes(userDoc.data()?.role)) {
      throw new HttpsError('permission-denied', 'Insufficient permissions');
    }

    const batchRef = db.collection('batches').doc(batchId);
    const batchSnap = await batchRef.get();
    if (!batchSnap.exists) {
      throw new HttpsError('not-found', 'Batch not found');
    }

    // Which links to send: failed-only (retry) or everything not yet delivered.
    const statuses = mode === 'failed' ? ['failed'] : ['pending', 'failed'];
    const membersSnap = await db
      .collection('passwords')
      .where('batchId', '==', batchId)
      .where('status', 'in', statuses)
      .get();
    const members = membersSnap.docs;
    const total = members.length;

    if (total === 0) {
      return { total: 0, sent: 0, failed: 0 };
    }

    // Mark the job running so the UI shows live progress immediately.
    await batchRef.update({
      sendJob: {
        state: 'running',
        total,
        sent: 0,
        failed: 0,
        startedAt: admin.firestore.Timestamp.now(),
        requestedBy: request.auth.uid,
      },
    });

    const template = await loadEmailTemplate();

    // ONE pooled connection with a send-rate cap — the opposite of the old
    // "new SMTP connection per email as fast as possible" that Gmail throttled.
    const transporter = nodemailer.createTransport({
      host: smtpHost.value(),
      port: parseInt(smtpPort.value(), 10),
      secure: false,
      auth: { user: smtpUser.value(), pass: smtpPass.value() },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5, // at most 5 messages/sec across the pool
    });

    const batchCounts = (batchSnap.data()?.counts || {}) as Record<string, number>;
    let cPending = batchCounts.pending || 0;
    let cSent = batchCounts.sent || 0;
    let cFailed = batchCounts.failed || 0;
    let sent = 0;
    let failed = 0;
    let processed = 0;
    let lastFlush = 0;

    // Flush progress to Firestore at most once per 10 messages (and on demand)
    // to avoid hammering the single batch doc, which would hit write contention.
    const flush = async (force: boolean) => {
      if (!force && processed - lastFlush < 10) return;
      lastFlush = processed;
      await batchRef.update({
        'counts.pending': cPending,
        'counts.sent': cSent,
        'counts.failed': cFailed,
        'sendJob.sent': sent,
        'sendJob.failed': failed,
      });
    };

    try {
      for (const docSnap of members) {
        const data = docSnap.data() as PasswordDoc;
        const wasFailed = data.status === 'failed';
        const link = `${appUrl.value()}/p/${docSnap.id}`;
        const email = renderEmail(template, data.recipientEmail, data.recipientName, link);

        let success = false;
        let lastErr = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await transporter.sendMail({
              from: `"Password Portal" <${smtpUser.value()}>`,
              to: data.recipientEmail,
              subject: email.subject,
              text: email.text,
              html: email.html,
            });
            success = true;
            break;
          } catch (err) {
            lastErr = (err as Error).message || 'Send failed';
            // Give up early on permanent errors (bad mailbox etc.); back off and
            // retry on transient deferrals.
            if (!isTransientMailError(err) || attempt === 2) break;
            await sleep(2000 * Math.pow(2, attempt)); // 2s, then 4s
          }
        }

        if (success) {
          await docSnap.ref.update({
            status: 'sent',
            emailSent: true,
            emailSentAt: admin.firestore.Timestamp.now(),
            lastError: admin.firestore.FieldValue.delete(),
          });
          if (wasFailed) cFailed = Math.max(0, cFailed - 1);
          else cPending = Math.max(0, cPending - 1);
          cSent += 1;
          sent += 1;
        } else {
          await docSnap.ref.update({ status: 'failed', lastError: lastErr });
          if (!wasFailed) {
            cPending = Math.max(0, cPending - 1);
            cFailed += 1;
          }
          failed += 1;
        }

        processed += 1;
        await flush(false);
        // Base pacing between messages, on top of the pool's rate limit.
        await sleep(150);
      }
    } finally {
      transporter.close();
      await batchRef.update({
        'counts.pending': cPending,
        'counts.sent': cSent,
        'counts.failed': cFailed,
        'sendJob.sent': sent,
        'sendJob.failed': failed,
        'sendJob.state': 'done',
        'sendJob.finishedAt': admin.firestore.Timestamp.now(),
      });
    }

    await db.collection('audit_logs').add({
      action: 'send_email',
      actorId: request.auth.uid,
      actorEmail: userDoc.data()?.email,
      targetId: batchId,
      details: { batch: true, total, sent, failed },
      ip: request.rawRequest?.ip || 'unknown',
      timestamp: admin.firestore.Timestamp.now(),
    });

    return { total, sent, failed };
  }
);

/**
 * Default HTML email template
 */
function getDefaultHtmlTemplate(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #283E49; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #283E49; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; background: #f5f5f5; }
    .button { display: inline-block; padding: 12px 24px; background: #89CCCA; color: #283E49; text-decoration: none; border-radius: 6px; font-weight: bold; }
    .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Password Portal</h1>
    </div>
    <div class="content">
      <p>Hello {{recipientName}},</p>
      <p>A new password has been created for you. Click the button below to view your password:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="{{link}}" class="button">View Your Password</a>
      </p>
      <p><strong>Important:</strong> This link can only be used once. Once you view your password, the link will expire immediately.</p>
      <p>If you did not request this password, please contact the IT team.</p>
    </div>
    <div class="footer">
      <p>Initio Learning Trust - Central IT Team</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Default plain text email template
 */
function getDefaultTextTemplate(): string {
  return `Hello {{recipientName}},

A new password has been created for you.

Click this link to view your password:
{{link}}

Important: This link can only be used once. Once you view your password, the link will expire immediately.

If you did not request this password, please contact the IT team.

---
Initio Learning Trust - Central IT Team`;
}
