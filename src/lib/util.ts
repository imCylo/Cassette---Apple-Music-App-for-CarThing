/** mm:ss for a duration in ms. Negative and NaN clamp to 0. */
export function fmtTime(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Pull an ambient colour out of the artwork so the screen takes on the record's
 * character instead of sitting on flat black. Samples a small grid, buckets by
 * hue, and prefers colour that is actually saturated — album art is mostly dark
 * or mostly grey often enough that a plain average comes out mud.
 */
export function ambientFrom(url: string): Promise<[number, number, number] | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const N = 40;
        const canvas = document.createElement('canvas');
        canvas.width = N;
        canvas.height = N;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, N, N);
        const { data } = ctx.getImageData(0, 0, N, N);

        const buckets = new Map<number, { r: number; g: number; b: number; w: number }>();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

          // Ignore near-black and blown-out pixels; they carry no character.
          if (lum < 0.08 || lum > 0.97) continue;

          // Saturated mid-tones win. Weight rewards both, gently.
          const weight = (0.25 + sat) * (1 - Math.abs(lum - 0.5));
          const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
          const cur = buckets.get(key) ?? { r: 0, g: 0, b: 0, w: 0 };
          cur.r += r * weight;
          cur.g += g * weight;
          cur.b += b * weight;
          cur.w += weight;
          buckets.set(key, cur);
        }

        let best: { r: number; g: number; b: number; w: number } | null = null;
        for (const v of buckets.values()) if (!best || v.w > best.w) best = v;
        if (!best || best.w === 0) return resolve(null);

        resolve([
          Math.round(best.r / best.w),
          Math.round(best.g / best.w),
          Math.round(best.b / best.w),
        ]);
      } catch {
        resolve(null);
      }
    };
    img.src = url;
  });
}

/** Sit the ambient colour at a fixed, readable darkness whatever the art. */
export function ambientCss(rgb: [number, number, number] | null): string {
  if (!rgb) return 'rgb(11 12 14)';
  const [r, g, b] = rgb;
  const mix = (c: number) => Math.round(c * 0.34 + 8);
  return `rgb(${mix(r)} ${mix(g)} ${mix(b)})`;
}

export function ambientGlow(rgb: [number, number, number] | null, alpha: number): string {
  if (!rgb) return `rgba(120,130,145,${alpha})`;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** Index of the lyric line that should be lit at `posMs`, or -1 before the first. */
export function activeLine(lines: { startMs: number }[], posMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= posMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/* ---------------------------------------------------------------- sources */

export type Source = {
  /** 'appleMusic' when the library provider is driving, otherwise the phone's system media. */
  kind: 'appleMusic' | 'system' | 'unknown';
  /** Bundle id of the app that owns playback, when it is a system-media session. */
  bundle: string | null;
  /** Something a person recognises. */
  label: string;
};

const BUNDLE_NAMES: Record<string, string> = {
  'com.google.ios.youtube': 'YouTube',
  'com.google.ios.youtubemusic': 'YouTube Music',
  'com.apple.Music': 'Apple Music',
  'com.apple.podcasts': 'Podcasts',
  'com.apple.mobilesafari': 'Safari',
  'com.apple.tv': 'Apple TV',
  'com.spotify.client': 'Spotify',
  'com.audible.iphone': 'Audible',
  'tv.twitch': 'Twitch',
  'com.netflix.Netflix': 'Netflix',
  'com.overcast.ios': 'Overcast',
  'fm.pocketcasts': 'Pocket Casts',
  'com.soundcloud.TouchApp': 'SoundCloud',
  'com.bandcamp.bandcamp': 'Bandcamp',
  'com.vlc.vlc-ios': 'VLC',
};

/** Turn `com.google.ios.youtube` into something readable when we don't know it. */
function prettifyBundle(bundle: string): string {
  const tail = bundle.split('.').filter(p => p && !/^(com|net|org|io|app|ios|iphone|mobile|tv|fm)$/i.test(p)).pop();
  if (!tail) return bundle;
  return tail
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Which app is actually making sound.
 *
 * The daemon does not put this on the wire directly — `capabilities.musicProvider`
 * reports the *library* provider and stays `appleMusic` even while something else
 * plays. But the system-media provider builds its uris as `system:<bundle>:<hash>`
 * and its art ids as `system-art:<token>`, so the now-playing item names its own
 * owner.
 */
export function sourceOf(uri: string | null | undefined, artworkId: string | null | undefined): Source {
  if (uri?.startsWith('system:') || artworkId?.startsWith('system-art:')) {
    const bundle = uri?.startsWith('system:') ? (uri.split(':')[1] ?? null) : null;
    const label = bundle ? (BUNDLE_NAMES[bundle] ?? prettifyBundle(bundle)) : 'your phone';
    return { kind: 'system', bundle, label };
  }
  if (uri?.startsWith('am:') || artworkId?.startsWith('applemusic/img/')) {
    return { kind: 'appleMusic', bundle: null, label: 'Apple Music' };
  }
  return { kind: 'unknown', bundle: null, label: 'your phone' };
}
