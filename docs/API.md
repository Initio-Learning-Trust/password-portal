# Password Portal API

Base URL: `https://password.initiolearning.org/api`

Two groups of endpoints:

- **Password generation** — public, no authentication, rate limited.
- **Password links** — creates a one-time link for a password. Requires an API key.

---

## Generate passwords

No authentication required.

| Endpoint | Format | Example |
|---|---|---|
| `GET /api/password/simple` | Word + Word + 2 digits | `TreeBridge47` |
| `GET /api/password/secure` | Word + digit + Word + symbol + Word | `Movie3Cartoon)Bottle` |
| `GET /api/password/word4` | Word + 4 digits | `Tiger4829` |
| `GET /api/password?style=…` | Any of the above, style as a parameter | |

### Parameters

| Name | Values | Default | Notes |
|---|---|---|---|
| `n` | `1`–`100` | `1` | Number of passwords to return |
| `format` | `text`, `json` | `text` | |
| `list` | word list name | all lists | See `GET /api/wordlists` |
| `style` | `simple`, `secure`, `word4` | `simple` | `/api/password` only |

### Responses

`format=text` (default) returns `text/plain`, one password per line:

```
$ curl "https://password.initiolearning.org/api/password/simple?n=3"
StrongOcean33
CloudBlaze69
CastleValley95
```

### PowerShell

In PowerShell, `curl` is an alias for `Invoke-WebRequest`, which returns a
response object and prints all of its properties rather than just the body. The
passwords are in its `Content` property. To get the text directly:

```powershell
Invoke-RestMethod "https://password.initiolearning.org/api/password/simple?n=3"

# or call the real curl binary
curl.exe "https://password.initiolearning.org/api/password/simple?n=3"
```

`format=json` returns:

```
$ curl "https://password.initiolearning.org/api/password/simple?n=2&format=json"
{"passwords":["RiverStone16","ArrowRaven41"],"count":2,"type":"simple"}
```

Responses are sent with `Cache-Control: no-store`.

### Other endpoints

```
GET /api/wordlists              Names of the configured word lists
GET /api/hasword?word=Tiger     Whether a word appears in those lists -> "true" / "false"
GET /api                        Machine-readable index of these endpoints
```

Both accept `format=json`.

---

## Create a password link

```
POST /api
Content-Type: application/json
X-API-Key: <your key>
```

Request:

```json
{
  "recipientEmail": "user@example.com",
  "recipientName": "John Smith",
  "password": "SecurePass123",
  "notes": "Optional internal notes",
  "sendEmail": false
}
```

`recipientEmail` and `password` are required. Set `sendEmail: true` to send the
notification email as well.

Response `201`:

```json
{
  "success": true,
  "id": "8f3c…",
  "link": "https://password.initiolearning.org/p/8f3c…",
  "status": "pending"
}
```

This endpoint may also be restricted to specific source IPs. Ask an
administrator if you need your server added.

---

## Rate limits

Generation endpoints allow **1,000 requests per hour per IP address**, counted
in a fixed window that resets on the hour.

Every response carries:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | Requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests left |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |
| `Retry-After` | Seconds until reset. Sent on `429` responses only |

Over the limit returns `429`:

```json
{"error":"Rate limit exceeded","limit":1000,"retryAfter":1439}
```

Use `n` to fetch up to 100 passwords in one request rather than making 100
requests — one request for `n=100` costs one unit of quota.

Counting is distributed and eventually consistent, so a burst may be allowed a
small number of requests beyond the limit. Treat the limit as approximate and
handle `429` whenever you see it.

**Higher limits.** Servers that generate at volume can be allowlisted for a
higher hourly limit. Contact an administrator with the public IP address or
CIDR range your requests originate from.

---

## Errors

| Status | Meaning |
|---|---|
| `400` | Invalid parameter (`n`, `format`, `style`, missing `word`) |
| `401` | Missing or invalid API key (authenticated endpoints) |
| `403` | Source IP not allowlisted (authenticated endpoints) |
| `404` | Unknown endpoint, style, or word list |
| `405` | Method not allowed |
| `429` | Rate limit exceeded |
| `500` | Server error |

Errors are JSON: `{"error":"..."}`.

---

## Notes

- Passwords are drawn from word lists curated by administrators, so output is
  predictable in shape and safe to hand to pupils.
- Randomness comes from a cryptographically secure generator.
- The service does not store generated passwords. Nothing is recorded against a
  generation request beyond rate-limit counters, which hold a hashed IP.
- `Access-Control-Allow-Origin: *` is set on generation endpoints, so they can
  be called directly from a browser.
