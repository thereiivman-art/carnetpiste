// Nouveau chrono avec lien vidéo : lien refusé s'il n'est pas une adresse
// web ; puis Carnet › Passés affiche l'heure de saisie et seulement les 3
// derniers roulages ; la page du roulage montre le lien vidéo.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  if (await p.$('#jourj-overlay')) { await p.click('[data-jj="close"]'); await p.waitForTimeout(300); }
  await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(300);
  await p.click('#carnet-add-chrono'); await p.waitForTimeout(400);
  await p.selectOption('#f-circuit', { index: 1 }); await p.waitForTimeout(200);
  await p.type('#f-laps', '1:45.200'); await p.keyboard.press('Enter'); await p.type('#f-laps', '1:44.800');
  await p.fill('#f-video', 'pas un lien'); await p.click('#submit-btn'); await p.waitForTimeout(300);
  console.log('refus:', await p.$eval('#form-error', e => e.innerText));
  await p.fill('#f-video', 'youtu.be/abc123'); await p.click('#submit-btn'); await p.waitForTimeout(700);
  const s = await p.evaluate(() => Object.values(window.__MOCK_DATA.sessions).filter(x => x.videoUrl)[0]);
  console.log('stocké:', s && s.videoUrl, '| tours:', s && JSON.stringify(s.laps), '| createdAt:', !!(s && s.createdAt), '| circuit:', s && s.circuit);
  // Après l'enregistrement, la fenêtre « ressenti » s'ouvre.
  if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.waitForTimeout(300); }
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(300);
  console.log('lignes:', await p.$$eval('.outings-card .outing-row', e => e.length), '| bouton:', await p.$eval('#carnet-history-toggle', e => e.innerText).catch(() => 'aucun'));
  console.log('1re ligne:', await p.$eval('.outings-card .outing-row', e => e.innerText.replace(/\n/g, ' | ')));
  await p.screenshot({ path: 'chrono-video-passes-' + lang + '.png' });
  await p.click('.outings-card .outing-row'); await p.waitForTimeout(700);
  console.log('page roulage:', await p.$$eval('.outing-session-meta', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
