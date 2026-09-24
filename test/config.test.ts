import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  STREAM_ADDON_URL: 'https://aiostreams.example.com/abc123/manifest.json',
  JIMAKU_API_KEY: 'test-key',
};

describe('loadConfig', () => {
  it('applies defaults when optional vars are absent', () => {
    const config = loadConfig(baseEnv as NodeJS.ProcessEnv);
    expect(config.port).toBe(7000);
    expect(config.dataDir).toBe('/data');
    expect(config.subtitleLanguages).toEqual(['eng']);
    expect(config.negativeCacheTtlHours).toBe(24);
    expect(config.extractionConcurrency).toBe(1);
    expect(config.extractionTimeoutMs).toBe(900000);
    expect(config.providerTimeoutMs).toBe(8000);
    expect(config.probeTimeoutMs).toBe(15000);
  });

  it('defaults probeTimeoutMs to 15000ms and reads PROBE_TIMEOUT_MS', () => {
    expect(loadConfig(baseEnv as NodeJS.ProcessEnv).probeTimeoutMs).toBe(15000);
    expect(loadConfig({ ...baseEnv, PROBE_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv).probeTimeoutMs).toBe(5000);
  });

  it('parses comma-separated languages, trimming whitespace', () => {
    const config = loadConfig({ ...baseEnv, SUBTITLE_LANGUAGES: 'eng, spa , fre' } as NodeJS.ProcessEnv);
    expect(config.subtitleLanguages).toEqual(['eng', 'spa', 'fre']);
  });

  it('throws a descriptive error when STREAM_ADDON_URL is missing', () => {
    const { STREAM_ADDON_URL, ...rest } = baseEnv;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/STREAM_ADDON_URL/);
  });

  it('throws a descriptive error when JIMAKU_API_KEY is missing', () => {
    const { JIMAKU_API_KEY, ...rest } = baseEnv;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/JIMAKU_API_KEY/);
  });

  it('throws when STREAM_ADDON_URL is not a valid URL', () => {
    expect(() => loadConfig({ ...baseEnv, STREAM_ADDON_URL: 'not-a-url' } as NodeJS.ProcessEnv))
      .toThrow(/not a valid URL/);
  });

  it('throws when a numeric var is present but blank', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it('throws when a numeric var is present but not a number', () => {
    expect(() => loadConfig({ ...baseEnv, EXTRACTION_CONCURRENCY: 'abc' } as NodeJS.ProcessEnv)).toThrow(/EXTRACTION_CONCURRENCY/);
  });

  it('throws when SUBTITLE_LANGUAGES is present but blank', () => {
    expect(() => loadConfig({ ...baseEnv, SUBTITLE_LANGUAGES: '' } as NodeJS.ProcessEnv)).toThrow(/SUBTITLE_LANGUAGES/);
  });
});
