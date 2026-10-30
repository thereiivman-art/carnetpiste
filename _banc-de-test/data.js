(function () {
  var today = new Date(); function d(off) { var x = new Date(today); x.setDate(x.getDate() + off); return x.toISOString().slice(0, 10); }
  var LANG = (location.hash.match(/lang=(\w+)/) || [])[1] || 'en'; var ADMIN = /admin=1/.test(location.hash); var EMAIL = ADMIN ? (window.__BENCH_ADMIN_EMAIL || 'admin@example.com') : 'alex@example.com';
  window.__MOCK_USER = { uid: 'u1', email: EMAIL, emailVerified: true, isAnonymous: false, displayName: 'Alex', getIdToken: function () { return Promise.resolve('x'); }, sendEmailVerification: function () { return Promise.resolve(); } };
  window.__MOCK_DATA = {
    users: {
      u1: { name: 'Alex', role: 'pilote', email: EMAIL, lang: LANG, tutorialSeen: true, country: 'FR', bike: 'Yamaha R6', level: 'intermediaire' },
      u2: { name: 'Sam', role: 'pilote', email: 'sam@example.com', lang: 'fr', tutorialSeen: true, country: 'BE', bike: 'BMW S1000RR' }
    },
    friendRequests: { f1: { id: 'f1', from: 'Alex', to: 'Sam', status: 'accepted' }, f2: { id: 'f2', from: 'Luca', to: 'Alex', status: 'pending' } },
    riders: { Alex: { name: 'Alex' }, Sam: { name: 'Sam' } },
    circuits: { Barcelone: { name: 'Barcelone', km: 4.657 }, Mugello: { name: 'Mugello' } },
    events: {
      e1: { id: 'e1', circuit: 'Barcelone', dateStart: d(30), dateEnd: d(31), riders: ['Alex', 'Sam'], note: '~420 € · test', horairesOverride: { groupB: '9h20-9h40, 11h20-11h40, 14h20-14h40' }, riderGroups: { Alex: (function () { var o = {}; o[d(30)] = { am: 'B' }; o[d(31)] = { am: 'B' }; return o; })() } },
      e2: { id: 'e2', circuit: 'Mugello', dateStart: d(-40), dateEnd: d(-39), riders: ['Alex', 'Sam'], note: '~350 €' },
      e3: { id: 'e3', circuit: 'Le Mans', dateStart: '2025-05-10', dateEnd: '2025-05-11', riders: ['Alex'], note: '' }
    },
    sessions: {
      s1: { id: 's1', rider: 'Alex', date: d(-40), circuit: 'Mugello', laps: [118.2, 116.9, 115.4, 116.1], eventId: 'e2', bike: 'Yamaha R6', group: 'B', slotStart: 540, slotLabel: '9h00-9h20' },
      s1b: { id: 's1b', rider: 'Alex', date: d(-40), circuit: 'Mugello', laps: [115.9, 114.8, 114.6, 115.0, 114.9], eventId: 'e2', bike: 'Yamaha R6', group: 'B', slotStart: 660, slotLabel: '11h00-11h20' },
      s1c: { id: 's1c', rider: 'Alex', date: d(-40), circuit: 'Mugello', laps: [114.2, 113.6, 113.9, 113.7], eventId: 'e2', bike: 'Yamaha R6', group: 'B', slotStart: 840, slotLabel: '14h00-14h20' },
      s1d: { id: 's1d', rider: 'Alex', date: d(-40), circuit: 'Mugello', laps: [114.0, 113.9, 114.3], eventId: 'e2', bike: 'Yamaha R6', group: 'B', slotStart: 960, slotLabel: '16h00-16h20' },
      s2: { id: 's2', rider: 'Sam', date: d(-40), circuit: 'Mugello', laps: [114.8, 113.9], eventId: 'e2' },
      s3: { id: 's3', rider: 'Alex', date: d(-100), circuit: 'Barcelone', laps: [112.4, 110.9], bike: 'Yamaha R6' }
    },
    teams: { t1: { id: 't1', name: 'Team Piste', leader: 'Alex', pro: false, slogan: 'On roule ensemble' }, t2: { id: 't2', name: 'Mototeam95', teamPro: true } },
    teamMembers: /noteam=1/.test(location.hash) ? { m2: { teamId: 't1', name: 'Sam', role: 'membre' } } : { m1: { teamId: 't1', name: 'Alex', role: 'leader' }, m2: { teamId: 't1', name: 'Sam', role: 'membre' } },
    feedEvents: {}, wallPosts: {}, follows: {}, settings: {},
    userPrivate: { u1: { setups: {
      s1: { pFrontHot: '2.3', pRearHot: '2.0', fork: 'C8 R10', shock: 'R12' },
      s1b: { pFrontHot: '2.3', pRearHot: '1.9', fork: 'C8 R10', shock: 'R12' },
      s1c: { pFrontHot: '2.3', pRearHot: '1.9', fork: 'C8 R10', shock: 'R10' } },
      tyreSets: [{ id: 't0', label: 'Pirelli SC1', since: d(-120), at: 1, bike: 'Yamaha R6' }] } }
  };
})();
