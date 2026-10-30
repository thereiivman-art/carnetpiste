// Chrono estimé sur un circuit jamais roulé : par les pilotes communs
// (Misano) et, sans eux, par le rythme au km (Jerez).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  for (const id of ['e6', 'e7']) {
    await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
    await p.locator('.pill-tabs button').nth(1).click(); await p.waitForTimeout(400);
    await p.click('[data-outing-event="' + id + '"]'); await p.waitForTimeout(800);
    await p.click('[data-pill-group="outing"][data-pill="chronos"]').catch(() => {}); await p.waitForTimeout(300);
    console.log(id + ':', (await p.$eval('.outing-best-card', e => e.innerText)).replace(/\n/g, ' | '));
    if (id === 'e6') await p.screenshot({ path: 'chrono-estime-' + lang + '.png' });
  }
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
