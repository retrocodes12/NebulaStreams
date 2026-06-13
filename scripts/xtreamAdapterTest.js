import assert from 'node:assert/strict';
import { XtreamCodesAdapter, hasXtreamCredentials } from '../src/adapters/XtreamCodesAdapter.js';

const credentials = {
  serverUrl: 'https://iptv.example.test',
  username: 'demo-user',
  password: 'demo-pass'
};

const makeResponse = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload)
});

const makeMockFetch = ({ failFirstAction = null, malformedAction = null, invalidAuth = false } = {}) => {
  const calls = [];
  const attemptsByAction = new Map();
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    const action = parsed.searchParams.get('action') || 'auth';
    calls.push({ action, url: String(url) });
    attemptsByAction.set(action, (attemptsByAction.get(action) || 0) + 1);

    if (failFirstAction === action && attemptsByAction.get(action) === 1) {
      return makeResponse({ error: 'temporary' }, { ok: false, status: 503 });
    }
    if (malformedAction === action) {
      return makeResponse('<html>bad</html>');
    }
    if (action === 'auth') {
      return makeResponse({
        user_info: {
          username: credentials.username,
          auth: invalidAuth ? 0 : 1,
          status: invalidAuth ? 'Disabled' : 'Active'
        },
        server_info: {
          url: 'iptv.example.test',
          server_protocol: 'https'
        }
      });
    }
    if (action === 'get_live_categories') {
      return makeResponse([{ category_id: '10', category_name: 'News' }]);
    }
    if (action === 'get_live_streams') {
      return makeResponse([
        { stream_id: 101, name: 'World News', category_id: '10', stream_icon: 'https://img.test/news.png', epg_channel_id: 'world.news' }
      ]);
    }
    if (action === 'get_vod_categories') {
      return makeResponse([{ category_id: '20', category_name: 'Movies' }]);
    }
    if (action === 'get_vod_streams') {
      return makeResponse([
        { stream_id: 202, name: 'Example Movie', category_id: '20', stream_icon: 'https://img.test/movie.jpg', container_extension: 'mkv', rating: '8.1' }
      ]);
    }
    if (action === 'get_series_categories') {
      return makeResponse([{ category_id: '30', category_name: 'Series' }]);
    }
    if (action === 'get_series') {
      return makeResponse([
        { series_id: 303, name: 'Example Series', category_id: '30', cover: 'https://img.test/series.jpg', rating: '7.8' }
      ]);
    }
    if (action === 'get_series_info') {
      return makeResponse({
        info: { name: 'Example Series', cover: 'https://img.test/series.jpg', plot: 'Series plot', genre: 'Drama, Action' },
        episodes: {
          1: [
            { id: 'ep-1', title: 'Pilot', episode_num: 1, container_extension: 'mp4', release_date: '2026-01-01' }
          ]
        }
      });
    }
    if (action === 'get_short_epg') {
      return makeResponse({
        epg_listings: [
          {
            title: Buffer.from('Current News').toString('base64'),
            description: Buffer.from('Live bulletin').toString('base64')
          }
        ]
      });
    }

    return makeResponse([]);
  };
  fetchImpl.calls = calls;
  fetchImpl.attemptsByAction = attemptsByAction;
  return fetchImpl;
};

const adapter = new XtreamCodesAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: makeMockFetch()
});

assert.equal(hasXtreamCredentials(credentials), true, 'credentials should be detected');
assert.equal(hasXtreamCredentials({ ...credentials, password: '' }), false, 'missing password should disable Xtream');

const auth = await adapter.authenticate(credentials);
assert.equal(auth.user_info.status, 'Active');

const definitions = await adapter.getCatalogDefinitions(credentials);
assert.deepEqual(definitions.map((entry) => entry.id), ['xtream-live-10', 'xtream-vod-20', 'xtream-series-30']);

const liveMetas = await adapter.getCatalog({ credentials, catalogId: 'xtream-live-10' });
assert.equal(liveMetas.length, 1);
assert.equal(liveMetas[0].id, 'xtream:live:101');
assert.equal(liveMetas[0].type, 'tv');

const vodMetas = await adapter.getCatalog({ credentials, catalogId: 'xtream-vod-20', search: 'movie' });
assert.equal(vodMetas.length, 1);
assert.equal(vodMetas[0].id, 'xtream:vod:202');
assert.equal(vodMetas[0].type, 'movie');

const seriesMetas = await adapter.getCatalog({ credentials, catalogId: 'xtream-series-30' });
assert.equal(seriesMetas.length, 1);
assert.equal(seriesMetas[0].id, 'xtream:series:303');
assert.equal(seriesMetas[0].type, 'series');

const seriesMeta = await adapter.getMeta(credentials, 'xtream:series:303');
assert.equal(seriesMeta.videos.length, 1);
assert.equal(seriesMeta.videos[0].id, 'xtream:episode:303:ep-1:mp4');

const liveMeta = await adapter.getMeta(credentials, 'xtream:live:101');
assert.equal(liveMeta.description, 'Live bulletin');

const streams = await adapter.getStreams({
  credentials,
  id: 'xtream:episode:303:ep-1:mp4',
  baseUrl: 'https://nebula.example.test',
  privateConfigId: 'private123'
});
assert.equal(streams.length, 2);
assert.equal(streams[0].url, 'https://nebula.example.test/private/private123/xtream/series/ep-1.mp4?mode=direct&pb=2');
assert.equal(streams[1].url, 'https://nebula.example.test/private/private123/xtream/series/ep-1.mp4?pb=2');
assert.equal(streams[1].behaviorHints.notWebReady, true);

const liveStreams = await adapter.getStreams({
  credentials,
  id: 'xtream:live:101',
  baseUrl: 'https://nebula.example.test',
  privateConfigId: 'private123'
});
assert.equal(liveStreams.length, 4);
assert.equal(liveStreams[0].url, 'https://nebula.example.test/private/private123/xtream/live/101.ts?mode=direct&pb=2');
assert.equal(liveStreams[1].url, 'https://nebula.example.test/private/private123/xtream/live/101.m3u8?mode=direct&pb=2');
assert.equal(liveStreams[2].behaviorHints.notWebReady, true);
assert.equal(liveStreams[2].url, 'https://nebula.example.test/private/private123/xtream/live/101.ts?pb=2');
assert.equal(liveStreams[3].url, 'https://nebula.example.test/private/private123/xtream/live/101.m3u8?pb=2');

const target = adapter.getUpstreamStreamUrl(credentials, 'live', 101, 'm3u8');
assert.equal(target, 'https://iptv.example.test/live/demo-user/demo-pass/101.m3u8');

const invalidAdapter = new XtreamCodesAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: makeMockFetch({ invalidAuth: true })
});
await assert.rejects(() => invalidAdapter.authenticate(credentials), /invalid|inactive/u);

const malformedAdapter = new XtreamCodesAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: makeMockFetch({ malformedAction: 'get_live_categories' })
});
await assert.rejects(() => malformedAdapter.getCategories(credentials, 'live'), /malformed JSON/u);

const retryFetch = makeMockFetch({ failFirstAction: 'get_vod_streams' });
const retryAdapter = new XtreamCodesAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: retryFetch
});
const retryVod = await retryAdapter.getItems(credentials, 'vod');
assert.equal(retryVod.length, 1);
assert.equal(retryFetch.attemptsByAction.get('get_vod_streams'), 2);

console.log('Xtream adapter tests passed');
