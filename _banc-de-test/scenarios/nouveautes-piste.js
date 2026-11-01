// 1. État de la piste (sèche / humide / pluie) sur un chrono ; un tour sous
//    la pluie ne fait pas un record.
// 2. « X chronos en attente d'envoi » hors ligne, puis « Chronos envoyés ✓ ».
// 3. « Créer » transforme une journée sans roulage en roulage.
// 4. QR paddock : choix du groupe, lien &g=B ; à l'arrivée par ce lien,
//    « J'y vais » inscrit le pilote avec ce groupe.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&jourj=1'); await p.waitForTimeout(1600);
  // 1. Pluie
  await p.evaluate(() => { const d = document.querySelector('.cf-more'); if (d) d.open = true; });
  console.log('piste (dans ⋯):', await p.$$eval('.cf-more .track-opt', e => e.map(x => x.title + (x.querySelector('svg') ? ' (icône)' : '') + (x.querySelector('input').checked ? '✓' : '')).join(' / ')));
  await p.click('.track-opt:has(input[value="pluie"])');
  await p.fill('#f-laps', '1:05.000'); await p.click('#submit-btn'); await p.waitForTimeout(600);
  if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.waitForTimeout(300); }
  const wet = await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => { const x = s.docs.map(d => d.data()).filter(d => d.laps && d.laps.indexOf(65) !== -1)[0]; return x ? x.track : 'absent'; }));
  console.log('chrono pluie stocké:', wet, '| étiquette:', await p.$eval('#root', e => /Pluie|Rain/.test(e.innerText)), '| tag:', !!(await p.$('.chrono-progress .track-tag, .chrono-progress [class*="track-"]')));
  // 2. En attente d'envoi
  await ctx.setOffline(true); await p.waitForTimeout(200);
  await p.evaluate(() => firebase.firestore().collection('sessions').doc('pend1').set({ id: 'pend1', rider: 'Alex', date: new Date().toISOString().slice(0, 10), circuit: 'Carole', laps: [72.5], createdAt: Date.now(), __pending: true }));
  await p.waitForTimeout(500);
  console.log('hors ligne:', await p.$eval('.pending-banner', e => e.innerText).catch(() => 'pas de bandeau'));
  await ctx.setOffline(false); await p.waitForTimeout(200);
  await p.evaluate(() => firebase.firestore().collection('sessions').doc('pend1').update({ __pending: false }));
  await p.waitForTimeout(500);
  console.log('retour réseau:', await p.$$eval('.toast', e => e.map(x => x.innerText).filter(x => /envoy|sent/.test(x)).join(' ') || 'pas de message'), '| bandeau:', !!(await p.$('.pending-banner')));
  // 3. Créer le roulage
  await p.evaluate(() => firebase.firestore().collection('sessions').doc('solo').set({ id: 'solo', rider: 'Alex', date: '2026-06-14', circuit: 'Lédenon', laps: [101.2], createdAt: Date.now() }));
  await p.waitForTimeout(400);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]').catch(() => {}); await p.waitForTimeout(300);
  await p.click('#carnet-history-toggle').catch(() => {}); await p.waitForTimeout(300);
  await p.locator('#root [data-open-outing="Lédenon"]:visible').first().click(); await p.waitForTimeout(600);
  console.log('journée sans roulage:', await p.$$eval('.outing-actions > button', e => e.map(x => x.innerText.trim()).join(' | ')));
  await p.click('[data-action="outing-create-event"]'); await p.waitForTimeout(700);
  const created = await p.evaluate(() => Promise.all([firebase.firestore().collection('events').get(), firebase.firestore().collection('sessions').doc('solo').get()]).then(([e, s]) => { const ev = e.docs.map(d => d.data()).filter(x => x.circuit === 'Lédenon' && x.dateStart === '2026-06-14')[0]; return ev ? 'roulage ' + JSON.stringify(ev.riders) + ' · chrono relié: ' + (s.data().eventId === ev.id) : 'aucun'; }));
  console.log('après Créer:', created, '| avertissement:', !!(await p.$('.unlinked-warning')));
  // 4. QR paddock (roulage perso de Barcelone)
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]').catch(() => {}); await p.waitForTimeout(300);
  await p.click('.pill-btn[data-view="event"]').catch(() => {}); await p.waitForTimeout(300);
  await p.locator('#root :is(button,summary):visible', { hasText: /^(À venir|Upcoming) \(/ }).last().click().catch(() => {}); await p.waitForTimeout(300);
  await p.locator('.event-row:visible', { hasText: /Barcelon/ }).first().click(); await p.waitForTimeout(600);
  await p.click('[data-action="outing-paddock-qr"]'); await p.waitForTimeout(400);
  await p.click('[data-qr-group="B"]'); await p.waitForTimeout(300);
  console.log('QR:', await p.$eval('#paddock-qr-caption', e => e.innerText), '|', await p.$eval('#paddock-qr-link', e => /roulage=e1.*&g=B/.test(e.innerText)));
  // Arrivée par un QR (roulage de Carole auquel Alex n'est pas inscrit, groupe B)
  const q = await ctx.newPage(); q.on('pageerror', e => errs.push(e.message));
  await q.goto(BASE + 'index.html?roulage=e9&g=B#lang=' + lang); await q.waitForTimeout(2000);
  console.log('bannière:', await q.$eval('.join-banner', e => e.innerText.split('\n')[0]).catch(() => 'absente'));
  await q.click('.join-banner [data-action="join-roulage-link"]').catch(() => {}); await q.waitForTimeout(800);
  console.log('inscrit avec groupe:', await q.evaluate(() => firebase.firestore().collection('events').doc('e9').get().then(d => { const e = d.data(); const g = e.riderGroups && e.riderGroups.Alex; return JSON.stringify(e.riders) + ' · ' + (g ? JSON.stringify(Object.values(g)[0]) : 'sans groupe'); })));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
