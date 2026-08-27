import {
  BridgethingClient,
  type BrowseEntry,
  type Capabilities,
  type ConnectionState,
  type LibraryItem,
  type Lyrics,
  type PlayerState,
  type QueueItem,
  type WebappInfo,
} from '@bridgething/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const wsUrl =
  import.meta.env.VITE_BRIDGETHING_URL ??
  (typeof window !== 'undefined' ? `ws://${window.location.host}/` : 'ws://127.0.0.1:8891/');

/** One client for the whole app. Auto-connects, auto-reconnects. */
export function useClient() {
  return useMemo(() => new BridgethingClient({ url: wsUrl }), []);
}

export function useConnection(client: BridgethingClient): ConnectionState {
  const [conn, setConn] = useState<ConnectionState>(client.connectionState);
  useEffect(() => client.on(() => setConn(client.connectionState)), [client]);
  return conn;
}

/** Full now-playing snapshot. Primed on mount, then pushed by the daemon. */
export function usePlayer(client: BridgethingClient): PlayerState | null {
  const [state, setState] = useState<PlayerState | null>(null);
  useEffect(() => {
    const off = client.player.onSnapshot(reply => setState(reply.state));
    client.player.stateGet().then(r => {
      if (r.ok) setState(r.response.state);
    });
    return off;
  }, [client]);
  return state;
}

export function useCapabilities(client: BridgethingClient): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    const off = client.capabilities.onSnapshot(reply => setCaps(reply.capabilities ?? null));
    client.capabilities.get().then(r => {
      if (r.ok) setCaps(r.response.capabilities ?? null);
    });
    return off;
  }, [client]);
  return caps;
}

/**
 * The playhead. `onSnapshot` only fires on material changes, so we extrapolate
 * locally between them. 10Hz — smooth enough for the bar, precise enough that a
 * lyric line never lands late by anything a human notices.
 */
export function usePlayhead(state: PlayerState | null): number {
  const [pos, setPos] = useState(0);
  const base = useRef({ ms: 0, at: 0, playing: false });

  useEffect(() => {
    if (!state) return;
    const pb = state.playback;
    base.current = {
      ms: pb.positionMs + (pb.positionAgeMs ?? 0),
      at: performance.now(),
      playing: pb.state === 'playing',
    };
    setPos(base.current.ms);
  }, [state]);

  useEffect(() => {
    const id = setInterval(() => {
      const b = base.current;
      setPos(b.playing ? b.ms + (performance.now() - b.at) : b.ms);
    }, 100);
    return () => clearInterval(id);
  }, []);

  return pos;
}

export type ArtState = 'idle' | 'waiting' | 'ready' | 'missing';

/**
 * Artwork, the way iAP2 actually delivers it.
 *
 * On Apple Music the daemon never *pulls* art — the phone pushes it, and until
 * that push lands `asset.get` answers NotFound immediately (see the daemon's
 * `fetch_iap2_art`). A track change is precisely the moment the art is not there
 * yet, so a single get on mount misses every time and the screen stays grey.
 *
 * So: subscribe to `onReady` first — that is the real signal — and keep a slow
 * retry behind it as a backstop. The daemon negative-caches a miss for 5s and
 * clears that cache when Ready fires, so retries are spaced to not waste calls.
 */
const ART_RETRY_MS = [1_200, 3_000, 6_000, 6_000, 10_000, 10_000];

export type ArtTier = 'gateway' | 'direct' | 'catalog' | null;

export type ArtTrack = {
  artworkId?: string | null;
  artist?: string | null;
  album?: string | null;
  title?: string | null;
  uri?: string | null;
  persistentId?: string | null;
};

/**
 * Artwork, in three tiers, because the first two can each fail on their own.
 *
 *  1. `asset.get` — the gateway's own lane.
 *  2. If that misses and the id is Apple Music's, decode the image URL out of
 *     the id and fetch it through the phone directly.
 *  3. If there is no usable id at all, look the record up in Apple's public
 *     catalog by artist + album. No auth, no tokens, and crucially it does not
 *     care what the gateway did or did not hand us.
 *
 * Tier 3 is what makes this survive a null `artworkId`, which is the state the
 * gateway appears to be in.
 */
export function useArtwork(client: BridgethingClient, track: ArtTrack | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<ArtState>('idle');
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState<ArtTier>(null);
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce(n => n + 1), []);

  const artworkId = track?.artworkId ?? null;
  const artist = track?.artist ?? null;
  const album = track?.album ?? null;
  const title = track?.title ?? null;
  const shownFor = useRef<string | null>(null);
  // Stable identity for the song, not for every attribute that trickles in.
  const identity = track?.persistentId ?? track?.uri ?? `${artist ?? ''}|${title ?? ''}`;
  const key = `${identity}|${artworkId ?? ''}`;

  useEffect(() => {
    if (!artworkId && !artist && !title) {
      setUrl(null);
      setState('idle');
      setAttempts(0);
      setTier(null);
      return;
    }

    let dead = false;
    let blobUrl: string | null = null;
    let timer: number | null = null;
    let tries = 0;

    // Only blank the screen when the song itself changed. A new artwork id for
    // the same song is an upgrade, not a reason to flash grey.
    const songChanged = shownFor.current !== identity;
    if (songChanged) {
      setUrl(null);
      setTier(null);
      shownFor.current = identity;
    }
    setState(songChanged ? 'waiting' : 'ready');
    setAttempts(0);
    setError(null);

    const show = (bytes: Uint8Array, mime: string, from: ArtTier) => {
      if (dead || !bytes.byteLength) return false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
      setUrl(blobUrl);
      setState('ready');
      setTier(from);
      return true;
    };

    const catalogTier = async () => {
      if (dead || !artist) return false;
      const found = await catalogArtUrl(client, artist, album, title);
      if (dead || !found) return false;
      const bytes = await netGet(client, found);
      if (dead || !bytes) return false;
      return show(bytes, 'image/jpeg', 'catalog');
    };

    const attempt = async () => {
      if (dead) return;
      tries += 1;
      setAttempts(tries);

      if (artworkId) {
        const res = await client.asset.get({ id: artworkId, requestId: crypto.randomUUID() });
        if (dead) return;

        if (res.ok) {
          const bytes = new Uint8Array(res.response.bytes as unknown as number[]);
          if (show(bytes, res.response.mime ?? 'image/jpeg', 'gateway')) return;
          setError('the gateway returned an empty body');
        } else {
          const detail: any = res.kind === 'domain' ? null : res.error;
          setError(
            res.kind === 'domain'
              ? 'gateway: notFound for this id'
              : `gateway protocol error: ${detail?.type ?? 'unknown'}`,
          );
        }

        // Tier 2 — the id still carries the real URL when it is Apple Music's.
        const direct = appleArtUrl(artworkId);
        if (direct) {
          const bytes = await netGet(client, direct);
          if (dead) return;
          if (bytes && show(bytes, 'image/jpeg', 'direct')) {
            setError('gateway lane failed; fetched from Apple directly');
            return;
          }
        }
      } else {
        setError('no artwork id from the gateway');
      }

      // Tier 3 — ask Apple's catalog ourselves.
      if (await catalogTier()) {
        setError(artworkId ? 'gateway and direct both failed; matched from Apple catalog' : 'no artwork id; matched from Apple catalog');
        return;
      }
      if (dead) return;

      const delay = ART_RETRY_MS[tries - 1];
      if (delay === undefined) {
        setState('missing');
        return;
      }
      timer = window.setTimeout(attempt, delay);
    };

    // The gateway's own artwork is the one that matches the Music app. A catalog
    // match is a stand-in, so keep listening and upgrade the moment the real
    // bytes arrive — this is what happens when a video briefly wakes the push.
    const off = client.asset.onReady(async ready => {
      if (dead || !artworkId || ready.id !== artworkId) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      const res = await client.asset.get({ id: artworkId, requestId: crypto.randomUUID() });
      if (dead || !res.ok) return;
      const bytes = new Uint8Array(res.response.bytes as unknown as number[]);
      if (show(bytes, res.response.mime ?? 'image/jpeg', 'gateway')) {
        setError(null);
      }
    });

    void attempt();

    return () => {
      dead = true;
      off();
      if (timer !== null) window.clearTimeout(timer);
      // Revoking here is what made the image vanish mid-track. The browser
      // releases the blob when the last reference goes; a short-lived leak is a
      // far better trade than a flickering screen.
    };
  }, [client, key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return { url, state, attempts, error, tier, retry };
}

/**
 * Thumbnails for a list of rows. Library art is companion-lane (an Apple Music
 * image URL the phone fetches), so unlike now-playing art it really is pullable
 * — but it goes over Bluetooth, so it is fetched a few at a time and only for
 * rows that are actually on screen.
 */
export function useThumbs(client: BridgethingClient, ids: (string | null)[]) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const inflight = useRef(new Set<string>());
  const key = ids.filter(Boolean).join('|');

  useEffect(() => {
    const wanted = ids.filter((id): id is string => !!id && !thumbs[id] && !inflight.current.has(id)).slice(0, 24);
    if (!wanted.length) return;

    let dead = false;
    const made: string[] = [];

    (async () => {
      // Small concurrency: Bluetooth is the bottleneck, not the daemon.
      const queue = [...wanted];
      const workers = Array.from({ length: 3 }, async () => {
        while (queue.length && !dead) {
          const id = queue.shift()!;
          inflight.current.add(id);
          const res = await client.asset.get({ id, requestId: crypto.randomUUID() });
          inflight.current.delete(id);
          if (dead || !res.ok) continue;
          const bytes = new Uint8Array(res.response.bytes as unknown as number[]);
          if (!bytes.byteLength) continue;
          const url = URL.createObjectURL(new Blob([bytes], { type: res.response.mime ?? 'image/jpeg' }));
          made.push(url);
          setThumbs(prev => ({ ...prev, [id]: url }));
        }
      });
      await Promise.all(workers);
    })();

    return () => {
      dead = true;
      made.forEach(URL.revokeObjectURL);
    };
  }, [client, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return thumbs;
}

/* -------------------------------------------------------------------- queue */

export function useQueue(client: BridgethingClient, enabled: boolean) {
  const [queue, setQueue] = useState<{ current: QueueItem | null; items: QueueItem[]; previous: QueueItem[] }>({
    current: null,
    items: [],
    previous: [],
  });

  useEffect(() => {
    const off = client.player.onQueueChanged(r =>
      setQueue({ current: r.current, items: r.items, previous: r.previous }),
    );
    return off;
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    client.player.queueGet().then(r => {
      if (!dead && r.ok) setQueue({ current: r.response.current, items: r.response.items, previous: r.response.previous });
    });
    return () => {
      dead = true;
    };
  }, [client, enabled]);

  return queue;
}

export type LyricsStatus = 'idle' | 'loading' | 'ready' | 'none' | 'unsupported';

/**
 * Lyrics for whatever is playing. The request carries no track, so the reply is
 * matched against current now-playing and discarded if the track moved on.
 */
export function useLyrics(client: BridgethingClient, state: PlayerState | null) {
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [status, setStatus] = useState<LyricsStatus>('idle');
  const track = state?.track ?? null;
  const key = track?.uri ?? track?.persistentId ?? null;

  useEffect(() => {
    if (!key) {
      setLyrics(null);
      setStatus('idle');
      return;
    }
    let dead = false;
    setLyrics(null);
    setStatus('loading');

    (async () => {
      const res = await client.lyrics.get();
      if (dead) return;

      if (!res.ok) {
        if (res.kind === 'domain' && res.error?.error?.type === 'notSupported') setStatus('unsupported');
        else setStatus('none');
        return;
      }

      const reply = res.response;
      // Discard a reply that landed after the track already moved on.
      const stale =
        (reply.trackUri && track?.uri && reply.trackUri !== track.uri) ||
        (reply.trackPersistentId && track?.persistentId && reply.trackPersistentId !== track.persistentId);
      if (stale) return;

      if (reply.lyrics && (reply.lyrics.synced?.length || reply.lyrics.plain)) {
        setLyrics(reply.lyrics);
        setStatus('ready');
        return;
      }

      // Daemon came up empty. Try lrclib's fuzzy endpoint ourselves before
      // telling the user there are no lyrics — it catches remasters and
      // "(feat. …)" titles that the strict lookup misses.
      const artist = track?.artist ?? '';
      const title = track?.title ?? '';
      if (!artist || !title) {
        setStatus('none');
        return;
      }
      setStatus('loading');
      try {
        const fuzzy = await fallbackLyrics(client, artist, title, track?.durationMs ?? null);
        if (dead) return;
        if (fuzzy && (fuzzy.synced?.length || fuzzy.plain)) {
          setLyrics(fuzzy);
          setStatus('ready');
          return;
        }
      } catch {
        /* the phone may have no route out; fall through to 'none' */
      }
      if (!dead) setStatus('none');
    })();

    return () => {
      dead = true;
    };
  }, [client, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { lyrics, status };
}

export function useVolume(client: BridgethingClient) {
  const [level, setLevel] = useState(0.5);
  const [muted, setMuted] = useState(false);
  const [bumped, setBumped] = useState(0);

  useEffect(
    () =>
      client.audio.onVolumeChanged(v => {
        setLevel(v.level);
        setMuted(v.muted);
        setBumped(Date.now());
      }),
    [client],
  );

  const nudge = useCallback(
    (delta: number) => {
      const next = Math.min(1, Math.max(0, level + delta));
      setLevel(next);
      setBumped(Date.now());
      client.audio.setVolume({ level: next });
    },
    [client, level],
  );

  return { level, muted, bumped, nudge };
}

/** Installed apps, for the drawer. Launcher-role bundles are excluded by the daemon. */
export function useApps(client: BridgethingClient, enabled: boolean) {
  const [apps, setApps] = useState<WebappInfo[]>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    client.webapp.list().then(r => {
      if (!dead && r.ok) setApps(r.response.webapps);
    });
    return () => {
      dead = true;
    };
  }, [client, enabled]);

  useEffect(() => {
    if (!apps.length) return;
    let dead = false;
    const made: string[] = [];
    (async () => {
      for (const app of apps) {
        if (!app.iconHash || icons[app.id]) continue;
        const res = await client.webapp.icon({ id: app.id });
        if (dead || !res.ok) continue;
        const bytes = new Uint8Array(res.response.bytes as unknown as number[]);
        const url = URL.createObjectURL(new Blob([bytes], { type: res.response.mime ?? 'image/png' }));
        made.push(url);
        setIcons(prev => ({ ...prev, [app.id]: url }));
      }
    })();
    return () => {
      dead = true;
      made.forEach(URL.revokeObjectURL);
    };
  }, [client, apps]); // eslint-disable-line react-hooks/exhaustive-deps

  return { apps, icons };
}

export type Preset = {
  uri: string;
  label: string;
  sub: string | null;
  artworkId: string | null;
};

const PRESETS_KEY = 'presets.v1';
const LAST_PLAYED_KEY = 'lastPlayed.v1';
const EMPTY: (Preset | null)[] = [null, null, null, null];

/**
 * Four car-radio slots, persisted on-device so they survive a restart.
 *
 * `lastPlayed` remembers the last *container* (playlist/album) started from the
 * browser. Apple Music over iAP2 frequently reports no playback context, so
 * without this a preset saved from the player would capture whichever single
 * track happened to be on — which is not what a preset means.
 */
export function usePresets(client: BridgethingClient) {
  const [presets, setPresets] = useState<(Preset | null)[]>(EMPTY);
  const [lastPlayed, setLastPlayed] = useState<Preset | null>(null);

  useEffect(() => {
    client.store.get({ key: PRESETS_KEY }).then(r => {
      if (!r.ok || !r.response.value) return;
      try {
        const parsed = JSON.parse(r.response.value);
        if (Array.isArray(parsed)) setPresets([0, 1, 2, 3].map(i => parsed[i] ?? null));
      } catch {
        /* corrupt slot data is not worth crashing over */
      }
    });
    client.store.get({ key: LAST_PLAYED_KEY }).then(r => {
      if (!r.ok || !r.response.value) return;
      try {
        setLastPlayed(JSON.parse(r.response.value));
      } catch {
        /* ignore */
      }
    });
  }, [client]);

  const rememberPlayed = useCallback(
    (p: Preset) => {
      setLastPlayed(p);
      client.store.put({ key: LAST_PLAYED_KEY, value: JSON.stringify(p) });
    },
    [client],
  );

  const save = useCallback(
    (next: (Preset | null)[]) => {
      setPresets(next);
      client.store.put({ key: PRESETS_KEY, value: JSON.stringify(next) });
    },
    [client],
  );

  const assign = useCallback(
    (slot: number, preset: Preset | null) => {
      const next = presets.slice();
      next[slot] = preset;
      save(next);
    },
    [presets, save],
  );

  return { presets, assign, lastPlayed, rememberPlayed };
}

/* ------------------------------------------------------------------ library */

export type Row = {
  key: string;
  kind: 'folder' | 'header' | 'playlist' | 'album' | 'artist' | 'track' | 'station' | 'show' | 'podcastEpisode';
  nodeId: string | null;
  uri: string | null;
  title: string;
  subtitle: string | null;
  artworkId: string | null;
  /** Playable containers are what a preset should hold. */
  container: boolean;
};

export type Crumb = { nodeId: string | null; title: string; uri?: string | null; container?: boolean };

function rowFromEntry(entry: BrowseEntry, i: number): Row {
  if (entry.type === 'folder') {
    const f = entry.data;
    return {
      key: `f:${f.nodeId}:${i}`,
      kind: 'folder',
      nodeId: f.nodeId,
      uri: null,
      title: f.title,
      subtitle: f.subtitle ?? (f.total != null ? `${f.total} items` : null),
      artworkId: f.artworkId,
      container: false,
    };
  }
  return rowFromItem(entry.data, i);
}

function rowFromItem(item: LibraryItem, i: number): Row {
  const d = item.data as any;
  const sub =
    item.type === 'playlist'
      ? [d.ownerName, d.trackCount != null ? `${d.trackCount} tracks` : null].filter(Boolean).join(' · ') || null
      : item.type === 'album'
        ? (d.artist?.name ?? null)
        : item.type === 'track'
          ? (d.artist?.name ?? null)
          : (d.subtitle ?? null);
  return {
    key: `i:${d.uri ?? d.id ?? i}:${i}`,
    kind: item.type,
    nodeId: null,
    uri: d.uri ?? null,
    title: d.name ?? d.title ?? 'Untitled',
    subtitle: sub,
    artworkId: d.artworkId ?? d.album?.artworkId ?? null,
    container: item.type === 'playlist' || item.type === 'album' || item.type === 'station' || item.type === 'show',
  };
}

export type LibraryState = {
  rows: Row[];
  loading: boolean;
  error: string | null;
  crumbs: Crumb[];
  open: (row: Row) => void;
  back: () => void;
  reload: () => void;
};

const PAGE = 100;

/**
 * Apple Music's browse root hands back everything: playlists, albums, artists,
 * songs, recently played and a pile of recommendation rails. That is a lot of
 * reading at 70km/h, so we never show the root. Instead we open the two or three
 * node ids that matter and stitch them into one list.
 *
 * The ids are the provider's own constants (`playlists`, `recently-played`) plus
 * whichever `rec:` rail is named "made for you".
 */
const NODE_PLAYLISTS = 'playlists';
const NODE_RECENT = 'recently-played';

async function browseNode(client: BridgethingClient, nodeId: string | null): Promise<Row[] | { error: string }> {
  const res = await client.library.browse({ nodeId, limit: PAGE, offset: 0, preview: 0 });
  if (!res.ok) {
    const e: any = res.kind === 'domain' ? res.error?.error : res.error;
    return {
      error:
        e?.type === 'unauthorized'
          ? 'Not signed in on the phone.'
          : e?.type === 'noGateway'
            ? 'No phone connected.'
            : 'Could not load your library.',
    };
  }
  return res.response.result.entries.map(rowFromEntry);
}

/** The "made for you" rail, if this account has one. Cached for the session. */
let madeForYouNode: string | null | undefined;
async function findMadeForYou(client: BridgethingClient): Promise<string | null> {
  if (madeForYouNode !== undefined) return madeForYouNode;
  const root = await browseNode(client, null);
  if ('error' in root) {
    madeForYouNode = null;
    return null;
  }
  const hit = root.find(
    r => r.kind === 'folder' && /made for you|for you|made for/i.test(r.title),
  );
  madeForYouNode = hit?.nodeId ?? null;
  return madeForYouNode;
}

export type Section = 'playlists' | 'recent';

export function useLibrary(client: BridgethingClient, enabled: boolean, section: Section): LibraryState {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ nodeId: null, title: 'Playlists' }]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const depth = crumbs.length;
  const node = crumbs[depth - 1]?.nodeId ?? null;

  // Changing section resets to that section's top level.
  useEffect(() => {
    setCrumbs([{ nodeId: null, title: section === 'recent' ? 'Recently played' : 'Playlists' }]);
    setRows([]);
  }, [section]);

  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    setLoading(true);
    setError(null);

    (async () => {
      // Top level of a section is assembled; anything deeper is a plain browse.
      if (depth === 1) {
        if (section === 'recent') {
          const recent = await browseNode(client, NODE_RECENT);
          if (dead) return;
          setLoading(false);
          if ('error' in recent) return setError(recent.error);
          return setRows(recent);
        }

        const mine = await browseNode(client, NODE_PLAYLISTS);
        if (dead) return;
        if ('error' in mine) {
          setLoading(false);
          return setError(mine.error);
        }

        const forYouNode = await findMadeForYou(client);
        let forYou: Row[] = [];
        if (forYouNode) {
          const got = await browseNode(client, forYouNode);
          if (!('error' in got)) forYou = got;
        }
        if (dead) return;
        setLoading(false);

        const header = (title: string, i: number): Row => ({
          key: `hdr:${title}:${i}`,
          kind: 'header',
          nodeId: null,
          uri: null,
          title,
          subtitle: null,
          artworkId: null,
          container: false,
        });

        setRows([
          ...(mine.length ? [header('Your playlists', 0), ...mine] : []),
          ...(forYou.length ? [header('Made for you', 1), ...forYou] : []),
        ]);
        return;
      }

      const got = await browseNode(client, node);
      if (dead) return;
      setLoading(false);
      if ('error' in got) return setError(got.error);
      setRows(got);
    })();

    return () => {
      dead = true;
    };
  }, [client, enabled, node, depth, section, nonce]);

  const open = useCallback((row: Row) => {
    const target = row.kind === 'folder' ? row.nodeId : row.uri;
    if (!target || row.kind === 'header') return;
    setRows([]);
    setCrumbs(c => [...c, { nodeId: target, title: row.title, uri: row.uri, container: row.container }]);
  }, []);

  const back = useCallback(() => {
    setCrumbs(c => (c.length > 1 ? c.slice(0, -1) : c));
    setRows([]);
  }, []);

  const reload = useCallback(() => {
    setRows([]);
    setNonce(n => n + 1);
  }, []);

  return { rows, loading, error, crumbs, open, back, reload };
}

/** Name a context uri the gateway gave us without a name. */
export async function resolveContextName(client: BridgethingClient, uri: string): Promise<string | null> {
  const res = await client.library.resolveContext({ uri });
  return res.ok ? (res.response.name ?? null) : null;
}

/* ------------------------------------------------------- lyrics fallback */

/**
 * The daemon's lyrics come from lrclib via its `/api/get` endpoint, which wants
 * artist + title + album + duration to line up closely. Plenty of Apple Music
 * tracks miss on that even though lrclib has them — a remaster runs three
 * seconds long, or the title carries a "(feat. …)" suffix.
 *
 * When the daemon comes back empty we retry against lrclib's fuzzy `/api/search`
 * ourselves, through `net.fetch` (the device has no network of its own; this
 * tunnels via the phone). Needs `net.fetch` in the manifest permissions.
 */
/** One GET through the phone's connection. The device has no network of its own. */
export async function netGet(client: BridgethingClient, url: string): Promise<Uint8Array | null> {
  const res = await client.net.fetch({
    request: {
      url,
      method: 'GET',
      headers: [{ name: 'user-agent', value: 'cassette-carthing/0.4' }],
      body: null,
      timeoutMs: 12_000,
      redirect: 'follow',
    },
  });
  if (!res.ok) return null;
  const reply = res.response.response;
  if (reply.status < 200 || reply.status >= 300) return null;
  return new Uint8Array(reply.body as unknown as number[]);
}

/**
 * Apple Music artwork ids are a reversible encoding of the image URL:
 * `applemusic/img/<edge>/u<percent-encoded url>` (namespace `applemusic/img/`,
 * no short form, so the tag is always `u`). Decoding it lets the app fetch the
 * image straight from Apple through the phone, skipping the daemon's asset lane
 * entirely — which matters because that lane is the one failing.
 */
export function appleArtUrl(assetId: string | null | undefined): string | null {
  if (!assetId) return null;
  const rest = assetId.startsWith('applemusic/img/') ? assetId.slice('applemusic/img/'.length) : null;
  if (!rest) return null;
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const tagged = rest.slice(slash + 1);
  if (tagged[0] !== 'u') return null;
  try {
    const url = decodeURIComponent(tagged.slice(1));
    return url.startsWith('https://') ? url : null;
  } catch {
    return null;
  }
}

function stripNoise(s: string): string {
  return s
    .replace(/\s*[([][^)\]]*\b(feat|ft|with|remaster(ed)?|version|edit|mix|mono|stereo|deluxe|live)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s*-\s*(\d{4}\s*)?remaster(ed)?.*$/gi, '')
    .trim();
}

type LrclibHit = {
  id?: number;
  trackName?: string;
  artistName?: string;
  duration?: number;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
};

/** Minimal LRC parser: `[mm:ss.xx] text`, multiple stamps per line allowed. */
export function parseLrc(text: string): { startMs: number; text: string }[] {
  const out: { startMs: number; text: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      out.push({ startMs: Number(m[1]) * 60_000 + Number(m[2]) * 1_000 + frac, text: body });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export async function fallbackLyrics(
  client: BridgethingClient,
  artist: string,
  title: string,
  durationMs: number | null,
): Promise<Lyrics | null> {
  const q = new URLSearchParams({ artist_name: stripNoise(artist), track_name: stripNoise(title) });
  const res = await netGet(client, `https://lrclib.net/api/search?${q.toString()}`);
  if (!res) return null;
  let hits: LrclibHit[];
  try {
    hits = JSON.parse(new TextDecoder().decode(res));
  } catch {
    return null;
  }
  if (!Array.isArray(hits) || !hits.length) return null;

  // Prefer synced, then the closest duration — that is what separates the right
  // recording from a live cut or a different remaster.
  const scored = hits
    .filter(h => h.syncedLyrics || h.plainLyrics)
    .map(h => ({
      h,
      score:
        (h.syncedLyrics ? -1000 : 0) +
        (durationMs && h.duration ? Math.abs(h.duration * 1000 - durationMs) / 1000 : 50),
    }))
    .sort((a, b) => a.score - b.score);
  const best = scored[0]?.h;
  if (!best) return null;

  const synced = best.syncedLyrics ? parseLrc(best.syncedLyrics) : null;
  return {
    synced: synced && synced.length ? synced : null,
    plain: best.plainLyrics && best.plainLyrics.trim() ? best.plainLyrics : null,
    source: 'lrclib (fuzzy)',
  };
}

/* --------------------------------------------------------- catalog artwork */

/**
 * Apple's public search endpoint. No key, no token — it is the same catalogue
 * behind the Music app, so a track that exists in Apple Music resolves here.
 * Results are cached on device so a repeat listen costs nothing.
 */
export async function catalogArtUrl(
  client: BridgethingClient,
  artist: string,
  album: string | null,
  title: string | null,
): Promise<string | null> {
  const cacheKey = `art:${artist}|${album ?? title ?? ''}`.slice(0, 180);
  const cached = await client.store.get({ key: cacheKey });
  if (cached.ok && cached.response.value) return cached.response.value || null;

  const norm = (v: string) =>
    v
      .toLowerCase()
      .replace(/\s*[([][^)\]]*[)\]]/g, '')
      .replace(/\s*-\s*(single|ep|deluxe|remaster(ed)?).*$/i, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  // Ask for several and pick the one that actually matches, rather than trusting
  // whatever the search ranked first — that is how you end up with a greatest
  // hits cover on an album track.
  const attempts: { term: string; entity: string; want: string | null }[] = [];
  if (album) attempts.push({ term: `${artist} ${album}`, entity: 'album', want: album });
  if (title) attempts.push({ term: `${artist} ${title}`, entity: 'song', want: title });

  for (const a of attempts) {
    const q = new URLSearchParams({ term: a.term, entity: a.entity, limit: '8', media: 'music' });
    const body = await netGet(client, `https://itunes.apple.com/search?${q.toString()}`);
    if (!body) continue;
    let results: any[];
    try {
      results = JSON.parse(new TextDecoder().decode(body))?.results ?? [];
    } catch {
      continue;
    }
    if (!results.length) continue;

    const wantName = a.want ? norm(a.want) : null;
    const wantArtist = norm(artist);

    const scored = results
      .filter(r => r.artworkUrl100)
      .map(r => {
        const name = norm(r.collectionName ?? r.trackName ?? '');
        const who = norm(r.artistName ?? '');

        // Score the two halves separately. Matching only the artist is how you
        // end up with the right band and the wrong record — both have to agree.
        let nameScore = 0;
        if (wantName && name === wantName) nameScore = 100;
        else if (wantName && (name.startsWith(wantName) || wantName.startsWith(name))) nameScore = 70;
        else if (wantName && name.includes(wantName)) nameScore = 45;

        let artistScore = 0;
        if (who === wantArtist) artistScore = 100;
        else if (who.includes(wantArtist) || wantArtist.includes(who)) artistScore = 60;

        let penalty = 0;
        if (/greatest hits|best of|essential|collection|compilation|karaoke|tribute|made famous/i.test(r.collectionName ?? ''))
          penalty = 50;

        return { r, nameScore, artistScore, total: nameScore + artistScore - penalty };
      })
      .filter(c => c.nameScore >= 45 && c.artistScore >= 60)
      .sort((x, y) => y.total - x.total);

    const best = scored[0];
    // No confident match is better than a confident wrong one.
    if (!best) continue;

    const small: string = best.r.artworkUrl100;
    const big = small.replace(/\/(\d+)x(\d+)(bb)?\.(jpg|png)$/i, '/600x600bb.$4');
    await client.store.put({ key: cacheKey, value: big });
    return big;
  }
  return null;
}

/* ------------------------------------------------------------- up next */

/**
 * What is coming up.
 *
 * The real queue is unavailable: the Apple Music provider implements `queue`
 * (add to it) but never queue *listing* — `queueGet` comes back empty, which is
 * why the Queue tab showed nothing. So instead of a queue we show the tracks of
 * whatever container is playing, which is the same list in practice and is
 * something the provider will answer for.
 */
export function useUpNext(client: BridgethingClient, containerUri: string | null, enabled: boolean) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!containerUri) {
      setRows([]);
      setError(null);
      return;
    }
    let dead = false;
    setLoading(true);
    setError(null);

    client.library.browse({ nodeId: containerUri, limit: 100, offset: 0, preview: 0 }).then(res => {
      if (dead) return;
      setLoading(false);
      if (!res.ok) {
        setError('Could not read this playlist.');
        return;
      }
      setRows(res.response.result.entries.map(rowFromEntry));
    });

    return () => {
      dead = true;
    };
  }, [client, containerUri, enabled]);

  return { rows, loading, error };
}
