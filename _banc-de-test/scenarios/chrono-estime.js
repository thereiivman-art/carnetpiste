// Chrono estimé sur un circuit jamais roulé : par les pilotes communs
// (Misano), par le barème recalé sur mes chronos (Navarra) et, sans les
// deux, par le rythme au km (Jerez).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  for (const id of ['e6', 'e7', 'e8']) {
    await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
    await p.locator('.pill-tabs button').nth(1).click(); await p.waitForTimeout(400);
    await p.click('[data-outing-event="' + id + '"]'); await p.waitForTimeout(800);
    await p.click('[data-pill-group="outing"][data-pill="chronos"]').catch(() => {}); await p.waitForTimeout(300);
    console.log(id + ':', (await p.$eval('.outing-best-card', e => e.innerText)).replace(/\n/g, ' | '));
    if (id === 'e6') await p.screenshot({ path: 'chrono-estime-' + lang + '.png' });
  }
  // Carnet › Circuits › Chronos : la même estimation pour Navarra
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.selectOption('#f-filter-circuit', 'Navarra').catch(e => console.log('select', e.message.split('\n')[0]));
  await p.waitForTimeout(500);
  await p.click('[data-pill-group="circuit"][data-pill="chronos"]'); await p.waitForTimeout(400);
  console.log('circuit chronos:', await p.$eval('.estimate-card', e => e.innerText.replace(/\n/g, ' | ')).catch(() => 'pas de carte'));
  await p.click('[data-pill-group="circuit"][data-pill="infos"]'); await p.waitForTimeout(300);
  console.log('infos sans estimation:', !(await p.$('.estimate-card')));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
