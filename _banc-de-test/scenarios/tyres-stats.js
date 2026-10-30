const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 820 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  console.log('carnet: tyre card', !!(await p.$('.tyre-card')), 'rows', await p.$$eval('.outing-row', e => e.length));
  await p.screenshot({ path: 'ts-carnet-' + lang + '.png' });
  await p.click('#profile-toggle'); await p.waitForTimeout(500); await p.click('[data-action="open-my-profile"]'); await p.waitForTimeout(400); await p.click('[data-profile-tab="moto"]'); await p.waitForTimeout(400);
  console.log('stats pills', await p.$$eval('[data-pill-group="stats"]', e => e.map(x => x.textContent).join(' / ')));
  await p.click('[data-action="tyre-new"]'); await p.waitForTimeout(300);
  await p.fill('#tyre-label', 'Pirelli SC2'); await p.click('.tyre-sheet [data-t="save"]'); await p.waitForTimeout(600);
  console.log('panel:', (await p.$eval('#app, body', e => e.innerText)).split('\n').filter(l => /Pirelli|Train|set|SC/i.test(l)).join(' | '));
  await p.screenshot({ path: 'ts-stats-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
