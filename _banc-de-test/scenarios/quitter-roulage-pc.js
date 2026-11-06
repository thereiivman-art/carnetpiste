// PC : « Je n'y vais plus » retire aussi le roulage de la colonne de droite.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1800);
  const rail = () => p.$eval('.side-rail', r => { const n = r.querySelector('.rail-next strong'); return n ? n.innerText.split('\n')[0] : '(aucun)'; }).catch(() => '(pas de colonne)');
  const before = await rail(); console.log('prochain avant:', before);
  await p.click('.side-rail .rail-next'); await p.waitForTimeout(800);
  const leave = await p.$('[data-action="leave-roulage"]'); console.log('bouton:', !!leave);
  if (leave) { await leave.click(); await p.waitForTimeout(1200); }
  console.log('prochain après:', await rail());
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
