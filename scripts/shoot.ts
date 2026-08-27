/**
 * Drive the app at exactly the device's 800x480 and screenshot each view.
 * Physical controls go in as the same browser events the Car Thing sends.
 *
 *   bun scripts/shoot.ts [outDir]
 */
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? 'shots';
const URL = process.env.APP_URL ?? 'http://localhost:5173/';

// The container ships its own chromium; don't let playwright fetch a matching build.
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 2 });

const errors: string[] = [];
page.on('console', m => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400); // let artwork + lyrics land

const shot = async (name: string) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${OUT}/${name}.png`);
};

const key = async (k: string) => {
  await page.keyboard.press(k);
  await page.waitForTimeout(650);
};

console.log('capturing:');
await shot('1-art');

await key('m'); // -> split
await shot('2-split');

await key('m'); // -> lyrics
await shot('3-lyrics');

await key('m'); // back to art
await page.keyboard.press('Escape'); // drawer
await page.waitForTimeout(700);
await shot('4-drawer');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// rotary wheel -> volume HUD
await page.mouse.wheel(120, 0);
await page.waitForTimeout(250);
await shot('5-volume');
await page.waitForTimeout(1800);

// hold preset 2 to save, then tap it
await page.keyboard.down('2');
await page.waitForTimeout(300);
await shot('6-preset-arming');
await page.waitForTimeout(600);
await page.keyboard.up('2');
await page.waitForTimeout(400);
await shot('7-preset-saved');

console.log(errors.length ? `\nconsole errors:\n${errors.map(e => '  ' + e).join('\n')}` : '\nno console errors');

await browser.close();
