/**
 * A stand-in for the on-device daemon, good enough to develop against.
 *
 * The real client accepts JSON text frames as well as msgpack, so this speaks
 * plain JSON on the same envelope: { id, meta, data: { type, data: { event, data } } }.
 * It serves one fabricated track with synced lyrics and a real JPEG for artwork,
 * so layout, the playhead, and lyric timing can all be checked for real.
 *
 *   bun scripts/mockd.ts [--port 8891] [--no-lyrics] [--plain] [--empty]
 */

import { decode as msgpackDecode } from '@msgpack/msgpack';
import { stringify as uuidToString } from 'uuid';

/**
 * The client encodes outbound frames as msgpack and turns uuid-named fields into
 * raw 16-byte arrays. Responses go back as JSON, where the client does no uuid
 * decoding — so every uuid has to come back out as a string here.
 */
function unwrapUuids(value: unknown): any {
  if (value instanceof Uint8Array) return value.length === 16 ? uuidToString(value) : Array.from(value);
  if (Array.isArray(value)) return value.map(unwrapUuids);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = unwrapUuids(v);
    return out;
  }
  return value;
}

const args = new Set(process.argv.slice(2));
const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 8891;

const NO_LYRICS = args.has('--no-lyrics');
const PLAIN_ONLY = args.has('--plain');
const EMPTY = args.has('--empty');
/** Reproduce iAP2: art is pushed late, never pulled, and context is absent. */
const IAP2 = args.has('--iap2');
/** Apple Music art id + a gateway asset lane that always misses — Malav's bug. */
const AM_BROKEN_ART = args.has('--am-broken-art');
/** Pretend a YouTube video has taken over the phone's audio session. */
const YOUTUBE = args.has('--youtube');
/** iap2 art id that never arrives — tiers 1 and 2 both dead, catalog must win. */
const STARVED = args.has('--starved');
/** After a few seconds, a video takes the audio: duration changes, title does not. */
const TAKEOVER = args.has('--takeover');
let takenOver = false;
const AM_ART_URL =
  'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/kid-a/400x400bb.jpg';
const AM_ART_ID = `applemusic/img/400/u${encodeURIComponent(AM_ART_URL).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
const ART_PUSH_MS = 2600;

/* ------------------------------------------------------------------ fixture */

const DURATION_MS = 214_000;
const START = Date.now();

const TRACK = {
  uri: 'am:track:1440857781',
  persistentId: 'iap2/1440857781',
  title: 'Everything In Its Right Place',
  album: 'Kid A',
  albumUri: 'am:album:1097861387',
  albumArtist: 'Radiohead',
  artist: 'Radiohead',
  artistUri: 'am:artist:657515',
  liked: true,
  artworkId: AM_BROKEN_ART ? AM_ART_ID : 'iap2/art/1440857781/9f2c',
  durationMs: DURATION_MS,
  mediaTypes: ['music'],
  trackNumber: 1,
  trackCount: 10,
};

const SYNCED = [
  [0, 'Everything'],
  [4200, 'Everything'],
  [8600, 'Everything in its right place'],
  [14100, 'Everything in its right place'],
  [19400, 'Everything in its right place'],
  [24800, 'There are two colours in my head'],
  [30600, 'There are two colours in my head'],
  [36200, 'What was that you tried to say?'],
  [41900, 'What was that you tried to say?'],
  [47500, 'Everything in its right place'],
  [53000, 'Everything in its right place'],
  [58600, 'Yesterday I woke up sucking a lemon'],
  [64400, 'Yesterday I woke up sucking a lemon'],
  [70100, 'Yesterday I woke up sucking a lemon'],
  [75800, 'Everything in its right place'],
  [81500, 'There are two colours in my head'],
  [87200, 'What was that you tried to say?'],
  [93000, 'Everything in its right place'],
].map(([startMs, text]) => ({ startMs: startMs as number, text: text as string }));

// Repeat the block so the fixture covers the whole track — otherwise the last
// third of the song sits on one stranded line and the view looks broken when it
// is actually correct.
for (let rep = 1; rep * 98_000 < DURATION_MS; rep++) {
  for (const line of SYNCED.slice(0, 18)) {
    const at = line.startMs + rep * 98_000;
    if (at < DURATION_MS) SYNCED.push({ startMs: at, text: line.text });
  }
}

const LYRICS = NO_LYRICS
  ? null
  : PLAIN_ONLY
    ? { synced: null, plain: SYNCED.map(l => l.text).join('\n'), source: 'musixmatch' }
    : { synced: SYNCED, plain: null, source: 'musixmatch' };

/** A small gradient JPEG so artwork, the ambient tint, and the shadow are all real. */
function artworkBytes(): number[] {
  // 1x1 transparent-ish PNG is useless for colour, so draw a real image with a
  // tiny hand-rolled BMP the browser will happily decode.
  const W = 64;
  const H = 64;
  const rowSize = W * 3 + ((4 - ((W * 3) % 4)) % 4);
  const pixelBytes = rowSize * H;
  const size = 54 + pixelBytes;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0);
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(W, 18);
  buf.writeInt32LE(H, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const off = 54 + (H - 1 - y) * rowSize + x * 3;
      const t = x / W;
      const u = y / H;
      buf[off + 2] = Math.round(198 - 120 * u + 40 * t); // R
      buf[off + 1] = Math.round(78 + 60 * t - 30 * u); // G
      buf[off + 0] = Math.round(52 + 150 * u * t); // B
    }
  }
  return Array.from(buf);
}
const ART = artworkBytes();

const APPS = [
  { id: 'a1', name: 'Weather', role: 'standard', version: '0.9.3' },
  { id: 'a2', name: 'Home Assistant', role: 'standard', version: '0.9.0' },
  { id: 'a3', name: 'Browser', role: 'standard', version: '0.9.0' },
  { id: 'a4', name: 'Spotify', role: 'standard', version: '8.9.2' },
  { id: 'a5', name: 'Calendar', role: 'standard', version: '0.9.0' },
];

const PLAYLISTS = [
  ['am:playlist:p.driving', 'Late Night Drive', 'Malav · 84 tracks'],
  ['am:playlist:p.commute', 'Morning Commute', 'Malav · 41 tracks'],
  ['am:playlist:p.focus', 'Deep Focus', 'Apple Music · 120 tracks'],
  ['am:playlist:p.90s', '90s Alternative', 'Apple Music · 100 tracks'],
  ['am:playlist:p.chill', 'Sunday Chill', 'Malav · 63 tracks'],
  ['am:playlist:p.loud', 'Loud & Fast', 'Malav · 29 tracks'],
  ['am:playlist:p.jazz', 'Late Jazz', 'Apple Music · 75 tracks'],
];
const ALBUMS = [
  ['am:album:1097861387', 'Kid A', 'Radiohead'],
  ['am:album:1440913150', 'In Rainbows', 'Radiohead'],
  ['am:album:1440908061', 'OK Computer', 'Radiohead'],
];

const TRACK_NAMES = [
  'Everything In Its Right Place', 'Kid A', 'The National Anthem', 'How to Disappear Completely',
  'Treefingers', 'Optimistic', 'In Limbo', 'Idioteque', 'Morning Bell', 'Motion Picture Soundtrack',
  'Untitled', 'Reckoner',
];

const store = new Map<string, string>();
/** Art the phone has not pushed yet; get() must miss until it lands. */
const pushedArt = new Set<string>();
let volume = 0.62;
let shuffleOn = false;
let repeatMode = 'off';
let playing = true;
let pausedAt = 0;
let seekBase: number | null = null;
let seekAt = 0;

function positionMs(): number {
  if (EMPTY) return 0;
  if (!playing) return pausedAt;
  if (seekBase !== null) return (seekBase + (Date.now() - seekAt)) % DURATION_MS;
  return (Date.now() - START) % DURATION_MS;
}

const YT_TRACK = {
  ...TRACK,
  uri: 'system:com.google.ios.youtube:8f31a2',
  persistentId: 'system:com.google.ios.youtube:8f31a2',
  title: 'Radiohead — Everything In Its Right Place (Live at Glastonbury)',
  artist: 'YouTube',
  album: null,
  liked: null,
  artworkId: 'system-art:yt-8f31a2',
  durationMs: 402_000,
};

function playerState() {
  // The takeover case: the daemon keeps reporting the song's title and artist
  // while the length (and the playhead) belong to a video.
  const base = EMPTY ? null : YOUTUBE ? YT_TRACK : TRACK;
  const track = base && takenOver ? { ...base, durationMs: 402_000 } : base;
  return {
    track,
    playback: {
      state: EMPTY ? 'stopped' : playing ? 'playing' : 'paused',
      positionMs: positionMs(),
      positionAgeMs: 0,
      shuffle: shuffleOn,
      shuffleMode: null,
      repeat: repeatMode,
      queueIndex: 0,
      queueCount: 10,
      queueChapterIndex: null,
      setElapsedTimeAvailable: true,
      queueListAvail: true,
      appleMusicRadioAd: false,
    },
    queue: [],
    options: { speed: 1, crossfadeMs: null },
    context: EMPTY || IAP2 || YOUTUBE ? null : { uri: 'am:playlist:p.driving', name: 'Late Night Drive' },
    target: null,
  };
}

const CAPS = {
  gateway: { name: 'iPhone', platform: 'ios', version: '0.11.0' },
  available: {
    geo: true,
    notifications: true,
    netFetch: true,
    netWs: true,
    audioTts: true,
    lyrics: !NO_LYRICS,
    playbackTargets: false,
  },
  authority: ['nowPlayingMetadata', 'nowPlayingPlayback', 'volume'],
  uriSchemes: ['am'],
  network: { reachable: true, kind: 'phone' },
  audio: { earcons: [], ttsVoices: [] },
  musicProvider: 'appleMusic',
};

/* -------------------------------------------------------------------- wire */

const uuid = () => crypto.randomUUID();
const evt = (type: string, event: string, data?: unknown) =>
  JSON.stringify({ id: uuid(), meta: { kind: 'event' }, data: { type, data: data === undefined ? { event } : { event, data } } });
const rsp = (requestId: string, type: string, event: string, data?: unknown) =>
  JSON.stringify({
    id: uuid(),
    meta: { kind: 'response', data: { requestId } },
    data: { type, data: data === undefined ? { event } : { event, data } },
  });

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response('mock bridgething daemon', { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log('[mockd] webapp connected');
      ws.send(evt('capabilities', 'snapshot', { capabilities: CAPS }));
      ws.send(evt('player', 'snapshot', { state: playerState() }));
      ws.send(evt('audio', 'volumeChanged', { level: volume, muted: false }));
      if (TAKEOVER) {
        setTimeout(() => {
          takenOver = true;
          console.log('[mockd] a video took the audio session (duration changes, title does not)');
          ws.send(evt('player', 'snapshot', { state: playerState() }));
        }, 4000);
      }
      if (YOUTUBE) {
        pushedArt.add(YT_TRACK.artworkId);
      } else if (STARVED) {
        // never pushed, ever
      } else if (AM_BROKEN_ART) {
        // deliberately never pushed: the gateway lane stays broken
      } else if (IAP2) {
        // The real device gets art as a push some seconds after the track lands.
        setTimeout(() => {
          pushedArt.add(TRACK.artworkId);
          console.log('[mockd] pushing art -> Asset.Ready');
          ws.send(evt('asset', 'ready', { id: TRACK.artworkId }));
        }, ART_PUSH_MS);
      } else {
        pushedArt.add(TRACK.artworkId);
      }
    },
    message(ws, raw) {
      let msg: any;
      try {
        msg =
          typeof raw === 'string'
            ? JSON.parse(raw)
            : unwrapUuids(msgpackDecode(new Uint8Array(raw as unknown as ArrayBufferLike)));
      } catch (err) {
        console.log('[mockd] undecodable frame', err);
        return;
      }
      const rid = msg?.meta?.kind === 'request' ? msg.id : null;
      const type = msg?.data?.type;
      const event = msg?.data?.data?.event;
      const body = msg?.data?.data?.data;
      console.log(`[mockd] <- ${type}.${event}`);

      switch (`${type}.${event}`) {
        case 'player.stateGet':
          return rid && ws.send(rsp(rid, 'player', 'stateReply', { state: playerState() }));
        case 'player.pause':
          pausedAt = positionMs();
          playing = false;
          return ws.send(evt('player', 'snapshot', { state: playerState() }));
        case 'player.resume':
          playing = true;
          return ws.send(evt('player', 'snapshot', { state: playerState() }));
        case 'player.skipNext':
        case 'player.skipPrev':
        case 'player.play':
          return ws.send(evt('player', 'snapshot', { state: playerState() }));

        case 'capabilities.get':
          return rid && ws.send(rsp(rid, 'capabilities', 'snapshot', { capabilities: CAPS }));

        case 'lyrics.get':
          if (!rid) return;
          if (NO_LYRICS) {
            return ws.send(rsp(rid, 'lyrics', 'lyricsErrorReply', { error: { type: 'notSupported' } }));
          }
          return ws.send(
            rsp(rid, 'lyrics', 'lyricsReply', {
              trackUri: TRACK.uri,
              trackPersistentId: TRACK.persistentId,
              lyrics: LYRICS,
            }),
          );

        case 'asset.get':
          if (!rid) return;
          if (AM_BROKEN_ART && body.id.startsWith('applemusic/img/')) {
            console.log('[mockd]    -> NotFound (apple music lane broken, as on the real device)');
            return ws.send(rsp(rid, 'asset', 'notFound', { requestId: body.requestId, id: body.id }));
          }
          if (!pushedArt.has(body.id)) {
            console.log(`[mockd]    -> NotFound (art not pushed yet) ${body.id}`);
            return ws.send(rsp(rid, 'asset', 'notFound', { requestId: body.requestId, id: body.id }));
          }
          return ws.send(
            rsp(rid, 'asset', 'got', { requestId: body.requestId, id: body.id, bytes: ART, mime: 'image/bmp' }),
          );

        case 'library.browse': {
          if (!rid) return;
          const node = body?.nodeId ?? null;
          const off = body?.offset ?? 0;
          const folder = (nodeId: string, title: string, total: number) => ({
            type: 'folder',
            data: { nodeId, title, subtitle: null, artworkId: null, total, previewChildren: null },
          });
          const playlist = ([uri, name, owner]: string[]) => ({
            type: 'item',
            data: { type: 'playlist', data: { uri, name, ownerName: owner, trackCount: null, artworkId: null } },
          });
          const album = ([uri, name, artist]: string[]) => ({
            type: 'item',
            data: {
              type: 'album',
              data: { uri, name, artist: { id: 'a', name: artist, artworkId: null }, artworkId: null },
            },
          });
          let entries: unknown[] = [];
          if (node === null) {
            entries = [
              folder('playlists', 'Playlists', PLAYLISTS.length),
              folder('albums', 'Albums', ALBUMS.length),
              folder('artists', 'Artists', 20),
              folder('songs', 'Songs', 900),
              folder('recently-played', 'Recently Played', 12),
              folder('rec:made-for-you', 'Made For You', 4),
              folder('rec:new-music', 'New Music Mix', 6),
            ];
          } else if (node === 'playlists' || node === 'n:playlists') {
            entries = PLAYLISTS.slice(off, off + (body?.limit ?? 60)).map(playlist);
          } else if (node.startsWith('am:playlist:') || node.startsWith('am:album:')) {
            const track = (n: number) => ({
              type: 'item',
              data: {
                type: 'track',
                data: {
                  uri: `${node}:t${n}`,
                  id: `t${n}`,
                  name: TRACK_NAMES[n % TRACK_NAMES.length],
                  album: { id: 'al', name: 'Kid A', artworkId: null },
                  artist: { id: 'ar', name: 'Radiohead', artworkId: null },
                  artworkId: null,
                  durationMs: 200000 + n * 1000,
                },
              },
            });
            entries = Array.from({ length: 12 }, (_, n) => track(n));
          } else if (node === 'recently-played') {
            entries = PLAYLISTS.slice(0, 4).map(playlist);
          } else if (node === 'rec:made-for-you') {
            entries = [
              ['am:playlist:p.mix1', 'Get Up! Mix', 'Apple Music'],
              ['am:playlist:p.mix2', 'Favourites Mix', 'Apple Music'],
              ['am:playlist:p.mix3', 'Chill Mix', 'Apple Music'],
            ].map(playlist);
          } else if (node === 'albums' || node === 'n:albums') {
            entries = ALBUMS.slice(off, off + (body?.limit ?? 60)).map(album);
          }
          return ws.send(
            rsp(rid, 'library', 'browseReply', { result: { entries, total: entries.length, hasMore: false } }),
          );
        }

        case 'player.queueGet': {
          if (!rid) return;
          const q = (n: number) => ({
            uri: `am:track:q${n}`,
            title: TRACK_NAMES[(n + 1) % TRACK_NAMES.length],
            artist: 'Radiohead',
            artistUri: null,
            album: 'Kid A',
            albumUri: null,
            artworkId: null,
            durationMs: 200000,
            persistentId: null,
            queued: true,
          });
          return ws.send(
            rsp(rid, 'player', 'queueReply', {
              current: { ...q(-1), title: TRACK.title, artworkId: TRACK.artworkId },
              items: Array.from({ length: 9 }, (_, n) => q(n)),
              previous: [],
            }),
          );
        }

        case 'player.seekTo':
          console.log(`[mockd] seekTo ${body?.positionMs}ms`);
          seekBase = body?.positionMs ?? 0;
          seekAt = Date.now();
          return ws.send(evt('player', 'snapshot', { state: playerState() }));

        case 'player.setShuffle':
          shuffleOn = !!body?.on;
          console.log(`[mockd] shuffle -> ${shuffleOn}`);
          return ws.send(evt('player', 'snapshot', { state: playerState() }));

        case 'player.setRepeat':
          repeatMode = body?.mode ?? 'off';
          console.log(`[mockd] repeat -> ${repeatMode}`);
          return ws.send(evt('player', 'snapshot', { state: playerState() }));

        case 'player.skipToIndex':
          console.log(`[mockd] skipToIndex ${body?.index}`);
          return ws.send(evt('player', 'snapshot', { state: playerState() }));

        case 'net.fetch': {
          if (!rid) return;
          const url: string = body?.request?.url ?? '';
          console.log(`[mockd] net.fetch -> ${url}`);
          if (url.includes('itunes.apple.com/search')) {
            console.log('[mockd]    -> catalog hit');
            const payload = JSON.stringify({
              resultCount: 1,
              results: [{ artistName: 'Radiohead', collectionName: 'Kid A', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg' }],
            });
            return ws.send(
              rsp(rid, 'net', 'fetchReply', {
                response: { status: 200, headers: [], body: Array.from(new TextEncoder().encode(payload)) },
              }),
            );
          }
          if (url.includes('mzstatic.com')) {
            console.log('[mockd]    -> serving artwork bytes directly (bypass worked)');
            return ws.send(
              rsp(rid, 'net', 'fetchReply', {
                response: { status: 200, headers: [{ name: 'content-type', value: 'image/jpeg' }], body: ART },
              }),
            );
          }
          const payload = JSON.stringify([
            { id: 1, trackName: TRACK.title, artistName: 'Radiohead', duration: 214,
              syncedLyrics: '[00:08.60] Everything in its right place\n[00:14.10] Everything in its right place\n[00:24.80] There are two colours in my head',
              plainLyrics: null },
          ]);
          return ws.send(
            rsp(rid, 'net', 'fetchReply', {
              response: { status: 200, headers: [], body: Array.from(new TextEncoder().encode(payload)) },
            }),
          );
        }

        case 'library.resolveContext':
          return rid && ws.send(rsp(rid, 'library', 'resolveContextReply', { name: null, artworkId: null, subtitle: null }));

        case 'store.get':
          return rid && ws.send(rsp(rid, 'store', 'response', { key: body.key, value: store.get(body.key) ?? null }));
        case 'store.put':
          store.set(body.key, body.value);
          return rid && ws.send(rsp(rid, 'store', 'response', { key: body.key, value: body.value }));
        case 'store.delete':
          store.delete(body.key);
          return rid && ws.send(rsp(rid, 'store', 'response', { key: body.key, value: null }));

        case 'webapp.list':
          return (
            rid &&
            ws.send(
              rsp(rid, 'webapp', 'listReply', {
                webapps: APPS.map(a => ({
                  ...a,
                  source: 'installed',
                  description: null,
                  iconHash: null,
                  settingsHash: null,
                  overlayHash: null,
                  config: [],
                  permissions: [],
                  rendersVoiceDisplay: false,
                  art: null,
                  provenance: null,
                })),
              }),
            )
          );
        case 'webapp.activate':
          console.log(`[mockd] would switch kiosk to ${body?.id}`);
          return rid && ws.send(rsp(rid, 'webapp', 'activeReply', { id: body?.id ?? null, name: null }));

        case 'audio.setVolume':
          volume = body.level;
          return ws.send(evt('audio', 'volumeChanged', { level: volume, muted: false }));

        case 'library.favoritesToggle':
          TRACK.liked = !TRACK.liked;
          return ws.send(evt('player', 'snapshot', { state: playerState() }));
      }
    },
    close() {
      console.log('[mockd] webapp disconnected');
    },
  },
});

console.log(
  `[mockd] listening on ws://127.0.0.1:${server.port}  ` +
    `(lyrics: ${NO_LYRICS ? 'unsupported' : PLAIN_ONLY ? 'plain only' : 'synced'}${EMPTY ? ', nothing playing' : ''})`,
);
