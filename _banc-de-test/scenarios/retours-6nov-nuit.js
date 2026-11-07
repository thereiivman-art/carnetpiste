// Lot du 6 nov (nuit) : Avancée, swipe Messages, Autour (icônes), infos dB avant
// le matériel, stories (barres, Voir le post), chrono (date future, brouillon,
// retour), fuseau, Bilan, échelle, podium, Horaires, Admin.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = []; const lang = process.argv[2] || 'fr';
  const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.dismiss());
  await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1'); await p.waitForTimeout(1600);
  // Circuits › Infos (Mugello : règles)
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(300);
  await p.selectOption('#root select', 'Mugello').catch(() => {}); await p.waitForTimeout(400);
  await p.locator('[data-pill-group="circuit"][data-pill="infos"]:visible').first().click(); await p.waitForTimeout(600);
  console.log('ordre:', await p.$eval('.circuit-lg', c => [...c.querySelectorAll('.circuit-rules, .gear-cols')].map(e => e.className.split(' ')[0]).join(' > ')).catch(() => '?'));
  console.log('icônes autour:', await p.$$eval('.around-link svg', e => e.length));
  await p.locator('[data-pill-group="circuit"][data-pill="plan"]:visible').first().click(); await p.waitForTimeout(1500);
  console.log('échelle:', await p.$eval('.plan-scale', e => e.innerText).catch(() => 'absente'));
  // Bilan
  await p.click('.bottom-nav-btn[data-nav-tab="profil"]').then(() => p.waitForTimeout(300)).then(() => p.click('.subnav-btn[data-view="stats"]')).catch(() => {}); await p.waitForTimeout(400);
  console.log('liens Bilan:', await p.$$eval('.moi-jump', e => e.length), '| podium:', await p.$$eval('.podium-scope button', e => e.map(x => x.innerText).join(' / ')));
  // Chrono : date future refusée, brouillon
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1&jourj=1'); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-main').catch(() => {}); await p.waitForTimeout(500);
  if (await p.$('#f-laps')) {
    await p.fill('#f-laps', "1'45.2"); await p.evaluate(() => { document.getElementById('f-date').value = '01/01/2030'; }); await p.waitForTimeout(200);
    await p.click('#session-form [type="submit"]'); await p.waitForTimeout(300);
    console.log('date future:', await p.$eval('#session-form .error-msg.visible, #session-form .visible', e => e.innerText).catch(() => 'pas de message'));
    console.log('brouillon:', await p.evaluate(() => sessionStorage.getItem('cdp-chrono-draft')));
  } else console.log('formulaire chrono introuvable');
  // Messages : swipe (un groupe dont je suis membre)
  await p.evaluate(() => { const u = firebase.auth().currentUser.uid; return firebase.firestore().collection('groupChats').doc('g1').set({ name: 'La bande', members: [u, 'u-sam'], memberNames: ['Alex', 'Sam'], createdBy: 'u-sam', createdByName: 'Sam', createdAt: Date.now(), lastText: 'Salut', lastAt: Date.now(), lastFrom: 'Sam' }); });
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(300);
  await p.locator('.subnav-btn:has-text("Messages"):visible, .pill-btn:has-text("Messages"):visible').first().click().catch(() => {}); await p.waitForTimeout(500);
  const sw = await p.$('.dm-swipe');
  if (sw) { const r = await sw.boundingBox(); await p.mouse.move(r.x + 20, r.y + r.height / 2); await p.mouse.down(); await p.mouse.move(r.x + 140, r.y + r.height / 2, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(300);
    console.log('swipe:', await p.$eval('.dm-swipe', e => e.classList.contains('open') + ' ' + e.querySelector('.dm-swipe-act').innerText)); }
  else console.log('swipe: pas de conversation');
  // Réglages : fuseau + Admin
  await p.click('.bottom-nav-btn[data-nav-tab="profil"]').then(() => p.waitForTimeout(300)).then(() => p.click('#settings-toggle')); await p.waitForTimeout(300);
  console.log('ligne Admin:', !!(await p.$('[data-settings-go="@admin"]')));
  await p.click('[data-settings-go="affichage"]'); await p.waitForTimeout(300);
  await p.selectOption('#tz-select', 'America/New_York'); await p.waitForTimeout(300);
  console.log('fuseau:', await p.evaluate(() => localStorage.getItem('cdp-tz')), '| horloge NY:', await p.evaluate(() => new Intl.DateTimeFormat('fr', { timeZone: 'America/New_York', hour: 'numeric' }).format(new Date())));
  await p.click('.settings-back').catch(() => {}); await p.waitForTimeout(300);
  await p.click('[data-settings-go="@admin"]').catch(() => {}); await p.waitForTimeout(400);
  await p.screenshot({ path: __dirname + '/../.sortie/admin.png' });
  console.log('page Admin:', await p.$$eval('.profile-tab-body .card', e => e.length), 'cartes | gestion comptes:', !!(await p.$('#account-manager-toggle')));
  // Recherche « Avancée »
  await p.click('.bottom-nav-btn[data-nav-tab="profil"]').then(() => p.waitForTimeout(300)).then(() => p.click('#settings-toggle')).catch(() => {}); await p.waitForTimeout(200);
  await p.locator('#search-toggle:visible').first().click(); await p.waitForTimeout(300);
  console.log('recherche:', await p.$eval('[data-gs-adv]', e => e.innerText));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
