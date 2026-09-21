import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { pingRedis } from '../redis/client.js';
import { pingTemporal } from '../temporal/client.js';

/**
 * Live dependency probes for GET /health.
 *
 * Every check here does real I/O — a supplier HTTP request, a Redis PING, a
 * Temporal GetSystemInfo call. Nothing is inferred from config or cached, since
 * a health endpoint that cannot go red is not a health endpoint.
 */

export type DependencyState = 'up' | 'down';
export type OverallStatus = 'ok' | 'degraded' | 'down';

export interface DependencyReport {
  status: DependencyState;
  latencyMs: number;
  error?: string;
}

export interface HealthReport {
  status: OverallStatus;
  suppliers: { A: DependencyReport; B: DependencyReport };
  redis: DependencyReport;
  temporal: DependencyReport;
  checkedAt: string;
  uptimeSeconds: number;
}

export async function checkHealth(): Promise<HealthReport> {
  // All four probes run concurrently: /health should cost one timeout at
  // worst, not four in series.
  const [supplierA, supplierB, redis, temporal] = await Promise.all([
    timed(() => probeSupplier(config.suppliers.a.url)),
    timed(() => probeSupplier(config.suppliers.b.url)),
    timed(pingRedisProbe),
    timed(() => pingTemporal(config.suppliers.healthTimeoutMs)),
  ]);

  const report: HealthReport = {
    status: overallStatus({ supplierA, supplierB, redis, temporal }),
    suppliers: { A: supplierA, B: supplierB },
    redis,
    temporal,
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  };

  if (report.status !== 'ok') {
    logger.warn({ health: report }, 'health check is not fully green');
  }
  return report;
}

/**
 * Redis and Temporal are critical: without either, no request can be served at
 * all. Suppliers are not individually critical — losing one is exactly the
 * degradation the workflow is built to absorb — but losing both leaves nothing
 * to aggregate.
 */
function overallStatus(checks: {
  supplierA: DependencyReport;
  supplierB: DependencyReport;
  redis: DependencyReport;
  temporal: DependencyReport;
}): OverallStatus {
  const { supplierA, supplierB, redis, temporal } = checks;

  if (redis.status === 'down' || temporal.status === 'down') return 'down';
  if (supplierA.status === 'down' && supplierB.status === 'down') return 'down';
  if (supplierA.status === 'down' || supplierB.status === 'down') return 'degraded';
  return 'ok';
}

/** 'down' maps to 503, everything else to 200 — degraded still serves traffic. */
export function httpStatusFor(status: OverallStatus): number {
  return status === 'down' ? 503 : 200;
}

async function probeSupplier(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  url.searchParams.set('city', config.defaults.city);

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(config.suppliers.healthTimeoutMs),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Drain the body so the socket can be reused rather than left dangling.
  await response.arrayBuffer();
}

async function pingRedisProbe(): Promise<void> {
  if (!(await pingRedis())) throw new Error('PING did not return PONG');
}

/** Run a probe, recording how long it took and why it failed. */
async function timed(probe: () => Promise<unknown>): Promise<DependencyReport> {
  const startedAt = Date.now();
  try {
    await probe();
    return { status: 'up', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
