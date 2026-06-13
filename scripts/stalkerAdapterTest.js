import assert from 'node:assert/strict';
import { StalkerPortalAdapter, hasStalkerCredentials } from '../src/adapters/StalkerPortalAdapter.js';

const credentials = {
  portalUrl: 'http://portal.example.test/c/',
  macAddress: '00:1A:79:AA:BB:CC',
  stbType: 'MAG270',
  serialNumber: 'SERIAL123',
  deviceId: 'DEVICE123',
  deviceId2: 'DEVICE456'
};

const makeResponse = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload)
});

const makeMockFetch = ({ failFirstAction = null, malformedAction = null, missingToken = false } = {}) => {
  const calls = [];
  const attemptsByAction = new Map();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const type = parsed.searchParams.get('type');
    const action = parsed.searchParams.get('action');
    calls.push({ type, action, url: String(url), headers: options.headers || {} });
    attemptsByAction.set(action, (attemptsByAction.get(action) || 0) + 1);

    if (failFirstAction === action && attemptsByAction.get(action) === 1) {
      return makeResponse({ js: { error: 'temporary' } }, { ok: false, status: 503 });
    }
    if (malformedAction === action) {
      return makeResponse('<html>bad</html>');
    }
    if (type === 'stb' && action === 'handshake') {
      return makeResponse({ js: missingToken ? {} : { token: 'token-1', random: 'abc' } });
    }
    if (type === 'stb' && action === 'get_profile') {
      assert.equal(parsed.searchParams.get('stb_type'), 'MAG270');
      assert.equal(parsed.searchParams.get('sn'), 'SERIAL123');
      assert.equal(parsed.searchParams.get('device_id'), 'DEVICE123');
      assert.equal(parsed.searchParams.get('device_id2'), 'DEVICE456');
      assert.equal((options.headers?.['X-User-Agent'] || '').includes('MAG270'), true);
      return makeResponse({ js: { id: 'profile-1', stb_type: 'MAG254' } });
    }
    if (type === 'account_info' && action === 'get_main_info') {
      return makeResponse({ js: { end_date: '2099-01-01', tariff_plan: 'Test' } });
    }
    if (type === 'itv' && action === 'get_genres') {
      return makeResponse({ js: [{ id: '7', title: 'News' }] });
    }
    if (type === 'itv' && action === 'get_all_channels') {
      return makeResponse({
        js: {
          data: [
            { id: '101', name: 'World News', number: '1', tv_genre_id: '7', cmd: 'ffmpeg http://portal.test/play/live.php?mac=00:1A:79:AA:BB:CC&stream=101&extension=ts&play_token=bad', logo: 'http://img.test/logo.png' },
            { id: '102', name: 'Movie Channel', number: '2', tv_genre_id: '8', cmd: 'ffmpeg http://origin.test/live/102.m3u8' }
          ]
        }
      });
    }
    if (type === 'itv' && action === 'get_ordered_list') {
      return makeResponse({
        js: {
          max_page_items: 14,
          total_items: 1,
          data: [
            { id: '101', name: 'World News', number: '1', tv_genre_id: '7', cmd: 'ffmpeg http://portal.test/play/live.php?mac=00:1A:79:AA:BB:CC&stream=101&extension=ts&play_token=bad', logo: 'http://img.test/logo.png' }
          ]
        }
      });
    }
    if (type === 'itv' && action === 'get_short_epg') {
      return makeResponse({
        js: {
          data: [
            {
              name: Buffer.from('News Hour').toString('base64'),
              descr: Buffer.from('Daily bulletin').toString('base64')
            }
          ]
        }
      });
    }
    if (type === 'itv' && action === 'create_link') {
      assert.equal(options.headers.Authorization, 'Bearer token-1');
      assert.equal(options.headers.Cookie.includes('mac=00%3A1A%3A79%3AAA%3ABB%3ACC'), true);
      assert.equal(parsed.searchParams.get('cmd'), 'http://localhost/ch/101_');
      return makeResponse({ js: { cmd: 'ffmpeg http://origin.test/live/101.m3u8' } });
    }
    return makeResponse({ js: [] });
  };
  fetchImpl.calls = calls;
  fetchImpl.attemptsByAction = attemptsByAction;
  return fetchImpl;
};

const adapter = new StalkerPortalAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: makeMockFetch()
});

assert.equal(hasStalkerCredentials(credentials), true);
assert.equal(hasStalkerCredentials({ ...credentials, macAddress: 'bad' }), false);

const auth = await adapter.authenticate(credentials);
assert.equal(auth.token, 'token-1');
assert.equal(auth.profile.stb_type, 'MAG254');

const categories = await adapter.getCategories(credentials);
assert.equal(categories.length, 1);
assert.deepEqual(adapter.getCatalogDefinitions(categories).map((entry) => entry.id), ['stalker-live-7']);

const catalog = await adapter.getCatalog({ credentials, catalogId: 'stalker-live-7' });
assert.equal(catalog.length, 1);
assert.equal(catalog[0].id, 'stalker:live:101');
assert.equal(catalog[0].type, 'tv');

const meta = await adapter.getMeta(credentials, 'stalker:live:101');
assert.equal(meta.name, 'World News');
assert.equal(meta.description, 'News Hour\nDaily bulletin');

const streams = await adapter.getStreams({
  credentials,
  id: 'stalker:live:101',
  baseUrl: 'https://nebula.example.test',
  privateConfigId: 'private123'
});
assert.equal(streams.length, 3);
assert.equal(streams[0].title, 'Live TV\nStalker Fresh Link');
assert.equal(streams[0].url, 'https://nebula.example.test/private/private123/stalker/live/101.ts?mode=direct&pb=2');
assert.equal(streams[1].title, 'Live TV\nStalker HLS');
assert.equal(streams[1].url, 'https://nebula.example.test/private/private123/stalker/live/101.m3u8?mode=playlist&pb=2');
assert.equal(streams[2].title, 'Live TV\nStalker Proxy Fallback');
assert.equal(streams[2].url, 'https://nebula.example.test/private/private123/stalker/live/101.ts?pb=2');
assert.equal(streams[2].behaviorHints.notWebReady, true);

const link = await adapter.createLink(credentials, '101');
assert.equal(link, 'http://origin.test/live/101.m3u8');

const playbackFetch = makeMockFetch();
const playbackOnlyAdapter = new StalkerPortalAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: playbackFetch
});
const playbackOnlyLink = await playbackOnlyAdapter.createLink(credentials, '101');
assert.equal(playbackOnlyLink, 'http://origin.test/live/101.m3u8');
assert.equal(playbackFetch.attemptsByAction.get('get_all_channels') || 0, 0);
assert.equal(playbackFetch.attemptsByAction.get('create_link'), 1);

const crossOriginHeaderCandidates = await adapter.getPlaybackHeaderCandidates(credentials, null, 'http://cdn.example.test/live/101.ts');
assert.equal(crossOriginHeaderCandidates.length, 4);
assert.equal(Object.hasOwn(crossOriginHeaderCandidates[0], 'Range'), false);
assert.equal(Object.hasOwn(crossOriginHeaderCandidates[1], 'Range'), false);
assert.equal(crossOriginHeaderCandidates[2].Range, 'bytes=0-');

const malformedAdapter = new StalkerPortalAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: makeMockFetch({ malformedAction: 'get_genres' })
});
await assert.rejects(() => malformedAdapter.getCategories(credentials), /malformed JSON/u);

const missingTokenAdapter = new StalkerPortalAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: makeMockFetch({ missingToken: true })
});
await assert.rejects(() => missingTokenAdapter.authenticate(credentials), /missing token/u);

const retryFetch = makeMockFetch({ failFirstAction: 'get_ordered_list' });
const retryAdapter = new StalkerPortalAdapter({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  fetchImpl: retryFetch
});
const retryChannels = await retryAdapter.getChannels(credentials, '7');
assert.equal(retryChannels.length, 1);
assert.equal(retryFetch.attemptsByAction.get('get_ordered_list'), 2);

console.log('Stalker adapter tests passed');
