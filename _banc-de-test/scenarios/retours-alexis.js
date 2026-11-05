// Retours d'Alexis (accompagnant) : Dessin fermé en changeant d'onglet,
// lecteur vidéo dans un post, Lien/Lieu repliés, message d'accueil,
// discussion d'un roulage, podium « Tous » par défaut pour l'accompagnant,
// Visités dans Circuits, albums photo touchables.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const lang = process.argv[2] || 'fr'; const errs = [];
  const page = async (hash) => { const p = await b.newPage({ viewport: { width: 390, height: 860 } }); p.on('pageerror', e => errs.push(e.message)); await p.goto(BASE + 'index.html#lang=' + lang + hash); await p.waitForTimeout(1600); return p; };
  // 1. Dessin ouvert dans la page, puis Communauté : le dessin se ferme.
  let p = await page('');
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.click('[data-action="map-open"][data-mode="draw"]'); await p.waitForTimeout(600);
  const opened = !!(await p.$('#annot-overlay.open.map-docked'));
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(500);
  console.log('dessin ouvert:', opened, '| fermé après Communauté:', !(await p.$('#annot-overlay.open')));
  // 2. Post avec un lien YouTube : Lien/Lieu repliés, lecteur intégré.
  await p.click('#wall-composer-toggle'); await p.waitForTimeout(300);
  console.log('lien replié:', await p.$eval('.post-extra[data-extra="link"]', e => e.hidden), '| lieu replié:', await p.$eval('.post-extra[data-extra="place"]', e => e.hidden));
  await p.fill('#wall-post-text', 'Mon tour'); await p.click('[data-post-extra="link"]'); await p.fill('#wall-post-link', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await p.click('#wall-post-form button[type="submit"]'); await p.waitForTimeout(600);
  await p.click('[data-mini-close]').catch(() => {}); await p.waitForTimeout(300);
  const face = p.locator('.link-player-face').first();
  console.log('lecteur dans le post:', await face.count() > 0);
  await face.click().catch(() => {}); await p.waitForTimeout(300);
  console.log('lecteur dans le post:', await p.$eval('.inline-player iframe', e => e.src.slice(0, 45)).catch(() => 'non')); await p.click('.inline-player-x').catch(() => {}); await p.waitForTimeout(200);
  // 3. Discussion du roulage (Barcelone, à venir).
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(400);
  await p.locator('#root [data-open-outing="Barcelone"]:visible').first().click(); await p.waitForTimeout(600);
  await p.click('[data-action="event-chat"]'); await p.waitForTimeout(400);
  await p.fill('#ev-chat-text', 'Qui vient en camion ?'); await p.click('#ev-chat-form button[type="submit"]'); await p.waitForTimeout(500);
  console.log('message de discussion:', await p.$$eval('#ev-chat-list .dm-bubble', e => e.map(x => x.innerText).join(' | ')), '| stocké:', await p.evaluate(() => Object.keys(window.__MOCK_DATA).filter(k => /^events\/e1\/messages/.test(k)).map(k => Object.values(window.__MOCK_DATA[k]).map(m => m.text).join()).join()));
  await p.screenshot({ path: 'retours-alexis-discussion.png' });
  await p.close();
  // 4. Compte tout neuf : message d'accueil dans la messagerie.
  p = await page('&bienvenue=1');
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(300);
  await p.click('[data-pill-group="social"][data-pill="messages"]'); await p.waitForTimeout(400);
  console.log('conversation d\'accueil:', await p.$$eval('.dm-conv strong', e => e.map(x => x.innerText).join(', ')));
  await p.click('.dm-conv[data-name="cp:welcome"]'); await p.waitForTimeout(300);
  console.log('accueil:', (await p.$eval('.dm-welcome', e => e.innerText).catch(() => 'non')).slice(0, 40), '| formulaire de réponse:', !!(await p.$('#dm-form')));
  await p.close();
  // 5. Accompagnant : podium Tous par défaut, Visités dans Circuits, albums.
  p = await page('&role=acc');
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  console.log('Visités dans le Carnet:', !!(await p.$('.subnav-btn[data-view="visites"]')));
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  console.log('pastille Visités dans Circuits:', !!(await p.$('[data-pill-group="circuit"][data-pill="visites"]')));
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(300);
  await p.click('[data-moi-jump="podium"]').catch(() => {}); await p.waitForTimeout(400);
  console.log('podium par défaut:', await p.$eval('.podium-scope .primary', e => e.innerText).catch(() => '?'));
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(300);
  console.log('titre carnet:', await p.$eval('.comp-carnet-title', e => e.innerText).catch(() => 'non'));
  await p.click('[data-pill-group="compcarnet"][data-pill="passes"]').catch(() => {}); await p.waitForTimeout(300);
  console.log('albums touchables:', await p.$$eval('.album-chip', e => e.map(x => x.tagName + ' ' + x.innerText.trim()).join(', ')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
