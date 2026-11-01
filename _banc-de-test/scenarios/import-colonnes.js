// Import d'une feuille en colonnes (Superlaps : une journée par colonne,
// « 14:52 1'18"979 »), en deux captures qui se chevauchent. La lecture
// d'image (Tesseract, hors ligne ici) est simulée par les mots et leurs
// positions tels qu'elle les rend.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.evaluate(() => {
    const shot = (rows1, rows2, withHead, y0) => {
      const words = [], lines = [];
      const add = (t, x0, y, x1) => words.push({ text: t, x0, y0: y, x1, y1: y + 30 });
      if (withHead) { lines.push({ text: '28 mars', x0: 123, y0: 855, x1: 300, y1: 895 }, { text: '29 mars', x0: 546, y0: 855, x1: 722, y1: 895 }); }
      rows1.forEach((r, i) => { add(r[0], 72, y0 + i * 73, 147); add(r[1], 173, y0 + i * 73, 330); });
      rows2.forEach((r, i) => { add(r[0], 495, y0 + i * 73, 570); add(r[1], 595, y0 + i * 73, 752); });
      return { text: words.map(w => w.text).join(' ') + (withHead ? ' 28 mars 29 mars Carole' : ''), confidence: 88, width: 923, words, lines };
    };
    const a = shot([['14:52', "1'18\"979"], ['14:53', "1'20\"512"], ['14:55', "1'17\"133"], ['14:56', "1'15\"567"], ['14:57', "1'14\"998"]],
      [['15:46', "1'13\"627"], ['15:47', "1'14\"525"], ['15:48', "1'15\"673"], ['15:50', "1'13\"470"]], true, 1000);
    const b2 = shot([['14:57', "1'14\"998"], ['14:58', "1'15\"350"], ['16:04', "1'20\"684"]],
      [['15:50', "1'13\"470"], ['15:51', "1'13\"006"], ['15:56', "1'11\"490"]], false, 300);
    const queue = [a, b2];
    window.ChronoImport.recognize = () => Promise.resolve(queue.shift());
  });
  await p.click('.bottom-nav-main'); await p.waitForTimeout(400);
  await p.click('#carnet-add-chrono, #add-chrono-toggle, .add-chrono-btn').catch(() => {}); await p.waitForTimeout(300);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await p.setInputFiles('#import-photo-input', [{ name: 'c1.png', mimeType: 'image/png', buffer: png }, { name: 'c2.png', mimeType: 'image/png', buffer: png }]);
  await p.waitForTimeout(900);
  console.log('choix:', await p.$$eval('input[name="imp-cand"]', e => e.map(x => x.parentNode.innerText.replace(/\s+/g, ' ').trim()).join(' | ')));
  console.log('consigne:', await p.$eval('.import-modal', e => (e.innerText.match(/Plusieurs journées[^\n]*|Several days[^\n]*/) || ['?'])[0]));
  console.log('journée 1:', await p.$eval('#imp-laps', e => e.value.split('\n').length + ' tours'), '| date', await p.$eval('#imp-date', e => e.value));
  await p.click('input[name="imp-cand"][value="1"]'); await p.waitForTimeout(200);
  console.log('journée 2:', await p.$eval('#imp-laps', e => e.value.replace(/\n/g, ' ')), '| date', await p.$eval('#imp-date', e => e.value));
  await p.click('[data-imp="apply"]'); await p.waitForTimeout(300);
  console.log('fenêtre fermée:', !(await p.$('.import-modal')), '|', await p.$eval('#imp-flags', e => e.innerText).catch(() => ''));
  console.log('formulaire:', await p.$eval('#f-date', e => e.value), '|', await p.$eval('#f-laps', e => e.value.split('\n').length + ' tours'));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
