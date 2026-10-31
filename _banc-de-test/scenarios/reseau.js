// Communauté façon réseau social : Fil (« Quoi de neuf ? », pilotes à
// suivre, commentaires), Suivis (suggestions, à découvrir, abonnements,
// abonnés), fiche d'un pilote non ami (compteurs, Suivre, publications).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1700);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(500);
  await p.click('.subnav-btn[data-view="social"]').catch(() => {}); await p.waitForTimeout(300);
  console.log('pastilles:', await p.$$eval('[data-pill-group="social"]', e => e.map(x => x.innerText).join(' / ')));
  console.log('composer:', await p.$eval('.composer-teaser', e => e.innerText).catch(() => 'absent'));
  console.log('à suivre:', await p.$$eval('.follow-card strong', e => e.map(x => x.innerText).join(', ')));
  console.log('commentaires:', await p.$$eval('.post-comment', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  await p.screenshot({ path: 'reseau-fil-' + lang + '.png', fullPage: true });
  // Commenter le message de Sam
  const form = await p.$('form[data-action="comment-form"]');
  if (form) { await form.$eval('[data-comment-text]', e => e.value = 'Je prends ma place !'); await form.$eval('button', e => e.click()); await p.waitForTimeout(500); }
  console.log('commentaire stocké:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.postComments || {}).filter(c => c.author === 'Alex').map(c => [c.postId, c.text]))));
  // Publier
  await p.click('#wall-composer-toggle'); await p.waitForTimeout(300);
  console.log('audience par défaut:', await p.$eval('#wall-post-audience', e => e.value));
  // Suivis
  await p.click('[data-pill-group="social"][data-pill="suivis"]'); await p.waitForTimeout(400);
  console.log('compteurs:', await p.$eval('.my-mini-profile .social-counts', e => e.innerText.replace(/\n/g, ' ')));
  console.log('suggestions:', await p.$$eval('.follow-card', e => e.map(x => x.innerText.replace(/\n/g, ' ')).slice(0, 4).join(' | ')));
  console.log('à découvrir:', await p.$$eval('.feed-card .wall-post-text', e => e.map(x => x.innerText).join(' | ')));
  await p.screenshot({ path: 'reseau-suivis-' + lang + '.png', fullPage: true });
  await p.click('.follow-card [data-action="quick-follow"]'); await p.waitForTimeout(500);
  console.log('abonnements:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.follows).filter(f => f.follower === 'Alex').map(f => f.followee))));
  // Fiche de Luca (non ami)
  await p.click('[data-open-person="Luca"]'); await p.waitForTimeout(600);
  console.log('fiche Luca:', await p.$eval('.social-counts', e => e.innerText.replace(/\n/g, ' ')), '| bouton:', await p.$eval('.follow-btn', e => e.innerText).catch(() => 'aucun'), '| publications:', await p.$$eval('.feed-card .wall-post-text', e => e.length));
  await p.screenshot({ path: 'reseau-fiche-' + lang + '.png', fullPage: true });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
