const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 400, height: 1100 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1800);
  await p.locator('.pill-tabs button').nth(1).click(); await p.waitForTimeout(400);
  await p.click('[data-outing-event="e1"]'); await p.waitForTimeout(800);
  const l = await p.$('.event-price-line'); console.log('line', l ? await l.innerText() : 'none');
  await p.screenshot({ path: 'bp-outing-' + lang + '.png' });
  await p.click('.event-price-line [data-action="outing-budget"]'); await p.waitForTimeout(500);
  await p.screenshot({ path: 'bp-sheet-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
