// Petit téléphone (360 px) : aucune page plus large que l'écran (sinon le
// téléphone dézoome et il faut naviguer de côté) ; pas de zoom au toucher d'un champ.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  console.log('viewport:', await p.$eval('meta[name=viewport]', m => m.content));
  const small = await p.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), select, textarea')].filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).length);
  console.log('champs < 16 px (zoom iPhone):', small);
  const check = async (nom) => { await p.waitForTimeout(500);
    const r = await p.evaluate(() => { const W = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
      const wide = [...document.querySelectorAll('#root *')].filter(e => { const r = e.getBoundingClientRect(); if (!r.width || r.right <= W + 1) return false; for (let a = e.parentElement; a && a.id !== 'root'; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return false; } return true; })
        .slice(0, 3).map(e => e.tagName + '.' + String(e.className).split(' ')[0] + ' →' + Math.round(e.getBoundingClientRect().right));
      return 'page ' + sw + '/' + W + (wide.length ? ' | dépasse: ' + wide.join(', ') : ''); });
    console.log(nom.padEnd(20), r); };
  // Publication avec un lien très long : passe à la ligne, la page ne s'élargit pas.
  await p.evaluate(() => firebase.firestore().collection('wallPosts').doc('longurl').set({ id: 'longurl', author: 'Sam', authorUid: 'u-sam', audience: 'all', text: 'https://exemple.com/' + 'x'.repeat(300), createdAt: Date.now() }));
  console.log('double-toucher:', await p.evaluate(() => getComputedStyle(document.documentElement).touchAction));
  await check('Accueil');
  await p.click('.bottom-nav-btn:nth-child(1)'); await check('Carnet');
  for (const sel of ['[data-view="event"]', '[data-cards-mode="passees"]', '.subnav-btn[data-view="circuit"]', '.subnav-btn[data-view="stats"]']) { await p.locator(sel + ':visible').first().click().catch(() => {}); await check(sel.replace(/[^a-z]+/g, ' ').trim().slice(-14)); }
  await p.click('.bottom-nav-btn.bottom-nav-main').catch(() => {}); await check('Chrono');
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await check('Fil');
  await p.locator('#wall-composer-toggle:visible').first().click().catch(() => {}); await check('Publier');
  for (const v of ['dmbox', 'teams']) { await p.locator('.subnav-btn[data-view="' + v + '"]:visible').first().click().catch(() => {}); await check(v); }
  await p.locator('#settings-toggle:visible').first().click().catch(() => {}); await check('Réglages');
  await p.locator('.header-avatar, .profile-toggle').first().click().catch(() => {}); await check('Profil');
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
