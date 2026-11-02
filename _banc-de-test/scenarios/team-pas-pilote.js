// Un team n'est pas un compte pilote : appuyer sur son avatar (ou ouvrir
// son nom comme une fiche) mène à la page du team, jamais à une fiche
// « PILOTE » vide.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.evaluate(() => firebase.firestore().collection('teams').doc('t2').update({ visibility: 'all' }));
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="team"]'); await p.waitForTimeout(400);
  console.log('avatars de team avec lien pilote:', await p.$$eval('.team-tile .mini-avatar[data-person]', e => e.length));
  await p.evaluate(() => { const s = document.createElement('span'); s.className = 'mini-avatar'; s.setAttribute('data-person', 'Mototeam95'); document.getElementById('root').appendChild(s); s.click(); });
  await p.waitForTimeout(600);
  console.log('nom du team ouvert →', await p.evaluate(() => document.querySelector('.person-page') ? 'fiche pilote' : ((document.querySelector('#root').innerText.match(/Mototeam95/) ? 'page du team' : '?'))));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
