// Messagerie privée : onglet Messages dans Communauté, écrire à un ami
// depuis sa fiche, recevoir une réponse (non lu), réglage « Qui peut
// m'écrire » et refus si le destinataire n'accepte personne.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 860 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(300);
  console.log('onglets Communauté:', await p.$$eval('.subnav.main-subnav [data-pill]', e => e.map(x => x.innerText).join(' / ')));
  await p.click('.feed-card .wall-post-head .mini-avatar[data-person="Sam"]').catch(() => {}); await p.waitForTimeout(600);
  console.log('fiche Sam, bouton Message:', !!(await p.$('[data-action="dm-open"]')));
  await p.click('[data-action="dm-open"]'); await p.waitForTimeout(500);
  await p.fill('#dm-text', 'Salut Sam, tu roules samedi ?'); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  console.log('envoyé:', await p.evaluate(() => firebase.firestore().collection('directMessages').get().then(s => s.docs.map(d => d.data()).map(m => m.fromName + '→' + m.toName + ' : ' + m.text + ' [' + m.members.join(',') + ']').join(' | '))));
  // Réponse de Sam
  await p.evaluate(() => { const me = firebase.auth().currentUser.uid; const m = [me, 'u2'].sort(); return firebase.firestore().collection('directMessages').doc('r1').set({ convId: m.join('__'), members: m, from: 'u2', fromName: 'Sam', toName: 'Alex', text: 'Oui, groupe B !', createdAt: Date.now() + 10 }); });
  await p.waitForTimeout(500);
  console.log('fil de discussion:', await p.$$eval('.dm-msg', e => e.map(x => (x.classList.contains('mine') ? 'moi: ' : 'Sam: ') + x.querySelector('.dm-bubble').innerText).join(' | ')));
  // Réaction emoji : appui sur la bulle de Sam, choix 🔥
  await p.click('.dm-msg:not(.mine) .dm-bubble'); await p.waitForTimeout(200);
  console.log('choix emoji:', await p.$$eval('.dm-react-picker button', e => e.map(x => x.innerText).join(' ')));
  await p.screenshot({ path: 'messagerie-reaction-choix-' + lang + '.png' });
  await p.click('.dm-react-picker [data-pick-emoji="🔥"]'); await p.waitForTimeout(400);
  console.log('réaction affichée:', await p.$$eval('.dm-react', e => e.map(x => x.innerText + (x.classList.contains('on') ? '✓' : '')).join(' ')), '| stockée:', await p.evaluate(() => firebase.firestore().collection('directMessages').doc('r1').get().then(d => JSON.stringify(d.data().reactions || {}))));
  await p.screenshot({ path: 'messagerie-reaction-' + lang + '.png' });
  await p.click('.dm-react'); await p.waitForTimeout(400);
  console.log('retirée:', await p.$$eval('.dm-react', e => e.length), '|', await p.evaluate(() => firebase.firestore().collection('directMessages').doc('r1').get().then(d => JSON.stringify(d.data().reactions || {}))));
  await p.click('[data-action="dm-back"]'); await p.waitForTimeout(400);
  console.log('conversations:', await p.$$eval('.dm-conv', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' || ')));
  await p.screenshot({ path: 'messagerie-' + lang + '.png' });
  // Réglage et refus
  await p.evaluate(() => firebase.firestore().collection('users').doc('u3').update({ dmPolicy: 'none' }));
  await p.waitForTimeout(300);
  await p.click('[data-action="dm-new"]'); await p.waitForTimeout(400);
  console.log('nouveau message, Tom proposé (refuse tout):', await p.$$eval('[data-dm-pick]', e => e.some(x => x.getAttribute('data-dm-pick') === 'Tom')), '| Sam proposé:', await p.$$eval('[data-dm-pick]', e => e.some(x => x.getAttribute('data-dm-pick') === 'Sam')));
  await p.click('[data-mini-close]'); await p.waitForTimeout(200);
  await p.click('#settings-toggle'); await p.waitForTimeout(400);
  await p.click('[data-profile-tab="reglages"]'); await p.waitForTimeout(300);
  await p.click('[data-pill-group="settings"][data-pill="confidentialite"]').catch(() => {}); await p.waitForTimeout(300);
  await p.selectOption('#dm-policy', 'followers'); await p.waitForTimeout(400);
  console.log('réglage enregistré:', await p.evaluate(() => firebase.firestore().collection('users').doc(firebase.auth().currentUser.uid).get().then(d => d.data().dmPolicy)));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
