// Repères : poser un repère, les partager (image avec le plan et la liste,
// post qu'un pote peut copier), et copier ceux d'un pote.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.click('[data-action="map-open"][data-mode="pins"]'); await p.waitForTimeout(500);
  const box = await p.$eval('.track-notes-map img', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.5 }; });
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(400);
  await p.fill('#tn-turn', '1'); await p.fill('#tn-brake', 'panneau 100'); await p.click('[data-s="save"]'); await p.waitForTimeout(400);
  await p.click('[data-tn="share"]'); await p.waitForTimeout(300);
  console.log('choix:', await p.$$eval('[data-tns]', e => e.map(x => x.innerText).join(' / ')));
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }).catch(() => null), p.click('[data-tns="png"]')]);
  console.log('image téléchargée:', dl ? dl.suggestedFilename() : 'non');
  if (dl) await dl.saveAs(require('path').join(process.cwd(), 'reperes-image.png'));
  await p.click('[data-tn="share"]'); await p.waitForTimeout(300);
  await p.click('[data-tns="post"]'); await p.waitForTimeout(1200);
  console.log('post partagé:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.notesShare).map(w => [w.notesShare.circuit, w.notesShare.notes.length, (w.photoURL || '').slice(0, 15)]))));
  // Un pote partage les siens : je les copie
  await p.click('[data-tn="close"]'); await p.waitForTimeout(300);
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(300);
  await p.click('[data-pill-group="social"][data-pill="fil"]'); await p.waitForTimeout(300);
  await p.evaluate(() => firebase.firestore().collection('wallPosts').doc('ns1').set({ id: 'ns1', author: 'Sam', authorUid: 'u2', audience: 'all', createdAt: Date.now(), text: 'Mes repères à Mugello', photoURL: 'icons/icon-192.png', notesShare: { circuit: 'Mugello', notes: [{ x: 0.2, y: 0.4, turn: '15', brake: '150 m' }, { x: 0.6, y: 0.3, turn: '1' }] } }));
  await p.waitForTimeout(600);
  console.log('bouton copier:', await p.$eval('[data-action="copy-notes"]', e => e.innerText).catch(() => 'absent'));
  await p.click('[data-action="copy-notes"]'); await p.waitForTimeout(600);
  console.log('mes repères Mugello:', await p.evaluate(() => firebase.firestore().collection('userPrivate').doc(firebase.auth().currentUser.uid).get().then(d => JSON.stringify(((d.data() || {}).trackNotes || {}).Mugello || []).slice(0, 120))));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
