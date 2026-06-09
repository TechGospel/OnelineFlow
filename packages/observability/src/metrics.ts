/**
 * Prometheus metrics.
 *
 * Cardinality discipline is the whole game here. `tenant_id` as a label with
 * 1,000 tenants x 10 statuses x 5 other labels is 50,000 series per metric —
 * enough to melt a Prometheus instance. So tenant_id appears ONLY on the few
 * metrics where per-tenant alerting genuinely matters, and everything else is
 * aggregate. Per-tenant detail lives in Postgres, which is built for it.
 */

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** Latency buckets tuned to observed QBO behaviour: p50 ~300ms, tail to 30s. */
const API_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30];

export const invoicesIngested = new Counter({
  name: 'onelineflow_invoices_ingested_total',
  help: 'Invoices accepted at ingestion',
  labelNames: ['source', 'deduplicated'] as const,
  registers: [registry],
});

export const invoiceTransitions = new Counter({
  name: 'onelineflow_invoice_transitions_total',
  help: 'Invoice state machine transitions',
  labelNames: ['from', 'to'] as const,
  registers: [registry],
});

export const extractionDuration = new Histogram({
  name: 'onelineflow_extraction_duration_seconds',
  help: 'End-to-end AI extraction latency',
  labelNames: ['model', 'outcome'] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 45, 90],
  registers: [registry],
});

export const extractionConfidence = new Histogram({
  name: 'onelineflow_extraction_confidence',
  help: 'Overall extraction confidence',
  labelNames: ['consensus'] as const,
  buckets: [0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 1],
  registers: [registry],
});

export const aiCostMicros = new Counter({
  name: 'onelineflow_ai_cost_micros_total',
  help: 'AI spend in millionths of a currency unit',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

export const qboRequests = new Counter({
  name: 'onelineflow_qbo_requests_total',
  help: 'Outbound QuickBooks API requests',
  labelNames: ['method', 'entity', 'outcome', 'fault_code'] as const,
  registers: [registry],
});

export const qboDuration = new Histogram({
  name: 'onelineflow_qbo_request_duration_seconds',
  help: 'QuickBooks API latency',
  labelNames: ['method', 'entity'] as const,
  buckets: API_BUCKETS,
  registers: [registry],
});

export const qboRateLimitWaits = new Histogram({
  name: 'onelineflow_qbo_rate_limit_wait_seconds',
  help: 'Time spent waiting on the per-realm rate limiter',
  buckets: [0.001, 0.01, 0.1, 0.5, 1, 5, 15, 60],
  registers: [registry],
});

/**
 * The one metric that carries tenant_id, because "tenant X's pipeline is stuck"
 * is exactly the alert an operator needs, and the series count is bounded by the
 * number of tenants actually in a failed state at any moment.
 */
export const tenantPipelineStalled = new Gauge({
  name: 'onelineflow_tenant_pipeline_stalled',
  help: '1 when a tenant has invoices stuck beyond the SLO',
  labelNames: ['tenant_id', 'reason'] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'onelineflow_queue_depth',
  help: 'Jobs waiting per queue',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

export const outboxBacklog = new Gauge({
  name: 'onelineflow_outbox_backlog',
  help: 'Unpublished outbox rows',
  registers: [registry],
});

export const outboxOldestAgeSeconds = new Gauge({
  name: 'onelineflow_outbox_oldest_age_seconds',
  help: 'Age of the oldest unpublished outbox row — the true relay-health signal',
  registers: [registry],
});

export const dbPoolGauge = new Gauge({
  name: 'onelineflow_db_pool',
  help: 'Postgres pool state',
  labelNames: ['state'] as const,
  registers: [registry],
});

/** Deliberately a counter, not a gauge: any nonzero rate is a page. */
export const duplicatePostsPrevented = new Counter({
  name: 'onelineflow_duplicate_posts_prevented_total',
  help: 'Times a guard stopped a bill from being posted twice',
  labelNames: ['guard'] as const,
  registers: [registry],
});

export async function metricsText(): Promise<string> {
  return registry.metrics();
}
