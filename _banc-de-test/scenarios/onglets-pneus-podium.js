// Circuits › Pneus (pressions du circuit choisi en tête, saisie pré-remplie)
// et Stats › Podium (un podium par circuit roulé).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  console.log('circuit pills:', await p.$$eval('[data-pill-group="circuit"]', e => e.map(x => x.textContent).join(' / ')));
  await p.selectOption('#f-filter-circuit', 'Mugello'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="circuit"][data-pill="pneus"]'); await p.waitForTimeout(400);
  console.log('first pressures circuit:', await p.$eval('.pressure-circuit strong', e => e.innerText));
  await p.click('[data-action="pressure-new"]'); await p.waitForTimeout(300);
  console.log('prefilled circuit:', await p.$eval('#pr-circuit', e => e.value));
  await p.click('.pressure-sheet [data-p="cancel"]');
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(400);
  console.log('stats pills:', await p.$$eval('[data-pill-group="stats"]', e => e.map(x => x.textContent).join(' / ')));
  await p.click('[data-pill-group="stats"][data-pill="podium"]'); await p.waitForTimeout(400);
  console.log('podiums:', await p.$$eval('.podium-card .help-text', e => e.map(x => x.innerText.split(' · ')[0]).join(', ')));
  await p.screenshot({ path: 'podium-stats-' + lang + '.png', fullPage: true });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
