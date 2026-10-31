#!/usr/bin/env node
// Banc de test de Pitbook : l'appli du dépôt, branchée sur un faux Firebase
// en mémoire (firebase-mock.js) rempli avec des données de démo (data.js,
// pilotes Alex et Sam). Rien ne part sur le vrai Firebase.
//
//   node _banc-de-test/lancer.js              démarre le banc sur http://localhost:8766/
//   node _banc-de-test/lancer.js tout         démarre, joue tous les scénarios, s'arrête
//   node _banc-de-test/lancer.js budget4 en   démarre, joue un scénario, s'arrête
//
// Adresses utiles : index.html#lang=fr (ou en), &admin=1 pour être admin,
// &noteam=1 pour ne mener aucun Team. Captures et relevés dans .sortie/.
//
// Le dossier commence par « _ » : GitHub Pages ne le publie pas.
var http = require('http');
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var BANC = __dirname;
var DEPOT = path.dirname(BANC);
var SORTIE = path.join(BANC, '.sortie');
var PORT = Number(process.env.PORT || 8766);

// La page d'accueil du banc : l'index.html du dépôt, avec le faux Firebase
// à la place du vrai et sans service worker (il garderait d'anciens
// fichiers en cache d'un lancement à l'autre).
function indexBanc() {
  var html = fs.readFileSync(path.join(DEPOT, 'index.html'), 'utf8');
  var app = fs.readFileSync(path.join(DEPOT, 'app.js'), 'utf8');
  var admin = (app.match(/var ADMIN_EMAIL = '([^']+)'/) || [])[1] || 'admin@example.com';
  var faux = '<script>window.__BENCH_ADMIN_EMAIL = ' + JSON.stringify(admin) + ';</script>' +
    '<script src="data.js"></script><script src="firebase-mock.js"></script><script>firebase.initializeApp({});</script>';
  var avant = html;
  html = html.replace(/<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+"><\/script>\s*/g, '')
    .replace(/<script src="firebase-config\.js"><\/script>/, faux)
    .replace(/navigator\.serviceWorker\.register\([^)]*\)/, 'Promise.resolve()');
  if (html === avant || html.indexOf('firebase-mock.js') === -1) throw new Error('index.html a changé : adapter indexBanc() dans lancer.js');
  return html;
}

var TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.webp': 'image/webp', '.ico': 'image/x-icon' };
function servir() {
  var srv = http.createServer(function (req, res) {
    var p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(indexBanc()); }
    // data.js et firebase-mock.js viennent du banc, tout le reste du dépôt.
    var f = /^\/(data|firebase-mock)\.js$/.test(p) ? path.join(BANC, p) : path.join(DEPOT, p);
    if (f.indexOf(DEPOT) !== 0 || /(^|[\\/])\./.test(path.relative(DEPOT, f))) { res.writeHead(403); return res.end(); }
    fs.readFile(f, function (err, data) {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': (TYPES[path.extname(f)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise(function (ok) { srv.listen(PORT, function () { ok(srv); }); });
}

// [scénario, arguments] joués par « tout ».
var TOUT = [
  ['crawl', 'fr'], ['crawl', 'en'], ['crawl2', 'fr'], ['crawl2', 'en'], ['crawl-admin'], ['crawl-admin2'],
  ['feat', 'fr'], ['budget4', 'fr'], ['budget4', 'en'], ['budget-page', 'fr'], ['reimp'], ['tyres-stats', 'fr'], ['tyres-stats', 'en'], ['pressures', 'fr'], ['pressures', 'en'], ['parrain', 'fr'], ['parrain', 'en'], ['tyres-used', 'fr'], ['tyres-used', 'en'], ['tyres-sessions', 'fr'], ['tyres-sessions', 'en'], ['eybis', 'fr'], ['amis', 'fr'], ['amis', 'en'], ['budget-roulage', 'fr'], ['budget-roulage', 'en'], ['team-rename', 'fr'], ['team-rename', 'en'], ['chrono-estime', 'fr'], ['chrono-estime', 'en'], ['moto-podium', 'fr'], ['moto-podium', 'en'], ['accompagnant', 'fr'], ['accompagnant', 'en'], ['accompagnant-plus', 'fr'], ['accompagnant-plus', 'en'], ['albums', 'fr'], ['albums', 'en'], ['role-roulage', 'fr'], ['role-roulage', 'en'], ['chrono-video', 'fr'], ['chrono-video', 'en'], ['records-piste', 'fr'], ['records-piste', 'en']
];
function jouer(nom, args) {
  return new Promise(function (ok) {
    var f = path.join(BANC, 'scenarios', nom + '.js');
    if (!fs.existsSync(f)) { console.log('Scénario inconnu : ' + nom); return ok(1); }
    console.log('\n== ' + nom + ' ' + args.join(' '));
    var c = cp.spawn(process.execPath, [f].concat(args), { cwd: SORTIE, stdio: 'inherit', env: Object.assign({}, process.env, { BANC_URL: 'http://localhost:' + PORT + '/' }) });
    c.on('exit', function (code) { ok(code || 0); });
  });
}

// Utilisé par d'autres outils du banc (guide/faire-guide.js) : on
// exporte le serveur sans rien lancer.
if (require.main !== module) { module.exports = { servir: servir, PORT: PORT, DEPOT: DEPOT, BANC: BANC }; return; }

(async function () {
  fs.mkdirSync(SORTIE, { recursive: true });
  indexBanc(); // échoue tout de suite si index.html ne se laisse plus adapter
  var srv = await servir();
  var a = process.argv.slice(2);
  if (!a.length) { console.log('Banc de test : http://localhost:' + PORT + '/index.html#lang=fr  (Ctrl+C pour arrêter)'); return; }
  var liste = a[0] === 'tout' ? TOUT : [[a[0]].concat(a.slice(1))];
  var echecs = 0;
  for (var i = 0; i < liste.length; i++) if (await jouer(liste[i][0], liste[i].slice(1))) echecs++;
  console.log('\n' + liste.length + ' scénario(s), ' + echecs + ' en échec. Captures et relevés : ' + SORTIE);
  srv.close();
  process.exit(echecs ? 1 : 0);
})();
