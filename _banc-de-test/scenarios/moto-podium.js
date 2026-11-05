// Onglet Moto d'un roulage (pressions de ce circuit, réglages du jour,
// pneus), Roulages › Ma prépa › Ma moto, et Stats › Podium.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1100 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(400); // l'appli s'ouvre sur le Fil
  await p.click('[data-cards-mode="passees"]:visible').catch(() => {}); await p.waitForTimeout(300);
  await p.getByText('Mugello').first().click(); await p.waitForTimeout(800);
  console.log('outing pills:', await p.$$eval('[data-pill-group="outing"]', e => e.map(x => x.textContent).join(' / ')));
  // Plus d'onglet Moto par roulage : « Ma moto ce jour-là » sous les chronos, puis Mon garage.
  console.log('ma moto ce jour-là:', !!(await p.$('.day-bike')), '| pneus de l\'époque:', await p.$eval('.day-bike-tyre, .day-bike .help-text', e => e.innerText.replace(/\n/g, ' ')).catch(() => '?'));
  await p.click('.day-bike [data-view="garage"]'); await p.waitForTimeout(500);
  console.log('pressures circuits:', await p.$$eval('.pressure-circuit strong', e => e.map(x => x.innerText).join(', ')));
  console.log('setup rows:', await p.$$eval('.moto-setup-row', e => e.length), '| tyre card:', !!(await p.$('.tyre-card')));
  await p.click('[data-action="pressure-new"]'); await p.waitForTimeout(300);
  console.log('prefill:', await p.$eval('#pr-circuit', e => e.value), await p.$eval('#pr-date', e => e.value));
  await p.click('.pressure-sheet [data-p="cancel"]');
  await p.screenshot({ path: 'moto-roulage-' + lang + '.png', fullPage: true });
  // (Ma prépa › Ma moto reste dans Chrono ; depuis un roulage on passe par Mon garage.)
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(400); // l'appli s'ouvre sur le Fil
  await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(400);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  console.log('circuit pills:', await p.$$eval('[data-pill-group="circuit"]', e => e.map(x => x.textContent).join(' / ')));
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(400);
  await p.click('[data-moi-jump="podium"]'); await p.waitForTimeout(400);
  console.log('podiums:', await p.$$eval('.podium-circuit', e => e.map(x => x.innerText).join(', ')));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
