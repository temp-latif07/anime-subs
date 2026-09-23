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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseInt(env.PORT ?? '7000', 10),
    dataDir: env.DATA_DIR ?? '/data',
    streamAddonUrl: requireUrl(env, 'STREAM_ADDON_URL'),
    jimakuApiKey: requireEnv(env, 'JIMAKU_API_KEY'),
    subtitleLanguages: (env.SUBTITLE_LANGUAGES ?? 'eng').split(',').map((s) => s.trim()).filter(Boolean),
    negativeCacheTtlHours: parseInt(env.NEGATIVE_CACHE_TTL_HOURS ?? '24', 10),
    extractionConcurrency: parseInt(env.EXTRACTION_CONCURRENCY ?? '1', 10),
    extractionTimeoutMs: parseInt(env.EXTRACTION_TIMEOUT_MS ?? '900000', 10),
    providerTimeoutMs: parseInt(env.PROVIDER_TIMEOUT_MS ?? '8000', 10),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
