import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlternativeMedia,
  Art,
  IconButton,
  LyricsPane,
  Placeholder,
  Progress,
  titleClass,
  Transport,
  VolumeHud,
} from './components';
import {
  type Preset,
  type Row,
  type Section,
  useApps,
  useArtwork,
  useCapabilities,
  useClient,
  useConnection,
  useLyrics,
  usePlayer,
  usePlayhead,
  useLibrary,
  usePresets,
  useThumbs,
  useUpNext,
  useVolume,
} from './lib/bridge';
import { InfoPanel, LibraryTab, MoreTab, Overlay, PresetChooser, UpNextTab, type Tab } from './overlay';
import { ambientCss, ambientFrom, ambientGlow, sourceOf } from './lib/util';

// Two views, not three. The full-screen lyric page duplicated the split one
// without adding anything you could not already read at arm's length.
type View = 'art' | 'split';
const CYCLE: View[] = ['art', 'split'];
const HOLD_MS = 700;
const VERSION = '0.8.0';

export default function App() {
  const client = useClient();
  const conn = useConnection(client);
  const state = usePlayer(client);
  const caps = useCapabilities(client);
  const posMs = usePlayhead(state);
  const { lyrics, status: lyricsStatus } = useLyrics(client, state);
  const { level, muted, bumped, nudge } = useVolume(client);
  const { presets, assign, lastPlayed, rememberPlayed } = usePresets(client);

  const [view, setView] = useState<View>('art');
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState<Tab>('library');
  const [section, setSection] = useState<Section>('playlists');
  const [showInfo, setShowInfo] = useState(false);
  const [assigning, setAssigning] = useState<Row | null>(null);
  const [glow, setGlow] = useState<[number, number, number] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const { apps, icons } = useApps(client, drawer && tab === 'more');
  const lib = useLibrary(client, drawer && tab === 'library', section);
  // Whatever container playback came from: the gateway's context when it gives
  // one (it usually does not on Apple Music), else the last thing started here.
  const playingFrom = state?.context?.uri ?? lastPlayed?.uri ?? null;
  const playingFromName = state?.context?.name ?? lastPlayed?.label ?? null;
  const upNext = useUpNext(client, playingFrom, drawer && tab === 'queue');
  const thumbIds = useMemo(
    () => (tab === 'queue' ? upNext.rows.map(r => r.artworkId) : lib.rows.map(r => r.artworkId)),
    [tab, upNext.rows, lib.rows],
  );
  const thumbs = useThumbs(client, drawer ? thumbIds : []);

  const track = state?.track ?? null;
  const art = useArtwork(client, track);
  const artUrl = art.url;
  const playing = state?.playback.state === 'playing';
  const shuffle = !!state?.playback.shuffle;
  // Which app owns playback right now. Apple Music is not always the answer —
  // start a video and the phone's system-media session takes over.
  const source = useMemo(() => sourceOf(track?.uri, track?.artworkId), [track?.uri, track?.artworkId]);
  // Only hide controls when we are certain; a wrong guess strips working buttons.
  const foreign = source.kind === 'system';
  const repeat = state?.playback.repeat ?? 'off';
  const lyricsAvailable = caps?.available.lyrics !== false;

  /* -------------------------------------------------- alternative media */

  /**
   * Manual only, deliberately.
   *
   * Three automatic tells were tried — a duration that changed while the title
   * did not, a playhead past the end of the track, a playhead jump nothing
   * explained. All three fire during ordinary Apple Music playback, because
   * iAP2 delivers metadata one attribute at a time and re-syncs the position
   * whenever it feels like it. A screen that hides your track at random is worse
   * than one that needs a tap, so this is now a switch you throw.
   */
  const [forceAlternative, setForceAlternative] = useState(false);
  const showAlternative = forceAlternative;

  // A real track change means whatever was playing is over; drop back to music.
  useEffect(() => {
    setForceAlternative(false);
  }, [track?.title, track?.artist]);

  /* ---------------------------------------------------------- ambient tint */

  useEffect(() => {
    if (!artUrl) {
      setGlow(null);
      return;
    }
    let dead = false;
    ambientFrom(artUrl).then(rgb => {
      if (!dead) setGlow(rgb);
    });
    return () => {
      dead = true;
    };
  }, [artUrl]);

  /* --------------------------------------------------------------- actions */

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(t => (t === msg ? null : t)), 1800);
  }, []);

  // With no lyrics provider there is nothing behind the other two views, so
  // Mode stops cycling and the lyrics button disappears rather than leading
  // to a dead screen.
  const cycle = useMemo(
    () => (lyricsAvailable && !foreign ? CYCLE : (['art'] as View[])),
    [lyricsAvailable, foreign],
  );

  const cycleView = useCallback(() => {
    setView(v => cycle[(Math.max(0, cycle.indexOf(v)) + 1) % cycle.length]);
  }, [cycle]);

  const toggleLyrics = useCallback(() => {
    if (!lyricsAvailable) return;
    setView(v => (v === 'art' ? 'split' : 'art'));
  }, [lyricsAvailable]);

  // A provider that loses lyrics mid-session must not strand us on a dead view.
  useEffect(() => {
    if (!lyricsAvailable || foreign) setView('art');
  }, [lyricsAvailable, foreign]);

  /**
   * What a preset should hold, best first.
   *
   * The playlist matters, not the song — a preset that replays one track is a
   * bookmark, not a station. Apple Music over iAP2 often leaves `context` empty,
   * so anything played out of the library browser is remembered as a fallback
   * before we ever consider the bare track.
   */
  const currentAsPreset = useCallback((): Preset | null => {
    const ctx = state?.context;
    if (ctx?.uri) {
      return { uri: ctx.uri, label: ctx.name ?? lastPlayed?.label ?? 'Playing from', sub: null, artworkId: track?.artworkId ?? null };
    }
    if (lastPlayed) return lastPlayed;
    if (track?.uri) {
      return {
        uri: track.uri,
        label: track.title ?? 'Track',
        sub: track.artist ?? null,
        artworkId: track.artworkId ?? null,
      };
    }
    return null;
  }, [state, track, lastPlayed]);

  const playPreset = useCallback(
    (i: number) => {
      const p = presets[i];
      if (!p) {
        flash(`Preset ${i + 1} is empty — hold it to save what's playing`);
        return;
      }
      // Shuffle first, then play: setting it afterwards can land after the
      // gateway has already queued the list in order.
      client.player.setShuffle({ on: true });
      client.player.play({ uri: p.uri, context: null });
      flash(`${p.label} · shuffled`);
    },
    [client, presets, flash],
  );

  const savePreset = useCallback(
    (i: number) => {
      const p = currentAsPreset();
      if (!p) {
        flash('Nothing playing to save');
        return;
      }
      assign(i, p);
      flash(`Saved to ${i + 1} · ${p.label}`);
    },
    [assign, currentAsPreset, flash],
  );

  const playRow = useCallback(
    (row: Row) => {
      if (!row.uri) return;
      // A track started from inside a playlist should keep that playlist as its
      // context, so next/prev walk the list rather than dead-ending.
      const here = lib.crumbs[lib.crumbs.length - 1];
      const contextUri = here?.container && here.uri && here.uri !== row.uri ? here.uri : null;
      client.player.play({ uri: row.uri, context: contextUri ? { contextUri } : null });
      if (contextUri && here) {
        rememberPlayed({ uri: contextUri, label: here.title, sub: null, artworkId: null });
      }
      setDrawer(false);
      flash(row.title);
    },
    [client, lib.crumbs, rememberPlayed, flash],
  );

  /** "Play" / "Shuffle" on an opened playlist or album. */
  const playAll = useCallback(
    (shuffle: boolean) => {
      const here = lib.crumbs[lib.crumbs.length - 1];
      if (!here?.uri) return;
      client.player.setShuffle({ on: shuffle });
      client.player.play({ uri: here.uri, context: null });
      rememberPlayed({ uri: here.uri, label: here.title, sub: null, artworkId: null });
      setDrawer(false);
      flash(shuffle ? `${here.title} · shuffled` : here.title);
    },
    [client, lib.crumbs, rememberPlayed, flash],
  );

  const seekable = state?.playback.setElapsedTimeAvailable !== false;
  const seek = useCallback((ms: number) => client.player.seekTo({ positionMs: Math.round(ms) }), [client]);

  const toggleLike = useCallback(() => {
    if (!track?.uri) return;
    client.library.favoritesToggle({
      item: { uri: track.uri, kind: 'track', persistentId: track.persistentId ?? null },
    });
  }, [client, track]);

  const openApp = useCallback(
    (id: string) => {
      client.webapp.activate({ id });
    },
    [client],
  );

  /* ---------------------------------------------------- physical controls */

  const holdTimer = useRef<number | null>(null);
  const heldFired = useRef(false);

  useEffect(() => {
    const clearHold = () => {
      if (holdTimer.current !== null) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Preset buttons: tap to jump, hold to save what's playing.
      if (['1', '2', '3', '4'].includes(e.key)) {
        if (e.repeat) return;
        const slot = Number(e.key) - 1;
        heldFired.current = false;
        holdTimer.current = window.setTimeout(() => {
          heldFired.current = true;
          holdTimer.current = null;
          savePreset(slot);
        }, HOLD_MS);
        return;
      }

      if (e.key === 'm' || e.key === 'M') {
        if (e.repeat) return;
        if (drawer) setDrawer(false);
        else cycleView();
        return;
      }

      if (e.key === 'Escape') {
        if (e.repeat) return;
        if (assigning) setAssigning(null);
        else if (drawer && lib.crumbs.length > 1 && tab === 'library') lib.back();
        else setDrawer(d => !d);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!['1', '2', '3', '4'].includes(e.key)) return;
      const slot = Number(e.key) - 1;
      const wasHeld = heldFired.current;
      clearHold();
      if (!wasHeld) playPreset(slot);
      heldFired.current = false;
    };

    // The rotary wheel arrives as horizontal scroll.
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaX) return;
      e.preventDefault();
      nudge(e.deltaX > 0 ? 0.04 : -0.04);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('wheel', onWheel);
      clearHold();
    };
  }, [assigning, cycleView, drawer, lib, nudge, playPreset, savePreset, tab]);

  // Keep the volume HUD's fade honest without running a timer all the time.
  useEffect(() => {
    if (!bumped) return;
    const id = window.setTimeout(() => forceTick(n => n + 1), 1700);
    return () => window.clearTimeout(id);
  }, [bumped]);

  /* ------------------------------------------------------------------ view */

  const bg = useMemo(() => ambientCss(glow), [glow]);
  const volumeVisible = bumped > 0 && Date.now() - bumped < 1600;

  const shell = (children: React.ReactNode) => (
    <div
      className="relative h-full w-full overflow-hidden text-white transition-[background-color] duration-700"
      style={{ backgroundColor: bg }}>
      <div
        className="pointer-events-none absolute -left-24 -top-32 h-[520px] w-[520px] rounded-full blur-[120px]"
        style={{ background: ambientGlow(glow, 0.22) }}
      />
      <div className="relative z-10 h-full w-full">{children}</div>
      <VolumeHud level={level} muted={muted} visible={volumeVisible} />
      {toast && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[72px] z-30 flex justify-center">
          <div className="max-w-[560px] truncate rounded-full bg-black/80 px-5 py-2 text-[14px] text-white/85 backdrop-blur">
            {toast}
          </div>
        </div>
      )}
      {drawer && (
        <Overlay
          tab={tab}
          setTab={t => {
            setShowInfo(false);
            setTab(t);
          }}
          glow={glow}
          onClose={() => setDrawer(false)}>
          {showInfo ? (
            <InfoPanel
              conn={conn}
              caps={caps}
              state={state}
              art={art}
              lyricsStatus={lyricsStatus}
              lyricsSource={lyrics?.source ?? null}
              source={source}
              version={VERSION}
              onBack={() => setShowInfo(false)}
            />
          ) : (
            <>
              {tab === 'library' && (
                <LibraryTab
                  lib={lib}
                  section={section}
                  setSection={setSection}
                  glow={glow}
                  thumbs={thumbs}
                  onPlay={playRow}
                  onPlayAll={playAll}
                  onAssign={setAssigning}
                />
              )}
              {tab === 'queue' && (
                <UpNextTab
                  rows={upNext.rows}
                  loading={upNext.loading}
                  error={upNext.error}
                  containerName={playingFromName}
                  currentUri={track?.uri ?? null}
                  currentTitle={track?.title ?? null}
                  shuffle={shuffle}
                  thumbs={thumbs}
                  glow={glow}
                  onPlay={row => {
                    if (!row.uri) return;
                    client.player.play({
                      uri: row.uri,
                      context: playingFrom ? { contextUri: playingFrom } : null,
                    });
                    setDrawer(false);
                    flash(row.title);
                  }}
                />
              )}
              {tab === 'more' && (
                <MoreTab
                  apps={apps.map(a => ({ id: a.id, name: a.name }))}
                  icons={icons}
                  glow={glow}
                  alternative={showAlternative}
                  onToggleAlternative={() => {
                    setForceAlternative(v => !v);
                    setDrawer(false);
                  }}
                  onPickApp={id => {
                    setDrawer(false);
                    openApp(id);
                  }}
                  onShowInfo={() => setShowInfo(true)}
                />
              )}
            </>
          )}
        </Overlay>
      )}
      {assigning && (
        <PresetChooser
          row={assigning}
          presets={presets}
          glow={glow}
          onPick={slot => {
            assign(slot, {
              uri: assigning.uri!,
              label: assigning.title,
              sub: assigning.subtitle,
              artworkId: assigning.artworkId,
            });
            flash(`Saved to ${slot + 1} · ${assigning.title}`);
            setAssigning(null);
          }}
          onCancel={() => setAssigning(null)}
        />
      )}
    </div>
  );

  if (!track) {
    return shell(
      <div className="flex h-full flex-col p-7">
        <div className="min-h-0 flex-1 overflow-hidden rounded-2xl">
          <Placeholder conn={conn} provider={caps?.musicProvider} />
        </div>
      </div>,
    );
  }

  if (showAlternative) {
    return shell(
      <div className="flex h-full flex-col p-7">
        <div className="min-h-0 flex-1">
          <AlternativeMedia
            posMs={posMs}
            durationMs={track.durationMs}
            playing={!!playing}
            glow={glow}
            reason={null}
            seekable={seekable}
            onSeek={seek}
            onPrev={() => client.player.skipPrev({ allowSeeking: true })}
            onToggle={() => (playing ? client.player.pause() : client.player.resume())}
            onNext={() => client.player.skipNext()}
            onDismiss={() => setForceAlternative(false)}
          />
        </div>
      </div>,
    );
  }

  const title = track.title ?? 'Unknown track';
  const artist = track.artist ?? '';
  const context = state?.context?.name ?? null;

  const lyricsPane = (
    <LyricsPane
      lyrics={lyrics}
      status={lyricsAvailable ? lyricsStatus : 'unsupported'}
      posMs={posMs}
      glow={glow}
      scale="split"
    />
  );

  /* One row of utility controls, shared by both views so nothing moves when you
     toggle lyrics. 48px targets — the old 36px ones sat under the wheel. */
  const utilities = (
    <>
      {!foreign && (
        <IconButton
          name="shuffle"
          label={shuffle ? 'Shuffle on' : 'Shuffle off'}
          active={shuffle}
          size={48}
          tint={shuffle ? ambientGlow(glow, 1) : undefined}
          onPress={() => client.player.setShuffle({ on: !shuffle })}
        />
      )}
      {!foreign && (
        <IconButton
          name={repeat === 'one' ? 'repeatOne' : 'repeat'}
          label={`Repeat ${repeat}`}
          active={repeat !== 'off'}
          size={48}
          tint={repeat !== 'off' ? ambientGlow(glow, 1) : undefined}
          onPress={() =>
            client.player.setRepeat({ mode: repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off' })
          }
        />
      )}
      <IconButton
        name="queue"
        label="Show queue"
        size={48}
        onPress={() => {
          setTab('queue');
          setDrawer(true);
        }}
      />
      {lyricsAvailable && !foreign && (
        <IconButton
          name="lyrics"
          label={view === 'split' ? 'Hide lyrics' : 'Show lyrics'}
          active={view === 'split'}
          size={48}
          tint={view === 'split' ? ambientGlow(glow, 1) : undefined}
          onPress={toggleLyrics}
        />
      )}
    </>
  );

  /* ---- artwork + controls ---- */
  if (view === 'art') {
    return shell(
      <div className="flex h-full items-center gap-9 px-8 py-7">
        <Art url={artUrl} size={366} glow={glow} />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
          {(context || foreign) && (
            <div className="flex items-center gap-2">
              {foreign && (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]"
                  style={{ background: ambientGlow(glow, 0.22), color: ambientGlow(glow, 1) }}>
                  {source.label}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
                {context ?? 'playing on your phone'}
              </span>
            </div>
          )}
          <div className={`line-clamp-2 font-bold leading-[1.12] tracking-tight ${titleClass(title)}`}>{title}</div>
          <div className="truncate text-[22px] text-white/55">{artist}</div>
          <div className="mt-1">
            <Progress
              posMs={posMs}
              durationMs={track.durationMs}
              glow={glow}
              seekable={seekable}
              onSeek={seek}
            />
          </div>
          <div className="mt-1 flex items-center gap-4">
            <Transport
              playing={!!playing}
              glow={glow}
              liked={track.liked}
              hideLike={foreign}
              onPrev={() => client.player.skipPrev({ allowSeeking: true })}
              onToggle={() => (playing ? client.player.pause() : client.player.resume())}
              onNext={() => client.player.skipNext()}
              onLike={toggleLike}
            />
          </div>
          {/* Utilities sit low and left. The rotary wheel and the back button own
              the right edge of the bezel, so anything parked there is awkward to
              hit while driving. */}
          <div className="mt-2 flex items-center gap-3">{utilities}</div>
        </div>
      </div>,
    );
  }

  /* ---- artwork + lyrics side by side ---- */
  return shell(
    <div className="flex h-full gap-7 px-8 py-7">
      <div className="flex w-[236px] shrink-0 flex-col gap-3">
        <Art url={artUrl} size={236} glow={glow} />
        <div className="min-w-0">
          <div className="line-clamp-2 text-[18px] font-semibold leading-[1.2]">{title}</div>
          <div className="truncate text-[15px] text-white/50">{artist}</div>
        </div>
        <Progress posMs={posMs} durationMs={track.durationMs} glow={glow} compact seekable={seekable} onSeek={seek} />
        <Transport
          playing={!!playing}
          glow={glow}
          liked={track.liked}
          compact
          hideLike={foreign}
          onPrev={() => client.player.skipPrev({ allowSeeking: true })}
          onToggle={() => (playing ? client.player.pause() : client.player.resume())}
          onNext={() => client.player.skipNext()}
          onLike={toggleLike}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-h-0 min-w-0 flex-1">{lyricsPane}</div>
        <div className="flex shrink-0 items-center justify-start gap-3">{utilities}</div>
      </div>
    </div>,
  );
}
