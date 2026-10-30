// Réglages d'un Team : le leader renomme son Team (doublon refusé).
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const open = async (hash) => {
    await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang + (hash || '')); await p.waitForTimeout(1600);
    await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
    await p.click('.subnav-btn[data-view="team"]'); await p.waitForTimeout(400);
    await p.getByText('Team Piste').first().click(); await p.waitForTimeout(700);
    await p.click('[data-pill-group="team"][data-pill="reglages"]'); await p.waitForTimeout(400);
  };
  await open();
  const input = '[id^="team-name-"]';
  console.log('leader sees field:', !!(await p.$(input)));
  await p.fill(input, 'Mototeam95'); await p.click('[data-action="team-rename"]'); await p.waitForTimeout(400);
  console.log('duplicate ->', (await p.$$eval('.toast', e => e.map(x => x.innerText))).pop());
  await p.fill(input, '  Team   Piste  Sud '); await p.click('[data-action="team-rename"]'); await p.waitForTimeout(700);
  console.log('rename ->', (await p.$$eval('.toast', e => e.map(x => x.innerText))).pop());
  console.log('stored:', await p.evaluate(() => Object.values(window.__MOCK_DATA.teams).map(t => t.name).join(', ')));
  await p.screenshot({ path: 'team-rename-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
