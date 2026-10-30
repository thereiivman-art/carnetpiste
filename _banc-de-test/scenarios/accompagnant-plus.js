// Accompagnant : Mes potes en piste (Prochain roulage et jour J), saisie du
// chrono d'un pote ; pilote : validation d'un chrono proposé par un pote.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&role=acc'); await p.waitForTimeout(1600);
  // Des potes roulent aujourd'hui : le jour J s'ouvre tout seul.
  if (await p.$('#jourj-overlay')) { console.log('jour J auto:', (await p.$eval('#jourj-overlay', e => e.innerText)).replace(/\n/g, ' | ').slice(0, 300)); await p.screenshot({ path: 'acc-jourj-' + lang + '.png' }); await p.click('[data-jj="close"]'); await p.waitForTimeout(300); }
  await p.click('.bottom-nav-btn:nth-child(2)'); await p.waitForTimeout(600);
  console.log('potes en piste:', await p.$$eval('.friends-on-track .fot-row', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')).catch(() => 'aucune carte'));
  await p.screenshot({ path: 'acc-potes-piste-' + lang + '.png' });
  // Saisir le chrono d'un pote
  await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(300);
  await p.click('[data-action="chrono-proposal"]'); await p.waitForTimeout(300);
  await p.selectOption('#cp-to', 'Sam'); await p.fill('#cp-circuit', 'Carole'); await p.fill('#cp-laps', "1'12.4\n1'11.8");
  await p.click('[data-cp="send"]'); await p.waitForTimeout(700);
  console.log('proposition:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.chronoProposals).filter(r => r.from === 'Alex').map(r => [r.to, r.circuit, r.laps, r.eventId, r.status]))));
  // Côté pilote : Alex reçoit le chrono saisi par Tom
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  if (await p.$('#jourj-overlay')) { await p.click('[data-jj="close"]'); await p.waitForTimeout(300); }
  await p.click('#notifications-toggle'); await p.waitForTimeout(500);
  console.log('notif:', await p.$eval('[data-action="accept-chrono-proposal"]', e => e.closest('.notifications-panel').innerText.split('\n').slice(0, 6).join(' | ')).catch(() => 'absente'));
  const before = await p.evaluate(() => Object.values(window.__MOCK_DATA.sessions).filter(s => s.rider === 'Alex').length);
  await p.click('[data-action="accept-chrono-proposal"]'); await p.waitForTimeout(800);
  console.log('sessions Alex:', before, '->', await p.evaluate(() => Object.values(window.__MOCK_DATA.sessions).filter(s => s.rider === 'Alex').length), '| statut:', await p.evaluate(() => window.__MOCK_DATA.chronoProposals.cp1.status));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
