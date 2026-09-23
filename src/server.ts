import express, { type Express } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { manifest } from './manifest.js';
import { handleSubtitlesRequest, type SubtitlesHandlerDeps } from './subtitlesHandler.js';
import type { CacheStore } from './cache/cacheStore.js';
import { normalizeVtt } from './ffmpeg/vttUtils.js';

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
      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const rawId = decodeURIComponent(idParam);
      const result = await handleSubtitlesRequest(rawId, handlerDeps);
      const host = req.get('host');
      const protocol = req.protocol;
      const origin = host ? `${protocol}://${host}` : '';
      const subtitles = result.subtitles.map((sub, i) => ({
        id: `${sub.lang}-${i + 1}`,
        lang: sub.lang,
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

  app.get('/vtt/:anilistId/:episode/:lang.vtt', async (req, res) => {
    const key = {
      anilistId: parseInt(req.params.anilistId, 10),
      episode: parseInt(req.params.episode, 10),
      lang: req.params.lang,
    };
    let entry = cache.get(key);

    const inFlight = cache.getInFlight(key);
    if (inFlight) {
      try {
        await Promise.race([
          inFlight,
          new Promise((resolve) => setTimeout(resolve, 35000)),
        ]);
      } catch {
        // extraction finished or failed; re-check cache below
      }
      entry = cache.get(key);
    }

    res.type('text/vtt');

    if (entry?.status === 'ready' && entry.filePath && existsSync(entry.filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const content = readFileSync(entry.filePath, 'utf-8');
      res.send(normalizeVtt(content));
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
