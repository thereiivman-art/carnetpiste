const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 400, height: 1500 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1800);
  await p.screenshot({ path: 'f-carnet-' + lang + '.png' });
  await p.getByText('Mugello').first().click(); await p.waitForTimeout(900);
  await p.screenshot({ path: 'f-day-' + lang + '.png' });
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1500);
  await p.click('#profile-toggle'); await p.waitForTimeout(500); await p.click('[data-action="open-my-profile"]'); await p.waitForTimeout(400); await p.click('[data-profile-tab="moto"]'); await p.waitForTimeout(400);
  await p.click('[data-action="tyre-new"]'); await p.waitForTimeout(400);
  await p.screenshot({ path: 'f-tyre-' + lang + '.png' });
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1500);
  await p.click('.bottom-nav button:nth-child(2)'); await p.waitForTimeout(700);
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }).catch(() => null), p.click('[data-action="add-to-calendar"]')]);
  if (dl) { const path = 'f-cal-' + lang + '.ics'; await dl.saveAs(path); console.log(require('fs').readFileSync(path, 'utf8')); }
  await p.click('.bottom-nav button:nth-child(3)'); await p.waitForTimeout(600);
  console.log('community subnav:', await p.$$eval('.subnav-btn', e => e.map(x => x.textContent)));
  console.log('errors', JSON.stringify(errs));
  await b.close();
})();
