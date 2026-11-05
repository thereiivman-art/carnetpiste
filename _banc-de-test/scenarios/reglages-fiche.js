// Réglages façon Instagram (liste, recherche, pages), fiche modifiée
// entièrement dans Social (identité + cosmétiques débloqués).
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const lang = process.argv[2] || 'fr'; const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 860 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('#settings-toggle'); await p.waitForTimeout(400);
  console.log('groupes:', await p.$$eval('.set-group-title', e => e.map(x => x.innerText).join(' / ')));
  await p.fill('#settings-search', 'écrire'); await p.waitForTimeout(200);
  console.log('recherche « écrire »:', await p.$$eval('.set-row:not([hidden]) .set-label', e => e.map(x => x.innerText).join(', ')));
  await p.fill('#settings-search', ''); await p.click('[data-settings-go="notifications"]'); await p.waitForTimeout(300);
  console.log('page:', await p.$eval('.settings-page-head .section-title', e => e.innerText), '| retour:', !!(await p.$('.settings-back')));
  await p.click('.settings-back'); await p.waitForTimeout(300);
  console.log('liste revenue:', !!(await p.$('#settings-search')));
  await p.click('[data-settings-go="@aide"]'); await p.waitForTimeout(300);
  console.log('page Aide:', await p.$eval('.settings-page-head .section-title', e => e.innerText));
  // Fiche : Modifier dans Social.
  await p.click('#profile-toggle'); await p.waitForTimeout(500);
  await p.click('[data-action="look-edit"]'); await p.waitForTimeout(400);
  await p.fill('#fiche-firstname', 'Alexandre'); await p.selectOption('#fiche-nationality', 'IT');
  console.log('titre / icône retirés:', !(await p.$('[data-look-set="title"], [data-look-set="nameIcon"]')));
  await p.click('[data-look-set="frame"][data-val=""]'); await p.waitForTimeout(300);
  console.log('prénom gardé après re-rendu:', await p.$eval('#fiche-firstname', e => e.value));
  await p.click('[data-action="look-save"]'); await p.waitForTimeout(800);
  await p.waitForTimeout(600);
  console.log('stocké:', await p.evaluate(() => { const u = window.__MOCK_DATA.users.u1; return [u.firstName, u.nationality].join(' | '); }));
  await p.screenshot({ path: 'reglages-fiche.png' });
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
