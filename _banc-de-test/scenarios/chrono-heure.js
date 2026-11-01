// Chrono à l'heure du jour J (roulage de Carole, Alex en groupe B,
// sessions 9h00-9h20, 11h00-11h20, 14h00-14h20…) :
// 1. l'heure s'affiche sur l'onglet Chrono ;
// 2. à 11h28, on propose « Groupe B · 11h00–11h20 » (Oui / Changer), le
//    chrono enregistré porte ce groupe et cette session ;
// 3. import d'une journée de tours (sans heure de passage) : découpée en
//    sessions d'après les horaires du groupe et le rythme du pilote.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const now = new Date(); now.setHours(11, 28, 0, 0);
  await p.clock.install({ time: now });
  await p.goto(BASE + 'index.html#lang=' + lang + '&jourj=1'); await p.clock.runFor(1600);
  console.log('heure:', await p.$eval('[data-live-clock]', e => e.innerText).catch(() => 'absente'));
  console.log('proposition:', await p.$eval('#cf-confirm', e => e.innerText.replace(/\n/g, ' | ')).catch(() => 'aucune'));
  console.log('pré-rempli:', await p.$eval('#f-group', e => e.value), '|', await p.$eval('#f-slot', e => e.options[e.selectedIndex].text));
  await p.click('[data-action="cf-confirm-yes"]'); await p.clock.runFor(200);
  console.log('après Oui:', await p.$eval('#cf-confirm', e => e.innerText).catch(() => 'absente'));
  await p.fill('#f-laps', '1:12.400'); await p.click('#submit-btn'); await p.clock.runFor(700);
  if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.clock.runFor(300); }
  console.log('chrono enregistré:', await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => { const x = s.docs.map(d => d.data()).filter(d => d.laps && d.laps[0] === 72.4)[0]; return x ? x.group + ' · ' + x.slotLabel + ' · ' + x.eventId : 'absent'; })));
  // L'heure suit
  await p.clock.runFor(4 * 60 * 1000);
  console.log('heure 4 min plus tard:', await p.$eval('[data-live-clock]', e => e.innerText).catch(() => 'absente'));

  // Import d'une journée entière (5 sessions de 20 min, ~1'12 au tour)
  const day = [];
  for (let k = 0; k < 5; k++) { day.push(95); for (let i = 0; i < 13; i++) day.push(72 + ((i * 7 + k) % 10) / 10); day.push(88); }
  await p.evaluate((laps) => {
    const txt = laps.map(v => Math.floor(v / 60) + ':' + (v % 60).toFixed(3).padStart(6, '0')).join('\n');
    window.ChronoImport.recognize = () => Promise.resolve({ text: txt, confidence: 95 });
  }, day);
  await p.click('.bottom-nav-main'); await p.clock.runFor(400);
  if (!(await p.$('#import-photo-input'))) { await p.click('#add-chrono-toggle').catch(() => {}); await p.clock.runFor(300); }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await p.setInputFiles('#import-photo-input', [{ name: 'jour.png', mimeType: 'image/png', buffer: png }]);
  await p.clock.runFor(900);
  console.log('découpage:', await p.$eval('#imp-split', e => e.innerText.replace(/\n/g, ' | ')).catch(() => 'aucun'));
  console.log('bouton:', await p.$eval('[data-imp="apply"]', e => e.innerText));
  const before = await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => s.docs.length));
  await p.click('[data-imp="apply"]'); await p.clock.runFor(800);
  if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.clock.runFor(300); }
  const after = await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => s.docs.map(d => d.data())));
  const fresh = after.filter(x => x.laps && x.laps.length > 5 && x.laps[0] === 95);
  console.log('sessions créées:', after.length - before, '|', fresh.map(x => (x.slotLabel || '?') + ' ' + x.laps.length + 't').join(', '));
  await p.screenshot({ path: 'chrono-heure-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
