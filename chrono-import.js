// Import de chronos depuis une photo / une capture d'écran / du texte collé.
//
// Rien ici ne touche à l'état de l'appli ni à Firestore : ce fichier ne fait
// que (1) lire une image avec Tesseract.js (reconnaissance de texte gratuite,
// exécutée sur l'appareil -- aucune image n'est envoyée nulle part), (2)
// transformer le texte obtenu en candidats { label, laps[] } et (3) deviner
// date / circuit / ligne du pilote. app.js affiche ensuite un écran de
// validation obligatoire avant que quoi que ce soit n'atteigne le formulaire.
(function (root) {
  'use strict';

  // Version figée (jamais "latest") : le script s'exécute dans la page de
  // l'appli, donc on ne charge qu'une version précise et connue.
  var TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function normKey(s) {
    return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ---- Temps ----

  // Corrige les confusions classiques de la reconnaissance de texte (O->0,
  // l/I->1, S->5, ","->".", ";"->":", 1'58"742) mais seulement DANS un mot
  // fait de caractères "de temps" contenant au moins un vrai chiffre, et
  // toujours un caractère pour un caractère -- les positions restent donc
  // identiques à la ligne d'origine (le nom du pilote n'est jamais touché).
  function fixTimeish(line) {
    return line.replace(/\S+/g, function (word) {
      if (!/^[\dOolI|S;,.:'"’`´“”¨]+$/.test(word) || !/\d/.test(word)) return word;
      return word
        .replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/S/g, '5')
        .replace(/;/g, ':').replace(/,/g, '.')
        .replace(/['’`´]/g, ':').replace(/["”“¨]/g, '.');
    });
  }

  function formatLap(sec) {
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    var str = s.toFixed(3);
    if (s < 10) str = '0' + str;
    return m + ':' + str;
  }

  // Un temps au tour vraisemblable : 20 s à 10 min.
  function plausibleLap(sec) { return sec >= 20 && sec <= 600; }

  // Extrait tous les temps d'une ligne. Formats acceptés : 1:58.742,
  // 1:58.74, 1'58"742, 1.58.742 (points au lieu de ":"), et 58.742 (secondes
  // seules, 3 décimales exactement -- pour ne pas confondre avec une heure
  // comme 14.20 ou une date).
  function extractTimes(line, loose) {
    var times = [];
    var used = [];
    var re = /(?:^|[^\d.:'"])(\d{1,2})\s?[:'.;]\s?([0-5]\d)\s?[.,:"]\s?(\d{1,3})(?![\d])/g;
    var m;
    var work = fixTimeish(' ' + line + ' ');
    // work a un espace de plus en tête : les index sont décalés de 1 par
    // rapport à `line` (corrigé ci-dessous dans le retour).
    // On ne corrige O/l/S qu'à l'intérieur des mots "temps" : on ré-extrait
    // donc depuis la ligne corrigée complète mais en exigeant des chiffres.
    while ((m = re.exec(work))) {
      var min = parseInt(m[1], 10), sec = parseInt(m[2], 10), ms = m[3];
      var frac = parseFloat('0.' + ms);
      var total = min * 60 + sec + frac;
      if (plausibleLap(total)) {
        var lead = m[0].match(/^[^\d]*/)[0].length;
        times.push({ sec: total, index: m.index + lead, end: m.index + m[0].length });
        used.push([m.index, m.index + m[0].length]);
      }
      re.lastIndex = m.index + m[0].length - 1;
    }
    // loose (texte collé par l'utilisateur, pas d'OCR) : 88.04 ou 78.5 sont
    // acceptés aussi ; hors de ce mode on exige 3 décimales pour ne pas
    // prendre une heure (14.20) ou une date pour un tour.
    var re2 = loose ? /(?:^|[^\d.:])(\d{2,3})[.,](\d{1,3})(?![\d])/g : /(?:^|[^\d.:])(\d{2})[.,](\d{3})(?![\d])/g;
    while ((m = re2.exec(work))) {
      var start = m.index;
      if (used.some(function (u) { return start >= u[0] - 1 && start < u[1]; })) continue;
      var v = parseInt(m[1], 10) + parseFloat('0.' + m[2]);
      if (plausibleLap(v)) {
        var lead2 = m[0].match(/^[^\d]*/)[0].length;
        times.push({ sec: v, index: m.index + lead2, end: m.index + m[0].length });
      }
    }
    times.sort(function (a, b) { return a.index - b.index; });
    times.forEach(function (t) { t.index -= 1; t.end -= 1; });
    return times;
  }

  // ---- Date ----

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function validDate(y, mo, d) {
    if (y < 100) y += 2000;
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1) return null;
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }
  var IT_MONTHS = { gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12 };
  var FR_MONTHS = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 };
  var EN_MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

  function findDate(text) {
    var m = text.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
    if (m) { var iso = validDate(+m[1], +m[2], +m[3]); if (iso) return iso; }
    var re = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})\b/g;
    while ((m = re.exec(text))) {
      var iso2 = validDate(+m[3], +m[2], +m[1]);
      if (iso2) return iso2;
    }
    var t = stripAccents(text).toLowerCase();
    var re3 = /\b(\d{1,2})\s+([a-z]{3,9})\s+(20\d{2})\b/g;
    while ((m = re3.exec(t))) {
      var mo = IT_MONTHS[m[2]] || FR_MONTHS[m[2]] || EN_MONTHS[m[2]];
      if (mo) { var iso3 = validDate(+m[3], mo, +m[1]); if (iso3) return iso3; }
    }
    return null;
  }

  // ---- Circuit ----

  function findCircuit(text, circuitNames) {
    var hay = ' ' + normKey(text) + ' ';
    var best = null;
    (circuitNames || []).forEach(function (name) {
      var key = normKey(name);
      if (key.length < 3) return;
      if (hay.indexOf(' ' + key + ' ') !== -1 || hay.indexOf(' ' + key) !== -1) {
        if (!best || key.length > best.key.length) best = { name: name, key: key };
      }
    });
    return best ? best.name : null;
  }

  // ---- Lignes / candidats ----

  function cleanLabel(line, times) {
    var label = line;
    times.slice().reverse().forEach(function (t) {
      label = label.slice(0, Math.max(0, t.index)) + ' ' + label.slice(Math.max(0, t.end));
    });
    return label.replace(/\s+/g, ' ').replace(/^[\s|:;,.\-_]+|[\s|:;,.\-_]+$/g, '').trim();
  }

  function hasName(label) {
    return /[A-Za-zÀ-ÿ]{3,}/.test(label);
  }

  // Candidats : une ligne = un pilote (plusieurs temps), ou un pilote par ligne
  // avec son seul meilleur temps (classement), ou un seul pilote dont chaque
  // ligne est un tour.
  function buildCandidates(text, loose) {
    var lines = String(text || '').split(/\r?\n/);
    var rows = [];
    lines.forEach(function (line) {
      var times = extractTimes(line, loose);
      if (!times.length) return;
      rows.push({ raw: line, times: times, label: cleanLabel(line, times) });
    });
    var candidates = [];
    var multi = rows.filter(function (r) { return r.times.length >= 2; });
    var named = rows.filter(function (r) { return r.times.length === 1 && hasName(r.label); });

    if (multi.length) {
      multi.forEach(function (r) {
        candidates.push({ label: r.label || 'Ligne', named: hasName(r.label), laps: r.times.map(function (t) { return t.sec; }), kind: 'row', raw: r.raw });
      });
    }
    if (named.length >= 2 && !multi.length) {
      named.forEach(function (r) {
        candidates.push({ label: r.label, named: true, laps: [r.times[0].sec], kind: 'best', raw: r.raw });
      });
    }
    // Tous les temps de la page, dans l'ordre : le cas d'un tableau de tours
    // d'un seul pilote (ou le secours si la ligne du pilote n'est pas reconnue).
    var all = [];
    rows.forEach(function (r) { r.times.forEach(function (t) { all.push(t.sec); }); });
    if (all.length && (!candidates.length || candidates.length > 1 || candidates[0].kind !== 'row' || all.length !== candidates[0].laps.length)) {
      var onlyNumericRows = rows.every(function (r) { return !hasName(r.label); });
      candidates.push({
        label: onlyNumericRows ? 'Tous les tours détectés' : 'Tous les temps de la page',
        laps: all, kind: 'all', raw: ''
      });
    }
    return candidates;
  }

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    if (!s.length) return 0;
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Indices des tours qui sortent nettement de la série (tour de rentrée,
  // erreur de lecture...) -- simple signalement, jamais supprimés d'office.
  function outlierIndexes(laps) {
    if (laps.length < 3) return [];
    var med = median(laps);
    var out = [];
    laps.forEach(function (v, i) { if (v > med * 1.35 || v < med * 0.75) out.push(i); });
    return out;
  }

  // Pré-sélection du pilote : numéro de course (mot entier) d'abord, puis un
  // morceau du pseudo / prénom / nom (3 lettres min).
  function scoreCandidateForMe(candidate, me) {
    if (!me) return 0;
    var label = ' ' + normKey(candidate.label + ' ' + (candidate.raw || '')) + ' ';
    var score = 0;
    var num = String(me.number || '').replace(/\D/g, '');
    if (num) {
      var rawLabel = ' ' + String(candidate.raw || candidate.label).replace(/[^\dA-Za-z]+/g, ' ') + ' ';
      var firstTimeIdx = rawLabel.search(/\d\s?[:'.]\s?\d/);
      var beforeTimes = firstTimeIdx > -1 ? rawLabel.slice(0, firstTimeIdx) : rawLabel;
      if (new RegExp('(^|\\s)#?' + num + '(\\s|$)').test(beforeTimes)) score += 3;
    }
    (me.names || []).forEach(function (n) {
      normKey(n).split(' ').forEach(function (part) {
        if (part.length >= 3 && label.indexOf(' ' + part) !== -1) score += 2;
      });
    });
    return score;
  }

  // Point d'entrée : texte (OCR ou collé) -> tout ce que l'écran de validation
  // doit afficher. `confidence` (0-100) vient de l'OCR, 100 pour du texte collé.
  function analyze(text, opts) {
    opts = opts || {};
    var candidates = buildCandidates(text, opts.loose);
    candidates.forEach(function (c) {
      c.outliers = outlierIndexes(c.laps);
      c.score = scoreCandidateForMe(c, opts.me);
    });
    var bestIdx = -1, bestScore = 0;
    candidates.forEach(function (c, i) { if (c.score > bestScore) { bestScore = c.score; bestIdx = i; } });
    if (bestIdx === -1 && candidates.length === 1) bestIdx = 0;
    // Aucune ligne nommée (simple liste de temps) : on prend "tous les tours".
    if (bestIdx === -1 && !candidates.some(function (c) { return c.named; })) {
      candidates.forEach(function (c, i) { if (c.kind === 'all') bestIdx = i; });
    }
    var confidence = opts.confidence == null ? 100 : opts.confidence;
    return {
      candidates: candidates,
      selected: bestIdx,           // -1 = l'utilisateur doit choisir sa ligne
      autoMatched: bestScore > 0,
      date: findDate(text),
      circuit: findCircuit(text, opts.circuits),
      confidence: confidence,
      lowConfidence: confidence < 75 || candidates.some(function (c) { return c.outliers.length > 0; })
    };
  }

  // Texte libre saisi par l'utilisateur dans le formulaire : mêmes règles.
  function parseLapList(text) {
    var laps = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var found = extractTimes(line, true);
      var bare = line.trim().match(/^(\d{2,3}(?:[.,]\d+)?)$/);
      if (!found.length && bare) { var v = parseFloat(bare[1].replace(',', '.')); if (plausibleLap(v)) laps.push(v); }
      found.forEach(function (t) { laps.push(t.sec); });
    });
    return laps;
  }

  // ---- Image -> texte (Tesseract.js) ----

  var tesseractPromise = null;
  function loadTesseract() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.crossOrigin = 'anonymous';
      s.onload = function () { root.Tesseract ? resolve(root.Tesseract) : reject(new Error('tesseract-missing')); };
      s.onerror = function () { tesseractPromise = null; reject(new Error('tesseract-load-failed')); };
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }

  // Redimensionne (2000 px max : assez pour lire de petits chiffres, assez
  // léger pour un téléphone), passe en niveaux de gris et étire le contraste.
  function prepareImage(file, maxDim) {
    maxDim = maxDim || 2000;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var k = Math.min(1, maxDim / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        try {
          var data = ctx.getImageData(0, 0, cw, ch);
          var px = data.data, lo = 255, hi = 0, i, g;
          for (i = 0; i < px.length; i += 4) {
            g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
            px[i] = g;
            if (g < lo) lo = g;
            if (g > hi) hi = g;
          }
          var span = Math.max(1, hi - lo);
          for (i = 0; i < px.length; i += 4) {
            g = (px[i] - lo) * 255 / span;
            px[i] = px[i + 1] = px[i + 2] = g;
          }
          ctx.putImageData(data, 0, 0);
        } catch (e) { /* canvas contaminé : on garde l'image telle quelle */ }
        resolve(canvas);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image-unreadable')); };
      img.src = url;
    });
  }

  // -> Promise<{ text, confidence }>. onProgress(0..1, statut)
  function recognize(file, onProgress) {
    return Promise.all([loadTesseract(), prepareImage(file)]).then(function (res) {
      var T = res[0], canvas = res[1];
      return T.createWorker('eng', 1, {
        logger: function (m) { if (onProgress && m && typeof m.progress === 'number') onProgress(m.progress, m.status); }
      }).then(function (worker) {
        return worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }).then(function () {
          return worker.recognize(canvas);
        }).then(function (r) {
          return worker.terminate().then(function () {
            return { text: (r.data && r.data.text) || '', confidence: (r.data && r.data.confidence) || 0 };
          });
        });
      });
    });
  }

  root.ChronoImport = {
    analyze: analyze,
    extractTimes: extractTimes,
    parseLapList: parseLapList,
    formatLap: formatLap,
    findDate: findDate,
    findCircuit: findCircuit,
    outlierIndexes: outlierIndexes,
    recognize: recognize,
    loadTesseract: loadTesseract
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ChronoImport;
})(typeof window !== 'undefined' ? window : globalThis);
