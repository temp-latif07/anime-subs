import express, { type Express } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { manifest } from './manifest.js';
import { handleSubtitlesRequest, type SubtitlesHandlerDeps } from './subtitlesHandler.js';
import type { CacheStore } from './cache/cacheStore.js';
import type { CacheProvider } from './types.js';
import { normalizeVtt } from './ffmpeg/vttUtils.js';

const PROVIDER_LABELS: Record<CacheProvider, string> = {
  jimaku: 'Jimaku',
  animetosho: 'AnimeTosho',
  opensubtitles: 'OpenSubtitles',
  extraction: 'Extracted',
};

export function createServer(handlerDeps: SubtitlesHandlerDeps, cache: CacheStore): Express {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
    const start = Date.now();
    res.on('finish', () => {
      console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  app.options('{*path}', (_req, res) => {
    res.sendStatus(204);
  });

  app.get('/manifest.json', (_req, res) => {
    res.json(manifest);
  });

  app.set('trust proxy', true);

  app.get(['/subtitles/:type/:id.json', '/subtitles/:type/:id/:extra.json'], async (req, res) => {
    try {
      const typeParam = Array.isArray(req.params.type) ? req.params.type[0] : req.params.type;
      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const rawId = decodeURIComponent(idParam);
      const result = await handleSubtitlesRequest(rawId, handlerDeps, typeParam);
      const host = req.get('host');
      const protocol = req.protocol;
      const origin = host ? `${protocol}://${host}` : '';

      const countByLang = new Map<string, number>();
      for (const sub of result.subtitles) countByLang.set(sub.lang, (countByLang.get(sub.lang) ?? 0) + 1);

      const subtitles = result.subtitles.map((sub) => ({
        id: `${sub.lang}-${sub.provider}`,
        lang: (countByLang.get(sub.lang) ?? 0) > 1 ? `${sub.lang} (${PROVIDER_LABELS[sub.provider]})` : sub.lang,
        url: sub.url.startsWith('http://') || sub.url.startsWith('https://')
          ? sub.url
          : `${origin}${sub.url.startsWith('/') ? '' : '/'}${sub.url}`,
      }));
      res.json({ subtitles });
    } catch (err) {
      console.warn(`[HTTP] Error handling subtitles request: ${(err as Error).message}`);
      res.status(200).json({ subtitles: [] });
    }
  });

  app.get('/vtt/:anilistId/:episode/:lang/:provider.vtt', async (req, res) => {
    const key = {
      anilistId: parseInt(req.params.anilistId, 10),
      episode: parseInt(req.params.episode, 10),
      lang: req.params.lang,
      provider: req.params.provider as CacheProvider,
    };
    let entry = cache.get(key);

    const inFlight = cache.getInFlight(key);
    if (inFlight) {
      let clientGone = false;
      const onClose = () => { clientGone = true; };
      req.on('close', onClose);
      try {
        await Promise.race([
          inFlight,
          new Promise((resolve) => setTimeout(resolve, handlerDeps.config.vttWaitMs)),
          new Promise((resolve) => req.once('close', resolve)),
        ]);
      } catch {
        // extraction finished or failed; re-check cache below
      } finally {
        req.off('close', onClose);
      }
      if (clientGone) return; // response would be discarded anyway; skip the write
      entry = cache.get(key);
    }

    res.type('text/vtt');

    if (entry?.status === 'ready' && entry.filePath && existsSync(entry.filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const content = readFileSync(entry.filePath, 'utf-8');
      res.send(normalizeVtt(content, key.lang));
      return;
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (entry?.status === 'pending') {
      res.send('WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nExtracting subtitles -- reselect this track in about a minute.\n');
      return;
    }
    res.status(404).send('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nNo subtitle available.\n');
  });

  return app;
}
