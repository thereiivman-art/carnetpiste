// Dessins des plans : enregistrés à part (circuitDrawings) avec leur
// visibilité (Public / Amis / Moi seul), plus dans la fiche du circuit ;
// un ancien dessin resté dans la fiche migre tout seul.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const lang = process.argv[2] || 'fr'; const errs = [];
  const p = await b.newPage({ viewport: { width: 1100, height: 800 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  // Ancien dessin d'Alex dans la fiche de Carole (avant la migration)
  await p.evaluate(() => firebase.firestore().collection('circuits').doc('Carole').set({ name: 'Carole', drawings: { Alex: 'data:image/png;base64,AAAA' }, drawingObjects: { Alex: [] }, drawingsBase: { Alex: null } }, { merge: true }));
  await p.waitForTimeout(7000);
  const mig = await p.evaluate(() => Promise.all([firebase.firestore().collection('circuitDrawings').get(), firebase.firestore().collection('circuits').doc('Carole').get()]).then(([d, c]) => ({ docs: d.docs.map(x => x.id.split('__').slice(1).join('__') + ':' + x.data().visibility), left: Object.keys((c.data() || {}).drawings || {}) })));
  console.log('migration:', JSON.stringify(mig));
  // Nouveau dessin sur un autre circuit, visible par mes amis
  await p.click('.bottom-nav-btn:nth-child(1)').catch(() => {}); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"], .nav-sub-btn >> text=Circuits').catch(() => {}); await p.waitForTimeout(500);
  await p.click('[data-action="map-open"][data-mode="draw"]'); await p.waitForTimeout(900);
  const c = await p.$('#annot-canvas'); const bx = await c.boundingBox();
  await p.mouse.move(bx.x + 100, bx.y + 100); await p.mouse.down(); await p.mouse.move(bx.x + 220, bx.y + 160, { steps: 8 }); await p.mouse.up();
  console.log('choix de visibilité:', await p.$$eval('#annot-visibility option', e => e.map(x => x.textContent).join(' / ')));
  await p.selectOption('#annot-visibility', 'friends');
  await p.click('#annot-save'); await p.waitForTimeout(800);
  const saved = await p.evaluate(() => firebase.firestore().collection('circuitDrawings').get().then(s => s.docs.map(d => ({ id: d.id.split('__')[1], vis: d.data().visibility, amis: (d.data().visibleTo || []).length, img: (d.data().drawing || '').slice(0, 14) }))));
  console.log('enregistré:', JSON.stringify(saved));
  console.log('boutons Repères/Commentaires:', !!(await p.$('#annot-pins-toggle')), !!(await p.$('#annot-notes-toggle')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
