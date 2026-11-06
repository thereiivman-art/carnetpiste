// Incident d'un ami : on peut placer l'endroit sur le plan (toutes les entrées).
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr') + '&jourj=1'); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-main').catch(() => {}); await p.waitForTimeout(500);
  const tryMap = async (nom) => {
    const im = await p.$('.incident-map img');
    if (!im) { console.log(nom, ': pas de plan'); return; }
    const r = await im.boundingBox();
    const hit = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + e.className : '?'; }, [r.x + r.width * 0.4, r.y + r.height * 0.5]);
    await p.mouse.click(r.x + r.width * 0.4, r.y + r.height * 0.5); await p.waitForTimeout(300);
    console.log(nom, ': sous le doigt', hit, '| croix posée:', !!(await p.$('.incident-x')));
  };
  // 1) bouton Incident de l'onglet Chrono, pour Sam
  await p.click('[data-action="incident-live"]'); await p.waitForTimeout(300);
  await p.click('[data-inc-who="Sam"]'); await p.waitForTimeout(200);
  await tryMap('onglet Chrono');
  await p.evaluate(() => document.querySelectorAll('.mini-sheet-overlay').forEach(o => o.remove()));
  // 2) depuis Chrono d'un ami
  await p.click('.chrono-friend-row [data-action="chrono-proposal"]'); await p.waitForTimeout(400);
  await p.fill('#cp-circuit', 'Mugello'); await p.click('[data-cp="incident"]'); await p.waitForTimeout(400);
  await tryMap('chrono d\'un ami');
  // 3) circuit tapé en minuscules
  await p.evaluate(() => document.querySelectorAll('.mini-sheet-overlay').forEach(o => o.remove()));
  await p.fill('#cp-circuit', 'mugello'); await p.click('[data-cp="incident"]'); await p.waitForTimeout(400);
  await tryMap('circuit en minuscules');
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
