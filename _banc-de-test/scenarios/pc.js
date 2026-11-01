// Mise en page PC (1440 × 900) : barre latérale compacte, colonne de
// contenu ≤ 920 px, boutons d'action à leur taille (pas de longues barres).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&jourj=1'); await p.waitForTimeout(1600);
  const w = (sel) => p.$eval(sel, e => Math.round(e.getBoundingClientRect().width)).catch(() => null);
  const h = (sel) => p.$eval(sel, e => Math.round(e.getBoundingClientRect().height)).catch(() => null);
  console.log('nav: hauteur bouton actif', await h('.bottom-nav-btn.active'), 'px | colonne', await w('#root'), 'px');
  console.log('Chrono: Enregistrer', await w('#submit-btn'), 'px');
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(400);
  console.log('Carnet: + Ajouter un chrono', await w('#carnet-add-chrono'), 'px');
  await p.locator('#root [data-open-outing]:visible').first().click().catch(() => {}); await p.waitForTimeout(700);
  console.log('Roulage: boutons', await p.$$eval('.outing-actions > button', e => e.map(x => x.innerText.trim() + ' ' + Math.round(x.getBoundingClientRect().width)).join(' | ')));
  // Mobile inchangé
  await p.setViewportSize({ width: 380, height: 900 }); await p.waitForTimeout(400);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  console.log('mobile: + Ajouter un chrono', await w('#carnet-add-chrono'), 'px (pleine largeur attendue)');
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
