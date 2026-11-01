// Garde-fous sur la date d'un chrono :
// 1. Chrono saisi sans roulage ce jour-là sur ce circuit → « Ces chronos
//    sont de quel jour ? » avec mes roulages passés ; choisir l'un d'eux
//    range le chrono à cette date (et le relie au roulage).
// 2. Une journée sans roulage (juste des chronos) se déplace ou se supprime.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-main'); await p.waitForTimeout(500);
  await p.click('#carnet-add-chrono, #add-chrono-toggle, .add-chrono-btn').catch(() => {}); await p.waitForTimeout(400);
  await p.evaluate(() => { const d = document.querySelector('.cf-more'); if (d) d.open = true; });
  await p.selectOption('#f-circuit', { label: 'Mugello' }).catch(async () => { await p.selectOption('#f-circuit', 'Mugello'); });
  await p.fill('#f-laps', '1:52.700'); await p.click('#submit-btn'); await p.waitForTimeout(500);
  console.log('question:', await p.$eval('.mini-sheet', e => e.innerText.replace(/\n/g, ' | ')).catch(() => 'aucune'));
  await p.click('.mini-sheet [data-pick-date]:not([data-pick-date="__other__"])'); await p.waitForTimeout(800);
  if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.waitForTimeout(300); }
  const saved = await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => { const x = s.docs.map(d => d.data()).filter(d => d.laps && d.laps.indexOf(112.7) !== -1)[0]; return x ? x.date + ' · ' + (x.eventId || 'sans roulage') : 'absent'; }));
  console.log('rangé au:', saved);
  // Journée sans roulage : chrono daté d'aujourd'hui puis « Oui, aujourd'hui »
  await p.click('.bottom-nav-main'); await p.waitForTimeout(400);
  await p.click('#carnet-add-chrono, #add-chrono-toggle, .add-chrono-btn').catch(() => {}); await p.waitForTimeout(400);
  await p.evaluate(() => { const d = document.querySelector('.cf-more'); if (d) d.open = true; });
  await p.selectOption('#f-circuit', { label: 'Mugello' }).catch(() => {});
  await p.fill('#f-laps', '1:59.100'); await p.click('#submit-btn'); await p.waitForTimeout(500);
  await p.click('.mini-sheet [data-pick-date].primary'); await p.waitForTimeout(800);
  if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.waitForTimeout(300); }
  // ouvrir la journée d'aujourd'hui à Mugello
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]').catch(() => {}); await p.waitForTimeout(300);
  await p.locator('#root [data-open-outing="Mugello"]:visible').first().click().catch(() => {}); await p.waitForTimeout(700);
  console.log('actions journée:', await p.$$eval('.outing-actions > button', e => e.map(x => x.innerText.trim()).join(' | ')));
  await p.click('[data-action="outing-move-day"]').catch(() => {}); await p.waitForTimeout(300);
  console.log('déplacer vers:', await p.$$eval('.mini-sheet [data-move-to]', e => e.map(x => x.innerText).join(' | ')).catch(() => '?'));
  await p.click('.mini-sheet [data-mini-close]').catch(() => {}); await p.waitForTimeout(200);
  await p.click('[data-action="outing-delete-day"]').catch(() => {}); await p.waitForTimeout(300);
  console.log('confirmation:', await p.$eval('.mini-sheet', e => e.innerText.replace(/\n/g, ' | ')).catch(() => '?'));
  await p.click('[data-del-go]').catch(() => {}); await p.waitForTimeout(700);
  const left = await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => s.docs.map(d => d.data()).filter(d => d.laps && d.laps.indexOf(119.1) !== -1).length));
  console.log('après suppression, chronos de la journée:', left, '| écran:', await p.$eval('.bottom-nav-btn.active', e => e.innerText.trim()));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
