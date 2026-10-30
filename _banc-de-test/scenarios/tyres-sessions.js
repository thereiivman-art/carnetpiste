// Circuits › Pneus › Cocher mes sessions : sessions des roulages depuis le
// montage, cochées par le pilote, et sessions d'une journée sans horaires.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(300);
  await p.click('[data-pill-group="circuit"][data-pill="pneus"]'); await p.waitForTimeout(400);
  const usage = async () => p.$eval('.tyre-card-usage', e => e.innerText);
  console.log('before:', await usage());
  await p.click('[data-action="tyre-sessions"]'); await p.waitForTimeout(400);
  console.log('days:', (await p.$$eval('.tyre-day', ds => ds.map(d => d.querySelector('strong').innerText + ' [' + [...d.querySelectorAll('.tyre-slot')].map(s => (s.querySelector('input').checked ? 'x' : 'o') + s.innerText.replace(/\n/g, ' ')).join(', ') + ']'))).join(' | '));
  await p.screenshot({ path: 'tyres-sessions-sheet-' + lang + '.png' });
  // coche les 3 sessions du 1er jour de Mugello sans chrono, et 3 sessions à Barcelone (sans horaires)
  const boxes = await p.$$('.tyre-day input[data-slot]:not([disabled])');
  for (const c of boxes.slice(0, 3)) await c.check();
  const ex = await p.$$('[data-extra]');
  for (const e of ex) { const k = await e.getAttribute('data-extra'); if (/barcelone/i.test(k)) await e.fill('3'); }
  await p.click('[data-ts="save"]'); await p.waitForTimeout(800);
  console.log('after:', await usage());
  console.log('stored:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.userPrivate || {}).map(d => { const s = (d.tyreSets || []).slice(-1)[0] || {}; return { ridden: s.ridden, extra: s.extra }; }))));
  await p.screenshot({ path: 'tyres-sessions-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
