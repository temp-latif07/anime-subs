export interface Config {
  port: number;
  dataDir: string;
  streamAddonUrl: string;
  jimakuApiKey: string;
  subtitleLanguages: string[];
  negativeCacheTtlHours: number;
  extractionConcurrency: number;
  extractionTimeoutMs: number;
  providerTimeoutMs: number;
  logLevel: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name);
  try {
    new URL(value);
  } catch {
    throw new Error(`Environment variable ${name} is not a valid URL: ${value}`);
  }
  return value;
}

function requireInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} is not a valid integer: ${raw}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const subtitleLanguages = (env.SUBTITLE_LANGUAGES ?? 'eng').split(',').map((s) => s.trim()).filter(Boolean);
  if (subtitleLanguages.length === 0) {
    throw new Error('SUBTITLE_LANGUAGES resolved to an empty list -- set at least one language or unset the variable to use the default (eng)');
  }

  return {
    port: requireInt(env, 'PORT', 7000),
    dataDir: env.DATA_DIR ?? '/data',
    streamAddonUrl: requireUrl(env, 'STREAM_ADDON_URL'),
    jimakuApiKey: requireEnv(env, 'JIMAKU_API_KEY'),
    subtitleLanguages,
    negativeCacheTtlHours: requireInt(env, 'NEGATIVE_CACHE_TTL_HOURS', 24),
    extractionConcurrency: requireInt(env, 'EXTRACTION_CONCURRENCY', 1),
    extractionTimeoutMs: requireInt(env, 'EXTRACTION_TIMEOUT_MS', 900000),
    providerTimeoutMs: requireInt(env, 'PROVIDER_TIMEOUT_MS', 8000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
