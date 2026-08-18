import { useRef, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../common/Card';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import styles from './Settings.module.css';

// Derived from the browser rather than hardcoded, so the examples are correct
// in whatever environment the portal is being viewed in.
const BASE = `${window.location.origin}/api`;

/**
 * Print one section on its own, so the generation reference and the
 * link-creation reference can go to different people without either handout
 * carrying the other's contents.
 *
 * Works by marking the wanted section and letting the print stylesheet hide
 * everything else, rather than opening a second window — a popup would lose the
 * stylesheet and get blocked as often as not. Attributes rather than CSS module
 * classes because the print rules live in global.css, where hashed class names
 * are not reachable.
 */
function printSection(el: HTMLElement | null): void {
  if (!el) return;

  el.setAttribute('data-print-target', '');
  document.body.setAttribute('data-printing', '');

  const cleanup = () => {
    el.removeAttribute('data-print-target');
    document.body.removeAttribute('data-printing');
    window.removeEventListener('afterprint', cleanup);
  };

  window.addEventListener('afterprint', cleanup);
  // Safari does not reliably fire afterprint; without this the page would stay
  // in its printing state and look broken on screen.
  window.setTimeout(cleanup, 60000);

  window.print();
}

/** A code sample with a copy button. Every example here is meant to be pasted
 *  into a terminal or handed to an integrator, so all of them get one. */
function CodeBlock({ children }: { children: string }) {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast('Failed to copy', 'error');
    }
  };

  return (
    <div className={styles.codeWrap}>
      <button
        type="button"
        className={styles.copyBtn}
        onClick={handleCopy}
        aria-label="Copy to clipboard"
        data-no-print
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <code className={styles.codeBlock}>{children}</code>
    </div>
  );
}

export function ApiDocsSettings() {
  const generateRef = useRef<HTMLDivElement>(null);
  const linksRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div ref={generateRef}>
        {/* Shown only on paper, so a printed handout identifies itself. */}
        <div data-print-only className={styles.printHeader}>
          <h1>Password Generation API</h1>
          <p>{BASE}</p>
        </div>

      <Card>
        <CardHeader>
          <CardTitle subtitle="Public endpoints — no authentication required">
            Generating passwords
          </CardTitle>
          <Button variant="ghost" onClick={() => printSection(generateRef.current)} data-no-print>
            Print this section
          </Button>
        </CardHeader>
        <CardContent>
          <div className={styles.apiDocs}>
            <p className={styles.helpText}>
              These endpoints return passwords in the same three styles the
              portal uses, drawn from the word lists configured under Settings →
              Word Lists. Safe to call from a browser or a server.
            </p>

            <div className={styles.apiSection}>
              <h5>Endpoints</h5>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th>Example output</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>GET /api/password/simple</code></td>
                    <td><code>TreeBridge47</code></td>
                  </tr>
                  <tr>
                    <td><code>GET /api/password/secure</code></td>
                    <td><code>Movie3Cartoon)Bottle</code></td>
                  </tr>
                  <tr>
                    <td><code>GET /api/password/word4</code></td>
                    <td><code>Tiger4829</code></td>
                  </tr>
                  <tr>
                    <td><code>GET /api/password?style=…</code></td>
                    <td>Any of the above</td>
                  </tr>
                  <tr>
                    <td><code>GET /api/wordlists</code></td>
                    <td>Names of the configured lists</td>
                  </tr>
                  <tr>
                    <td><code>GET /api/hasword?word=Tiger</code></td>
                    <td><code>true</code> / <code>false</code></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className={styles.apiSection}>
              <h5>Parameters</h5>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Values</th>
                    <th>Default</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>n</code></td>
                    <td>1–100</td>
                    <td>1</td>
                  </tr>
                  <tr>
                    <td><code>format</code></td>
                    <td><code>text</code>, <code>json</code></td>
                    <td><code>text</code></td>
                  </tr>
                  <tr>
                    <td><code>list</code></td>
                    <td>A word list name</td>
                    <td>All lists</td>
                  </tr>
                  <tr>
                    <td><code>style</code></td>
                    <td><code>simple</code>, <code>secure</code>, <code>word4</code></td>
                    <td><code>simple</code></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className={styles.apiSection}>
              <h5>Three passwords as plain text</h5>
              <CodeBlock>{`curl "${BASE}/password/simple?n=3"`}</CodeBlock>
              <CodeBlock>{`StrongOcean33
CloudBlaze69
CastleValley95`}</CodeBlock>
            </div>

            <div className={styles.apiSection}>
              <h5>As JSON</h5>
              <CodeBlock>{`curl "${BASE}/password/simple?n=2&format=json"`}</CodeBlock>
              <CodeBlock>{`{"passwords":["RiverStone16","ArrowRaven41"],"count":2,"type":"simple"}`}</CodeBlock>
            </div>

            <div className={styles.apiSection}>
              <h5>PowerShell</h5>
              <p className={styles.helpText}>
                In PowerShell, <code>curl</code> is an alias for{' '}
                <code>Invoke-WebRequest</code>, which prints a response object
                rather than the body. Use <code>Invoke-RestMethod</code>, or call
                real curl as <code>curl.exe</code>.
              </p>
              <CodeBlock>{`Invoke-RestMethod "${BASE}/password/simple?n=3"

# or, for the real curl binary
curl.exe "${BASE}/password/simple?n=3"`}</CodeBlock>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle subtitle="Applies to the generation endpoints">Rate limits</CardTitle>
        </CardHeader>
        <CardContent>
          <div className={styles.apiDocs}>
            <p className={styles.helpText}>
              1,000 requests per hour per IP address, in a fixed window that
              resets on the hour. Ask for a higher limit by having your IP added
              under Settings → IP Whitelist with a generation limit set.
            </p>

            <div className={styles.apiSection}>
              <h5>Response headers</h5>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Header</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>X-RateLimit-Limit</code></td>
                    <td>Requests allowed this window</td>
                  </tr>
                  <tr>
                    <td><code>X-RateLimit-Remaining</code></td>
                    <td>Requests left</td>
                  </tr>
                  <tr>
                    <td><code>X-RateLimit-Reset</code></td>
                    <td>Unix time the window resets</td>
                  </tr>
                  <tr>
                    <td><code>Retry-After</code></td>
                    <td>Seconds until reset. Sent on 429 only</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className={styles.apiSection}>
              <h5>Over the limit</h5>
              <CodeBlock>{`{"error":"Rate limit exceeded","limit":1000,"retryAfter":1439}`}</CodeBlock>
              <p className={styles.helpText}>
                Use <code>n</code> to fetch up to 100 passwords in one request
                rather than making 100 requests — one request for{' '}
                <code>n=100</code> costs one unit of quota.
              </p>
            </div>

            <div className={styles.apiSection}>
              <h5>Errors</h5>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>400</code></td><td>Invalid parameter</td></tr>
                  <tr><td><code>401</code></td><td>Missing or invalid API key</td></tr>
                  <tr><td><code>403</code></td><td>Source IP not allowlisted</td></tr>
                  <tr><td><code>404</code></td><td>Unknown endpoint, style, or word list</td></tr>
                  <tr><td><code>429</code></td><td>Rate limit exceeded</td></tr>
                </tbody>
              </table>
              <p className={styles.helpText}>
                All errors are JSON: <code>{'{"error":"..."}'}</code>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      </div>

      <div ref={linksRef}>
        <div data-print-only className={styles.printHeader}>
          <h1>Password Link API</h1>
          <p>{BASE}</p>
        </div>

      <Card>
        <CardHeader>
          <CardTitle subtitle="Requires an API key">Creating a password link</CardTitle>
          <Button variant="ghost" onClick={() => printSection(linksRef.current)} data-no-print>
            Print this section
          </Button>
        </CardHeader>
        <CardContent>
          <div className={styles.apiDocs}>
            <p className={styles.helpText}>
              Creates a one-time link for a password you supply. Create a key
              under Settings → API Keys. Access can also be restricted by source
              IP under Settings → IP Whitelist.
            </p>

            <div className={styles.apiSection}>
              <h5>Request</h5>
              <CodeBlock>{`curl -X POST "${BASE}" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: your-api-key-here" \\
  -d '{
    "recipientEmail": "user@example.com",
    "recipientName": "John Smith",
    "password": "SecurePassword123",
    "notes": "Optional internal notes",
    "sendEmail": false
  }'`}</CodeBlock>
              <p className={styles.helpText}>
                <code>recipientEmail</code> and <code>password</code> are
                required. Set <code>sendEmail</code> to <code>true</code> to send
                the notification email as well.
              </p>
            </div>

            <div className={styles.apiSection}>
              <h5>Response</h5>
              <CodeBlock>{`{
  "success": true,
  "id": "uuid-of-password-link",
  "link": "${window.location.origin}/p/uuid",
  "status": "pending"
}`}</CodeBlock>
            </div>
          </div>
        </CardContent>
      </Card>
      </div>
    </>
  );
}
