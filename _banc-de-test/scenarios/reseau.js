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
  console.log('stories:', await p.$$eval('.story-bubble', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(', ')) || 'aucune');
  if (await p.$('.story-bubble')) {
    await p.click('.story-bubble'); await p.waitForTimeout(500);
    console.log('story ouverte:', await p.$eval('.story-overlay', e => e.innerText.replace(/\n/g, ' | ')));
    await p.screenshot({ path: 'reseau-story-' + lang + '.png' });
    await p.click('.story-close'); await p.waitForTimeout(300);
  }
  console.log('lignes « sont amis »:', await p.$$eval('.feed-line', e => e.length), '| « Plus tôt »:', await p.$$eval('.feed-day', e => e.filter(x => /Plus tôt|Earlier/.test(x.innerText)).length));
  // Profil
  await p.click('[data-pill-group="social"][data-pill="profil"]'); await p.waitForTimeout(400);
  console.log('profil:', await p.$eval('.social-profile-head', e => e.innerText.replace(/\n/g, ' ')), '| publications:', await p.$$eval('.feed-card', e => e.length));
  await p.screenshot({ path: 'reseau-profil-' + lang + '.png', fullPage: true });
  // Abonnements
  await p.click('[data-pill-group="social"][data-pill="abonnements"]'); await p.waitForTimeout(400);
  console.log('suggestions:', await p.$$eval('.follow-card', e => e.map(x => x.innerText.replace(/\n/g, ' ')).slice(0, 4).join(' | ')));
  console.log('à découvrir:', await p.$$eval('.feed-card .wall-post-text', e => e.map(x => x.innerText).join(' | ')));
  await p.screenshot({ path: 'reseau-suivis-' + lang + '.png', fullPage: true });
  console.log('sous-onglets:', await p.$$eval('[data-cpill-group="suivislist"], .sub-pill-btn', e => e.map(x => x.innerText).join(' / ')));
  await p.click('[data-action="repost"]'); await p.waitForTimeout(500);
  console.log('republié:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.author === 'Alex' && w.repostOf).map(w => [w.repostOf.author, w.repostOf.text]))));
  await p.click('.follow-card [data-action="quick-follow"]'); await p.waitForTimeout(500);
  console.log('abonnements:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.follows).filter(f => f.follower === 'Alex').map(f => f.followee))));
  // Fiche de Luca (non ami)
  await p.click('[data-open-person="Luca"]'); await p.waitForTimeout(600);
  console.log('fiche Luca:', await p.$eval('.social-counts', e => e.innerText.replace(/\n/g, ' ')), '| bouton:', await p.$eval('.follow-btn', e => e.innerText).catch(() => 'aucun'), '| publications:', await p.$$eval('.feed-card .wall-post-text', e => e.length));
  await p.screenshot({ path: 'reseau-fiche-' + lang + '.png', fullPage: true });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
