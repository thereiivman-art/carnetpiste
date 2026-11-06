// Roulages : personne n'est inscrit sans son accord.
// 1. Alex modifie son roulage de Barcelone et y ajoute Tom : Tom reçoit une
//    invitation (eventInvites), il n'est PAS inscrit.
// 2. Sam a invité Alex à un roulage : Alex l'accepte depuis ses
//    notifications et se retrouve inscrit.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]').catch(() => {}); await p.waitForTimeout(300);
  await p.click('.pill-btn[data-cards-mode="avenir"]').catch(() => {}); await p.waitForTimeout(500);
  await p.evaluate(() => document.querySelectorAll('#root details').forEach(d => { d.open = true; }));
  await p.locator('#root :is(button,summary):visible', { hasText: /^(À venir|Upcoming) \(/ }).last().click().catch(() => {}); await p.waitForTimeout(400);
  let opened = true;
  await p.locator(':is(.event-row,.outing-row):visible', { hasText: /Barcelon/ }).first().click().catch(() => { opened = false; });
  await p.waitForTimeout(600);
  console.log('roulage ouvert:', opened);
  await p.click('#edit-event-btn'); await p.waitForTimeout(500);
  await p.fill('#ev-riders-search', 'Tom'); await p.waitForTimeout(400);
  console.log('puces:', await p.$$eval('.chip-row .team-link-chip', e => e.map(x => x.innerText.replace(/[×\n]/g, ' ').replace(/\s+/g, ' ').trim()).join(' | ')));
  await p.click('#event-form button[type="submit"]'); await p.waitForTimeout(900);
  const st = await p.evaluate(() => new Promise(res => {
    const db = firebase.firestore();
    Promise.all([db.collection('events').doc('e1').get(), db.collection('eventInvites').doc('e1_Tom').get()]).then(([e, i]) => res({ riders: (e.data() || {}).riders, invitation: i.exists ? i.data().status : 'aucune' }));
  }));
  console.log('après envoi:', JSON.stringify(st));

  // Invitation reçue par Alex
  await p.evaluate(() => firebase.firestore().collection('eventInvites').doc('e3_Alex').set({ eventId: 'e3', teamId: null, circuit: 'Le Mans', dateStart: '', from: 'Sam', to: 'Alex', status: 'pending', createdAt: Date.now() }));
  await p.evaluate(() => firebase.firestore().collection('events').doc('e3').update({ riders: ['Sam'] }));
  await p.waitForTimeout(500);
  await p.click('#notifications-toggle'); await p.waitForTimeout(500);
  console.log('notification:', await p.$eval('[data-action="event-invite-accept"]', e => e.closest('.friend-row').innerText.replace(/\n/g, ' | ')).catch(() => 'absente'));
  await p.click('[data-action="event-invite-accept"]').catch(() => {}); await p.waitForTimeout(900);
  const st2 = await p.evaluate(() => new Promise(res => {
    const db = firebase.firestore();
    Promise.all([db.collection('events').doc('e3').get(), db.collection('eventInvites').doc('e3_Alex').get()]).then(([e, i]) => res({ riders: (e.data() || {}).riders, invitation: i.exists ? i.data().status : 'supprimée' }));
  }));
  console.log('après acceptation:', JSON.stringify(st2));
  await p.screenshot({ path: 'invitations-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
