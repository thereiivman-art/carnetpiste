const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 380, height: 800 }, hasTouch: true }); const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(BASE + 'index.html#lang=fr'); await p.waitForTimeout(1600);
await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(400);
await p.mouse.wheel(0, 600); await p.waitForTimeout(200);
await p.click('#search-toggle'); await p.waitForTimeout(300);
const inp = await p.$('#gsearch-input, .gsearch input, input[type="search"]'); await inp.type('clair'); await p.waitForTimeout(400);
console.log('kb-open pendant:', await p.evaluate(() => document.documentElement.classList.contains('kb-open')));
console.log('résultats:', await p.$$eval('[data-gs-go], .gs-item, .gsearch-results > *', e => e.slice(0,4).map(x => x.className + ':' + x.innerText.slice(0,30)).join(' | ')));
const res = p.locator('.gsearch-row:visible').first(); await res.click(); await p.waitForTimeout(600);
const t = p.locator('[data-theme-set="light"]:visible, [data-theme="light"]:visible, button:has-text("clair"):visible').first(); if (await t.count()) { await t.click(); await p.waitForTimeout(400); }
console.log('actif:', await p.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '#' + a.id + ' visible=' + !!(a.offsetParent) + ' overlay=' + !!document.querySelector('.gsearch-overlay, #gsearch, .gsearch') : 'none'; }));
console.log('kb-open après:', await p.evaluate(() => document.documentElement.classList.contains('kb-open')), '| nav visible:', await p.$eval('.bottom-nav', e => getComputedStyle(e).display !== 'none'));
await p.goto(BASE + 'index.html#lang=fr'); await p.waitForTimeout(1600);
await p.evaluate(() => firebase.firestore().collection('wallPosts').doc('w9').set({ id: 'w9', author: 'Sam', text: 'Jerez ce week-end', audience: 'all', createdAt: Date.now() - 60e3 }));
await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(800);
const post = await p.$('.wall-post'); if (post) { await post.scrollIntoViewIfNeeded(); await p.screenshot({ path: 'post-foot.png' }); }
console.log('boutons:', await p.$$eval('[data-action="dm-share-post"]', e => e.length), await p.$$eval('.wall-post', e => e.length));
await p.locator('[data-action="dm-share-post"]').first().click({ timeout: 4000 }).catch(e => console.log('clic', e.message.split('\n')[0])); await p.waitForTimeout(400);
console.log('feuille envoyer:', await p.$$eval('[data-dmshare]', e => e.map(x => x.getAttribute('data-dmshare')).join(',')));
console.log('errs', JSON.stringify(errs)); await b.close(); })();
