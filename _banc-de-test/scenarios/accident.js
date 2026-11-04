// Chrono › Accident : type (chute, sortie…), endroit sur le plan, un mot,
// publié sur mon Social (amis) ; rangé avec le chrono enregistré.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr') + '&jourj=1'); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-main'); await p.waitForTimeout(400);
  console.log('bouton:', await p.$eval('#cf-incident', e => e.innerText).catch(() => 'absent'));
  await p.click('#cf-incident'); await p.waitForTimeout(400);
  console.log('types:', await p.$$eval('[data-inc-type]', e => e.map(x => x.innerText).join(' / ')), '| plan:', !!(await p.$('.incident-map img')));
  await p.click('[data-inc-type="sortie"]'); await p.waitForTimeout(200);
  const r = await p.$eval('.incident-map img', e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width * 0.4, y: b.top + b.height * 0.5 }; });
  await p.mouse.click(r.x, r.y); await p.waitForTimeout(300);
  await p.fill('#inc-note', 'Tout va bien');
  await p.screenshot({ path: 'accident-feuille.png' });
  await p.click('[data-inc="ok"]'); await p.waitForTimeout(400);
  console.log('après valider (sans chrono):', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.incident).map(w => [w.text, w.audience, (w.photoURL || '').slice(0, 15)]))));
  // Avec un chrono : rangé dans la session
  await p.click('#cf-incident'); await p.waitForTimeout(300);
  await p.fill('#f-laps', '1:12.400').catch(() => {});
  await p.click('[data-inc="ok"]'); await p.waitForTimeout(300);
  await p.fill('#f-laps', '1:12.400'); await p.click('#cf-incident'); await p.waitForTimeout(300); await p.click('[data-inc="ok"]'); await p.waitForTimeout(300);
  console.log('bouton:', await p.$eval('#cf-incident', e => e.innerText));
  await p.click('#submit-btn'); await p.waitForTimeout(800);
  if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.waitForTimeout(300); }
  console.log('session:', await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => JSON.stringify(s.docs.map(d => d.data()).filter(x => x.incident).map(x => [x.circuit, x.incident.type])))));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
