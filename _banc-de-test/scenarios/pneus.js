// Pneus : popup du jour (calendrier 30 jours), récolte +10, compteur en
// haut, gains plafonnés (publier +10, liker +1, commenter +1 ; 100/jour),
// points du profil rempli, et réponse à un commentaire dans la même boîte.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr') + '&pneus=1'); await p.waitForTimeout(3200);
  console.log('popup du jour:', !!(await p.$('.pneus-sheet')), '| à quoi ça sert:', !!(await p.$('.pneus-why')), '| cases:', await p.$$eval('.pneus-day', e => e.length), '| aujourd\'hui:', await p.$eval('.pneus-day.today', e => e.innerText.replace(/\n/g, ' ')).catch(() => '?'));
  await p.screenshot({ path: 'pneus-calendrier.png' });
  const before = await p.$eval('.header-pneus b', e => +e.innerText);
  await p.click('[data-pneus="collect"]'); await p.waitForTimeout(300);
  console.log('après récolte:', await p.$eval('.pneus-total b', e => e.innerText), '| bouton récolter:', !!(await p.$('[data-pneus="collect"]')), '| case J1 faite:', await p.$$eval('.pneus-day.done', e => e.length));
  await p.click('[data-mini-close]'); await p.waitForTimeout(300);
  console.log('compteur:', before, '→', await p.$eval('.header-pneus b', e => e.innerText));
  // Publier : +10, puis popup Story / Partager
  await p.click('#wall-composer-toggle'); await p.waitForTimeout(300);
  console.log('case « autres réseaux » dans le formulaire:', !!(await p.$('#wall-post-form .share-elsewhere')));
  await p.fill('#wall-post-text', 'Test pneus'); await p.click('#wall-post-form button[type="submit"]'); await p.waitForTimeout(600);
  console.log('popup après publication:', await p.$$eval('.after-publish button', e => e.map(x => x.innerText).join(' / ')));
  await p.click('[data-after="story"]'); await p.waitForTimeout(400);
  console.log('mise en story:', await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.story && w.text === 'Test pneus').length));
  await p.click('[data-mini-close]'); await p.waitForTimeout(1600);
  const st = await p.evaluate(() => firebase.firestore().collection('users').doc(firebase.auth().currentUser.uid).get().then(d => d.data().pneus || {}));
  console.log('enregistré: bank', st.bank, '| du jour', st.capped, '| cal', JSON.stringify(st.cal), '| total', st.total);
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
