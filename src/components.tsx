import type { LyricLine, Lyrics, PlayerState } from '@bridgething/client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Preset } from './lib/bridge';
import type { LyricsStatus } from './lib/bridge';
import { activeLine, ambientGlow, clamp, fmtTime } from './lib/util';

type RGB = [number, number, number] | null;

/* ------------------------------------------------------------------ artwork */

export function Art({ url, size, glow }: { url: string | null; size: number; glow: RGB }) {
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-2xl bg-white/5"
      style={{
        width: size,
        height: size,
        boxShadow: `0 24px 60px -12px ${ambientGlow(glow, 0.55)}, 0 0 0 1px rgba(255,255,255,0.07) inset`,
      }}>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <svg viewBox="0 0 24 24" className="h-1/3 w-1/3 text-white/12" fill="currentColor" aria-hidden="true">
            <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z" />
          </svg>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- progress */

export function Progress({
  posMs,
  durationMs,
  glow,
  compact,
  seekable,
  onSeek,
}: {
  posMs: number;
  durationMs: number | null;
  glow: RGB;
  compact?: boolean;
  /** Gateways that refuse absolute seeks report this false; do not offer a thumb. */
  seekable?: boolean;
  onSeek?: (ms: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  const live = durationMs != null && durationMs > 0;
  // Do not gate on the gateway's capability flag. iAP2 often omits it, and a
  // refused seek is a no-op — whereas hiding the control makes a working feature
  // look broken. `seekable` only dims the affordance.
  const canSeek = !!onSeek && live;

  // After a seek the daemon takes a moment to report the new position; hold the
  // requested value until reality catches up, or the bar snaps backwards.
  useEffect(() => {
    if (pending === null) return;
    if (Math.abs(posMs - pending) < 1_500) {
      setPending(null);
      return;
    }
    const id = window.setTimeout(() => setPending(null), 2_500);
    return () => window.clearTimeout(id);
  }, [posMs, pending]);

  const shown = dragMs ?? pending ?? posMs;
  const pct = live ? clamp((shown / durationMs) * 100, 0, 100) : 0;

  const msAt = (clientX: number) => {
    const el = bar.current;
    if (!el || !live) return 0;
    const r = el.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * durationMs;
  };

  const commit = (ms: number) => {
    const target = Math.round(ms);
    setDragMs(null);
    setPending(target);
    onSeek?.(target);
  };

  const down = (e: React.PointerEvent) => {
    if (!canSeek) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; dragging still works without it */
    }
    setDragMs(msAt(e.clientX));
  };
  const move = (e: React.PointerEvent) => {
    if (dragMs === null) return;
    setDragMs(msAt(e.clientX));
  };
  const up = () => {
    if (dragMs === null) return;
    commit(dragMs);
  };

  // Belt and braces for the device's kiosk build: if pointer events never
  // arrive, touch events still land, and a plain tap still seeks.
  const touchStart = (e: React.TouchEvent) => {
    if (!canSeek) return;
    const t = e.touches[0];
    if (t) setDragMs(msAt(t.clientX));
  };
  const touchMove = (e: React.TouchEvent) => {
    if (dragMs === null) return;
    const t = e.touches[0];
    if (t) setDragMs(msAt(t.clientX));
  };
  const touchEnd = () => {
    if (dragMs === null) return;
    commit(dragMs);
  };
  const click = (e: React.MouseEvent) => {
    if (!canSeek || dragMs !== null) return;
    commit(msAt(e.clientX));
  };

  const scrubbing = dragMs !== null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {/* A 6px bar is untouchable in a moving car; the hit area is 34px tall. */}
      <div
        className={canSeek ? 'group -my-4 cursor-pointer py-4 touch-none' : ''}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onTouchStart={touchStart}
        onTouchMove={touchMove}
        onTouchEnd={touchEnd}
        onClick={click}>
        <div
          ref={bar}
          className={`relative w-full rounded-full bg-white/14 transition-[height] ${
            scrubbing ? 'h-2.5' : compact ? 'h-1.5' : 'h-2'
          }`}>
          <div
            className={`h-full rounded-full ${scrubbing ? '' : 'transition-[width] duration-100 ease-linear'}`}
            style={{ width: `${pct}%`, background: ambientGlow(glow, 0.95) }}
          />
          {canSeek && (
            <div
              className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-lg transition-all ${
                scrubbing ? 'h-5 w-5' : seekable === false ? 'h-3 w-3 opacity-40' : 'h-3.5 w-3.5 opacity-85'
              }`}
              style={{ left: `${pct}%` }}
            />
          )}
        </div>
      </div>
      {!compact && (
        <div className="flex justify-between font-mono text-[13px] tabular-nums text-white/45">
          <span className={scrubbing ? 'text-white' : undefined}>{fmtTime(shown)}</span>
          <span>{live ? `-${fmtTime(durationMs - shown)}` : '--:--'}</span>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- transport */

function Icon({
  name,
  className = '',
  style,
}: {
  name: 'prev' | 'next' | 'play' | 'pause' | 'heart' | 'lyrics' | 'grid' | 'shuffle' | 'repeat' | 'repeatOne' | 'queue';
  className?: string;
  style?: React.CSSProperties;
}) {
  const paths: Record<string, React.ReactElement> = {
    prev: <path d="M7 6v12H5V6h2Zm12 0v12l-9-6 9-6Z" />,
    next: <path d="M17 6v12h2V6h-2ZM5 6v12l9-6-9-6Z" />,
    play: <path d="M8 5v14l11-7L8 5Z" />,
    pause: <path d="M7 5h3.5v14H7V5Zm6.5 0H17v14h-3.5V5Z" />,
    heart: <path d="M12 20.5 3.8 12.6a5 5 0 0 1 7.1-7l1.1 1.1 1.1-1.1a5 5 0 1 1 7.1 7L12 20.5Z" />,
    shuffle: <path d="M17 3l4 4-4 4V8.5h-2.2l-2.4 3.5 2.4 3.5H17V13l4 4-4 4v-3h-3.3l-3-4.4L7.6 18H3v-3h3l3-4.4L6 6.2H3V3h4.6l3.1 4.6 3-4.6H17V3Z" />,
    repeat: <path d="M7 7h9V4l5 4.5L16 13v-3H9v4H6V8a1 1 0 0 1 1-1Zm10 10H8v3l-5-4.5L8 11v3h7v-4h3v6a1 1 0 0 1-1 1Z" />,
    repeatOne: (
      <>
        <path d="M7 7h9V4l5 4.5L16 13v-3H9v4H6V8a1 1 0 0 1 1-1Zm10 10H8v3l-5-4.5L8 11v3h7v-4h3v6a1 1 0 0 1-1 1Z" />
        <path d="M11.4 9.2h1.3v5.6h-1.3v-4.3l-1.1.4v-1.1l2-.6h-.9Z" />
      </>
    ),
    lyrics: <path d="M4 5h16v2H4V5Zm0 4h11v2H4V9Zm0 4h16v2H4v-2Zm0 4h9v2H4v-2Z" />,
    grid: <path d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z" />,
    queue: <path d="M3 6h13v2H3V6Zm0 5h13v2H3v-2Zm0 5h9v2H3v-2Zm15-9.5 4 3.5-4 3.5V13h-1V9h1V6.5Z" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className} style={style}>
      {paths[name]}
    </svg>
  );
}

function TButton({
  onPress,
  label,
  children,
  primary,
  glow,
  active,
  size = 56,
}: {
  onPress: () => void;
  label: string;
  children: React.ReactNode;
  primary?: boolean;
  glow?: RGB;
  active?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      style={
        primary
          ? { width: size + 16, height: size + 16, background: ambientGlow(glow ?? null, 1) }
          : { width: size, height: size }
      }
      className={[
        'grid shrink-0 place-items-center rounded-full transition',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60',
        primary
          ? 'text-black active:scale-95'
          : active
            ? 'bg-white/22 text-white active:scale-95'
            : 'bg-white/10 text-white/80 active:scale-95 active:bg-white/20',
      ].join(' ')}>
      {children}
    </button>
  );
}

export function Transport({
  playing,
  glow,
  liked,
  compact,
  hideLike,
  onPrev,
  onToggle,
  onNext,
  onLike,
}: {
  playing: boolean;
  glow: RGB;
  liked: boolean | null;
  compact?: boolean;
  /** A video or podcast has no favourite; hide it rather than showing a dead control. */
  hideLike?: boolean;
  onPrev: () => void;
  onToggle: () => void;
  onNext: () => void;
  onLike: () => void;
}) {
  const s = compact ? 44 : 56;
  return (
    <div className="flex items-center gap-4">
      <TButton onPress={onPrev} label="Previous track" size={s}>
        <Icon name="prev" className="h-1/2 w-1/2" />
      </TButton>
      <TButton onPress={onToggle} label={playing ? 'Pause' : 'Play'} primary glow={glow} size={s}>
        <Icon name={playing ? 'pause' : 'play'} className="h-1/2 w-1/2" />
      </TButton>
      <TButton onPress={onNext} label="Next track" size={s}>
        <Icon name="next" className="h-1/2 w-1/2" />
      </TButton>
      {!hideLike && (
        <TButton onPress={onLike} label={liked ? 'Remove from favourites' : 'Add to favourites'} active={!!liked} size={s}>
          <Icon name="heart" className={liked ? 'h-[45%] w-[45%] text-rose-400' : 'h-[45%] w-[45%]'} />
        </TButton>
      )}
    </div>
  );
}

export function IconButton({
  name,
  label,
  onPress,
  active,
  size = 44,
  tint,
}: {
  name: 'lyrics' | 'grid' | 'shuffle' | 'repeat' | 'repeatOne' | 'queue';
  label: string;
  onPress: () => void;
  active?: boolean;
  size?: number;
  tint?: string;
}) {
  return (
    <TButton onPress={onPress} label={label} active={active} size={size}>
      <Icon name={name} className="h-[42%] w-[42%]" style={tint ? { color: tint } : undefined} />
    </TButton>
  );
}

/* ------------------------------------------------------------------ lyrics */

export function LyricsPane({
  lyrics,
  status,
  posMs,
  glow,
  scale,
}: {
  lyrics: Lyrics | null;
  status: LyricsStatus;
  posMs: number;
  glow: RGB;
  scale: 'split' | 'full';
}) {
  const box = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLParagraphElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  const synced: LyricLine[] | null = lyrics?.synced?.length ? lyrics.synced : null;
  const idx = synced ? activeLine(synced, posMs) : -1;

  useLayoutEffect(() => {
    const el = active.current;
    const container = box.current;
    const track = inner.current;
    if (!container || !track) return;
    if (!el) {
      track.style.transform = 'translateY(0px)';
      return;
    }
    const y = container.clientHeight / 2 - el.offsetTop - el.offsetHeight / 2;
    track.style.transform = `translateY(${y}px)`;
  }, [idx, synced, scale]);

  if (status === 'loading') return <LyricsMessage text="Looking for lyrics…" />;
  if (status === 'unsupported') return <LyricsMessage text="This provider doesn't supply lyrics." />;
  if (status === 'none' || !lyrics) return <LyricsMessage text="No lyrics for this track." />;

  if (!synced) {
    return (
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        <div className="whitespace-pre-wrap text-[26px] leading-[1.45] text-white/70">
          {lyrics.plain}
        </div>
        <Attribution source={lyrics.source} />
      </div>
    );
  }

  return (
    <div
      ref={box}
      className="relative min-h-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_22%,black_78%,transparent)]">
      <div ref={inner} className="transition-transform duration-500 ease-out will-change-transform">
        {synced.map((line, i) => {
          const isActive = i === idx;
          const dist = Math.abs(i - idx);
          return (
            <p
              key={`${line.startMs}-${i}`}
              ref={isActive ? active : undefined}
              style={isActive ? { color: ambientGlow(glow, 1) } : undefined}
              className={[
                // Big enough to read in a glance from the driver's seat. Only
                // the line you are on and its immediate neighbours are legible;
                // everything else fades out so there is nothing to scan.
                'px-1 py-3 text-[38px] leading-[1.18] font-semibold tracking-tight transition-all duration-300',
                isActive
                  ? 'opacity-100'
                  : dist === 1
                    ? 'text-white/40'
                    : 'text-white/12',
              ].join(' ')}>
              {line.text || '♪'}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function LyricsMessage({ text }: { text: string }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-[17px] text-white/35">
      <span>{text}</span>
    </div>
  );
}

/**
 * Long titles are the norm, not the exception. Step the size down before
 * allowing a second line, so a two-line title never crowds the transport.
 */
export function titleClass(title: string): string {
  if (title.length > 42) return 'text-[24px]';
  if (title.length > 30) return 'text-[28px]';
  if (title.length > 20) return 'text-[33px]';
  return 'text-[38px]';
}

function Attribution({ source }: { source: string }) {
  return <div className="pt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-white/22">via {source}</div>;
}

/* ----------------------------------------------------------------- presets */

export function PresetBar({
  presets,
  arming,
  onTap,
  glow,
}: {
  presets: (Preset | null)[];
  arming: number | null;
  onTap: (i: number) => void;
  glow: RGB;
}) {
  return (
    <div className="flex w-full gap-2">
      {presets.map((p, i) => {
        const armed = arming === i;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onTap(i)}
            style={armed ? { background: ambientGlow(glow, 0.9), color: '#000' } : undefined}
            className={[
              'flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left transition',
              armed ? '' : p ? 'bg-white/10 active:bg-white/18' : 'bg-white/[0.045]',
            ].join(' ')}>
            <span
              className={`font-mono text-[12px] tabular-nums ${armed ? 'text-black/60' : p ? 'text-white/45' : 'text-white/25'}`}>
              {i + 1}
            </span>
            <span
              className={`truncate text-[13.5px] ${armed ? 'font-semibold text-black' : p ? 'text-white/85' : 'text-white/25'}`}>
              {armed ? 'hold to save…' : (p?.label ?? 'empty')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------- misc */

export function VolumeHud({ level, muted, visible }: { level: number; muted: boolean; visible: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-5 z-30 flex justify-center transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}>
      <div className="flex items-center gap-3 rounded-full bg-black/75 px-5 py-2.5 backdrop-blur">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-white/70" aria-hidden="true">
          {muted ? (
            <path d="M4 9h4l5-4v14l-5-4H4V9Zm12.5 1.1 1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1Z" />
          ) : (
            <path d="M4 9h4l5-4v14l-5-4H4V9Zm12.5-2.4A7 7 0 0 1 16.5 17.4l-1.1-1.7a5 5 0 0 0 0-7.4l1.1-1.7Z" />
          )}
        </svg>
        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-white/20">
          <div className="h-full rounded-full bg-white transition-[width] duration-100" style={{ width: `${(muted ? 0 : level) * 100}%` }} />
        </div>
        <span className="w-9 text-right font-mono text-[12px] tabular-nums text-white/60">
          {Math.round((muted ? 0 : level) * 100)}
        </span>
      </div>
    </div>
  );
}

export function Marquee({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`truncate ${className ?? ''}`} title={text}>
      {text}
    </div>
  );
}

export function Placeholder({ conn, provider }: { conn: string; provider: string | undefined }) {
  const waiting = conn !== 'open';
  return (
    <div className="grid h-full w-full place-items-center bg-[rgb(11,12,14)] px-16 text-center">
      <div className="flex flex-col items-center gap-4">
        <svg viewBox="0 0 24 24" className="h-12 w-12 text-white/15" fill="currentColor" aria-hidden="true">
          <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z" />
        </svg>
        <div className="text-[24px] font-semibold text-white/80">
          {waiting ? 'Reconnecting to the device' : 'Nothing playing'}
        </div>
        <div className="max-w-md text-[15px] leading-relaxed text-white/40">
          {waiting
            ? 'Waiting for the daemon.'
            : provider === 'none'
              ? 'Connect your phone and sign in, then start a track from anywhere — this screen follows it.'
              : 'Start a track from your phone, or press a preset below.'}
        </div>
      </div>
    </div>
  );
}

export function nowPlayingLine(state: PlayerState | null): string | null {
  const ctx = state?.context;
  if (!ctx) return null;
  return ctx.name ?? null;
}

/* ------------------------------------------------------- alternative media */

/**
 * Shown when the audio does not match the metadata — a video or another app has
 * taken over the phone. Transport still works (it drives whatever holds the
 * session), so this is a usable screen, not just a warning.
 */
export function AlternativeMedia({
  posMs,
  durationMs,
  playing,
  glow,
  reason,
  seekable,
  onSeek,
  onPrev,
  onToggle,
  onNext,
  onDismiss,
}: {
  posMs: number;
  durationMs: number | null;
  playing: boolean;
  glow: RGB;
  reason: string | null;
  seekable?: boolean;
  onSeek?: (ms: number) => void;
  onPrev: () => void;
  onToggle: () => void;
  onNext: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-16">
      <div className="flex flex-col items-center gap-2.5">
        <svg viewBox="0 0 24 24" className="h-11 w-11" fill="currentColor" style={{ color: ambientGlow(glow, 0.9) }} aria-hidden="true">
          <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm6 2.8v5.4l4.5-2.7L10 7.8ZM7 19h10v2H7v-2Z" />
        </svg>
        <div className="text-[30px] font-bold tracking-tight">Alternative media playing</div>
        <div className="max-w-[62ch] text-center text-[15px] leading-relaxed text-white/45">
          Something other than your music library has the phone's audio. Titles and artwork belong to the
          last track, so they are hidden{reason ? ` — ${reason}` : ''}.
        </div>
      </div>

      <div className="w-full max-w-[560px]">
        <Progress posMs={posMs} durationMs={durationMs} glow={glow} seekable={seekable} onSeek={onSeek} />
      </div>

      <Transport
        playing={playing}
        glow={glow}
        liked={null}
        hideLike
        onPrev={onPrev}
        onToggle={onToggle}
        onNext={onNext}
        onLike={() => {}}
      />

      <button
        type="button"
        onClick={onDismiss}
        className="rounded-full bg-white/8 px-5 py-2 text-[13.5px] text-white/55 transition active:bg-white/16">
        Show the music screen anyway
      </button>
    </div>
  );
}
