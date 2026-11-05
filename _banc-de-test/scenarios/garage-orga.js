// Garage (Carnet › Garage, pneus de l'époque sous les chronos d'un roulage),
// podium « Tous » (chronos vérifiés), trophées acquis, événements de l'orga,
// fiche accompagnant, personnalisation débloquée par les pneus.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const page = async (hash) => { const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message)); await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr') + (hash || '')); await p.waitForTimeout(1600); return p; };
  const p = await page();
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  console.log('Carnet:', await p.$$eval('.subnav.main-subnav .subnav-btn', e => e.map(x => x.innerText).join(' / ')));
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(300); await p.click('[data-pill-group="moi"][data-pill="garage"]'); await p.waitForTimeout(500);
  console.log('garage:', await p.$eval('.garage-head', e => e.innerText.replace(/\n/g, ' ')).catch(() => 'absent'), '| pneus:', !!(await p.$('.tyre-card')));
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(300);
  await p.click('[data-pill-group="moi"][data-pill="stats"]'); await p.waitForTimeout(300); await p.click('[data-moi-jump="podium"]'); await p.waitForTimeout(300);
  await p.evaluate(() => firebase.firestore().collection('sessions').doc('cv1').set({ id: 'cv1', rider: 'Luca', circuit: 'Mugello', date: '2026-09-01', laps: [110.5], certifiedBy: 'Team Piste', createdAt: Date.now() }));
  await p.waitForTimeout(300);
  await p.click('[data-podium-scope="tous"]'); await p.waitForTimeout(300);
  console.log('podium tous:', await p.$$eval('.global-podium-row', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  console.log('trophées acquis enregistrés:', await p.evaluate(() => new Promise(r => setTimeout(r, 1800)).then(() => firebase.firestore().collection('users').doc(firebase.auth().currentUser.uid).get()).then(d => Object.keys(d.data().trophiesAcquired || {}).length)));
  // Personnalisation débloquée
  const lk = await page('&look=1');
  await lk.click('#profile-toggle'); await lk.waitForTimeout(400);
  await lk.click('.ph-cover[data-own-cover]').catch(() => {}); await lk.waitForTimeout(400);
  console.log('couleurs à débloquer:', await lk.$$eval('.look-sw.locked', e => e.length), '| débloquées:', await lk.$$eval('.look-sw:not(.locked)', e => e.length));
  // Accompagnant
  const a = await page('&role=acc');
  await a.click('.bottom-nav-btn:nth-child(1)'); await a.waitForTimeout(300);
  console.log('Carnet accompagnant:', await a.$$eval('.subnav.main-subnav .subnav-btn', e => e.map(x => x.innerText).join(' / ')));
  await a.click('.bottom-nav-btn:nth-child(3)'); await a.waitForTimeout(300);
  await a.click('#profile-toggle'); await a.waitForTimeout(400);
  await a.click('[data-pill-group="person"][data-pill="fiche"]').catch(() => {}); await a.waitForTimeout(300);
  console.log('fiche accompagnant:', await a.$eval('.person-kpis', e => e.innerText.replace(/\n/g, ' ')).catch(() => 'absente'));
  // Organisateur
  const o = await page('&role=orga');
  await o.click('.bottom-nav-btn:nth-child(1)'); await o.waitForTimeout(300);
  console.log('Carnet orga:', await o.$$eval('.subnav.main-subnav .subnav-btn', e => e.map(x => x.innerText).join(' / ')));
  await o.click('.subnav-btn[data-view="orgaev"]').catch(() => {}); await o.waitForTimeout(400);
  console.log('événements orga:', await o.$eval('.person-kpis', e => e.innerText.replace(/\n/g, ' ')).catch(() => 'absent'), '|', await o.$$eval('.orga-ev-row strong', e => e.map(x => x.innerText).join(', ')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
