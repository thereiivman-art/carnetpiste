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
  var PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  var PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
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
    if (sec == null) return '??';
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
    // Heures de passage (10:39:15.314) : ce n'est pas un temps au tour --
    // remplacées par des espaces de même longueur (les positions restent).
    var noClock = line.replace(/\b\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\b/g, function (c) { return new Array(c.length + 1).join(' '); });
    var work = fixTimeish(' ' + noClock + ' ');
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
        times.push({ sec: total, minutes: true, index: m.index + lead, end: m.index + m[0].length });
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
    // Une ligne qui contient un vrai temps m:ss.mmm : les secondes seules à
    // côté (temps de secteur 31.723, écart 2.218...) n'en sont pas.
    if (times.some(function (t) { return t.minutes; })) times = times.filter(function (t) { return t.minutes; });
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

  // Libellé d'une ligne = ce qui précède le premier temps (numéro + nom) si
  // ça contient un nom -- le reste (écarts, tours, classe SBK/SSP...) n'en fait pas partie.
  function cleanLabel(line, times) {
    if (times.length) {
      var before = line.slice(0, Math.max(0, times[0].index)).replace(/\s+/g, ' ').trim();
      before = before.replace(/(\s+(SBK|SSP|STK|SS|PRO|AMA|EVO|[A-Z]{3}))+$/, '').replace(/[\s|:;,.\-_]+$/, '');
      before = before.replace(/^\d{1,3}\s+(?=#?\d{1,3}\s)/, '');
      if (hasName(before)) return before;
    }
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
  // En-tête d'un pilote dans un relevé détaillé : "(167) GERMAIN Xavier"
  // (ligne sans temps, numéro + nom).
  function parseSectionHeader(line) {
    var m = line.trim().match(/^[(\[]?\s*#?(\d{1,3})\s*[)\]]?\s*[-:]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’. \-]{2,})$/);
    if (!m) return null;
    return { number: m[1], name: m[2].trim() };
  }

  function buildCandidates(text, loose) {
    var lines = String(text || '').split(/\r?\n/);
    var rows = [];
    var sections = [];
    var current = null;
    lines.forEach(function (line) {
      var times = extractTimes(line, loose);
      // En-tête "(167) GERMAIN Xavier" collé en fin de ligne (capture sur
      // deux colonnes lue par l'OCR) : on le sort de la ligne.
      var inline = line.match(/\((\d{1,3})\s*\)\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'’. \-]{2,})\s*$/);
      if (inline && !times.some(function (t) { return t.minutes; }) && parseSectionHeader(line) == null) {
        current = { label: '(' + inline[1] + ') ' + inline[2].trim(), raw: inline[0], laps: [], rebuilt: [] }; sections.push(current);
        return;
      }
      if (!times.length) {
        var h = parseSectionHeader(line);
        if (h) { current = { label: '(' + h.number + ') ' + h.name, raw: line, laps: [], rebuilt: [] }; sections.push(current); }
        return;
      }
      var row = { raw: line, times: times, label: cleanLabel(line, times) };
      rows.push(row);
      if (current) {
        // Relevé tour par tour : le tour est le temps avec minutes. S'il n'a
        // pas été lu mais que les 4 temps de secteur l'ont été, le tour en
        // est la somme (signalée "reconstitué") ; sinon ligne illisible (??).
        var withMin = times.filter(function (t) { return t.minutes; });
        if (withMin.length) { current.laps.push(withMin[0].sec); }
        else {
          var sum = times.length >= 4 ? times.slice(-4).reduce(function (a, t) { return a + t.sec; }, 0) : 0;
          if (sum >= 60 && sum <= 400) { current.rebuilt.push(current.laps.length); current.laps.push(Math.round(sum * 1000) / 1000); }
          else current.laps.push(null);
        }
      }
    });
    var candidates = [];

    // Relevé détaillé par pilote (une section par pilote, un tour par ligne).
    var usable = sections.filter(function (sec) { return sec.laps.length >= 1; });
    if (usable.length) {
      usable.forEach(function (sec) {
        candidates.push({ label: sec.label, named: true, laps: sec.laps, rebuilt: sec.rebuilt, kind: 'section', raw: sec.raw });
      });
      return candidates;
    }

    var multi = rows.filter(function (r) { return r.times.length >= 2; });
    var named = rows.filter(function (r) { return r.times.length === 1 && hasName(r.label) && !/break|no laps|pause|session/i.test(r.label); });

    // Colonnes (ex. un tableau "Day 2 Morning | Day 2 Afternoon" : une
    // colonne = une session) : lignes sans nom ayant toutes le même nombre
    // de temps, au moins 3 lignes -> un candidat par colonne.
    var unlabeled = multi.filter(function (r) { return !hasName(r.label); });
    var counts = {};
    unlabeled.forEach(function (r) { counts[r.times.length] = (counts[r.times.length] || 0) + 1; });
    var modal = 0;
    Object.keys(counts).forEach(function (k) { if (counts[k] >= 3 && (!modal || counts[k] > counts[modal])) modal = parseInt(k, 10); });
    if (modal) {
      var full = unlabeled.filter(function (r) { return r.times.length === modal; });
      for (var c = 0; c < modal; c++) {
        candidates.push({ label: 'Colonne ' + (c + 1), named: false, laps: full.map(function (r) { return r.times[c].sec; }), kind: 'column', raw: '' });
      }
      multi = multi.filter(function (r) { return unlabeled.indexOf(r) === -1; });
    }

    multi.forEach(function (r) {
      candidates.push({ label: r.label || 'Ligne', named: hasName(r.label), laps: r.times.map(function (t) { return t.sec; }), kind: 'row', raw: r.raw });
    });
    if (named.length >= 2 && !multi.length) {
      named.forEach(function (r) {
        candidates.push({ label: r.label, named: true, laps: [r.times[0].sec], kind: 'best', raw: r.raw });
      });
    }
    // Tous les temps de la page, dans l'ordre : le cas d'un tableau de tours
    // d'un seul pilote (ou le secours si la ligne du pilote n'est pas reconnue).
    var all = [];
    rows.forEach(function (r) { r.times.forEach(function (t) { all.push(t.sec); }); });
    var onlyRows = candidates.length && candidates.every(function (c) { return c.kind === 'row'; });
    if (all.length && (!candidates.length || candidates.length > 1 || !onlyRows || all.length !== candidates[0].laps.length)) {
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
    var valid = laps.filter(function (v) { return v != null; });
    if (valid.length < 3) return [];
    var med = median(valid);
    var out = [];
    laps.forEach(function (v, i) { if (v != null && (v > med * 1.35 || v < med * 0.75)) out.push(i); });
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
      if (!candidates.some(function (c) { return c.kind === 'column'; })) candidates.forEach(function (c, i) { if (c.kind === 'all') bestIdx = i; });
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

  function ocrCanvas(canvas, onProgress) {
    return loadTesseract().then(function (T) {
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

  // ---- PDF (texte vectoriel, ex. classements MyLaps) ----

  var pdfJsPromise = null;
  function loadPdfJs() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDFJS_URL;
      s.crossOrigin = 'anonymous';
      s.onload = function () {
        if (!root.pdfjsLib) { reject(new Error('pdfjs-missing')); return; }
        root.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        resolve(root.pdfjsLib);
      };
      s.onerror = function () { pdfJsPromise = null; reject(new Error('pdfjs-load-failed')); };
      document.head.appendChild(s);
    });
    return pdfJsPromise;
  }

  // Éléments de texte positionnés ({str, x, y}) -> lignes : même hauteur
  // (tolérance ~ une demi-ligne), de gauche à droite, de haut en bas.
  function itemsToLines(items, tolerance) {
    tolerance = tolerance || 3;
    var rows = [];
    items.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; }).forEach(function (it) {
      if (!String(it.str).trim()) return;
      var row = rows.filter(function (r) { return Math.abs(r.y - it.y) <= tolerance; })[0];
      if (!row) { row = { y: it.y, cells: [] }; rows.push(row); }
      row.cells.push(it);
    });
    rows.sort(function (a, b) { return b.y - a.y; });
    return rows.map(function (r) {
      return r.cells.sort(function (a, b) { return a.x - b.x; }).map(function (c) { return String(c.str).trim(); }).join(' ');
    });
  }

  function recognizePdf(file, onProgress) {
    return loadPdfJs().then(function (pdfjs) {
      return file.arrayBuffer().then(function (buf) { return pdfjs.getDocument({ data: buf }).promise; });
    }).then(function (pdf) {
      var pages = [];
      for (var n = 1; n <= Math.min(pdf.numPages, 20); n++) pages.push(n);
      var lines = [];
      return pages.reduce(function (chain, n) {
        return chain.then(function () {
          return pdf.getPage(n).then(function (page) { return page.getTextContent(); }).then(function (tc) {
            var items = tc.items.map(function (it) { return { str: it.str, x: it.transform[4], y: it.transform[5] }; });
            lines = lines.concat(itemsToLines(items), ['']);
            if (onProgress) onProgress(n / pages.length, 'lecture du PDF');
          });
        });
      }, Promise.resolve()).then(function () {
        var text = lines.join('\n');
        if (text.replace(/\s/g, '').length >= 20) return { text: text, confidence: 100 };
        // PDF scanné (une image) : on rend la 1re page et on la lit comme une photo.
        return pdf.getPage(1).then(function (page) {
          var viewport = page.getViewport({ scale: 2 });
          var canvas = document.createElement('canvas');
          canvas.width = viewport.width; canvas.height = viewport.height;
          return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function () {
            return ocrCanvas(canvas, onProgress);
          });
        });
      });
    });
  }

  function isPdf(file) {
    return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
  }

  // -> Promise<{ text, confidence }>. onProgress(0..1, statut)
  function recognize(file, onProgress) {
    if (isPdf(file)) return recognizePdf(file, onProgress);
    return prepareImage(file).then(function (canvas) { return ocrCanvas(canvas, onProgress); });
  }


  // ---- Horaires (affiche / PDF de l'organisateur) ----
  // Reconnaît, ligne par ligne, une lettre de groupe (R, A, B, C, D, ou
  // "R - ROOKIE", "Groupe B", "Gr. C"...) et des heures (9:00, 09.15, 9h20).
  // - ligne avec groupe + 2 heures : un créneau début-fin ;
  // - ligne avec groupe + plusieurs heures : paires début/fin si elles
  //   s'enchaînent comme telles, sinon des débuts (durée par défaut).
  // Résultat au format des horaires de l'appli : { groupA: "9h00-9h20, ..." }.
  function parseClock(tok) {
    var m = String(tok).match(/^(\d{1,2})\s*[:.hH]\s*(\d{2})$/);
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59 || h < 6) return null;
    return h * 60 + mi;
  }
  function fmtClock(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return h + 'h' + (m < 10 ? '0' : '') + m;
  }
  function findGroupLetter(line) {
    var t = ' ' + stripAccents(line).toUpperCase().replace(/[|]/g, ' ') + ' ';
    var m = t.match(/(?:^|\s)(?:GROUPE?|GR\.?)\s*([RABCD])(?=[\s.:\-)]|$)/);
    if (m) return m[1];
    m = t.match(/(?:^|\s)([RABCD])\s*[-–:]\s*[A-Z]{3,}/); // "R - ROOKIE", "B - ESPERTI"
    if (m) return m[1];
    var words = { ROOKIE: 'R', ROOKIES: 'R', AMATORI: 'A', ESPERTI: 'B', VELOCI: 'C', PRO: 'D' };
    for (var w in words) if (new RegExp('\\s' + w + '\\s').test(t)) return words[w];
    m = t.match(/^\s*([RABCD])\s+(?=\d)/); // ligne qui commence par la lettre seule
    if (m) return m[1];
    return null;
  }
  function parseHoraires(text, defaultDuration) {
    defaultDuration = defaultDuration || 20;
    var slots = {}; // letter -> [{s,e}]
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var letter = findGroupLetter(line);
      if (!letter) return;
      var times = (line.match(/\b\d{1,2}\s*[:.hH]\s*\d{2}\b/g) || []).map(parseClock).filter(function (v) { return v !== null; });
      if (!times.length) return;
      var list = slots[letter] || (slots[letter] = []);
      if (times.length === 2 && times[1] > times[0] && times[1] - times[0] <= 60) {
        list.push({ s: times[0], e: times[1] });
        return;
      }
      // Appariement glouton début/fin (créneau de 45 min max). Une heure
      // isolée au milieu de paires (ex. colonne « pause 13.00 ») est ignorée.
      var pairs = [], singles = [], i = 0;
      while (i < times.length) {
        var d = i + 1 < times.length ? times[i + 1] - times[i] : -1;
        if (d > 0 && d <= 45 && (i + 2 >= times.length || times[i + 2] >= times[i + 1])) { pairs.push({ s: times[i], e: times[i + 1] }); i += 2; }
        else { singles.push(times[i]); i++; }
      }
      if (pairs.length >= 2) pairs.forEach(function (x) { list.push(x); });
      else times.forEach(function (t) { list.push({ s: t, e: t + defaultDuration }); });
    });
    var out = {}, count = 0;
    Object.keys(slots).forEach(function (letter) {
      var seen = {};
      var list = slots[letter].filter(function (x) { var k = x.s + '-' + x.e; if (seen[k]) return false; seen[k] = true; return true; })
        .sort(function (a, b) { return a.s - b.s; });
      if (!list.length) return;
      out['group' + letter] = list.map(function (x) { return fmtClock(x.s) + '-' + fmtClock(x.e); }).join(', ');
      count += list.length;
    });
    return { horaires: out, slotCount: count };
  }

  // Télécharge le lecteur de texte et le lecteur de PDF à l'avance, pour
  // qu'ils marchent ensuite sans réseau (le service worker les garde, et
  // Tesseract garde ses données de langue dans le navigateur).
  function prepareOffline() {
    return loadTesseract().then(function (T) {
      return T.createWorker('eng', 1).then(function (worker) { return worker.terminate(); });
    }).then(function () {
      return loadPdfJs();
    }).then(function () {
      return fetch(PDFJS_WORKER_URL, { mode: 'no-cors' });
    });
  }

  root.ChronoImport = {
    parseHoraires: parseHoraires,
    analyze: analyze,
    extractTimes: extractTimes,
    parseLapList: parseLapList,
    formatLap: formatLap,
    findDate: findDate,
    findCircuit: findCircuit,
    outlierIndexes: outlierIndexes,
    recognize: recognize,
    itemsToLines: itemsToLines,
    isPdf: isPdf,
    loadTesseract: loadTesseract,
    prepareOffline: prepareOffline
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ChronoImport;
})(typeof window !== 'undefined' ? window : globalThis);
