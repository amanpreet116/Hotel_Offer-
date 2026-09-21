/**
 * Central, env-driven configuration. Every value has a sane local default so
 * `npm run dev` works with no .env file at all. Read this module instead of
 * touching `process.env` anywhere else.
 */

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Env var ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

export const config = {
  env: str('NODE_ENV', 'development'),
  isProduction: str('NODE_ENV', 'development') === 'production',

  api: {
    port: int('PORT', 3000),
  },

  logger: {
    level: str('LOG_LEVEL', 'debug'),
  },

  suppliers: {
    a: {
      name: 'supplierA' as const,
      url: str('SUPPLIER_A_URL', 'http://localhost:3000/supplierA/hotels'),
    },
    b: {
      name: 'supplierB' as const,
      url: str('SUPPLIER_B_URL', 'http://localhost:3000/supplierB/hotels'),
    },
    timeoutMs: int('SUPPLIER_TIMEOUT_MS', 5000),
    // Health probes get a much shorter budget than real fetches: /health must
    // answer quickly even when a supplier is hanging.
    healthTimeoutMs: int('SUPPLIER_HEALTH_TIMEOUT_MS', 2000),
  },

  redis: {
    url: str('REDIS_URL', 'redis://localhost:6379'),
    keyPrefix: str('REDIS_KEY_PREFIX', 'hotels'),
    // How long a city's snapshot stays cached before the next request has to
    // re-run the workflow. Short enough that supplier price moves show up.
    ttlSeconds: int('REDIS_TTL_SECONDS', 300),
    // Upper bound on a single command, so a request cannot hang waiting on a
    // Redis that has gone away mid-flight.
    commandTimeoutMs: int('REDIS_COMMAND_TIMEOUT_MS', 2000),
  },

  temporal: {
    address: str('TEMPORAL_ADDRESS', 'localhost:7233'),
    namespace: str('TEMPORAL_NAMESPACE', 'default'),
    taskQueue: str('TEMPORAL_TASK_QUEUE', 'hotel-offers'),
    // Startup safety net. Compose healthchecks already gate dependents on
    // Temporal being ready; this covers the gap between "port accepts
    // connections" and "namespace is registered", and any later restart.
    connect: {
      maxAttempts: int('TEMPORAL_CONNECT_MAX_ATTEMPTS', 30),
      initialDelayMs: int('TEMPORAL_CONNECT_INITIAL_DELAY_MS', 500),
      maxDelayMs: int('TEMPORAL_CONNECT_MAX_DELAY_MS', 5000),
    },
    // The SDK retries UNAVAILABLE indefinitely, so a request issued while
    // Temporal is down would hang forever. Bound the start call only — the
    // result poll is legitimately long-running.
    startTimeoutMs: int('TEMPORAL_START_TIMEOUT_MS', 10000),
    // Server-side ceiling on a single run, so an abandoned workflow cannot
    // linger indefinitely.
    workflowExecutionTimeout: str('TEMPORAL_WORKFLOW_EXECUTION_TIMEOUT', '2 minutes'),
  },

  defaults: {
    city: 'delhi',
  },

  shutdown: {
    // How long in-flight work gets to finish before the process is forced down.
    graceMs: int('SHUTDOWN_GRACE_MS', 10000),
  },
} as const;

export type Config = typeof config;
