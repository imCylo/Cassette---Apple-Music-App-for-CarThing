/**
 * Generate `catalog.json` — a `catalog.v1` document for the BridgeThing app
 * directory (https://bridgething.com/apps).
 *
 * The directory fetches the catalog from a browser, so both the catalog URL and
 * every download URL have to answer with `Access-Control-Allow-Origin: *`. A
 * GitHub repo page does not; `raw.githubusercontent.com` does, which is why the
 * release zips live in `releases/` in this repo rather than as GitHub Release
 * attachments — release assets redirect to a host whose CORS behaviour is not
 * guaranteed.
 *
 * `download.sha256` is verified before anything reaches a device, so it must be
 * the hash of the exact bytes served. This script hashes the files on disk, so
 * never rebuild a zip after generating the catalog — the zip embeds mtimes, so
 * a rebuild of identical source still changes the hash.
 *
 * The icon is `docs/icon.png`, not `public/icon.svg`, because raw.githubusercontent
 * serves SVG as `text/plain` with `nosniff` — a browser refuses to render it in an
 * `<img>`. PNG is served as `image/png`. `docs/` rather than `public/` so it stays
 * out of the shipped bundle.
 *
 *   bun scripts/catalog.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(join(root, 'public', 'manifest.json'), 'utf8'));

const OWNER = 'imCylo';
const REPO = 'Cassette---Apple-Music-App-for-CarThing';
const BRANCH = 'main';

const raw = (path: string) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${path}`;
const homepage = `https://github.com/${OWNER}/${REPO}`;

/** Release notes per version. Newest first; the catalog is emitted that way. */
const CHANGELOG: Record<string, string> = {
  '0.8.0':
    'Browsing rebuilt at driving scale. Lyrics at 38px. Artwork no longer flickers ' +
    'between metadata updates, and catalog matches now require the album and the ' +
    'artist to agree so a wrong cover is never shown. Up next starts at the playing ' +
    'track. The alternative-media screen is a manual switch.',
};

const releasesDir = join(root, 'releases');
const zips = readdirSync(releasesDir).filter(f => f.endsWith('.zip'));
if (!zips.length) {
  console.error('no zips in releases/ — run `bun run share` and move the zip there first');
  process.exit(1);
}

const versions = zips
  .map(file => {
    const full = join(releasesDir, file);
    const bytes = readFileSync(full);
    const version = file.replace(/^.*?-(\d+\.\d+\.\d+)\.zip$/, '$1');
    return {
      version,
      released_at: statSync(full).mtime.toISOString(),
      download: {
        url: raw(`releases/${file}`),
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      permissions: manifest.permissions ?? [],
      min_libbridgething_version: '0.11.0',
      changelog: CHANGELOG[version] ?? '',
    };
  })
  .sort((a, b) => b.released_at.localeCompare(a.released_at));

const catalog = {
  schema: 'catalog.v1',
  updated_at: new Date().toISOString(),
  repo: {
    name: 'Cassette',
    description: 'An Apple Music player for the Spotify Car Thing.',
    homepage,
    icon: raw('docs/icon.png'),
  },
  apps: [
    {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: OWNER,
      icon: raw('docs/icon.png'),
      homepage,
      source: homepage,
      versions,
    },
  ],
  recommended_sources: [],
};

/**
 * Check the document before writing it. The directory validates on submission
 * and reports one failure at a time through a web form, which is a slow way to
 * find out that `released_at` is not a date.
 */
function validate(doc: typeof catalog): void {
  const fail = (msg: string) => {
    console.error(`catalog is invalid: ${msg}`);
    process.exit(1);
  };
  const need = (obj: Record<string, unknown>, keys: string[], where: string) => {
    for (const k of keys) if (obj[k] === undefined || obj[k] === null || obj[k] === '') fail(`missing ${where}${k}`);
  };
  const https = (url: string, where: string) => {
    if (!url.startsWith('https://')) fail(`${where} is not https: ${url}`);
  };

  need(doc, ['schema', 'updated_at', 'repo', 'apps'], '');
  if (doc.schema !== 'catalog.v1') fail(`schema is ${doc.schema}`);
  if (Number.isNaN(Date.parse(doc.updated_at))) fail('updated_at is not a date');

  need(doc.repo, ['name', 'description', 'homepage', 'icon'], 'repo.');
  https(doc.repo.homepage, 'repo.homepage');
  https(doc.repo.icon, 'repo.icon');

  for (const app of doc.apps) {
    need(app, ['id', 'name', 'description', 'author', 'icon', 'homepage', 'source', 'versions'], 'app.');
    // The id is the install path on the device; a v7 uuid is required.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(app.id);
    if (!uuid) fail(`app.id is not a uuid: ${app.id}`);
    else if (uuid[1] !== '7') fail(`app.id is uuid v${uuid[1]}, not v7: ${app.id}`);
    https(app.icon, 'app.icon');
    https(app.homepage, 'app.homepage');
    https(app.source, 'app.source');
    if (!app.versions.length) fail('app has no versions');

    for (const v of app.versions) {
      need(v, ['version', 'released_at', 'download', 'permissions'], 'version.');
      if (!/^\d+\.\d+\.\d+/.test(v.version)) fail(`version is not semver: ${v.version}`);
      if (Number.isNaN(Date.parse(v.released_at))) fail(`released_at is not a date: ${v.released_at}`);
      need(v.download, ['url', 'size', 'sha256'], 'download.');
      https(v.download.url, 'download.url');
      if (!/^[0-9a-f]{64}$/.test(v.download.sha256)) fail(`sha256 is not a hex digest: ${v.download.sha256}`);
      if (!Array.isArray(v.permissions)) fail('permissions is not an array');
    }
  }
}

validate(catalog);
writeFileSync(join(root, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

console.log(`catalog.json written — ${versions.length} version(s)`);
for (const v of versions) {
  console.log(`  ${v.version}  ${v.download.size} bytes  ${v.download.sha256.slice(0, 16)}…`);
}
console.log(`\nsubmit this url:\n  ${raw('catalog.json')}`);
