# BridgeThing findings

Things found while building Cassette against BridgeThing `0.11.0+image.0.2.1`,
with an iPhone (iOS 27 beta) signed into Apple Music. Each one is a place where a
webapp cannot do something, or where the data it receives is not what it looks
like.

**All of this is from one device and one account.** Some of it is read off the
BridgeThing source rather than confirmed on hardware, and it may well be a
misconfiguration on my end rather than a bug. Corrections welcome — file an issue
here or point me at the right thread.

Source paths below refer to
[JoeyEamigh/bridgething](https://github.com/JoeyEamigh/bridgething) unless noted.

---

## 1. Apple Music artwork frequently never resolves

**Symptom.** `track.artworkId` is present, but `asset.get` returns `notFound`
indefinitely. The screen stays grey for the whole song.

**The tell that isolated it.** Starting a YouTube video makes the *correct*
artwork appear — for the Apple Music song, with the song's own metadata still on
screen. Closing YouTube makes it vanish again. So one artwork path works and
another does not, on the same device, seconds apart.

**Reading.** There are two lanes. iAP2 art is pushed by the phone and cannot be
pulled — `crates/core/src/handler/client/asset.rs`:

```rust
async fn fetch_iap2_art(state: &State, id: &str) -> FetchOutcome {
  if !state.iap2_pending_art.is_pending(id).await {
    return FetchOutcome::NotFound;   // immediately
  }
  // ... otherwise wait up to ASSET_WAIT_TIMEOUT (5s) for the push
}
```

Apple Music art is different: `crates/companion/src/provider/apple_music.rs`
builds ids from an artwork URL template via `IMAGE_CODEC.asset_id(...)`, which
the phone is then asked to fetch and downscale. That is the lane that appears to
fail.

**Two things a webapp can do.** A `notFound` on a first call is normal, not
final — subscribe to `asset.onReady` and re-`get`, because that is the only
signal the push has landed. And Apple Music ids are reversible:

```
applemusic/img/<edge>/u<percent-encoded https://…mzstatic.com/…>
```

Namespace `applemusic/img/`, no short form, so the tag is always `u`. Decoding it
and fetching the URL through `net.fetch` bypasses the lane entirely.

**Worth checking upstream:** whether the companion's fetch-and-downscale step is
failing silently, and whether a failure there could surface as something other
than an indefinite `notFound`.

---

## 2. The app that owns playback is not on the wire

**Symptom.** Start a YouTube video and the Car Thing keeps showing the Apple
Music track — title, artist, artwork — while the playhead runs on the video's
timeline. Nothing tells the webapp the audio changed hands.

**Reading.** The daemon knows. `crates/core/src/player/mod.rs` carries
`iap2_app_bundle`, and `crates/core/src/handler/gateway/player.rs` branches on it
for the Spotify wake path. It is never projected into the client-facing
`PlayerState`.

`capabilities.musicProvider` does not help either — `crates/companion/src/hub/mod.rs`
computes it from the **library** provider, so it stays `appleMusic` throughout.

The system-media provider *does* name its owner (`system:<bundle>:<hash>` uris,
`system-art:` ids), but it only attaches when the platform supplies a media
session backend — `crates/companion/src/session/mod.rs`:

```rust
let Some(backend) = self.backends.media_sessions.clone() else { return };
```

There is a Kotlin implementation for Android and none for iOS, which is expected
since iOS does not let third-party apps read another app's now-playing.

**Heuristics that do not work.** Three were tried and all produce false positives
during ordinary playback, because iAP2 delivers metadata one attribute at a time
and re-syncs position freely: duration changing while the title does not; the
playhead passing the track's end; an unexplained playhead jump. Cassette ended up
with a manual switch.

**A small ask upstream:** exposing `iap2_app_bundle` (or just a boolean "the
audible source is not the library provider") on `PlayerState` would let any
webapp handle this properly.

---

## 3. Apple Music reports no playback context

**Symptom.** `state.context` is `null` during normal Apple Music playback, so
"playing from <playlist>" never renders, and anything keying off the current
container has nothing to work with.

**Consequence.** A preset that saves "what is playing" captures the single track
rather than the playlist, which is not what a preset means. Cassette works around
it by remembering the last container started from its own browser.

---

## 4. Apple Music has no queue listing

**Symptom.** `player.queueGet()` returns an empty queue even mid-playlist, while
skip-next plays the right song.

**Reading.** `crates/companion/src/provider/apple_music.rs` implements `queue`
(add to queue) but no queue read, and sets `queue_list_avail: None`. So the empty
result is by construction.

The full client→bridge player command set is `Play, Queue, Pause, Resume,
SkipNext, SkipPrev, SkipToIndex, SeekTo, SetShuffle, SetRepeat, SetSpeed,
SetCrossfade, TransferTo, StateGet, QueueGet, TargetsGet` — note there is **no
remove-from-queue verb** for any provider, so queue editing is not implementable
from a webapp today.

Cassette shows the tracks of the playing container instead, via
`library.browse({ nodeId: <container uri> })`.

---

## 5. Lyrics come from lrclib's strict endpoint

**Not a bug, but worth knowing.** Apple Music supplies no lyrics —
`apple_music.rs`'s `lyrics()` returns `Ok(None)` — so everything falls through to
`crates/companion/src/lyrics/lrclib.rs`, which calls lrclib's `/api/get` with
artist, title, album and duration. That endpoint wants a close match, so a
remaster three seconds long or a title carrying `(feat. …)` misses even when
lrclib has the song.

Cassette retries against lrclib's fuzzy `/api/search` through `net.fetch`,
stripping remaster/feat noise and picking the closest-duration synced hit. It
recovers a noticeable share of the misses. Doing this in the companion instead
would benefit every webapp.

---

## 6. Smaller notes

**`setElapsedTimeAvailable` is often absent.** Gating scrub UI on it hides a
control that works. A refused seek is a harmless no-op, so it is better used to
dim the affordance than to remove it.

**Browse falls through to container children.** Any `nodeId` the Apple Music
provider does not recognise is treated as a container uri:

```rust
Some(node) => {
  let scope = AmLibraryScope::Children { uri: node.to_owned() };
  ...
}
```

So `browse({ nodeId: "am:playlist:…" })` returns that playlist's tracks. This is
useful and not obvious from the docs.

**The client accepts JSON frames.** `handleMessage` in `@bridgething/client`
parses string payloads as JSON, so a mock daemon can speak plain JSON instead of
msgpack. Outbound frames are always msgpack, and uuid-named fields are encoded as
raw 16-byte arrays — a mock has to decode those back to strings. This made
building `scripts/mockd.ts` far easier than expected and may be worth a line in
the developer docs.
