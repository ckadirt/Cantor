// Screenshot frames of a design document (docs/import/flow.html) on the
// desktop, at the phone's 392 dp width, without the phone's browser.
//
//   python3 -m http.server 8099 &          # from the repository root
//   PLAYWRIGHT=~/.hermes/hermes-agent/node_modules/playwright-core \
//   B=$(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/ | tail -1)chrome-headless-shell-linux64/chrome-headless-shell \
//   node cantor/scripts/frame-shots.cjs f-roster f-ask f-sum
//
// Writes /tmp/frame-<id>.png. LENS=seal draws song marks in the seal;
// DOC=docs/other.html points it at another drawing.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.B });
  const page = await browser.newPage({
    viewport: { width: 392, height: 764 },
    deviceScaleFactor: 2,
  });
  const doc = process.env.DOC || 'docs/import/flow.html';
  const lens = process.env.LENS ? `&lens=${process.env.LENS}` : '';
  await page.goto(`http://localhost:8099/${doc}?phone&still${lens}`);
  await page.waitForTimeout(800);
  for (const id of process.argv.slice(2)) {
    const frame = await page.$(
      `#${id} [data-frame], #${id} .fld, #${id} .frame`,
    );
    if (frame === null) {
      console.log('missing', id);
      continue;
    }
    await frame.screenshot({ path: `/tmp/frame-${id}.png` });
    console.log('wrote', `/tmp/frame-${id}.png`);
  }
  await browser.close();
})();
