// Roulages › Ma prépa › Ma moto › Mes pressions : saisie, contrôle de forme, modification,
// suppression, et aucune valeur proposée dans les champs.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const stored = () => p.evaluate(() => Object.values(window.__MOCK_DATA.userPrivate || {}).map(d => d.pressures));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn.bottom-nav-main'); await p.waitForTimeout(400); await p.click('#root [data-view="planning"]'); await p.waitForTimeout(500); await p.click('[data-cpill-group="planning"][data-cpill="prepa"]'); await p.waitForTimeout(300); await p.click('[data-cpill-group="prepsub"][data-cpill="moto"]'); await p.waitForTimeout(300);
  await p.click('[data-action="pressure-new"]'); await p.waitForTimeout(300);
  console.log('prefilled pressures:', JSON.stringify(await p.$$eval('#pr-fc, #pr-rc, #pr-fh, #pr-rh', e => e.map(x => x.value + '|' + x.placeholder))));
  await p.fill('#pr-circuit', 'Barcelone'); await p.fill('#pr-fc', 'deux');
  await p.click('.pressure-sheet [data-p="save"]'); await p.waitForTimeout(200);
  console.log('error shown:', await p.$eval('.pressure-error', e => !e.hidden && e.textContent));
  await p.fill('#pr-fc', '2,1'); await p.fill('#pr-rc', '1,8'); await p.fill('#pr-cond', lang === 'fr' ? 'Soleil' : 'Sunny');
  await p.click('.pressure-sheet [data-p="save"]'); await p.waitForTimeout(800);
  console.log('card:', (await p.$eval('.pressures-card', e => e.innerText)).replace(/\n/g, ' | '));
  console.log('stored:', JSON.stringify(await stored()));
  await p.click('[data-action="pressure-edit"]'); await p.waitForTimeout(300);
  await p.fill('#pr-fh', '2.3'); await p.selectOption('#pr-unit', 'psi');
  await p.click('.pressure-sheet [data-p="save"]'); await p.waitForTimeout(800);
  console.log('after edit:', await p.evaluate(() => [...document.querySelector('.pressure-row').querySelectorAll('.pressure-vals')].map(x => x.innerText).join(' + ')));
  await p.screenshot({ path: 'pressures-' + lang + '.png', fullPage: true });
  await p.click('[data-action="pressure-edit"]'); await p.waitForTimeout(300);
  await p.click('.pressure-sheet [data-p="delete"]'); await p.waitForTimeout(800);
  console.log('after delete:', JSON.stringify(await stored()));
  console.log('setup placeholders:', await p.evaluate(() => (typeof SETUP_FIELDS !== 'undefined') ? 'global?' : 'ok'));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
