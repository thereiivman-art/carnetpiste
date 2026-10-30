const { chromium, BASE } = require('../lib');
const fs = require('fs');
const LANG = process.argv[2] || 'en';
const FR = /[éèêàùçôîâœ]|\b(le|la|les|des|du|et|pour|avec|ton|ta|tes|vous|votre|roulages?|chronos?|pilotes?|tours?|ajoute|aucun|une|est|sur|dans|pas|mon|mes|ses|au|aux|à)\b/i;
const EN = /\b(the|and|your|you|with|trackdays?|lap times?|riders?|add|no|of|to|for|my)\b/i;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  await p.goto(BASE + 'index.html#lang=' + LANG); await p.waitForTimeout(2000);
  const seen = new Map();
  async function harvest(where) {
    const lines = await p.evaluate(() => {
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n; while ((n = w.nextNode())) { const t = n.nodeValue.trim(); if (t && n.parentElement && n.parentElement.offsetParent !== null && !/^(script|style)$/i.test(n.parentElement.tagName)) out.push(t); }
      document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(e => { ['placeholder', 'title', 'aria-label'].forEach(a => { const v = e.getAttribute(a); if (v) out.push('@' + a + ': ' + v); }); });
      return out;
    });
    lines.forEach(t => { if (!seen.has(t)) seen.set(t, where); });
  }
  async function clickAll(sel, where, depth) {
    const n = await p.$$eval(sel, els => els.length);
    for (let i = 0; i < n; i++) {
      const els = await p.$$(sel); if (!els[i]) continue;
      const label = ((await els[i].innerText().catch(() => '')) || '').trim().slice(0, 30);
      try { await els[i].click({ timeout: 1500 }); } catch (e) { continue; }
      await p.waitForTimeout(350);
      await harvest(where + ' > ' + label);
      if (depth) await clickAll('.pill-btn', where + ' > ' + label, 0);
    }
  }
  await harvest('start');
  const tabs = await p.$$eval('.bottom-nav button, nav button, [data-tab]', els => els.length);
  const tabSel = (await p.$('[data-tab]')) ? '[data-tab]' : '.bottom-nav button';
  const nt = await p.$$eval(tabSel, els => els.length);
  for (let t = 0; t < nt; t++) {
    const els = await p.$$(tabSel); const label = (await els[t].innerText()).trim();
    await els[t].click(); await p.waitForTimeout(500); await harvest(label);
    await clickAll('.subnav-btn', label, 1);
    await clickAll('.pill-btn', label, 0);
  }
  // profile / settings / notifications panels
  for (const sel of ['#profile-toggle', '#settings-toggle', '#notifications-toggle', '[data-action="open-my-profile"]']) {
    const el = await p.$(sel); if (!el) continue;
    try { await el.click(); await p.waitForTimeout(500); await harvest(sel); await clickAll('.pill-btn', sel, 0); } catch (e) {}
    await p.keyboard.press('Escape').catch(() => {});
  }
  const res = [];
  for (const [t, w] of seen) {
    const txt = t.replace(/^@[a-z-]+: /, '');
    if (LANG === 'en' ? FR.test(txt) : (EN.test(txt) && !FR.test(txt))) res.push(w + '  ||  ' + t);
  }
  fs.writeFileSync('found-' + LANG + '.txt', res.join('\n'));
  fs.writeFileSync('all-' + LANG + '.txt', [...seen.keys()].join('\n'));
  console.log(LANG, 'texts', seen.size, 'suspicious', res.length, 'tabs', nt);
  await b.close();
})();
