const { chromium, BASE } = require('../lib');
const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 420, height: 2400 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  await p.goto(BASE + 'index.html#lang=en&admin=1'); await p.waitForTimeout(1600);
  await p.click('#settings-toggle'); await p.waitForTimeout(500);
  await p.getByText('Help', { exact: true }).first().click(); await p.waitForTimeout(500); await p.click('[data-pill-group="aide"][data-pill="admin"]');
  await p.waitForTimeout(800);
  // open every <details>
  await p.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
  await p.waitForTimeout(300);
  const out = await p.evaluate(() => {
    const o = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const t = n.nodeValue.trim(); if (t && n.parentElement && n.parentElement.offsetParent !== null && !/^(script|style)$/i.test(n.parentElement.tagName)) o.push(t); }
    document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(e => { ['placeholder', 'title', 'aria-label'].forEach(a => { const v = e.getAttribute(a); if (v) o.push('@' + a + ': ' + v); }); });
    return [...new Set(o)];
  });
  fs.writeFileSync('admin-pill.txt', out.join('\n'));
  await p.screenshot({ path: 'admin.png', fullPage: false });
  console.log(out.length);
  await b.close();
})();
