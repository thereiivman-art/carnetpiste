// Story au nom d'un team :
// 1. Alex, Team Leader de t1, publie « en tant que » son team ;
// 2. une story de t2 (publiée par son leader) apparaît chez Alex, adhérent
//    de t2, avec le nom et l'avatar du team ; « Voir le team » ouvre sa page ;
// 3. adhérent : pas de bouton « Ne plus suivre », un badge Adhérent.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 380, height: 800 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.evaluate(() => {
    const db = firebase.firestore();
    return Promise.all([
      db.collection('follows').add({ follower: 'Alex', followee: 't2', followeeType: 'team', followerUid: firebase.auth().currentUser.uid, tier: 'adherent' }),
      db.collection('wallPosts').doc('tst2').set({ id: 'tst2', author: 'Sam', authorUid: 'u2', audience: 'all', story: true, asTeam: true, teamId: 't2', photoURL: 'icons/icon-192.png', text: 'Roulage club samedi', createdAt: Date.now() - 3600e3 })
    ]);
  });
  await p.waitForTimeout(500);
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="social"][data-pill="fil"]'); await p.waitForTimeout(300);
  console.log('rangée:', await p.$$eval('.story-bubble', e => e.map(x => x.innerText.replace(/\n/g, ' ') + (x.classList.contains('team-story') ? '[team]' : '')).join(' | ')));
  await p.setInputFiles('#story-input', require('path').join(__dirname, '../../icons/icon-512.png')); await p.waitForTimeout(1200);
  console.log('choix:', await p.$$eval('.story-as-team option', e => e.map(x => x.innerText).join(', ')));
  await p.selectOption('.story-as-team', 't1');
  console.log('« dans mon fil » masqué:', await p.$eval('.story-also-feed', e => e.closest('label').hidden));
  await p.screenshot({ path: 'story-team-compose.png' });
  await p.click('.story-publish'); await p.waitForTimeout(500);
  console.log('stocké:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.asTeam).map(w => [w.author, w.teamId]))));
  console.log('rangée après:', await p.$$eval('.story-bubble', e => e.map(x => x.innerText.replace(/\n/g, ' ') + (x.classList.contains('team-story') ? '[team]' : '')).join(' | ')));
  const last = await p.$$eval('.story-bubble.team-story', e => e[e.length - 1].getAttribute('data-index'));
  await p.click('.story-bubble[data-index="' + last + '"]'); await p.waitForTimeout(400);
  console.log('visionneuse:', await p.$eval('.story-overlay', e => e.innerText.replace(/\n/g, ' | ')), '| j\'aime:', !!(await p.$('.story-like')), '| vues:', !!(await p.$('[data-views-for]')));
  await p.screenshot({ path: 'story-team-view.png' });
  await p.click('.story-profile'); await p.waitForTimeout(500);
  await p.screenshot({ path: 'story-team-page.png' });
  console.log('page ouverte:', await p.evaluate(() => (document.querySelector('.team-hero, .team-page, #root .card') || {}).innerText.split('\n').slice(0, 3).join(' / ')), '| ne plus suivre:', await p.$$eval('[data-action="unfollow-team"]', e => e.length), '| badge adhérent:', await p.$$eval('.adherent-badge', e => e.length));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
