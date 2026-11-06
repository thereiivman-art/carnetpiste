// Rôle : plus de choix par roulage (retiré) ; l'avertissement en passant le
// compte en accompagnant (rien d'effacé, confirmation demandée).
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
  await p.click('[data-cards-mode="avenir"]'); await p.waitForTimeout(300);
  await p.click('[data-outing-event="e1"]'); await p.waitForTimeout(700);
  const tabs = () => p.$$eval('[data-pill-group="outing"]', e => e.map(x => x.innerText).join(' / '));
  // La ligne « Sur ce roulage : Pilote / Accompagnant » a été retirée
  // (retour Alexis) : le rôle vient du compte, un rôle déjà posé reste lu.
  console.log('pilote, onglets:', await tabs(), '| plus de choix par roulage:', !(await p.$('[data-action="ride-role"]')));
  // Avertissement au changement de rôle du compte
  await p.click('#settings-toggle'); await p.waitForTimeout(300);
  await p.click('[data-settings-go="@compte"]'); await p.waitForTimeout(300);
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
