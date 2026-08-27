import type { Capabilities, PlayerState } from '@bridgething/client';
import { useEffect, useRef, useState } from 'react';
import type { ArtState, LibraryState, Preset, Row, Section } from './lib/bridge';
import { ambientGlow } from './lib/util';

type RGB = [number, number, number] | null;
export type Tab = 'library' | 'queue' | 'more';

/* ------------------------------------------------------------------ pieces */

/** Stable tile colour per title, so rows stay recognisable between visits. */
function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function Tile({ title, kind, src, size = 60 }: { title: string; kind: Row['kind']; src?: string; size?: number }) {
  const h = hueOf(title);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size }}
        className="shrink-0 rounded-xl object-cover"
        draggable={false}
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size, background: `hsl(${h} 42% 30%)` }}
      className="grid shrink-0 place-items-center rounded-xl text-[22px] font-bold text-white/85">
      {kind === 'folder' ? (
        <svg viewBox="0 0 24 24" className="h-7 w-7 opacity-80" fill="currentColor" aria-hidden="true">
          <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />
        </svg>
      ) : (
        (title.trim()[0] ?? '?').toUpperCase()
      )}
    </div>
  );
}

/** Big enough to hit without aiming. Nothing here is under 56px tall. */
function BigButton({
  onPress,
  active,
  glow,
  children,
  wide,
}: {
  onPress: () => void;
  active?: boolean;
  glow?: RGB;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      style={active ? { background: ambientGlow(glow ?? null, 0.95), color: '#000' } : undefined}
      className={`flex h-14 shrink-0 items-center justify-center rounded-2xl text-[19px] transition ${
        wide ? 'flex-1 px-5' : 'px-6'
      } ${active ? 'font-semibold' : 'bg-white/10 text-white/75 active:bg-white/20'}`}>
      {children}
    </button>
  );
}

/** The rotary wheel arrives as horizontal scroll; make it drive a list. */
function useWheelScroll(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaX) return;
      e.preventDefault();
      e.stopPropagation();
      el.scrollTop += e.deltaX * 2.2;
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  }, [ref]);
}

/* ------------------------------------------------------------------ shell */

export function Overlay({
  tab,
  setTab,
  onClose,
  glow,
  children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  onClose: () => void;
  glow: RGB;
  children: React.ReactNode;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'library', label: 'Music' },
    { id: 'queue', label: 'Up next' },
    { id: 'more', label: 'More' },
  ];
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[rgb(12,13,15)]">
      <div className="flex shrink-0 items-center gap-2.5 px-6 pb-3 pt-4">
        {tabs.map(t => (
          <BigButton key={t.id} onPress={() => setTab(t.id)} active={tab === t.id} glow={glow} wide>
            {t.label}
          </BigButton>
        ))}
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to music"
          className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-white/10 text-white/70 transition active:bg-white/20">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden="true">
            <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4Z" />
          </svg>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- library */

export function LibraryTab({
  lib,
  section,
  setSection,
  glow,
  thumbs,
  onPlay,
  onPlayAll,
  onAssign,
}: {
  lib: LibraryState;
  section: Section;
  setSection: (s: Section) => void;
  glow: RGB;
  thumbs: Record<string, string>;
  onPlay: (row: Row) => void;
  onPlayAll: (shuffle: boolean) => void;
  onAssign: (row: Row) => void;
}) {
  const here = lib.crumbs[lib.crumbs.length - 1];
  const scroller = useRef<HTMLDivElement>(null);
  const hold = useRef<number | null>(null);
  const held = useRef(false);
  useWheelScroll(scroller);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [lib.crumbs.length, section]);

  const startHold = (row: Row) => {
    if (!row.container) return;
    held.current = false;
    hold.current = window.setTimeout(() => {
      held.current = true;
      hold.current = null;
      onAssign(row);
    }, 550);
  };
  const endHold = (row: Row) => {
    if (hold.current !== null) {
      window.clearTimeout(hold.current);
      hold.current = null;
    }
    if (!held.current) (row.kind === 'folder' || row.container ? lib.open : onPlay)(row);
    held.current = false;
  };

  const atTop = lib.crumbs.length === 1;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 px-6 pb-3">
        {atTop ? (
          <>
            <BigButton onPress={() => setSection('playlists')} active={section === 'playlists'} glow={glow} wide>
              Playlists
            </BigButton>
            <BigButton onPress={() => setSection('recent')} active={section === 'recent'} glow={glow} wide>
              Recently played
            </BigButton>
          </>
        ) : (
          <>
            <BigButton onPress={lib.back}>‹ Back</BigButton>
            <div className="min-w-0 flex-1 truncate text-[19px] font-medium text-white/85">{here?.title}</div>
            {here?.container && here.uri && (
              <>
                <BigButton onPress={() => onPlayAll(true)}>Shuffle</BigButton>
                <BigButton onPress={() => onPlayAll(false)}>Play</BigButton>
              </>
            )}
          </>
        )}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
        {lib.error ? (
          <div className="grid h-full place-items-center px-10 text-center">
            <div className="flex flex-col items-center gap-4">
              <div className="text-[20px] text-white/65">{lib.error}</div>
              <BigButton onPress={lib.reload}>Try again</BigButton>
            </div>
          </div>
        ) : lib.rows.length === 0 && lib.loading ? (
          <div className="grid h-full place-items-center text-[20px] text-white/35">Loading…</div>
        ) : lib.rows.length === 0 ? (
          <div className="grid h-full place-items-center text-[20px] text-white/35">Nothing here.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {lib.rows.map(row =>
              row.kind === 'header' ? (
                <div
                  key={row.key}
                  className="px-1 pb-1 pt-4 font-mono text-[13px] uppercase tracking-[0.16em] text-white/35 first:pt-0">
                  {row.title}
                </div>
              ) : (
                <button
                  key={row.key}
                  type="button"
                  onPointerDown={() => startHold(row)}
                  onPointerUp={() => endHold(row)}
                  onPointerLeave={() => {
                    if (hold.current !== null) {
                      window.clearTimeout(hold.current);
                      hold.current = null;
                    }
                  }}
                  className="flex items-center gap-4 rounded-2xl bg-white/[0.06] px-4 py-3 text-left transition active:bg-white/16">
                  <Tile title={row.title} kind={row.kind} src={thumbs[row.artworkId ?? '']} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[21px] font-medium text-white/95">{row.title}</div>
                    {row.subtitle && <div className="truncate text-[16px] text-white/45">{row.subtitle}</div>}
                  </div>
                  {row.kind === 'folder' && <span className="pr-2 text-[26px] text-white/25">›</span>}
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- preset pick */

export function PresetChooser({
  row,
  presets,
  glow,
  onPick,
  onCancel,
}: {
  row: Row;
  presets: (Preset | null)[];
  glow: RGB;
  onPick: (slot: number) => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/85 px-10">
      <div className="w-full max-w-[620px] rounded-3xl bg-[rgb(24,25,29)] p-7">
        <div className="font-mono text-[13px] uppercase tracking-[0.16em] text-white/40">Save to preset</div>
        <div className="mt-2 truncate text-[26px] font-semibold">{row.title}</div>
        <div className="mt-6 flex gap-3">
          {[0, 1, 2, 3].map(i => (
            <button
              key={i}
              type="button"
              onClick={() => onPick(i)}
              className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-2xl bg-white/10 py-4 transition active:bg-white/20">
              <span className="font-mono text-[24px] font-bold" style={{ color: ambientGlow(glow, 1) }}>
                {i + 1}
              </span>
              <span className="w-full truncate px-2 text-center text-[13px] text-white/45">
                {presets[i]?.label ?? 'empty'}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="mt-5 h-14 w-full rounded-2xl bg-white/8 text-[19px] text-white/60 active:bg-white/16">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- up next */

export function UpNextTab({
  rows,
  loading,
  error,
  containerName,
  currentUri,
  currentTitle,
  shuffle,
  thumbs,
  glow,
  onPlay,
}: {
  rows: Row[];
  loading: boolean;
  error: string | null;
  containerName: string | null;
  currentUri: string | null;
  currentTitle: string | null;
  shuffle: boolean;
  thumbs: Record<string, string>;
  glow: RGB;
  onPlay: (row: Row) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useWheelScroll(scroller);

  const currentIndex = rows.findIndex(
    r =>
      (!!currentUri && r.uri === currentUri) ||
      (!!currentTitle && r.title.toLowerCase() === currentTitle.toLowerCase()),
  );

  // Start the list at what is playing, so the row under it really is next.
  const ordered = currentIndex >= 0 ? [...rows.slice(currentIndex), ...rows.slice(0, currentIndex)] : rows;

  return (
    <>
      <div className="flex shrink-0 items-baseline gap-3 px-6 pb-3">
        <div className="min-w-0 flex-1 truncate text-[19px] text-white/70">
          {containerName ? containerName : 'Nothing is playing from a playlist'}
        </div>
        {shuffle && (
          <span className="shrink-0 font-mono text-[13px] uppercase tracking-[0.14em] text-white/35">shuffled</span>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
        {error ? (
          <div className="grid h-full place-items-center text-[20px] text-white/40">{error}</div>
        ) : loading && rows.length === 0 ? (
          <div className="grid h-full place-items-center text-[20px] text-white/35">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="grid h-full place-items-center px-12 text-center text-[18px] leading-relaxed text-white/35">
            Start a playlist and its tracks show up here.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {ordered.map((row, i) => {
              const isCurrent = currentIndex >= 0 && i === 0;
              // With shuffle on the gateway picks its own order, so claiming to
              // know what is next would be a lie.
              const isNext = currentIndex >= 0 && i === 1 && !shuffle;
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => onPlay(row)}
                  style={isCurrent ? { background: ambientGlow(glow, 0.2) } : undefined}
                  className={`flex items-center gap-4 rounded-2xl px-4 py-3 text-left transition ${
                    isCurrent ? '' : 'bg-white/[0.06] active:bg-white/16'
                  }`}>
                  <Tile title={row.title} kind={row.kind} src={thumbs[row.artworkId ?? '']} />
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-[21px] ${isCurrent ? 'font-semibold text-white' : 'font-medium text-white/90'}`}>
                      {row.title}
                    </div>
                    {row.subtitle && <div className="truncate text-[16px] text-white/45">{row.subtitle}</div>}
                  </div>
                  {(isCurrent || isNext) && (
                    <span
                      className="shrink-0 rounded-lg px-3 py-1.5 font-mono text-[12px] uppercase tracking-[0.14em]"
                      style={
                        isCurrent
                          ? { color: ambientGlow(glow, 1) }
                          : { background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)' }
                      }>
                      {isCurrent ? 'playing' : 'next'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------- more */

export function MoreTab({
  apps,
  icons,
  glow,
  alternative,
  onToggleAlternative,
  onPickApp,
  onShowInfo,
}: {
  apps: { id: string; name: string }[];
  icons: Record<string, string>;
  glow: RGB;
  alternative: boolean;
  onToggleAlternative: () => void;
  onPickApp: (id: string) => void;
  onShowInfo: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useWheelScroll(scroller);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          onClick={onToggleAlternative}
          style={alternative ? { background: ambientGlow(glow, 0.95), color: '#000' } : undefined}
          className={`flex h-16 items-center gap-4 rounded-2xl px-5 text-left text-[20px] transition ${
            alternative ? 'font-semibold' : 'bg-white/[0.08] text-white/85 active:bg-white/16'
          }`}>
          <svg viewBox="0 0 24 24" className="h-7 w-7 shrink-0" fill="currentColor" aria-hidden="true">
            <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm6 2.8v5.4l4.5-2.7L10 7.8ZM7 19h10v2H7v-2Z" />
          </svg>
          {alternative ? 'Back to track info' : 'Something else is playing'}
        </button>

        <button
          type="button"
          onClick={onShowInfo}
          className="flex h-16 items-center gap-4 rounded-2xl bg-white/[0.08] px-5 text-left text-[20px] text-white/85 transition active:bg-white/16">
          <svg viewBox="0 0 24 24" className="h-7 w-7 shrink-0" fill="currentColor" aria-hidden="true">
            <path d="M11 7h2v2h-2V7Zm0 4h2v6h-2v-6Zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" />
          </svg>
          Diagnostics
        </button>

        {apps.length > 0 && (
          <>
            <div className="px-1 pb-1 pt-4 font-mono text-[13px] uppercase tracking-[0.16em] text-white/35">
              Other apps
            </div>
            {apps.map(app => (
              <button
                key={app.id}
                type="button"
                onClick={() => onPickApp(app.id)}
                className="flex h-16 items-center gap-4 rounded-2xl bg-white/[0.06] px-4 text-left transition active:bg-white/16">
                {icons[app.id] ? (
                  <img src={icons[app.id]} alt="" className="h-11 w-11 rounded-xl object-cover" />
                ) : (
                  <div
                    className="grid h-11 w-11 place-items-center rounded-xl text-[18px] font-bold text-black"
                    style={{ background: ambientGlow(glow, 0.85) }}>
                    {app.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span className="truncate text-[20px] text-white/85">{app.name}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- info */

/** Which fetch path an asset id takes — the two fail for different reasons. */
function laneOf(id: string | null): string {
  if (!id) return 'none (no artwork id)';
  if (id.startsWith('iap2/art/')) return 'iap2 — phone pushes it, cannot be pulled';
  if (id.startsWith('system-art:')) return 'system media — pushed by whichever app is playing';
  if (id.startsWith('applemusic/img/')) return 'apple music — url encoded in the id, fetchable directly';
  return 'companion — the phone fetches the image over the internet';
}

function Field({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex gap-3 border-b border-white/6 py-2 last:border-b-0">
      <div className="w-[168px] shrink-0 font-mono text-[12px] uppercase tracking-[0.1em] text-white/35">{label}</div>
      <div className={`min-w-0 flex-1 break-all font-mono text-[13px] ${warn ? 'text-amber-300' : 'text-white/75'}`}>
        {value}
      </div>
    </div>
  );
}

export function InfoPanel({
  conn,
  caps,
  state,
  art,
  lyricsStatus,
  lyricsSource,
  source,
  version,
  onBack,
}: {
  conn: string;
  caps: Capabilities | null;
  state: PlayerState | null;
  art: {
    state: ArtState;
    attempts: number;
    url: string | null;
    error: string | null;
    tier: 'gateway' | 'direct' | 'catalog' | null;
    retry: () => void;
  };
  lyricsStatus: string;
  lyricsSource: string | null;
  source: { kind: string; bundle: string | null; label: string };
  version: string;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useWheelScroll(scroller);
  const track = state?.track ?? null;

  const dump = {
    version,
    conn,
    provider: caps?.musicProvider ?? null,
    gateway: caps?.gateway?.name ?? null,
    lyricsCap: caps?.available.lyrics ?? null,
    lyricsStatus,
    lyricsSource,
    trackUri: track?.uri ?? null,
    trackPersistentId: track?.persistentId ?? null,
    artworkId: track?.artworkId ?? null,
    artLane: laneOf(track?.artworkId ?? null),
    artState: art.state,
    artTier: art.tier,
    artAttempts: art.attempts,
    artError: art.error,
    contextUri: state?.context?.uri ?? null,
    setElapsedTimeAvailable: state?.playback.setElapsedTimeAvailable ?? null,
    queueListAvail: state?.playback.queueListAvail ?? null,
    audibleSource: source,
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 px-6 pb-3">
        <BigButton onPress={onBack}>‹ Back</BigButton>
        <div className="text-[19px] font-medium text-white/80">Diagnostics</div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
        <Field label="cassette" value={version} />
        <Field label="daemon link" value={conn} warn={conn !== 'open'} />
        <Field label="music provider" value={caps?.musicProvider ?? 'unknown'} warn={caps?.musicProvider !== 'appleMusic'} />
        <Field label="gateway" value={caps?.gateway?.name ?? 'none — no phone connected'} warn={!caps?.gateway} />
        <Field label="lyrics status" value={lyricsStatus} />
        <Field label="lyrics source" value={lyricsSource ?? 'none yet'} />
        <Field label="track uri" value={track?.uri ?? 'null'} warn={!track?.uri} />
        <Field label="artwork id" value={track?.artworkId ?? 'null — the phone is not sending one'} warn={!track?.artworkId} />
        <Field label="artwork lane" value={laneOf(track?.artworkId ?? null)} />
        <Field
          label="artwork came from"
          value={
            art.tier === 'gateway'
              ? 'the gateway asset lane'
              : art.tier === 'direct'
                ? 'apple, fetched directly'
                : art.tier === 'catalog'
                  ? 'apple catalog lookup'
                  : 'nothing yet'
          }
          warn={art.tier === null}
        />
        {art.error && <Field label="artwork note" value={art.error} warn={art.state === 'missing'} />}
        <Field
          label="seek allowed"
          value={String(state?.playback.setElapsedTimeAvailable ?? 'not reported')}
          warn={state?.playback.setElapsedTimeAvailable === false}
        />
        <Field
          label="queue readable"
          value={String(state?.playback.queueListAvail ?? 'not reported')}
          warn={state?.playback.queueListAvail !== true}
        />
        <Field
          label="context uri"
          value={state?.context?.uri ?? 'null — presets fall back to what you last started here'}
          warn={!state?.context?.uri}
        />

        <div className="mt-4 flex gap-2.5">
          <BigButton onPress={art.retry} wide>
            Retry artwork
          </BigButton>
          <BigButton
            onPress={() => {
              try {
                navigator.clipboard?.writeText(JSON.stringify(dump, null, 2));
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              } catch {
                setCopied(false);
              }
            }}
            wide>
            {copied ? 'Copied' : 'Copy as JSON'}
          </BigButton>
        </div>
      </div>
    </>
  );
}
