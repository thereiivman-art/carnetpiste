// Groupes de discussion (amis / team), Compte fusionné (ordre des onglets),
// budget masqué par l'œil, notification « X et Y viennent ».
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const lang = process.argv[2] || 'fr'; const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 860 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  // Groupe : créer avec Sam, écrire, retrouver dans la liste.
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(300);
  await p.click('[data-pill-group="social"][data-pill="messages"]'); await p.waitForTimeout(400);
  await p.click('[data-action="group-new"]'); await p.waitForTimeout(300);
  console.log('candidats:', await p.$$eval('[data-grp-pick]', e => e.map(x => x.getAttribute('data-grp-pick')).join(', ')));
  await p.fill('#grp-name', 'La bande'); await p.check('[data-grp-pick="Sam"]'); await p.click('#grp-save'); await p.waitForTimeout(500);
  await p.fill('#dm-text', 'On part ensemble ?'); await p.click('#dm-form button[type="submit"]'); await p.waitForTimeout(500);
  console.log('fil du groupe:', await p.$$eval('#dm-list .dm-bubble', e => e.map(x => x.innerText).join(' | ')));
  console.log('stocké:', await p.evaluate(() => JSON.stringify(Object.values(window.__MOCK_DATA.groupChats || {}).map(g => [g.name, g.memberNames, g.lastText]))));
  await p.click('[data-action="group-info"]'); await p.waitForTimeout(300);
  console.log('membres:', await p.$$eval('.mini-sheet .grp-row span', e => e.map(x => x.innerText).join(', ')));
  await p.click('[data-mini-close]'); await p.click('[data-action="dm-back"]'); await p.waitForTimeout(300);
  console.log('conversations:', await p.$$eval('.dm-conv strong', e => e.map(x => x.innerText).join(', ')));
  // Compte : onglets dans l'ordre demandé, profil + compte sur la même page.
  await p.click('#settings-toggle'); await p.waitForTimeout(400);
  await p.click('[data-settings-go="@compte"]'); await p.waitForTimeout(400);
  console.log('Compte : profil + email:', !!(await p.$('.profile-tab-body #profile-form, .profile-tab-body form')), '| déconnexion:', !!(await p.$('.profile-tab-body [id*="logout"], .profile-tab-body [data-action*="logout"]')));
  await p.click('#settings-toggle'); await p.waitForTimeout(300);
  console.log('barre d onglets retirée:', !(await p.$('.profile-tabs')));
  // Budget masqué.
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(300);
  await p.click('[data-pill-group="moi"][data-pill="budget"]').catch(() => {}); await p.waitForTimeout(300);
  await p.click('[data-action="budget-hide"]'); await p.waitForTimeout(300);
  console.log('budget masqué:', await p.evaluate(() => document.body.classList.contains('budget-masked')));
  await p.click('[data-action="budget-hide"]'); await p.waitForTimeout(300);
  console.log('budget réaffiché:', !(await p.evaluate(() => document.body.classList.contains('budget-masked'))));
  await p.screenshot({ path: 'groupes-compte.png' });
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
