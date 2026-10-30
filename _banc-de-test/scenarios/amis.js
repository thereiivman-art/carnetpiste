// Fiche profil : la rangée de tous les amis (la mienne et celle d'un ami).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(500);
  await p.locator('.subnav-btn').nth(0).click(); await p.waitForTimeout(300);
  await p.locator('.pill-tabs button').nth(1).click(); await p.waitForTimeout(400);
  await p.getByText('Sam', { exact: true }).last().click(); await p.waitForTimeout(1200);
  const row = async () => (await p.$('.ph-friends-row')) ? await p.$$eval('.ph-friends-row .ph-fav-friend span', e => e.map(x => x.innerText).join(', ')) : 'aucune rangée';
  console.log('Sam :', await row());
  await p.screenshot({ path: 'amis-sam-' + lang + '.png' });
  // Ma fiche (Alex) depuis la rangée de Sam
  await p.click('.ph-friends-row [data-name="Alex"]').catch(() => {}); await p.waitForTimeout(1200);
  console.log('Alex :', await row());
  const sc = await p.$eval('.ph-friends-row', e => [e.scrollWidth, e.clientWidth]).catch(() => null);
  console.log('scroll width / visible:', sc);
  await p.screenshot({ path: 'amis-alex-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
