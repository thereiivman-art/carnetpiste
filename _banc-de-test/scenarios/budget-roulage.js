// Onglet Budget d'un roulage : même ligne que Carnet › Budget, total en tête.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1100 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  // roulage à venir (Barcelone) : depuis « À venir »
  await p.locator('.pill-tabs button').nth(1).click(); await p.waitForTimeout(400);
  await p.click('[data-outing-event="e1"]'); await p.waitForTimeout(800);
  console.log('pills:', await p.$$eval('[data-pill-group="outing"]', e => e.map(x => x.textContent).join(' / ')));
  await p.click('.event-price-line [data-action="outing-budget"]'); await p.waitForTimeout(500);
  console.log('active pill:', await p.$eval('[data-pill-group="outing"].active', e => e.textContent));
  console.log('hero:', (await p.$eval('.outing-budget-hero', e => e.innerText)).replace(/\n/g, ' | '));
  await p.fill('#bud-e1-travel', '180'); await p.fill('#bud-e1-hotel', '240'); await p.waitForTimeout(1000);
  console.log('hero total after typing:', await p.$eval('[data-tot-big="e1"]', e => e.innerText));
  await p.screenshot({ path: 'budget-roulage-' + lang + '.png', fullPage: true });
  await p.click('[data-action="budget-open-season"]'); await p.waitForTimeout(600);
  console.log('global tab:', await p.$eval('.subnav-btn.active', e => e.textContent), '| season', await p.$eval('.budget-season.active span', e => e.textContent), '| row total', await p.$eval('[data-tot-ev="e1"]', e => e.innerText));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
