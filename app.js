
(function () {
  "use strict";

  // Declared first and only here: several top-level `var x = ...expr...`
  // statements below (restoring "Tous les pilotes" from a saved browser
  // preference, for instance) call functions that read STATE immediately
  // as the script loads -- before any function is actually invoked later.
  // If this block sat further down the file (it used to, right before
  // startSync()/persist()/init()), those earlier statements would run
  // first and hit STATE while it's still undefined.
  var db = firebase.firestore();
  var auth = firebase.auth();
  var STATE = { sessions: [], events: [], circuits: {}, riders: [] };
  var canPersist = false;
  var unsubscribers = [];

  // Real accounts (email/password), not anonymous sign-in -- gates the
  // whole app behind a login/signup screen (see renderAuthScreen()).
  var authState = 'loading'; // 'loading' | 'signed-out' | 'signed-in'
  var currentUserProfile = null; // { name, role: 'pilote'|'accompagnant', email } once loaded
  var authMode = 'login'; // 'login' | 'signup' -- which form the auth screen shows
  var authError = '';
  var autoVerifyEmailSent = false; // guards the auto-resend in onAuthStateChanged, see there

  // The one administrator (Xavier) can delete anything; everyone else can
  // still add/edit collaboratively (chronos, sorties, groupes, équipement)
  // but not remove a rider, a sortie, someone else's chrono, or a whole
  // checklist category -- see isAdmin()'s call sites. Matching Firestore
  // rules (riders/events delete, and sessions delete for someone else's
  // chrono) enforce this server-side too; checklist-category/item removal
  // is only hidden client-side (Firestore can't easily tell "this update
  // removed a nested item" from "added one").
  var ADMIN_EMAIL = 'thereiivman@gmail.com';
  function isAdmin() {
    return !!(currentUserProfile && currentUserProfile.email &&
      currentUserProfile.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatTime(seconds) {
    var m = Math.floor(seconds / 60);
    var rem = seconds - m * 60;
    var remStr = rem.toFixed(3);
    if (rem < 10) remStr = '0' + remStr;
    return m + ':' + remStr;
  }

  // Rounded-to-the-second version for places that just need a rough sense
  // of scale (the progression chart's y-axis) rather than the exact time.
  function formatTimeShort(seconds) {
    var m = Math.floor(seconds / 60);
    var rem = Math.round(seconds - m * 60);
    if (rem === 60) { rem = 0; m += 1; }
    var remStr = rem < 10 ? '0' + rem : '' + rem;
    return m + ':' + remStr;
  }

  // Seconds.milliseconds only, no minute -- for labels right next to a
  // point on the progression chart, where the y-axis alongside it already
  // establishes the minute, so repeating it on every point is just noise.
  function formatSecondsOnly(seconds) {
    var m = Math.floor(seconds / 60);
    var rem = seconds - m * 60;
    var remStr = rem.toFixed(3);
    if (rem < 10) remStr = '0' + remStr;
    return remStr;
  }

  function parseTime(raw) {
    var str = String(raw).trim();
    if (!str) return null;
    var m = str.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) {
      var min = parseInt(m[1], 10);
      var sec = parseFloat(m[2]);
      if (sec >= 60) return null;
      return min * 60 + sec;
    }
    m = str.match(/^(\d+(?:\.\d+)?)$/);
    if (m) {
      var v = parseFloat(m[1]);
      if (v <= 0 || v > 1200) return null;
      return v;
    }
    return null;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function sessionBest(session) {
    var best = Infinity;
    for (var i = 0; i < session.laps.length; i++) {
      if (session.laps[i] < best) best = session.laps[i];
    }
    return best;
  }

  function formatDate(iso) {
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  // Same as formatDate() but with a 2-digit year -- used where table width
  // matters on mobile (the Records battus table has 5 columns already).
  function formatDateShortYear(iso) {
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    return parts[2] + '/' + parts[1] + '/' + parts[0].slice(2);
  }

  // The chrono date fields use a plain text JJ/MM/AAAA input instead of a
  // native <input type="date"> -- the native picker's on-screen format
  // follows the browser/OS locale, which can silently show mm/dd/yyyy
  // (American) even on a French page, and there's no reliable HTML-only
  // way to force it. A text field pinned to French order sidesteps that.
  function isoToFrDate(iso) {
    if (!iso) return '';
    var p = String(iso).split('-');
    if (p.length !== 3) return '';
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function frDateToIso(fr) {
    var m = String(fr || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) return null;
    var d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (d < 10 ? '0' + d : d);
  }

  // Auto-inserts the "/" separators as digits are typed, so JJ/MM/AAAA
  // stays easy to type on a plain text field without a native picker.
  function autoFormatFrDateInput(el) {
    if (!el) return;
    el.addEventListener('input', function () {
      var digits = el.value.replace(/[^\d]/g, '').slice(0, 8);
      var out = digits;
      if (digits.length > 4) out = digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4);
      else if (digits.length > 2) out = digits.slice(0, 2) + '/' + digits.slice(2);
      el.value = out;
    });
  }

  function distinctRiders() {
    var seen = {};
    var out = [];
    STATE.sessions.forEach(function (s) {
      if (s.rider && !seen[s.rider]) { seen[s.rider] = true; out.push(s.rider); }
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  // Every circuit the app knows about — from logged chronos AND from
  // planned sorties, so a brand-new circuit with a sortie but no chrono yet
  // (e.g. picked from the Calendrier) is still a valid Circuit/Chronos tab
  // context instead of being silently rejected by normalizeSelection().
  function allCircuits() {
    var seen = {};
    var out = [];
    STATE.sessions.forEach(function (s) {
      if (!seen[s.circuit]) { seen[s.circuit] = true; out.push(s.circuit); }
    });
    eventsList().forEach(function (e) {
      if (!seen[e.circuit]) { seen[e.circuit] = true; out.push(e.circuit); }
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  function mostRecentCircuit(circuitList) {
    var best = null, bestDate = null;
    circuitList.forEach(function (c) {
      var maxDate = null;
      STATE.sessions.forEach(function (s) {
        if (s.circuit === c && (!maxDate || s.date > maxDate)) maxDate = s.date;
      });
      if (!bestDate || (maxDate && maxDate > bestDate)) { bestDate = maxDate; best = c; }
    });
    return best;
  }

  function mostRecentRider(riderList) {
    var best = null, bestDate = null;
    riderList.forEach(function (r) {
      var maxDate = null;
      STATE.sessions.forEach(function (s) {
        if (s.rider === r && (!maxDate || s.date > maxDate)) maxDate = s.date;
      });
      if (!bestDate || (maxDate && maxDate > bestDate)) { bestDate = maxDate; best = r; }
    });
    return best;
  }

  var editingCircuitInfo = false; // local UI state, not persisted
  var annot = { open: false, circuit: null, eventId: null, sessionId: null, tool: 'brush', color: '#e63946', size: 4, fontSize: 22, drawing: false, lastX: 0, lastY: 0 };

  // ---- Calendrier (sorties planifiées + sessions déjà roulées) ----
  //
  // Saving (persist() below) publishes a new document version, and the
  // platform reloads every open view — including this one — to it. That
  // wipes plain JS variables back to their initial values, which used to
  // make something as small as ticking a "pense-bête" checkbox look like it
  // bounced the whole app back to the main tab. UI navigation state (which
  // tab/view/day/circuit/pilote is showing) is therefore kept in
  // localStorage — private to this browser, survives that reload, and never
  // touches the shared document — while actual data (sessions, events,
  // checklists) still goes through STATE/persist() as normal.
  var UI_STATE_KEY = 'carnet-de-piste-ui-state';

  function loadUiState() {
    try {
      var raw = localStorage.getItem(UI_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveUiState() {
    try {
      var knownRiders = allKnownRiders();
      var isAllRiders = !!(selectedRiders && knownRiders.length > 1 && selectedRiders.size === knownRiders.length);
      localStorage.setItem(UI_STATE_KEY, JSON.stringify({
        activeView: activeView,
        calendarViewMode: calendarViewMode,
        calendarAnchor: calendarAnchor,
        selectedEventId: selectedEventId,
        selectedSessionDate: selectedSessionDate,
        selectedCircuit: selectedCircuit,
        selectedRidersAll: isAllRiders,
        selectedRider: (selectedRiders && selectedRiders.size === 1) ? Array.from(selectedRiders)[0] : null,
        planningGroupFilter: planningGroupFilter
      }));
    } catch (e) {
      // Private browsing / storage blocked / quota — fine, just won't survive a reload.
    }
  }

  var _savedUiState = loadUiState();
  // 'sessions' was this app's old (pre-5-tab) Chronos tab id, and 'chronos'
  // was itself a later, now-retired standalone tab — both map forward to
  // 'circuit', which absorbed that content, so a browser with either value
  // already saved doesn't land on a dead tab.
  var _rawSavedView = _savedUiState.activeView;
  // 'calendar' was itself a later, now-retired standalone tab — Calendrier
  // is merged into Événements, so any saved 'calendar' state maps forward
  // to 'event' too.
  var activeView = (_rawSavedView === 'sessions' || _rawSavedView === 'chronos') ? 'circuit' : (_rawSavedView === 'calendar' ? 'event' : (_rawSavedView || 'event')); // 'event' | 'circuit' | 'stats'
  var calendarAnchor = _savedUiState.calendarAnchor || dateKey(new Date()); // 'YYYY-MM-DD'
  var calendarViewMode = _savedUiState.calendarViewMode || '2month'; // one of ZOOM_LEVELS below — base view is 2 months (current + next)
  var selectedEventId = _savedUiState.selectedEventId || null; // which sortie the Événement tab (and Calendrier's detail card) shows
  var editingEventId = null; // null | 'new' | an event id — never restored (don't reopen a form after reload)
  var prefillEventCircuit = null; // one-shot pre-fill for the "Ajouter une sortie" form's circuit field
  // Draft group assignment while the sortie form (add or edit) is open --
  // riders/dates aren't committed to a real event yet (or may still change
  // while editing), so this lives outside STATE until submit. Reset
  // whenever editingEventId changes (see renderEventForm) so switching
  // between "new" and an existing sortie, or closing the form, never
  // leaks a stale draft into the next one.
  var eventFormDraftGroups = {}; // { [rider]: { [date]: { am, pm } } }
  var eventFormDraftGroupsFor = null; // editingEventId the draft above belongs to
  var editingSessionId = null; // id of the chrono row being edited inline in the Circuit history table, or null
  var selectedSessionDate = _savedUiState.selectedSessionDate || null; // 'YYYY-MM-DD' — shows the "chronos of that day" card
  var planningGroupFilter = _savedUiState.planningGroupFilter || null; // array of HORAIRES_GROUPS keys, or null for "all available"
  var planningIsOngoing = false; // set by renderPlanningTab(), read by updateLiveClock()
  var planningEventDateStart = null; // ditto -- 'YYYY-MM-DD' of the target sortie
  var planningEventId = null; // ditto -- id of the target sortie, read by maybeNotifyGroupDeparture()
  var notifiedSlotKey = null; // 'eventId-slotStart' already notified, avoids re-notifying every 15s tick
  // Which circuit and which rider(s) all four tabs currently show —
  // validated/defaulted by normalizeSelection() below, and kept in sync
  // with the currently-selected sortie via selectEvent(). The global picker
  // (above the main tabs) allows either exactly one rider or the complete
  // known-riders roster ("Tous les pilotes"); it now conditions Calendrier
  // too (events/sessions on the grid, and the period's sorties list).
  var selectedCircuit = _savedUiState.selectedCircuit || null;
  var selectedRiders = _savedUiState.selectedRidersAll ? new Set(allKnownRiders()) : (_savedUiState.selectedRider ? new Set([_savedUiState.selectedRider]) : null); // Set — 1 rider, or the full roster when "Tous" is active
  var ZOOM_LEVELS = ['year', '6month', '3month', '2month', 'month', 'week'];
  // The checklist is a shared, editable template (STATE.checklistTemplate,
  // one Firestore doc) -- any rider can add/rename/remove a category or an
  // item; ev.checklist just maps an item's id to checked/not for one
  // sortie. DEFAULT_CHECKLIST_TEMPLATE is only the starting suggestion: it
  // takes effect until someone edits it, at which point that edit
  // "materializes" the template into Firestore (see cloneChecklistTemplate).
  var DEFAULT_CHECKLIST_TEMPLATE = {
    categories: [
      { id: 'pistard', name: 'Équipement du pistard', items: [
        { id: 'casque', label: 'Casque' },
        { id: 'visieres', label: 'Visières' },
        { id: 'combi', label: 'Combi' },
        { id: 'sous-combi', label: 'Sous combi' },
        { id: 'airbag', label: 'Airbag' },
        { id: 'gants', label: 'Gants' },
        { id: 'sous-gants', label: 'Sous gants' },
        { id: 'bottes', label: 'Bottes' },
        { id: 'sliders', label: 'Sliders' }
      ]},
      { id: 'moto', name: 'Équipement de la moto', items: [
        { id: 'pneus-rechange', label: 'Pneus de rechange' },
        { id: 'couv-chauffantes', label: 'Couvertures chauffantes' },
        { id: 'bequilles-av-ar', label: 'Béquilles AV et AR' },
        { id: 'chicane', label: 'Chicane' },
        { id: 'gonfleur', label: 'Gonfleur' },
        { id: 'mamo', label: 'Mamo' }
      ]},
      { id: 'transport', name: 'Équipement transport', items: [
        { id: 'sangles', label: 'Sangles' },
        { id: 'rampe', label: 'Rampe' },
        { id: 'caisses', label: 'Caisses' }
      ]},
      { id: 'papiers', name: 'Papiers administratifs', items: [
        { id: 'acces-circuit', label: 'Accès circuit' },
        { id: 'declaration', label: 'Déclaration' },
        { id: 'assurance', label: 'Assurance' },
        { id: 'carte-grise', label: 'Carte grise moto' },
        { id: 'permis', label: 'Permis de conduire' }
      ]},
      { id: 'consommable', name: 'Équipement consommable', items: [
        { id: 'bidons', label: 'Bidons' },
        { id: 'bec-verseur', label: 'Bec verseur' },
        { id: 'essence', label: 'Essence' },
        { id: 'bouteilles-eau', label: 'Bouteilles eau' },
        { id: 'nettoyage', label: 'Nettoyage' },
        { id: 'serviette', label: 'Serviette' },
        { id: 'sacs-poubelles', label: 'Sacs poubelles' },
        { id: 'eponge', label: 'Éponge' }
      ]},
      { id: 'bricole', name: 'Équipement bricole', items: [
        { id: 'boite-outils', label: 'Boîte à outils' },
        { id: 'dynamo', label: 'Dynamo' }
      ]},
      { id: 'confort', name: 'Équipement confort', items: [
        { id: 'chaises', label: 'Chaises' },
        { id: 'armoire', label: 'Armoire' },
        { id: 'porte-manteau', label: 'Porte-manteau' },
        { id: 'ventilo', label: 'Ventilo' }
      ]},
      { id: 'aide', name: 'Équipement aide', items: [
        { id: '3dms', label: '3DMS' },
        { id: 'camera', label: 'Caméra' },
        { id: 'pc', label: 'PC' }
      ]},
      { id: 'autres', name: 'Autres', items: [
        { id: 'autocollant', label: 'Autocollant' },
        { id: 'plan-circuit', label: 'Plan circuit' },
        { id: 'app-telephone', label: 'Application téléphone' }
      ]}
    ]
  };

  function checklistTemplate() {
    return STATE.checklistTemplate || DEFAULT_CHECKLIST_TEMPLATE;
  }

  function checklistAllItems() {
    var out = [];
    checklistTemplate().categories.forEach(function (cat) {
      cat.items.forEach(function (item) { out.push(item); });
    });
    return out;
  }

  function cloneChecklistTemplate() {
    return JSON.parse(JSON.stringify(checklistTemplate()));
  }

  function addChecklistItem(categoryId, label) {
    label = label.trim();
    if (!label) return;
    var prevState = JSON.parse(JSON.stringify(STATE));
    var tpl = cloneChecklistTemplate();
    var cat = tpl.categories.filter(function (c) { return c.id === categoryId; })[0];
    if (!cat) return;
    cat.items.push({ id: genId(), label: label });
    STATE.checklistTemplate = tpl;
    renderRoot();
    persist(prevState);
  }

  function removeChecklistItem(categoryId, itemId) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var tpl = cloneChecklistTemplate();
    var cat = tpl.categories.filter(function (c) { return c.id === categoryId; })[0];
    if (!cat) return;
    cat.items = cat.items.filter(function (i) { return i.id !== itemId; });
    STATE.checklistTemplate = tpl;
    renderRoot();
    persist(prevState);
  }

  function addChecklistCategory(name) {
    name = name.trim();
    if (!name) return;
    var prevState = JSON.parse(JSON.stringify(STATE));
    var tpl = cloneChecklistTemplate();
    tpl.categories.push({ id: genId(), name: name, items: [] });
    STATE.checklistTemplate = tpl;
    renderRoot();
    persist(prevState);
  }

  function removeChecklistCategory(categoryId) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var tpl = cloneChecklistTemplate();
    tpl.categories = tpl.categories.filter(function (c) { return c.id !== categoryId; });
    STATE.checklistTemplate = tpl;
    renderRoot();
    persist(prevState);
  }

  // Horaires are per-groupe-de-niveau session times, not a single free-text
  // slot -- a trackday runs several groups back-to-back, each with its own
  // pause (a fast and a slow group can break for lunch up to an hour
  // apart), so pause is a token within a group's own line (e.g. "PAUSE
  // DEJ"), never a separate field of its own.
  var HORAIRES_GROUPS = [
    { key: 'groupR', label: 'Groupe R (Rookies)' },
    { key: 'groupA', label: 'Groupe A' },
    { key: 'groupB', label: 'Groupe B' },
    { key: 'groupC', label: 'Groupe C' },
    { key: 'groupD', label: 'Groupe D' }
  ];

  // The level-group letters a rider can be assigned to, reused both for
  // per-day/per-période rider assignment on a sortie and for tagging a
  // chrono entry with which group's session it belongs to.
  var GROUP_LETTERS = ['A', 'B', 'C', 'D'];

  // Every calendar date from start to end (inclusive), 'YYYY-MM-DD' strings
  // -- used to build the per-day group-assignment grid for a multi-day
  // sortie, and capped defensively against a malformed/huge range.
  function datesInRange(startStr, endStr) {
    var out = [];
    if (!startStr) return out;
    var cur = parseLocalDate(startStr);
    var end = parseLocalDate(endStr || startStr);
    var guard = 0;
    while (cur.getTime() <= end.getTime() && guard < 60) {
      out.push(dateKey(cur));
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    return out;
  }

  // A rider's assigned group for one day/période of a sortie, or '' if
  // never set. ev.riderGroups = { [rider]: { [date]: { am: 'A', pm: 'B' } } }
  // -- a rider can switch groups at the lunch break (am vs pm) or from one
  // day to the next (a fresh am/pm pair per date), each independently.
  function riderGroupFor(ev, rider, date, period) {
    var slot = period === 'apres-midi' ? 'pm' : 'am';
    return (ev && ev.riderGroups && ev.riderGroups[rider] && ev.riderGroups[rider][date] && ev.riderGroups[rider][date][slot]) || '';
  }

  function normalizeSelection() {
    var circuits = allCircuits();
    if (!circuits.length) {
      selectedCircuit = null;
    } else if (!selectedCircuit || circuits.indexOf(selectedCircuit) === -1) {
      selectedCircuit = mostRecentCircuit(circuits) || circuits[0];
    }
    // Circuit/Chronos/Statistiques show either a single "pilote actif" or
    // the complete roster ("Tous les pilotes") — picked via the global
    // rider picker above the main tabs. allKnownRiders() so a rider with
    // only a planned sortie and no chrono yet is still selectable.
    var riders = allKnownRiders();
    if (!riders.length) {
      selectedRiders = new Set();
      return;
    }
    if (!selectedRiders) {
      selectedRiders = new Set([mostRecentRider(riders) || riders[0]]);
      return;
    }
    var isAll = selectedRiders.size === riders.length && riders.every(function (r) { return selectedRiders.has(r); });
    var isSingleValid = selectedRiders.size === 1 && riders.indexOf(Array.from(selectedRiders)[0]) !== -1;
    if (isAll) {
      selectedRiders = new Set(riders); // re-sync in case the roster grew/shrank
    } else if (!isSingleValid) {
      selectedRiders = new Set([mostRecentRider(riders) || riders[0]]);
    }
  }

  function getDisplaySessions() {
    if (!selectedCircuit) return [];
    return STATE.sessions
      .filter(function (s) { return s.circuit === selectedCircuit && selectedRiders.has(s.rider); })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  function riderStats(riderName) {
    var sessions = STATE.sessions.filter(function (s) { return s.rider === riderName; });
    var circuitBests = {};
    var lastSession = null;
    sessions.forEach(function (s) {
      var b = sessionBest(s);
      if (!circuitBests[s.circuit] || b < circuitBests[s.circuit].time) {
        circuitBests[s.circuit] = { time: b, date: s.date };
      }
      if (!lastSession || s.date > lastSession.date) lastSession = s;
    });
    var circuitNames = Object.keys(circuitBests).sort(function (a, b) { return a.localeCompare(b); });
    var riderEvents = eventsList().filter(function (e) { return (e.riders || []).indexOf(riderName) !== -1; });
    // "Jours sur piste" is every calendar day of every sortie the rider took
    // part in -- not just days with a chrono actually typed in, since a
    // 2-day outing is still 2 track days even if only one got a time
    // logged. A sortie = 1 event; a set of dates (not a running sum) so two
    // sorties sharing a date, however unlikely, still count that day once.
    var trackDaySet = {};
    riderEvents.forEach(function (ev) {
      datesInRange(ev.dateStart, ev.dateEnd || ev.dateStart).forEach(function (d) { trackDaySet[d] = true; });
    });
    return {
      circuitsVisited: circuitNames.length,
      trackDays: Object.keys(trackDaySet).length,
      outingsCount: riderEvents.length,
      lastSession: lastSession ? { circuit: lastSession.circuit, date: lastSession.date, time: sessionBest(lastSession) } : null,
      bests: circuitNames.map(function (c) {
        return { circuit: c, time: circuitBests[c].time, date: circuitBests[c].date };
      })
    };
  }

  function riderCircuitBest(rider, circuit) {
    var best = null;
    STATE.sessions.forEach(function (s) {
      if (s.rider === rider && s.circuit === circuit) {
        var b = sessionBest(s);
        if (best === null || b < best) best = b;
      }
    });
    return best;
  }

  // Inline replacement for one row of the chronos history table -- every
  // field of a recorded session (pilote, date, session/groupe, chronos,
  // moto, note) becomes editable in place, instead of only offering
  // delete. Spans the full width of the table so it doesn't fight the
  // column layout with its own multi-field form.
  function renderSessionEditRow(s, colCount) {
    var html = '<tr class="session-edit-row" data-session-id="' + s.id + '"><td colspan="' + colCount + '">';
    html += '<form id="session-edit-form" novalidate>';
    html += '<div class="field-row">';
    html += '<div><label for="se-rider">Pilote</label><input type="text" id="se-rider" list="rider-options-se" value="' + escapeHtml(s.rider || '') + '" required>' +
      '<datalist id="rider-options-se">' + riderDatalist() + '</datalist></div>';
    html += '<div><label for="se-date">Date</label><input type="text" id="se-date" inputmode="numeric" placeholder="JJ/MM/AAAA" value="' + isoToFrDate(s.date) + '" required></div>';
    html += '<div><label for="se-bike">Moto</label><input type="text" id="se-bike" list="bike-options-se" value="' + escapeHtml(s.bike || '') + '">' +
      '<datalist id="bike-options-se">' + bikeDatalist() + '</datalist></div>';
    html += '</div>';
    html += '<div class="field-row">';
    html += '<div><label for="se-period">Session</label><select id="se-period">' +
      '<option value=""' + (!s.period ? ' selected' : '') + '>Journée entière</option>' +
      '<option value="matin"' + (s.period === 'matin' ? ' selected' : '') + '>Matin</option>' +
      '<option value="apres-midi"' + (s.period === 'apres-midi' ? ' selected' : '') + '>Après-midi</option>' +
      '</select></div>';
    html += '<div><label for="se-group">Groupe</label><select id="se-group"><option value=""' + (!s.group ? ' selected' : '') + '>—</option>' +
      GROUP_LETTERS.map(function (g) { return '<option value="' + g + '"' + (s.group === g ? ' selected' : '') + '>' + g + '</option>'; }).join('') +
      '</select></div>';
    html += '</div>';
    html += '<label for="se-laps">Chronos</label>' +
      '<textarea id="se-laps" required>' + escapeHtml(s.laps.map(function (l) { return formatTime(l); }).join('\n')) + '</textarea>' +
      '<div class="help-text">Un chrono par ligne (ou séparés par une virgule) — format 1:23.456 ou 83.456.</div>';
    html += '<div style="margin-top:0.6rem;"><label for="se-note">Note (optionnel)</label><input type="text" id="se-note" value="' + escapeHtml(s.note || '') + '"></div>';
    html += '<div class="field-error" id="session-edit-error"></div>';
    html += '<div style="margin-top:0.7rem; display:flex; gap:0.6rem;">' +
      '<button type="submit" class="primary">Enregistrer</button>' +
      '<button type="button" class="ghost" id="cancel-session-edit-btn">Annuler</button>' +
      '</div>';
    html += '</form></td></tr>';
    return html;
  }

  function onSessionEditSubmit(evt) {
    evt.preventDefault();
    var errEl = document.getElementById('session-edit-error');
    errEl.textContent = '';
    errEl.classList.remove('visible');

    var session = STATE.sessions.filter(function (s) { return s.id === editingSessionId; })[0];
    if (!session) { editingSessionId = null; renderRoot(); return; }

    var rider = document.getElementById('se-rider').value.trim();
    var dateRaw = document.getElementById('se-date').value;
    var date = frDateToIso(dateRaw);
    var bike = document.getElementById('se-bike').value.trim();
    var note = document.getElementById('se-note').value.trim();
    var period = document.getElementById('se-period').value;
    var group = document.getElementById('se-group').value;
    var rawLaps = document.getElementById('se-laps').value.split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var laps = [];
    var invalid = false;
    rawLaps.forEach(function (raw) {
      var t = parseTime(raw);
      if (t === null) { invalid = true; } else { laps.push(t); }
    });

    if (dateRaw.trim() && !date) {
      errEl.textContent = 'Date invalide — format attendu JJ/MM/AAAA.';
      errEl.classList.add('visible');
      return;
    }
    if (!rider || !date || !laps.length) {
      errEl.textContent = 'Renseignez un pilote, une date et au moins un chrono valide.';
      errEl.classList.add('visible');
      return;
    }
    if (invalid) {
      errEl.textContent = 'Certains chronos sont illisibles — format attendu 1:23.456 ou 83.456.';
      errEl.classList.add('visible');
      return;
    }

    var prevState = JSON.parse(JSON.stringify(STATE));
    session.rider = rider;
    session.date = date;
    session.laps = laps;
    if (bike) session.bike = bike; else delete session.bike;
    if (note) session.note = note; else delete session.note;
    if (period) session.period = period; else delete session.period;
    if (group) session.group = group; else delete session.group;
    editingSessionId = null;
    renderRoot();
    persist(prevState);
    showToast('Chrono modifié.', 'success');
  }

  function renderSessionsCard() {
    var sessions = getDisplaySessions();
    var showRider = selectedRiders.size !== 1;
    var html = '<div class="card sessions-card">';
    html += '<div class="circuit-head"><div class="circuit-name">' + escapeHtml(selectedCircuit) + '</div>';
    var record = null;
    sessions.forEach(function (s) {
      var b = sessionBest(s);
      if (!record || b < record.time) record = { time: b, rider: s.rider };
    });
    if (record) {
      html += '<div class="circuit-best">Record ' + formatTime(record.time) + ' — ' + escapeHtml(record.rider) + '</div>';
    }
    html += '</div>';
    if (!sessions.length) {
      html += '<div class="empty-state">Aucune session pour ce circuit avec les pilotes sélectionnés.</div>';
    } else {
      var colCount = 4 + (showRider ? 1 : 0);
      html += '<div class="table-scroll"><table class="session-table"><thead><tr><th>Date</th>' + (showRider ? '<th>Pilote</th>' : '') + '<th>Chronos</th><th>Moto</th><th></th></tr></thead><tbody>';
      sessions.forEach(function (s) {
        if (s.id === editingSessionId) {
          html += renderSessionEditRow(s, colCount);
          return;
        }
        var best = sessionBest(s);
        var isRecord = record && best === record.time;
        var personalBest = riderCircuitBest(s.rider, s.circuit);
        var lapsHtml = s.laps.map(function (l) {
          var t = formatTime(l);
          var span = (l === best) ? '<span class="best-lap">' + t + '</span>' : t;
          if (personalBest !== null && l > personalBest) {
            span += '<span class="lap-delta">+' + (l - personalBest).toFixed(3) + '</span>';
          }
          return span;
        }).join(', ');
        var noteHtml = s.note ? '<div class="note-text">' + escapeHtml(s.note) + '</div>' : '';
        var periodLabel = s.period === 'matin' ? 'Matin' : s.period === 'apres-midi' ? 'Après-midi' : '';
        var sessionTagParts = [];
        if (periodLabel) sessionTagParts.push(periodLabel);
        if (s.group) sessionTagParts.push('Groupe ' + s.group);
        var sessionTagHtml = sessionTagParts.length ? '<div class="note-text">' + escapeHtml(sessionTagParts.join(' — ')) + '</div>' : '';
        html += '<tr data-session-id="' + s.id + '">';
        html += '<td>' + formatDate(s.date) + sessionTagHtml + noteHtml + '</td>';
        if (showRider) html += '<td class="rider-cell">' + escapeHtml(s.rider || '—') + '</td>';
        html += '<td class="laps-cell">' + lapsHtml + (isRecord ? '<span class="record-pill">RECORD</span>' : '') + '</td>';
        html += '<td class="bike-cell">' + (s.bike ? escapeHtml(s.bike) : '—') + '</td>';
        html += '<td class="row-actions">' +
          '<button type="button" class="ghost icon-btn" data-action="edit-session-request" data-id="' + s.id + '" aria-label="Modifier ce chrono" title="Modifier">✎</button>' +
          deleteControl(s) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    return html;
  }

  function renderRiderStatsCard(riderName) {
    var stats = riderStats(riderName);
    var html = '<div class="card">';
    html += '<div class="rider-stat-name">' + escapeHtml(riderName) + '</div>';
    html += '<div class="rider-stat-tiles">';
    html += '<div class="mini-tile"><div class="stat-label">Circuits visités</div><div class="stat-value">' + stats.circuitsVisited + '</div></div>';
    html += '<div class="mini-tile"><div class="stat-label">Jours sur piste</div><div class="stat-value">' + stats.trackDays + '</div></div>';
    html += '<div class="mini-tile"><div class="stat-label">Sorties</div><div class="stat-value">' + stats.outingsCount + '</div></div>';
    html += '</div>';
    if (stats.lastSession) {
      html += infoRow('Dernière sortie', escapeHtml(stats.lastSession.circuit) + ' — ' + escapeHtml(formatDate(stats.lastSession.date)) + ' (' + formatTime(stats.lastSession.time) + ')');
    }
    html += '<div class="best-times-title">Meilleurs temps par circuit</div>';
    if (!stats.bests.length) {
      html += '<div class="empty-inline">Aucun chrono enregistré.</div>';
    } else {
      stats.bests.forEach(function (b) {
        html += '<div class="best-time-row"><span class="best-time-circuit">' + escapeHtml(b.circuit) + '</span>' +
          '<span><span class="best-time-value">' + formatTime(b.time) + '</span>' +
          '<span class="best-time-date">' + formatDate(b.date) + '</span></span></div>';
      });
    }
    html += '</div>';
    return html;
  }

  // ---- Sélecteur de pilote global — affiché au-dessus des 4 rubriques principales ----

  function renderGlobalRiderPicker() {
    var riders = allKnownRiders();
    var manageBtn = isAdmin()
      ? '<button type="button" class="ghost icon-btn" id="rider-manager-toggle" aria-label="Gérer les pilotes" title="Gérer les pilotes">⚙</button>'
      : '';
    if (!riders.length && !riderManagerOpen) {
      // Still let a first-time admin create the roster before any chrono exists.
      return '<div class="card filters-card global-rider-picker"><div class="filter-block">' +
        '<label style="display:flex; align-items:center; justify-content:space-between;"><span>Pilote</span>' + manageBtn + '</label>' +
        '<div class="help-text">Aucun pilote pour l\'instant.</div>' +
        '</div></div>';
    }
    var allActive = !!(selectedRiders && selectedRiders.size === riders.length && riders.every(function (r) { return selectedRiders.has(r); }));
    var pills = riders.length ? '<button type="button" class="rider-pill' + (allActive ? ' active' : '') + '" data-global-rider="__all__">Tous les pilotes</button>' : '';
    pills += riders.map(function (r) {
      var active = !allActive && selectedRiders && selectedRiders.size === 1 && selectedRiders.has(r);
      return '<button type="button" class="rider-pill' + (active ? ' active' : '') + '" data-global-rider="' + escapeHtml(r) + '">' + escapeHtml(r) + '</button>';
    }).join('');
    var html = '<div class="card filters-card global-rider-picker"><div class="filter-block">' +
      '<label style="display:flex; align-items:center; justify-content:space-between;"><span>Pilote</span>' + manageBtn + '</label>' +
      '<div class="rider-filter">' + pills + '</div>' +
      '</div>' + (isAdmin() ? renderRiderManagerPanel() : '') + '</div>';
    return html;
  }

  // ---- Gestion des pilotes (ajout / renommage / suppression) ----
  //
  // Riders are otherwise just names attached to sessions/events -- this
  // panel lets the roster (STATE.riders) be edited directly, including a
  // rider with no chrono yet. Admin-only (see isAdmin()): the gear that
  // opens it, and this panel's own content, are both hidden for everyone
  // else -- enforced again server-side in firestore.rules (riders delete).
  function renderRiderManagerPanel() {
    if (!riderManagerOpen) return '';
    var riders = allKnownRiders();
    var rows = riders.map(function (r) {
      if (editingRiderName === r) {
        return '<li class="rider-manager-row rider-manager-row-edit">' +
          '<form data-rename-rider="' + escapeHtml(r) + '" class="rider-manager-rename-form">' +
          '<input type="text" name="new-name" value="' + escapeHtml(r) + '" required autofocus>' +
          '<button type="submit" class="primary">OK</button>' +
          '<button type="button" class="ghost" data-action="cancel-rename-rider">Annuler</button>' +
          '</form></li>';
      }
      var isPendingDelete = pendingDeleteRider === r;
      return '<li class="rider-manager-row">' +
        '<span class="rider-manager-name">' + escapeHtml(r) + '</span>' +
        '<button type="button" class="ghost icon-btn" data-action="rename-rider-request" data-rider="' + escapeHtml(r) + '" aria-label="Renommer ' + escapeHtml(r) + '" title="Renommer">✎</button>' +
        '<button type="button" class="ghost icon-btn' + (isPendingDelete ? ' confirm' : '') + '" data-action="delete-rider-request" data-rider="' + escapeHtml(r) + '" aria-label="Supprimer ' + escapeHtml(r) + '" title="Supprimer">' + (isPendingDelete ? '✓' : '×') + '</button>' +
        '</li>';
    }).join('');
    var html = '<div class="rider-manager">';
    html += riders.length ? '<ul class="rider-manager-list">' + rows + '</ul>' : '';
    html += '<form id="add-rider-form" class="rider-manager-add-form">' +
      '<input type="text" id="new-rider-name" placeholder="Nom du nouveau pilote" required>' +
      '<input type="text" id="new-rider-number" placeholder="N° moto (si homonyme)" style="max-width:9rem;">' +
      '<button type="submit" class="primary">Ajouter</button>' +
      '</form>';
    if (riderManagerError) {
      html += '<div class="field-error visible">' + escapeHtml(riderManagerError) + '</div>';
    }
    html += '</div>';
    return html;
  }

  // ---- Mon profil — chaque pilote/accompagnant gère son propre compte ----
  //
  // Only the fields that live on the user's own users/{uid} doc: role and
  // the notification preference. The rider name is the roster's join key
  // (STATE.riders / ev.riderGroups / session.rider all key off it), so
  // renaming it here would mean rewriting every document that references
  // it -- out of scope for a self-service panel, handled instead via the
  // admin-only rider manager above.
  function renderProfilePanel() {
    if (!profilePanelOpen) return '';
    var p = currentUserProfile;
    var isAccompagnant = p.role === 'accompagnant';
    var followed = p.followedRiders || [];
    var html = '<div class="card profile-panel">';
    html += '<div class="section-title">Mon profil</div>';
    html += '<form id="profile-form">';
    html += '<label>Nom<input type="text" value="' + escapeHtml(p.name) + '" disabled></label>';
    html += '<label>Je suis</label>';
    html += '<div class="auth-role-choice">' +
      '<label><input type="radio" name="profile-role" value="pilote"' + (!isAccompagnant ? ' checked' : '') + '> Pilote</label>' +
      '<label><input type="radio" name="profile-role" value="accompagnant"' + (isAccompagnant ? ' checked' : '') + '> Accompagnant</label>' +
      '</div>';
    html += '<div id="profile-followed-wrap" style="display:' + (isAccompagnant ? 'block' : 'none') + '; margin-top:0.9rem;">';
    html += '<label>Pilotes que je suis</label>';
    var riders = allKnownRiders();
    if (!riders.length) {
      html += '<div class="help-text">Aucun pilote enregistré pour l\'instant.</div>';
    } else {
      html += '<div class="profile-followed-riders">' + riders.map(function (r) {
        return '<label class="checklist-item"><input type="checkbox" name="profile-follow-rider" value="' + escapeHtml(r) + '"' + (followed.indexOf(r) !== -1 ? ' checked' : '') + '> ' + escapeHtml(r) + '</label>';
      }).join('') + '</div>';
    }
    html += '</div>';
    html += '<label class="checklist-item" style="margin-top:0.9rem;"><input type="checkbox" id="profile-notify"' + (p.notifyBeforeSession ? ' checked' : '') + '> <span id="profile-notify-label">' + (isAccompagnant ? 'Me notifier quand un pilote suivi va partir rouler' : 'Me notifier quand mon groupe va partir rouler') + '</span></label>';
    html += '<div class="help-text" style="margin-top:0.4rem;">Nécessite d\'autoriser les notifications du navigateur, et que cet onglet reste ouvert.</div>';
    html += '<div style="margin-top:1rem; display:flex; gap:0.6rem;"><button type="submit" class="primary">Enregistrer</button>' +
      '<button type="button" class="ghost" id="profile-cancel">Fermer</button></div>';
    if (profileSaveMessage) html += '<div class="help-text" style="margin-top:0.6rem;">' + escapeHtml(profileSaveMessage) + '</div>';
    html += '</form></div>';
    return html;
  }

  // ---- Gestion des comptes accompagnant (admin) ----
  //
  // Riders (STATE.riders) already have their own admin panel; this one is
  // for the users/{uid} accounts themselves -- specifically accompagnants,
  // who don't otherwise show up anywhere an admin could keep an eye on
  // them or walk one back to a pilote/remove their access.
  var accountManagerOpen = false;
  var accompagnantAccounts = null; // null = not loaded yet; array once fetched
  var accountManagerError = '';
  var pendingDeleteAccountUid = null;

  function loadAccompagnantAccounts() {
    accountManagerError = '';
    db.collection('users').where('role', '==', 'accompagnant').get().then(function (snap) {
      accompagnantAccounts = snap.docs.map(function (doc) { return Object.assign({ uid: doc.id }, doc.data()); });
      renderRoot();
    }).catch(function (err) {
      accountManagerError = 'Erreur : ' + (err && err.message ? err.message : err);
      renderRoot();
    });
  }

  function renderAccountManagerPanel() {
    if (!accountManagerOpen) return '';
    var html = '<div class="card account-manager-panel">';
    html += '<div class="section-title">Comptes accompagnant</div>';
    if (accompagnantAccounts === null) {
      html += '<div class="help-text">Chargement...</div>';
    } else if (!accompagnantAccounts.length) {
      html += '<div class="help-text">Aucun compte accompagnant pour l\'instant.</div>';
    } else {
      html += '<ul class="rider-manager-list">' + accompagnantAccounts.map(function (a) {
        var isPendingDelete = pendingDeleteAccountUid === a.uid;
        var followed = (a.followedRiders || []).join(', ') || '—';
        return '<li class="rider-manager-row account-manager-row">' +
          '<div><span class="rider-manager-name">' + escapeHtml(a.name || a.email) + '</span>' +
          '<div class="help-text">' + escapeHtml(a.email || '') + ' · suit : ' + escapeHtml(followed) + '</div></div>' +
          '<button type="button" class="ghost icon-btn" data-action="demote-account" data-uid="' + a.uid + '" aria-label="Repasser en pilote" title="Repasser en pilote">↺</button>' +
          '<button type="button" class="ghost icon-btn' + (isPendingDelete ? ' confirm' : '') + '" data-action="delete-account-request" data-uid="' + a.uid + '" aria-label="Supprimer ce compte" title="Retirer l\'accès">' + (isPendingDelete ? '✓' : '×') + '</button>' +
          '</li>';
      }).join('') + '</ul>';
    }
    if (accountManagerError) html += '<div class="field-error visible">' + escapeHtml(accountManagerError) + '</div>';
    html += '</div>';
    return html;
  }

  var profileSaveMessage = '';
  function saveProfile(role, notifyBeforeSession, followedRiders) {
    var uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) return;
    if (notifyBeforeSession && window.Notification && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    db.collection('users').doc(uid).set({ role: role, notifyBeforeSession: notifyBeforeSession, followedRiders: followedRiders }, { merge: true }).then(function () {
      currentUserProfile.role = role;
      currentUserProfile.notifyBeforeSession = notifyBeforeSession;
      currentUserProfile.followedRiders = followedRiders;
      profileSaveMessage = 'Profil enregistré.';
      renderRoot();
    }).catch(function (err) {
      profileSaveMessage = 'Erreur : ' + (err && err.message ? err.message : err);
      renderRoot();
    });
  }

  // Riders are keyed by their display name throughout the app (sessions,
  // riderGroups, checklist...), so two people who happen to share a first
  // name can't otherwise coexist as distinct riders. Rather than a deeper
  // id-based refactor, a rider whose base name collides with an existing
  // one gets a bike number folded into the name itself -- "Julien (#12)" --
  // which stays a single opaque string everywhere else already treats a
  // rider name as one.
  function riderBaseName(name) {
    return (name || '').replace(/\s*\(#[^)]*\)\s*$/, '').trim();
  }

  function addRider(name, number) {
    riderManagerError = '';
    name = riderBaseName(name);
    number = (number || '').trim();
    var known = allKnownRiders();
    var baseCollision = known.some(function (r) { return riderBaseName(r).toLowerCase() === name.toLowerCase(); });
    if (baseCollision && !number) {
      riderManagerError = 'Un pilote "' + name + '" existe déjà — ajoute son numéro de moto pour les différencier.';
      renderRoot();
      return;
    }
    var finalName = number ? (name + ' (#' + number + ')') : name;
    if (known.some(function (r) { return r.toLowerCase() === finalName.toLowerCase(); })) {
      riderManagerError = 'Ce pilote existe déjà.';
      renderRoot();
      return;
    }
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.riders = known.concat([finalName]).sort(function (a, b) { return a.localeCompare(b); });
    renderRoot();
    persist(prevState);
    showToast('Pilote ajouté.', 'success');
  }

  function renameRider(oldName, newName) {
    riderManagerError = '';
    var known = allKnownRiders();
    var conflict = known.some(function (r) { return r !== oldName && r.toLowerCase() === newName.toLowerCase(); });
    if (conflict) {
      riderManagerError = 'Ce pilote existe déjà.';
      editingRiderName = null;
      renderRoot();
      return;
    }
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.riders = known.map(function (r) { return r === oldName ? newName : r; }).sort(function (a, b) { return a.localeCompare(b); });
    STATE.sessions.forEach(function (s) { if (s.rider === oldName) s.rider = newName; });
    eventsList().forEach(function (ev) {
      if (!ev.riders || !ev.riders.length) return;
      ev.riders = ev.riders.map(function (r) { return r === oldName ? newName : r; });
      // A rename can turn two entries into duplicates (rider already there
      // under the new name) -- collapse them.
      var seen = {};
      ev.riders = ev.riders.filter(function (r) { return seen[r] ? false : (seen[r] = true); });
    });
    if (selectedRiders && selectedRiders.has(oldName)) {
      selectedRiders.delete(oldName);
      selectedRiders.add(newName);
    }
    editingRiderName = null;
    renderRoot();
    persist(prevState);
    showToast('Pilote renommé.', 'success');
  }

  function deleteRider(name) {
    riderManagerError = '';
    var hasSessions = STATE.sessions.some(function (s) { return s.rider === name; });
    var hasEvents = eventsList().some(function (ev) { return (ev.riders || []).indexOf(name) !== -1; });
    if (hasSessions || hasEvents) {
      riderManagerError = 'Ce pilote a des chronos ou des sorties enregistrés — supprimez-les ou renommez plutôt le pilote.';
      pendingDeleteRider = null;
      renderRoot();
      return;
    }
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.riders = (STATE.riders || []).filter(function (r) { return r !== name; });
    if (selectedRiders) selectedRiders.delete(name);
    pendingDeleteRider = null;
    renderRoot();
    persist(prevState);
    showToast('Pilote supprimé.', 'success');
  }

  // Every rider+circuit's personal-best progression, walked in chronological
  // order, so we can tell exactly which sessions actually beat a previous
  // record and when -- as opposed to riderCircuitBest()/the session table's
  // RECORD pill, which only flag today's all-time best, not the history of
  // who beat what. A session only counts as "battu" (beaten) when it
  // improves on a real prior best; the very first session on a circuit sets
  // one but doesn't beat anything, so it's excluded.
  function personalRecordsBrokenInYear(year, riderFilter) {
    var groups = {};
    STATE.sessions.forEach(function (s) {
      if (riderFilter && !riderFilter.has(s.rider)) return;
      var key = s.rider + '||' + s.circuit;
      groups[key] = groups[key] || [];
      groups[key].push(s);
    });
    var records = [];
    Object.keys(groups).forEach(function (key) {
      var sessions = groups[key].slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });
      var running = null;
      sessions.forEach(function (s) {
        var b = sessionBest(s);
        if (running !== null && b < running && s.date.slice(0, 4) === year) {
          records.push({ rider: s.rider, circuit: s.circuit, date: s.date, time: b, previous: running });
        }
        if (running === null || b < running) running = b;
      });
    });
    records.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    return records;
  }

  // Gains are usually well under a minute, so a bare "0.514s" reads faster
  // than the m:ss.mmm format used for absolute times -- fall back to
  // formatTime() only for the rare gain that spans a full minute.
  function formatGain(seconds) {
    if (seconds >= 60) return formatTime(seconds);
    return seconds.toFixed(3) + 's';
  }

  function renderRecordsThisYearCard() {
    var year = String(new Date().getFullYear());
    var riderFilter = (selectedRiders && selectedRiders.size) ? selectedRiders : null;
    var records = personalRecordsBrokenInYear(year, riderFilter);
    var html = '<div class="card records-year-card"><h2 class="section-title">Records battus en ' + year + '</h2>';
    if (!records.length) {
      html += '<div class="empty-state">Aucun record personnel battu en ' + year + ' pour l’instant.</div>';
    } else {
      html += '<div class="table-scroll"><table class="session-table"><thead><tr><th>Date</th><th>Pilote</th><th>Circuit</th><th>Nouveau temps</th><th>Gain</th></tr></thead><tbody>';
      records.forEach(function (r) {
        html += '<tr><td>' + escapeHtml(formatDateShortYear(r.date)) + '</td><td class="rider-cell">' + escapeHtml(r.rider) + '</td><td>' + escapeHtml(r.circuit) + '</td>' +
          '<td class="laps-cell">' + formatTime(r.time) + '<span class="record-pill">RECORD</span></td>' +
          '<td class="gain-cell">-' + formatGain(r.previous - r.time) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    return html;
  }

  function renderStatsTab() {
    var riders = allKnownRiders();
    if (!riders.length) {
      return '<div class="card"><div class="empty-state">Aucun pilote pour l\'instant — ajoutez une sortie ou un chrono pour commencer.</div></div>';
    }
    var html = '';
    var rider = (selectedRiders && selectedRiders.size === 1) ? Array.from(selectedRiders)[0] : null;
    if (rider) {
      html += renderRiderStatsCard(rider);
    } else {
      // "Tous les pilotes" (ou un état transitoire) — empile la carte de chaque pilote.
      var names = (selectedRiders && selectedRiders.size ? Array.from(selectedRiders) : riders).slice().sort(function (a, b) { return a.localeCompare(b); });
      names.forEach(function (r) {
        html += renderRiderStatsCard(r);
      });
    }
    html += renderRecordsThisYearCard();
    return html;
  }

  // Every sortie on this circuit whose date range covers dateStr -- lets
  // the chrono form suggest a link even when the rider didn't get here by
  // way of that sortie's own "En cours"/Planning context (selectedEventId).
  function candidateEventsForCircuitDate(circuit, dateStr) {
    if (!dateStr) return [];
    return eventsList().filter(function (e) {
      return e.circuit === circuit && e.dateStart <= dateStr && (e.dateEnd || e.dateStart) >= dateStr;
    }).sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : 1; });
  }

  function renderLinkedEventField(circuit, dateStr) {
    var candidates = candidateEventsForCircuitDate(circuit, dateStr);
    if (!candidates.length) return '';
    var preselect = (selectedEventId && candidates.some(function (e) { return e.id === selectedEventId; })) ? selectedEventId : candidates[0].id;
    var options = candidates.map(function (e) {
      return '<option value="' + e.id + '"' + (e.id === preselect ? ' selected' : '') + '>' + escapeHtml(formatEventRange(e, true)) + '</option>';
    }).join('');
    return '<div style="margin-top:0.9rem;"><label for="f-linked-event">Sortie associée</label>' +
      '<select id="f-linked-event"><option value="">Aucune</option>' + options + '</select></div>';
  }

  function renderForm() {
    if (!selectedCircuit) {
      return '<div class="card"><div class="empty-state">Choisissez un circuit dans l\'onglet Circuit avant d\'enregistrer un chrono.</div></div>';
    }
    var rider = (selectedRiders && selectedRiders.size === 1) ? Array.from(selectedRiders)[0] : null;
    var todayStr = dateKey(new Date());
    var candidates = candidateEventsForCircuitDate(selectedCircuit, todayStr);
    var preselectId = candidates.length
      ? ((selectedEventId && candidates.some(function (e) { return e.id === selectedEventId; })) ? selectedEventId : candidates[0].id)
      : null;
    var linkedEvent = preselectId ? candidates.filter(function (e) { return e.id === preselectId; })[0] : null;
    var html = '<div class="card">';
    html += '<h2 class="section-title">Entrer un nouveau chrono</h2>';
    html += '<form id="session-form" novalidate>';
    html += '<div class="field-row">';
    if (!rider) {
      html += '<div><label for="f-rider">Pilote</label>' +
        '<input type="text" id="f-rider" list="rider-options" placeholder="Ex. Xavier" required>' +
        '<datalist id="rider-options">' + riderDatalist() + '</datalist></div>';
    }
    html += '<div><label for="f-date">Date</label>' +
      '<input type="text" id="f-date" inputmode="numeric" placeholder="JJ/MM/AAAA" value="' + isoToFrDate(todayStr) + '" required></div>';
    html += '<div><label>Circuit</label><div class="static-field">' + escapeHtml(selectedCircuit) + '</div></div>';
    html += '<div><label for="f-bike">Moto</label>' +
      '<input type="text" id="f-bike" list="bike-options" placeholder="Ex. ST 765 RS">' +
      '<datalist id="bike-options">' + bikeDatalist() + '</datalist></div>';
    html += '</div>';
    // Entry granularity is deliberately flexible: one row can be just the
    // day's best time, just one session's best, or every lap of one
    // session -- "Session" + "Chronos" together cover all three, since the
    // Chronos field already accepts one time or a whole list.
    html += '<div class="field-row">';
    html += '<div><label for="f-period">Session</label><select id="f-period">' +
      '<option value="">Journée entière</option>' +
      '<option value="matin">Matin</option>' +
      '<option value="apres-midi">Après-midi</option>' +
      '</select></div>';
    html += '<div><label for="f-group">Groupe</label><select id="f-group"><option value="">—</option>' +
      GROUP_LETTERS.map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('') +
      '</select></div>';
    html += '</div>';
    if (rider && linkedEvent) {
      var hintAm = riderGroupFor(linkedEvent, rider, todayStr, 'matin');
      var hintPm = riderGroupFor(linkedEvent, rider, todayStr, 'apres-midi');
      if (hintAm || hintPm) {
        html += '<div class="help-text">Groupe assigné aujourd\'hui — matin : ' + (hintAm || '—') + ', après-midi : ' + (hintPm || '—') + '.</div>';
      }
    }
    html += '<label for="f-laps">Chronos</label>' +
      '<textarea id="f-laps" placeholder="1:23.456' + String.fromCharCode(10) + '1:22.980' + String.fromCharCode(10) + '1:23.120" required></textarea>' +
      '<div class="help-text">Un chrono par ligne (ou séparés par une virgule) — format 1:23.456 ou 83.456. Entrez juste votre meilleur temps du jour ou de la session, ou tous vos tours.</div>';
    html += '<div style="margin-top:0.9rem;"><label for="f-note">Note (optionnel)</label>' +
      '<input type="text" id="f-note" placeholder="Ex. Pluie, pneus neufs, réglages…"></div>';
    html += '<div id="f-linked-event-wrap">' + renderLinkedEventField(selectedCircuit, todayStr) + '</div>';
    html += '<div class="field-error" id="form-error"></div>';
    html += '<div style="margin-top:0.9rem;">' +
      '<button type="submit" class="primary" id="submit-btn">Enregistrer le chrono</button>' +
      '</div>';
    html += '</form></div>';
    return html;
  }

  function renderChronosTab() {
    var html = '';
    html += renderForm();
    // The history table already supports any number of selected riders
    // (it shows a "Pilote" column when more than one is active), so keep
    // it visible in "Tous les pilotes" mode too.
    if (selectedCircuit && selectedRiders && selectedRiders.size) {
      html += renderSessionsCard();
    }
    // The progression chart comes right after the chronos summary. With
    // several riders active (including "Tous les pilotes") every one of
    // them gets their own line, overlaid on the same chart, instead of
    // arbitrarily picking just one.
    if (selectedRiders && selectedRiders.size && selectedCircuit) {
      html += renderProgressionChart(Array.from(selectedRiders), selectedCircuit);
    }
    return html;
  }

  // Holds the flat list of {date, time, rider, isBest} points across every
  // series (rider) in the most recently rendered progression chart, keyed
  // by a running index, so the click-to-update-caption handler in
  // attachHandlers() can look up what was clicked without re-parsing the
  // DOM.
  var PROGRESSION_POINTS = [];
  var PROGRESSION_MULTI = false; // whether the last render had >1 rider series (caption then names the rider)

  // Fixed hue order for rider series -- a rider keeps the same color
  // whenever they appear on this chart, regardless of who else is shown
  // alongside them (picked by that rider's position in the full
  // known-riders roster, not by selection order, so it never shuffles).
  var PROGRESSION_SERIES_COLORS = ['var(--accent)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

  function riderSeriesColor(riderName) {
    var idx = allKnownRiders().indexOf(riderName);
    if (idx === -1) idx = 0;
    return PROGRESSION_SERIES_COLORS[idx % PROGRESSION_SERIES_COLORS.length];
  }

  // Line chart of one or more riders' recorded chronos on one circuit,
  // over time -- one line per rider, sharing the same time/date scale so
  // they're directly comparable. x is spaced proportionally to real
  // elapsed time between session dates (not just index order); y is NOT
  // inverted — a faster (lower) time naturally plots lower on the chart,
  // same as any plain numeric axis where values grow upward (1'54 below
  // 2'00, not above it).
  function renderProgressionChart(riders, circuit) {
    // Several sessions can land on the same day (matin/après-midi, or just
    // several separate entries) -- the progression is one point per rider
    // per day, so those collapse to that day's single best time rather
    // than plotting redundant/misleading points on top of each other.
    var series = riders.map(function (riderName) {
      var bestByDate = {};
      STATE.sessions.forEach(function (s) {
        if (s.rider !== riderName || s.circuit !== circuit) return;
        var b = sessionBest(s);
        if (!bestByDate[s.date] || b < bestByDate[s.date]) bestByDate[s.date] = b;
      });
      var raw = Object.keys(bestByDate)
        .map(function (date) { return { date: date, time: bestByDate[date] }; })
        .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      return { rider: riderName, raw: raw };
    }).filter(function (s) { return s.raw.length > 0; });

    var isMulti = series.length > 1;
    // A single rider's chart keeps the app's accent color, same as before
    // multi-rider overlays existed -- the fixed categorical palette only
    // kicks in once there's actually more than one line to tell apart.
    series.forEach(function (s) { s.color = isMulti ? riderSeriesColor(s.rider) : 'var(--accent)'; });
    var html = '<div class="card progression-card"><h2 class="section-title">Visualisation de la progression</h2>';

    if (!series.length) {
      html += '<div class="empty-state">Aucun chrono enregistré sur ' + escapeHtml(circuit) + (riders.length === 1 ? ' pour ' + escapeHtml(riders[0]) : '') + '.</div></div>';
      return html;
    }
    if (series.length === 1 && series[0].raw.length === 1) {
      var only = series[0].raw[0];
      html += '<div class="empty-state">Un seul chrono enregistré — ' + formatTime(only.time) + ' le ' + escapeHtml(formatDate(only.date)) + '. La courbe apparaîtra au prochain chrono.</div></div>';
      return html;
    }
    var totalPoints = series.reduce(function (sum, s) { return sum + s.raw.length; }, 0);
    if (totalPoints < 2) {
      html += '<div class="empty-state">Pas encore assez de chronos pour tracer une courbe.</div></div>';
      return html;
    }

    var W = 640, H = 260;
    var marginL = 64, marginR = 16, marginT = 34, marginB = 38;
    var plotW = W - marginL - marginR, plotH = H - marginT - marginB;

    var allTimes = [], allStamps = [];
    series.forEach(function (s) {
      s.raw.forEach(function (p) {
        allTimes.push(p.time);
        allStamps.push(parseLocalDate(p.date).getTime());
      });
    });
    var minTime = Math.min.apply(null, allTimes);
    var maxTime = Math.max.apply(null, allTimes);
    var timeSpan = maxTime - minTime;
    var minStamp = Math.min.apply(null, allStamps);
    var maxStamp = Math.max.apply(null, allStamps);
    var stampSpan = maxStamp - minStamp;

    series.forEach(function (s) {
      var recordTime = Math.min.apply(null, s.raw.map(function (p) { return p.time; }));
      s.pts = s.raw.map(function (p, i) {
        var xFrac = stampSpan > 0 ? (parseLocalDate(p.date).getTime() - minStamp) / stampSpan : (s.raw.length > 1 ? i / (s.raw.length - 1) : 0.5);
        var yFrac = timeSpan > 0 ? (maxTime - p.time) / timeSpan : 0.5;
        return { x: marginL + xFrac * plotW, y: marginT + yFrac * plotH, date: p.date, time: p.time, isBest: p.time === recordTime };
      });
    });

    var gridTimes = timeSpan > 0 ? [minTime, minTime + timeSpan / 2, maxTime] : [minTime];
    var gridSvg = '';
    gridTimes.forEach(function (t) {
      var y = marginT + (timeSpan > 0 ? (maxTime - t) / timeSpan : 0.5) * plotH;
      gridSvg += '<line class="progression-grid" x1="' + marginL + '" y1="' + y.toFixed(1) + '" x2="' + (marginL + plotW) + '" y2="' + y.toFixed(1) + '"></line>';
      // The axis is just for orientation (roughly how fast) -- the exact
      // lap times already show at each point, so milliseconds here would
      // just be clutter. Rounded to the second.
      gridSvg += '<text class="progression-axis-label" x="' + (marginL - 10) + '" y="' + (y + 5).toFixed(1) + '" text-anchor="end">' + formatTimeShort(t) + '</text>';
    });

    // With one rider, every point can carry a value label (dataviz
    // guidance: label all points when few). With several riders overlaid,
    // that many labels would collide, so only each series' own endpoints
    // and its own record get one.
    var MIN_LABEL_GAP = 56; // wider now that the label font is bigger
    var pointsSvg = '';
    var dateLabelsSvg = '';
    var dateLabelReservedX = [];
    var flatPoints = [];

    series.forEach(function (s) {
      var pts = s.pts;
      var lastIdx = pts.length - 1;
      var recordIdx = -1;
      pts.forEach(function (p, i) { if (recordIdx === -1 && p.isBest) recordIdx = i; });

      if (pts.length > 1) {
        var pathD = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
        pointsSvg += '<path class="progression-line" style="stroke:' + s.color + '" d="' + pathD + '"></path>';
      }

      var labelEvery = !isMulti && pts.length <= 7;
      var chosen = {};
      var reservedX = [];
      [0, lastIdx, recordIdx].forEach(function (i) {
        if (i < 0 || chosen[i]) return;
        chosen[i] = true;
        reservedX.push(pts[i].x);
      });
      if (labelEvery) {
        pts.forEach(function (p, i) {
          if (chosen[i]) return;
          var clear = reservedX.every(function (rx) { return Math.abs(p.x - rx) >= MIN_LABEL_GAP; });
          if (clear) { chosen[i] = true; reservedX.push(p.x); }
        });
      }

      pts.forEach(function (p, i) {
        var globalIdx = flatPoints.length;
        flatPoints.push({ date: p.date, time: p.time, rider: s.rider, isBest: p.isBest });
        pointsSvg += '<circle class="progression-point' + (p.isBest ? ' is-best' : '') + '" style="' + (p.isBest ? '' : 'stroke:' + s.color + ';') + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="9" data-idx="' + globalIdx + '" tabindex="0">' +
          '<title>' + (isMulti ? escapeHtml(s.rider) + ' — ' : '') + escapeHtml(formatDate(p.date)) + ' — ' + formatTime(p.time) + (p.isBest ? ' (record)' : '') + '</title>' +
          '</circle>';
        if (chosen[i]) {
          pointsSvg += '<text class="progression-value-label' + (p.isBest ? ' is-best' : '') + '" style="' + (p.isBest ? '' : 'fill:' + s.color + ';') + '" x="' + p.x.toFixed(1) + '" y="' + (p.y - 16).toFixed(1) + '" text-anchor="middle">' + formatSecondsOnly(p.time) + '</text>';
        }
        if (i === 0 || i === lastIdx) {
          var clearDate = dateLabelReservedX.every(function (rx) { return Math.abs(p.x - rx) >= MIN_LABEL_GAP; });
          if (clearDate) {
            dateLabelReservedX.push(p.x);
            dateLabelsSvg += '<text class="progression-axis-label" x="' + p.x.toFixed(1) + '" y="' + (H - marginB + 18).toFixed(1) + '" text-anchor="middle">' + shortDayMonth(parseLocalDate(p.date)) + '</text>';
          }
        }
      });
    });

    var svg = '<svg class="progression-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Progression des chronos">' +
      gridSvg +
      pointsSvg +
      dateLabelsSvg +
      '</svg>';

    html += svg;

    if (isMulti) {
      html += '<div class="progression-legend">' + series.map(function (s) {
        return '<span class="progression-legend-item"><span class="progression-legend-dot" style="background:' + s.color + '"></span>' + escapeHtml(s.rider) + '</span>';
      }).join('') + '</div>';
    }

    var latest = flatPoints.reduce(function (best, p) { return (!best || p.date > best.date) ? p : best; }, null);
    html += '<div class="progression-caption" id="progression-caption">' +
      (isMulti ? escapeHtml(latest.rider) + ' — ' : '') +
      escapeHtml(formatDate(latest.date)) + ' — ' + formatTime(latest.time) + (latest.isBest ? ' (record)' : '') +
      '</div>';
    html += '</div>';

    PROGRESSION_POINTS = flatPoints;
    PROGRESSION_MULTI = isMulti;
    return html;
  }

  function circuitDatalist() {
    var out = '';
    allCircuits().forEach(function (c) { out += '<option value="' + escapeHtml(c) + '">'; });
    return out;
  }

  function bikeDatalist() {
    var seen = {};
    var out = '';
    STATE.sessions.forEach(function (s) {
      if (s.bike && !seen[s.bike]) { seen[s.bike] = true; out += '<option value="' + escapeHtml(s.bike) + '">'; }
    });
    return out;
  }

  function riderDatalist() {
    var out = '';
    allKnownRiders().forEach(function (r) {
      out += '<option value="' + escapeHtml(r) + '">';
    });
    return out;
  }

  // A chrono can be deleted by the admin or by whoever it belongs to
  // (matching firestore.rules' sessions delete rule) -- not by anyone
  // else, so one rider can't wipe another's times.
  function deleteControl(session) {
    if (!isAdmin() && (!currentUserProfile || session.rider !== currentUserProfile.name)) return '';
    return '<button type="button" class="ghost icon-btn" data-action="delete-request" data-id="' + session.id + '" aria-label="Supprimer cette session" title="Supprimer">×</button>';
  }

  // ---- Circuit info (km, virages, prochaine sortie) + visuel annotable ----

  function circuitInfo(name) {
    STATE.circuits = STATE.circuits || {};
    return STATE.circuits[name] || {};
  }

  // The circuit card's "Prochaine sortie" is derived straight from the
  // Calendrier — the earliest sortie on this circuit that hasn't finished
  // yet — rather than a separately-typed date that can drift out of sync.
  function nextOutingForCircuit(circuit) {
    var todayKey = dateKey(new Date());
    var norm = (circuit || '').trim().toLowerCase();
    var matches = eventsList().filter(function (e) {
      return e.circuit.trim().toLowerCase() === norm && (e.dateEnd || e.dateStart) >= todayKey;
    }).sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0; });
    return matches[0] || null;
  }

  // By default only returns sessions for the riders currently selected in
  // the main filter, so the circuit info card, the sessions table and the
  // annotation screen all agree on "whose data am I looking at". Pass
  // includeAllRiders=true to bypass that (used nowhere yet, kept for
  // flexibility).
  function circuitSessionsDesc(circuit, includeAllRiders) {
    return STATE.sessions
      .filter(function (s) {
        if (s.circuit !== circuit) return false;
        if (includeAllRiders) return true;
        return selectedRiders && selectedRiders.has(s.rider);
      })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }

  function infoRow(label, valueHtml) {
    return '<div class="info-row"><span class="info-label">' + escapeHtml(label) + '</span><span class="info-value">' + valueHtml + '</span></div>';
  }

  // The Circuit tab is rider-agnostic (it's context, not a comparison
  // view), so its "Dernière sortie"/"Record circuit" figures cover every
  // rider, not just whichever one happens to be active elsewhere.
  function renderCircuitTab() {
    var circuits = allCircuits();
    if (!circuits.length) {
      return '<div class="card"><div class="empty-state">Aucun circuit pour l\'instant — ajoutez une sortie dans le Calendrier ou un chrono pour commencer.</div></div>';
    }
    var html = '<div class="card"><label for="f-filter-circuit">Circuit</label><select id="f-filter-circuit">';
    circuits.forEach(function (c) {
      html += '<option value="' + escapeHtml(c) + '"' + (c === selectedCircuit ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    });
    html += '</select></div>';
    html += renderCircuitInfoCard();
    // Chronos used to be its own tab; it's really always been about
    // "the currently active circuit", so it lives here now, right after
    // the circuit's own info.
    html += '<h2 class="section-title" style="margin-top:0.5rem;">Chronos</h2>';
    html += renderChronosTab();
    return html;
  }

  function renderCircuitInfoCard() {
    var info = circuitInfo(selectedCircuit);
    var sessions = circuitSessionsDesc(selectedCircuit, true);
    var lastSession = null;
    sessions.forEach(function (s) { if (!lastSession || s.date > lastSession.date) lastSession = s; });
    var recordSession = null, recordTime = Infinity;
    sessions.forEach(function (s) {
      var b = sessionBest(s);
      if (b < recordTime) { recordTime = b; recordSession = s; }
    });

    var turnsHtml = '—';
    if (info.turnsRight != null || info.turnsLeft != null) {
      turnsHtml = (info.turnsRight != null ? info.turnsRight + ' D' : '—') + ' / ' + (info.turnsLeft != null ? info.turnsLeft + ' G' : '—');
    }

    var html = '<div class="card circuit-info-card"><div class="circuit-info-grid"><div class="circuit-info-list">';
    html += '<div class="circuit-name" style="margin-bottom:0.5rem;">' + escapeHtml(selectedCircuit) + '</div>';
    html += infoRow('Distance', info.km != null ? (escapeHtml(String(info.km)) + ' km') : '—');
    html += infoRow('Virages (D / G)', turnsHtml);
    html += infoRow('Organisateur habituel', info.organizer ? escapeHtml(info.organizer) : '—');
    if (info.briefing) html += infoRow('Briefing', escapeHtml(info.briefing));
    var lastEvent = (lastSession && lastSession.eventId) ? eventsList().filter(function (e) { return e.id === lastSession.eventId; })[0] : null;
    var lastOutingText = lastSession ? (escapeHtml(formatDate(lastSession.date)) + ' — ' + formatTime(sessionBest(lastSession))) : '—';
    html += infoRow('Dernière sortie', lastEvent
      ? '<button type="button" class="link-btn" id="last-outing-link" data-event-id="' + lastEvent.id + '">' + lastOutingText + '</button>'
      : lastOutingText);
    html += infoRow('Record circuit', recordSession ? (formatTime(recordTime) + ' (' + escapeHtml(recordSession.rider) + ')') : '—');
    var upcoming = nextOutingForCircuit(selectedCircuit);
    html += infoRow('Prochaine sortie', upcoming
      ? '<button type="button" class="link-btn" id="next-outing-link" data-event-id="' + upcoming.id + '">' + escapeHtml(formatEventRange(upcoming, true)) + '</button>'
      : '<button type="button" class="link-btn" id="plan-outing-link">Non planifiée — planifier</button>');
    if (editingCircuitInfo) {
      html += renderCircuitInfoEditForm(info);
    } else {
      html += '<button type="button" class="ghost" id="edit-circuit-info-btn" style="margin-top:0.6rem;">Modifier les infos</button>';
    }
    html += '</div>';
    html += renderCircuitVisual(info);
    html += '</div></div>';
    return html;
  }

  function renderCircuitInfoEditForm(info) {
    var html = '<div class="info-edit-form">';
    html += '<div><label for="ci-km">Distance (km)</label><input type="text" inputmode="decimal" id="ci-km" value="' + (info.km != null ? escapeHtml(String(info.km)) : '') + '" placeholder="Ex. 4.2"></div>';
    html += '<div><label for="ci-right">Virages à droite</label><input type="text" inputmode="numeric" id="ci-right" value="' + (info.turnsRight != null ? escapeHtml(String(info.turnsRight)) : '') + '" placeholder="Ex. 9"></div>';
    html += '<div><label for="ci-left">Virages à gauche</label><input type="text" inputmode="numeric" id="ci-left" value="' + (info.turnsLeft != null ? escapeHtml(String(info.turnsLeft)) : '') + '" placeholder="Ex. 5"></div>';
    html += '<div><label for="ci-organizer">Organisateur habituel</label><input type="text" id="ci-organizer" value="' + escapeHtml(info.organizer || '') + '" placeholder="Ex. MT95"</div>';
    html += '<div><label for="ci-briefing">Briefing</label><input type="text" id="ci-briefing" value="' + escapeHtml(info.briefing || '') + '" placeholder="Ex. 8h15"></div>';
    html += '</div>';
    // These usual times pre-remplissent automatiquement une nouvelle sortie
    // créée sur ce circuit (voir renderEventForm) -- utile puisque
    // l'organisateur fixe en général les mêmes créneaux à chaque sortie.
    var horairesVal = (info.horaires && typeof info.horaires === 'object') ? info.horaires : {};
    html += '<div style="margin-top:0.6rem;"><label>Horaires habituels par groupe</label><div class="horaires-grid">';
    HORAIRES_GROUPS.forEach(function (g) {
      // Rookies (groupe R) is Mugello-only for now -- hide the field
      // elsewhere so it doesn't look like every circuit has one.
      if (g.key === 'groupR' && selectedCircuit !== 'Mugello' && !horairesVal.groupR) return;
      html += '<div><label for="ci-horaires-' + g.key + '" class="horaires-sublabel">' + escapeHtml(g.label) + '</label>' +
        '<input type="text" id="ci-horaires-' + g.key + '" placeholder="Ex. 9h, 10h40, 14h, 15h20, 16h40" value="' + escapeHtml(horairesVal[g.key] || '') + '"></div>';
    });
    html += '</div></div>';
    html += '<div class="info-edit-actions"><button type="button" class="primary" id="save-circuit-info-btn">Enregistrer</button><button type="button" class="ghost" id="cancel-circuit-info-btn">Annuler</button></div>';
    return html;
  }

  // eventId (optional): when the visual is shown from a sortie's own card
  // (Événements) rather than the Circuit tab, annotating it opens that
  // sortie's own blank layer (see openAnnotation) instead of the circuit's
  // shared plan -- so the button carries the event id rather than the id
  // attachHandlers() otherwise wires to the globally-selected circuit.
  function renderCircuitVisual(info, circuitName, eventId) {
    circuitName = circuitName || selectedCircuit;
    if (info.mapImage) {
      return (
        '<div class="circuit-visual-frame">' +
          '<button type="button" class="circuit-visual-btn" id="open-annot-btn" data-circuit="' + escapeHtml(circuitName) + '"' + (eventId ? ' data-event-id="' + eventId + '"' : '') + ' aria-label="Annoter le tracé du circuit">' +
            '<img src="' + info.mapImage + '" alt="Tracé de ' + escapeHtml(circuitName) + '">' +
          '</button>' +
          '<div class="circuit-visual-caption">Toucher pour annoter</div>' +
        '</div>'
      );
    }
    return (
      '<div class="circuit-visual-frame">' +
        '<div class="circuit-visual-btn circuit-visual-placeholder">Aucun plan importé pour ce circuit</div>' +
      '</div>'
    );
  }

  function saveCircuitInfo() {
    var kmRaw = document.getElementById('ci-km').value.trim().replace(',', '.');
    var rightRaw = document.getElementById('ci-right').value.trim();
    var leftRaw = document.getElementById('ci-left').value.trim();
    var km = kmRaw ? parseFloat(kmRaw) : null;
    var right = rightRaw ? parseInt(rightRaw, 10) : null;
    var left = leftRaw ? parseInt(leftRaw, 10) : null;
    var organizer = document.getElementById('ci-organizer').value.trim();
    var briefing = document.getElementById('ci-briefing').value.trim();
    var horaires = {};
    var anyHoraire = false;
    HORAIRES_GROUPS.forEach(function (g) {
      var el = document.getElementById('ci-horaires-' + g.key);
      var v = el ? el.value.trim() : '';
      if (v) { horaires[g.key] = v; anyHoraire = true; }
    });
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.circuits = STATE.circuits || {};
    var entry = STATE.circuits[selectedCircuit] || {};
    entry.km = (km != null && !isNaN(km)) ? km : null;
    entry.turnsRight = (right != null && !isNaN(right)) ? right : null;
    entry.turnsLeft = (left != null && !isNaN(left)) ? left : null;
    entry.organizer = organizer || null;
    entry.briefing = briefing || null;
    entry.horaires = anyHoraire ? horaires : null;
    STATE.circuits[selectedCircuit] = entry;
    editingCircuitInfo = false;
    renderRoot();
    persist(prevState);
  }

  // ---- Écran d'annotation (calque façon Paint sur le tracé du circuit) ----

  var annotCanvasEl = null;
  var annotInnerEl = null;
  var annotView = { scale: 1, x: 0, y: 0 };
  var annotPointers = new Map(); // pointerId -> {x, y} in client coords
  var annotPinch = null; // {startDist, startMidLocal, startScale, startX, startY}
  // Retained-mode model so strokes/text can be undone and moved after the
  // fact. Coordinates/sizes are stored as FRACTIONS of the canvas buffer's
  // current width/height (not raw pixels) so they survive a real canvas
  // resize (e.g. the force-landscape rotation swapping width/height)
  // without any manual rescale math — a redraw just multiplies by whatever
  // canvas.width/height currently are.
  var annotObjects = []; // {type:'stroke', tool, color, sizeFrac, points:[{nx,ny}]} | {type:'text', text, color, nx, ny, fontSizeFrac}
  var annotUndoStack = []; // [{baseVisible, objects}], most recent last
  var annotBaseImageObj = null; // previously-saved PNG (Image), immutable background layer
  var annotBaseImageVisible = false;
  var annotCurrentStroke = null; // in-progress stroke object while drawing
  var annotDrag = null; // {obj, startNx, startNy, origPoints|origXY}
  // The canvas drawing buffer is rendered at this many buffer-pixels per CSS
  // pixel so strokes and text stay crisp on retina phones, and stay crisp
  // when the rider pinch-zooms in to add fine detail. Capped at 3 so the
  // saved PNG doesn't balloon on very high-DPI devices.
  var ANNOT_DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));

  // Sentinel session id meaning "the circuit's own plan, not tied to any
  // particular chrono" -- lets a rider annotate a track (braking markers,
  // lines) before ever logging a session there. Its drawing is stored on
  // STATE.circuits[circuit].drawing instead of a STATE.sessions[] entry.
  var ANNOT_CIRCUIT_LEVEL = '__circuit__';

  // A third level, one per sortie: opening the map from an event's own
  // card (Événements -> "En cours") always starts from a blank layer for
  // that sortie specifically, rather than the circuit-level plan that
  // otherwise accumulates every trait ever drawn on that track across
  // every past outing. Its drawing is stored on the event doc itself
  // (STATE.events[].drawing), keyed 'event:<eventId>' in annot.sessionId.
  var ANNOT_EVENT_PREFIX = 'event:';
  function eventLevelSessionId(eventId) { return ANNOT_EVENT_PREFIX + eventId; }
  function isEventLevelId(sessionId) { return typeof sessionId === 'string' && sessionId.indexOf(ANNOT_EVENT_PREFIX) === 0; }
  function eventIdFromLevelId(sessionId) { return sessionId.slice(ANNOT_EVENT_PREFIX.length); }

  function openAnnotation(circuit, eventId) {
    var sessions = circuitSessionsDesc(circuit);
    annot.open = true;
    annot.circuit = circuit;
    annot.eventId = eventId || null;
    annot.sessionId = eventId ? eventLevelSessionId(eventId) : (sessions.length ? sessions[0].id : ANNOT_CIRCUIT_LEVEL);
    annot.tool = 'brush';
    renderAnnotationOverlay();
  }

  function closeAnnotation() {
    annot.open = false;
    annot.eventId = null;
    var overlay = document.getElementById('annot-overlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.classList.remove('force-landscape');
      overlay.innerHTML = '';
    }
    document.body.classList.remove('annot-forced-landscape');
    annotCanvasEl = null;
    annotInnerEl = null;
    annotPointers.clear();
    annotPinch = null;
    annotObjects = [];
    annotUndoStack = [];
    annotBaseImageObj = null;
    annotBaseImageVisible = false;
    annotCurrentStroke = null;
    annotDrag = null;
    window.removeEventListener('resize', onAnnotResize);
    window.removeEventListener('orientationchange', onAnnotOrientationChange);
    window.removeEventListener('keydown', onAnnotKeydown);
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document).catch(function () {});
    }
  }

  // iOS Safari (including "Add to Home Screen" apps) does not implement the
  // Fullscreen API or Screen Orientation lock at all, so relying on those
  // silently does nothing on an iPhone. Instead we rotate the whole overlay
  // 90° with CSS so it visually fills the screen in landscape regardless of
  // how the phone is physically held — this works on every browser.
  function toggleAnnotFullscreen() {
    var overlay = document.getElementById('annot-overlay');
    if (!overlay) return;

    // Deliberately NOT using the real Fullscreen API here: iOS Safari
    // (including "Add to Home Screen" apps) doesn't support it at all, and
    // on browsers that DO support it, becoming the fullscreen element hands
    // the box to the browser's own top-layer fullscreen rendering, which
    // overrides our custom rotate/size transform outright. The CSS rotation
    // trick below is the one mechanism that works consistently everywhere.
    var isPortrait = window.matchMedia && window.matchMedia('(orientation: portrait)').matches;
    if (!isPortrait) {
      showToast('Déjà en mode paysage.');
      return;
    }
    var forced = overlay.classList.toggle('force-landscape');
    document.body.classList.toggle('annot-forced-landscape', forced);
    // Layout box swapped dimensions — resize the drawing surface to match
    // once the browser has applied the new transform.
    requestAnimationFrame(function () {
      requestAnimationFrame(resizeAnnotCanvasPreserving);
    });
  }

  // Plain window resize (also fires when a real Fullscreen API request
  // succeeds, e.g. on desktop/Android — that is NOT a device rotation) just
  // needs the canvas resized to match the new box.
  function onAnnotResize() {
    if (!annot.open) return;
    resizeAnnotCanvasPreserving();
  }

  // orientationchange only fires on an actual device rotation, so it is the
  // right (and only) signal to auto-drop the force-landscape CSS hack —
  // using 'resize' for this too would misfire when requestFullscreen()
  // succeeds and briefly reports a landscape-shaped viewport on its own.
  function onAnnotOrientationChange() {
    var overlay = document.getElementById('annot-overlay');
    if (!overlay || !annot.open) return;
    var isPortrait = window.matchMedia && window.matchMedia('(orientation: portrait)').matches;
    if (!isPortrait && overlay.classList.contains('force-landscape')) {
      overlay.classList.remove('force-landscape');
      document.body.classList.remove('annot-forced-landscape');
    }
    resizeAnnotCanvasPreserving();
  }

  function renderAnnotationOverlay() {
    var overlay = document.getElementById('annot-overlay');
    if (!overlay) return;
    if (!annot.open) {
      overlay.classList.remove('open');
      overlay.innerHTML = '';
      return;
    }
    var info = circuitInfo(annot.circuit);
    var sessions = circuitSessionsDesc(annot.circuit);
    var showRiderInOption = selectedRiders && selectedRiders.size !== 1;
    // A circuit-level entry always leads the list, so the plan can be
    // annotated (braking markers, lines) before any chrono is logged there
    // -- alongside one entry per session, each with its own drawing.
    var options = '';
    if (annot.eventId) {
      var evForAnnot = eventsList().filter(function (e) { return e.id === annot.eventId; })[0];
      var evDrawing = evForAnnot && evForAnnot.drawing;
      var evLevelId = eventLevelSessionId(annot.eventId);
      options += '<option value="' + evLevelId + '"' + (annot.sessionId === evLevelId ? ' selected' : '') + '>' +
        'Cette sortie (nouveau plan)' + (evDrawing ? ' ✎' : '') + '</option>';
    }
    options += '<option value="' + ANNOT_CIRCUIT_LEVEL + '"' + (annot.sessionId === ANNOT_CIRCUIT_LEVEL ? ' selected' : '') + '>' +
      'Plan général' + (info.drawing ? ' ✎' : '') + '</option>';
    options += sessions.map(function (s) {
      var label = formatDate(s.date) + ' — ' + formatTime(sessionBest(s)) + (showRiderInOption ? ' — ' + s.rider : '') + (s.drawing ? ' ✎' : '');
      return '<option value="' + s.id + '"' + (s.id === annot.sessionId ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');

    var html = '';
    var svgFullscreen = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/></svg>';

    html += '<div class="annot-header">';
    html += '<button type="button" class="ghost icon-btn" id="annot-close" aria-label="Fermer">←</button>';
    html += '<div class="annot-title">' + escapeHtml(annot.circuit) + '</div>';
    html += '<select id="annot-session-select" aria-label="Sortie à annoter">' + options + '</select>';
    html += '<button type="button" class="ghost icon-btn annot-fullscreen-btn" id="annot-fullscreen" aria-label="Plein écran paysage" title="Forcer l\'affichage paysage">' + svgFullscreen + '</button>';
    html += '</div>';
    html += '<div class="annot-orientation-hint">Astuce : passez le téléphone en mode paysage (ou utilisez le bouton paysage) pour annoter plus confortablement.</div>';
    html += '<div class="annot-body">';
    html += '<div class="annot-toolbar">';
    var svgBrush = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L11 16 6 18l2-5z"/><path d="M15 6l3 3"/></svg>';
    var svgEraser = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="18" height="7" rx="1.5" transform="rotate(-20 12 12)"/><path d="M4 20h16"/></svg>';
    var svgMove = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M6 6l-3 6 3 6M18 6l3 6-3 6M6 6l6-3 6 3M6 18l6 3 6-3"/></svg>';
    var svgClear = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
    var svgUndo = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a8.5 8.5 0 1 0 2.3-7"/></svg>';
    var svgExport = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M4 17v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';
    html += '<button type="button" class="annot-tool-btn" data-tool="brush" aria-label="Pinceau" title="Pinceau">' + svgBrush + '</button>';
    html += '<button type="button" class="annot-tool-btn" data-tool="eraser" aria-label="Gomme" title="Gomme">' + svgEraser + '</button>';
    html += '<button type="button" class="annot-tool-btn" data-tool="text" aria-label="Texte" title="Texte">T</button>';
    html += '<button type="button" class="annot-tool-btn" data-tool="move" aria-label="Déplacer" title="Déplacer un trait ou un texte">' + svgMove + '</button>';
    html += '<input type="color" id="annot-color" class="annot-color-input" value="' + annot.color + '" aria-label="Couleur" title="Couleur">';
    var SIZE_PRESETS = [2, 4, 8];
    var SIZE_LABELS = { 2: 'Fin', 4: 'Moyen', 8: 'Épais' };
    html += '<div class="annot-size-group" role="group" aria-label="Épaisseur du trait">';
    SIZE_PRESETS.forEach(function (s) {
      var dotPx = 3 + s;
      html += '<button type="button" class="annot-size-btn' + (annot.size === s ? ' active' : '') + '" data-size="' + s + '" aria-label="' + SIZE_LABELS[s] + '" title="' + SIZE_LABELS[s] + '">' +
        '<span class="annot-size-dot" style="width:' + dotPx + 'px;height:' + dotPx + 'px;"></span></button>';
    });
    html += '</div>';
    html += '<div class="annot-zoom-group" role="group" aria-label="Zoom">';
    html += '<span class="annot-zoom-label">Zoom</span>';
    html += '<button type="button" class="annot-zoom-btn" id="annot-zoom-out" aria-label="Zoom arrière" title="Zoom arrière">−</button>';
    html += '<button type="button" class="ghost annot-zoom-value" id="annot-zoom-value" aria-label="Réinitialiser le zoom" title="Revenir à 100%">' + Math.round(annotView.scale * 100) + '%</button>';
    html += '<button type="button" class="annot-zoom-btn" id="annot-zoom-in" aria-label="Zoom avant" title="Zoom avant">+</button>';
    html += '</div>';
    html += '<button type="button" class="ghost icon-btn" id="annot-undo" aria-label="Annuler" title="Annuler la dernière action (Ctrl+Z)">' + svgUndo + '</button>';
    html += '<button type="button" class="ghost icon-btn" id="annot-export" aria-label="Exporter en image" title="Afficher le tracé annoté en grand pour l\'enregistrer">' + svgExport + '</button>';
    html += '<button type="button" class="ghost icon-btn" id="annot-clear" aria-label="Tout effacer" title="Tout effacer">' + svgClear + '</button>';
    html += '<button type="button" class="primary annot-save-btn" id="annot-save">Enregistrer</button>';
    html += '</div>';
    html += '<div class="annot-canvas-wrap' + (info.mapImage ? ' has-basemap' : '') + '" id="annot-canvas-wrap">';
    html += '<div class="annot-canvas-inner" id="annot-canvas-inner">';
    if (info.mapImage) html += '<img class="annot-basemap" src="' + info.mapImage + '" alt="">';
    html += '<canvas class="annot-canvas" id="annot-canvas"></canvas>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    overlay.innerHTML = html;
    overlay.classList.add('open');
    setupAnnotCanvas();
    attachAnnotHandlers();
    window.addEventListener('resize', onAnnotResize);
    window.addEventListener('orientationchange', onAnnotOrientationChange);
    window.addEventListener('keydown', onAnnotKeydown);
  }

  function onAnnotKeydown(e) {
    var isZ = e.key === 'z' || e.key === 'Z';
    if ((e.ctrlKey || e.metaKey) && isZ) {
      e.preventDefault();
      annotUndo();
    }
  }

  function setupAnnotCanvas() {
    var wrap = document.getElementById('annot-canvas-wrap');
    var canvas = document.getElementById('annot-canvas');
    var inner = document.getElementById('annot-canvas-inner');
    if (!wrap || !canvas || !inner) return;
    var size0 = annotWrapLocalSize();
    var w = Math.max(1, Math.round(size0.w * ANNOT_DPR));
    var h = Math.max(1, Math.round(size0.h * ANNOT_DPR));
    canvas.width = w;
    canvas.height = h;
    annotCanvasEl = canvas;
    annotInnerEl = inner;
    annotView = { scale: 1, x: 0, y: 0 };
    applyAnnotView();
    var ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    annotObjects = [];
    annotUndoStack = [];
    annotCurrentStroke = null;
    annotDrag = null;
    annotBaseImageObj = null;
    annotBaseImageVisible = false;
    var existingDrawing = annot.sessionId === ANNOT_CIRCUIT_LEVEL
      ? circuitInfo(annot.circuit).drawing
      : isEventLevelId(annot.sessionId)
        ? (eventsList().filter(function (e) { return e.id === eventIdFromLevelId(annot.sessionId); })[0] || {}).drawing
        : (STATE.sessions.filter(function (s) { return s.id === annot.sessionId; })[0] || {}).drawing;
    if (existingDrawing) {
      var img = new Image();
      img.onload = function () {
        annotBaseImageObj = img;
        annotBaseImageVisible = true;
        redrawAnnotCanvas();
      };
      img.src = existingDrawing;
    }
  }

  // Resizes the canvas buffer to the wrap's current size (e.g. after the
  // force-landscape rotation swaps width/height) and redraws from the
  // retained object model — since objects are stored as fractions of the
  // buffer's own width/height, they land in the right place automatically.
  function resizeAnnotCanvasPreserving() {
    var wrap = document.getElementById('annot-canvas-wrap');
    var canvas = annotCanvasEl;
    if (!wrap || !canvas) return;
    var size1 = annotWrapLocalSize();
    var newW = Math.max(1, Math.round(size1.w * ANNOT_DPR));
    var newH = Math.max(1, Math.round(size1.h * ANNOT_DPR));
    if (newW === canvas.width && newH === canvas.height) return;
    canvas.width = newW;
    canvas.height = newH;
    var ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    redrawAnnotCanvas();
  }

  // Clones the object list deeply (JSON-safe: plain numbers/strings only) so
  // undo snapshots aren't aliased to the live, still-mutable array/objects.
  function cloneAnnotObjects(arr) {
    return JSON.parse(JSON.stringify(arr));
  }

  // Call before any action that mutates the drawing (finishing a stroke,
  // baking text, clearing, moving an object) so Ctrl+Z / the undo button can
  // step back to exactly this point.
  function pushAnnotUndo() {
    annotUndoStack.push({ baseVisible: annotBaseImageVisible, objects: cloneAnnotObjects(annotObjects) });
    if (annotUndoStack.length > 30) annotUndoStack.shift();
  }

  function annotUndo() {
    if (!annotUndoStack.length) {
      showToast('Rien à annuler.');
      return;
    }
    var prev = annotUndoStack.pop();
    annotBaseImageVisible = prev.baseVisible;
    annotObjects = prev.objects;
    annotDrag = null;
    redrawAnnotCanvas();
  }

  // Full from-scratch redraw of the annotation layer: the (immutable) saved
  // base image first, then every retained object in creation order (order
  // matters for the eraser tool, which needs to punch through whatever was
  // drawn before it).
  function redrawAnnotCanvas() {
    var canvas = annotCanvasEl;
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (annotBaseImageVisible && annotBaseImageObj) {
      ctx.drawImage(annotBaseImageObj, 0, 0, canvas.width, canvas.height);
    }
    annotObjects.forEach(function (obj) { drawAnnotObject(obj, ctx, canvas); });
  }

  function drawAnnotObject(obj, ctx, canvas) {
    if (obj.type === 'stroke') {
      if (obj.points.length < 1) return;
      ctx.save();
      var lineWidth = obj.sizeFrac * canvas.width * (obj.tool === 'eraser' ? 3 : 1);
      if (obj.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = obj.color;
      }
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      obj.points.forEach(function (p, i) {
        var x = p.nx * canvas.width, y = p.ny * canvas.height;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (obj.points.length === 1) {
        // A single tap with no movement: draw a dot, not an invisible path.
        var p0 = obj.points[0];
        ctx.lineTo(p0.nx * canvas.width + 0.01, p0.ny * canvas.height + 0.01);
      }
      ctx.stroke();
      ctx.restore();
    } else if (obj.type === 'text') {
      ctx.save();
      ctx.fillStyle = obj.color;
      ctx.font = '600 ' + (obj.fontSizeFrac * canvas.width) + 'px "IBM Plex Sans", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(obj.text, obj.nx * canvas.width, obj.ny * canvas.height);
      ctx.restore();
    }
  }

  // Point-to-segment distance, used to hit-test strokes for the move tool.
  function annotPointSegDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var lenSq = dx * dx + dy * dy;
    var t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }

  // Finds the top-most object under a buffer-pixel point, or null.
  function annotHitTest(px, py) {
    var canvas = annotCanvasEl;
    if (!canvas) return null;
    for (var i = annotObjects.length - 1; i >= 0; i--) {
      var obj = annotObjects[i];
      if (obj.type === 'text') {
        var ctx = canvas.getContext('2d');
        ctx.save();
        ctx.font = '600 ' + (obj.fontSizeFrac * canvas.width) + 'px "IBM Plex Sans", sans-serif';
        var width = ctx.measureText(obj.text).width;
        ctx.restore();
        var height = obj.fontSizeFrac * canvas.width * 1.3;
        var x = obj.nx * canvas.width, y = obj.ny * canvas.height;
        if (px >= x - 6 && px <= x + width + 6 && py >= y - height / 2 - 6 && py <= y + height / 2 + 6) {
          return obj;
        }
      } else if (obj.type === 'stroke') {
        var threshold = Math.max(obj.sizeFrac * canvas.width * 2, 22 * ANNOT_DPR);
        var pts = obj.points;
        var hit = false;
        if (pts.length === 1) {
          var d0 = annotDistance({ x: px, y: py }, { x: pts[0].nx * canvas.width, y: pts[0].ny * canvas.height });
          if (d0 <= threshold) hit = true;
        } else {
          for (var j = 0; j < pts.length - 1 && !hit; j++) {
            var x1 = pts[j].nx * canvas.width, y1 = pts[j].ny * canvas.height;
            var x2 = pts[j + 1].nx * canvas.width, y2 = pts[j + 1].ny * canvas.height;
            if (annotPointSegDist(px, py, x1, y1, x2, y2) <= threshold) hit = true;
          }
        }
        if (hit) return obj;
      }
    }
    return null;
  }

  function applyAnnotView() {
    if (!annotInnerEl) return;
    annotInnerEl.style.transform = 'translate(' + annotView.x + 'px,' + annotView.y + 'px) scale(' + annotView.scale + ')';
    var zoomLabel = document.getElementById('annot-zoom-value');
    if (zoomLabel) zoomLabel.textContent = Math.round(annotView.scale * 100) + '%';
  }

  // Zooms in/out by a fixed step, keeping the wrap's own center point
  // visually anchored — the same pivot-anchor math the pinch gesture uses,
  // just with a fixed pivot instead of the fingers' midpoint.
  function annotZoomStep(factor) {
    var wrap = document.getElementById('annot-canvas-wrap');
    if (!wrap) return;
    var rect = wrap.getBoundingClientRect();
    var centerLocal = annotClientToLocal(rect.left + rect.width / 2, rect.top + rect.height / 2);
    var newScale = Math.max(0.5, Math.min(6, annotView.scale * factor));
    var pivotX = (centerLocal.x - annotView.x) / annotView.scale;
    var pivotY = (centerLocal.y - annotView.y) / annotView.scale;
    annotView.scale = newScale;
    annotView.x = centerLocal.x - newScale * pivotX;
    annotView.y = centerLocal.y - newScale * pivotY;
    applyAnnotView();
  }

  function annotDistance(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function annotMidpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // Converts a client (viewport) point into the LOCAL coordinate system that
  // #annot-canvas-inner's translate()/scale() transform operates in. That
  // local space is simply "pixels from the wrap's own top-left" UNLESS the
  // force-landscape CSS rotation hack is active, in which case the whole
  // subtree is additionally rotated 90° and a plain client-minus-rect
  // subtraction would be wrong — this undoes that fixed, known rotation.
  function annotClientToLocal(clientX, clientY) {
    var wrap = document.getElementById('annot-canvas-wrap');
    var overlay = document.getElementById('annot-overlay');
    var rect = wrap.getBoundingClientRect();
    var rotated = overlay && overlay.classList.contains('force-landscape');
    if (!rotated) {
      return { x: clientX - rect.left, y: clientY - rect.top };
    }
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var vx = clientX - cx, vy = clientY - cy;
    // Inverse of a 90° clockwise rotation about the center.
    var lx = vy, ly = -vx;
    var localW = rect.height, localH = rect.width; // dimensions swap under 90°
    return { x: lx + localW / 2, y: ly + localH / 2 };
  }

  // The wrap's own LOCAL (pre-rotation) box size. getBoundingClientRect()
  // always reports the on-screen, POST-rotation box, whose width/height are
  // swapped relative to local layout under the force-landscape 90° rotation
  // — this undoes that swap so callers get true local pixel dimensions.
  function annotWrapLocalSize() {
    var wrap = document.getElementById('annot-canvas-wrap');
    var overlay = document.getElementById('annot-overlay');
    if (!wrap) return { w: 0, h: 0 };
    var rect = wrap.getBoundingClientRect();
    var rotated = overlay && overlay.classList.contains('force-landscape');
    return rotated ? { w: rect.height, h: rect.width } : { w: rect.width, h: rect.height };
  }

  // Converts a point already in the wrap's LOCAL coordinate system (as
  // returned by annotClientToLocal) into a canvas drawing-buffer pixel —
  // undoes the pan/zoom transform applied to #annot-canvas-inner, then
  // scales from local CSS pixels to buffer pixels.
  function annotLocalToCanvasPoint(localX, localY) {
    var canvas = annotCanvasEl;
    if (!canvas) return { x: 0, y: 0 };
    var innerX = (localX - annotView.x) / annotView.scale;
    var innerY = (localY - annotView.y) / annotView.scale;
    var size = annotWrapLocalSize();
    return {
      x: innerX / (size.w || 1) * canvas.width,
      y: innerY / (size.h || 1) * canvas.height
    };
  }

  // Maps a client (viewport) coordinate to a pixel coordinate in the
  // canvas's drawing buffer, correctly accounting for BOTH the fixed 90°
  // force-landscape rotation (if active) and the current pan/zoom — a plain
  // getBoundingClientRect() ratio silently breaks under the rotation
  // because on-screen axes no longer line up with the buffer's own axes.
  function annotCanvasPointFromClient(clientX, clientY) {
    var localPt = annotClientToLocal(clientX, clientY);
    return annotLocalToCanvasPoint(localPt.x, localPt.y);
  }

  function annotDrawSegment(x0, y0, x1, y1) {
    var canvas = annotCanvasEl;
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.save();
    if (annot.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = annot.size * 3 * ANNOT_DPR;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = annot.color;
      ctx.lineWidth = annot.size * ANNOT_DPR;
    }
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }

  // Unified gesture handling on the wrap: one finger draws (or drops a text
  // label), two fingers pan/zoom the view — same convention as most
  // sketching apps, and works with mouse too (mouse never has a 2nd pointer).
  function annotFinalizeCurrentStroke() {
    if (annotCurrentStroke) {
      annotObjects.push(annotCurrentStroke);
      annotCurrentStroke = null;
    }
  }

  function onAnnotWrapPointerDown(e) {
    var wrap = e.currentTarget;
    annotPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (annotPointers.size === 1) {
      if (annot.tool === 'text') {
        e.preventDefault();
        // Text input/labels are children of the wrap (not the pan/zoomed
        // inner div), so they only need the rotation undone, not pan/zoom.
        var localTap = annotClientToLocal(e.clientX, e.clientY);
        showAnnotTextInput(localTap.x, localTap.y);
      } else if (annot.tool === 'move') {
        e.preventDefault();
        var canvasM = annotCanvasEl;
        var mpt = annotCanvasPointFromClient(e.clientX, e.clientY);
        var hitObj = annotHitTest(mpt.x, mpt.y);
        if (hitObj && canvasM) {
          try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
          pushAnnotUndo();
          annotDrag = {
            obj: hitObj,
            startNx: mpt.x / canvasM.width,
            startNy: mpt.y / canvasM.height,
            orig: hitObj.type === 'text'
              ? { nx: hitObj.nx, ny: hitObj.ny }
              : { points: hitObj.points.map(function (p) { return { nx: p.nx, ny: p.ny }; }) }
          };
        } else {
          annotDrag = null;
        }
      } else {
        try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
        var pt = annotCanvasPointFromClient(e.clientX, e.clientY);
        annot.drawing = true;
        annot.lastX = pt.x;
        annot.lastY = pt.y;
        pushAnnotUndo();
        var canvas2 = annotCanvasEl;
        annotCurrentStroke = {
          type: 'stroke',
          tool: annot.tool,
          color: annot.color,
          sizeFrac: (annot.size * ANNOT_DPR) / canvas2.width,
          points: [{ nx: pt.x / canvas2.width, ny: pt.y / canvas2.height }]
        };
      }
    } else if (annotPointers.size === 2) {
      annot.drawing = false;
      annotFinalizeCurrentStroke();
      annotDrag = null;
      var pending = document.getElementById('annot-text-input');
      if (pending) pending.blur();
      var pts = Array.from(annotPointers.values());
      var localA = annotClientToLocal(pts[0].x, pts[0].y);
      var localB = annotClientToLocal(pts[1].x, pts[1].y);
      annotPinch = {
        startDist: annotDistance(pts[0], pts[1]),
        startMidLocal: annotMidpoint(localA, localB),
        startScale: annotView.scale,
        startX: annotView.x,
        startY: annotView.y
      };
    }
    e.preventDefault();
  }

  function onAnnotWrapPointerMove(e) {
    if (!annotPointers.has(e.pointerId)) return;
    annotPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (annotPointers.size >= 2 && annotPinch) {
      var pts = Array.from(annotPointers.values()).slice(0, 2);
      var dist = annotDistance(pts[0], pts[1]);
      var localA = annotClientToLocal(pts[0].x, pts[0].y);
      var localB = annotClientToLocal(pts[1].x, pts[1].y);
      var midLocal = annotMidpoint(localA, localB);
      var scaleRatio = dist / (annotPinch.startDist || 1);
      var newScale = Math.max(0.5, Math.min(6, annotPinch.startScale * scaleRatio));
      // Keep the point under the fingers at pinch-start anchored under the
      // fingers' current midpoint as scale changes (standard pinch-zoom
      // pivot math), instead of naively adding the midpoint's raw delta —
      // the latter looks like it "doesn't zoom right", drifting the image
      // out from under your fingers as soon as the distance changes.
      var pivotX = (annotPinch.startMidLocal.x - annotPinch.startX) / annotPinch.startScale;
      var pivotY = (annotPinch.startMidLocal.y - annotPinch.startY) / annotPinch.startScale;
      annotView.scale = newScale;
      annotView.x = midLocal.x - newScale * pivotX;
      annotView.y = midLocal.y - newScale * pivotY;
      applyAnnotView();
      e.preventDefault();
      return;
    }
    if (annotPointers.size === 1 && annot.tool === 'move' && annotDrag) {
      var canvasM = annotCanvasEl;
      if (canvasM) {
        var mpt = annotCanvasPointFromClient(e.clientX, e.clientY);
        var nx = mpt.x / canvasM.width, ny = mpt.y / canvasM.height;
        var dnx = nx - annotDrag.startNx, dny = ny - annotDrag.startNy;
        var obj = annotDrag.obj;
        if (obj.type === 'text') {
          obj.nx = annotDrag.orig.nx + dnx;
          obj.ny = annotDrag.orig.ny + dny;
        } else {
          obj.points = annotDrag.orig.points.map(function (p) { return { nx: p.nx + dnx, ny: p.ny + dny }; });
        }
        redrawAnnotCanvas();
      }
      e.preventDefault();
      return;
    }
    if (annotPointers.size === 1 && annot.drawing && annotCurrentStroke) {
      var pt = annotCanvasPointFromClient(e.clientX, e.clientY);
      annotDrawSegment(annot.lastX, annot.lastY, pt.x, pt.y);
      annot.lastX = pt.x;
      annot.lastY = pt.y;
      var canvas2 = annotCanvasEl;
      annotCurrentStroke.points.push({ nx: pt.x / canvas2.width, ny: pt.y / canvas2.height });
      e.preventDefault();
    }
  }

  function onAnnotWrapPointerUp(e) {
    annotPointers.delete(e.pointerId);
    if (annotPointers.size < 2) annotPinch = null;
    if (annotPointers.size === 0) {
      annot.drawing = false;
      annotFinalizeCurrentStroke();
      annotDrag = null;
    }
  }

  // window.prompt() is blocked inside the artifact's sandboxed frame (no
  // allow-modals), so the text tool uses a small in-page input instead of a
  // native prompt dialog. Once confirmed, the text becomes a draggable
  // label the rider can reposition before "baking" it into the drawing.
  function showAnnotTextInput(wrapX, wrapY) {
    var wrap = document.getElementById('annot-canvas-wrap');
    if (!wrap) return;
    var existingInput = document.getElementById('annot-text-input');
    if (existingInput && existingInput.parentNode) existingInput.parentNode.removeChild(existingInput);

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'annot-text-input';
    input.className = 'annot-text-input';
    input.placeholder = 'Texte…';
    input.style.left = wrapX + 'px';
    input.style.top = wrapY + 'px';
    input.style.color = annot.color;
    input.style.fontSize = annot.fontSize + 'px';
    wrap.appendChild(input);
    input.focus();

    var committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      var value = input.value.trim();
      if (input.parentNode) input.parentNode.removeChild(input);
      if (value) createAnnotTextLabel(value, wrapX, wrapY);
    }
    function cancel() {
      committed = true;
      if (input.parentNode) input.parentNode.removeChild(input);
    }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

  // A movable label the rider can drag with one finger to reposition, resize
  // with A-/A+, and then confirm (✓ bakes it into the canvas pixels) or
  // discard (×).
  function createAnnotTextLabel(text, wrapX, wrapY) {
    var wrap = document.getElementById('annot-canvas-wrap');
    if (!wrap) return;
    var size = annot.fontSize;
    var label = document.createElement('div');
    label.className = 'annot-text-label';
    label.textContent = text;
    label.style.left = wrapX + 'px';
    label.style.top = wrapY + 'px';
    label.style.color = annot.color;
    label.style.fontSize = size + 'px';
    wrap.appendChild(label);

    var controls = document.createElement('div');
    controls.className = 'annot-text-controls';
    controls.innerHTML =
      '<button type="button" class="annot-text-smaller" aria-label="Réduire le texte">A-</button>' +
      '<button type="button" class="annot-text-bigger" aria-label="Agrandir le texte">A+</button>' +
      '<button type="button" class="annot-text-confirm" aria-label="Valider le texte">✓</button>' +
      '<button type="button" class="annot-text-delete" aria-label="Supprimer le texte">×</button>';
    // Stop these buttons' pointerdown from bubbling to the wrap-level
    // gesture handler — it calls preventDefault() while the text tool is
    // active, which would otherwise silently swallow the click that follows.
    controls.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    wrap.appendChild(controls);

    // Pure local-space arithmetic (offsetWidth/offsetHeight are layout
    // values, unaffected by any ancestor CSS transform) so this positions
    // correctly whether or not the force-landscape rotation is active —
    // using getBoundingClientRect() here would mix up the axes once rotated.
    function positionControls() {
      var leftPx = parseFloat(label.style.left) || 0;
      var topPx = parseFloat(label.style.top) || 0;
      var w = label.offsetWidth, h = label.offsetHeight;
      controls.style.left = (leftPx + w + 4) + 'px';
      controls.style.top = (topPx - h / 2 - 4) + 'px';
    }
    positionControls();

    var dragging = false, offsetX = 0, offsetY = 0;
    label.addEventListener('pointerdown', function (e) {
      dragging = true;
      try { label.setPointerCapture(e.pointerId); } catch (err) {}
      var localStart = annotClientToLocal(e.clientX, e.clientY);
      offsetX = localStart.x - (parseFloat(label.style.left) || 0);
      offsetY = localStart.y - (parseFloat(label.style.top) || 0);
      e.preventDefault();
      e.stopPropagation();
    });
    label.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var localPt = annotClientToLocal(e.clientX, e.clientY);
      label.style.left = (localPt.x - offsetX) + 'px';
      label.style.top = (localPt.y - offsetY) + 'px';
      positionControls();
      e.preventDefault();
      e.stopPropagation();
    });
    function stopDrag(e) { dragging = false; if (e) e.stopPropagation(); }
    label.addEventListener('pointerup', stopDrag);
    label.addEventListener('pointercancel', stopDrag);

    function cleanup() {
      if (label.parentNode) label.parentNode.removeChild(label);
      if (controls.parentNode) controls.parentNode.removeChild(controls);
    }
    function resize(delta) {
      size = Math.max(12, Math.min(64, size + delta));
      label.style.fontSize = size + 'px';
      annot.fontSize = size; // next text starts at the last used size
      positionControls();
    }
    controls.querySelector('.annot-text-smaller').addEventListener('click', function (e) {
      e.stopPropagation();
      resize(-4);
    });
    controls.querySelector('.annot-text-bigger').addEventListener('click', function (e) {
      e.stopPropagation();
      resize(4);
    });
    controls.querySelector('.annot-text-confirm').addEventListener('click', function (e) {
      e.stopPropagation();
      // label.style.left/top ARE the local anchor (left edge, vertical
      // center — matching fillText's left-align/middle-baseline) that we've
      // been tracking all along, so convert straight from local space
      // instead of round-tripping through getBoundingClientRect(), which
      // reports an axis-swapped bounding box once the label is rotated.
      var localX = parseFloat(label.style.left) || 0;
      var localY = parseFloat(label.style.top) || 0;
      var pt = annotLocalToCanvasPoint(localX, localY);
      var canvas = annotCanvasEl;
      if (canvas) {
        // Buffer pixels per on-screen CSS pixel is just DPR/zoom — constant
        // regardless of rotation, since the canvas buffer is always sized
        // from its own local (un-rotated) box (see annotWrapLocalSize) and
        // rotation doesn't change lengths. Store the baked size as a
        // FRACTION of the buffer width so it survives a later resize.
        var bufferScale = ANNOT_DPR / annotView.scale;
        pushAnnotUndo();
        var textObj = {
          type: 'text',
          text: text,
          color: label.style.color,
          nx: pt.x / canvas.width,
          ny: pt.y / canvas.height,
          fontSizeFrac: (size * bufferScale) / canvas.width
        };
        annotObjects.push(textObj);
        drawAnnotObject(textObj, canvas.getContext('2d'), canvas);
      }
      cleanup();
    });
    controls.querySelector('.annot-text-delete').addEventListener('click', function (e) {
      e.stopPropagation();
      cleanup();
    });
  }

  function saveAnnotation() {
    if (!annotCanvasEl) return;
    // any text label still pending gets baked in automatically on save
    var pendingConfirm = document.querySelector('.annot-text-confirm');
    if (pendingConfirm) pendingConfirm.click();
    var dataUrl = annotCanvasEl.toDataURL('image/png');
    var prevState = JSON.parse(JSON.stringify(STATE));
    if (annot.sessionId === ANNOT_CIRCUIT_LEVEL) {
      STATE.circuits = STATE.circuits || {};
      var entry = STATE.circuits[annot.circuit] || {};
      entry.drawing = dataUrl;
      STATE.circuits[annot.circuit] = entry;
    } else if (isEventLevelId(annot.sessionId)) {
      var evForSave = STATE.events.filter(function (e) { return e.id === eventIdFromLevelId(annot.sessionId); })[0];
      if (evForSave) evForSave.drawing = dataUrl;
    } else {
      var session = STATE.sessions.filter(function (s) { return s.id === annot.sessionId; })[0];
      if (session) session.drawing = dataUrl;
    }
    persist(prevState);
    showToast('Annotation enregistrée.', 'success');
    renderAnnotationOverlay();
  }

  // Flattens the circuit map + annotations onto an opaque white background
  // (the canvas itself is transparent, so exporting it alone would give a
  // washed-out/see-through PNG) and shows it full-screen as a plain <img>.
  // Long-pressing an <img> is a native browser/OS feature ("Enregistrer
  // l'image") that works even inside a sandboxed, publicly-shared artifact —
  // unlike the `downloads` capability, which the platform disables the
  // moment an artifact is shared publicly (this one is, so riders can add
  // their own chronos), and unlike a script-triggered download, which the
  // viewer's sandbox blocks outright.
  function exportAnnotationPng() {
    if (!annotCanvasEl) return;
    var pendingConfirm = document.querySelector('.annot-text-confirm');
    if (pendingConfirm) pendingConfirm.click();
    var canvas = annotCanvasEl;
    var out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    var octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    var basemapImg = document.querySelector('#annot-canvas-wrap .annot-basemap');
    if (basemapImg && basemapImg.complete && basemapImg.naturalWidth) {
      // Replicate the on-screen "object-fit: contain" placement and the
      // basemap's reduced opacity so the export matches what's visible.
      var iw = basemapImg.naturalWidth, ih = basemapImg.naturalHeight;
      var scale = Math.min(out.width / iw, out.height / ih);
      var dw = iw * scale, dh = ih * scale;
      var dx = (out.width - dw) / 2, dy = (out.height - dh) / 2;
      octx.save();
      octx.globalAlpha = 0.55;
      octx.drawImage(basemapImg, dx, dy, dw, dh);
      octx.restore();
    }
    octx.drawImage(canvas, 0, 0, out.width, out.height);
    showAnnotImagePreview(out.toDataURL('image/png'));
  }

  function showAnnotImagePreview(dataUrl) {
    var existing = document.getElementById('annot-image-preview');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var overlay = document.createElement('div');
    overlay.id = 'annot-image-preview';
    overlay.className = 'annot-image-preview-overlay';
    overlay.innerHTML =
      '<button type="button" class="ghost icon-btn annot-image-preview-close" id="annot-image-preview-close" aria-label="Fermer">✕</button>' +
      '<img src="' + dataUrl + '" alt="Tracé annoté">' +
      '<div class="annot-image-preview-hint">Appui long sur l’image pour l’enregistrer dans votre galerie photo (ou faites une capture d’écran).</div>';
    document.body.appendChild(overlay);
    function closePreview() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    document.getElementById('annot-image-preview-close').addEventListener('click', closePreview);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closePreview(); });
  }

  function attachAnnotHandlers() {
    var closeBtn = document.getElementById('annot-close');
    if (closeBtn) closeBtn.addEventListener('click', closeAnnotation);

    var sessionSelect = document.getElementById('annot-session-select');
    if (sessionSelect) {
      sessionSelect.addEventListener('change', function () {
        annot.sessionId = sessionSelect.value;
        renderAnnotationOverlay();
      });
    }

    document.querySelectorAll('.annot-tool-btn[data-tool]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === annot.tool);
      btn.addEventListener('click', function () {
        annot.tool = btn.getAttribute('data-tool');
        document.querySelectorAll('.annot-tool-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });

    var colorInput = document.getElementById('annot-color');
    if (colorInput) colorInput.addEventListener('input', function (e) { annot.color = e.target.value; });

    document.querySelectorAll('.annot-size-btn[data-size]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        annot.size = parseFloat(btn.getAttribute('data-size'));
        document.querySelectorAll('.annot-size-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });

    var zoomValueBtn = document.getElementById('annot-zoom-value');
    if (zoomValueBtn) {
      zoomValueBtn.addEventListener('click', function () {
        annotView = { scale: 1, x: 0, y: 0 };
        applyAnnotView();
      });
    }
    var zoomOutBtn = document.getElementById('annot-zoom-out');
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', function () { annotZoomStep(1 / 1.25); });
    var zoomInBtn = document.getElementById('annot-zoom-in');
    if (zoomInBtn) zoomInBtn.addEventListener('click', function () { annotZoomStep(1.25); });

    var undoBtn = document.getElementById('annot-undo');
    if (undoBtn) undoBtn.addEventListener('click', annotUndo);

    var clearBtn = document.getElementById('annot-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (!annotCanvasEl) return;
        if (!annotObjects.length && !annotBaseImageVisible) return;
        pushAnnotUndo();
        annotObjects = [];
        annotBaseImageVisible = false;
        annotCurrentStroke = null;
        annotDrag = null;
        redrawAnnotCanvas();
      });
    }

    var saveBtn = document.getElementById('annot-save');
    if (saveBtn) saveBtn.addEventListener('click', saveAnnotation);

    var exportBtn = document.getElementById('annot-export');
    if (exportBtn) exportBtn.addEventListener('click', exportAnnotationPng);

    var fullscreenBtn = document.getElementById('annot-fullscreen');
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleAnnotFullscreen);

    var wrap = document.getElementById('annot-canvas-wrap');
    if (wrap) {
      wrap.addEventListener('pointerdown', onAnnotWrapPointerDown);
      wrap.addEventListener('pointermove', onAnnotWrapPointerMove);
      wrap.addEventListener('pointerup', onAnnotWrapPointerUp);
      wrap.addEventListener('pointercancel', onAnnotWrapPointerUp);
    }
  }

  // ---- Calendrier : sorties planifiées + sessions déjà roulées, en vue année/mois/semaine ----

  var MONTH_NAMES_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  var WEEKDAY_LETTERS_FR = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  function eventsList() {
    STATE.events = STATE.events || [];
    return STATE.events;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // Parses a "YYYY-MM-DD" string as a LOCAL midnight Date (not UTC), so
  // day-by-day range walking and calendar-cell matching stay consistent
  // regardless of the viewer's timezone.
  function parseLocalDate(str) {
    var p = str.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  var WEEKDAY_NAMES_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  function weekdayName(iso) {
    return WEEKDAY_NAMES_FR[parseLocalDate(iso).getDay()];
  }

  function dateKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function shortDayMonth(date) {
    return pad2(date.getDate()) + '/' + pad2(date.getMonth() + 1);
  }

  function mondayOf(date) {
    var copy = new Date(date.getTime());
    var dow = (copy.getDay() + 6) % 7; // Monday = 0
    copy.setDate(copy.getDate() - dow);
    return copy;
  }

  // Every rider known to the log — from ridden sessions AND from planned
  // outings (a rider can be added to an outing before ever logging a
  // chrono), so the calendar's rider filter covers both.
  function allKnownRiders() {
    var seen = {};
    (STATE.riders || []).forEach(function (r) { seen[r] = true; });
    distinctRiders().forEach(function (r) { seen[r] = true; });
    eventsList().forEach(function (ev) { (ev.riders || []).forEach(function (r) { seen[r] = true; }); });
    var out = Object.keys(seen);
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  // Condensed human-readable date range for an event, e.g. "28-30 septembre"
  // or, spanning months/years, "28 septembre - 2 octobre". Pass withYear for
  // the fuller form used in the detail card.
  function formatEventRange(ev, withYear) {
    var s = parseLocalDate(ev.dateStart);
    var e = parseLocalDate(ev.dateEnd || ev.dateStart);
    var yearSuffix = withYear ? ' ' + e.getFullYear() : '';
    if (s.getTime() === e.getTime()) {
      return s.getDate() + ' ' + MONTH_NAMES_FR[s.getMonth()].toLowerCase() + yearSuffix;
    }
    if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
      return s.getDate() + '-' + e.getDate() + ' ' + MONTH_NAMES_FR[e.getMonth()].toLowerCase() + yearSuffix;
    }
    if (s.getFullYear() === e.getFullYear()) {
      return s.getDate() + ' ' + MONTH_NAMES_FR[s.getMonth()].toLowerCase() + ' - ' + e.getDate() + ' ' + MONTH_NAMES_FR[e.getMonth()].toLowerCase() + yearSuffix;
    }
    return s.getDate() + ' ' + MONTH_NAMES_FR[s.getMonth()].toLowerCase() + ' ' + s.getFullYear() +
      ' - ' + e.getDate() + ' ' + MONTH_NAMES_FR[e.getMonth()].toLowerCase() + ' ' + e.getFullYear();
  }

  function eventCircuitById(id) {
    var ev = eventsList().filter(function (e) { return e.id === id; })[0];
    return ev ? ev.circuit : '';
  }

  // Maps every date-string touched by a planned outing to
  // {eventId, isStart, isEnd} so the grids can highlight whole ranges with
  // rounded ends, in one pass over all events. Respects the global rider
  // picker (above the main tabs) — an event with riders specified is hidden
  // unless at least one of them is selected; an event with no riders yet
  // always shows.
  function eventDateInfoAll() {
    var map = {};
    eventsList().forEach(function (ev) {
      if (selectedRiders && ev.riders && ev.riders.length) {
        var matches = ev.riders.some(function (r) { return selectedRiders.has(r); });
        if (!matches) return;
      }
      var start = parseLocalDate(ev.dateStart);
      var end = parseLocalDate(ev.dateEnd || ev.dateStart);
      var cur = new Date(start.getTime());
      var guard = 0;
      while (cur.getTime() <= end.getTime() && guard < 400) {
        guard++;
        map[dateKey(cur)] = {
          eventId: ev.id,
          isStart: cur.getTime() === start.getTime(),
          isEnd: cur.getTime() === end.getTime()
        };
        cur.setDate(cur.getDate() + 1);
      }
    });
    return map;
  }

  // Maps every date-string that has at least one ridden session to the list
  // of sessions on that date (respecting the global rider picker), so those
  // dates can be shown in a different colour from planned outings.
  function sessionsByDate() {
    var map = {};
    STATE.sessions.forEach(function (s) {
      if (!s.date) return;
      if (selectedRiders && !selectedRiders.has(s.rider)) return;
      (map[s.date] = map[s.date] || []).push(s);
    });
    return map;
  }

  function sessionsOnDate(dateStr) {
    return STATE.sessions.filter(function (s) {
      return s.date === dateStr && (!selectedRiders || selectedRiders.has(s.rider));
    });
  }

  // Chronos no longer has its own tab — its content (rider picker,
  // progression chart, entry form, session history) is appended to the
  // end of Circuit, since it was always about the currently active circuit
  // anyway. See renderCircuitTab().
  var MAIN_TABS = [
    ['event', 'Événements'],
    ['planning', 'Planning'],
    ['circuit', 'Chronos'],
    ['stats', 'Stats']
  ];

  function renderViewTabs() {
    var html = '<div class="view-tabs">';
    MAIN_TABS.forEach(function (t) {
      html += '<button type="button" class="view-tab' + (activeView === t[0] ? ' active' : '') + '" data-view="' + t[0] + '">' + t[1] + '</button>';
    });
    html += '</div>';
    return '<div class="main-tabs-wrap">' + html + '</div>';
  }

  // Ordered for ergonomics: (1) the year's sorties at a glance, (2) the
  // calendar grid to navigate/pick a date, (3) a summary of whichever
  // sortie/day is currently selected. The add/edit form stays last — it's
  // an action, not something to read.
  // The event's own info/checklist/actions live in the Événement tab now —
  // showing them again here would just duplicate that. Calendrier stays
  // focused on navigating dates: the grid, then a summary of sorties in
  // whatever period is on screen (clicking one jumps to Événement). A
  // day's logged chronos (not event-related) still show inline, since
  // that's not duplicated anywhere else.
  function renderCalendarSection() {
    var eventInfo = eventDateInfoAll();
    var sessionsMap = sessionsByDate();
    var html = '<h2 class="section-title section-heading-standalone">Calendrier</h2>';
    html += renderCalendarViewSwitcher();
    html += renderCalendarZoomHint();
    html += renderCalendarNav();
    if (calendarViewMode === 'month') html += renderMonthGrid(eventInfo, sessionsMap);
    else if (calendarViewMode === 'week') html += renderWeekGrid(eventInfo, sessionsMap);
    else if (calendarViewMode === '6month') html += renderMultiMonthGrid(6, eventInfo, sessionsMap);
    else if (calendarViewMode === '3month') html += renderMultiMonthGrid(3, eventInfo, sessionsMap);
    else if (calendarViewMode === '2month') html += renderMultiMonthGrid(2, eventInfo, sessionsMap);
    else html += renderYearGrid(eventInfo, sessionsMap);
    if (selectedSessionDate) html += renderSessionDayCard(selectedSessionDate);
    html += renderPeriodEventsCard();
    return html;
  }

  var ZOOM_LEVEL_LABELS = { year: 'Année', '6month': '6 mois', '3month': '3 mois', '2month': '2 mois', month: 'Mois', week: 'Semaine' };

  // Explicit buttons for picking the calendar's zoom level -- pinch/Ctrl+
  // wheel gestures (see the hint below) still work too, but aren't
  // discoverable on their own, especially for someone without a trackpad.
  function renderCalendarViewSwitcher() {
    var html = '<div class="calendar-view-switcher">';
    ZOOM_LEVELS.forEach(function (mode) {
      html += '<button type="button" class="calendar-view-btn' + (calendarViewMode === mode ? ' active' : '') + '" data-calendar-view="' + mode + '">' + ZOOM_LEVEL_LABELS[mode] + '</button>';
    });
    html += '</div>';
    return html;
  }

  function renderCalendarZoomHint() {
    return '<div class="calendar-zoom-hint">Astuce : glissez à gauche/droite (ou flèches ← →) pour changer de période, pincez à deux doigts ou Ctrl + molette pour zoomer.</div>';
  }

  // How many consecutive months a given mode shows — 'year' is the one
  // special case (always the 12 calendar-aligned months of one year); the
  // others are a rolling window of N months starting at calendarAnchor.
  function monthsCountForMode(mode) {
    if (mode === '6month') return 6;
    if (mode === '3month') return 3;
    if (mode === '2month') return 2;
    return 1; // 'month'
  }

  // The exact date range currently on screen, mirroring the grid-building
  // logic above — lets the sorties summary below the calendar track
  // whatever period the rider has zoomed/navigated to (a week, a month, a
  // year…) instead of always being pinned to the whole year.
  function visiblePeriodRange() {
    var d = parseLocalDate(calendarAnchor);
    if (calendarViewMode === 'year') {
      return { start: dateKey(new Date(d.getFullYear(), 0, 1)), end: dateKey(new Date(d.getFullYear(), 11, 31)) };
    }
    if (calendarViewMode === 'week') {
      var monday = mondayOf(d);
      var sunday = new Date(monday.getTime());
      sunday.setDate(sunday.getDate() + 6);
      return { start: dateKey(monday), end: dateKey(sunday) };
    }
    var count = monthsCountForMode(calendarViewMode);
    var start = new Date(d.getFullYear(), d.getMonth(), 1);
    var end = new Date(d.getFullYear(), d.getMonth() + count, 0); // last day of the count-th month
    return { start: dateKey(start), end: dateKey(end) };
  }

  function calendarNavLabel() {
    var d = parseLocalDate(calendarAnchor);
    if (calendarViewMode === 'year') return '' + d.getFullYear();
    if (calendarViewMode === 'week') {
      var monday = mondayOf(d);
      var sunday = new Date(monday.getTime());
      sunday.setDate(sunday.getDate() + 6);
      return shortDayMonth(monday) + ' – ' + shortDayMonth(sunday) + ' ' + sunday.getFullYear();
    }
    var count = monthsCountForMode(calendarViewMode);
    if (count === 1) return MONTH_NAMES_FR[d.getMonth()] + ' ' + d.getFullYear();
    var end = new Date(d.getFullYear(), d.getMonth() + count - 1, 1);
    if (d.getFullYear() === end.getFullYear()) {
      return MONTH_NAMES_FR[d.getMonth()] + ' - ' + MONTH_NAMES_FR[end.getMonth()] + ' ' + d.getFullYear();
    }
    return MONTH_NAMES_FR[d.getMonth()] + ' ' + d.getFullYear() + ' - ' + MONTH_NAMES_FR[end.getMonth()] + ' ' + end.getFullYear();
  }

  function calendarNavStep(delta) {
    var d = parseLocalDate(calendarAnchor);
    if (calendarViewMode === 'year') d.setFullYear(d.getFullYear() + delta);
    else if (calendarViewMode === 'week') d.setDate(d.getDate() + delta * 7);
    else d.setMonth(d.getMonth() + delta * monthsCountForMode(calendarViewMode));
    calendarAnchor = dateKey(d);
  }

  // Steps through ZOOM_LEVELS (Année → 6 mois → 3 mois → 2 mois → Mois →
  // Semaine). direction +1 = more detail (zoom in), -1 = less (zoom out).
  // Returns false at either end so callers can skip a pointless re-render.
  function calendarZoomStep(direction) {
    var idx = ZOOM_LEVELS.indexOf(calendarViewMode);
    if (idx === -1) idx = 0;
    var next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + direction));
    if (next === idx) return false;
    calendarViewMode = ZOOM_LEVELS[next];
    return true;
  }

  function renderCalendarNav() {
    return (
      '<div class="card calendar-nav-card">' +
        '<button type="button" class="ghost icon-btn" id="cal-prev" aria-label="Précédent">‹</button>' +
        '<div class="calendar-year-label">' + calendarNavLabel() + '</div>' +
        '<button type="button" class="ghost icon-btn" id="cal-next" aria-label="Suivant">›</button>' +
        '<button type="button" class="ghost" id="cal-today">Aujourd\'hui</button>' +
      '</div>'
    );
  }

  function renderYearGrid(eventInfo, sessionsMap) {
    var year = parseLocalDate(calendarAnchor).getFullYear();
    var html = '<div class="card calendar-grid-card"><div class="calendar-year-grid">';
    for (var m = 0; m < 12; m++) html += renderMonthMini(year, m, eventInfo, sessionsMap);
    html += '</div></div>';
    return html;
  }

  // Rolling window of `count` consecutive months starting at calendarAnchor
  // — used for the 6/3/2-month zoom levels between the full year and a
  // single month.
  function renderMultiMonthGrid(count, eventInfo, sessionsMap) {
    var anchor = parseLocalDate(calendarAnchor);
    var startYear = anchor.getFullYear(), startMonth = anchor.getMonth();
    var html = '<div class="card calendar-grid-card"><div class="calendar-year-grid">';
    for (var i = 0; i < count; i++) {
      var y = startYear, m = startMonth + i;
      while (m > 11) { m -= 12; y += 1; }
      html += renderMonthMini(y, m, eventInfo, sessionsMap);
    }
    html += '</div></div>';
    return html;
  }

  function renderMonthMini(year, month, eventInfo, sessionsMap) {
    var firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayKey = dateKey(new Date());
    var html = '<div class="cal-month"><div class="cal-month-title">' + MONTH_NAMES_FR[month] + '</div>';
    html += '<div class="cal-weekdays">' + WEEKDAY_LETTERS_FR.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="cal-days">';
    for (var i = 0; i < firstDow; i++) html += '<span class="cal-day empty"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var key = year + '-' + pad2(month + 1) + '-' + pad2(d);
      var cell = eventInfo[key];
      var sessions = sessionsMap[key];
      var classes = 'cal-day';
      if (cell) {
        classes += ' has-event';
        if (cell.eventId === selectedEventId) classes += ' selected';
        if (cell.isStart) classes += ' range-start';
        if (cell.isEnd) classes += ' range-end';
      }
      if (sessions && sessions.length) classes += ' has-session';
      if (key === todayKey) classes += ' today';
      var dotHtml = (sessions && sessions.length) ? '<span class="cal-day-dot"></span>' : '';
      if (cell || (sessions && sessions.length)) {
        html += '<button type="button" class="calendar-cell ' + classes + '" data-date="' + key + '"' + (cell ? ' data-event-id="' + cell.eventId + '"' : '') + '>' + d + dotHtml + '</button>';
      } else {
        html += '<span class="' + classes + '">' + d + '</span>';
      }
    }
    html += '</div></div>';
    return html;
  }

  function renderMonthGrid(eventInfo, sessionsMap) {
    var anchor = parseLocalDate(calendarAnchor);
    var year = anchor.getFullYear(), month = anchor.getMonth();
    var firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayKey = dateKey(new Date());
    var html = '<div class="card calendar-grid-card"><div class="cal-month cal-month-large">';
    html += '<div class="cal-weekdays">' + WEEKDAY_LETTERS_FR.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="cal-days cal-days-large">';
    for (var i = 0; i < firstDow; i++) html += '<span class="cal-day cal-day-large empty"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var key = year + '-' + pad2(month + 1) + '-' + pad2(d);
      var cell = eventInfo[key];
      var sessions = sessionsMap[key];
      var classes = 'cal-day cal-day-large';
      if (cell) {
        classes += ' has-event';
        if (cell.eventId === selectedEventId) classes += ' selected';
        if (cell.isStart) classes += ' range-start';
        if (cell.isEnd) classes += ' range-end';
      }
      if (sessions && sessions.length) classes += ' has-session';
      if (key === todayKey) classes += ' today';
      var inner = '<span class="cal-day-num">' + d + '</span>';
      if (cell) inner += '<span class="cal-day-label">' + escapeHtml(eventCircuitById(cell.eventId)) + '</span>';
      if (sessions && sessions.length) inner += '<span class="cal-day-dot"></span>';
      if (cell || (sessions && sessions.length)) {
        html += '<button type="button" class="calendar-cell ' + classes + '" data-date="' + key + '"' + (cell ? ' data-event-id="' + cell.eventId + '"' : '') + '>' + inner + '</button>';
      } else {
        html += '<span class="' + classes + '">' + inner + '</span>';
      }
    }
    html += '</div></div></div>';
    return html;
  }

  function renderWeekGrid(eventInfo, sessionsMap) {
    var anchor = parseLocalDate(calendarAnchor);
    var monday = mondayOf(anchor);
    var todayKey = dateKey(new Date());
    var html = '<div class="card calendar-grid-card"><div class="cal-week">';
    for (var i = 0; i < 7; i++) {
      var d = new Date(monday.getTime());
      d.setDate(d.getDate() + i);
      var key = dateKey(d);
      var cell = eventInfo[key];
      var sessions = sessionsMap[key];
      var classes = 'cal-week-day';
      if (cell) classes += ' has-event';
      if (sessions && sessions.length) classes += ' has-session';
      if (key === todayKey) classes += ' today';
      var clickable = !!cell || (sessions && sessions.length);
      html += '<div class="' + (clickable ? 'calendar-cell ' : '') + classes + '"' + (clickable ? ' data-date="' + key + '"' : '') + (cell ? ' data-event-id="' + cell.eventId + '"' : '') + '>';
      html += '<div class="cal-week-day-head">' + WEEKDAY_LETTERS_FR[i] + ' ' + d.getDate() + '</div>';
      if (cell) {
        var ev = eventsList().filter(function (e) { return e.id === cell.eventId; })[0];
        if (ev) {
          html += '<div class="cal-week-event">' + escapeHtml(ev.circuit) + '</div>';
          if (ev.riders && ev.riders.length) html += '<div class="cal-week-riders">' + escapeHtml(ev.riders.join(', ')) + '</div>';
        }
      }
      if (sessions && sessions.length) {
        sessions.forEach(function (s) {
          html += '<div class="cal-week-session">' + escapeHtml(s.rider) + ' · ' + formatTime(sessionBest(s)) + '</div>';
        });
      }
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  // Deleting a sortie is admin-only (matches firestore.rules) -- several
  // riders can be relying on it (groupes, horaires, checklist), not just
  // whoever created it.
  function deleteEventControl(id) {
    if (!isAdmin()) return '';
    return '<button type="button" class="ghost icon-btn" data-action="delete-event-request" data-id="' + id + '" aria-label="Supprimer cette sortie" title="Supprimer">×</button>';
  }

  function renderSessionDayCard(dateStr) {
    var sessions = sessionsOnDate(dateStr);
    if (!sessions.length) return '';
    var html = '<div class="card event-detail-card session-day-card">';
    html += '<div class="event-detail-header"><h3>Chronos du ' + escapeHtml(formatDate(dateStr)) + '</h3><button type="button" class="ghost icon-btn" id="close-session-day" aria-label="Fermer">×</button></div>';
    sessions.forEach(function (s) {
      html += infoRow(s.rider + ' — ' + s.circuit, formatTime(sessionBest(s)));
    });
    html += '</div>';
    return html;
  }

  // Reuses the exact same accordion component as the Événement tab
  // (renderEventGroupCard) — clicking a sortie here expands its résumé in
  // place, right where it was clicked, instead of navigating away.
  function renderPeriodEventsCard() {
    var range = visiblePeriodRange();
    var events = eventsList().filter(function (ev) {
      var end = ev.dateEnd || ev.dateStart;
      if (ev.dateStart > range.end || end < range.start) return false;
      // Respect the global rider picker — an event with riders specified is
      // hidden unless at least one of them is currently selected; an event
      // with no riders assigned yet always shows.
      if (selectedRiders && ev.riders && ev.riders.length) {
        return ev.riders.some(function (r) { return selectedRiders.has(r); });
      }
      return true;
    }).sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0; });
    return renderEventGroupCard('Sorties · ' + calendarNavLabel(), events, { hideGroups: true });
  }

  // Selecting a sortie is a "picking" action — it also syncs selectedCircuit
  // so the Circuit/Chronos/Statistiques tabs stay contextually consistent
  // with whichever sortie is currently active. Closing/clearing sites keep
  // assigning selectedEventId = null directly (there's nothing to sync to).
  function selectEvent(id) {
    selectedEventId = id || null;
    if (id) {
      var ev = eventsList().filter(function (e) { return e.id === id; })[0];
      if (ev) selectedCircuit = ev.circuit;
    }
  }

  // Classifies a sortie against today's date so the Événement tab can group
  // every sortie ever logged — past, ongoing, or upcoming — rather than
  // showing only whichever one happens to be selected.
  function eventTemporalStatus(ev, todayKey) {
    var end = ev.dateEnd || ev.dateStart;
    if (todayKey < ev.dateStart) return 'upcoming';
    if (todayKey > end) return 'past';
    return 'ongoing';
  }

  // A rider isn't locked to one group for the whole sortie -- they can move
  // up or down at the lunch break (matin vs après-midi) or overnight (a
  // fresh choice each day), so this renders one Matin/Après-midi pair of
  // selects per rider per day rather than a single group for the event.
  // "Marc (A), Xavier (B)" -- each rider's day-1 group, as a quick-glance
  // summary for Événements. The full breakdown (which can differ by day or
  // by matin/après-midi) is only in Planning's renderRiderGroupsSection().
  function riderStartGroupsSummary(ev) {
    if (!ev.riders || !ev.riders.length) return '';
    var dates = datesInRange(ev.dateStart, ev.dateEnd);
    if (!dates.length) return '';
    var parts = [];
    ev.riders.forEach(function (rider) {
      var group = riderGroupFor(ev, rider, dates[0], 'matin') || riderGroupFor(ev, rider, dates[0], 'apres-midi');
      parts.push(escapeHtml(rider) + (group ? ' (' + escapeHtml(group) + ')' : ''));
    });
    return parts.join(', ');
  }

  function renderRiderGroupsSection(ev) {
    if (!ev.riders || !ev.riders.length) return '';
    var dates = datesInRange(ev.dateStart, ev.dateEnd);
    if (!dates.length) return '';
    var showDateLabel = dates.length > 1;
    var groupOptions = function (current) {
      var opts = '<option value=""' + (!current ? ' selected' : '') + '>—</option>';
      GROUP_LETTERS.forEach(function (g) {
        opts += '<option value="' + g + '"' + (current === g ? ' selected' : '') + '>' + g + '</option>';
      });
      return opts;
    };
    var html = '<div class="event-checklist">';
    if (ev.riders.length > 1) {
      html += '<label class="rider-group-common"><span>Groupe commun à tous les pilotes</span><select data-common-group data-event-id="' + ev.id + '">' +
        '<option value="" selected>— Choisir pour appliquer à tous —</option>' +
        GROUP_LETTERS.map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('') +
        '</select></label>';
    }
    dates.forEach(function (date) {
      if (showDateLabel) html += '<div class="rider-groups-date-label">' + escapeHtml(formatDate(date)) + '</div>';
      ev.riders.forEach(function (rider) {
        var am = riderGroupFor(ev, rider, date, 'matin');
        var pm = riderGroupFor(ev, rider, date, 'apres-midi');
        html += '<div class="rider-group-row">';
        html += '<span class="rider-group-name">' + escapeHtml(rider) + '</span>';
        html += '<label class="rider-group-field">Matin <select data-rider-group data-event-id="' + ev.id + '" data-rider="' + escapeHtml(rider) + '" data-date="' + date + '" data-period="am">' + groupOptions(am) + '</select></label>';
        html += '<label class="rider-group-field">Après-midi <select data-rider-group data-event-id="' + ev.id + '" data-rider="' + escapeHtml(rider) + '" data-date="' + date + '" data-period="pm">' + groupOptions(pm) + '</select></label>';
        html += '</div>';
      });
    });
    html += '</div>';
    return html;
  }

  function setRiderGroup(eventId, rider, date, period, group) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var ev = eventsList().filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    ev.riderGroups = ev.riderGroups || {};
    ev.riderGroups[rider] = ev.riderGroups[rider] || {};
    ev.riderGroups[rider][date] = ev.riderGroups[rider][date] || {};
    if (group) ev.riderGroups[rider][date][period] = group;
    else delete ev.riderGroups[rider][date][period];
    renderRoot();
    persist(prevState);
  }

  // "Groupe commun à tous les pilotes" -- one click assigns the same group
  // to every rider, every day and both périodes of the sortie at once,
  // instead of clicking through each rider/day/matin-après-midi cell
  // individually when the whole group rides together.
  function applyCommonGroup(eventId, group) {
    if (!group) return;
    var prevState = JSON.parse(JSON.stringify(STATE));
    var ev = eventsList().filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    var dates = datesInRange(ev.dateStart, ev.dateEnd);
    ev.riderGroups = ev.riderGroups || {};
    (ev.riders || []).forEach(function (rider) {
      ev.riderGroups[rider] = ev.riderGroups[rider] || {};
      dates.forEach(function (date) {
        ev.riderGroups[rider][date] = ev.riderGroups[rider][date] || {};
        ev.riderGroups[rider][date].am = group;
        ev.riderGroups[rider][date].pm = group;
      });
    });
    renderRoot();
    persist(prevState);
  }

  // Trims the sortie form's in-memory group draft down to a clean
  // riderGroups object: only riders currently in the form and dates
  // currently within its start/end range, and only am/pm slots that are
  // actually set. Returns null instead of an empty object so a sortie
  // with no groups assigned doesn't carry a pointless riderGroups: {}.
  // existingRiderGroups (the sortie's current riderGroups, when editing one)
  // is carried forward untouched for any rider who already has real
  // per-day/période assignments -- those are fine-tuned in Planning and a
  // sortie edit (changing the date, the note, ...) shouldn't collapse them
  // back to a single uniform group. The "groupe de départ" dropdown only
  // seeds a rider who doesn't have any assignment yet.
  function draftRiderGroupsFor(riders, dateStart, dateEnd, existingRiderGroups) {
    var dates = datesInRange(dateStart, dateEnd);
    var merged = {};
    riders.forEach(function (rider) {
      var existing = (existingRiderGroups || {})[rider];
      if (existing && Object.keys(existing).length) {
        merged[rider] = existing;
        return;
      }
      var startGroup = eventFormDraftGroups[rider] && eventFormDraftGroups[rider].start;
      if (!startGroup) return;
      merged[rider] = {};
      dates.forEach(function (date) { merged[rider][date] = { am: startGroup, pm: startGroup }; });
    });
    var out = {};
    riders.forEach(function (rider) {
      if (!merged[rider]) return;
      dates.forEach(function (date) {
        var slot = merged[rider][date];
        if (!slot) return;
        var clean = {};
        if (slot.am) clean.am = slot.am;
        if (slot.pm) clean.pm = slot.pm;
        if (clean.am || clean.pm) {
          out[rider] = out[rider] || {};
          out[rider][date] = clean;
        }
      });
    });
    return Object.keys(out).length ? out : null;
  }

  function renderEventSummaryCard(ev, opts) {
    opts = opts || {};
    var html = '<div class="card event-detail-card">';
    html += '<div class="event-detail-header"><h3>' + escapeHtml(ev.circuit) + '</h3><button type="button" class="ghost icon-btn" id="close-event-detail" aria-label="Fermer">×</button></div>';
    html += infoRow('Circuit', escapeHtml(ev.circuit));
    html += infoRow('Dates', escapeHtml(formatEventRange(ev, true)));
    html += infoRow('Organisateur', ev.organizer ? escapeHtml(ev.organizer) : '—');
    if (ev.riders && ev.riders.length) html += infoRow('Pilotes', escapeHtml(ev.riders.join(', ')));
    // Just the starting group here, for a quick glance -- the full day-by-
    // jour/matin-après-midi breakdown (and the ability to change it) lives
    // in the Planning tab, so Événements stays simple and informative.
    if (!opts.hideGroups) {
      var groupsSummary = riderStartGroupsSummary(ev);
      if (groupsSummary) html += infoRow('Groupes', groupsSummary);
    }
    if (ev.hotelName || ev.hotelAddress) {
      html += infoRow('Hôtel', [ev.hotelName, ev.hotelAddress].filter(Boolean).map(escapeHtml).join(' — '));
    }
    if (ev.flightOutDep || ev.flightOutArr) {
      html += infoRow('Avion aller', [ev.flightOutDep, ev.flightOutArr].filter(Boolean).join(' → '));
    }
    if (ev.flightBackDep || ev.flightBackArr) {
      html += infoRow('Avion retour', [ev.flightBackDep, ev.flightBackArr].filter(Boolean).join(' → '));
    }
    if (ev.note) html += infoRow('Note', escapeHtml(ev.note));
    // The circuit's own interactive map, so the annotated track is one tap
    // away from the sortie it belongs to, not just reachable from Circuit.
    html += '<div class="event-circuit-map"><div class="event-checklist-title">Carte du circuit</div>' + renderCircuitVisual(circuitInfo(ev.circuit), ev.circuit, ev.id) + '</div>';
    // The équipement checklist (with its count) lives entirely in
    // Planning now -- Événements stays simple and informative.
    html += '<div class="event-detail-actions"><button type="button" class="ghost" id="edit-event-btn" data-id="' + ev.id + '">Modifier</button>' + deleteEventControl(ev.id) + '</div>';
    html += '</div>';
    return html;
  }

  // Each row is its own accordion: clicking it opens its résumé (info,
  // pense-bête, circuit map) right underneath, in place, instead of
  // duplicating it in a summary above the lists. Only one can be open at a
  // time (there's a single selectedEventId), so opening a new row closes
  // whichever was open.
  // One sortie row (+ its accordion panel when open) -- shared by the
  // plain "En cours"/"À venir" lists and the per-year "Passés" bands below,
  // so the row markup and its open/edit behavior stay in exactly one place.
  function renderEventRow(ev, opts) {
    var isOpen = ev.id === selectedEventId;
    var html = '<div class="event-row event-row-toggle' + (isOpen ? ' selected' : '') + '" data-event-id="' + ev.id + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">';
    html += '<div class="event-row-main"><span class="event-row-circuit">' + escapeHtml(ev.circuit) + '</span>';
    // The équipement count lives only in Planning now (with the actual
    // checklist to act on) -- it added nothing here, least of all for a
    // past sortie where it's just a stale "0/43".
    html += '<span class="event-row-dates">' + escapeHtml(formatEventRange(ev)) + '</span></div>';
    html += '<div class="event-row-riders">' + ((ev.riders && ev.riders.length) ? escapeHtml(ev.riders.join(', ')) : 'Pilotes non précisés') + '</div>';
    html += '</div>';
    if (isOpen) {
      html += '<div class="event-accordion-panel">' + ((editingEventId === ev.id) ? renderEventForm() : renderEventSummaryCard(ev, opts)) + '</div>';
    }
    return html;
  }

  function renderEventGroupCard(title, events, opts) {
    var html = '<div class="card events-list-card"><h2 class="section-title">' + escapeHtml(title) + '</h2>';
    if (!events.length) {
      html += '<div class="empty-state">Aucune sortie.</div>';
    } else {
      events.forEach(function (ev) { html += renderEventRow(ev, opts); });
    }
    html += '</div>';
    return html;
  }

  // Which "Passés" year bands are expanded in the Événement tab -- every
  // year starts collapsed (nothing in this map) so a rider with years of
  // history isn't confronted with a giant scrolling list by default; a
  // year only stays open once the rider has actually clicked it open.
  var expandedPastYears = {};

  // Past sorties collapse into one closed band per year (most recent
  // first) instead of one long flat list -- opening a year reveals its
  // sorties in place, same accordion row as everywhere else.
  function renderPastEventsCard(past) {
    var html = '<div class="card events-list-card"><h2 class="section-title">Passés</h2>';
    if (!past.length) {
      html += '<div class="empty-state">Aucune sortie.</div></div>';
      return html;
    }
    var byYear = {};
    past.forEach(function (ev) {
      var year = (ev.dateStart || '').slice(0, 4) || '—';
      byYear[year] = byYear[year] || [];
      byYear[year].push(ev);
    });
    var years = Object.keys(byYear).sort(function (a, b) { return b.localeCompare(a); });
    years.forEach(function (year) {
      var yearEvents = byYear[year];
      var isExpanded = !!expandedPastYears[year];
      html += '<div class="past-year-band">';
      html += '<button type="button" class="past-year-toggle" data-past-year="' + escapeHtml(year) + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '">' +
        '<span class="past-year-chevron">' + (isExpanded ? '▾' : '▸') + '</span>' +
        '<span class="past-year-label">' + escapeHtml(year) + '</span>' +
        '<span class="past-year-count">' + yearEvents.length + ' sortie' + (yearEvents.length > 1 ? 's' : '') + '</span>' +
        '</button>';
      if (isExpanded) {
        html += '<div class="past-year-body">';
        yearEvents.forEach(function (ev) { html += renderEventRow(ev, { hideGroups: false }); });
        html += '</div>';
      }
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  // Événements merges the former separate Calendrier tab in: (1) "En cours"
  // first, only when a sortie's date range actually covers today — no point
  // in a permanent empty section for the common case of nothing running
  // right now; (2) "À venir" then "Passés" (the latter banded by year); (3)
  // "Ajouter un événement", a standing section rather than something you
  // have to leave the tab to reach; (4) the Calendrier grid itself, kept
  // last since it's for browsing dates rather than the day-to-day view.
  function renderEventTab() {
    var all = eventsList();
    var todayKey = dateKey(new Date());
    var ongoing = [], upcoming = [], past = [];
    all.forEach(function (ev) {
      var status = eventTemporalStatus(ev, todayKey);
      if (status === 'ongoing') ongoing.push(ev);
      else if (status === 'upcoming') upcoming.push(ev);
      else past.push(ev);
    });
    ongoing.sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0; });
    upcoming.sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0; });
    past.sort(function (a, b) { return a.dateStart < b.dateStart ? 1 : a.dateStart > b.dateStart ? -1 : 0; });
    var html = '';
    if (!all.length) {
      html += '<div class="card"><div class="empty-state">Aucune sortie enregistrée — ajoutez-en une ci-dessous.</div></div>';
    } else {
      if (ongoing.length) html += renderEventGroupCard('En cours', ongoing);
      html += renderEventGroupCard('À venir', upcoming);
      html += renderPastEventsCard(past);
    }
    html += renderEventForm();
    html += renderCalendarSection();
    return html;
  }

  // ---- Onglet Planning (horaires de la sortie en cours / à venir) ----
  //
  // A trackday's schedule is fixed by the organizer and repeats every
  // group all day -- what actually changes minute to minute is which
  // slot is current. updateLiveClock() (below, run on an interval) patches
  // the current/next/past classes on these DOM nodes directly rather than
  // going through renderRoot(), so it never blows away an open form
  // elsewhere on the page.
  //
  // Groups are shown as independent columns, each with its own list of
  // slots -- NOT merged onto one shared timeline. A first attempt merged
  // every group onto one "heure en ligne" table, but groups routinely
  // break for lunch at different times (up to 1h apart between a fast
  // group and a slow one), which made a shared timeline mostly empty
  // cells and auto-detected pause rows that didn't line up with what any
  // single group actually experienced.
  function parseHoraireToken(tok) {
    var m = tok.match(/^(\d{1,2})h(\d{2})?\s*(?:[-–à]\s*(\d{1,2})h(\d{2})?)?$/i);
    if (!m) return null;
    var start = parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
    var end = m[3] != null
      ? parseInt(m[3], 10) * 60 + (m[4] ? parseInt(m[4], 10) : 0)
      : start + 20; // no end given -- Le Mans/Carole's sessions are 20 min
    return { start: start, end: end };
  }

  function parseHoraireLine(line) {
    return (line || '').split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (tok) {
      var parsed = parseHoraireToken(tok);
      return { label: tok, start: parsed ? parsed.start : null, end: parsed ? parsed.end : null };
    });
  }

  // Every rider assigned to a group letter (A-D) at any point of the
  // sortie -- riderGroups is per-day/per-période, but the horaires display
  // is for the whole sortie, so a rider who's in Groupe B on any day/demi-
  // journée shows up under Groupe B.
  function ridersInGroup(ev, letter) {
    var rg = (ev && ev.riderGroups) || {};
    return Object.keys(rg).filter(function (rider) {
      var byDate = rg[rider] || {};
      return Object.keys(byDate).some(function (d) { return byDate[d].am === letter || byDate[d].pm === letter; });
    }).sort();
  }

  // allowedKeys: null/undefined shows every group that has horaires; an
  // array restricts to just those keys (the Planning tab's checkboxes).
  // ev (optional) lets us list which riders are assigned to each group.
  function renderHoraireGroups(horaires, allowedKeys, ev) {
    var groups = HORAIRES_GROUPS.filter(function (g) {
      return horaires[g.key] && (!allowedKeys || allowedKeys.indexOf(g.key) !== -1);
    });
    if (!groups.length) return '';
    var html = '<div class="today-schedule-groups">';
    groups.forEach(function (g) {
      html += '<div class="today-schedule-group"><div class="today-schedule-group-label">' + escapeHtml(g.label) + '</div>';
      if (ev) {
        var letter = g.key.replace('group', '');
        var names = ridersInGroup(ev, letter);
        if (names.length) {
          html += '<div class="today-schedule-group-riders">' + names.map(escapeHtml).join(', ') + '</div>';
        }
      }
      html += '<div class="today-schedule-slots">';
      parseHoraireLine(horaires[g.key]).forEach(function (slot) {
        if (slot.start == null) {
          html += '<span class="schedule-slot schedule-slot-label">' + escapeHtml(slot.label) + '</span>';
        } else {
          html += '<span class="schedule-slot" data-slot-start="' + slot.start + '" data-slot-end="' + slot.end + '">' + escapeHtml(slot.label) + '</span>';
        }
      });
      html += '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function checklistCountLabel(ev) {
    var allItems = checklistAllItems();
    if (!allItems.length) return 'Équipement (pense-bête)';
    var checklist = ev.checklist || {};
    var done = allItems.filter(function (item) { return checklist[item.id]; }).length;
    return 'Équipement (pense-bête) — ' + done + '/' + allItems.length;
  }

  // The full, editable, categorized pense-bête -- any rider can check an
  // item for this sortie, add/remove an item within a category, or add/
  // remove a whole category, straight from Planning.
  function renderPlanningChecklist(ev) {
    var tpl = checklistTemplate();
    var checklist = ev.checklist || {};
    var admin = isAdmin();
    var html = '<div class="event-checklist planning-checklist">';
    tpl.categories.forEach(function (cat) {
      var isPendingDelete = pendingDeleteChecklistCategory === cat.id;
      var doneInCat = cat.items.filter(function (item) { return checklist[item.id]; }).length;
      var catKey = 'cat-' + cat.id;
      var open = planningSectionsOpen[catKey] ? ' open' : '';
      html += '<details class="checklist-category" data-planning-section="' + catKey + '"' + open + '>';
      html += '<summary><span class="checklist-category-name">' + escapeHtml(cat.name) + ' — ' + doneInCat + '/' + cat.items.length + '</span>';
      // Deleting a whole category is admin-only (see isAdmin()) -- it
      // removes every item other riders may already rely on. Adding is
      // still open to anyone, right below.
      if (admin) {
        html += '<button type="button" class="ghost icon-btn' + (isPendingDelete ? ' confirm' : '') + '" data-action="remove-checklist-category" data-category="' + cat.id + '" aria-label="Supprimer la catégorie ' + escapeHtml(cat.name) + '" title="Supprimer la catégorie">' + (isPendingDelete ? '✓' : '×') + '</button>';
      }
      html += '</summary>';
      html += '<div class="planning-section-body">';
      cat.items.forEach(function (item) {
        var checked = !!checklist[item.id];
        // The remove button is a sibling of the <label>, not nested inside
        // it -- a button nested in a checkbox's <label> gets its click
        // forwarded to the checkbox by the browser, toggling it as an
        // unwanted side effect of removing the item.
        html += '<div class="checklist-item-row">' +
          '<label class="checklist-item"><input type="checkbox" data-checklist-key="' + item.id + '" data-event-id="' + ev.id + '"' + (checked ? ' checked' : '') + '> ' + escapeHtml(item.label) + '</label>' +
          (admin ? '<button type="button" class="ghost icon-btn checklist-item-remove" data-action="remove-checklist-item" data-category="' + cat.id + '" data-item="' + item.id + '" aria-label="Retirer ' + escapeHtml(item.label) + '" title="Retirer">×</button>' : '') +
          '</div>';
      });
      html += '<form class="checklist-add-item-form" data-add-item-category="' + cat.id + '">' +
        '<input type="text" placeholder="+ ajouter un objet" data-new-item-input>' +
        '<button type="submit" class="ghost">Ajouter</button></form>';
      html += '</div></details>';
    });
    html += '<form id="add-checklist-category-form" class="checklist-add-category-form">' +
      '<input type="text" id="new-checklist-category" placeholder="+ nouvelle catégorie">' +
      '<button type="submit" class="ghost">Ajouter</button></form>';
    html += '</div>';
    return html;
  }

  // The sortie the Planning tab leads with: today's if one is running,
  // else the soonest upcoming one, so there's always something useful to
  // look at instead of an empty gap between outings.
  function targetPlanningEvent() {
    var all = eventsList();
    var todayKey = dateKey(new Date());
    var ongoing = all.filter(function (ev) { return eventTemporalStatus(ev, todayKey) === 'ongoing'; })
      .sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : 1; });
    if (ongoing.length) return { ev: ongoing[0], mode: 'ongoing' };
    var upcoming = all.filter(function (ev) { return eventTemporalStatus(ev, todayKey) === 'upcoming'; })
      .sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : 1; });
    if (upcoming.length) return { ev: upcoming[0], mode: 'upcoming' };
    return null;
  }

  // Collapsed by default -- Planning got long once horaires, group
  // assignment and the equipment checklist all landed here, so each big
  // section is a native <details> a rider opens only when they need it.
  // Open/closed state is tracked here (not just left to the browser)
  // because renderRoot() rebuilds this markup from scratch on every
  // change -- without this a <details> would snap shut the moment you
  // ticked a checkbox inside it.
  var planningSectionsOpen = {};
  function collapsibleSection(key, title, innerHtml) {
    if (!innerHtml) return '';
    var open = planningSectionsOpen[key] ? ' open' : '';
    return '<details class="planning-section" data-planning-section="' + key + '"' + open + '><summary>' + escapeHtml(title) + '</summary><div class="planning-section-body">' + innerHtml + '</div></details>';
  }

  function renderPlanningTab() {
    var target = targetPlanningEvent();
    if (!target) {
      return '<div class="card"><div class="empty-state">Aucune sortie en cours ou à venir — planifiez-en une dans l\'onglet Événements.</div></div>';
    }
    var ev = target.ev, isOngoing = target.mode === 'ongoing';
    // Read by updateLiveClock() so it knows whether "now" actually falls
    // within this sortie -- a session's time-of-day only means "in
    // progress"/"past" today; for a sortie weeks away the countdown should
    // read in days, not compare today's clock against Jerez's 10h.
    planningIsOngoing = isOngoing;
    planningEventDateStart = ev.dateStart;
    planningEventId = ev.id;
    var info = circuitInfo(ev.circuit);
    var horaires = info.horaires;

    var html = '<div class="card today-schedule-card">';
    html += '<div class="eyebrow">' + (isOngoing ? 'En ce moment — ' : 'Prochaine sortie — ') + escapeHtml(ev.circuit) + '</div>';
    var sub = [];
    if (!isOngoing) sub.push(escapeHtml(formatEventRange(ev, true)) + ' (' + weekdayName(ev.dateStart) + ')');
    if (info.organizer) sub.push('Organisateur ' + escapeHtml(info.organizer));
    if (info.briefing) sub.push('Briefing ' + escapeHtml(info.briefing));
    if (sub.length) html += '<div class="help-text">' + sub.join(' · ') + '</div>';

    if (ev.hotelName || ev.hotelAddress) {
      html += '<div class="help-text">Hôtel : ' + [ev.hotelName, ev.hotelAddress].filter(Boolean).map(escapeHtml).join(' — ') + '</div>';
    }
    if (ev.flightOutDep || ev.flightOutArr) {
      html += '<div class="help-text">Avion aller : ' + escapeHtml([ev.flightOutDep, ev.flightOutArr].filter(Boolean).join(' → ')) + '</div>';
    }
    if (ev.flightBackDep || ev.flightBackArr) {
      html += '<div class="help-text">Avion retour : ' + escapeHtml([ev.flightBackDep, ev.flightBackArr].filter(Boolean).join(' → ')) + '</div>';
    }

    var availableGroups = horaires ? HORAIRES_GROUPS.filter(function (g) { return horaires[g.key]; }) : [];
    if (!availableGroups.length) {
      html += '<div class="help-text">Aucun horaire enregistré pour ' + escapeHtml(ev.circuit) + ' — ajoutez-les depuis l\'onglet Circuit (Modifier les infos).</div>';
      html += collapsibleSection('groupes', 'Groupes par pilote', renderRiderGroupsSection(ev));
      html += collapsibleSection('equipement', checklistCountLabel(ev), renderPlanningChecklist(ev));
      return html + '</div>';
    }

    var activeKeys = (planningGroupFilter && planningGroupFilter.length)
      ? planningGroupFilter.filter(function (k) { return availableGroups.some(function (g) { return g.key === k; }); })
      : availableGroups.map(function (g) { return g.key; });
    if (!activeKeys.length) activeKeys = availableGroups.map(function (g) { return g.key; });

    html += '<div id="planning-countdown" class="planning-countdown"></div>';

    var horairesInner = '<div class="planning-group-filter">';
    availableGroups.forEach(function (g) {
      var checked = activeKeys.indexOf(g.key) !== -1;
      horairesInner += '<label class="planning-group-check"><input type="checkbox" data-planning-group="' + g.key + '"' + (checked ? ' checked' : '') + '> ' + escapeHtml(g.label) + '</label>';
    });
    horairesInner += '</div>';
    horairesInner += renderHoraireGroups(horaires, activeKeys, ev);
    html += collapsibleSection('horaires', 'Horaires', horairesInner);
    html += collapsibleSection('groupes', 'Groupes par pilote', renderRiderGroupsSection(ev));
    html += collapsibleSection('equipement', checklistCountLabel(ev), renderPlanningChecklist(ev));
    return html + '</div>';
  }

  // Fires a browser notification once, when a rider the current account
  // cares about is about to go out (<=10 min) and notifications are
  // opted-in from "Mon profil". A pilote is notified about their own
  // group; an accompagnant is notified about whichever of their followed
  // riders is about to leave. Only works while this tab stays open --
  // there's no backend on GitHub Pages to push a real notification once
  // the app is closed.
  function maybeNotifyGroupDeparture(nextStart, diff, nextGroupLabels) {
    if (!currentUserProfile || !currentUserProfile.notifyBeforeSession) return;
    if (!window.Notification || Notification.permission !== 'granted') return;
    if (diff > 10 || diff < 0) return;
    var ev = eventsList().filter(function (e) { return e.id === planningEventId; })[0];
    if (!ev) return;
    var namesToWatch = currentUserProfile.role === 'accompagnant'
      ? (currentUserProfile.followedRiders || [])
      : [currentUserProfile.name];
    if (!namesToWatch.length) return;
    var departingNames = ridersForGroupLabels(ev, nextGroupLabels).filter(function (name) {
      return namesToWatch.indexOf(name) !== -1;
    });
    if (!departingNames.length) return;
    var slotKey = planningEventId + '-' + nextStart;
    if (notifiedSlotKey === slotKey) return;
    notifiedSlotKey = slotKey;
    var subject = currentUserProfile.role === 'accompagnant'
      ? departingNames.join(', ') + ' part' + (departingNames.length > 1 ? 'ent' : '') + ' rouler'
      : 'Ton groupe part rouler';
    new Notification('Carnet de Piste', { body: subject + ' dans ' + diff + ' min !' });
  }

  // The group label(s) attached to the earliest data-slot-start currently
  // in the DOM, and among those matching, the group letter itself. Shared
  // by both the "dans X jours" and "prochaine session dans" countdowns so
  // only the group that actually leaves first is ever shown, not every
  // group running that day.
  function earliestScheduleGroupLabels(minStart) {
    var labels = [];
    document.querySelectorAll('[data-slot-start="' + minStart + '"]').forEach(function (el) {
      var groupContainer = el.closest('.today-schedule-group');
      var labelEl = groupContainer && groupContainer.querySelector('.today-schedule-group-label');
      if (labelEl && labels.indexOf(labelEl.textContent) === -1) labels.push(labelEl.textContent);
    });
    return labels;
  }

  function ridersForGroupLabels(ev, labels) {
    var names = [];
    HORAIRES_GROUPS.filter(function (g) { return labels.indexOf(g.label) !== -1; }).forEach(function (g) {
      ridersInGroup(ev, g.key.replace('group', '')).forEach(function (name) {
        if (names.indexOf(name) === -1) names.push(name);
      });
    });
    return names.sort();
  }

  function countdownHtml(prefix, groupLabels, riderNames) {
    var html = escapeHtml(prefix);
    if (groupLabels.length) html += ' — ' + escapeHtml(groupLabels.join(', '));
    if (riderNames.length) html += ' <span class="planning-countdown-riders">' + riderNames.map(escapeHtml).join(', ') + '</span>';
    return html;
  }

  function updateLiveClock() {
    var clockEl = document.getElementById('live-clock');
    if (clockEl) {
      var now = new Date();
      clockEl.textContent = pad2(now.getHours()) + 'h' + pad2(now.getMinutes());
    }
    var countdownEl = document.getElementById('planning-countdown');
    // Session times are only "current"/"past" relative to today's clock if
    // today actually falls within the sortie -- for a sortie that's still
    // weeks away, every slot would otherwise look "past" the moment its
    // time-of-day ticks by today, which is meaningless.
    if (!planningIsOngoing) {
      document.querySelectorAll('[data-slot-start]').forEach(function (el) {
        el.classList.remove('slot-current', 'slot-next', 'slot-past');
      });
      if (countdownEl) {
        if (planningEventDateStart) {
          var days = Math.round((parseLocalDate(planningEventDateStart) - parseLocalDate(dateKey(new Date()))) / 86400000);
          var dayText = days === 1 ? 'Dans 1 jour' : 'Dans ' + days + ' jours';
          var minStartUp = null;
          document.querySelectorAll('[data-slot-start]').forEach(function (el) {
            var start = parseInt(el.getAttribute('data-slot-start'), 10);
            if (minStartUp == null || start < minStartUp) minStartUp = start;
          });
          var groupLabelsUp = minStartUp == null ? [] : earliestScheduleGroupLabels(minStartUp);
          var evUp = eventsList().filter(function (e) { return e.id === planningEventId; })[0];
          var riderNamesUp = evUp ? ridersForGroupLabels(evUp, groupLabelsUp) : [];
          countdownEl.innerHTML = countdownHtml(dayText, groupLabelsUp, riderNamesUp);
        } else {
          countdownEl.textContent = '';
        }
      }
      return;
    }
    var nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    var seenNext = false;
    var nextStart = null;
    document.querySelectorAll('[data-slot-start]').forEach(function (el) {
      var start = parseInt(el.getAttribute('data-slot-start'), 10);
      var end = parseInt(el.getAttribute('data-slot-end'), 10);
      el.classList.remove('slot-current', 'slot-next', 'slot-past');
      if (nowMinutes >= start && nowMinutes < end) {
        el.classList.add('slot-current');
      } else if (nowMinutes < start) {
        if (!seenNext) { el.classList.add('slot-next'); seenNext = true; }
        if (nextStart == null || start < nextStart) nextStart = start;
      } else {
        el.classList.add('slot-past');
      }
    });
    if (countdownEl) {
      if (nextStart == null) {
        countdownEl.textContent = '';
      } else {
        var diff = nextStart - nowMinutes;
        var nextGroupLabels = earliestScheduleGroupLabels(nextStart);
        var evNext = eventsList().filter(function (e) { return e.id === planningEventId; })[0];
        var nextRiderNames = evNext ? ridersForGroupLabels(evNext, nextGroupLabels) : [];
        var prefix = 'Prochaine session dans ' + (diff >= 60 ? (Math.floor(diff / 60) + 'h' + pad2(diff % 60)) : (diff + ' min'));
        countdownEl.innerHTML = countdownHtml(prefix, nextGroupLabels, nextRiderNames);
        maybeNotifyGroupDeparture(nextStart, diff, nextGroupLabels);
      }
    }
  }

  // Same grid as renderRiderGroupsSection (Matin/Après-midi per rider per
  // day, plus a "groupe commun" shortcut), but reading/writing the form's
  // in-memory draft instead of a saved event's ev.riderGroups -- riders and
  // dates typed into the form aren't a real sortie yet, so there's nothing
  // to key setRiderGroup() off of until Enregistrer is pressed.
  // Just one "groupe de départ" per rider here -- the day-by-day/matin-
  // après-midi breakdown (which can differ if someone switches group at
  // lunch, or from one day to the next) is edited in the Planning tab
  // instead, on the saved sortie. This starting group only seeds that
  // breakdown uniformly when the sortie is created/saved (see
  // draftRiderGroupsFor); it doesn't try to represent it in full.
  function renderEventFormGroupsGrid(riders) {
    if (!riders.length) return '<div class="help-text">Ajoutez au moins un pilote pour lui assigner un groupe de départ.</div>';
    var groupOptions = function (current) {
      var opts = '<option value=""' + (!current ? ' selected' : '') + '>—</option>';
      GROUP_LETTERS.forEach(function (g) {
        opts += '<option value="' + g + '"' + (current === g ? ' selected' : '') + '>' + g + '</option>';
      });
      return opts;
    };
    var html = '<div class="rider-start-groups">';
    riders.forEach(function (rider) {
      var current = (eventFormDraftGroups[rider] && eventFormDraftGroups[rider].start) || '';
      html += '<label class="rider-group-field"><span class="rider-group-name">' + escapeHtml(rider) + '</span>' +
        '<select data-form-start-group data-rider="' + escapeHtml(rider) + '">' + groupOptions(current) + '</select></label>';
    });
    html += '</div>';
    return html;
  }

  // Reads the riders currently typed into the open form and regenerates
  // just the groups grid from the draft -- called whenever that field
  // changes, without touching (or losing in-progress input in) the rest
  // of the form.
  function refreshEventFormGroups() {
    var grid = document.getElementById('ev-groups-grid');
    if (!grid) return;
    var ridersEl = document.getElementById('ev-riders');
    var riders = ridersEl ? ridersEl.value.split(',').map(function (r) { return r.trim(); }).filter(Boolean) : [];
    grid.innerHTML = renderEventFormGroupsGrid(riders);
    attachEventFormGroupHandlers();
  }

  function attachEventFormGroupHandlers() {
    document.querySelectorAll('#ev-groups-grid select[data-form-start-group]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var rider = sel.getAttribute('data-rider');
        eventFormDraftGroups[rider] = sel.value ? { start: sel.value } : {};
      });
    });
  }

  function renderEventForm() {
    if (editingEventId === null) {
      eventFormDraftGroupsFor = null;
      return '<div class="card add-event-card"><h2 class="section-title">Ajouter un événement</h2><button type="button" class="primary" id="add-event-btn">+ Ajouter une sortie</button></div>';
    }
    var isNew = editingEventId === 'new';
    var ev = isNew ? { circuit: prefillEventCircuit || '' } : (eventsList().filter(function (e) { return e.id === editingEventId; })[0] || {});
    // A new sortie starts from its circuit's usual organizer (set via
    // Circuit > Modifier les infos) -- the organizer is normally the same
    // every time, so re-typing it per sortie would be pure friction.
    // Horaires themselves aren't edited here at all anymore -- Planning
    // reads them straight from the circuit.
    if (isNew && ev.circuit) {
      var circuitDefaults = circuitInfo(ev.circuit);
      if (circuitDefaults.organizer) ev.organizer = circuitDefaults.organizer;
    }
    // The draft starts from each rider's day-1 group when editing an
    // existing sortie (just a representative "groupe de départ", not the
    // full day-by-day breakdown -- that's edited in Planning), or empty
    // for a new one. Only re-seeds when editingEventId itself changes, so
    // it isn't wiped on every keystroke.
    if (eventFormDraftGroupsFor !== editingEventId) {
      var seedGroups = {};
      Object.keys(ev.riderGroups || {}).forEach(function (rider) {
        var riderDates = Object.keys(ev.riderGroups[rider]).sort();
        var firstDate = riderDates[0];
        var start = firstDate && (ev.riderGroups[rider][firstDate].am || ev.riderGroups[rider][firstDate].pm);
        if (start) seedGroups[rider] = { start: start };
      });
      eventFormDraftGroups = seedGroups;
      eventFormDraftGroupsFor = editingEventId;
    }
    var html = '<div class="card">';
    html += '<h2 class="section-title">' + (isNew ? 'Ajouter une sortie' : 'Modifier la sortie') + '</h2>';
    html += '<form id="event-form" novalidate>';
    html += '<div class="field-row">';
    html += '<div><label for="ev-circuit">Circuit</label>' +
      '<input type="text" id="ev-circuit" list="circuit-options-ev" placeholder="Ex. Jerez" value="' + escapeHtml(ev.circuit || '') + '" required>' +
      '<datalist id="circuit-options-ev">' + circuitDatalist() + '</datalist></div>';
    html += '<div><label for="ev-date-start">Date de début</label><input type="text" id="ev-date-start" inputmode="numeric" placeholder="JJ/MM/AAAA" value="' + isoToFrDate(ev.dateStart) + '" required></div>';
    html += '<div><label for="ev-date-end">Date de fin (optionnel)</label><input type="text" id="ev-date-end" inputmode="numeric" placeholder="JJ/MM/AAAA" value="' + isoToFrDate(ev.dateEnd) + '"></div>';
    html += '<div><label for="ev-organizer">Organisateur</label><input type="text" id="ev-organizer" placeholder="Ex. MT95" value="' + escapeHtml(ev.organizer || '') + '"></div>';
    html += '</div>';
    // Horaires live on the circuit (shared across every sortie there, see
    // renderCircuitInfoEditForm), but any pilote creating a sortie can set
    // them here too instead of having to detour through l'onglet Circuit --
    // handy the first time a circuit is used, or when the organiser
    // announces new créneaux.
    var evHorairesVal = (ev.circuit && circuitInfo(ev.circuit).horaires) || {};
    html += '<div style="margin-top:0.9rem;"><label>Horaires par groupe</label><div class="horaires-grid">';
    HORAIRES_GROUPS.forEach(function (g) {
      if (g.key === 'groupR' && ev.circuit !== 'Mugello' && !evHorairesVal.groupR) return;
      html += '<div><label for="ev-horaires-' + g.key + '" class="horaires-sublabel">' + escapeHtml(g.label) + '</label>' +
        '<input type="text" id="ev-horaires-' + g.key + '" placeholder="Ex. 9h, 10h40, 14h, 15h20, 16h40" value="' + escapeHtml(evHorairesVal[g.key] || '') + '"></div>';
    });
    html += '</div></div>';
    html += '<label for="ev-riders" style="margin-top:0.9rem; display:block;">Pilotes (séparés par une virgule)</label>' +
      '<input type="text" id="ev-riders" list="rider-options-ev" placeholder="Ex. Marc, Xavier" value="' + escapeHtml((ev.riders || []).join(', ')) + '">' +
      '<datalist id="rider-options-ev">' + riderDatalist() + '</datalist>';
    html += '<div class="event-checklist" style="margin-top:0.9rem;"><div class="event-checklist-title">Groupe de départ</div><div id="ev-groups-grid">' +
      renderEventFormGroupsGrid(ev.riders || []) + '</div></div>';
    html += '<div style="margin-top:0.9rem;"><label for="ev-note">Note (optionnel)</label><input type="text" id="ev-note" placeholder="Ex. Inscriptions avant le 1er septembre" value="' + escapeHtml(ev.note || '') + '"></div>';
    html += '<div class="field-row" style="margin-top:0.9rem;">';
    html += '<div><label for="ev-hotel-name">Hôtel — nom</label><input type="text" id="ev-hotel-name" placeholder="Ex. Ibis Le Mans" value="' + escapeHtml(ev.hotelName || '') + '"></div>';
    html += '<div><label for="ev-hotel-address">Hôtel — adresse</label><input type="text" id="ev-hotel-address" placeholder="Ex. 12 rue de la Sarthe, 72100 Le Mans" value="' + escapeHtml(ev.hotelAddress || '') + '"></div>';
    html += '</div>';
    html += '<label style="margin-top:0.9rem; display:block;">Avion</label>';
    html += '<div class="field-row">';
    html += '<div><label for="ev-flight-out-dep" class="horaires-sublabel">Aller — départ</label><input type="text" id="ev-flight-out-dep" placeholder="Ex. 6h40" value="' + escapeHtml(ev.flightOutDep || '') + '"></div>';
    html += '<div><label for="ev-flight-out-arr" class="horaires-sublabel">Aller — arrivée</label><input type="text" id="ev-flight-out-arr" placeholder="Ex. 8h15" value="' + escapeHtml(ev.flightOutArr || '') + '"></div>';
    html += '<div><label for="ev-flight-back-dep" class="horaires-sublabel">Retour — départ</label><input type="text" id="ev-flight-back-dep" placeholder="Ex. 18h00" value="' + escapeHtml(ev.flightBackDep || '') + '"></div>';
    html += '<div><label for="ev-flight-back-arr" class="horaires-sublabel">Retour — arrivée</label><input type="text" id="ev-flight-back-arr" placeholder="Ex. 19h35" value="' + escapeHtml(ev.flightBackArr || '') + '"></div>';
    html += '</div>';
    html += '<div class="field-error" id="event-form-error"></div>';
    html += '<div style="margin-top:0.9rem; display:flex; gap:0.6rem;">' +
      '<button type="submit" class="primary">Enregistrer</button>' +
      '<button type="button" class="ghost" id="cancel-event-btn">Annuler</button>' +
      '</div>';
    html += '</form></div>';
    return html;
  }

  function onEventSubmit(ev) {
    ev.preventDefault();
    var circuit = document.getElementById('ev-circuit').value.trim();
    var dateStartRaw = document.getElementById('ev-date-start').value;
    var dateEndRawInput = document.getElementById('ev-date-end').value;
    var dateStart = frDateToIso(dateStartRaw);
    var organizer = document.getElementById('ev-organizer').value.trim();
    var ridersRaw = document.getElementById('ev-riders').value;
    var note = document.getElementById('ev-note').value.trim();
    var errEl = document.getElementById('event-form-error');
    errEl.textContent = '';
    errEl.classList.remove('visible');

    if (dateStartRaw.trim() && !dateStart) {
      errEl.textContent = 'Date de début invalide — format attendu JJ/MM/AAAA.';
      errEl.classList.add('visible');
      return;
    }
    if (dateEndRawInput.trim() && !frDateToIso(dateEndRawInput)) {
      errEl.textContent = 'Date de fin invalide — format attendu JJ/MM/AAAA.';
      errEl.classList.add('visible');
      return;
    }
    if (!circuit || !dateStart) {
      errEl.textContent = 'Le circuit et la date de début sont obligatoires.';
      errEl.classList.add('visible');
      return;
    }
    var dateEndRaw = frDateToIso(dateEndRawInput);
    var dateEnd = dateEndRaw || dateStart;
    if (dateEnd < dateStart) {
      errEl.textContent = 'La date de fin doit être après la date de début.';
      errEl.classList.add('visible');
      return;
    }
    var riders = ridersRaw.split(',').map(function (r) { return r.trim(); }).filter(Boolean);
    var horairesFromForm = {};
    var anyHoraireFromForm = false;
    HORAIRES_GROUPS.forEach(function (g) {
      var el = document.getElementById('ev-horaires-' + g.key);
      var v = el ? el.value.trim() : '';
      if (v) { horairesFromForm[g.key] = v; anyHoraireFromForm = true; }
    });
    var hotelName = document.getElementById('ev-hotel-name').value.trim();
    var hotelAddress = document.getElementById('ev-hotel-address').value.trim();
    var flightOutDep = document.getElementById('ev-flight-out-dep').value.trim();
    var flightOutArr = document.getElementById('ev-flight-out-arr').value.trim();
    var flightBackDep = document.getElementById('ev-flight-back-dep').value.trim();
    var flightBackArr = document.getElementById('ev-flight-back-arr').value.trim();

    // Trim the form's draft down to riders still in the field and dates
    // still within range -- a rider removed from the field, or a date
    // dropped by shortening the range, shouldn't leave orphaned group data
    // behind in the saved sortie. Existing per-day/période assignments
    // (fine-tuned in Planning) are carried forward, not reset.
    var existingForGroups = editingEventId !== 'new'
      ? (STATE.events.filter(function (e) { return e.id === editingEventId; })[0] || {}).riderGroups
      : null;
    var riderGroups = draftRiderGroupsFor(riders, dateStart, dateEnd, existingForGroups);

    var prevState = JSON.parse(JSON.stringify(STATE));
    eventsList();
    if (editingEventId === 'new') {
      var newEvent = { id: genId(), circuit: circuit, dateStart: dateStart, dateEnd: dateEnd, riders: riders, organizer: organizer, note: note };
      if (riderGroups) newEvent.riderGroups = riderGroups;
      if (hotelName) newEvent.hotelName = hotelName;
      if (hotelAddress) newEvent.hotelAddress = hotelAddress;
      if (flightOutDep) newEvent.flightOutDep = flightOutDep;
      if (flightOutArr) newEvent.flightOutArr = flightOutArr;
      if (flightBackDep) newEvent.flightBackDep = flightBackDep;
      if (flightBackArr) newEvent.flightBackArr = flightBackArr;
      STATE.events.push(newEvent);
      selectedEventId = newEvent.id;
    } else {
      var existing = STATE.events.filter(function (e) { return e.id === editingEventId; })[0];
      if (existing) {
        existing.circuit = circuit;
        existing.dateStart = dateStart;
        existing.dateEnd = dateEnd;
        existing.riders = riders;
        existing.organizer = organizer;
        existing.note = note;
        existing.autoCreated = false; // a manual edit means it's no longer just a byproduct of a chrono
        // checklist isn't touched here -- it's checked off in Planning, not the sortie form.
        existing.riderGroups = riderGroups || null; // never `undefined` -- Firestore rejects that as a field value
        existing.hotelName = hotelName || null;
        existing.hotelAddress = hotelAddress || null;
        existing.flightOutDep = flightOutDep || null;
        existing.flightOutArr = flightOutArr || null;
        existing.flightBackDep = flightBackDep || null;
        existing.flightBackArr = flightBackArr || null;
        selectedEventId = existing.id;
      }
    }
    if (anyHoraireFromForm) {
      STATE.circuits = STATE.circuits || {};
      var circuitEntry = STATE.circuits[circuit] || {};
      circuitEntry.horaires = Object.assign({}, circuitEntry.horaires || {}, horairesFromForm);
      STATE.circuits[circuit] = circuitEntry;
    }
    selectedCircuit = circuit;
    calendarAnchor = dateStart;
    editingEventId = null;
    prefillEventCircuit = null;
    renderRoot();
    persist(prevState);
  }

  function toggleEventChecklist(eventId, key, value) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var ev = eventsList().filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    ev.checklist = ev.checklist || {};
    ev.checklist[key] = value;
    renderRoot();
    persist(prevState);
  }

  function removeEvent(id) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.events = eventsList().filter(function (e) { return e.id !== id; });
    if (selectedEventId === id) selectedEventId = null;
    if (editingEventId === id) editingEventId = null;
    renderRoot();
    persist(prevState);
  }

  // ---- Calendrier : pincer/molette pour zoomer, glisser/flèches pour naviguer ----
  //
  // Registered once on `document` (not re-attached per render) so a gesture
  // survives the renderRoot() that happens mid-gesture when the view
  // actually changes — attaching to `.calendar-grid-card` itself would
  // lose the in-flight pointermove/pointerup once that element gets
  // replaced. Each handler scopes itself with closest('.calendar-grid-card').
  var calendarPinchPointers = new Map();
  var calendarPinchStartDist = null;
  var calendarSwipeStart = null; // {x, y} — only set while exactly one touch/pen pointer is down

  function onCalendarPointerDown(e) {
    if (!e.target.closest || !e.target.closest('.calendar-grid-card')) return;
    calendarPinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (calendarPinchPointers.size === 1 && e.pointerType !== 'mouse') {
      calendarSwipeStart = { x: e.clientX, y: e.clientY };
    } else {
      // A second finger landed (pinch) or this is a mouse pointer — not a swipe.
      calendarSwipeStart = null;
    }
    if (calendarPinchPointers.size === 2) {
      var pts = Array.from(calendarPinchPointers.values());
      calendarPinchStartDist = annotDistance(pts[0], pts[1]);
    }
  }

  function onCalendarPointerMove(e) {
    if (!calendarPinchPointers.has(e.pointerId)) return;
    calendarPinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (calendarPinchPointers.size === 2 && calendarPinchStartDist != null) {
      e.preventDefault();
      var pts = Array.from(calendarPinchPointers.values());
      var dist = annotDistance(pts[0], pts[1]);
      var ratio = dist / (calendarPinchStartDist || 1);
      if (ratio > 1.3) {
        calendarPinchStartDist = dist;
        if (calendarZoomStep(1)) renderRoot();
      } else if (ratio < 1 / 1.3) {
        calendarPinchStartDist = dist;
        if (calendarZoomStep(-1)) renderRoot();
      }
    }
  }

  // One-finger horizontal swipe on the calendar grid moves to the
  // previous/next period (same as the ‹ › buttons or the ← → keys) —
  // swipe left reveals what's next, swipe right goes back, matching how a
  // native calendar app (or a book page) responds to a horizontal drag.
  var CALENDAR_SWIPE_THRESHOLD = 50;

  function onCalendarPointerUp(e) {
    if (calendarSwipeStart && calendarPinchPointers.size === 1 && calendarPinchPointers.has(e.pointerId)) {
      var dx = e.clientX - calendarSwipeStart.x;
      var dy = e.clientY - calendarSwipeStart.y;
      if (Math.abs(dx) > CALENDAR_SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
        calendarNavStep(dx < 0 ? 1 : -1);
        renderRoot();
      }
    }
    calendarPinchPointers.delete(e.pointerId);
    if (calendarPinchPointers.size < 2) calendarPinchStartDist = null;
    if (calendarPinchPointers.size === 0) calendarSwipeStart = null;
  }

  // Trackpad pinch-to-zoom is delivered by the browser as a wheel event with
  // ctrlKey set — that's the only wheel interaction we hijack, so a normal
  // two-finger scroll over the calendar still scrolls the page as expected.
  function onCalendarWheel(e) {
    if (!e.ctrlKey) return;
    if (!e.target.closest || !e.target.closest('.calendar-grid-card')) return;
    e.preventDefault();
    if (calendarZoomStep(e.deltaY < 0 ? 1 : -1)) renderRoot();
  }

  // ← → move to the previous/next period whenever the Événements tab (which
  // now includes the Calendrier section) is showing, unless the user is
  // typing somewhere (a form field, a name…).
  function onCalendarKeydown(e) {
    if (activeView !== 'event') return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    calendarNavStep(e.key === 'ArrowLeft' ? -1 : 1);
    renderRoot();
  }

  function subtitleForView(view) {
    if (view === 'circuit') return 'Le plan du circuit, ses infos et vos chronos.';
    if (view === 'stats') return 'L’historique et les records du pilote.';
    if (view === 'planning') return 'Les horaires de la sortie en cours ou à venir.';
    return 'Vos sorties, leur calendrier, et comment en ajouter une.';
  }

  // ---- Thème clair / sombre ----
  //
  // Per-browser preference (like the UI state above), not shared via
  // Firestore -- each rider picks their own. "system" (no localStorage
  // entry) leaves data-theme unset so the CSS's own
  // prefers-color-scheme media query keeps deciding, matching the
  // pre-toggle behavior exactly.
  var THEME_KEY = 'carnet-de-piste-theme';

  function getThemePref() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return (t === 'light' || t === 'dark') ? t : 'system';
    } catch (e) { return 'system'; }
  }

  function applyTheme(pref) {
    if (pref === 'light' || pref === 'dark') {
      document.documentElement.dataset.theme = pref;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  function setThemePref(pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
    applyTheme(pref);
    renderRoot();
  }

  function renderThemeToggle() {
    var pref = getThemePref();
    function btn(value, label, icon) {
      return '<button type="button" class="theme-toggle-btn' + (pref === value ? ' active' : '') + '" data-theme-choice="' + value + '" aria-label="Thème ' + label + '" title="Thème ' + label + '">' + icon + '</button>';
    }
    return '<div class="theme-toggle" role="group" aria-label="Choix du thème">' +
      btn('light', 'clair', '☀️') +
      btn('dark', 'sombre', '🌙') +
      btn('system', 'système', '🖥️') +
      '</div>';
  }

  // A render bug used to mean a silent blank page -- an exception thrown
  // while building `body` fires before root.innerHTML is ever assigned, so
  // whatever was there before (nothing, on a fresh load) just stays.
  // Catching it here turns that into a visible, copy-pasteable error
  // instead, so a rider hitting a bug can report exactly what broke.
  function renderRoot() {
    try {
      renderRootUnsafe();
    } catch (err) {
      if (window.console) console.error('renderRoot failed', err);
      var root = document.getElementById('root');
      if (root) {
        root.innerHTML = '<div class="card"><h2 class="section-title">Erreur d\'affichage</h2>' +
          '<p>Quelque chose a mal tourné en construisant la page. Envoie ce message tel quel :</p>' +
          '<pre style="white-space:pre-wrap; word-break:break-word; font-size:0.78rem; background:var(--surface-alt); padding:0.8rem; border-radius:8px;">' +
          escapeHtml((err && err.stack) || String(err)) + '</pre></div>';
      }
    }
  }

  function renderRootUnsafe() {
    var root = document.getElementById('root');
    if (authState !== 'signed-in') {
      var authBody;
      if (authState === 'loading') authBody = '<div class="card auth-card"><div class="empty-state">Connexion...</div></div>';
      else if (authState === 'verify-email') authBody = renderVerifyEmailScreen();
      else authBody = renderAuthScreen();
      root.innerHTML =
        '<header class="page-head"><div class="eyebrow">Trackdays moto</div><h1 class="title">Carnet de Piste</h1></header>' +
        '<div class="auth-screen">' + authBody + '</div>';
      attachAuthHandlers();
      return;
    }
    normalizeSelection();
    var body;
    if (activeView === 'circuit') body = renderCircuitTab();
    else if (activeView === 'stats') body = renderStatsTab();
    else if (activeView === 'planning') body = renderPlanningTab();
    else body = renderEventTab(); // 'event' and safety fallback
    root.innerHTML =
      '<header class="page-head">' +
        '<div class="page-head-row">' +
          '<div class="page-head-text">' +
            '<div class="eyebrow">Trackdays moto</div>' +
            '<h1 class="title">Carnet de Piste</h1>' +
            '<p class="subtitle">' + subtitleForView(activeView) + '</p>' +
          '</div>' +
          '<div class="header-controls">' +
            '<div class="live-clock" id="live-clock">--h--</div>' +
            renderThemeToggle() +
          '</div>' +
        '</div>' +
        '<div class="account-bar">' +
          '<span class="account-bar-identity">' + escapeHtml(currentUserProfile.name) + ' · ' + (currentUserProfile.role === 'accompagnant' ? 'Accompagnant' : 'Pilote') + '</span>' +
          '<span class="account-bar-actions">' +
            '<button type="button" class="ghost account-bar-btn" id="profile-toggle">Mon profil</button>' +
            (isAdmin() ? '<button type="button" class="ghost account-bar-btn" id="account-manager-toggle">Comptes accompagnant</button>' : '') +
            '<button type="button" class="ghost account-bar-btn" id="logout-btn">Se déconnecter</button>' +
          '</span>' +
        '</div>' +
        '<div class="banner" id="status-banner"></div>' +
      '</header>' +
      renderProfilePanel() +
      renderAccountManagerPanel() +
      renderGlobalRiderPicker() +
      renderViewTabs() +
      body;
    attachHandlers();
    updateBanner();
    saveUiState();
    updateLiveClock();
  }

  // ---- Comptes (Pilote / Accompagnant) ----
  //
  // Real Firebase accounts (email/password), one profile doc per uid in
  // 'users'. Gates the whole app: nothing renders until authState is
  // 'signed-in' and the profile doc has loaded (see init()'s
  // onAuthStateChanged and onSignupSubmit below).
  // A freshly created account (or an old one from before this check
  // existed) can't do anything until its email is confirmed -- otherwise
  // any bot can "sign up" with a throwaway address and start writing.
  // Firestore rules enforce this server-side too (email_verified on every
  // write except a user's own profile, which has to be writable right
  // after signup, before there's been time to verify anything).
  function renderVerifyEmailScreen() {
    var email = (auth.currentUser && auth.currentUser.email) || 'ton adresse';
    var html = '<div class="card auth-card">';
    html += '<h2 class="section-title">Vérifie ton email</h2>';
    html += '<p class="help-text">Un email de vérification a été envoyé à <strong>' + escapeHtml(email) + '</strong>. Clique sur le lien qu\'il contient, puis reviens ici. Pense à vérifier tes spams/courriers indésirables si tu ne le vois pas — l\'expéditeur est une adresse @firebaseapp.com.</p>';
    html += '<div class="field-error' + (authError ? ' visible' : '') + '" id="auth-error">' + escapeHtml(authError) + '</div>';
    html += '<div style="margin-top:0.9rem; display:flex; gap:0.6rem; flex-wrap:wrap;">' +
      '<button type="button" class="primary" id="verify-check-btn">J\'ai vérifié, continuer</button>' +
      '<button type="button" class="ghost" id="verify-resend-btn">Renvoyer l\'email</button>' +
      '</div>';
    html += '<div class="help-text" style="margin-top:0.9rem;"><button type="button" class="auth-link" id="verify-logout-btn">Se déconnecter</button></div>';
    html += '</div>';
    return html;
  }

  function renderAuthScreen() {
    var html = '<div class="card auth-card">';
    if (authMode === 'signup') {
      html += '<h2 class="section-title">Créer un compte</h2>';
      html += '<form id="signup-form" novalidate>';
      html += '<label for="au-name">Nom</label><input type="text" id="au-name" placeholder="Ex. Xavier" required>';
      html += '<div id="au-number-wrap" style="margin-top:0.7rem;"><label for="au-number">N° de moto <span class="help-text" style="display:inline;">(si un autre pilote porte déjà ce nom)</span></label><input type="text" id="au-number" placeholder="Ex. 12"></div>';
      html += '<label style="margin-top:0.7rem;">Je suis</label><div class="auth-role-choice">' +
        '<label><input type="radio" name="au-role" value="pilote" checked> Pilote</label>' +
        '<label><input type="radio" name="au-role" value="accompagnant"> Accompagnant</label></div>';
      html += '<label for="au-email" style="margin-top:0.7rem;">Email</label><input type="email" id="au-email" required>';
      html += '<label for="au-password" style="margin-top:0.7rem;">Mot de passe</label><input type="password" id="au-password" required minlength="6">';
      html += '<div class="field-error' + (authError ? ' visible' : '') + '" id="auth-error">' + escapeHtml(authError) + '</div>';
      html += '<button type="submit" class="primary" style="margin-top:0.9rem;">Créer mon compte</button>';
      html += '</form>';
      html += '<div class="help-text" style="margin-top:0.9rem;">Déjà un compte ?<br><button type="button" class="auth-link" id="switch-to-login">Se connecter</button></div>';
    } else {
      html += '<h2 class="section-title">Connexion</h2>';
      html += '<form id="login-form" novalidate>';
      html += '<label for="au-email">Email</label><input type="email" id="au-email" required>';
      html += '<label for="au-password" style="margin-top:0.7rem;">Mot de passe</label><input type="password" id="au-password" required>';
      html += '<div class="field-error' + (authError ? ' visible' : '') + '" id="auth-error">' + escapeHtml(authError) + '</div>';
      html += '<button type="submit" class="primary" style="margin-top:0.9rem;">Se connecter</button>';
      html += '</form>';
      html += '<div class="help-text" style="margin-top:0.9rem;">Pas encore de compte ?<br><button type="button" class="auth-link" id="switch-to-signup">Créer un compte</button></div>';
      html += '<div class="help-text" style="margin-top:0.4rem;"><button type="button" class="auth-link" id="forgot-password-btn">Mot de passe oublié ?</button></div>';
    }
    html += '</div>';
    return html;
  }

  function translateAuthError(err) {
    var code = err && err.code;
    if (code === 'auth/email-already-in-use') return 'Cet email est déjà utilisé — connecte-toi plutôt.';
    if (code === 'auth/invalid-email') return 'Email invalide.';
    if (code === 'auth/weak-password') return 'Mot de passe trop court (6 caractères minimum).';
    if (code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-credential') return 'Email ou mot de passe incorrect.';
    if (code === 'auth/too-many-requests') return 'Trop de tentatives — attends quelques minutes avant de renvoyer l\'email.';
    return 'Erreur : ' + ((err && err.message) || err);
  }

  function onLoginSubmit(evt) {
    evt.preventDefault();
    var email = document.getElementById('au-email').value.trim();
    var password = document.getElementById('au-password').value;
    authError = '';
    auth.signInWithEmailAndPassword(email, password).catch(function (err) {
      authError = translateAuthError(err);
      renderRoot();
    });
  }

  function onSignupSubmit(evt) {
    evt.preventDefault();
    var roleEl = document.querySelector('input[name="au-role"]:checked');
    var role = roleEl ? roleEl.value : 'pilote';
    var numberEl = document.getElementById('au-number');
    var number = (role === 'pilote' && numberEl) ? numberEl.value.trim() : '';
    var name = riderBaseName(document.getElementById('au-name').value.trim());
    if (number) name = name + ' (#' + number + ')';
    var email = document.getElementById('au-email').value.trim();
    var password = document.getElementById('au-password').value;
    if (!name) {
      authError = 'Indique ton nom.';
      renderRoot();
      return;
    }
    authError = '';
    auth.createUserWithEmailAndPassword(email, password).then(function (cred) {
      return db.collection('users').doc(cred.user.uid).set({ name: name, role: role, email: email }).then(function () {
        if (role === 'pilote') {
          return db.collection('riders').doc(safeDocId(name)).set({ name: name }, { merge: true });
        }
      }).then(function () {
        return cred.user.sendEmailVerification();
      });
    }).then(function () {
      // Held at 'verify-email' -- the account and profile both exist, but
      // nothing writable happens until the address is confirmed (bots
      // shouldn't be able to just type in someone's email and start
      // editing sorties). currentUserProfile is set directly here rather
      // than waiting on onAuthStateChanged's own profile fetch, since that
      // fetch can race this document write.
      currentUserProfile = { name: name, role: role, email: email };
      authState = 'verify-email';
      autoVerifyEmailSent = true; // already sent just above -- don't let onAuthStateChanged send a second one
      renderRoot();
      showToast('Compte créé — vérifie ton email pour continuer.', 'success');
    }).catch(function (err) {
      authError = translateAuthError(err);
      renderRoot();
    });
  }

  function checkEmailVerified() {
    var user = auth.currentUser;
    if (!user) return;
    user.reload().then(function () {
      if (user.emailVerified) {
        authError = '';
        // Force-refresh the ID token so Firestore rules see
        // email_verified=true on the very next write, instead of
        // whatever was cached from before verification.
        return user.getIdToken(true).then(function () {
          return db.collection('users').doc(user.uid).get();
        }).then(function (doc) {
          if (doc.exists) currentUserProfile = doc.data();
          authState = 'signed-in';
          canPersist = true;
          startSync();
          renderRoot();
        });
      }
      authError = 'Pas encore vérifié — clique sur le lien reçu par email, puis réessaie.';
      renderRoot();
    });
  }

  function attachAuthHandlers() {
    var loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.addEventListener('submit', onLoginSubmit);
    var signupForm = document.getElementById('signup-form');
    if (signupForm) {
      signupForm.addEventListener('submit', onSignupSubmit);
      signupForm.querySelectorAll('input[name="au-role"]').forEach(function (radio) {
        radio.addEventListener('change', function () {
          var numberWrap = document.getElementById('au-number-wrap');
          if (numberWrap && radio.checked) numberWrap.style.display = radio.value === 'pilote' ? 'block' : 'none';
        });
      });
    }
    var toSignup = document.getElementById('switch-to-signup');
    if (toSignup) toSignup.addEventListener('click', function () { authMode = 'signup'; authError = ''; renderRoot(); });
    var toLogin = document.getElementById('switch-to-login');
    if (toLogin) toLogin.addEventListener('click', function () { authMode = 'login'; authError = ''; renderRoot(); });
    var forgotBtn = document.getElementById('forgot-password-btn');
    if (forgotBtn) {
      forgotBtn.addEventListener('click', function () {
        var email = document.getElementById('au-email').value.trim();
        if (!email) {
          authError = 'Indique ton email d\'abord, puis clique à nouveau sur "Mot de passe oublié ?".';
          renderRoot();
          return;
        }
        auth.sendPasswordResetEmail(email).then(function () {
          authError = '';
          showToast('Email de réinitialisation envoyé à ' + email + '.', 'success');
        }).catch(function (err) {
          authError = translateAuthError(err);
          renderRoot();
        });
      });
    }
    var verifyCheckBtn = document.getElementById('verify-check-btn');
    if (verifyCheckBtn) verifyCheckBtn.addEventListener('click', checkEmailVerified);
    var verifyResendBtn = document.getElementById('verify-resend-btn');
    if (verifyResendBtn) {
      verifyResendBtn.addEventListener('click', function () {
        if (!auth.currentUser) return;
        auth.currentUser.sendEmailVerification().then(function () {
          showToast('Email renvoyé à ' + auth.currentUser.email + '.', 'success');
        }).catch(function (err) {
          authError = translateAuthError(err);
          renderRoot();
        });
      });
    }
    var verifyLogoutBtn = document.getElementById('verify-logout-btn');
    if (verifyLogoutBtn) verifyLogoutBtn.addEventListener('click', function () { auth.signOut(); });
  }

  var pendingDelete = null;
  var pendingDeleteEvent = null;
  var pendingDeleteChecklistCategory = null;
  var profilePanelOpen = false; // pure UI state, not persisted
  var riderManagerOpen = false; // pure UI state, not persisted
  var editingRiderName = null; // rider currently shown as an inline rename form, or null
  var pendingDeleteRider = null; // rider armed for delete (click-to-confirm, like session delete)
  var riderManagerError = ''; // validation/blocking message shown in the panel

  function attachHandlers() {
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', function () { auth.signOut(); });
    var profileToggle = document.getElementById('profile-toggle');
    if (profileToggle) {
      profileToggle.addEventListener('click', function () {
        profilePanelOpen = !profilePanelOpen;
        profileSaveMessage = '';
        renderRoot();
      });
    }
    var accountManagerToggle = document.getElementById('account-manager-toggle');
    if (accountManagerToggle) {
      accountManagerToggle.addEventListener('click', function () {
        accountManagerOpen = !accountManagerOpen;
        if (accountManagerOpen && accompagnantAccounts === null) loadAccompagnantAccounts();
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="demote-account"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-uid');
        var account = (accompagnantAccounts || []).filter(function (a) { return a.uid === uid; })[0];
        if (!account) return;
        db.collection('users').doc(uid).set({ role: 'pilote' }, { merge: true }).then(function () {
          if (account.name) return db.collection('riders').doc(safeDocId(account.name)).set({ name: account.name }, { merge: true });
        }).then(function () {
          accompagnantAccounts = accompagnantAccounts.filter(function (a) { return a.uid !== uid; });
          showToast(account.name + ' est maintenant Pilote.', 'success');
          renderRoot();
        }).catch(function (err) {
          accountManagerError = 'Erreur : ' + (err && err.message ? err.message : err);
          renderRoot();
        });
      });
    });
    document.querySelectorAll('[data-action="delete-account-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-uid');
        if (pendingDeleteAccountUid === uid) {
          db.collection('users').doc(uid).delete().then(function () {
            accompagnantAccounts = accompagnantAccounts.filter(function (a) { return a.uid !== uid; });
            pendingDeleteAccountUid = null;
            showToast('Accès retiré.', 'success');
            renderRoot();
          }).catch(function (err) {
            accountManagerError = 'Erreur : ' + (err && err.message ? err.message : err);
            renderRoot();
          });
        } else {
          pendingDeleteAccountUid = uid;
          renderRoot();
        }
      });
    });
    var profileCancel = document.getElementById('profile-cancel');
    if (profileCancel) {
      profileCancel.addEventListener('click', function () {
        profilePanelOpen = false;
        renderRoot();
      });
    }
    var profileForm = document.getElementById('profile-form');
    if (profileForm) {
      profileForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var role = profileForm.querySelector('input[name="profile-role"]:checked').value;
        var notify = document.getElementById('profile-notify').checked;
        var followedRiders = Array.prototype.map.call(
          profileForm.querySelectorAll('input[name="profile-follow-rider"]:checked'),
          function (el) { return el.value; }
        );
        saveProfile(role, notify, followedRiders);
      });
      var notifyLabel = document.getElementById('profile-notify-label');
      profileForm.querySelectorAll('input[name="profile-role"]').forEach(function (radio) {
        radio.addEventListener('change', function () {
          var isAcc = radio.value === 'accompagnant' && radio.checked;
          if (radio.checked) {
            var wrap = document.getElementById('profile-followed-wrap');
            if (wrap) wrap.style.display = isAcc ? 'block' : 'none';
            if (notifyLabel) notifyLabel.textContent = isAcc ? 'Me notifier quand un pilote suivi va partir rouler' : 'Me notifier quand mon groupe va partir rouler';
          }
        });
      });
    }
    document.querySelectorAll('[data-theme-choice]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setThemePref(btn.getAttribute('data-theme-choice'));
      });
    });
    var form = document.getElementById('session-form');
    if (form) form.addEventListener('submit', onSubmit);
    var fDateEl = document.getElementById('f-date');
    autoFormatFrDateInput(fDateEl);
    if (fDateEl) {
      fDateEl.addEventListener('input', function () {
        var wrap = document.getElementById('f-linked-event-wrap');
        if (!wrap) return;
        var iso = frDateToIso(fDateEl.value) || dateKey(new Date());
        wrap.innerHTML = renderLinkedEventField(selectedCircuit, iso);
      });
    }
    var nextOutingLink = document.getElementById('next-outing-link');
    if (nextOutingLink) {
      nextOutingLink.addEventListener('click', function () {
        var ev = eventsList().filter(function (e) { return e.id === nextOutingLink.getAttribute('data-event-id'); })[0];
        if (!ev) return;
        activeView = 'event';
        selectEvent(ev.id);
        calendarAnchor = ev.dateStart;
        renderRoot();
      });
    }
    var planOutingLink = document.getElementById('plan-outing-link');
    if (planOutingLink) {
      planOutingLink.addEventListener('click', function () {
        activeView = 'event';
        editingEventId = 'new';
        selectedEventId = null;
        prefillEventCircuit = selectedCircuit;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="delete-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (pendingDelete === id) {
          removeSession(id);
          pendingDelete = null;
        } else {
          pendingDelete = id;
          btn.textContent = '✓';
          btn.setAttribute('aria-label', 'Confirmer la suppression');
          btn.setAttribute('title', 'Confirmer la suppression');
          btn.classList.add('confirm');
        }
      });
    });

    document.querySelectorAll('[data-action="edit-session-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingSessionId = btn.getAttribute('data-id');
        renderRoot();
      });
    });
    var cancelSessionEditBtn = document.getElementById('cancel-session-edit-btn');
    if (cancelSessionEditBtn) cancelSessionEditBtn.addEventListener('click', function () { editingSessionId = null; renderRoot(); });
    var sessionEditForm = document.getElementById('session-edit-form');
    if (sessionEditForm) sessionEditForm.addEventListener('submit', onSessionEditSubmit);
    autoFormatFrDateInput(document.getElementById('se-date'));

    document.querySelectorAll('.view-tab[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeView = btn.getAttribute('data-view');
        editingEventId = null;
        prefillEventCircuit = null;
        editingSessionId = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-calendar-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        calendarViewMode = btn.getAttribute('data-calendar-view');
        renderRoot();
      });
    });
    var calPrev = document.getElementById('cal-prev');
    if (calPrev) calPrev.addEventListener('click', function () { calendarNavStep(-1); renderRoot(); });
    var calNext = document.getElementById('cal-next');
    if (calNext) calNext.addEventListener('click', function () { calendarNavStep(1); renderRoot(); });
    var calToday = document.getElementById('cal-today');
    if (calToday) calToday.addEventListener('click', function () { calendarAnchor = dateKey(new Date()); renderRoot(); });

    // A day cell carrying a planned outing selects it and stays on
    // Calendrier — the sorties list below (same accordion as Événement)
    // then shows it expanded in place. A day with only ridden sessions and
    // no outing shows its chronos inline instead.
    document.querySelectorAll('.calendar-cell[data-date]').forEach(function (el) {
      el.addEventListener('click', function () {
        var evId = el.getAttribute('data-event-id');
        var dateStr = el.getAttribute('data-date');
        if (evId) {
          selectEvent(evId);
          renderRoot();
          return;
        }
        var sessionsHere = sessionsOnDate(dateStr);
        selectedSessionDate = sessionsHere.length ? dateStr : null;
        renderRoot();
      });
    });
    // Every sorties list (Calendrier's period card and the Événement tab's
    // groups) is the same accordion: clicking the open row again collapses
    // it, clicking another row switches to it — nothing here navigates tabs.
    document.querySelectorAll('.event-row-toggle[data-event-id]').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-event-id');
        if (selectedEventId === id) {
          selectedEventId = null;
        } else {
          selectEvent(id);
        }
        renderRoot();
      });
    });
    document.querySelectorAll('.past-year-toggle[data-past-year]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var year = btn.getAttribute('data-past-year');
        expandedPastYears[year] = !expandedPastYears[year];
        renderRoot();
      });
    });
    var lastOutingLink = document.getElementById('last-outing-link');
    if (lastOutingLink) {
      lastOutingLink.addEventListener('click', function () {
        selectEvent(lastOutingLink.getAttribute('data-event-id'));
        activeView = 'event';
        renderRoot();
      });
    }
    var closeEventDetail = document.getElementById('close-event-detail');
    if (closeEventDetail) closeEventDetail.addEventListener('click', function () { selectedEventId = null; renderRoot(); });
    var closeSessionDay = document.getElementById('close-session-day');
    if (closeSessionDay) closeSessionDay.addEventListener('click', function () { selectedSessionDate = null; renderRoot(); });
    document.querySelectorAll('input[data-checklist-key]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        toggleEventChecklist(cb.getAttribute('data-event-id'), cb.getAttribute('data-checklist-key'), cb.checked);
      });
    });
    document.querySelectorAll('select[data-rider-group]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        setRiderGroup(sel.getAttribute('data-event-id'), sel.getAttribute('data-rider'), sel.getAttribute('data-date'), sel.getAttribute('data-period'), sel.value);
      });
    });
    document.querySelectorAll('select[data-common-group]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        applyCommonGroup(sel.getAttribute('data-event-id'), sel.value);
      });
    });
    var editEventBtn = document.getElementById('edit-event-btn');
    if (editEventBtn) {
      editEventBtn.addEventListener('click', function () {
        editingEventId = editEventBtn.getAttribute('data-id');
        renderRoot();
      });
    }
    var addEventBtn = document.getElementById('add-event-btn');
    if (addEventBtn) {
      addEventBtn.addEventListener('click', function () {
        editingEventId = 'new';
        selectedEventId = null;
        prefillEventCircuit = null;
        renderRoot();
      });
    }
    var cancelEventBtn = document.getElementById('cancel-event-btn');
    if (cancelEventBtn) cancelEventBtn.addEventListener('click', function () { editingEventId = null; prefillEventCircuit = null; renderRoot(); });
    var eventForm = document.getElementById('event-form');
    if (eventForm) eventForm.addEventListener('submit', onEventSubmit);
    // Riders and dates typed into the open sortie form drive the groups
    // grid live, without touching the rest of the form.
    var evRidersEl = document.getElementById('ev-riders');
    if (evRidersEl) evRidersEl.addEventListener('input', refreshEventFormGroups);
    var evCircuitEl = document.getElementById('ev-circuit');
    if (evCircuitEl && editingEventId === 'new') {
      evCircuitEl.addEventListener('change', function () {
        var defaults = circuitInfo(evCircuitEl.value.trim());
        var orgEl = document.getElementById('ev-organizer');
        if (orgEl && !orgEl.value.trim() && defaults.organizer) orgEl.value = defaults.organizer;
      });
    }
    var evDateStartEl = document.getElementById('ev-date-start');
    if (evDateStartEl) { evDateStartEl.addEventListener('input', refreshEventFormGroups); autoFormatFrDateInput(evDateStartEl); }
    var evDateEndEl = document.getElementById('ev-date-end');
    if (evDateEndEl) { evDateEndEl.addEventListener('input', refreshEventFormGroups); autoFormatFrDateInput(evDateEndEl); }
    attachEventFormGroupHandlers();
    document.querySelectorAll('[data-action="delete-event-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (pendingDeleteEvent === id) {
          removeEvent(id);
          pendingDeleteEvent = null;
        } else {
          pendingDeleteEvent = id;
          btn.textContent = '✓';
          btn.setAttribute('aria-label', 'Confirmer la suppression');
          btn.setAttribute('title', 'Confirmer la suppression');
          btn.classList.add('confirm');
        }
      });
    });

    document.querySelectorAll('[data-planning-section]').forEach(function (details) {
      details.addEventListener('toggle', function () {
        planningSectionsOpen[details.getAttribute('data-planning-section')] = details.open;
      });
    });
    document.querySelectorAll('[data-planning-group]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var selected = [];
        document.querySelectorAll('[data-planning-group]').forEach(function (b) {
          if (b.checked) selected.push(b.getAttribute('data-planning-group'));
        });
        planningGroupFilter = selected;
        renderRoot();
      });
    });

    document.querySelectorAll('.checklist-add-item-form').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = form.querySelector('[data-new-item-input]');
        if (!input || !input.value.trim()) return;
        addChecklistItem(form.getAttribute('data-add-item-category'), input.value);
      });
    });
    var addCategoryForm = document.getElementById('add-checklist-category-form');
    if (addCategoryForm) {
      addCategoryForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = document.getElementById('new-checklist-category');
        if (!input || !input.value.trim()) return;
        addChecklistCategory(input.value);
      });
    }
    document.querySelectorAll('[data-action="remove-checklist-item"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeChecklistItem(btn.getAttribute('data-category'), btn.getAttribute('data-item'));
      });
    });
    document.querySelectorAll('[data-action="remove-checklist-category"]').forEach(function (btn) {
      btn.addEventListener('click', function (evt) {
        // This button sits inside a <summary> (the category's collapsible
        // header) -- without stopping the click here, the browser's
        // default "click toggles the parent <details>" behavior fires too.
        evt.preventDefault();
        evt.stopPropagation();
        var categoryId = btn.getAttribute('data-category');
        if (pendingDeleteChecklistCategory === categoryId) {
          removeChecklistCategory(categoryId);
          pendingDeleteChecklistCategory = null;
        } else {
          pendingDeleteChecklistCategory = categoryId;
          renderRoot();
        }
      });
    });
    var riderManagerToggle = document.getElementById('rider-manager-toggle');
    if (riderManagerToggle) {
      riderManagerToggle.addEventListener('click', function () {
        riderManagerOpen = !riderManagerOpen;
        editingRiderName = null;
        pendingDeleteRider = null;
        riderManagerError = '';
        renderRoot();
      });
    }
    var addRiderForm = document.getElementById('add-rider-form');
    if (addRiderForm) {
      addRiderForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = document.getElementById('new-rider-name');
        var numberInput = document.getElementById('new-rider-number');
        var name = input.value.trim();
        if (!name) return;
        addRider(name, numberInput ? numberInput.value : '');
      });
    }
    document.querySelectorAll('[data-action="rename-rider-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingRiderName = btn.getAttribute('data-rider');
        pendingDeleteRider = null;
        riderManagerError = '';
        renderRoot();
      });
    });
    var cancelRenameBtn = document.querySelector('[data-action="cancel-rename-rider"]');
    if (cancelRenameBtn) {
      cancelRenameBtn.addEventListener('click', function () {
        editingRiderName = null;
        renderRoot();
      });
    }
    var renameRiderForm = document.querySelector('.rider-manager-rename-form');
    if (renameRiderForm) {
      renameRiderForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var oldName = renameRiderForm.getAttribute('data-rename-rider');
        var newName = renameRiderForm.querySelector('[name="new-name"]').value.trim();
        if (!newName) return;
        renameRider(oldName, newName);
      });
    }
    document.querySelectorAll('[data-action="delete-rider-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-rider');
        if (pendingDeleteRider === name) {
          deleteRider(name);
        } else {
          pendingDeleteRider = name;
          editingRiderName = null;
          riderManagerError = '';
          renderRoot();
        }
      });
    });

    var circuitSelect = document.getElementById('f-filter-circuit');
    if (circuitSelect) {
      circuitSelect.addEventListener('change', function () {
        selectedCircuit = circuitSelect.value;
        editingCircuitInfo = false;
        editingSessionId = null;
        renderRoot();
      });
    }
    var editInfoBtn = document.getElementById('edit-circuit-info-btn');
    if (editInfoBtn) editInfoBtn.addEventListener('click', function () { editingCircuitInfo = true; renderRoot(); });
    var cancelInfoBtn = document.getElementById('cancel-circuit-info-btn');
    if (cancelInfoBtn) cancelInfoBtn.addEventListener('click', function () { editingCircuitInfo = false; renderRoot(); });
    var saveInfoBtn = document.getElementById('save-circuit-info-btn');
    if (saveInfoBtn) saveInfoBtn.addEventListener('click', saveCircuitInfo);
    var openAnnotBtn = document.getElementById('open-annot-btn');
    if (openAnnotBtn) {
      openAnnotBtn.addEventListener('click', function () {
        openAnnotation(openAnnotBtn.getAttribute('data-circuit') || selectedCircuit, openAnnotBtn.getAttribute('data-event-id') || null);
      });
    }
    document.querySelectorAll('[data-global-rider]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = btn.getAttribute('data-global-rider');
        selectedRiders = (val === '__all__') ? new Set(allKnownRiders()) : new Set([val]);
        renderRoot();
      });
    });
    document.querySelectorAll('.progression-point').forEach(function (el) {
      el.addEventListener('click', function () {
        var idx = parseInt(el.getAttribute('data-idx'), 10);
        var p = PROGRESSION_POINTS[idx];
        var caption = document.getElementById('progression-caption');
        if (p && caption) {
          caption.textContent = (PROGRESSION_MULTI ? p.rider + ' — ' : '') + formatDate(p.date) + ' — ' + formatTime(p.time) + (p.isBest ? ' (record)' : '');
        }
      });
    });
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var riderEl = document.getElementById('f-rider');
    var dateEl = document.getElementById('f-date');
    var bikeEl = document.getElementById('f-bike');
    var lapsEl = document.getElementById('f-laps');
    var noteEl = document.getElementById('f-note');
    var periodEl = document.getElementById('f-period');
    var groupEl = document.getElementById('f-group');
    var errEl = document.getElementById('form-error');
    errEl.classList.remove('visible');

    var activeRider = (selectedRiders && selectedRiders.size === 1) ? Array.from(selectedRiders)[0] : null;
    var rider = riderEl ? riderEl.value.trim() : (activeRider || '');
    var date = frDateToIso(dateEl.value);
    var circuit = selectedCircuit;
    var bike = bikeEl.value.trim();
    var note = noteEl.value.trim();
    var period = periodEl ? periodEl.value : '';
    var group = groupEl ? groupEl.value : '';
    var rawLaps = lapsEl.value.split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var laps = [];
    var invalid = false;
    rawLaps.forEach(function (raw) {
      var t = parseTime(raw);
      if (t === null) { invalid = true; } else { laps.push(t); }
    });

    if (dateEl.value.trim() && !date) {
      errEl.textContent = 'Date invalide — format attendu JJ/MM/AAAA.';
      errEl.classList.add('visible');
      return;
    }
    if (!rider || !date || !circuit || !laps.length) {
      errEl.textContent = 'Renseignez un pilote, une date et au moins un chrono valide.';
      errEl.classList.add('visible');
      return;
    }
    if (invalid) {
      errEl.textContent = 'Certains chronos sont illisibles — format attendu 1:23.456 ou 83.456.';
      errEl.classList.add('visible');
      return;
    }

    var previousBest = riderCircuitBest(rider, circuit);
    var session = { id: genId(), rider: rider, date: date, circuit: circuit, laps: laps };
    if (bike) session.bike = bike;
    if (note) session.note = note;
    if (period) session.period = period;
    if (group) session.group = group;
    var prevState = JSON.parse(JSON.stringify(STATE));

    // Linked via the "Sortie associée" suggestion (renderLinkedEventField),
    // pre-selected to whichever sortie on this circuit covers the chosen
    // date -- a rider can still pick "Aucune" to skip it.
    var linkedEventEl = document.getElementById('f-linked-event');
    var linkedEventId = linkedEventEl ? linkedEventEl.value : '';
    var linkedEvent = linkedEventId ? eventsList().filter(function (e) { return e.id === linkedEventId; })[0] : null;
    if (linkedEvent) {
      session.eventId = linkedEvent.id;
      linkedEvent.riders = linkedEvent.riders || [];
      if (linkedEvent.riders.indexOf(rider) === -1) linkedEvent.riders.push(rider);
    }

    STATE.sessions.push(session);
    selectedRiders = new Set([rider]);
    renderRoot();
    persist(prevState);

    var newBest = sessionBest(session);
    if (previousBest === null || newBest < previousBest) {
      showToast('Nouveau record personnel sur ' + circuit + ' : ' + formatTime(newBest) + ' !', 'success');
    } else {
      showToast('Chrono enregistré.', 'success');
    }
  }

  function removeSession(id) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.sessions = STATE.sessions.filter(function (s) { return s.id !== id; });
    renderRoot();
    persist(prevState);
  }

  function updateBanner() {
    var banner = document.getElementById('status-banner');
    if (!banner) return;
    if (!canPersist) {
      banner.textContent = 'Sauvegarde indisponible dans cette vue : vos modifications ne seront pas conservées.';
      banner.classList.add('visible');
      var submitBtn = document.getElementById('submit-btn');
      if (submitBtn) submitBtn.disabled = true;
    } else {
      banner.classList.remove('visible');
    }
  }

  function showToast(message, variant) {
    var stack = document.getElementById('toast-stack');
    var toast = document.createElement('div');
    toast.className = variant ? 'toast ' + variant : 'toast';
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4000);
  }

  function safeDocId(name) {
    return encodeURIComponent(name).slice(0, 300) || '_';
  }

  function startSync() {
    unsubscribers.push(db.collection('sessions').onSnapshot(function (snap) {
      STATE.sessions = snap.docs.map(function (d) { return d.data(); });
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('events').onSnapshot(function (snap) {
      STATE.events = snap.docs.map(function (d) { return d.data(); });
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('circuits').onSnapshot(function (snap) {
      var map = {};
      snap.docs.forEach(function (d) {
        var data = d.data();
        map[data.name] = data;
      });
      STATE.circuits = map;
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('riders').onSnapshot(function (snap) {
      STATE.riders = snap.docs.map(function (d) { return d.data().name; })
        .sort(function (a, b) { return a.localeCompare(b); });
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('settings').doc('checklist').onSnapshot(function (doc) {
      STATE.checklistTemplate = doc.exists ? doc.data() : null;
      renderRoot();
    }, handleSyncError));
  }

  function stopSync() {
    unsubscribers.forEach(function (unsub) { unsub(); });
    unsubscribers = [];
  }

  function handleSyncError() {
    canPersist = false;
    updateBanner();
    showToast('Connexion à la base de données perdue — vérifie ta connexion et recharge la page.');
  }

  // Diffs prevState against the current STATE (already mutated in place by
  // the caller, the same pattern every mutation in this app already
  // follows) and writes only the documents that actually changed --
  // Firestore's own compare-and-set per document, not one big blob.
  function diffArrayCollection(batch, coll, prevArr, nextArr) {
    var prevById = {}, nextById = {}, n = 0;
    (prevArr || []).forEach(function (item) { prevById[item.id] = item; });
    (nextArr || []).forEach(function (item) { nextById[item.id] = item; });
    Object.keys(nextById).forEach(function (id) {
      if (JSON.stringify(nextById[id]) !== JSON.stringify(prevById[id])) {
        batch.set(db.collection(coll).doc(id), nextById[id]);
        n++;
      }
    });
    Object.keys(prevById).forEach(function (id) {
      if (!nextById[id]) { batch.delete(db.collection(coll).doc(id)); n++; }
    });
    return n;
  }

  function diffCircuits(batch, prevMap, nextMap) {
    var n = 0;
    Object.keys(nextMap || {}).forEach(function (name) {
      var prevEntry = (prevMap || {})[name];
      var nextEntry = nextMap[name];
      if (JSON.stringify(nextEntry) !== JSON.stringify(prevEntry)) {
        var doc = Object.assign({}, nextEntry, { name: name });
        batch.set(db.collection('circuits').doc(safeDocId(name)), doc);
        n++;
      }
    });
    Object.keys(prevMap || {}).forEach(function (name) {
      if (!nextMap || !nextMap[name]) { batch.delete(db.collection('circuits').doc(safeDocId(name))); n++; }
    });
    return n;
  }

  function diffRiders(batch, prevArr, nextArr) {
    var n = 0;
    var prevSet = {}, nextSet = {};
    (prevArr || []).forEach(function (r) { prevSet[r] = true; });
    (nextArr || []).forEach(function (r) { nextSet[r] = true; });
    (nextArr || []).forEach(function (r) {
      if (!prevSet[r]) { batch.set(db.collection('riders').doc(safeDocId(r)), { name: r }); n++; }
    });
    (prevArr || []).forEach(function (r) {
      if (!nextSet[r]) { batch.delete(db.collection('riders').doc(safeDocId(r))); n++; }
    });
    return n;
  }

  // A single document (not a collection) -- STATE.checklistTemplate starts
  // null (DEFAULT_CHECKLIST_TEMPLATE is used until someone edits it), so
  // this only writes once the first edit actually happens.
  function diffChecklistTemplate(batch, prevTemplate, nextTemplate) {
    if (JSON.stringify(prevTemplate || null) === JSON.stringify(nextTemplate || null)) return 0;
    if (nextTemplate) batch.set(db.collection('settings').doc('checklist'), nextTemplate);
    else batch.delete(db.collection('settings').doc('checklist'));
    return 1;
  }

  function persist(prevState) {
    if (!canPersist) { updateBanner(); return; }
    var batch = db.batch();
    var ops = 0;
    ops += diffArrayCollection(batch, 'sessions', prevState.sessions, STATE.sessions);
    ops += diffArrayCollection(batch, 'events', prevState.events, STATE.events);
    ops += diffCircuits(batch, prevState.circuits, STATE.circuits);
    ops += diffRiders(batch, prevState.riders, STATE.riders);
    ops += diffChecklistTemplate(batch, prevState.checklistTemplate, STATE.checklistTemplate);
    if (!ops) return;
    batch.commit().catch(function (err) {
      STATE = prevState;
      renderRoot();
      if (err && err.code === 'permission-denied') {
        canPersist = false;
        updateBanner();
      } else {
        showToast('La sauvegarde a échoué — réessayez.');
      }
    });
  }

  function init() {
    renderRoot();
    setInterval(updateLiveClock, 15000);
    document.addEventListener('pointerdown', onCalendarPointerDown);
    document.addEventListener('pointermove', onCalendarPointerMove);
    document.addEventListener('pointerup', onCalendarPointerUp);
    document.addEventListener('pointercancel', onCalendarPointerUp);
    document.addEventListener('wheel', onCalendarWheel, { passive: false });
    document.addEventListener('keydown', onCalendarKeydown);
    // Real accounts (Pilote/Accompagnant), not anonymous sign-in: only
    // onSignupSubmit's own success handler moves authState to 'signed-in'
    // for a brand-new account (see its comment) -- here, a missing profile
    // doc just means that write hasn't landed yet, so it's a no-op rather
    // than an error.
    auth.onAuthStateChanged(function (user) {
      if (!user) {
        stopSync();
        authState = 'signed-out';
        currentUserProfile = null;
        canPersist = false;
        autoVerifyEmailSent = false;
        renderRoot();
        return;
      }
      if (!user.emailVerified) {
        // Covers both a fresh signup (handled directly in
        // onSignupSubmit, but this also fires) and someone logging back
        // into an old, never-verified account -- either way, held here
        // until they confirm. An account created before this screen
        // existed never got a first verification email at all, so send
        // one automatically the first time we land here this session
        // (guarded so a re-fired onAuthStateChanged doesn't spam it, and
        // skipped if onSignupSubmit already just sent one itself).
        if (!autoVerifyEmailSent) {
          autoVerifyEmailSent = true;
          user.sendEmailVerification().catch(function () {});
        }
        authState = 'verify-email';
        renderRoot();
        return;
      }
      db.collection('users').doc(user.uid).get().then(function (doc) {
        if (doc.exists) {
          currentUserProfile = doc.data();
          authState = 'signed-in';
          canPersist = true;
          startSync();
          renderRoot();
        } else {
          // The admin removed this account (see renderAccountManagerPanel) --
          // sign them out cleanly instead of leaving the app stuck on
          // "Connexion..." forever.
          authState = 'signed-out';
          auth.signOut();
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
