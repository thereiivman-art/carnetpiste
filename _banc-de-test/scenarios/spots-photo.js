// Spots photo : l'admin les place sur le plan (tout public / accès pro),
// un accompagnant les voit depuis Plan & repères › Photo.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const go = async (hash) => { const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr') + hash); await p.waitForTimeout(1600);
    await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300); await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400); return p; };
  const a = await go('&admin=1');
  await a.click('[data-action="photo-spots"]'); await a.waitForTimeout(300);
  const r = await a.$eval('.spots-map img', e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width * 0.5, y: b.top + b.height * 0.3 }; });
  await a.mouse.click(r.x, r.y); await a.waitForTimeout(300);
  await a.fill('#spot-label', 'Tribune virage 1'); await a.click('[data-spot-access="pro"]'); await a.click('[data-spot="add"]'); await a.waitForTimeout(600);
  console.log('admin, spots:', await a.$$eval('.spot-row', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  const saved = await a.evaluate(() => firebase.firestore().collection('circuits').get().then(s => JSON.stringify(s.docs.map(d => d.data()).filter(c => c.photoSpots).map(c => [c.name, c.photoSpots.length, c.photoSpots[0].access]))));
  console.log('enregistré:', saved);
  await a.screenshot({ path: 'spots-photo.png' });
  const acc = await go('&role=acc');
  console.log('accompagnant, bouton Photo:', !!(await acc.$('[data-action="photo-spots"]')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
