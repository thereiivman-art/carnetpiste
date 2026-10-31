// Records de la piste : l'admin saisit MotoGP / Moto2 / Moto3 / FSBK dans
// la fiche du circuit ; Circuits › Chronos range ces records avec ceux des
// potes et le mien, écarts depuis mon record. Valeurs fictives de test.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1100 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1'); await p.waitForTimeout(1600);
  if (await p.$('#jourj-overlay')) { await p.click('[data-jj="close"]'); await p.waitForTimeout(300); }
  await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.selectOption('#f-filter-circuit', 'Mugello'); await p.waitForTimeout(500);
  await p.click('[data-pill-group="circuit"][data-pill="infos"]'); await p.waitForTimeout(300);
  await p.click('#edit-circuit-info-btn'); await p.waitForTimeout(300);
  await p.fill('#ci-rec-motogp', '1:45.000'); await p.fill('#ci-rec-motogp-who', 'Pilote A, 2025');
  await p.fill('#ci-rec-moto2', '1:50.000'); await p.fill('#ci-rec-moto3', '1:55.000');
  await p.click('#save-circuit-info-btn'); await p.waitForTimeout(600);
  console.log('stocké:', JSON.stringify(await p.evaluate(() => (window.__MOCK_DATA.circuits || {}).Mugello && window.__MOCK_DATA.circuits.Mugello.trackRecords)));
  await p.click('[data-pill-group="circuit"][data-pill="chronos"]'); await p.waitForTimeout(400);
  console.log('carte:', await p.$$eval('.track-records .tr-row', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')).catch(() => 'absente'));
  await p.evaluate(() => { const c = document.querySelector('.track-records'); if (c) window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 80); });
  await p.screenshot({ path: 'records-piste-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
