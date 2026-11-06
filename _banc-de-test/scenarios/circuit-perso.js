// Créer mon circuit perso : un nom, puis une image (contour importé) ou un
// dessin à main levée (contour du tracé, dans la page). Et le podium
// montre aussi les circuits des potes.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.click('[data-action="circuit-create"]'); await p.waitForTimeout(300);
  await p.fill('#cc-name', 'Circuit du Var');
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-cc="image"]')]);
  await fc.setFiles(require('path').join(__dirname, '../../icons/icon-512.png')); await p.waitForTimeout(1200);
  console.log('circuit choisi:', await p.$eval('#f-filter-circuit', e => e.value), '| enregistré:', await p.evaluate(() => firebase.firestore().collection('circuits').get().then(s => s.docs.map(d => d.data()).filter(c => c.name === 'Circuit du Var').map(c => Object.keys(c.outlineDrawings || {}).join()).join())));
  console.log('vignette du tracé:', await p.$$eval('.circuit-plan-map img', e => e.some(i => /^data:image/.test(i.getAttribute('src')))));
  await p.click('[data-action="circuit-create"]'); await p.waitForTimeout(300);
  await p.fill('#cc-name', 'Piste perso'); await p.click('[data-cc="draw"]'); await p.waitForTimeout(600);
  console.log('dessin ouvert dans la page:', !!(await p.$('#annot-overlay.open.map-docked')), '| niveau:', await p.$eval('#annot-session-select', e => e.options[e.selectedIndex].text));
  await p.screenshot({ path: 'circuit-perso.png' });
  // Podium : circuits des potes aussi
  const p2 = await b.newPage({ viewport: { width: 390, height: 900 } }); p2.on('pageerror', e => errs.push(e.message));
  await p2.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p2.waitForTimeout(1500);
  await p2.click('.bottom-nav-btn:nth-child(1)'); await p2.waitForTimeout(300);
  await p2.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(300);
  await p2.click('[data-moi-jump="podium"]', { timeout: 1500 }).catch(() => {}); await p2.waitForTimeout(400);
  console.log('podiums:', await p2.$$eval('.podium-circuit', e => e.map(x => x.innerText.trim()).join(', ')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
