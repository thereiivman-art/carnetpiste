// Retours du 6 nov (soir) : Social (plus Fil), unités °F / miles, Autour du
// circuit espacé, Instagram / TikTok intégrés, Visités (nom → Infos, tracé → Plan),
// Bilan sans Trophées, recherche avancée derrière l'engrenage, météo gardée 1 h.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = []; const lang = process.argv[2] || 'fr';
  const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  let wxCalls = 0;
  await p.route('https://api.open-meteo.com/**', r => { wxCalls++; r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current: { temperature_2m: 20, weather_code: 0, wind_speed_10m: 10 }, hourly: { precipitation: [0] }, daily: { weather_code: [0], temperature_2m_max: [25], temperature_2m_min: [10], precipitation_probability_max: [5] } }) }); });
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(400);
  console.log('onglets Communauté:', await p.$$eval('.subnav-btn', e => e.map(x => x.innerText.trim()).filter(Boolean).join(' / ')));
  // Unités
  await p.click('.bottom-nav-btn[data-nav-tab="profil"]').then(() => p.waitForTimeout(300)).then(() => p.click('#settings-toggle')); await p.waitForTimeout(300);
  await p.click('[data-settings-go="affichage"]'); await p.waitForTimeout(300);
  await p.click('[data-unit="temp"][data-val="F"]'); await p.waitForTimeout(150); await p.click('[data-unit="dist"][data-val="mi"]'); await p.waitForTimeout(150);
  await p.click('.bottom-nav-btn[data-nav-tab="profil"]').then(() => p.waitForTimeout(300)).then(() => p.click('#settings-toggle')).catch(() => {}); await p.waitForTimeout(300);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.locator('[data-pill-group="circuit"][data-pill="infos"]:visible').first().click(); await p.waitForTimeout(800);
  // Bulles repliées : on ouvre Météo et Autour.
  await p.click('[data-info-bubble="wx"]'); await p.waitForTimeout(800); await p.click('[data-info-bubble="around"]').catch(() => {}); await p.waitForTimeout(400);
  console.log('météo:', await p.$eval('.today-wx .wx-now', e => e.innerText.replace(/\n/g, ' ')), '| distance:', await p.$$eval('.info-row, .circuit-info-card', e => (e.map(x => x.innerText).join(' ').match(/[\d.,]+ (mi|km)\b/) || ['?'])[0]));
  const gaps = await p.$$eval('.around-links a', a => a.length > 1 ? Math.round(a[1].getBoundingClientRect().left - a[0].getBoundingClientRect().right) : -1);
  console.log('espace entre liens:', gaps, 'px');
  await p.locator('[data-pill-group="circuit"][data-pill="plan"]:visible').first().click(); await p.waitForTimeout(300);
  await p.locator('[data-pill-group="circuit"][data-pill="infos"]:visible').first().click(); await p.waitForTimeout(500);
  console.log('requêtes météo (2 affichages):', wxCalls);
  // Bilan
  await p.click('.bottom-nav-btn[data-nav-tab="profil"]').then(() => p.waitForTimeout(300)).then(() => p.click('.subnav-btn[data-view="stats"]')).catch(() => {}); await p.waitForTimeout(400);
  console.log('Bilan:', await p.$$eval('.moi-jump', e => e.map(x => x.innerText).join(' / ')), '| section trophées:', !!(await p.$('#moi-trophees')));
  // Instagram / TikTok
  await p.evaluate(() => { const db = firebase.firestore(); db.collection('wallPosts').doc('ig').set({ id: 'ig', author: 'Sam', authorUid: 'u-sam', audience: 'all', text: 'Insta', linkUrl: 'https://www.instagram.com/p/DfZtUicI2Se/', createdAt: Date.now() }); db.collection('wallPosts').doc('tt').set({ id: 'tt', author: 'Tom', authorUid: 'u-tom', audience: 'all', text: 'Tiktok', linkUrl: 'https://www.tiktok.com/@motogp/video/7611128334956711190?lang=fr', createdAt: Date.now() - 1000 }); });
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(800);
  console.log('lecteurs:', await p.$$eval('.link-player-face[data-embed]', e => e.map(x => x.getAttribute('data-embed').split('?')[0]).join(' | ')));
  // Recherche
  await p.locator('#search-toggle:visible').first().click(); await p.waitForTimeout(300);
  console.log('recherche: filtres cachés:', !(await p.$('.gsearch-filters')), '| engrenage:', await p.$eval('[data-gs-adv]', e => e.innerText));
  await p.click('[data-gs-adv]'); await p.waitForTimeout(200);
  console.log('après engrenage:', await p.$$eval('[data-gs-type]', e => e.length), 'filtres');
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
