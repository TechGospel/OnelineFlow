/**
 * The concrete Fastify instance type for this service.
 *
 * Fastify's default `FastifyInstance` is parameterised with `FastifyBaseLogger`.
 * We hand it a real pino `Logger`, which is a NARROWER type (pino requires
 * `msgPrefix`, the base interface does not). Under `exactOptionalPropertyTypes`
 * those are not interchangeable, so route registrars typed against the default
 * will not accept our instance.
 *
 * Declaring the instance type once here — rather than widening the logger or
 * casting at each registration — keeps the routes fully typed.
 */

import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from '@onelineflow/observability';

export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  Logger
>;
