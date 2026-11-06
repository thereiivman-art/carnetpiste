// En-tête d'un roulage allégé : icônes (Gérer, discussion, inviter, agenda),
// plus de ligne « Sur ce roulage », team en rond cliquable, discussion = groupe dans Messages.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, colorScheme: 'dark' }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]').catch(() => {}); await p.waitForTimeout(300);
  await p.locator('[data-cards-mode="avenir"]:visible').first().click().catch(() => {}); await p.waitForTimeout(300);
  await p.locator('#root [data-outing-event]:visible').first().click({ position: { x: 30, y: 14 } }); await p.waitForTimeout(800);
  console.log('actions:', await p.$$eval('.outing-actions-icons > button', e => e.map(x => x.getAttribute('aria-label') || x.innerText).join(' | ')));
  console.log('ligne sur ce roulage:', !!(await p.$('[data-action="ride-role"]')));
  console.log('une seule ligne:', await p.$$eval('.outing-actions-icons > button', e => new Set(e.map(x => Math.round(x.getBoundingClientRect().top))).size === 1));
  await p.screenshot({ path: __dirname + '/../.sortie/roulage-entete.png', clip: { x: 0, y: 0, width: 390, height: 560 } });
  const chat = await p.$('[data-action="event-group"]');
  if (chat) { await chat.click(); await p.waitForTimeout(900);
    console.log('groupe:', JSON.stringify(await p.evaluate(() => Object.entries(window.__MOCK_DATA.groupChats || {}).map(([id, g]) => [id, g.name, (g.memberNames || []).length]))), '| ouvert:', !!(await p.$('.dm-thread'))); }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
