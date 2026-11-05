// Pitbook+ (simulation) : l'espace Pitbook+ dans Mon compte (offre, prix,
// statut), « Ça m'intéresse » qui remonte une suggestion, l'admin qui
// attribue Pitbook+ à un compte depuis la gestion des comptes, et le badge
// C+ affiché à côté du nom.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1'); await p.waitForTimeout(1600);
  await p.click('#settings-toggle'); await p.waitForTimeout(400);
  console.log('liste réglages:', await p.$$eval('.set-label', e => e.length), '| page:', await p.evaluate(() => document.documentElement.scrollWidth), 'px');
  await p.click('[data-settings-go="@plus"]'); await p.waitForTimeout(400);
  console.log('statut:', await p.$eval('.cp-status', e => e.innerText), '| prix:', await p.$$eval('.cp-price strong', e => e.map(x => x.innerText).join(' / ')));
  console.log('compris:', await p.$$eval('.cp-feat:not(.free) strong', e => e.map(x => x.innerText.replace(/\s+/g, ' ')).join(' | ')));
  await p.click('[data-action="carnet-plus-interest"]'); await p.waitForTimeout(400);
  console.log('intérêt remonté:', await p.evaluate(() => firebase.firestore().collection('feedback').get().then(s => s.docs.some(d => /\[Carnet\+\]/.test(d.data().text)))));
  // Admin : attribuer Pitbook+ à Sam
  await p.click('[data-settings-go="@reglages"]'); await p.waitForTimeout(300);
  await p.click('[data-settings-go="@compte"]'); await p.waitForTimeout(300);
  await p.click('#account-manager-toggle').catch(() => {}); await p.waitForTimeout(900);
  const btn = await p.$('li:has-text("Sam") [data-action="toggle-account-badge"][data-field="plus"]');
  console.log('bouton admin Pitbook+:', !!btn);
  if (btn) { await btn.click(); await p.waitForTimeout(500); }
  console.log('Sam en base:', await p.evaluate(() => firebase.firestore().collection('users').doc('u2').get().then(d => !!d.data().plus)));
  // Badge à côté du nom de Sam (fil)
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(300);
  await p.evaluate(() => firebase.firestore().collection('users').doc('u2').update({ plus: true }));
  await p.waitForTimeout(600);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="social"][data-pill="fil"]').catch(() => {}); await p.waitForTimeout(600);
  console.log('badge C+ dans le fil:', await p.$$eval('.plus-badge', e => e.length > 0 ? e[0].innerText + ' (' + e.length + ')' : 'aucun'));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
