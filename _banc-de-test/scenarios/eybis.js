// Import admin : calendrier Eybis 2027, avec création du Team Eybis.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 400, height: 1400 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1'); await p.waitForTimeout(1600);
  await p.click('#settings-toggle'); await p.waitForTimeout(300);
  await p.getByText(lang === 'fr' ? 'Aide' : 'Help', { exact: true }).first().click(); await p.waitForTimeout(300);
  await p.click('[data-pill-group="aide"][data-pill="admin"]'); await p.waitForTimeout(500);
  await p.selectOption('#evimp-preset', 'eybis'); await p.waitForTimeout(400);
  console.log('team:', await p.$eval('#evimp-team', e => e.value), '| new name:', await p.$eval('#evimp-newteam', e => e.value), '| vis:', await p.$eval('#evimp-vis', e => e.value));
  await p.click('[data-action="evimp-check"]'); await p.waitForTimeout(400);
  console.log('after check: team', await p.$eval('#evimp-team', e => e.value), 'vis', await p.$eval('#evimp-vis', e => e.value), '| rows', await p.$$eval('.evimp-row', e => e.length), 'errors', await p.$$eval('.evimp-row.error', e => e.map(x => x.innerText)));
  console.log('button:', await p.$eval('[data-action="evimp-go"]', e => e.textContent));
  await p.screenshot({ path: 'eybis-preview-' + lang + '.png' });
  await p.click('[data-action="evimp-go"]'); await p.waitForTimeout(1500);
  const data = await p.evaluate(() => {
    const D = window.__MOCK_DATA, team = Object.values(D.teams).filter(t => t.name === 'Eybis')[0];
    const evs = Object.values(D.events).filter(e => team && e.teamId === team.id);
    return { team: team && { teamPro: team.teamPro, createdBy: team.createdBy, description: team.description }, leader: Object.values(D.teamMembers).filter(m => team && m.teamId === team.id).map(m => m.name + ':' + m.role),
      n: evs.length, vis: [...new Set(evs.map(e => e.eventVisibility))], url: [...new Set(evs.map(e => e.bookingUrl))], sample: evs.slice(0, 3).map(e => e.dateStart + ' ' + e.circuit + ' | ' + e.note) };
  });
  console.log(JSON.stringify(data, null, 1));
  await p.click('[data-action="evimp-check"]'); await p.waitForTimeout(400);
  console.log('re-check: team', await p.$eval('#evimp-team', e => e.options[e.selectedIndex].text), '| ok rows', await p.$$eval('.evimp-row:not(.error)', e => e.length), '/', await p.$$eval('.evimp-row', e => e.length));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
