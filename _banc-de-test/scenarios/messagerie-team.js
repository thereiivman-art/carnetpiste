// Messages à un team :
// 1. Alex écrit à Mototeam95 depuis Messages › Nouveau message ;
// 2. Sam écrit à Team Piste, dont Alex est Team Leader : la conversation
//    « Sam à Team Piste » arrive chez Alex, qui répond au nom du team ;
// 3. la réponse d'un leader de Mototeam95 arrive chez Alex (non lue).
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 380, height: 800 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  const me = await p.evaluate(() => firebase.auth().currentUser.uid);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="social"][data-pill="messages"]'); await p.waitForTimeout(300);
  await p.click('[data-action="dm-new"]'); await p.waitForTimeout(300);
  console.log('nouveau message, teams:', await p.$$eval('[data-dm-pick^="team:"]', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(', ')));
  await p.fill('#dm-pick-q', 'moto'); await p.waitForTimeout(200);
  console.log('recherche « moto »:', await p.$$eval('[data-dm-pick]', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(', ')));
  await p.click('[data-dm-pick="team:t2"]'); await p.waitForTimeout(400);
  console.log('fil vide:', await p.$eval('.dm-thread', e => e.innerText.replace(/\n/g, ' | ')));
  await p.fill('#dm-text', 'Bonjour, il reste de la place samedi ?'); await p.click('#dm-form button[type="submit"]'); await p.waitForTimeout(400);
  console.log('stocké:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.teamMessages || {}).map(m => [m.convId.replace(/__.*/, '__moi'), m.userName, m.asTeam, m.text]))));
  // Sam écrit à Team Piste ; un leader de Mototeam95 répond à Alex.
  await p.evaluate((me) => { const db = firebase.firestore(), t = Date.now(); return Promise.all([
    db.collection('teamMessages').doc('tm1').set({ convId: 't1__u2', teamId: 't1', teamName: 'Team Piste', userUid: 'u2', userName: 'Sam', from: 'u2', fromName: 'Sam', asTeam: false, text: 'Je peux rejoindre le team ?', createdAt: t - 60000 }),
    db.collection('teamMessages').doc('tm2').set({ convId: 't2__' + me, teamId: 't2', teamName: 'Mototeam95', userUid: me, userName: 'Alex', from: 'u7', fromName: 'William', asTeam: true, text: 'Oui, 3 places !', createdAt: t + 1000 })
  ]); }, me);
  await p.waitForTimeout(500);
  console.log('fil team ouvert:', await p.$$eval('.dm-msg', e => e.map(x => (x.classList.contains('mine') ? 'moi: ' : 'eux: ') + x.querySelector('.dm-bubble').innerText).join(' / ')));
  await p.click('[data-action="dm-back"]'); await p.waitForTimeout(300);
  console.log('conversations:', await p.$$eval('.dm-conv', e => e.map(x => x.innerText.replace(/\n/g, ' ') + (x.classList.contains('unread') ? ' [non lu]' : '')).join(' || ')));
  await p.screenshot({ path: 'messagerie-team-liste.png' });
  await p.click('.dm-conv[data-name="tu:t1__u2"]'); await p.waitForTimeout(400);
  console.log('côté leader:', await p.$eval('.dm-thread', e => e.innerText.replace(/\n/g, ' | ')));
  await p.fill('#dm-text', 'Bienvenue Sam !'); await p.click('#dm-form button[type="submit"]'); await p.waitForTimeout(400);
  console.log('réponse stockée:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.teamMessages).filter(m => m.teamId === 't1' && m.asTeam).map(m => [m.fromName, m.userName, m.text]))));
  await p.screenshot({ path: 'messagerie-team-leader.png' });
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
