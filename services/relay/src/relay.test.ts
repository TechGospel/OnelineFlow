import { describe, expect, it, vi } from 'vitest';
import { asTenantId } from '@onelineflow/core';
import { AUDIT_ONLY, jobId, ROUTES } from './relay.js';
import { QUEUE_NAMES, type QueueRegistry } from '@onelineflow/queue';

const TENANT = asTenantId('11111111-1111-4111-8111-111111111111');
const INVOICE = 'aaaaaaaa-0000-4000-8000-000000000001';

function fakeQueues(): { queues: QueueRegistry; add: ReturnType<typeof vi.fn> } {
  const add = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
  return { queues: { add } as unknown as QueueRegistry, add };
}

describe('outbox routing', () => {
  it('routes invoice.received to the extraction queue', async () => {
    const { queues, add } = fakeQueues();
    await ROUTES['invoice.received']!(queues, TENANT, INVOICE, {
      documentId: 'doc-1',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(add).toHaveBeenCalledOnce();
    const [queue, jobId, payload] = add.mock.calls[0]!;
    expect(queue).toBe(QUEUE_NAMES.extraction);
    expect(jobId).toBe(`extract-${INVOICE}`);
    expect(payload).toMatchObject({ tenantId: TENANT, documentId: 'doc-1' });
  });

  it('routes invoice.approved to the posting queue', async () => {
    const { queues, add } = fakeQueues();
    await ROUTES['invoice.approved']!(queues, TENANT, INVOICE, {
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      realmId: '123456',
      expectedVersion: 4,
    });

    const [queue, jobId, payload] = add.mock.calls[0]!;
    expect(queue).toBe(QUEUE_NAMES.posting);
    expect(payload).toMatchObject({ realmId: '123456', expectedVersion: 4 });
    expect(jobId).toBe(`post-${INVOICE}-4`);
  });

  describe('job id determinism', () => {
    it('produces an identical id for a redelivered event', async () => {
      // At-least-once delivery is the design. This is what makes it safe:
      // BullMQ dedupes on job id, so the second delivery is a no-op.
      const a = fakeQueues();
      const b = fakeQueues();
      const payload = { documentId: 'doc-1', invoiceCreatedAt: '2026-06-01T00:00:00.000Z' };
      await ROUTES['invoice.received']!(a.queues, TENANT, INVOICE, payload);
      await ROUTES['invoice.received']!(b.queues, TENANT, INVOICE, payload);
      expect(a.add.mock.calls[0]![1]).toBe(b.add.mock.calls[0]![1]);
    });

    it('gives a re-approval a distinct posting job id', async () => {
      // Version is in the key so approving again after a rejection enqueues a
      // genuinely new job rather than silently colliding with the settled one.
      const { queues, add } = fakeQueues();
      await ROUTES['invoice.approved']!(queues, TENANT, INVOICE, { expectedVersion: 4 });
      await ROUTES['invoice.approved']!(queues, TENANT, INVOICE, { expectedVersion: 9 });
      expect(add.mock.calls[0]![1]).not.toBe(add.mock.calls[1]![1]);
    });
  });

  it('routes review and failure events to notifications', async () => {
    const { queues, add } = fakeQueues();
    await ROUTES['invoice.needs_review']!(queues, TENANT, INVOICE, { confidence: 0.4 });
    await ROUTES['invoice.posting_failed']!(queues, TENANT, INVOICE, { code: 'validation' });
    const targetQueues = add.mock.calls.map((c) => String(c[0]));
    expect(targetQueues).toEqual([QUEUE_NAMES.notification, QUEUE_NAMES.notification]);
  });

  describe('job ids satisfy BullMQ constraints', () => {
    it('never contains a colon', () => {
      // BullMQ throws at enqueue time on a custom id containing ':'. That
      // failure mode stalls the entire pipeline, and a mocked queue will not
      // reproduce it — hence an explicit guard.
      expect(jobId('extract', INVOICE)).not.toContain(':');
      expect(jobId('post', INVOICE, 7)).not.toContain(':');
    });

    it('throws rather than emitting an id containing a colon', () => {
      expect(() => jobId('extract', 'a:b')).toThrow(/must not contain/);
    });

    it('every route produces a colon-free id', async () => {
      for (const [eventType, route] of Object.entries(ROUTES)) {
        const { queues, add } = fakeQueues();
        await route(queues, TENANT, INVOICE, { expectedVersion: 1 });
        const id = String(add.mock.calls[0]![1]);
        expect(id, `${eventType} produced "${id}"`).not.toContain(':');
      }
    });
  });

  it('every audit-only event is deliberately unrouted', () => {
    // Guards against someone adding a route for an event that should not
    // produce work, and vice versa.
    for (const eventType of AUDIT_ONLY) {
      expect(ROUTES[eventType], `${eventType} should have no route`).toBeUndefined();
    }
  });

  it('routed and audit-only sets do not overlap', () => {
    const routed = new Set(Object.keys(ROUTES));
    const overlap = [...AUDIT_ONLY].filter((e) => routed.has(e));
    expect(overlap).toEqual([]);
  });
});
