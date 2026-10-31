// Audience d'un motoclub dans les réglages du team (leader) ; « Bientôt en
// piste » sur la fiche d'un pilote : ami (par défaut), non ami seulement
// s'il a choisi « Tout le monde » ; réglage dans Mon compte › Vie privée.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.evaluate(async () => {
    const db = firebase.firestore(), day = new Date().toISOString().slice(0, 10);
    await db.collection('postViews').doc('t1').set({ postId: 'tp1', owner: 'Sam', viewer: 'Luca', day, teamId: 't1' });
    await db.collection('postViews').doc('t2').set({ postId: 'tp1', owner: 'Sam', viewer: 'Tom', day, teamId: 't1' });
    await db.collection('profileViews').doc('t3').set({ postId: 'team:t1', owner: 'team:t1', viewer: 'Luca', day, teamId: 't1' });
  });
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(500);
  await p.click('.subnav-btn[data-view="team"]'); await p.waitForTimeout(400);
  await p.getByText('Team Piste').first().click(); await p.waitForTimeout(700);
  await p.click('[data-action="team-settings-open"]'); await p.waitForTimeout(800);
  console.log('audience du team:', await p.$$eval('.aud-card .aud-tile', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')).catch(() => 'absente'));
  await p.screenshot({ path: 'audience-team-' + lang + '.png', fullPage: true });
  // Fiche de Sam (ami) : sous-onglet Bientôt en piste
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="social"]'); await p.waitForTimeout(300);
  await p.evaluate(() => { const b = [...document.querySelectorAll('[data-person-link="Sam"], [data-name="Sam"]')][0]; if (b) b.click(); });
  await p.waitForTimeout(600);
  console.log('fiche Sam, pastilles:', await p.$$eval('[data-pill-group="person"]', e => e.map(x => x.innerText).join(' / ')));
  await p.click('[data-pill-group="person"][data-pill="bientot"]').catch(() => {}); await p.waitForTimeout(300);
  console.log('Sam bientôt:', await p.$$eval('.feed-upcoming-row strong', e => e.map(x => x.innerText).join(', ')));
  // Réglage Vie privée
  await p.click('#settings-toggle'); await p.waitForTimeout(300);
  await p.click('[data-profile-tab="reglages"]'); await p.waitForTimeout(300);
  await p.click('[data-pill-group="settings"][data-pill="confidentialite"]'); await p.waitForTimeout(300);
  await p.selectOption('#profile-share-upcoming', 'public'); await p.waitForTimeout(500);
  console.log('réglage stocké:', await p.evaluate(() => window.__MOCK_DATA.users.u1.shareUpcoming));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
