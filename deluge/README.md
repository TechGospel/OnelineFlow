# Zoho Creator / Deluge adapter

## Role

Deluge is the **tenant-facing adapter**, not the transaction engine.

It owns the intake form, tenant-specific business rules, and the human approval
step. It does not own idempotency and — in the platform deployment — it does not
call QuickBooks.

Why: Creator's API quotas and Deluge's per-invocation execution limits are orders
of magnitude below the platform's throughput target. Keeping the QuickBooks write
in the Node core also means one implementation of the duplicate guards instead of
one per tenant app.

## Files

| File                             | Use                                                    |
| -------------------------------- | ------------------------------------------------------ |
| `functions/OnelineFlow_Ingest.dg` | Creator → platform. Multi-tenant deployment.           |
| `functions/QBO_DirectPost.dg`    | Creator → QuickBooks directly. **Single-tenant only.** |

Pick one. Running both against the same records will post twice.

## Setup — platform mode

1. **Setup → Connections → Custom Service**, named `onelineflow`, with the
   platform's OAuth2 or API-key settings.
2. Create a **Settings** form with: `API_Base_URL`, `Tenant_Slug`, `Ops_Email`.
3. On the **Invoice_Intake** form add: `OnelineFlow_Invoice_Id`, `Status`,
   `Retry_Count`, `Error_Message`, `Submitted_At`, `Document`.
4. Workflow: _On Successful Form Submission_ → `OnelineFlow.ingest(input.ID)`.
5. Schedule `OnelineFlow.retrySweep()` every 15 minutes.

## Setup — single-tenant direct mode

1. **Setup → Connections → Custom Service (OAuth 2.0)**, named `qbo`:

   | Field       | Value                                                       |
   | ----------- | ----------------------------------------------------------- |
   | Auth URL    | `https://appcenter.intuit.com/connect/oauth2`               |
   | Token URL   | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` |
   | Refresh URL | same as Token URL                                           |
   | Scope       | `com.intuit.quickbooks.accounting`                          |

   Zoho stores and auto-refreshes the tokens. **Never hand-roll this.** Intuit
   rotates the refresh token on every use; losing one value permanently breaks
   the connection and needs a manual reconnect.

2. **Settings** form: `QBO_Base_URL`, `Realm_ID`, `Minor_Version`,
   `Tenant_Slug`, `Ops_Email`.

   Base URL is `https://sandbox-quickbooks.api.intuit.com` or
   `https://quickbooks.api.intuit.com`. Keep it in the form, never hardcoded.

3. **Invoice_Intake** additions: `QBO_Bill_Id`, `QBO_SyncToken`,
   `Post_Attempt_Epoch`, `Posted_On`, `Error_Message`, plus a `Line_Items`
   subform with `Description`, `Amount`, `GL_Code`, `Tax_Code`.

4. Create **QBO_Reference_Cache** (`Entity_Type`, `Lookup_Key`, `QBO_Id`,
   `Display_Name`, `Refreshed_At`) and **QBO_Log**.

5. Workflow: on `Status` changing to `Approved` → `QBO.postBill(input.ID)`.

## Things that bite

- **QBO returns faults inside HTTP 200 bodies.** Always check for `Fault` in the
  response before trusting it. Code that only checks the status stores a
  nonexistent entity id.
- **`SyncToken` is mandatory for any update** and must be current. A stale one
  returns error 5010; re-read the entity first.
- **`DocNumber` is capped at 21 characters.** Truncate from the _tail_ — suffixes
  carry the sequence number that distinguishes one invoice from the next.
- **QBO's query language has no bind parameters.** `QBO.escapeLiteral` is the
  only defence; a vendor named "O'Brien & Sons" breaks an unescaped query.
- **Cache reference lookups.** Without it every invoice costs 2–4 extra QBO
  reads, which is the difference between fitting inside the rate limit and not.
- **Batch scheduled functions.** Deluge has hard statement and execution
  ceilings; a run that dies halfway leaves ambiguous state. 20–25 records per
  invocation always finishes.
- **A dormant sandbox connection dies.** Intuit expires refresh tokens after
  ~100 days of inactivity even though the Connection auto-refreshes on use. Add
  a daily health ping.

## Verify before trusting

Intuit's rate limits, the `requestid` retention window, and the current
`minorversion` all shift between releases. Check them against Intuit's live
documentation before relying on them in production — the values in this code are
correct as written but are not guaranteed to stay so.
