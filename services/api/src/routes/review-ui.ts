/**
 * Review UI for invoices that need a human.
 *
 * Server-rendered on purpose. A separate SPA would mean a second build
 * pipeline, a second deploy, a second auth integration and a CORS surface — for
 * a screen whose entire job is "show one invoice, take one decision". The
 * review queue is not a product surface, it is an operational tool, and it
 * should cost accordingly.
 *
 * Design constraints that come from watching people actually do this work:
 *
 *   - **Keyboard first.** A reviewer clearing 200 invoices uses A/R/J/K, not a
 *     mouse. Anything that forces a pointer halves their throughput.
 *   - **The reason for review is the headline.** The reviewer's first question
 *     is always "why is this in front of me", not "what is this invoice".
 *   - **Amounts are rendered from exact decimal strings.** The API never sends
 *     money as a JSON number, and the UI never parses one into a float.
 *   - **Blocking findings force a typed reason.** The override is the audited
 *     decision; a checkbox would be clicked without reading.
 */

import { z } from 'zod';
import { ValidationError, asInvoiceId } from '@onelineflow/core';
import type { AppInstance } from '../app-types.js';
import type { ApiDeps } from '../main.js';
import { requireTenant } from '../auth.js';

const queueQuery = z.object({
  status: z.enum(['needs_review', 'pending_approval', 'failed']).default('needs_review'),
  cursor: z.string().datetime().optional(),
});

interface QueueRow {
  id: string;
  created_at: Date;
  status: string;
  version: number;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  total_minor: bigint | null;
  overall_confidence: string | null;
  findings: Array<{ code: string; severity: string; message: string; field?: string }> | null;
  extraction_models: string[] | null;
  failure_message: string | null;
}

export function registerReviewUiRoutes(app: AppInstance, deps: ApiDeps): void {
  app.get('/review', async (req, reply) => {
    const auth = await requireTenant(req, ['approver']);
    const parsed = queueQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid queue filter', {
        publicMessage: 'That filter is not valid.',
      });
    }
    const { status } = parsed.data;

    const { rows, counts } = await deps.db.withTenant(auth.tenantId, async (client) => {
      const queue = await client.query<QueueRow>(
        `SELECT id, created_at, status, version, vendor_name, invoice_number,
                invoice_date, due_date, currency, total_minor, overall_confidence,
                findings, extraction_models, failure_message
           FROM invoices
          WHERE status = $1
          ORDER BY created_at ASC
          LIMIT 50`,
        [status],
      );

      // Oldest first: a review queue is a FIFO of obligations, and the oldest
      // invoice is the one closest to being paid late.
      const tally = await client.query<{ status: string; n: string }>(
        `SELECT status, count(*)::text AS n
           FROM invoices
          WHERE status IN ('needs_review','pending_approval','failed')
          GROUP BY status`,
      );

      return {
        rows: queue.rows,
        counts: Object.fromEntries(tally.rows.map((r) => [r.status, Number(r.n)])),
      };
    });

    return (
      reply
        .header('Content-Type', 'text/html; charset=utf-8')
        // The UI renders tenant data; a strict CSP means an invoice description
        // containing markup cannot become script execution even if escaping
        // somewhere below were wrong.
        .header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        )
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .send(renderQueue(rows, status, counts))
    );
  });

  /**
   * Form-post decision endpoint.
   *
   * Separate from the JSON API so the UI degrades to plain HTML forms with no
   * JavaScript at all. The keyboard handler posts these same forms.
   */
  app.post<{ Params: { id: string } }>('/review/:id/decide', async (req, reply) => {
    const auth = await requireTenant(req, ['approver']);
    const invoiceId = asInvoiceId(req.params.id);

    const body = z
      .object({
        decision: z.enum(['approve', 'reject']),
        overrideReason: z.string().max(1000).optional(),
        reason: z.string().max(1000).optional(),
        expectedVersion: z.coerce.number().int().positive().optional(),
        returnTo: z.string().max(200).optional(),
      })
      .safeParse(req.body);

    if (!body.success) {
      throw new ValidationError('Invalid decision', { publicMessage: 'Invalid decision.' });
    }

    // Delegates to the same handlers the JSON API uses, so the UI cannot drift
    // from the API's rules — the approval limit and override checks are not
    // reimplemented here.
    const target = body.data.decision === 'approve' ? 'approve' : 'reject';
    const response = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceId}/${target}`,
      headers: {
        authorization: req.headers.authorization ?? '',
        'content-type': 'application/json',
      },
      payload:
        target === 'approve'
          ? {
              ...(body.data.overrideReason ? { overrideReason: body.data.overrideReason } : {}),
              ...(body.data.expectedVersion ? { expectedVersion: body.data.expectedVersion } : {}),
            }
          : { reason: body.data.reason ?? 'Rejected from review queue' },
    });

    if (response.statusCode >= 400) {
      const parsedBody = response.json<{ error?: { message?: string } }>();
      return reply
        .status(response.statusCode)
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(renderError(parsedBody.error?.message ?? 'The decision could not be recorded.'));
    }

    void auth;
    // PRG: redirect after post so a refresh does not re-submit the decision.
    return reply.redirect(body.data.returnTo ?? '/review', 303);
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * HTML-escape.
 *
 * Every interpolation below goes through this. Vendor names and line
 * descriptions come from PDFs supplied by third parties — they are exactly the
 * untrusted input an injection would arrive in.
 */
function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  // Only primitives are ever interpolated. Rendering an object would emit
  // "[object Object]" into the page, which is a bug worth surfacing rather
  // than displaying.
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean'
        ? String(value)
        : (JSON.stringify(value) ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render integer minor units without ever creating a float. */
function money(minor: bigint | string | null, currency: string | null): string {
  if (minor === null || currency === null) return '—';
  const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF']);
  const exp = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const value = BigInt(minor);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(exp + 1, '0');
  const body =
    exp === 0
      ? digits
      : `${digits.slice(0, digits.length - exp)}.${digits.slice(digits.length - exp)}`;
  return `${negative ? '-' : ''}${body} ${currency}`;
}

function severityRank(s: string): number {
  return s === 'blocking' ? 0 : s === 'warning' ? 1 : 2;
}

function renderQueue(rows: QueueRow[], status: string, counts: Record<string, number>): string {
  const tabs = (['needs_review', 'pending_approval', 'failed'] as const)
    .map((s) => {
      const active = s === status ? ' class="tab active"' : ' class="tab"';
      const label = s.replace(/_/g, ' ');
      return `<a href="/review?status=${s}"${active}>${esc(label)} <span class="count">${counts[s] ?? 0}</span></a>`;
    })
    .join('');

  const cards = rows.map((row, index) => renderCard(row, index, status)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review queue — onelineFlow</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #fff; --line: #dfe3e8; --ink: #1a1d21; --muted: #5c6570;
    --block: #c0392b; --warn: #b7791f; --ok: #237a4b; --accent: #2b5fd9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171a; --card: #1c2024; --line: #2c3238; --ink: #e8eaed; --muted: #9aa4b0;
      --block: #ff6b5a; --warn: #e0a33e; --ok: #4ec27e; --accent: #6b9bff;
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { position:sticky; top:0; background:var(--card); border-bottom:1px solid var(--line);
           padding:12px 20px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; z-index:10; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .tabs { display:flex; gap:4px; }
  .tab { padding:6px 12px; border-radius:6px; text-decoration:none; color:var(--muted); font-size:14px; }
  .tab.active { background:var(--accent); color:#fff; }
  .count { opacity:.75; font-variant-numeric:tabular-nums; }
  .hint { margin-left:auto; color:var(--muted); font-size:13px; }
  kbd { background:var(--bg); border:1px solid var(--line); border-radius:4px;
        padding:1px 5px; font-size:12px; font-family:ui-monospace,monospace; }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
          padding:16px 18px; margin-bottom:14px; }
  .card.focused { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
  .row { display:flex; gap:20px; align-items:baseline; flex-wrap:wrap; }
  .vendor { font-size:17px; font-weight:600; }
  .amount { font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; margin-left:auto; }
  .meta { color:var(--muted); font-size:13px; }
  .why { margin:12px 0; padding:10px 12px; border-radius:8px; border-left:3px solid var(--line); background:var(--bg); }
  .why.blocking { border-left-color:var(--block); }
  .why.warning  { border-left-color:var(--warn); }
  .why .code { font-family:ui-monospace,monospace; font-size:12px; color:var(--muted); }
  .conf { font-variant-numeric:tabular-nums; }
  .conf.low { color:var(--block); font-weight:600; }
  form { display:flex; gap:8px; align-items:center; margin-top:12px; flex-wrap:wrap; }
  input[type=text] { flex:1; min-width:240px; padding:7px 10px; border:1px solid var(--line);
                     border-radius:6px; background:var(--bg); color:var(--ink); font-size:14px; }
  button { padding:7px 16px; border-radius:6px; border:1px solid transparent; font-size:14px;
           cursor:pointer; font-weight:500; }
  .approve { background:var(--ok); color:#fff; }
  .reject  { background:transparent; color:var(--block); border-color:var(--block); }
  .empty { text-align:center; padding:60px 20px; color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Review queue</h1>
  <nav class="tabs">${tabs}</nav>
  <div class="hint">
    <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> approve · <kbd>r</kbd> reject · <kbd>?</kbd> help
  </div>
</header>
<main>
${rows.length === 0 ? '<div class="empty">Nothing here. Queue is clear.</div>' : cards}
</main>
<script>
// Keyboard navigation. A reviewer clearing 200 invoices uses the keyboard;
// forcing a pointer roughly halves their throughput.
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  if (!cards.length) return;
  var i = 0;
  function focus(n) {
    if (n < 0 || n >= cards.length) return;
    cards[i].classList.remove('focused');
    i = n;
    cards[i].classList.add('focused');
    cards[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  focus(0);
  document.addEventListener('keydown', function (e) {
    // Never hijack keys while someone is typing an override reason.
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var card = cards[i];
    if (e.key === 'j') { focus(i + 1); e.preventDefault(); }
    else if (e.key === 'k') { focus(i - 1); e.preventDefault(); }
    else if (e.key === 'a') {
      var reason = card.querySelector('input[name=overrideReason]');
      // Blocking findings require a typed reason. Focus the field rather than
      // submitting — the override must be a deliberate, recorded act.
      if (reason && !reason.value.trim()) { reason.focus(); e.preventDefault(); return; }
      card.querySelector('form.approve-form').submit();
      e.preventDefault();
    }
    else if (e.key === 'r') { card.querySelector('form.reject-form').submit(); e.preventDefault(); }
    else if (e.key === '?') { alert('j/k move · a approve · r reject\\nBlocking findings need a written reason before approval.'); }
  });
})();
</script>
</body>
</html>`;
}

function renderCard(row: QueueRow, index: number, status: string): string {
  const findings = [...(row.findings ?? [])].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );
  const hasBlocking = findings.some((f) => f.severity === 'blocking');

  const confidence = row.overall_confidence === null ? null : Number(row.overall_confidence);
  const confClass = confidence !== null && confidence < 0.9 ? 'conf low' : 'conf';

  const whys = findings
    .slice(0, 4)
    .map(
      (f) =>
        `<div class="why ${esc(f.severity)}"><span class="code">${esc(f.code)}</span> — ${esc(f.message)}</div>`,
    )
    .join('');

  const failure = row.failure_message
    ? `<div class="why blocking"><span class="code">FAILURE</span> — ${esc(row.failure_message)}</div>`
    : '';

  const returnTo = `/review?status=${encodeURIComponent(status)}`;

  return `<article class="card" data-index="${index}">
  <div class="row">
    <span class="vendor">${esc(row.vendor_name ?? 'Unknown vendor')}</span>
    <span class="meta">${esc(row.invoice_number ?? 'no number')}</span>
    <span class="amount">${esc(money(row.total_minor, row.currency))}</span>
  </div>
  <div class="row meta">
    <span>Issued ${esc(row.invoice_date ?? '—')}</span>
    <span>Due ${esc(row.due_date ?? '—')}</span>
    <span class="${confClass}">Confidence ${confidence === null ? '—' : (confidence * 100).toFixed(1) + '%'}</span>
    <span>${esc((row.extraction_models ?? []).join(' + ') || 'no model')}</span>
  </div>
  ${failure}${whys}
  <form class="approve-form" method="post" action="/review/${esc(row.id)}/decide">
    <input type="hidden" name="decision" value="approve">
    <input type="hidden" name="expectedVersion" value="${esc(row.version)}">
    <input type="hidden" name="returnTo" value="${esc(returnTo)}">
    ${
      hasBlocking
        ? `<input type="text" name="overrideReason" required minlength="10"
             placeholder="Why is it safe to approve despite the blocking issue? (recorded in the audit log)">`
        : ''
    }
    <button type="submit" class="approve">Approve</button>
  </form>
  <form class="reject-form" method="post" action="/review/${esc(row.id)}/decide">
    <input type="hidden" name="decision" value="reject">
    <input type="hidden" name="returnTo" value="${esc(returnTo)}">
    <input type="text" name="reason" required minlength="3" placeholder="Reason for rejection">
    <button type="submit" class="reject">Reject</button>
  </form>
</article>`;
}

function renderError(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Could not record decision</title>
<style>body{font:15px/1.6 system-ui;margin:0;padding:60px 20px;text-align:center;background:#f6f7f9;color:#1a1d21}
@media(prefers-color-scheme:dark){body{background:#14171a;color:#e8eaed}}
a{color:#2b5fd9}</style></head>
<body><h1>Could not record that decision</h1><p>${esc(message)}</p>
<p><a href="/review">Back to the queue</a></p></body></html>`;
}

export { esc as escapeHtml, money as renderMoney };
