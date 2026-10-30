// In-memory stand-in for the Firebase compat SDK, enough to render the app.
(function () {
  var DATA = window.__MOCK_DATA || {};
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function docSnap(coll, id) {
    var d = (DATA[coll] || {})[id];
    return { id: id, exists: !!d, data: function () { return clone(d); }, ref: docRef(coll, id), get: function (k) { return d && d[k]; } };
  }
  var listeners = [];
  var muted = false, pending = null;
  function notify() { if (muted) return; if (pending) return; pending = setTimeout(function () { pending = null; listeners.forEach(function (l) { try { l(); } catch (e) { console.error(e); } }); }, 0); }
  function querySnap(coll, filters, lim) {
    var all = DATA[coll] || {};
    var docs = Object.keys(all).filter(function (id) {
      return filters.every(function (f) {
        var v = all[id][f[0]];
        if (f[1] === '==') return v === f[2];
        if (f[1] === 'in') return f[2].indexOf(v) !== -1;
        if (f[1] === 'array-contains') return Array.isArray(v) && v.indexOf(f[2]) !== -1;
        if (f[1] === '>=') return v >= f[2];
        if (f[1] === '<=') return v <= f[2];
        return true;
      });
    }).map(function (id) { return docSnap(coll, id); });
    if (lim) docs = docs.slice(0, lim);
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); }, docChanges: function () { return docs.map(function (d) { return { type: 'added', doc: d }; }); } };
  }
  function query(coll, filters, lim) {
    var q = {
      where: function (a, op, b) { return query(coll, filters.concat([[a, op, b]]), lim); },
      orderBy: function () { return q; }, limit: function (n) { return query(coll, filters, n); }, limitToLast: function (n) { return query(coll, filters, n); },
      startAfter: function () { return q; }, endBefore: function () { return q; }, startAt: function () { return q; },
      get: function () { return Promise.resolve(querySnap(coll, filters, lim)); },
      onSnapshot: function (cb) { var l = function () { cb(querySnap(coll, filters, lim)); }; listeners.push(l); setTimeout(l, 0); return function () {}; },
      doc: function (id) { return docRef(coll, id || ('auto' + Math.random().toString(36).slice(2))); },
      add: function (data) { var id = 'auto' + Math.random().toString(36).slice(2); (DATA[coll] = DATA[coll] || {})[id] = clone(data); notify(); return Promise.resolve(docRef(coll, id)); }
    };
    return q;
  }
  function docRef(coll, id) {
    return {
      id: id, path: coll + '/' + id,
      get: function () { return Promise.resolve(docSnap(coll, id)); },
      set: function (data, opt) { DATA[coll] = DATA[coll] || {}; DATA[coll][id] = opt && (opt.merge || opt.mergeFields) ? Object.assign({}, DATA[coll][id], clone(data)) : clone(data); notify(); return Promise.resolve(); },
      update: function (data) { DATA[coll] = DATA[coll] || {}; DATA[coll][id] = Object.assign({}, DATA[coll][id], clone(data)); notify(); return Promise.resolve(); },
      delete: function () { if (DATA[coll]) delete DATA[coll][id]; notify(); return Promise.resolve(); },
      onSnapshot: function (cb) { var l = function () { cb(docSnap(coll, id)); }; listeners.push(l); setTimeout(l, 0); return function () {}; },
      collection: function (sub) { return query(coll + '/' + id + '/' + sub, []); }
    };
  }
  var db = {
    collection: function (c) { return query(c, []); },
    doc: function (path) { var p = path.split('/'); return docRef(p[0], p[1]); },
    batch: function () { var ops = []; return { set: function (r, d, o) { ops.push(function () { return r.set(d, o); }); }, update: function (r, d) { ops.push(function () { return r.update(d); }); }, delete: function (r) { ops.push(function () { return r.delete(); }); }, commit: function () { muted = true; ops.forEach(function (f) { f(); }); muted = false; notify(); return Promise.resolve(); } }; },
    runTransaction: function (fn) { return fn({ get: function (r) { return r.get(); }, set: function (r, d, o) { return r.set(d, o); }, update: function (r, d) { return r.update(d); } }); },
    enablePersistence: function () { return Promise.resolve(); }, settings: function () {}
  };
  var user = window.__MOCK_USER;
  var auth = {
    currentUser: user,
    onAuthStateChanged: function (cb) { setTimeout(function () { cb(user); }, 0); return function () {}; },
    setPersistence: function () { return Promise.resolve(); },
    signOut: function () { return Promise.resolve(); },
    signInWithEmailAndPassword: function () { return Promise.resolve(); }
  };
  var firestoreFn = function () { return db; };
  firestoreFn.FieldValue = { serverTimestamp: function () { return new Date().toISOString(); }, arrayUnion: function () { return [].slice.call(arguments); }, arrayRemove: function () { return []; }, increment: function (n) { return n; }, delete: function () { return null; } };
  firestoreFn.Timestamp = { now: function () { return { toMillis: function () { return Date.now(); }, toDate: function () { return new Date(); } }; }, fromDate: function (d) { return { toDate: function () { return d; }, toMillis: function () { return +d; } }; } };
  var authFn = function () { return auth; };
  authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
  authFn.EmailAuthProvider = { credential: function () { return {}; } };
  window.firebase = { initializeApp: function () { return { auth: authFn, firestore: firestoreFn, delete: function () { return Promise.resolve(); } }; }, auth: authFn, firestore: firestoreFn, apps: [] };
})();
