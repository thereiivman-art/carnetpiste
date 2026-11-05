// Fiche profil : la rangée de tous mes amis sur mon profil ; sur la fiche
// d'un ami, plus de liste (liste d'amis privée), juste « Ami avec toi ».
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(500);
  await p.locator('.subnav-btn').nth(0).click(); await p.waitForTimeout(300);
  await p.click('#profile-toggle'); await p.waitForTimeout(400);
  await p.click('.social-count[data-list="amis"]'); await p.waitForTimeout(400);
  await p.click('[data-cpill-group="suivislist"][data-cpill="liste"]'); await p.waitForTimeout(300);
  await p.click('[data-cpill-section="suivislist:liste"] [data-open-person="Sam"]'); await p.waitForTimeout(1200);
  const row = async () => (await p.$('.ph-friends-row')) ? await p.$$eval('.ph-friends-row .ph-fav-friend span', e => e.map(x => x.innerText).join(', ')) : 'aucune rangée';
  console.log('Sam :', await row(), '| compteurs:', await p.$eval('.social-counts', e => e.innerText.replace(/\n/g, ' ')).catch(() => '?'));
  await p.screenshot({ path: 'amis-sam-' + lang + '.png' });
  // Mon profil (Alex)
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
  await p.click('#profile-toggle'); await p.waitForTimeout(800);
  console.log('Alex :', await row());
  const sc = await p.$eval('.ph-friends-row', e => [e.scrollWidth, e.clientWidth]).catch(() => null);
  console.log('scroll width / visible:', sc);
  await p.screenshot({ path: 'amis-alex-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
