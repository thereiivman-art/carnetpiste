#!/usr/bin/env node
// Plan de circuit (image : trait sombre sur fond clair) -> tracé au style
// Pitbook (circuit-outlines/*.png : 1920x1080, trait #1b1d22 de 16 px,
// départ en rouge #c8261f).
//
//   node _banc-de-test/traces/image-vers-trace.js reglages.json
//
// reglages.json : { "source": "plan.png", "sortie": "circuit-outlines/X.png",
//   "seuil": 110, "effacer": [[x, y, l, h], ...], "relier": [[x1, y1, x2, y2], ...],
//   "depart": [x, y] }   (coordonnées dans l'image source)
// On garde le plus grand morceau de trait sombre (le circuit : les numéros
// de virage et les flèches tombent), on en tire la ligne centrale et on la
// redessine.
const fs = require('fs');
const path = require('path');
const { chromium } = require('../lib');

(async () => {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const base = path.dirname(path.resolve(process.argv[2]));
  const src = path.resolve(base, cfg.source), out = path.resolve(base, cfg.sortie);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto('file://' + src); // même origine que l'image : le canvas reste lisible
  const png = await p.evaluate(async (cfg) => {
    const img = document.querySelector('img') || await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = location.href; });
    const K = 3; // on travaille 3 fois plus grand pour une ligne centrale propre
    const W = img.naturalWidth * K, H = img.naturalHeight * K;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let m = new Uint8Array(W * H);
    const seuil = cfg.seuil || 110;
    for (let i = 0; i < W * H; i++) { const r = d[i * 4], gg = d[i * 4 + 1], bb = d[i * 4 + 2]; m[i] = (r + gg + bb) / 3 < seuil ? 1 : 0; }
    (cfg.effacer || []).forEach(([x, y, w, h]) => { for (let yy = y * K; yy < (y + h) * K; yy++) for (let xx = x * K; xx < (x + w) * K; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) m[yy * W + xx] = 0; });
    (cfg.relier || []).forEach(([x1, y1, x2, y2]) => {
      const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * K), t = cfg.epaisseur || 6;
      for (let k = 0; k <= n; k++) { const x = (x1 + (x2 - x1) * k / n) * K, y = (y1 + (y2 - y1) * k / n) * K;
        for (let dy = -t; dy <= t; dy++) for (let dx = -t; dx <= t; dx++) { const xx = Math.round(x + dx), yy = Math.round(y + dy); if (xx >= 0 && yy >= 0 && xx < W && yy < H) m[yy * W + xx] = 1; } }
    });
    // plus grand morceau connexe
    const lab = new Int32Array(W * H); let best = 0, bestN = 0, cur = 0;
    for (let i = 0; i < W * H; i++) {
      if (!m[i] || lab[i]) continue; cur++; let n = 0; const st = [i]; lab[i] = cur;
      while (st.length) { const q = st.pop(); n++; const x = q % W, y = (q / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (m[j] && !lab[j]) { lab[j] = cur; st.push(j); } } }
      if (n > bestN) { bestN = n; best = cur; }
    }
    for (let i = 0; i < W * H; i++) m[i] = lab[i] === best ? 1 : 0;
    // squelette (Zhang-Suen)
    const P = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : m[y * W + x];
    let changed = true;
    while (changed) { changed = false;
      for (let step = 0; step < 2; step++) { const del = [];
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { if (!m[y * W + x]) continue;
          const p2 = P(x, y - 1), p3 = P(x + 1, y - 1), p4 = P(x + 1, y), p5 = P(x + 1, y + 1), p6 = P(x, y + 1), p7 = P(x - 1, y + 1), p8 = P(x - 1, y), p9 = P(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]; let A = 0; for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++; if (A !== 1) continue;
          if (step === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
          del.push(y * W + x); }
        del.forEach(i => { m[i] = 0; }); if (del.length) changed = true; } }
    // ébarbage : on retire les petites branches mortes
    for (let it = 0; it < 30 * K; it++) { const ends = [];
      for (let i = 0; i < W * H; i++) { if (!m[i]) continue; const x = i % W, y = (i / W) | 0; let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && P(x + dx, y + dy)) n++; if (n <= 1) ends.push(i); }
      if (!ends.length) break; ends.forEach(i => { m[i] = 0; }); }
    // parcours de la boucle depuis le point le plus proche du départ
    const [sx, sy] = cfg.depart.map(v => v * K); let start = -1, sd = 1e18;
    for (let i = 0; i < W * H; i++) if (m[i]) { const x = i % W, y = (i / W) | 0, dd = (x - sx) ** 2 + (y - sy) ** 2; if (dd < sd) { sd = dd; start = i; } }
    const seen = new Uint8Array(W * H), pts = []; let q = start, prev = null;
    while (q !== -1) { seen[q] = 1; const x = q % W, y = (q / W) | 0; pts.push([x, y]); let nxt = -1, nb = -1e9;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const xx = x + dx, yy = y + dy; if (!P(xx, yy) || seen[yy * W + xx]) continue;
        const sc = prev ? (dx * prev[0] + dy * prev[1]) / Math.hypot(dx, dy) : 0; if (sc > nb) { nb = sc; nxt = yy * W + xx; } }
      prev = nxt === -1 ? prev : [(nxt % W) - x, ((nxt / W) | 0) - y]; q = nxt; }
    // simplification (Douglas-Peucker) puis lissage (Chaikin)
    function rdp(a, e) { if (a.length < 3) return a; const [x1, y1] = a[0], [x2, y2] = a[a.length - 1]; let md = 0, mi = 0; const L = Math.hypot(x2 - x1, y2 - y1) || 1;
      for (let i = 1; i < a.length - 1; i++) { const dd = Math.abs((y2 - y1) * a[i][0] - (x2 - x1) * a[i][1] + x2 * y1 - y2 * x1) / L; if (dd > md) { md = dd; mi = i; } }
      return md > e ? rdp(a.slice(0, mi + 1), e).slice(0, -1).concat(rdp(a.slice(mi), e)) : [a[0], a[a.length - 1]]; }
    let poly = rdp(pts, 1.5 * K);
    for (let it = 0; it < 3; it++) { const o = []; for (let i = 0; i < poly.length; i++) { const a = poly[i], bpt = poly[(i + 1) % poly.length]; o.push([a[0] * .75 + bpt[0] * .25, a[1] * .75 + bpt[1] * .25], [a[0] * .25 + bpt[0] * .75, a[1] * .25 + bpt[1] * .75]); } poly = o; }
    // mise à l'échelle 1920x1080, marge 120
    const xs = poly.map(v => v[0]), ys = poly.map(v => v[1]); const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const s = Math.min((1920 - 240) / (maxx - minx), (1080 - 240) / (maxy - miny)); const ox = (1920 - (maxx - minx) * s) / 2, oy = (1080 - (maxy - miny) * s) / 2;
    const T = v => [ox + (v[0] - minx) * s, oy + (v[1] - miny) * s];
    const o = document.createElement('canvas'); o.width = 1920; o.height = 1080; const h = o.getContext('2d');
    h.fillStyle = '#fff'; h.fillRect(0, 0, 1920, 1080);
    h.lineWidth = 16; h.lineJoin = 'round'; h.lineCap = 'round'; h.strokeStyle = '#1b1d22';
    h.beginPath(); poly.forEach((v, i) => { const [x, y] = T(v); i ? h.lineTo(x, y) : h.moveTo(x, y); }); h.closePath(); h.stroke();
    // départ : trait rouge perpendiculaire à la piste
    const st0 = T([sx, sy]); let bi = 0, bd = 1e18; poly.forEach((v, i) => { const [x, y] = T(v), dd = (x - st0[0]) ** 2 + (y - st0[1]) ** 2; if (dd < bd) { bd = dd; bi = i; } });
    const A = T(poly[(bi - 2 + poly.length) % poly.length]), Bp = T(poly[(bi + 2) % poly.length]), C = T(poly[bi]);
    let tx = Bp[0] - A[0], ty = Bp[1] - A[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    h.strokeStyle = '#c8261f'; h.beginPath(); h.moveTo(C[0] - ty * 45, C[1] + tx * 45); h.lineTo(C[0] + ty * 45, C[1] - tx * 45); h.stroke();
    return { png: o.toDataURL('image/png'), points: pts.length, poly: poly.length, closed: Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) / K };
  }, cfg);
  fs.writeFileSync(out, Buffer.from(png.png.split(',')[1], 'base64'));
  console.log(path.relative(process.cwd(), out), '| points', png.points, '| fermeture (px source)', png.closed.toFixed(1));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
