// Un ami est forcément abonné, dans les deux sens :
// - Alex a 7 amis : ils comptent dans ses abonnés et ses abonnements ;
// - sur la fiche de Sam (ami), « Ami ✓ » à la place de « Suivre / Abonné » ;
// - sur la fiche de Luca (pas ami), « Suivre ».
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="social"][data-pill="profil"]'); await p.waitForTimeout(400);
  console.log('mes compteurs:', await p.$eval('.social-counts', e => e.innerText.replace(/\n/g, ' ')));
  const openPerson = async (n) => { await p.evaluate((n) => { const s = document.createElement('span'); s.className = 'mini-avatar'; s.setAttribute('data-person', n); document.getElementById('root').appendChild(s); s.click(); }, n); await p.waitForTimeout(600); };
  await openPerson('Sam');
  console.log('fiche Sam:', await p.$$eval('.follow-btn', e => e.map(x => x.tagName + ':' + x.innerText + '@' + (x.closest('[data-open-person], .follow-card, .people-card, .person-hero, .ph-actions') || {}).className + '/' + (x.getAttribute('data-name') || '')).join(', ')), '|', await p.$eval('.social-counts', e => e.innerText.replace(/\n/g, ' ')).catch(() => ''));
  await openPerson('Luca');
  console.log('fiche Luca:', await p.$$eval('.follow-btn', e => e.map(x => x.tagName + ':' + x.innerText).join(', ')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
