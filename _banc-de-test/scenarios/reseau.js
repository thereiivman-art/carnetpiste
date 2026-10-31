// Communauté › Réseau : Fil (stories, « Quoi de neuf ? », réactions emoji,
// commentaires, republier sur tous les posts, liens profil / circuit),
// Profil (= fiche pilote + pilotes à suivre + publier), abonnements via
// les compteurs, fiche d'un pilote non ami. Coaching dans Carnet.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const goFil = async () => {
    await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
    await p.click('.subnav-btn[data-view="social"]').catch(() => {}); await p.waitForTimeout(300);
    await p.click('[data-pill-group="social"][data-pill="fil"]'); await p.waitForTimeout(300);
  };
  await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1'); await p.waitForTimeout(1700);
  console.log('carnet:', await p.$$eval('.subnav-btn', e => e.map(x => x.innerText).join(' / ')));
  await goFil();
  console.log('communauté:', await p.$$eval('.subnav-btn', e => e.map(x => x.innerText).join(' / ')), '| pastilles:', await p.$$eval('[data-pill-group="social"]', e => e.map(x => x.innerText).join(' / ')));
  console.log('stories:', await p.$$eval('.story-bubble', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(', ')));
  console.log('« Gaz ! » restant:', await p.$$eval('.reaction-btn', e => e.filter(x => /Gaz/.test(x.innerText)).length), '| pieds de post:', await p.$$eval('.feed-card', e => e.filter(c => c.querySelector('.post-comment-form')).length) + '/' + await p.$$eval('.feed-card', e => e.length));
  // Réagir avec 🔥 sur un roulage
  const ride = await p.$('.feed-card:has(.feed-ride) .reaction-open');
  if (ride) { await ride.click(); await p.waitForTimeout(200); await p.click('.feed-card:has(.feed-ride) .reaction-picker:not([hidden]) [data-emoji="🔥"]'); await p.waitForTimeout(400); }
  console.log('réaction stockée:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.postReactions || {}).map(r => [r.postId.slice(0, 30), r.emoji]))));
  // Republier un roulage
  const rp = await p.$('.feed-card:has(.feed-ride) [data-action="repost-item"]');
  if (rp) { await rp.click(); await p.waitForTimeout(400); }
  console.log('republié:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.author === 'Alex' && w.repostOf).map(w => [w.repostOf.kind, w.repostOf.circuit]))));
  // Commenter un message
  const form = await p.$('form[data-action="comment-form"]');
  if (form) { await form.$eval('[data-comment-text]', e => e.value = 'Je prends ma place !'); await form.$eval('button', e => e.click()); await p.waitForTimeout(400); }
  console.log('commentaire:', await p.evaluate(() => Object.values(window.__MOCK_DATA.postComments || {}).filter(c => c.author === 'Alex').length));
  await p.screenshot({ path: 'reseau-fil-' + lang + '.png', fullPage: true });
  // Composer : visibilité repliée, Public / Mes amis
  await p.click('#wall-composer-toggle'); await p.waitForTimeout(300);
  console.log('visibilité:', await p.$eval('.audience-more', e => [e.open, e.querySelector('summary').innerText, [...e.querySelectorAll('option')].map(o => o.innerText).join('/')].join(' | ')));
  // Circuit cliquable
  await p.click('.feed-card .feed-ride-circuit'); await p.waitForTimeout(500);
  console.log('circuit ouvert:', await p.$eval('.subnav-btn.active', e => e.innerText).catch(() => '?'));
  // Avatar cliquable → profil
  await goFil();
  await p.click('.feed-card .wall-post-head .mini-avatar[data-person="Sam"]').catch(() => {}); await p.waitForTimeout(500);
  console.log('avatar → fiche de:', await p.$eval('.person-name, .ph-name', e => e.innerText).catch(() => '?'));
  // Profil (photo en haut à gauche)
  await p.click('.hello-text'); await p.waitForTimeout(500);
  console.log('profil:', await p.$eval('.bottom-nav-btn.active', e => e.innerText.trim()), '|', await p.$eval('[data-pill-group="social"].active', e => e.innerText).catch(() => '?'), '| à suivre sur le profil:', await p.$$eval('.follow-card', e => e.length), '| composer en bas de fiche:', !!(await p.$('#wall-composer-toggle, #wall-post-form')));
  await p.screenshot({ path: 'reseau-profil-' + lang + '.png', fullPage: true });
  console.log('sous-onglets profil:', await p.$$eval('[data-pill-group="person"]', e => e.map(x => x.innerText).join(' / ')));
  await p.click('[data-pill-group="person"][data-pill="monfil"]'); await p.waitForTimeout(400);
  console.log('mon fil:', !!(await p.$('#wall-composer-toggle, #wall-post-form')), '|', await p.$eval('.feed-section-title', e => e.innerText).catch(() => '?'), '| republications:', await p.$$eval('.repost-box', e => e.length));
  await p.screenshot({ path: 'reseau-monfil-' + lang + '.png', fullPage: true });
  await p.click('[data-pill-group="person"][data-pill="fiche"]'); await p.waitForTimeout(300);
  // Abonnements par les compteurs
  await p.click('.social-count[data-list="abonnes"]'); await p.waitForTimeout(400);
  console.log('suggestions via compteurs:', await p.$$eval('.follow-card strong', e => e.map(x => x.innerText).slice(0, 3).join(', ')));
  console.log('abonnés:', await p.$$eval('[data-cpill-section="suivislist:abonnes"] .people-row strong', e => e.map(x => x.innerText).join(', ')));
  await p.click('.follow-card [data-action="quick-follow"]'); await p.waitForTimeout(400);
  console.log('abonnements:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.follows).filter(f => f.follower === 'Alex').map(f => f.followee))));
  await p.click('[data-open-person="Luca"]'); await p.waitForTimeout(600);
  console.log('fiche Luca:', await p.$eval('.social-counts', e => e.innerText.replace(/\n/g, ' ')), '| bouton:', await p.$eval('.follow-btn', e => e.innerText).catch(() => 'aucun'), '| publications:', await p.$$eval('.feed-card .wall-post-text', e => e.length));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
