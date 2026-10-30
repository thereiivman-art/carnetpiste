// Un accompagnant : les roulages de ses potes (passés et à venir), leurs
// podiums dans Stats, et la page d'un roulage d'un pote.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&role=acc'); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(400);
  console.log('pills:', await p.$$eval('[data-pill-group="compcarnet"]', e => e.map(x => x.textContent).join(' / ')));
  console.log('passés:', await p.$$eval('.outing-row', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  await p.screenshot({ path: 'acc-carnet-' + lang + '.png' });
  await p.click('[data-pill-group="compcarnet"][data-pill="avenir"]'); await p.waitForTimeout(300);
  console.log('à venir:', await p.$$eval('.outing-row', e => e.map(x => x.innerText.replace(/\n/g, ' ')).slice(0, 3).join(' | ')));
  await p.click('[data-pill-group="compcarnet"][data-pill="passes"]'); await p.waitForTimeout(300);
  await p.click('.outing-row'); await p.waitForTimeout(800);
  console.log('page roulage:', (await p.$eval('#app, body', e => e.innerText)).split('\n').slice(0, 14).join(' | ').slice(0, 300));
  await p.screenshot({ path: 'acc-roulage-' + lang + '.png', fullPage: true });
  await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(400);
  console.log('stats pills:', await p.$$eval('[data-pill-group="stats"]', e => e.map(x => x.textContent).join(' / ')));
  await p.click('[data-pill-group="stats"][data-pill="podium"]'); await p.waitForTimeout(400);
  console.log('podiums:', await p.$$eval('.podium-circuit', e => e.map(x => x.innerText).join(', ')));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
