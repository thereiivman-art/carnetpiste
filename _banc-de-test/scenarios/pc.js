// Mise en page PC façon Instagram (1600 × 900) : une barre à gauche (nom de
// l'app, onglets, Inviter, Mon compte, Notifications, ma fiche), colonne de
// contenu de 760 px, colonne de droite, boutons d'action à leur taille.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&jourj=1'); await p.waitForTimeout(1600);
  const w = (sel) => p.$eval(sel, e => Math.round(e.getBoundingClientRect().width)).catch(() => null);
  const h = (sel) => p.$eval(sel, e => Math.round(e.getBoundingClientRect().height)).catch(() => null);
  console.log('nav: hauteur bouton actif', await h('.bottom-nav-btn.active'), 'px | colonne', await w('#root'), 'px');
  console.log('Chrono: Enregistrer', await w('#submit-btn'), 'px');
  console.log('barre gauche:', await p.evaluate(() => [document.querySelector('.nav-brand').innerText].concat([...document.querySelectorAll('.bottom-nav-btn, header.page-head .header-icon-btn, header.page-head .header-hello')].map(e => (e.getAttribute('title') || e.innerText).trim().split('\n').pop())).join(' | ')));
  console.log('colonne de droite:', await p.$eval('.side-rail', e => getComputedStyle(e).display + ' · ' + [...e.querySelectorAll('.rail-title')].map(x => x.innerText).join(' / ')).catch(() => 'absente'));
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
