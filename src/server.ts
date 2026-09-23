import express, { type Express } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { manifest } from './manifest.js';
import { handleSubtitlesRequest, type SubtitlesHandlerDeps } from './subtitlesHandler.js';
import type { CacheStore } from './cache/cacheStore.js';

export function createServer(handlerDeps: SubtitlesHandlerDeps, cache: CacheStore): Express {
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });

  app.get('/manifest.json', (_req, res) => {
    res.json(manifest);
  });

  app.set('trust proxy', true);

  app.get('/subtitles/series/:id.json', async (req, res) => {
    try {
      const result = await handleSubtitlesRequest(req.params.id, handlerDeps);
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
      res.status(500).json({ subtitles: [], error: (err as Error).message });
    }
  });

  app.get('/vtt/:anilistId/:episode/:lang.vtt', (req, res) => {
    const key = {
      anilistId: parseInt(req.params.anilistId, 10),
      episode: parseInt(req.params.episode, 10),
      lang: req.params.lang,
    };
    const entry = cache.get(key);
    res.type('text/vtt');

    if (entry?.status === 'ready' && entry.filePath && existsSync(entry.filePath)) {
      res.send(readFileSync(entry.filePath, 'utf-8'));
      return;
    }
    if (entry?.status === 'pending') {
      res.send('WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nExtracting subtitles -- reselect this track in about a minute.\n');
      return;
    }
    res.status(404).send('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nNo subtitle available.\n');
  });

  return app;
}
