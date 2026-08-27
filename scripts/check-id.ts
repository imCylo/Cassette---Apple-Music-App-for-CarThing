/**
 * The webapp id is this app's identity.
 *
 * BridgeThing installs a bundle to `/var/bridgething/webapps/<id>/` and the
 * companion matches updates by id. Change it and every existing install is
 * orphaned — people keep the old copy forever and your update installs beside it
 * as a second app.
 *
 * `bun create bridgething` mints the id once, at scaffold time. Nothing in the
 * build touches it: vite copies `public/` into `dist/` verbatim, and both
 * `share.ts` and `push.ts` only read the manifest. So the only realistic way it
 * changes is a human editing it, or someone re-running the scaffold and copying
 * the source across.
 *
 * This runs before every build so that mistake fails loudly instead of shipping.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minted at scaffold time. Never edit this, and never edit the manifest's id. */
const EXPECTED_ID = '01a03aee-7989-76c4-b62c-edc89c2cee53';

const manifestPath = join(import.meta.dir, '..', 'public', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.id !== EXPECTED_ID) {
  console.error(
    [
      '',
      '  ✗ the webapp id changed.',
      '',
      `      expected  ${EXPECTED_ID}`,
      `      found     ${manifest.id}`,
      '',
      '  This id is the install path on the device and the key the companion app',
      '  updates against. Changing it strands every copy already installed.',
      '',
      '  If this was accidental, restore the id in public/manifest.json.',
      '  If you genuinely want a separate app, change EXPECTED_ID here too and',
      '  say so in the release notes — existing users will need to reinstall.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`webapp id ok (${EXPECTED_ID})`);
