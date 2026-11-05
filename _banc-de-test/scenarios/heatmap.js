// Carte de chaleur des repères : positions partagées sans texte (grille 24 × 24),
// visible à partir de 3 pilotes, une case allumée si 2 pilotes y ont un repère ;
// on peut arrêter de partager.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const lang = process.argv[2] || 'fr'; const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(500);
  const circuit = await p.$eval('[data-heat-toggle]', e => e.getAttribute('data-heat-toggle'));
  await p.click('[data-heat-toggle]'); await p.waitForTimeout(500);
  console.log('peu de pilotes:', await p.$eval('.heat-ctl .help-text', e => e.innerText));
  await p.evaluate((c) => { const db = firebase.firestore(); return Promise.all(['a', 'b', 'c'].map((u, i) => db.collection('trackHeat').doc(u + '__x').set({ circuit: c, pts: [5 * 24 + 10, 12 * 24 + 8 + i], updatedAt: Date.now() }))); }, circuit);
  await p.click('[data-heat-toggle]'); await p.waitForTimeout(300); await p.click('[data-heat-toggle]'); await p.waitForTimeout(600);
  console.log('carte:', await p.$eval('.heat-ctl .help-text', e => e.innerText), '| cases allumées:', await p.$$eval('.heat-layer i', e => e.length));
  await p.screenshot({ path: 'heatmap-' + lang + '.png' });
  // Un repère noté : publié sans texte.
  await p.evaluate(() => { const me = firebase.auth().currentUser; return firebase.firestore().collection('userPrivate').doc(me.uid).get(); });
  await p.click('[data-heat-share]'); await p.waitForTimeout(300);
  console.log('partage coupé:', await p.$eval('[data-heat-share]', e => e.innerText));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
