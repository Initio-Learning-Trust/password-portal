# Password Portal

A secure, one-time password sharing portal for Initio Learning Trust. IT and Helpdesk staff can securely send passwords to end users via single-use links.

## Features

- **One-time links** - Passwords are deleted after viewing
- **Email notifications** - Send password links directly to recipients
- **Batch upload** - Create multiple password links via CSV
- **Password generator** - Generate memorable passwords like "Sunset-Tiger-42"
- **Queue management** - Track and manage all password links
- **API access** - Integrate with automation tools (e.g., Salamander)
- **Audit logging** - Full activity history
- **Role-based access** - Admin and Technician roles

---

## User Guide

### Logging In

1. Go to [password.initiolearning.org](https://password.initiolearning.org)
2. Click **Sign in with Google**
3. Use your @initiolearning.org account

---

### Creating a Password Link

1. Click **Create Password** in the sidebar
2. Enter the recipient's **email** and **name**
3. Either:
   - Click **Generate Password** for a memorable password
   - Or enter a custom password manually
4. Toggle **Send email notification** if you want to email the link
5. Click **Create Password Link**
6. Copy the password and/or link to share

---

### Batch Upload (Multiple Users)

For creating many password links at once:

1. Go to **Batch Upload** in the sidebar
2. Click **Download Template** to get the CSV format
3. Fill in your CSV file:

```csv
email,name,password,notes
john.smith@school.org,John Smith,,New starter
jane.doe@school.org,Jane Doe,,Password reset
bob.jones@school.org,Bob Jones,CustomPass123,Manual password
```

| Column | Required | Description |
|--------|----------|-------------|
| email | Yes | Recipient's email address |
| name | No | Recipient's display name |
| password | No | Leave blank to auto-generate |
| notes | No | Internal notes (not sent to user) |

4. Upload the CSV file
5. Review the preview - you can regenerate passwords or remove rows
6. Click **Create Password Links**
7. Download the results CSV with all the generated links

---

### Queue Management

View and manage all password links:

1. Go to **Queue** in the sidebar
2. Filter by status: Pending, Sent, Viewed, Expired, Revoked
3. Filter by source: Dashboard, API, Batch
4. Search by email

**Actions:**
- **Send** - Email the link to the recipient
- **Revoke** - Invalidate the link (can't be used)
- **Delete** - Remove the record entirely

**Bulk Actions:**
- Select multiple items with checkboxes
- Click **Send Selected** to email all at once

---

### Settings (Admin Only)

#### API Keys
Create API keys for automation tools:
1. Go to **Settings** → **API Keys**
2. Click **Create API Key**
3. Enter a name (e.g., "Salamander")
4. Copy the key immediately - it won't be shown again!

#### IP Whitelist
Two independent grants, set per entry:
1. Go to **Settings** → **IP Whitelist**
2. Add an IP address or CIDR range
3. **Generation limit** raises the hourly quota on the public generation
   endpoints for that address. Blank uses the default.
4. **Allow password-link creation** grants `POST /api`. Off by default, so
   raising a quota never widens API access by accident.

If no entry grants API access, `POST /api` accepts any IP — the same behaviour
as an empty list. See [Operating the API](#operating-the-api); elevated
generation limits need one-time proxy configuration before they take effect.

#### Word Lists
Customize the password generator:
1. Go to **Settings** → **Word Lists**
2. Add custom word lists (e.g., Animals, Nature, School)
3. Words are used to generate memorable passwords

These lists feed both the in-app generator and the public generation API. With
no lists configured, a built-in default list is used.

#### Email Templates
Customize notification emails:
1. Go to **Settings** → **Email Templates**
2. Edit the subject, HTML body, and plain text body
3. Available variables:
   - `{{recipientName}}` - Recipient's name
   - `{{recipientEmail}}` - Recipient's email
   - `{{link}}` - Password view link

#### Users
Manage user roles:
1. Go to **Settings** → **Users**
2. Change roles between Admin and Technician

| Role | Permissions |
|------|-------------|
| Admin | Full access including Settings |
| Technician | Create/manage passwords only |

#### Audit Log
View all system activity:
1. Go to **Settings** → **Audit Log**
2. Filter by action type
3. Export to CSV for compliance

---

## API Documentation

Integrator-facing reference: **[docs/API.md](docs/API.md)** — that file is
written to be sent to third parties as-is.

Summary:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/password/{simple,secure,word4}` | none | Generate passwords |
| `GET /api/password?style=…` | none | Generate passwords |
| `GET /api/wordlists` | none | List configured word lists |
| `GET /api/hasword?word=…` | none | Word membership check |
| `GET /api/whoami` | API key | Proxy/IP diagnostic (see below) |
| `POST /api` | API key | Create a password link |

`POST /api` is unchanged from before the generation endpoints were added.

---

## Operating the API

### Rate limits

Generation endpoints are public and rate limited per IP. Configuration lives in
`functions/.env`, which is committed — these are non-secret values, and CI must
deploy the same ones a local deploy would. Edit the file and redeploy functions
for a change to take effect.

| Parameter | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_PUBLIC_PER_HOUR` | `1000` | Hourly limit for callers not on an elevated tier |
| `RATE_LIMIT_PROXY_HOPS` | unset | Proxies that append to `X-Forwarded-For` between the client and the function |
| `RATE_LIMIT_TRUSTED_PROXIES` | unset | CIDR prefixes those proxies come from |

Counters live in the `rate_limits` collection, keyed by a hashed IP and the
hour. Put a Firestore TTL policy on the `expiresAt` field of that collection so
they are reclaimed automatically.

The function is capped at `maxInstances: 20`. That cap, not the rate limiter, is
the hard ceiling on what a distributed abuser can cost you.

### Raising the limit for a specific server

Settings → IP Whitelist. Add the server's address or CIDR range and set
**Generation limit** to the hourly figure you want. Leave **Allow
password-link creation** unticked unless that server also needs `POST /api` —
the two grants are independent.

Changes take up to 5 minutes to reach live traffic (in-process cache).

### Proxy trust (already configured)

`RATE_LIMIT_PROXY_HOPS=1` and `RATE_LIMIT_TRUSTED_PROXIES` are set in
`functions/.env`, measured against the live deployment. Requests arriving
through Firebase Hosting show a two-entry chain, `[client, google-frontend]`,
so the client is one hop from the right.

The trailing hop rotates across several Google ranges between requests, so
`RATE_LIMIT_TRUSTED_PROXIES` holds Google's full published IPv4 and IPv6 list
from <https://www.gstatic.com/ipranges/goog.json> rather than a few observed
addresses. `functions/trusted-proxies.json` is the same list, used by the tests.

Refresh both if elevated tiers start intermittently falling back to the public
limit — that is the symptom of a front-end range that is not on the list. The
failure is safe (a caller drops to the public limit, never gains one they
should not have), but it is silent.

The procedure below is what produced those values, kept for when the routing
changes.

### Re-measuring the proxy chain

**This configuration gates rate limiting itself, not only the elevated tiers.**
Without it the limiter cannot identify callers and keys its counters off
whichever proxy address terminated the request. That address varies between
requests, so counters fragment and the public limit is not reliably enforced.
The function logs a warning once per instance while in that state.

An elevated limit is granted on the strength of an IP address, so the
deployment has to be able to identify the caller's IP with confidence.
`X-Forwarded-For` is append-only — anything a caller sends arrives as a prefix
— so the trustworthy entry is a fixed number of hops from the *right*, and
every entry to its right must be a known proxy. Until both values are
configured, elevated tiers stay off and every caller gets the public limit.

To determine them:

1. From the server you intend to allowlist, call the diagnostic with a valid
   API key, using the same URL your integration uses:

   ```
   curl -H "X-API-Key: <key>" https://password.initiolearning.org/api/whoami
   ```

2. In `candidatesByHopCount`, find the key whose value is that server's real
   public IP. That number is `RATE_LIMIT_PROXY_HOPS`.

3. Set `RATE_LIMIT_TRUSTED_PROXIES` to CIDR prefixes covering every `chain`
   entry to the right of it.

4. Redeploy and call `/api/whoami` again. `resolved.trusted` must be `true`
   and `resolved.ip` must be the server's real address. If `trusted` is
   `false`, `resolved.reason` says why.

Determine the values against the URL integrators actually use. A caller
reaching the function by a different route has a different chain, and the
trusted-proxy check is what stops that route being used to forge an address —
so do not widen `RATE_LIMIT_TRUSTED_PROXIES` beyond the prefixes you saw in
step 3.

### Tests

```
cd functions && npm run build
node test-ip-matching.js          # CIDR matching, IP resolution, spoofing cases
node test-ratelimit-allowlist.js  # needs: firebase emulators:start --only functions,firestore
```

---

## Security

- Passwords are encrypted with AES-256-GCM
- Links use UUID v4 (122 bits of randomness)
- Passwords are deleted from database after viewing
- All actions are logged for audit
- Google Workspace SSO with domain restriction
- API access requires key + IP whitelist

---

## Technical Setup

### Requirements
- Node.js 20+
- Firebase project (Blaze plan)
- Google Workspace account for SMTP

### Environment Variables

Frontend (`.env`):
```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

Cloud Functions secrets:
```
PASSWORD_ENCRYPTION_KEY  # 64-character hex string
SMTP_USER                # Google Workspace email
SMTP_PASS                # App password
```

Cloud Functions parameters (`functions/.env`, not secret):
```
APP_URL                      # Public site URL used in generated links
SMTP_HOST                    # Default: smtp.gmail.com
SMTP_PORT                    # Default: 587
RATE_LIMIT_PUBLIC_PER_HOUR   # Default: 1000
RATE_LIMIT_PROXY_HOPS        # Unset. See "Operating the API"
RATE_LIMIT_TRUSTED_PROXIES   # Unset. See "Operating the API"
```

### Deployment

Pushes to `main` build and deploy automatically via
`.github/workflows/deploy.yml`, which deploys hosting, functions and Firestore
rules in one invocation. Pull requests run the build and type checks only.

The workflow refuses to deploy if any required repository secret is unset, and
again if the built bundle does not contain the injected Firebase API key. Both
checks exist because an earlier version of this workflow shipped bundles with
empty config that crashed in production with `auth/invalid-api-key`.

The deploy step pins `firebase-tools` explicitly. That version must support the
Node runtime in `functions/package.json` — a firebase-tools older than the
runtime rejects the `engines` field outright and deploys nothing. If you raise
the functions runtime, raise the pinned CLI version with it.

Required repository secrets (Settings → Secrets and variables → Actions):

```
FIREBASE_API_KEY              FIREBASE_MESSAGING_SENDER_ID
FIREBASE_AUTH_DOMAIN          FIREBASE_APP_ID
FIREBASE_PROJECT_ID           ALLOWED_DOMAIN
FIREBASE_STORAGE_BUCKET       APP_URL
FIREBASE_SERVICE_ACCOUNT      # JSON service account key
```

Cloud Functions secrets (`PASSWORD_ENCRYPTION_KEY`, `SMTP_USER`, `SMTP_PASS`)
live in Secret Manager and are set with `firebase functions:secrets:set`, not
as GitHub secrets.

Non-secret function parameters live in `functions/.env`, which is committed via
an explicit `.gitignore` negation. That is deliberate: CI deploys from a clean
checkout, so an uncommitted parameter file would mean CI silently deploying
different values than a local deploy — including leaving `RATE_LIMIT_PROXY_HOPS`
unset, which disables elevated rate limits without any error. Never put a
secret in that file.

To deploy by hand:

```bash
npm run build                            # needs VITE_FIREBASE_* in the environment
cd functions && npm run build && cd ..

firebase deploy --only hosting,functions,firestore:rules
```

Deploy the three targets together. Hosting alone can leave the site calling an
API that has not shipped; functions alone can leave them running against stale
security rules. Add `firestore:indexes` if `firestore.indexes.json` changed.

---

## Support

For issues or questions, contact the Central IT Team.
