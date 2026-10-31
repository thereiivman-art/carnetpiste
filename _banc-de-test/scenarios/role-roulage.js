// Rôle par roulage : Alex (pilote) vient en accompagnant à Barcelone sans
// changer son compte ; puis l'avertissement en passant le compte en
// accompagnant (rien d'effacé, confirmation demandée).
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
  await p.click('[data-pill-group="carnet"][data-pill="avenir"], .pill-tabs button:nth-child(2)'); await p.waitForTimeout(300);
  await p.click('[data-outing-event="e1"]'); await p.waitForTimeout(700);
  const tabs = () => p.$$eval('[data-pill-group="outing"]', e => e.map(x => x.innerText).join(' / '));
  console.log('pilote, onglets:', await tabs(), '| rôle:', await p.$$eval('.ride-role-btn.active', e => e.map(x => x.innerText).join()));
  await p.click('[data-action="ride-role"][data-role="accompagnant"]'); await p.waitForTimeout(600);
  console.log('stocké:', JSON.stringify(await p.evaluate(() => window.__MOCK_DATA.events.e1.riderRoles)));
  console.log('acc, onglets:', await tabs(), '| carte:', (await p.$eval('.outing-group-main', e => e.innerText.replace(/\n/g, ' '))));
  await p.click('[data-pill-group="outing"][data-pill="chronos"]'); await p.waitForTimeout(300);
  console.log('bouton pote:', !!(await p.$('[data-action="chrono-proposal"]')), '| potes en piste:', await p.$$eval('.friends-on-track .fot-row', e => e.map(x => x.innerText.split('\n')[0]).join(', ')).catch(() => ''));
  await p.screenshot({ path: 'role-roulage-' + lang + '.png' });
  await p.click('[data-action="ride-role"][data-role="pilote"]'); await p.waitForTimeout(600);
  console.log('retour pilote:', JSON.stringify(await p.evaluate(() => window.__MOCK_DATA.events.e1.riderRoles)), '|', await tabs());
  // Avertissement au changement de rôle du compte
  await p.click('#settings-toggle'); await p.waitForTimeout(300);
  await p.click('[data-profile-tab="profil"]'); await p.waitForTimeout(300);
  await p.click('[data-cpill-group="profil"][data-cpill="role"]'); await p.waitForTimeout(300);
  await p.check('input[name="profile-role"][value="accompagnant"]');
  await p.click('#profile-form [type="submit"]'); await p.waitForTimeout(400);
  console.log('rôle après 1er clic:', await p.evaluate(() => window.__MOCK_DATA.users.u1.role));
  console.log('message:', (await p.textContent('#root')).match(/(Rien n'est effacé|Nothing is deleted)[^\n]{0,60}/)?.[0]);
  await p.screenshot({ path: 'role-avert-' + lang + '.png' });
  await p.click('#profile-form [type="submit"]'); await p.waitForTimeout(700);
  console.log('rôle après confirmation:', await p.evaluate(() => window.__MOCK_DATA.users.u1.role), '| sessions Alex:', await p.evaluate(() => Object.values(window.__MOCK_DATA.sessions).filter(s => s.rider === 'Alex').length));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
