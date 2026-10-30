// Onglet Moto d'un roulage (pressions de ce circuit, réglages du jour,
// pneus), Roulages › Ma prépa › Ma moto, et Stats › Podium.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1100 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.getByText('Mugello').first().click(); await p.waitForTimeout(800);
  console.log('outing pills:', await p.$$eval('[data-pill-group="outing"]', e => e.map(x => x.textContent).join(' / ')));
  await p.click('[data-pill-group="outing"][data-pill="moto"]'); await p.waitForTimeout(400);
  console.log('pressures circuits:', await p.$$eval('.pressure-circuit strong', e => e.map(x => x.innerText).join(', ')));
  console.log('setup rows:', await p.$$eval('.moto-setup-row', e => e.length), '| tyre card:', !!(await p.$('.tyre-card')));
  await p.click('[data-action="pressure-new"]'); await p.waitForTimeout(300);
  console.log('prefill:', await p.$eval('#pr-circuit', e => e.value), await p.$eval('#pr-date', e => e.value));
  await p.click('.pressure-sheet [data-p="cancel"]');
  await p.screenshot({ path: 'moto-roulage-' + lang + '.png', fullPage: true });
  await p.click('[data-action="open-ma-moto"]'); await p.waitForTimeout(500);
  console.log('ma prépa:', await p.$eval('[data-cpill-group="planning"].active', e => e.textContent), '/', await p.$eval('[data-cpill-group="prepsub"].active', e => e.textContent), '| pressures circuits:', await p.$$eval('[data-cpill-section="planning:prepa"] .pressure-circuit strong', e => e.map(x => x.innerText).join(', ')));
  console.log('sub-pills:', await p.$$eval('[data-cpill-group="prepsub"]', e => e.map(x => x.textContent).join(' / ')));
  await p.screenshot({ path: 'ma-prepa-moto-' + lang + '.png', fullPage: true });
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(400);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  console.log('circuit pills:', await p.$$eval('[data-pill-group="circuit"]', e => e.map(x => x.textContent).join(' / ')));
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="stats"][data-pill="podium"]'); await p.waitForTimeout(400);
  console.log('podiums:', await p.$$eval('.podium-circuit', e => e.map(x => x.innerText).join(', ')));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
