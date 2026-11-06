// Page d'un roulage : boutons d'un seul mot, plus de « Partager », et
// « Rejoindre » quand on n'est pas inscrit (direct pour un roulage perso,
// demande au Team Leader pour un roulage de team, puis « Demandé »).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  const open = async (re) => {
    await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
    await p.click('.subnav-btn[data-view="carnet"]').catch(() => {}); await p.waitForTimeout(300);
    await p.click('.pill-btn[data-cards-mode="avenir"]').catch(() => {}); await p.waitForTimeout(400);
    await p.locator('#root :is(button,summary):visible', { hasText: /^(À venir|Upcoming) \(/ }).last().click().catch(() => {}); await p.waitForTimeout(400);
    await p.locator(':is(.event-row,.outing-row):visible', { hasText: re }).first().click();
    await p.waitForTimeout(700);
  };
  const acts = () => p.$$eval('.outing-actions button', e => e.map(x => x.innerText.trim() + (x.disabled ? ' (inactif)' : '')).join(' | '));
  await open(/Barcelon/);
  console.log('inscrit:', await acts());
  // Roulage perso où Alex n'est pas : rejoindre directement
  await p.evaluate(() => firebase.firestore().collection('events').doc('e7').update({ riders: ['Sam'] }));
  await p.waitForTimeout(400);
  await open(/Jerez/);
  console.log('pas inscrit (perso):', await acts());
  await p.click('.outing-actions [data-action="join-roulage-link"]'); await p.waitForTimeout(700);
  console.log('après Rejoindre:', JSON.stringify(await p.evaluate(() => firebase.firestore().collection('events').doc('e7').get().then(d => d.data().riders))), '|', await acts());
  // Roulage de team (pas ouvert) : demande au Team Leader
  await p.evaluate(() => firebase.firestore().collection('events').doc('e8').update({ riders: ['Sam'], teamId: 'tX', eventVisibility: 'public' }));
  await p.waitForTimeout(400);
  await open(/Navarra/);
  console.log('pas inscrit (team):', await acts());
  await p.click('.outing-actions [data-action="join-roulage-link"]'); await p.waitForTimeout(700);
  const req = await p.evaluate(() => firebase.firestore().collection('eventJoinRequests').doc('e8_Alex').get().then(d => d.exists ? d.data() : null));
  console.log('demande:', req ? req.status + ' teamId=' + req.teamId : 'aucune', '| inscrit ?', JSON.stringify(await p.evaluate(() => firebase.firestore().collection('events').doc('e8').get().then(d => d.data().riders))));
  await p.waitForTimeout(500);
  console.log('ensuite:', await acts());
  await p.screenshot({ path: 'rejoindre-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
