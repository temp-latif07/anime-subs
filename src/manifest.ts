export const manifest = {
  id: 'org.animesubs',
  version: '1.0.0',
  name: 'AnimeSubs',
  description: 'Tiered anime subtitle resolver: Jimaku and AnimeTosho first, embedded-track extraction from your own stream addon as a fallback when nothing else has anything.',
  resources: ['subtitles'],
  types: ['series'],
  idPrefixes: ['kitsu', 'mal', 'anidb', 'anilist'],
  catalogs: [],
  behaviorHints: { configurable: false },
};
