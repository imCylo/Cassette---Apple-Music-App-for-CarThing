/** Measure real geometry in the running app instead of guessing from a screenshot. */
import { chromium } from 'playwright';

const URL = process.env.APP_URL ?? 'http://localhost:5174/';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 800, height: 480 } });

const notFound: string[] = [];
page.on('response', r => {
  if (r.status() === 404) notFound.push(r.url());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const probe = async (label: string) => {
  const out = await page.evaluate(() => {
    const active = document.querySelector('p[style*="color"]') as HTMLElement | null;
    const box = active?.closest('.overflow-hidden') as HTMLElement | null;
    const body = document.body;
    return {
      overflowX: body.scrollWidth > body.clientWidth ? body.scrollWidth : 0,
      overflowY: body.scrollHeight > body.clientHeight ? body.scrollHeight : 0,
      active: active
        ? {
            text: active.textContent?.slice(0, 40),
            centerY: active.getBoundingClientRect().top + active.getBoundingClientRect().height / 2,
          }
        : null,
      box: box
        ? { top: box.getBoundingClientRect().top, height: box.getBoundingClientRect().height }
        : null,
      clipped: Array.from(document.querySelectorAll('.truncate'))
        .filter(el => el.scrollWidth > el.clientWidth + 1)
        .map(el => (el.textContent ?? '').slice(0, 46)),
    };
  });
  const want = out.box ? out.box.top + out.box.height / 2 : null;
  console.log(`\n[${label}]`);
  console.log('  body overflow x/y :', out.overflowX, '/', out.overflowY);
  if (out.active && want !== null) {
    console.log(`  active line       : "${out.active.text}"`);
    console.log(`  centred at        : ${out.active.centerY.toFixed(1)}  (want ${want.toFixed(1)}, off by ${(out.active.centerY - want).toFixed(1)})`);
  }
  if (out.clipped.length) console.log('  truncated text    :', out.clipped);
};

await probe('art');
await page.keyboard.press('m');
await page.waitForTimeout(800);
await probe('split');
await page.keyboard.press('m');
await page.waitForTimeout(800);
await probe('lyrics');

console.log('\n404s:', notFound.length ? notFound : 'none');
await browser.close();
