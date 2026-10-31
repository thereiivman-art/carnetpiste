// Roulages › Ma prépa › Ma moto : pneus déjà roulés, avec les km déjà faits estimés.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn.bottom-nav-main'); await p.waitForTimeout(400); await p.click('#root [data-view="planning"]'); await p.waitForTimeout(500); await p.click('[data-cpill-group="planning"][data-cpill="prepa"]'); await p.waitForTimeout(300); await p.click('[data-cpill-group="prepsub"][data-cpill="moto"]'); await p.waitForTimeout(300);
  await p.click('[data-action="tyre-new"]'); await p.waitForTimeout(300);
  console.log('km field hidden at first:', await p.$eval('.tyre-prior', e => getComputedStyle(e).display === 'none'));
  await p.check('[name="tyre-state"][value="used"]'); await p.waitForTimeout(200);
  console.log('km field shown:', await p.$eval('.tyre-prior', e => getComputedStyle(e).display !== 'none'));
  await p.fill('#tyre-label', 'Pirelli SC2');
  await p.click('.tyre-sheet [data-t="save"]'); await p.waitForTimeout(300);
  console.log('blocked without km:', !!(await p.$('.tyre-sheet')));
  await p.screenshot({ path: 'tyres-used-sheet-' + lang + '.png' });
  await p.fill('#tyre-prior', '800');
  await p.click('.tyre-sheet [data-t="save"]'); await p.waitForTimeout(800);
  console.log('card:', (await p.$eval('.tyre-card', e => e.innerText)).replace(/\n/g, ' | '));
  console.log('stored:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.userPrivate || {}).map(d => (d.tyreSets || []).slice(-1)[0]))));
  await p.screenshot({ path: 'tyres-used-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
