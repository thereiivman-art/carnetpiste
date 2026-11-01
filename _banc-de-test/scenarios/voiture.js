// Mode voiture : Mon compte › Profil › « Je roule en Voiture ».
// Le vocabulaire suit (Ma moto → Ma voiture), la fiche réglages devient
// celle d'une voiture (géométrie, aéro), les records MotoGP disparaissent,
// et les classements ne comparent qu'entre pilotes voiture (Sam roule en
// moto : ses chronos sortent des comparaisons ; les miens restent).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  const sessionsSeen = () => p.evaluate(() => new Promise(r => setTimeout(() => r(document.getElementById('root').innerText.indexOf('Sam') !== -1), 50)));
  await p.click('#settings-toggle'); await p.waitForTimeout(400);
  await p.click('[data-profile-tab="profil"]').catch(() => {}); await p.waitForTimeout(300);
  await p.click('[data-cpill-group="profil"][data-cpill="moto"]').catch(() => {}); await p.waitForTimeout(300);
  console.log('choix:', await p.$$eval('[data-action="set-discipline"]', e => e.map(x => x.innerText + (x.classList.contains('active') ? '✓' : '')).join(' / ')));
  await p.click('[data-action="set-discipline"][data-discipline="auto"]'); await p.waitForTimeout(700);
  console.log('stocké:', await p.evaluate(() => firebase.firestore().collection('users').doc(firebase.auth().currentUser.uid).get().then(d => d.data().discipline)));
  console.log('libellés profil:', await p.$$eval('[data-cpill-group="profil"]', e => e.map(x => x.innerText).join(' / ')), '|', await p.$eval('label[for="profile-bike"]', e => e.innerText).catch(() => '?'), '|', await p.$eval('#profile-bike', e => e.placeholder).catch(() => '?'));
  // Page d'un roulage passé : onglets, réglages, records
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]').catch(() => {}); await p.waitForTimeout(300);
  await p.locator('#root [data-open-outing]:visible', { hasText: /Mugello/ }).first().click().catch(() => {}); await p.waitForTimeout(800);
  console.log('onglets roulage:', await p.$$eval('[data-pill-group="outing"]', e => e.map(x => x.innerText).join(' / ')));
  await p.click('[data-pill-group="outing"][data-pill="moto"]').catch(() => {}); await p.waitForTimeout(500);
  console.log('réglages:', await p.$eval('#root', e => (e.innerText.match(/(Amortos AV|Front dampers|Fourche|Fork)[^·\n]*/) || ['?'])[0]));
  await p.click('[data-pill-group="outing"][data-pill="infos"]').catch(() => {}); await p.waitForTimeout(400);
  console.log('records MotoGP visibles:', await p.evaluate(() => /MotoGP/.test(document.getElementById('root').innerText)));
  // Classements : chronos d'autres pilotes moto exclus
  const counts = await p.evaluate(() => new Promise(r => firebase.firestore().collection('sessions').get().then(s => r(s.docs.length))));
  console.log('chronos en base:', counts);
  await p.click('.subnav-btn[data-view="stats"]').catch(() => {}); await p.waitForTimeout(500);
  console.log('Sam dans les stats/classements:', await sessionsSeen());
  // Nouveau chrono : marqué voiture
  await p.click('.bottom-nav-main'); await p.waitForTimeout(500);
  if (await p.$('#f-laps')) {
    await p.type('#f-laps', '1:40.500'); await p.click('#submit-btn'); await p.waitForTimeout(500);
    // Garde-fou de date (pas de roulage aujourd'hui sur ce circuit) : « Oui, aujourd'hui ».
    if (await p.$('.mini-sheet')) { await p.click('.mini-sheet [data-pick-date].primary'); await p.waitForTimeout(700); }
    if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.waitForTimeout(300); }
    console.log('nouveau chrono:', await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => { const x = s.docs.map(d => d.data()).filter(d => d.laps && d.laps.indexOf(100.5) !== -1)[0]; return x ? (x.discipline || 'moto') : 'absent'; })));
  }
  // Retour en moto
  await p.click('#settings-toggle'); await p.waitForTimeout(400);
  await p.click('[data-profile-tab="profil"]').catch(() => {}); await p.waitForTimeout(300);
  await p.click('[data-cpill-group="profil"][data-cpill="moto"]').catch(() => {}); await p.waitForTimeout(300);
  await p.click('[data-action="set-discipline"][data-discipline="moto"]'); await p.waitForTimeout(600);
  console.log('retour moto:', await p.$$eval('[data-cpill-group="profil"]', e => e.map(x => x.innerText).join(' / ')));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
