/* LNP Patent Desk: FTO workspace around LnpFto. Route: #fto[-<opinion id>][--p<profile id>][--d<quick|standard|deep>]
   Without an opinion id: pick a profile -> candidates -> depth -> run (progress, cancel, resume) and the saved opinions.
   With an opinion id: the opinion (risk matrix first, expiry timeline, one fold per patent with the claim chart). */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;
  if (!g.LnpLazyView) g.LnpLazyView = (function () {
    var reg = {};
    function one(n) {
      return reg[n] || (reg[n] = new Promise(function (res, rej) {
        var el;
        if (/\.css$/.test(n)) { el = document.createElement('link'); el.rel = 'stylesheet'; el.href = n; el.onload = el.onerror = function () { res(true); }; }
        else { el = document.createElement('script'); el.src = n; el.async = false; el.onload = function () { res(true); }; el.onerror = function () { delete reg[n]; rej({ code: 'script', message: 'nicht ladbar: ' + n }); }; }
        document.head.appendChild(el);
      }));
    }
    return function (id, need, real) {
      return function (host, route, App) {
        var inst = null, dead = false;
        need.reduce(function (p, n) { return p.then(function () { return one(n); }); }, Promise.resolve()).then(function () { if (!dead) inst = real(host, route, App); }).catch(function (e) {
          App.logError('view ' + id, e);
          if (!dead) g.LnpUI.set(host, g.LnpUI.h('div.page', null, g.LnpUI.h('p.notice.err', { text: 'Die Ansicht konnte nicht aufgebaut werden: ' + g.LnpUI.errText(e) })));
        });
        return { update: function (r) { return inst && inst.update ? inst.update(r) : false; }, destroy: function () { dead = true; try { if (typeof inst === 'function') inst(); else if (inst && inst.destroy) inst.destroy(); } catch (e) { App.logError('destroy ' + id, e); } } };
      };
    };
  })();

  var DEPTHS = [['quick', 'Schnell', 'Triage und Merkmalsanalyse der 5 wichtigsten Schriften. Ohne Unteransprüche, ohne Gegenprüfung.'],
    ['standard', 'Standard', 'Die 10 wichtigsten Schriften mit Unteransprüchen und Gegenprüfung aus Sicht des Patentinhabers.'],
    ['deep', 'Gründlich', 'Die 20 wichtigsten Schriften; auch abgelaufene, erloschene und widerrufene Rechte werden analysiert.']];
  var ROUTE = { structure: ['Struktur', 'Ein Lipid des Profils steht als Verbindung in der Schrift'], markush: ['Formel im Anspruch', 'Lipid offenbart und ein unabhängiger Claim enthält eine Formel'], text: ['Claim-Text', 'Treffer der aus dem Profil erzeugten Claim-Suchen'],
    seed: ['Schlüsselfamilie', 'Aus der Liste der bekannten Schlüsselfamilien'], semantic: ['KI-Suche', 'Treffer der semantischen Suche'], manual: ['Von Hand', 'Übergeben oder von Hand hinzugefügt'], family: ['Familie', 'Familienmitglied eines Treffers im Zielmarkt'] };
  var REASON = { dead: 'Nicht mehr in Kraft', triage_c: 'In der Triage als nicht einschlägig eingestuft', depth_limit: 'Wegen der gewählten Tiefe nicht analysiert', no_text: 'Kein Anspruchstext im Bestand', text_cut: 'Anspruchstext nicht im Datenpaket',
    wo: 'WO-Veröffentlichungen (ohne eigene Schutzwirkung)', market: 'Kein Zielmarkt gewählt', no_ai: 'Ohne Claude nicht analysiert' };
  var REASON_ORDER = ['depth_limit', 'no_ai', 'no_text', 'text_cut', 'triage_c', 'dead', 'market', 'wo'];
  var STATE = { done: ['Fertig', 'good'], running: ['Unterbrochen', 'warn'], paused: ['Angehalten', 'warn'], cancelled: ['Abgebrochen', 'hollow'] };
  var DEAD = { expired: 1, lapsed: 1, revoked: 1, withdrawn: 1, refused: 1 };
  var QCHK = { ok: 'Zitat im Anspruch gefunden', elided: 'Zitat mit Auslassung', approx: 'Zitat nur sinngemäß gefunden', fail: 'Zitat nicht im Anspruch gefunden', empty: 'kein Zitat' };

  function mount(host, route, App) {
    var K = g.LnpKit, C = g.LnpChart, F = g.LnpFto, St = g.LnpStore, D = g.LnpData;
    var dead = false, ctl = null, running = false, viewSeq = 0;
    var S = { profiles: [], pid: '', depth: 'standard', features: null, cands: null, checked: new Map(), manual: [], handed: null, record: null, ai: false };
    var page = h('div.page.k-page'); host.appendChild(page);

    function aiReady() { var A = g.LnpAI; try { return !!(A && A.available && A.available()); } catch (e) { return false; } }
    function abortRun() { if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } } ctl = null; running = false; }

    if (!F) {
      U.set(page, K.head('Freedom-to-Operate', 'Vorprüfung', 'gegen den Bestand'), h('p.notice.err', { text: 'Die Analyse-Skripte (engine/fto.js) sind in diesem Datenpaket nicht enthalten. Suche, Struktursuche und Merkliste arbeiten ohne sie.' }));
      return { destroy: function () { dead = true; } };
    }

    /* ============================================================ setup */
    function aiNotice() {
      if (S.ai) return null;
      return h('div.k-noai', { id: 'fto-noai', role: 'note' }, h('p.overline', { text: 'Claude nicht verfügbar' }),
        h('h2.k-h3', { text: 'Die Merkmalsanalyse braucht Claude im Artefakt' }),
        h('p', { text: 'Die Analyse vergleicht Anspruchsmerkmale mit dem Produktprofil. Das leistet Claude über die Artefakt-Funktion dieser Seite. Sie ist hier nicht verfügbar: Die Seite läuft außerhalb von claude.ai, die Funktion wurde nicht freigegeben oder die Nutzung ist für dieses Konto abgeschaltet.' }),
        h('p', { text: 'Ohne Claude arbeitet weiter: die Kandidatensuche über Struktur, Claim-Text und Schlüsselfamilien, Rechtsstand und geschätzter Ablauf je Schrift, das Suchprotokoll und der Export dieser Zusammenstellung. Es entsteht dann keine Triage und keine Merkmalsanalyse.' }));
    }
    function profileOf(id) { return S.profiles.filter(function (p) { return p.id === id; })[0] || null; }
    function setRoute() { R.go({ view: 'fto', params: { p: S.pid, d: S.depth === 'standard' ? '' : S.depth } }, { silent: true, replace: true }); }

    function showSetup(r) {
      var my = ++viewSeq;
      abortRun();
      S.depth = DEPTHS.some(function (d) { return d[0] === r.params.d; }) ? r.params.d : 'standard';
      U.set(page, K.head('Freedom-to-Operate', 'Vorprüfung gegen den Bestand,', 'Merkmal für Merkmal', 'Die Prüfung sucht zu einem Produktprofil die einschlägigen Schriften, vergleicht die unabhängigen Claims wörtlich mit dem Produkt und hält Rechtsstand, Ablauf und offene Fragen fest. Ergebnis ist eine Vorprüfung für das Gespräch mit der Patentanwaltskanzlei, kein Rechtsgutachten.'), K.busy('Profile und gespeicherte Prüfungen werden geladen'));
      var A = g.LnpAI;
      Promise.all([
        St.list('profiles').then(function (l) { return (l || []).filter(function (p) { return p && Array.isArray(p.lipids); }); }, function () { return []; }),
        St.get('settings', 'fto-selection').then(null, function () { return null; }),
        Promise.resolve(A && A.init ? A.init() : false).then(null, function () { return false; }),
        F.list().then(null, function () { return []; })
      ]).then(function (x) {
        if (dead || my !== viewSeq) return;
        S.profiles = x[0]; S.handed = x[1] && Array.isArray(x[1].pns) && x[1].pns.length ? x[1] : null; S.ai = aiReady();
        var want = r.params.p ? String(r.params.p) : '';
        if (want && want !== S.pid) { S.cands = null; S.features = null; S.checked.clear(); }
        S.pid = profileOf(want) ? want : (profileOf(S.pid) ? S.pid : (S.profiles[0] ? S.profiles[0].id : ''));
        drawSetup(x[3]);
      });
    }

    function drawSetup(saved) {
      var prodBox = h('div'), candBox = h('div'), depthBox = h('div'), startBox = h('div'), savedBox = h('div');
      U.set(page, K.head('Freedom-to-Operate', 'Vorprüfung gegen den Bestand,', 'Merkmal für Merkmal', 'Die Prüfung sucht zu einem Produktprofil die einschlägigen Schriften, vergleicht die unabhängigen Claims wörtlich mit dem Produkt und hält Rechtsstand, Ablauf und offene Fragen fest. Ergebnis ist eine Vorprüfung für das Gespräch mit der Patentanwaltskanzlei, kein Rechtsgutachten.'),
        aiNotice(),
        K.sec('Schritt 1', 'Produkt', null, prodBox), K.sec('Schritt 2', 'Kandidaten', null, candBox), K.sec('Schritt 3', 'Tiefe und Start', null, depthBox, startBox),
        K.sec('Archiv', 'Gespeicherte Prüfungen', null, savedBox));
      drawProduct(); drawCands(); drawDepth(); drawSaved(saved);

      function drawProduct() {
        U.clear(prodBox);
        if (!S.profiles.length) {
          prodBox.appendChild(h('div.empty.k-empty', null, h('h3', { text: 'Noch kein Produktprofil' }), h('p', { text: 'Die Prüfung braucht ein Profil mit den Lipiden und ihren Anteilen. Das Beispielprofil zeigt den Ablauf an einer generischen MC3-siRNA-Formulierung.' }),
            h('div.k-row', null, h('button.btn.primary', { type: 'button', onclick: useExample }, 'Beispielprofil verwenden'), h('a.btn', { href: '#produkte' }, U.icon('product'), 'Profil anlegen'))));
          return;
        }
        var sel = h('select.select', { id: 'fto-profile', 'aria-label': 'Produktprofil' });
        S.profiles.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.name || 'Profil' })); });
        sel.value = S.pid;
        sel.addEventListener('change', function () { S.pid = sel.value; S.cands = null; S.features = null; S.checked.clear(); setRoute(); drawProduct(); drawCands(); drawDepth(); });
        var p = profileOf(S.pid), lip = (p.lipids || []).filter(function (l) { return l.name || l.smiles; });
        prodBox.appendChild(h('div.k-row', null, sel, h('a.btn.sm', { href: R.build({ view: 'produkte', arg: p.id }) }, 'Profil bearbeiten')));
        prodBox.appendChild(K.kv([
          ['Lipide', lip.length ? lip.map(function (l) { return (l.name || 'eigenes Lipid') + (l.molPct != null ? ' ' + String(l.molPct).replace('.', ',') + ' mol-%' : ''); }).join(' · ') : 'keine Angabe'],
          ['Wirkstoff', (p.payload && p.payload.type) || 'keine Angabe'], ['Verfahren', (p.process && p.process.mixing) || 'keine Angabe'],
          ['Zielmärkte', (p.markets && p.markets.length ? p.markets : ['DE', 'EP', 'US']).join(', ')], ['Geändert', U.date(String(p.updated || '').slice(0, 10))]]));
        if (!lip.some(function (l) { return l.role === 'ionizable'; })) prodBox.appendChild(h('p.notice', { text: 'Im Profil fehlt ein ionisierbares Lipid. Die Struktursuche und die Formelprüfung haben dann keinen Ansatzpunkt.' }));
      }
      function useExample() {
        var ex = g.LnpProfile ? g.LnpProfile.clean(g.LnpProfile.example()) : null; if (!ex) return;
        ex.id = K.uid('pr'); ex.updated = new Date().toISOString();
        St.put('profiles', ex.id, ex).then(function () { S.profiles = [ex]; S.pid = ex.id; setRoute(); drawProduct(); drawCands(); drawDepth(); }, function (e) { U.toast('Das Beispiel konnte nicht gespeichert werden: ' + U.errText(e), { error: true }); });
      }

      /* -------------------------------------------------------- candidates */
      function features(p) {
        var key = 'pf-' + p.id, stamp = (p.updated || '') + '|' + (S.ai ? 'ai' : 'det');
        return St.get('settings', key).then(null, function () { return null; }).then(function (c) {
          if (c && c.stamp === stamp && c.features && c.features.schema_version === 'pf-1') return c.features;
          return F.normalizeProfile(p, { lang: 'de', signal: ctl ? ctl.signal : undefined }).then(function (f) { St.put('settings', key, { stamp: stamp, features: f }).catch(function () { }); return f; });
        });
      }
      function manualAll() { return (S.handed ? S.handed.pns : []).concat(S.manual); }
      function findCands() {
        var p = profileOf(S.pid); if (!p) return;
        ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var line = h('span', { text: S.ai ? 'Profil wird aufbereitet (ein Claude-Aufruf, falls es sich geändert hat)' : 'Profil wird aufbereitet' });
        U.set(candBox, h('div.k-busy', { role: 'status' }, h('span.spin'), line));
        var my = viewSeq;
        features(p).then(function (f) {
          S.features = f; if (dead || my !== viewSeq) return null;
          line.textContent = 'Kandidaten werden gesucht';
          return F.candidates(f, { max: 90, markets: p.markets && p.markets.length ? p.markets : undefined, manual: manualAll(), signal: ctl ? ctl.signal : undefined,
            onEvent: function (ev) { if (ev && ev.type === 'stage') line.textContent = ev.stage === 'structure' ? 'Struktursuche: ' + (ev.lipid || '') : ev.stage === 'text' ? 'Claim-Suche ' + (ev.query || '') : 'Kandidaten werden gesucht'; } });
        }).then(function (list) {
          if (!list || dead || my !== viewSeq) return;
          S.cands = list; S.record = list.record || null; S.checked.clear();
          list.forEach(function (c) { S.checked.set(c.p, c.auth !== 'WO'); });
          drawCands(); drawDepth();
        }).catch(function (e) {
          if (dead || my !== viewSeq) return;
          U.set(candBox, K.errBox(e, 'Die Kandidatensuche ist gescheitert'), h('p', null, h('button.btn', { type: 'button', onclick: findCands }, 'Erneut versuchen')));
        });
      }
      function addManual(input, msg) {
        var v = input.value.trim(); if (!v) return;
        D.byPn(v).then(function (p) { return p >= 0 ? D.patent(p) : null; }).then(function (pt) {
          if (!pt) { msg.textContent = 'Die Nummer „' + v + '“ ist nicht im Bestand.'; return; }
          input.value = ''; msg.textContent = '';
          if (S.cands) {
            if (!S.cands.some(function (c) { return c.p === pt.p; })) S.cands.unshift({ p: pt.p, pn: pt.pn, auth: pt.auth, kind: pt.kind, title: pt.title, assignee: pt.assignee, player: pt.player, status: pt.status, text: pt.text, routes: ['manual'], score: 1, why: ['von Hand hinzugefügt'] });
            S.checked.set(pt.p, true); S.manual.push(pt.pn); drawCands(); drawDepth();
          } else { if (S.manual.indexOf(pt.pn) < 0) S.manual.push(pt.pn); drawCands(); }
        }, function (e) { msg.textContent = U.errText(e); });
      }
      function drawCands() {
        U.clear(candBox);
        var addIn = h('input.input.mono', { id: 'fto-add', type: 'text', placeholder: 'Nummer, z. B. EP 3 532 103', autocomplete: 'off', 'aria-label': 'Schrift von Hand hinzufügen' }), addMsg = h('span.k-hint', { 'aria-live': 'polite' });
        var addForm = h('form.k-qrow.k-add', { onsubmit: function (ev) { ev.preventDefault(); addManual(addIn, addMsg); } }, addIn, h('button.btn', { type: 'submit' }, 'Hinzufügen'));
        if (S.handed) {
          var chips = h('div.k-chips'); S.handed.pns.slice(0, 30).forEach(function (pn) { chips.appendChild(h('a.tag', { href: App.patentHref(pn, { q: '' }), text: U.pnPretty(pn) })); });
          if (S.handed.pns.length > 30) chips.appendChild(h('span.tag', { text: '+ ' + (S.handed.pns.length - 30) }));
          candBox.appendChild(h('div.k-handed', { id: 'fto-handover' }, h('p.k-sub', null, h('b', { text: K.plural(S.handed.pns.length, 'Schrift', 'Schriften') }), ' übergeben aus ' + ({ suche: 'der Suche', patent: 'der Patentansicht', merkliste: 'der Merkliste', struktur: 'der Struktursuche' }[S.handed.from] || 'einer anderen Ansicht') + (S.handed.q ? ' („' + S.handed.q + '“)' : '') + '. Sie kommen zusätzlich in die Kandidatenliste.'),
            chips, h('button.btn.quiet.sm', { type: 'button', onclick: function () { St.remove('settings', 'fto-selection').catch(function () { }); S.handed = null; S.cands = null; drawCands(); drawDepth(); } }, U.icon('x'), 'Übergabe verwerfen')));
        }
        if (!profileOf(S.pid)) { candBox.appendChild(h('p.k-hint', { text: 'Erst ein Produktprofil wählen oder anlegen.' })); return; }
        if (!S.cands) {
          if (S.manual.length) candBox.appendChild(h('p.k-sub', { text: 'Von Hand hinzugefügt: ' + S.manual.map(U.pnPretty).join(', ') }));
          candBox.appendChild(h('div.k-row', null, h('button.btn.primary', { id: 'fto-find', type: 'button', onclick: findCands }, U.icon('search'), 'Kandidaten suchen'), addForm));
          candBox.appendChild(addMsg);
          candBox.appendChild(h('p.k-hint', { text: 'Gesucht wird im Browser: jedes Lipid exakt, als Teilstruktur und nach Ähnlichkeit, dazu aus dem Profil erzeugte Claim-Suchen, die Schlüsselfamilien und Familienmitglieder in den Zielmärkten.' + (S.ai ? ' Vorher bereitet Claude das Profil einmal auf.' : '') }));
          return;
        }
        var list = S.cands, tb = h('tbody'), count = h('b');
        function upd() { var n = 0; list.forEach(function (c) { if (S.checked.get(c.p)) n++; }); count.textContent = K.plural(n, 'Schrift', 'Schriften') + ' gewählt'; drawDepth(); }
        function setAll(fn) { list.forEach(function (c) { S.checked.set(c.p, !!fn(c)); }); drawCands(); drawDepth(); }
        list.forEach(function (c) {
          var cb = h('input.chk', { type: 'checkbox', checked: !!S.checked.get(c.p), 'aria-label': c.pn + ' prüfen', onchange: function () { S.checked.set(c.p, cb.checked); upd(); } });
          var why = (c.why || []);
          tb.appendChild(h('tr', null, h('td', null, cb), h('td', null, K.patentLink(c.pn, App)),
            h('td.t', null, h('span', { text: c.title || '' }), h('br'), h('span.faint', { text: c.player || c.assignee || '' })),
            h('td', null, U.statusPill(c.status), c.text ? null : h('span.tag.k-gap', { text: c.auth === 'WO' ? 'WO: nur Verweis' : 'kein Volltext', title: 'Ohne Anspruchstext ist keine Merkmalsanalyse möglich' })),
            h('td', null, h('span.cmpd-w', null, (c.routes || []).map(function (rt) { var x = ROUTE[rt] || [rt, '']; return h('span.tag' + (rt === 'structure' || rt === 'markush' ? '.k-clm' : ''), { text: x[0], title: x[1] }); }))),
            h('td.k-why', { title: why.join('\n') }, why.slice(0, 2).map(function (w) { return h('div', { text: w }); }), why.length > 2 ? h('div.faint', { text: '+ ' + (why.length - 2) + ' weitere Gründe' }) : null)));
        });
        candBox.appendChild(h('div.k-row.k-between', null,
          h('p.k-sub', null, h('b', { text: K.plural(list.length, 'Kandidat', 'Kandidaten') }), ' · ', count),
          h('span.k-row', null, h('button.btn.sm', { type: 'button', onclick: function () { setAll(function (c) { return c.auth !== 'WO'; }); } }, 'Alle'), h('button.btn.sm', { type: 'button', onclick: function () { setAll(function (c) { return c.text; }); } }, 'Nur mit Volltext'),
            h('button.btn.sm', { type: 'button', onclick: function () { setAll(function () { return false; }); } }, 'Keine'), h('button.btn.sm', { type: 'button', onclick: function () { S.cands = null; findCands(); } }, 'Neu suchen'))));
        candBox.appendChild(h('div.table-wrap.k-cands', null, h('table.data', null, h('thead', null, h('tr', null, ['', 'Nummer', 'Titel und Anmelder', 'Rechtsstand', 'Gefunden über', 'Warum'].map(function (t) { return h('th', { text: t }); }))), tb)));
        candBox.appendChild(h('div.k-row', null, addForm, addMsg));
        var rec = S.record;
        if (rec) {
          var rows = [];
          (rec.structure || []).forEach(function (s) { rows.push(['Struktur', (s.lipid || '') + ' · ' + (s.mode || ''), s.error ? 'Fehler: ' + s.error : U.num(s.compounds) + ' Verbindungen, ' + U.num(s.publications) + ' Schriften']); });
          (rec.text || []).forEach(function (t) { rows.push(['Claim-Text', t.query || '', t.error ? 'Fehler: ' + t.error : U.num(t.total) + ' Treffer, ' + U.num(t.taken) + ' übernommen']); });
          (rec.seed || []).forEach(function (s) { rows.push(['Schlüsselfamilien', 'Stufe ' + s.tier, s.error ? 'Fehler: ' + s.error : U.num(s.total) + ' Schriften']); });
          var t2 = h('table.data'), tb2 = h('tbody'); rows.forEach(function (r) { tb2.appendChild(h('tr', null, h('td', { text: r[0] }), h('td.mono.k-query', { text: r[1] }), h('td', { text: r[2] }))); });
          t2.appendChild(h('thead', null, h('tr', null, ['Weg', 'Abfrage', 'Ergebnis'].map(function (x) { return h('th', { text: x }); })))); t2.appendChild(tb2);
          candBox.appendChild(h('details.k-fold', null, h('summary', null, h('span', { text: 'Suchprotokoll: ' + rows.length + ' Abfragen, wörtlich' })), h('div.k-fold-body', null, h('div.table-wrap', null, t2), (rec.notes || []).map(function (n) { return h('p.k-hint', { text: n }); }))));
        }
        upd();
      }

      /* -------------------------------------------------------- depth, estimate, start */
      function selected() { return (S.cands || []).filter(function (c) { return S.checked.get(c.p); }); }
      function estimate(depth) {
        var d = F.DEPTH[depth], sel = selected(), live = sel.filter(function (c) { return c.text && c.auth !== 'WO' && (d.dead || !DEAD[c.status]); });
        var withText = sel.filter(function (c) { return c.text && c.auth !== 'WO'; }).length, tri = Math.ceil((d.dead ? live.length : withText) / 10), n = Math.min(d.n, live.length);
        return { sel: sel.length, live: d.dead ? live.length : withText, tri: tri, n: n, min: live.length ? tri + n + 1 : 0, max: live.length ? tri + n * (1 + (d.dep ? 1 : 0) + (d.red ? 1 : 0)) + 1 : 0, dep: d.dep, red: d.red };
      }
      function drawDepth() {
        U.clear(depthBox); U.clear(startBox);
        var seg = h('div.k-depth', { role: 'radiogroup', 'aria-label': 'Tiefe der Analyse' });
        DEPTHS.forEach(function (d) {
          seg.appendChild(h('button.k-depth-opt', { type: 'button', role: 'radio', 'aria-checked': S.depth === d[0] ? 'true' : 'false', onclick: function () { S.depth = d[0]; setRoute(); drawDepth(); } }, h('b', { text: d[1] }), h('span', { text: d[2] })));
        });
        depthBox.appendChild(seg);
        if (!S.cands) { startBox.appendChild(h('p.k-hint', { text: 'Die Schätzung der Claude-Aufrufe erscheint, sobald die Kandidaten feststehen.' })); return; }
        var e = estimate(S.depth);
        if (S.ai) {
          depthBox.appendChild(h('div.k-est', { id: 'fto-estimate' }, h('p', null, 'Voraussichtlich ', h('b.mono', { text: e.min === e.max ? String(e.min) : e.min + ' bis ' + e.max }), ' Aufrufe an Claude für ' + K.plural(e.sel, 'gewählte Schrift', 'gewählte Schriften') + '.'),
            h('ul.k-est-list', null,
              h('li', { text: 'Triage: bis zu ' + e.tri + (e.tri === 1 ? ' Aufruf' : ' Aufrufe') + ' für ' + e.live + ' Schriften mit Anspruchstext (je 10 pro Aufruf; Rechte, die nicht mehr in Kraft sind, entfallen)' }),
              h('li', { text: 'Merkmalsanalyse: ' + e.n + (e.n === 1 ? ' Aufruf' : ' Aufrufe') + ', einer je Schrift; die Triage kann Schriften als nicht einschlägig aussortieren, dann werden es weniger' }),
              e.dep ? h('li', { text: 'Unteransprüche: bis zu ' + e.n + ', nur für Schriften der höchsten Relevanz' }) : null,
              e.red ? h('li', { text: 'Gegenprüfung: bis zu ' + e.n + ', entfällt, wenn schon alle Merkmale als erfüllt gelten' }) : null,
              h('li', { text: 'Zusammenfassung: 1 Aufruf' })),
            h('p.k-hint', { text: 'Nicht eingerechnet: Liefert Claude eine ungültige Antwort, wird der Schritt genau einmal wiederholt. Sehr lange Anspruchssätze werden auf mehrere Aufrufe verteilt. Im ungünstigsten Fall verdoppelt sich die Zahl. Aufrufe laufen nacheinander; die Nutzung zählt auf das eigene Claude-Konto.' })));
        } else depthBox.appendChild(h('p.notice', { text: 'Ohne Claude werden 0 Aufrufe gesendet. Es entsteht eine Zusammenstellung aus Kandidaten, Rechtsstand und Ablauf; jede Schrift wird als „ohne Claude nicht analysiert“ geführt.' }));
        var btn = h('button.btn.primary.k-start', { id: 'fto-start', type: 'button', disabled: !e.sel, onclick: start }, U.icon('fto'), S.ai ? 'Analyse starten' : 'Ohne Claude zusammenstellen');
        startBox.appendChild(h('div.k-row', null, btn, h('span.k-hint', { text: e.sel ? 'Die Analyse läuft, solange diese Ansicht offen ist. Ein Abbruch lässt sich später fortsetzen.' : 'Mindestens eine Schrift wählen.' })));
      }
      function start() {
        var p = profileOf(S.pid), sel = selected(); if (!p || !sel.length || !S.features) return;
        runWith(function (o) { return F.run(S.features, Object.assign({ patents: sel, searchRecord: S.record, depth: S.depth, lang: 'de', markets: p.markets && p.markets.length ? p.markets : undefined }, o)); }, p.name);
      }

      /* -------------------------------------------------------- saved */
      function drawSaved(list) {
        U.clear(savedBox);
        if (!list || !list.length) { savedBox.appendChild(h('p.k-hint', { text: 'Noch keine Prüfung gespeichert. Fertige und unterbrochene Prüfungen erscheinen hier und lassen sich öffnen, fortsetzen und exportieren.' })); return; }
        var rows = h('div.rows.k-saved');
        list.forEach(function (o) {
          var st = STATE[o.state] || [o.state || '–', 'hollow'], del = null, armed = false;
          var worst = o.summary && o.summary.overall && (o.summary.overall.markets || []).reduce(function (a, m) { return F.maxRisk(a, m.risk); }, null);
          del = h('button.btn.quiet.sm', { type: 'button', onclick: function () {
            if (!armed) { armed = true; U.set(del, 'Wirklich löschen?'); setTimeout(function () { armed = false; if (del.isConnected) U.set(del, 'Löschen'); }, 4000); return; }
            F.remove(o.id).then(function () { return F.list(); }).then(drawSaved, function (e) { U.toast('Löschen gescheitert: ' + U.errText(e), { error: true }); });
          } }, 'Löschen');
          rows.appendChild(h('div.row', null,
            h('span.grow', null, o.state === 'done' ? h('a', { href: R.build({ view: 'fto', arg: o.id }) }, h('b', { text: o.title || o.id })) : h('b', { text: o.title || o.id }), h('br'),
              h('span.faint', { text: U.date(String(o.updated || o.created || '').slice(0, 10)) + ' · ' + ((DEPTHS.filter(function (d) { return d[0] === o.depth; })[0] || [0, o.depth])[1]) + (o.summary ? ' · ' + o.summary.patents + ' analysiert' : ' · ' + o.steps + ' Schritte gespeichert') + (o.error && o.error.message ? ' · ' + o.error.message : '') })),
            worst ? K.riskPill(worst) : null, h('span.pill.' + st[1], { text: st[0] }),
            o.state === 'done' ? h('a.btn.sm', { href: R.build({ view: 'fto', arg: o.id }) }, 'Öffnen') : h('button.btn.sm', { type: 'button', onclick: function () { runWith(function (x) { return F.resume(o.id, x); }, o.title); } }, 'Fortsetzen'), del));
        });
        savedBox.appendChild(rows);
      }
    }

    /* ============================================================ run */
    function runWith(call, title) {
      var my = ++viewSeq;
      abortRun();
      ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; running = true;
      var STG = [['status', 'Rechtsstand und Märkte'], ['triage', 'Triage der unabhängigen Claims'], ['patent', 'Merkmalsanalyse je Schrift'], ['synthesis', 'Zusammenfassung']];
      var stEl = {}, steps = h('ol.k-steps'), log = h('ol.k-log', { 'aria-live': 'polite' }), stream = h('pre.k-stream', { 'aria-hidden': 'true' }), calls = h('span.mono', { text: '0' }), headLine = h('span', { text: 'Analyse läuft' }), spin = h('span.spin');
      var cancel = h('button.btn', { type: 'button', onclick: function () { cancel.disabled = true; headLine.textContent = 'Wird abgebrochen …'; if (ctl) ctl.abort(); } }, 'Abbrechen'), after = h('div.k-row');
      STG.forEach(function (s) { var li = h('li', { data: { s: 'wait' } }, h('span.st', { text: 'wartet' }), h('span.k-steps-t', { text: s[1] }), h('span.info')); stEl[s[0]] = li; steps.appendChild(li); });
      function stage(id, state, info) { var li = stEl[id]; if (!li) return; li.dataset.s = state; li.children[0].textContent = state === 'run' ? 'läuft' : state === 'ok' ? 'fertig' : state === 'err' ? 'gestoppt' : 'wartet'; if (info != null) li.children[2].textContent = info; }
      function line(text, cls) { log.appendChild(h('li' + (cls ? '.' + cls : ''), null, h('time.mono', { text: new Date().toLocaleTimeString('de-DE') }), h('span', { text: text }))); while (log.children.length > 300) log.removeChild(log.firstChild); log.scrollTop = log.scrollHeight; }
      U.set(page, K.head('Freedom-to-Operate', title || 'Prüfung', ''),
        h('section.sec', null, h('div.k-run-head', null, spin, h('h2.sec-title', null, headLine), h('span.k-sub', null, 'Claude-Aufrufe: ', calls), cancel),
          steps, h('p.k-hint', { text: 'Jeder fertige Schritt ist gespeichert. Nach einem Abbruch, einem Neuladen oder einer Begrenzung der Nutzung setzt „Fortsetzen“ an dieser Stelle wieder an.' })),
        h('section.sec', null, h('h3.k-h3', { text: 'Verlauf' }), log, h('h3.k-h3', { text: 'Antwort des laufenden Schritts' }), stream), after);
      var SUB = { chart: 'Merkmalsanalyse', dependent: 'Unteransprüche', redteam: 'Gegenprüfung' };
      function onEvent(ev) {
        if (dead || my !== viewSeq || !ev) return;
        if (ev.type === 'stage') {
          if (stEl[ev.stage]) {
            var done = ev.total != null && ev.done >= ev.total;
            stage(ev.stage, done ? 'ok' : 'run', ev.total != null ? ev.done + ' von ' + ev.total + (ev.pn && !done ? ' · ' + U.pnPretty(ev.pn) : '') : null);
            if (ev.stage === 'patent' && ev.pn && !done) line(U.pnPretty(ev.pn) + ': Analyse beginnt');
          } else if (SUB[ev.stage]) { stream.textContent = ''; line(U.pnPretty(ev.pn) + ': ' + SUB[ev.stage] + (ev.parts > 1 ? ' (Teil ' + ev.part + ' von ' + ev.parts + ')' : '')); }
        } else if (ev.type === 'triage') line(U.pnPretty(ev.pn) + ': Relevanz ' + (ev.rel || '–') + (ev.why ? ' · ' + ev.why : ''));
        else if (ev.type === 'chart') line(U.pnPretty(ev.pn) + ': Merkmalsanalyse fertig, Risiko ' + K.riskLabel(ev.risk), 'ok');
        else if (ev.type === 'redteam') line(U.pnPretty(ev.pn) + ': Gegenprüfung fertig, Risiko ' + K.riskLabel(ev.risk && ev.risk.final), 'ok');
        else if (ev.type === 'dependent') line(U.pnPretty(ev.pn) + ': Unteransprüche geprüft', 'ok');
        else if (ev.type === 'text') { var t = String(ev.text || ''); stream.textContent = t.length > 900 ? '… ' + t.slice(-900) : t; }
        else if (ev.type === 'repair') line('Antwort ungültig (' + ev.errors + ' Fehler), Schritt wird einmal wiederholt', 'warn');
        else if (ev.type === 'warn') line(String(ev.message || ''), 'warn');
        else if (ev.type === 'usage') calls.textContent = String(ev.calls);
        else if (ev.type === 'resume') line('Gespeicherter Lauf gefunden: ' + ev.steps + ' fertige Schritte werden übernommen');
        else if (ev.type === 'resumed') line('Schritt aus dem Speicher übernommen');
      }
      function finish() { running = false; ctl = null; if (spin.parentNode) spin.parentNode.removeChild(spin); cancel.hidden = true; }
      call({ onEvent: onEvent, signal: ctl ? ctl.signal : undefined }).then(function (op) {
        if (dead || my !== viewSeq) return;
        finish(); R.go({ view: 'fto', arg: op.id });
      }, function (e) {
        if (dead || my !== viewSeq) return;
        finish();
        STG.forEach(function (s) { if (stEl[s[0]].dataset.s === 'run') stage(s[0], 'err'); });
        var cancelled = e && e.code === 'cancelled';
        headLine.textContent = cancelled ? 'Abgebrochen' : 'Angehalten';
        line(cancelled ? 'Abgebrochen. Die fertigen Schritte sind gespeichert.' : (e && (e.userMessage || e.message)) || 'Die Analyse wurde angehalten.', cancelled ? null : 'warn');
        if (!cancelled) after.appendChild(h('p.notice.err', { text: (e && (e.userMessage || e.message)) || 'Die Analyse wurde angehalten.' }));
        if (e && e.id) after.appendChild(h('button.btn.primary', { type: 'button', onclick: function () { runWith(function (x) { return F.resume(e.id, x); }, title); } }, 'Fortsetzen'));
        after.appendChild(h('button.btn', { type: 'button', onclick: function () { R.go({ view: 'fto', params: { p: S.pid, d: S.depth === 'standard' ? '' : S.depth } }); } }, 'Zurück zur Auswahl'));
      });
    }

    /* ============================================================ opinion */
    function showOpinion(id) {
      var my = ++viewSeq;
      abortRun();
      U.set(page, K.busy('Prüfung wird geladen'));
      Promise.resolve(F.load(id)).then(function (op) {
        if (dead || my !== viewSeq) return;
        if (op && op.patents) return drawOpinion(op);
        return St.get('opinions', id).then(null, function () { return null; }).then(function (head) {
          if (dead || my !== viewSeq) return;
          U.set(page, K.head('Freedom-to-Operate', 'Prüfung nicht abgeschlossen', ''), h('div.empty', null,
            h('h3', { text: head ? 'Diese Prüfung wurde unterbrochen' : 'Diese Prüfung gibt es nicht' }),
            h('p', { text: head ? 'Gespeichert sind ' + Object.keys(head.steps || {}).length + ' fertige Schritte. Fortsetzen nimmt die Analyse an dieser Stelle wieder auf.' : 'Unter dieser Adresse ist nichts gespeichert. Gespeicherte Prüfungen liegen im Speicher dieser Seite; in einem anderen Browser sind sie nur sichtbar, wenn die Artefakt-Datenbank verfügbar ist.' }),
            h('div.k-row', null, head ? h('button.btn.primary', { type: 'button', onclick: function () { runWith(function (x) { return F.resume(id, x); }, head.title); } }, 'Fortsetzen') : null, h('a.btn', { href: '#fto' }, 'Alle Prüfungen'))));
        });
      }).catch(function (e) { if (!dead && my === viewSeq) U.set(page, K.errBox(e, 'Die Prüfung konnte nicht geladen werden'), h('p', null, h('a.btn', { href: '#fto' }, 'Alle Prüfungen'))); });
    }
    function exportOp(op, fmt) {
      var text; try { text = F.render(op, fmt); } catch (e) { U.toast('Export gescheitert: ' + U.errText(e), { error: true }); return; }
      var name = 'fto-' + String((op.profile && op.profile.bezeichnung) || 'pruefung').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + String(op.finished || op.created || '').slice(0, 10) + '.' + fmt;
      U.saveFile(name, text, fmt === 'md' ? 'text/markdown;charset=utf-8' : fmt === 'html' ? 'text/html;charset=utf-8' : 'application/json');
    }
    function prose(text) { return h('div.k-prose', null, String(text || '').split(/\n{2,}/).filter(function (x) { return x.trim(); }).map(function (b) {
      var lines = b.split('\n').filter(function (l) { return l.trim(); });
      if (lines.length && lines.every(function (l) { return /^\s*([-*]|\d+[.)])\s+/.test(l); })) return h('ul', null, lines.map(function (l) { return h('li', { text: l.replace(/^\s*([-*]|\d+[.)])\s+/, '').replace(/\*\*/g, '') }); }));
      return h('p', { text: b.replace(/\*\*/g, '') });
    })); }
    function limits(op, id) { return h('aside.k-limits', { id: id, 'aria-label': 'Grenzen dieser Vorprüfung' }, String(op.limits || '').split('\n').filter(function (l) { return l.trim(); }).map(function (l, i) { return h(i === 0 ? 'p.k-limits-t' : 'p', { text: l }); })); }

    function drawOpinion(op) {
      var matrix = (op.matrix || []).slice().sort(function (a, b) { return F.riskRank(b.risk) - F.riskRank(a.risk) || String(a.expiry || '').localeCompare(String(b.expiry || '')); });
      var folds = {}, syn = op.synthesis, einzel = {}; if (syn) (syn.einzelbewertungen || []).forEach(function (x) { einzel[x.patent_id] = x; });
      function jump(pn) { var d = folds[pn]; if (!d) return; d.open = true; d.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      var depthName = (DEPTHS.filter(function (d) { return d[0] === op.depth; })[0] || [0, op.depth])[1];
      var head = h('header.page-head', null, h('p.overline', null, h('a', { href: '#fto', text: 'Freedom-to-Operate' }), ' / Vorprüfung'), h('h1.page-title', { text: op.title || 'FTO-Vorprüfung' }),
        h('p.lead', { text: 'Erstellt ' + U.date(String(op.finished || op.created || '').slice(0, 10)) + ' · Tiefe ' + depthName + ' · Märkte ' + (op.markets || []).join(', ') + ' · ' + K.plural((op.patents || []).length, 'Schrift analysiert', 'Schriften analysiert') + (op.run ? ' · ' + op.run.calls + ' Claude-Aufrufe' : '') + ' · Rechtsstand vom ' + U.date(op.statusSnapshot) }),
        h('div.k-row', null, [['md', 'Markdown'], ['html', 'HTML'], ['json', 'JSON']].map(function (f) { return h('button.btn.sm', { type: 'button', 'data-fmt': f[0], onclick: function () { exportOp(op, f[0]); } }, U.icon('download'), f[1]); })));

      // overall + matrix
      var over = K.stats(((op.overall && op.overall.markets) || []).map(function (m) { return [m.market === 'EP_UPC' ? 'EP / Einheitspatent' : m.market === 'DE' ? 'Deutschland' : m.market === 'US' ? 'USA' : m.market, K.riskPill(m.risk), (m.drivers || []).length ? 'Treiber: ' + m.drivers.map(U.pnPretty).join(', ') : 'kein treibendes Schutzrecht']; }));
      var mt = h('tbody');
      matrix.forEach(function (m) {
        mt.appendChild(h('tr', null, h('td', null, h('button.k-linkbtn.mono', { type: 'button', onclick: function () { jump(m.pn); }, text: U.pnPretty(m.pn) })), h('td', { text: (m.markets || []).join(', ') }), h('td', { text: m.rel || '–' }), h('td', null, K.riskPill(m.risk)),
          h('td', { text: K.litLabel(m.literal) }), h('td', null, h('span.pill.' + (m.dead ? 'hollow' : m.pending ? 'info' : 'good'), { text: m.dead ? 'nicht in Kraft' : m.pending ? 'anhängig' : 'in Kraft' }), h('div.faint.k-small', { text: m.status || '' })),
          h('td.mono', { text: m.expiry ? U.date(m.expiry) : 'unbekannt', title: m.expiryBasis || null }), h('td.k-small', { text: (m.flags || []).map(function (f) { return String(f).replace(/_/g, ' '); }).join(', ') })));
      });
      var matrixSec = K.sec('Ergebnis', 'Risikomatrix', null,
        op.aiUsed === false ? h('p.notice', { text: 'Ohne Claude erstellt: Diese Zusammenstellung enthält Recherche und Rechtsstand, aber keine Merkmalsanalyse.' }) : null,
        (op.overall && (op.overall.markets || []).length) ? over : null,
        matrix.length ? h('div.table-wrap', null, h('table.data.k-matrix', null, h('thead', null, h('tr', null, ['Schutzrecht', 'Markt', 'Relevanz', 'Risiko', 'Wortsinn', 'Rechtsstand', 'Ablauf (Schätzung)', 'Hinweise'].map(function (t) { return h('th', { text: t }); }))), mt)) : h('p.k-hint', { text: 'Keine Schrift wurde analysiert. Die Gründe stehen unter „Nicht analysiert“.' }),
        h('p.k-hint', { text: 'Risiko = das ungünstigere Ergebnis aus Merkmalsanalyse und Gegenprüfung; Untergrenzen setzt die App (wortsinngemäß erfüllt und erteilt = sehr hoch). Die Stufe ist eine Arbeitshypothese.' }));

      // timeline
      var tlBox = h('div');
      if (matrix.length) C.timeline(tlBox, { from: K.todayIso(), label: 'Geschätzter Ablauf der analysierten Schutzrechte', rows: matrix.map(function (m) { return { label: U.pnPretty(m.pn), href: App.patentHref(m.pn, { q: '' }), end: m.expiry || null, lv: K.riskLevel(m.risk), risk: K.riskLabel(m.risk), dead: m.dead, pending: m.pending, note: m.expiryBasis || '' }; }) });
      var tlSec = matrix.length ? K.sec('Zeit', 'Wie lange die Rechte laufen', null, h('p.k-note', { text: 'Balken von heute bis zum geschätzten Ablauf, Farbe nach Risikostufe, gestrichelt = Anmeldung noch nicht erteilt. Ablauf = Anmeldetag plus 20 Jahre, US mit Laufzeitanpassung; Verzichte, Gebührenausfälle und Schutzzertifikate sind nicht berücksichtigt.' }),
        h('div.k-legend', null, [0, 1, 2, 3, 4].map(function (i) { return h('span', null, h('i.k-lv', { data: { lv: String(i) } }), ['sehr gering', 'gering', 'mittel', 'hoch', 'sehr hoch'][i]); }), h('span', null, h('i.k-lv', { data: { lv: '-1' } }), 'nicht beurteilbar')), tlBox) : null;

      // synthesis
      var synSec = syn ? K.sec('Zusammenfassung', 'Was Claude aus den Einzelergebnissen zieht', null, prose(syn.zusammenfassung),
        syn.app && (syn.app.flags || []).length ? h('p.notice', { text: 'Prüfhinweise der App zur Zusammenfassung: ' + syn.app.flags.join(', ').replace(/_/g, ' ') }) : null,
        syn.querschnitt ? h('div', null, h('h3.k-h3', { text: 'Übergreifende Punkte' }), prose(syn.querschnitt)) : null) : (op.synthesisFailed ? K.sec('Zusammenfassung', 'Nicht erstellt', null, h('p.notice.err', { text: 'Die Zusammenfassung ist gescheitert: ' + (op.synthesisFailed.message || '') })) : null);

      // per patent
      var patSec = K.sec('Einzelergebnisse', 'Merkmalsanalyse je Schutzrecht', null);
      var order = {}; matrix.forEach(function (m, i) { order[m.pn] = i; });
      (op.patents || []).slice().sort(function (a, b) { return (order[a.pn] || 0) - (order[b.pn] || 0); }).forEach(function (e, idx) {
        var ch = e.chart, rt = e.redteam, da = e.dependent, gs = (ch && ch.gesamt) || {};
        var body = h('div.k-pat-body');
        body.appendChild(K.kv([['Anmelder', e.assignee], ['Bewertet für', (e.markets || []).join(', ') + (e.jurisdiction ? ' (' + e.jurisdiction + ')' : '')], ['Relevanz', (e.rel || '–') + (e.relWhy ? ': ' + e.relWhy : '')], ['Gefunden über', (e.why || []).join(' · ')],
          ['Rechtsstand', (e.status || '') + (e.right && (e.right.notes || []).length ? ' · ' + e.right.notes.join(' · ') : '')], ['Ablauf', e.expiry && e.expiry.date ? U.date(e.expiry.date) + ' (Schätzung)' + (e.expiry.basis ? ' · ' + e.expiry.basis : '') : 'unbekannt'],
          ['Risiko', h('span.k-row', null, K.riskPill(e.risk && e.risk.final), h('span.faint.k-small', { text: 'Analyse: ' + K.riskLabel(e.risk && e.risk.b) + ' · Gegenprüfung: ' + (e.risk && e.risk.e ? K.riskLabel(e.risk.e) : '–') }))],
          ['Hinweise', (e.flags || []).map(function (f) { return String(f).replace(/_/g, ' '); }).join(', ')]]));
        body.appendChild(h('p', null, h('a.btn.sm', { href: App.patentHref(e.pn, { q: '' }) }, 'Schrift öffnen')));
        if (e.failed) body.appendChild(h('p.notice.err', { text: 'Analyse gescheitert: ' + (e.failed.message || e.failed.code || '') + '. Die Schrift gilt als nicht beurteilbar.' }));
        if (einzel[e.pn]) body.appendChild(h('div', null, h('h4.k-h4', { text: 'Kurzfazit' }), h('p', { text: einzel[e.pn].kurzfazit || '' }), einzel[e.pn].text ? prose(einzel[e.pn].text) : null));
        if (ch && ch.app && (ch.app.notes || []).length) body.appendChild(h('div', null, h('h4.k-h4', { text: 'Prüfungen der App' }), h('ul.k-list', null, ch.app.notes.concat(rt && rt.app ? (rt.app.notes || []) : []).map(function (n) { return h('li', { text: n }); }))));
        ((ch && ch.claims) || []).forEach(function (c) {
          var a = c.app || {}, tb = h('tbody');
          (c.merkmale || []).forEach(function (m) {
            var x = m.app || {}, verified = x.verified === true || x.quote === 'ok', au = m.auslegung || {}, extra = [];
            if (au.weite_auslegung || au.enge_auslegung) extra.push('Auslegung: weit = ' + (au.weite_auslegung || '–') + '; eng = ' + (au.enge_auslegung || '–'));
            if (au.definition_quote) extra.push('Definition' + (au.definition_para ? ' [' + au.definition_para + ']' : '') + ': „' + au.definition_quote + '“');
            if (m.annahme) extra.push('Annahme: ' + m.annahme);
            if (m.klaerung) extra.push('Zu klären: ' + m.klaerung);
            if (x.redteam) extra.push('Gegenprüfung: ' + x.redteam);
            if (m.markush) extra.push('Formelprüfung: ' + String(m.markush.app_ergebnis || m.markush.ergebnis || '').replace(/_/g, ' ') + (m.markush.geruest ? ' · Gerüst: ' + m.markush.geruest : ''));
            tb.appendChild(h('tr', null, h('td.mono', { text: m.feature_id || '' }), h('td.k-quote', null, h('q', { text: m.claim_quote || '' })),
              h('td', null, h('span', { text: m.product_value == null ? '–' : String(m.product_value) }), (m.product_refs || []).length ? h('span.faint.mono.k-small', { text: ' [' + m.product_refs.join(', ') + ']' }) : null),
              h('td', null, K.verdictPill(x.verdict || m.verdict), x.forced ? h('div.faint.k-small', { text: 'von der App gesetzt (' + String(x.forced).replace(/_/g, ' ') + '); Claude: ' + String(m.verdict || '').replace(/_/g, ' ') }) : null,
                h('div.k-small.k-reason', { text: m.begruendung || '' }), extra.map(function (t) { return h('div.k-small.faint', { text: t }); })),
              h('td.k-verif', null, verified ? h('span.k-ok', { title: QCHK.ok }, U.icon('check'), h('span', { text: 'geprüft' })) : h('span.k-nok', { title: QCHK[x.quote] || 'Zitat nicht geprüft' }, U.icon('x'), h('span', { text: x.quote === 'elided' ? 'Auslassung' : x.quote === 'approx' ? 'sinngemäß' : x.quote === 'empty' ? 'kein Zitat' : 'nicht belegt' })))));
          });
          body.appendChild(h('div.k-claim', null, h('h4.k-h4', null, 'Anspruch ' + c.claim_no, c.kategorie ? h('span.faint', { text: ' · ' + String(c.kategorie).replace(/_/g, ' ') }) : null),
            h('p.k-sub', null, 'Ergebnis aus den Merkmalen: ', h('b', { text: K.litLabel(a.literal_final || a.literal || c.literal_ergebnis) }), a.literal_model && a.literal_model !== a.literal ? h('span.faint', { text: ' (Claude: ' + K.litLabel(a.literal_model) + ')' }) : null, (a.flags || []).length ? h('span.faint', { text: ' · ' + a.flags.join(', ').replace(/_/g, ' ') }) : null),
            h('div.table-wrap', null, h('table.data.k-chart-t', null, h('thead', null, h('tr', null, ['Merkmal', 'Anspruchswortlaut (Zitat)', 'Produkt', 'Bewertung', 'Zitat'].map(function (t) { return h('th', { text: t }); }))), tb)),
            (c.aequivalenz || []).length ? h('div', null, h('h5.k-h5', { text: 'Fragen zur Äquivalenz für die anwaltliche Prüfung (hier nicht entschieden)' }), h('ul.k-list', null, c.aequivalenz.map(function (q) { return h('li', { text: (q.feature_id || '') + ': Austauschmittel ' + (q.austauschmittel || '–') + '. ' + (q.begruendung || '') }); }))) : null));
        });
        if (da && (da.unteransprueche || []).length) {
          var tb3 = h('tbody');
          da.unteransprueche.forEach(function (u) { (u.zusatzmerkmale || []).forEach(function (z, i) { tb3.appendChild(h('tr', null, h('td.mono', { text: i ? '' : String(u.claim_no) }), h('td.k-quote', null, h('q', { text: z.claim_quote || '' })), h('td', null, K.verdictPill((z.app && z.app.verdict) || z.verdict), h('div.k-small', { text: z.begruendung || '' })), h('td', { text: i ? '' : String((u.app && u.app.ketten_ergebnis) || u.ketten_ergebnis || '').replace(/_/g, ' ') }))); }); });
          body.appendChild(h('div.k-claim', null, h('h4.k-h4', { text: 'Unteransprüche (Rückzugspositionen)' }), h('div.table-wrap', null, h('table.data.k-chart-t', null, h('thead', null, h('tr', null, ['Anspruch', 'Zusatzmerkmal (Zitat)', 'Bewertung', 'Kette'].map(function (t) { return h('th', { text: t }); }))), tb3))));
        }
        if (rt) {
          var at = [];
          (rt.claims || []).forEach(function (rc) { (rc.angriffe || []).forEach(function (a2) { at.push('Anspruch ' + rc.claim_no + ' ' + (a2.feature_id || '') + ': ' + (a2.argument_patentinhaber || '') + (a2.gegenargument_nutzer ? ' · Dagegen: ' + a2.gegenargument_nutzer : '') + ' · Ergebnis: ' + String(a2.ergebnis || '').replace(/_/g, ' ')); }); });
          body.appendChild(h('div.k-claim', null, h('h4.k-h4', { text: 'Gegenprüfung aus Sicht des Patentinhabers' }), h('p.k-sub', null, 'Risiko nach Gegenprüfung: ', K.riskPill(rt.revidiert && rt.revidiert.risiko), rt.revidiert && rt.revidiert.begruendung ? h('span', { text: ' ' + rt.revidiert.begruendung }) : null),
            at.length ? h('ul.k-list', null, at.map(function (t) { return h('li', { text: t }); })) : h('p.k-hint', { text: 'Kein tragfähiger Angriff gefunden.' })));
        }
        var qs = (gs.offene_fragen || []).slice();
        if (qs.length) body.appendChild(h('div', null, h('h4.k-h4', { text: 'Fragen an die Kanzlei' }), h('ul.k-list', null, qs.map(function (q) { return h('li', { text: q }); }))));
        if ((gs.umgehungsloesungen || []).length) body.appendChild(h('div', null, h('h4.k-h4', { text: 'Ansätze zur Umgehung (technische Hypothesen)' }), h('ul.k-list', null, gs.umgehungsloesungen.map(function (u) { return h('li', { text: (u.feature_id || '') + ': ' + (u.aenderung || '') + (u.vorbehalt ? ' · Vorbehalt: ' + u.vorbehalt : '') }); }))));
        var d = h('details.k-pat', { open: idx === 0 }, h('summary', null, h('span.mono.k-pat-pn', { text: U.pnPretty(e.pn) }), h('span.k-pat-t', { text: e.title || '' }), K.riskPill(e.risk && e.risk.final)), body);
        folds[e.pn] = d; patSec.appendChild(d);
      });
      if (!(op.patents || []).length) patSec.appendChild(h('p.k-hint', { text: 'Keine Schrift wurde analysiert.' }));

      // not charted
      var groups = {}; (op.notCharted || []).forEach(function (n) { (groups[n.reason] = groups[n.reason] || []).push(n); });
      var ncSec = (op.notCharted || []).length ? K.sec('Lücken', 'Nicht analysiert, und warum', null, h('p.k-note', { text: 'Diese Schriften gehören zur Auswahl, haben aber keine Merkmalsanalyse. Sie sind damit nicht entlastet.' })) : null;
      if (ncSec) REASON_ORDER.concat(Object.keys(groups).filter(function (k) { return REASON_ORDER.indexOf(k) < 0; })).forEach(function (k) {
        if (!groups[k]) return;
        var tbn = h('tbody'); groups[k].forEach(function (n) { tbn.appendChild(h('tr', null, h('td', null, K.patentLink(n.pn, App)), h('td.t', { text: n.title || '' }), h('td', { text: n.status || '' }), h('td.mono', { text: n.expiry ? U.date(n.expiry) : '–' }), h('td.k-small', { text: n.text || '' }))); });
        ncSec.appendChild(h('details.k-fold', { open: k === 'depth_limit' || k === 'no_ai' }, h('summary', null, h('span', { text: (REASON[k] || k) + ' (' + groups[k].length + ')' })), h('div.k-fold-body', null, h('div.table-wrap', null, h('table.data', null, h('thead', null, h('tr', null, ['Nummer', 'Titel', 'Rechtsstand', 'Ablauf', 'Grund'].map(function (t) { return h('th', { text: t }); }))), tbn)))));
      });

      // next steps
      var steps = syn && (syn.naechste_schritte || []).length ? K.sec('Weiter', 'Nächste Schritte', null, h('ol.k-next', null, syn.naechste_schritte.slice().sort(function (a, b) { return (a.prioritaet || 0) - (b.prioritaet || 0); }).map(function (s) { return h('li', null, h('b', { text: s.schritt || '' }), s.warum ? h('span', { text: ' ' + s.warum }) : null); })),
        (syn.offene_fragen || []).length ? h('div', null, h('h3.k-h3', { text: 'Offene Fragen' }), h('ul.k-list', null, syn.offene_fragen.map(function (q) { return h('li', { text: q }); }))) : null) : null;
      var warn = (op.warnings || []).length ? K.sec('Lauf', 'Hinweise aus der Analyse', null, h('ul.k-list', null, op.warnings.map(function (w) { return h('li', { text: w }); }))) : null;

      var endLimits = limits(op, 'fto-limits-end');
      var topLimits = h('aside.k-limits.short', { id: 'fto-limits', 'aria-label': 'Hinweis' }, h('p', null, h('b', { text: 'Vorprüfung, kein Rechtsgutachten. ' }), 'Automatisiert erstellt, ersetzt nicht die Prüfung durch eine Patentanwältin oder einen Patentanwalt. Rechtsstand vom ' + U.date(op.statusSnapshot) + ', Laufzeiten sind Schätzungen, generische Ansprüche können mehr erfassen als hier gefunden wurde.'),
        h('button.btn.sm', { type: 'button', onclick: function () { endLimits.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, 'Alle Grenzen lesen'));
      U.set(page, head, topLimits, matrixSec, tlSec, synSec, patSec, ncSec, steps, warn, endLimits);
    }

    /* ============================================================ routing */
    function show(r) { if (r.arg) showOpinion(r.arg); else showSetup(r); }
    show(route);
    var offCaps = App.on('caps', function () { if (!dead && !running && !App.route.arg && !S.ai && aiReady()) showSetup(App.route); });
    return {
      update: function (r) { show(r); return true; },
      destroy: function () { dead = true; abortRun(); offCaps(); K.tip.hide(); }
    };
  }
  g.LnpApp.registerView({ id: 'fto', title: 'FTO', icon: 'fto', mount: g.LnpLazyView('fto', ['app/views/views.css', 'app/views/lib/kit.js', 'app/views/lib/chart.js'], mount) });
})(window);
