const { chromium, BASE } = require('../lib');
const fs = require('fs');
const LANG = process.argv[2] || 'en';
const FR = /[éèêàùçôîâœ]|\b(le|la|les|des|du|et|pour|avec|ton|ta|tes|vous|votre|roulages?|chronos?|pilotes?|tours?|ajoute|aucun|une|est|sur|dans|pas|mon|mes|ses|au|aux|à)\b/i;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  await p.goto(BASE + 'index.html#lang=' + LANG); await p.waitForTimeout(2000);
  const seen = new Map();
  async function harvest(where) {
    const lines = await p.evaluate(() => {
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n; while ((n = w.nextNode())) { const t = n.nodeValue.trim(); const e = n.parentElement; if (t && e && (e.offsetParent !== null || getComputedStyle(e).position === 'fixed') && !/^(script|style|option)$/i.test(e.tagName)) out.push(t); }
      document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(e => { if (e.offsetParent === null) return; ['placeholder', 'title', 'aria-label'].forEach(a => { const v = e.getAttribute(a); if (v) out.push('@' + a + ': ' + v); }); });
      return out;
    });
    lines.forEach(t => { if (!seen.has(t)) seen.set(t, where); });
  }
  async function home() { await p.goto(BASE + 'index.html#lang=' + LANG); await p.waitForTimeout(1500); }
  async function clickText(txt) { const el = p.getByText(txt, { exact: false }).first(); try { await el.click({ timeout: 1500 }); await p.waitForTimeout(600); return true; } catch (e) { return false; } }
  async function clickSel(sel) { const el = await p.$(sel); if (!el) return false; try { await el.click({ timeout: 1500 }); await p.waitForTimeout(600); return true; } catch (e) { return false; } }
  async function sweepPills(where) { const n = await p.$$eval('.pill-btn, .subnav-btn', e => e.length); for (let i = 0; i < n; i++) { const els = await p.$$('.pill-btn, .subnav-btn'); if (!els[i]) continue; try { await els[i].click({ timeout: 1000 }); await p.waitForTimeout(300); await harvest(where); } catch (e) {} } }
  const scenarios = [
    ['outing past', async () => { await clickText('Mugello'); }],
    ['outing upcoming', async () => { await clickSel('.subnav-btn[data-view="carnet"]'); await clickSel('[data-cards-mode="avenir"]'); await clickText('Barcelon'); }],
    ['chrono tab', async () => { await clickSel('.bottom-nav-btn.bottom-nav-main'); await clickSel('#root [data-view="planning"]'); }],
    ['add lap form', async () => { await clickSel('.add-chrono-btn'); }],
    ['circuits', async () => { await clickText(LANG === 'en' ? 'Circuits' : 'Circuits'); await clickSel('[data-action="open-track-notes"]'); }],
    ['stats', async () => { await clickText('Stats'); }],
    ['person Sam', async () => { await clickSel('[data-tab="communaute"], .bottom-nav button:nth-child(3)'); await clickText('Sam'); }],
    ['team', async () => { await clickSel('[data-tab="communaute"], .bottom-nav button:nth-child(3)'); await clickText('Team'); await clickText('Team Piste'); }],
    ['settings', async () => { await clickSel('#settings-toggle'); }],
    ['profile', async () => { await clickSel('#profile-toggle'); }],
    ['notifications', async () => { await clickSel('#notifications-toggle'); }],
    ['calendar', async () => { await clickSel('.subnav-btn[data-view="carnet"]'); await clickSel('.pill-btn[data-view="event"]'); await clickSel('[data-pill-group="events"][data-pill="calendrier"]'); }],
    ['budget', async () => { await clickSel('.bottom-nav-btn[data-view^="carnet"]'); await clickSel('.subnav-btn[data-view="stats"]'); await clickSel('[data-pill-group="stats"][data-pill="budget"]'); const ys = await p.$$('[data-budget-season]'); for (const y of ys) { try { await y.click(); await p.waitForTimeout(300); await harvest('budget season'); await p.$$eval('details', d => d.forEach(x => x.open = true)); await p.$$eval('[data-budget-act="add-line"]', b => b.slice(0, 2).forEach(x => x.click())); await p.waitForTimeout(300); await harvest('budget details'); } catch (e) {} } }],
    ['budget past outing', async () => { await clickSel('.bottom-nav-btn[data-view^="carnet"]'); await clickSel('.subnav-btn[data-view="carnet"]'); await clickText('Mugello'); }],
    ['new trackday', async () => { await clickSel('.subnav-btn[data-view="carnet"]'); await clickSel('.pill-btn[data-view="event"]'); await clickText(LANG === 'en' ? 'Add a trackday' : 'Ajouter un roulage'); }]
  ];
  for (const [name, fn] of scenarios) {
    await home(); try { await fn(); } catch (e) {} await harvest(name); await sweepPills(name);
  }
  const res = [];
  for (const [t, w] of seen) { const txt = t.replace(/^@[a-z-]+: /, ''); if (LANG === 'en' && FR.test(txt)) res.push(w + '  ||  ' + t); }
  fs.writeFileSync('found2-' + LANG + '.txt', res.join('\n'));
  fs.writeFileSync('all2-' + LANG + '.txt', [...seen].map(x => x[1] + ' || ' + x[0]).join('\n'));
  console.log(LANG, 'texts', seen.size, 'suspicious', res.length);
  await b.close();
})();
