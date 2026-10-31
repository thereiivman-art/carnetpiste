// Onglet central Chrono : le jour du roulage (Alex roule à Carole,
// &jourj=1), gros bouton « Ajouter un chrono », progression du jour, plan
// et repères ; sans roulage, le prochain roulage. Horaires : toucher un
// groupe n'affiche que lui. Calendrier dans Carnet › Roulages.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&jourj=1'); await p.waitForTimeout(1800);
  console.log('nav:', await p.$$eval('.bottom-nav-btn', e => e.map(x => x.innerText.trim()).join(' | ')));
  console.log('ouvre sur Chrono:', await p.$eval('.bottom-nav-btn.active', e => e.innerText.trim()), '| overlay:', !!(await p.$('#jourj-overlay')));
  console.log('écran:', (await p.$eval('.chrono-hero', e => e.innerText.replace(/\n/g, ' | '))), '| titre de section:', !!(await p.$('.section-heading')));
  await p.screenshot({ path: 'chrono-jour-' + lang + '.png' });
  for (const t of ['1:12.400', '1:11.800']) {
    console.log('formulaire:', await p.$eval('#cf-summary', e => e.innerText), '| options repliées:', !(await p.$eval('.cf-more', e => e.open)));
    await p.type('#f-laps', t); await p.click('#submit-btn'); await p.waitForTimeout(600);
    if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.waitForTimeout(300); }
  }
  console.log('reste sur Chrono:', await p.$eval('.bottom-nav-btn.active', e => e.innerText.trim()));
  console.log('progression:', await p.$eval('.chrono-progress', e => e.innerText.replace(/\n/g, ' | ').slice(0, 200)).catch(() => 'absente'));
  console.log('plan:', await p.$eval('.chrono-plan', e => e.innerText.replace(/\n/g, ' | ')));
  await p.screenshot({ path: 'chrono-progression-' + lang + '.png', fullPage: true });
  await p.click('.chrono-hor-link'); await p.waitForTimeout(500);
  await p.click('[data-cpill-group="planning"][data-cpill="programme"]').catch(() => {}); await p.waitForTimeout(300);
  // Horaires : toucher B n'affiche que B
  const boxes = await p.$$('.planning-group-check');
  console.log('groupes:', boxes.length);
  if (boxes.length > 1) {
    await boxes[1].click(); await p.waitForTimeout(400);
    console.log('après B:', await p.$$eval('[data-planning-group]', e => e.map(x => x.getAttribute('data-planning-group') + (x.checked ? '✓' : '·')).join(' ')));
    const bb = await p.$$('.planning-group-check'); await bb[1].click(); await p.waitForTimeout(400);
    console.log('retouché:', await p.$$eval('[data-planning-group]', e => e.map(x => x.getAttribute('data-planning-group') + (x.checked ? '✓' : '·')).join(' ')));
  }
  await p.click('.bottom-nav-btn.bottom-nav-main'); await p.waitForTimeout(300);
  // Sans roulage aujourd'hui
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn.bottom-nav-main'); await p.waitForTimeout(400);
  console.log('sans roulage:', await p.$eval('#root', e => e.innerText.split('\n').filter(Boolean).slice(0, 12).join(' | ')));
  await p.click('[data-view="planning"].primary'); await p.waitForTimeout(500);
  console.log('prépa ouverte:', !!(await p.$('[data-cpill-group="planning"]')), '| nav:', await p.$eval('.bottom-nav-btn.active', e => e.innerText.trim()));
  // Calendrier dans Carnet › Roulages
  await p.click('.bottom-nav-btn[data-view^="carnet"], .bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(300);
  await p.click('.pill-btn[data-view="event"]'); await p.waitForTimeout(500);
  console.log('calendrier:', await p.$$eval('.pill-tabs .pill-btn.active, .subnav-btn.active', e => e.map(x => x.innerText).join(' / ')), '| lignes:', await p.$$eval('.event-row', e => e.length));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
