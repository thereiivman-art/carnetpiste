const { chromium, BASE } = require('../lib');
const fs = require('fs');
const FR = /[éèêàùçôîâœ]|\b(le|la|les|des|du|et|pour|avec|ton|ta|tes|vous|votre|roulages?|chronos?|pilotes?|tours?|ajoute|aucun|une|est|sur|dans|pas|mon|mes|ses|au|aux|à|compte|comptes|groupe|langue|liens?|ouverts?|créés?)\b/i;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  const URL = BASE + 'index.html#lang=en&admin=1';
  const seen = new Map();
  async function harvest(where) {
    const lines = await p.evaluate(() => {
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n; while ((n = w.nextNode())) { const t = n.nodeValue.trim(); const e = n.parentElement; if (t && e && e.offsetParent !== null && !/^(script|style)$/i.test(e.tagName)) out.push(t); }
      document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(e => { if (e.offsetParent === null) return; ['placeholder', 'title', 'aria-label'].forEach(a => { const v = e.getAttribute(a); if (v) out.push('@' + a + ': ' + v); }); });
      return out;
    });
    lines.forEach(t => { if (!seen.has(t)) seen.set(t, where); });
  }
  async function home() { await p.goto('about:blank'); await p.goto(URL); await p.waitForTimeout(1600); }
  async function sweep(where, depth) {
    const sel = '.pill-btn, .subnav-btn, summary, .collapsible-toggle, [data-action^="toggle"], #account-manager-toggle';
    const n = await p.$$eval(sel, e => e.length);
    for (let i = 0; i < n && i < 60; i++) { const els = await p.$$(sel); if (!els[i]) continue; try { await els[i].click({ timeout: 800 }); await p.waitForTimeout(250); await harvest(where); } catch (e) {} }
  }
  const tabs = ['.bottom-nav button:nth-child(1)', '.bottom-nav button:nth-child(2)', '.bottom-nav button:nth-child(3)', '#settings-toggle', '#profile-toggle', '#notifications-toggle'];
  for (const t of tabs) {
    await home(); const el = await p.$(t); if (!el) continue; try { await el.click(); await p.waitForTimeout(600); } catch (e) {}
    await harvest(t); await sweep(t);
    // second pass after toggles opened
    await sweep(t);
  }
  // account manager explicitly
  await home(); try { await p.click('#settings-toggle'); await p.waitForTimeout(500); await p.getByText('Account').first().click(); await p.waitForTimeout(400); await p.click('#account-manager-toggle'); await p.waitForTimeout(800); await harvest('account manager'); await sweep('account manager'); } catch (e) { console.log('acct', e.message.slice(0, 80)); }
  const res = [];
  for (const [t, w] of seen) { const txt = t.replace(/^@[a-z-]+: /, ''); if (FR.test(txt)) res.push(w + '  ||  ' + t); }
  fs.writeFileSync('found-admin.txt', res.join('\n'));
  fs.writeFileSync('all-admin.txt', [...seen].map(x => x[1] + ' || ' + x[0]).join('\n'));
  console.log('texts', seen.size, 'suspicious', res.length);
  await b.close();
})();
