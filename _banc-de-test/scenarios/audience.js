// Audience (Carnet+) : Sam voit le message d'Alex dans son fil (vue comptée
// une fois par jour, jamais pour l'auteur), visite son profil ; Alex voit
// ensuite impressions, comptes touchés, visites et le kit média.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  // Vue réelle : défiler le fil suffit à compter les vues des posts des autres
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="social"][data-pill="fil"]'); await p.waitForTimeout(400);
  for (const y of [500, 900, 1300]) { await p.evaluate(y => window.scrollTo(0, y), y); await p.waitForTimeout(1500); }
  console.log('vues envoyées:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.postViews || {}).map(v => [v.owner, v.viewer, v.postId.slice(0, 24)]))));
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click('.feed-card .mini-avatar[data-person="Sam"]').catch(() => {}); await p.waitForTimeout(500);
  console.log('visite de profil:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.profileViews || {}).map(v => [v.owner, v.viewer]))));
  // Tableau de bord d'Alex (avec des vues d'autres comptes injectées)
  await p.evaluate(async () => {
    const db = firebase.firestore(), day = new Date().toISOString().slice(0, 10);
    await db.collection('postViews').doc('x1').set({ postId: 'fe1', owner: 'Alex', viewer: 'Sam', day });
    await db.collection('postViews').doc('x2').set({ postId: 'fe1', owner: 'Alex', viewer: 'Luca', day });
    await db.collection('profileViews').doc('x3').set({ postId: 'profile:Alex', owner: 'Alex', viewer: 'Luca', day });
  });
  await p.waitForTimeout(300);
  await p.click('.hello-text'); await p.waitForTimeout(500);
  await p.click('[data-pill-group="person"][data-pill="audience"]'); await p.waitForTimeout(500);
  console.log('audience:', await p.$$eval('.aud-tile', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  console.log('plus vues:', await p.$$eval('.aud-post', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  await p.screenshot({ path: 'audience-' + lang + '.png', fullPage: true });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
