/* LNP Patent Desk: system view. Route: #system[--xtest] (xtest starts the self-test)
   Corpus snapshot and coverage from the manifest, source dates with a staleness warning for the legal status,
   engine diagnostics, AI usage log, a self-test, the limits statement and a short method description. */
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

  var MODE = { worker: 'eigener Worker', blob: 'Blob-Worker', main: 'Hauptthread' };
  var SIZE_DE = { chemistry: 'Strukturen', images: 'Formelbilder', 'claim text': 'Anspruchstext', 'patent table': 'Patenttabelle', definitions: 'Definitionen', postings: 'Suchindex (Wörter)', positions: 'Suchindex (Positionen)', web: 'Seite und Skripte', status: 'Rechtsstand', meta: 'Filterspalten', 'index other': 'Suchindex (übrige)', seed: 'Stammdaten' };
  var LIMITS_FALLBACK = ['Diese Seite ist ein Recherche- und Vorprüfungswerkzeug und keine Rechtsberatung. Sie ersetzt nicht die Prüfung durch eine Patentanwältin oder einen Patentanwalt.',
    'Der Bestand ist fachlich eingegrenzt (LNP- und Lipid-Feld, EP, US und WO). Schutzrechte außerhalb dieser Eingrenzung sind nicht erfasst.',
    'Generische Ansprüche (Markush) können Strukturen erfassen, die im Bestand nicht einzeln indexiert sind.', 'Rechtsstand und Ablauf sind Momentaufnahmen und Schätzungen.'];

  function mount(host, route, App) {
    var K = g.LnpKit, C = g.LnpChart, D = g.LnpData, S = g.LnpSearch, Ch = g.LnpChem, St = g.LnpStore;
    var M = App.manifest || {}, c = M.counts || {}, snap = M.snapshots || {}, cut = M.cut || {}, dead = false;
    var covBox = h('div', null, K.busy('Abdeckung wird gezählt')), engBox = h('div'), aiBox = h('div'), testBox = h('div.k-tests'), errBox = h('div');
    var testBtn = h('button.btn.primary', { id: 'sys-test', type: 'button', onclick: runTests }, U.icon('check'), 'Selbsttest starten');

    /* ---------------------------------------------------------- sources and staleness */
    var regDays = K.daysSince(snap.ep_register), builtDays = K.daysSince(String(M.built || '').slice(0, 10));
    var stale = regDays == null ? h('p.notice.err', { id: 'sys-stale', text: 'Das Datum des Rechtsstands ist unbekannt. Jede Angabe zum Rechtsstand ist als ungeprüft zu behandeln.' })
      : regDays > 180 ? h('p.notice.err', { id: 'sys-stale', text: 'Der Rechtsstand (EP-Register) ist ' + regDays + ' Tage alt, also älter als sechs Monate. Die FTO-Prüfung behandelt deshalb jeden Rechtsstand als ungeprüft und jedes Recht als in Kraft. Vor jeder Entscheidung den Stand im Register nachsehen.' })
        : regDays > 45 ? h('p.notice', { id: 'sys-stale', text: 'Der Rechtsstand (EP-Register) ist ' + regDays + ' Tage alt. Erteilungen, Einsprüche, Widerrufe und erloschene Rechte nach dem ' + U.date(snap.ep_register) + ' fehlen. Für einzelne Schriften führt der Registerlink in der Patentansicht zum aktuellen Stand.' })
          : h('p.k-ok-note', { id: 'sys-stale', text: 'Der Rechtsstand (EP-Register) ist ' + regDays + ' Tage alt.' });
    var sources = K.kv([
      ['Datenpaket erstellt', U.date(String(M.built || '').slice(0, 10)) + (builtDays != null ? ' · vor ' + builtDays + ' Tagen' : '')],
      ['Rechtsstand EP', 'EP-Register, Stand ' + U.date(snap.ep_register) + ' · erloschene Staaten zusätzlich aus den Patentschriften'],
      ['Rechtsstand US', 'gerechnet aus Anmeldetag und Laufzeitanpassung; Aufrechterhaltungsgebühren und Verzichtserklärungen sind nicht geprüft'],
      ['EP-Volltexte', 'EPO Publication Server, abgerufen bis ' + U.date(snap.ep_text)], ['US-Volltexte', 'USPTO Patent Public Search, abgerufen bis ' + U.date(snap.us_text)],
      ['Strukturen und Feldabgrenzung', 'SureChEMBL, Stand ' + U.date(snap.surechembl) + ' (CC BY 4.0)'], ['Korpus zusammengestellt', U.date(String(snap.corpus || '').slice(0, 10))]]);

    /* ---------------------------------------------------------- coverage */
    function coverage() {
      var auths = ['EP', 'US', 'WO'];
      Promise.all(auths.map(function (a) { return S.search('', { filters: { auth: [a] }, limit: 1, facets: true, snippets: false }).then(function (r) { return r; }, function () { return null; }); })).then(function (res) {
        if (dead) return;
        var tb = h('tbody'), tot = [0, 0, 0];
        auths.forEach(function (a, i) {
          var r = res[i]; if (!r) { tb.appendChild(h('tr', null, h('td', { text: a }), h('td', { colspan: '5', text: 'nicht gezählt' }))); return; }
          var f = r.facets || {}, st = f.status || {}, withSt = 0; Object.keys(st).forEach(function (k) { if (k && k !== 'unknown') withSt += st[k]; });
          var live = st.granted || 0;
          tot[0] += r.total; tot[1] += f.text || 0; tot[2] += withSt;
          tb.appendChild(h('tr', null, h('td', null, h('a', { href: R.build({ view: 'suche', params: { a: [a] } }), text: a })), h('td.num', { text: U.num(r.total) }), h('td.num', { text: U.num(f.text || 0) }),
            h('td.num', { text: r.total ? ((f.text || 0) / r.total * 100).toFixed(1).replace('.', ',') + ' %' : '–' }), h('td.num', { text: a === 'WO' ? '–' : U.num(withSt) }), h('td.num', { text: a === 'WO' ? '–' : U.num(live) })));
        });
        tb.appendChild(h('tr.k-total', null, h('td', { text: 'Summe' }), h('td.num', { text: U.num(tot[0]) }), h('td.num', { text: U.num(tot[1]) }), h('td.num', { text: tot[0] ? (tot[1] / tot[0] * 100).toFixed(1).replace('.', ',') + ' %' : '–' }), h('td.num', { text: U.num(tot[2]) }), h('td')));
        U.set(covBox, h('div.table-wrap', null, h('table.data.k-cov', null, h('thead', null, h('tr', null, ['Amt', 'Schriften', 'mit Anspruchstext', 'Anteil', 'mit Rechtsstand', 'davon erteilt'].map(function (t) { return h('th', { text: t }); }))), tb)));
      });
    }
    var idxC = (M.idx && M.idx.counts) || {};
    var facts = K.stats([
      ['Schriften', U.num(c.patents), U.num(c.families) + ' Familien'],
      ['Mit Anspruchstext', U.num(c.fulltext), 'von ' + U.num(c.fulltextAvailable) + ' abgerufenen Volltexten'],
      ['Claims', U.num(c.claims), idxC.claimsEn != null ? U.num(idxC.claimsEn) + ' englisch, ' + U.num(idxC.claimsDe) + ' deutsch · ' + U.num(idxC.indep) + ' unabhängig' : null],
      ['Verbindungen', U.num(c.compounds), M.chem ? 'in ' + U.num(M.chem.nPat) + ' Schriften' : 'nicht enthalten'],
      ['Schlüsselfamilien', U.num(c.seed_present) + ' von ' + U.num(c.seed_expected), U.num(c.seed_fulltext) + ' mit Anspruchstext'],
      ['Formelbilder', M.img ? U.num(M.img.images) : '0', M.img ? 'aus ' + U.num(M.img.patents) + ' EP-Schriften' + (M.img.cut ? ', ' + U.num(M.img.cut) + ' gekürzt' : '') : 'nicht enthalten']]);
    var textShare = c.patents ? c.fulltext / c.patents * 100 : 0;
    var gaps = h('ul.k-list', null,
      h('li', { text: 'Anspruchstext liegt für ' + U.num(c.fulltext) + ' von ' + U.num(c.patents) + ' Schriften vor (' + textShare.toFixed(1).replace('.', ',') + ' %). Alle anderen sind über Titel, Abstract, Anmelder, Klassen, Rechtsstand und Strukturen auffindbar, aber nicht über ihre Claims, und sie können nicht analysiert werden.' }),
      h('li', { text: 'Abgerufen werden je EP-Anmeldung die jüngste B-Schrift (sonst die A-Schrift ab Anmeldejahr 2017) und jedes US-Patent; US-Offenlegungen nur ohne erteiltes Patent und ab 2018. WO-Schriften haben nie Anspruchstext: dort zählen die EP- und US-Familienmitglieder.' }),
      h('li', { text: cut.applied ? 'Wegen der Größengrenze des Datenpakets (' + U.num(cut.budgetMb) + ' MB) fehlt der Anspruchstext von ' + U.num((cut.text || {}).cut) + ' abgerufenen Schriften (' + U.num((cut.text || {}).claimsCut) + ' Claims) und die Definitionen von ' + U.num((cut.defs || {}).cut) + ' Schriften. Gekürzt wird zuerst das weitere Umfeld, älteste zuerst; Schlüsselfamilien bleiben vollständig.' + (cut.firstCut ? ' Erste gekürzte Schrift: ' + cut.firstCut.pn + '.' : '')
        : 'Keine Kürzung: Alle ' + U.num((cut.text || {}).available != null ? cut.text.available : c.fulltextAvailable) + ' abgerufenen Volltexte sind im Datenpaket.' }),
      h('li', { text: 'Definitionen aus der Beschreibung liegen für ' + U.num(c.withDefs) + ' Schriften vor (Auszug, höchstens 8.000 Zeichen je Schrift). Die vollständige Beschreibung ist nicht enthalten.' }),
      h('li', { text: 'Formelbilder gibt es nur für EP-Schriften. US-Ansprüche mit Formeln enthalten an der Stelle einen Platzhalter; die Analyse meldet dann „Formel fehlt“.' }));
    var sizeBox = h('div');
    if (M.sizes) C.hbars(sizeBox, { unit: 'Bytes', color: 'var(--s1)', rows: Object.keys(M.sizes).sort(function (a, b) { return M.sizes[b] - M.sizes[a]; }).map(function (k) { return { label: SIZE_DE[k] || k, value: Math.round(M.sizes[k] / 1024), title: U.bytes(M.sizes[k]) }; }) });

    /* ---------------------------------------------------------- engines */
    function drawEngines() {
      var d = App.diag(), eng = d.engines || {}, sd = St.diag ? St.diag() : {};
      Promise.all([Promise.resolve(D.diag()).then(null, function () { return null; }), Promise.resolve(S.diag ? S.diag() : null).then(null, function () { return null; }), App.chemUsed ? Promise.resolve(Ch.diag()).then(null, function () { return null; }) : Promise.resolve(null)]).then(function (x) {
        if (dead) return;
        var dd = x[0] || eng.data || {}, sdg = x[1] || {}, cd = x[2], se = eng.search || {};
        var chemCell = cd ? (MODE[cd.mode] || cd.mode) + ', ' + cd.workers + ' Worker · ' + U.num(cd.n) + ' Verbindungen · geladen in ' + U.num(Math.round(((cd.ms || {}).fetch || 0) + ((cd.ms || {}).load || 0) + ((cd.ms || {}).init || 0))) + ' ms · OpenChemLib ' + (cd.ocl || '')
          : h('span', null, 'noch nicht geladen ', h('button.btn.sm', { type: 'button', onclick: function () { App.chemUsed = true; U.toast('Strukturdaten werden geladen'); Ch.init().then(drawEngines, function (e) { U.toast('Strukturdaten nicht ladbar: ' + U.errText(e), { error: true }); }); } }, 'Jetzt laden'));
        U.set(engBox, K.kv([
          ['Patenttabelle', (MODE[dd.mode] || dd.mode || '–') + ' · entpackt mit ' + (dd.gzip === 'native' ? 'DecompressionStream' : 'fflate') + (dd.fetches != null ? ' · ' + dd.fetches + ' Dateien, ' + U.bytes(dd.bytes || 0) + ' geladen' : '')],
          ['Suchindex', (MODE[se.mode] || se.mode || '–') + (se.ms != null ? ' · bereit nach ' + U.num(Math.round(se.ms)) + ' ms' : '') + (sdg && sdg.cache ? ' · ' + sdg.cache.postShards + ' Wort- und ' + sdg.cache.textShards + ' Textblöcke im Speicher (' + U.bytes(sdg.cache.bytes || 0) + ')' : '')],
          ['Strukturen', chemCell],
          ['Dateiformat', d.enc === 'b64' ? 'Base64-Text (Ersatzformat)' : 'binär (gzip)'],
          ['Speicher', ({ db: 'Artefakt-Datenbank: Profile, Prüfungen und Merkliste folgen dem Konto', local: 'Browser-Speicher: nur in diesem Browser auf diesem Gerät', memory: 'nur diese Sitzung: beim Schließen geht alles verloren' })[App.store.backend] + (sd.readonly ? ' · Schreiben in die Datenbank wurde abgelehnt, Änderungen bleiben lokal' : '')],
          ['Claude (Analyse, KI-Suche)', d.aiAvailable ? 'verfügbar' : d.caps.claude ? 'von der Seite nicht nutzbar (nicht freigegeben oder abgeschaltet)' : 'nicht verfügbar: Seite läuft außerhalb von claude.ai'],
          ['Datei-Export', d.caps.downloads ? 'über den Speichern-Dialog von claude.ai' : 'über einen Datei-Link des Browsers'],
          ['Start', d.ms.ready != null ? U.num(d.ms.ready) + ' ms bis zur ersten Ansicht (Tabelle ' + U.num(d.ms.meta) + ' ms, Index ' + U.num(d.ms.index) + ' ms)' : '–'],
          ['Browser', d.ua.browser + ' ' + (d.ua.major || '') + ' · ' + d.ua.os + ' · ' + d.viewport[0] + ' × ' + d.viewport[1]],
          ['Fehler seit Start', String(d.errors.length)]]));
        U.clear(errBox);
        if (d.errors.length) { var ul = h('ul.k-list'); d.errors.slice(-10).forEach(function (e) { ul.appendChild(h('li.mono.k-small', { text: e.where + (e.code ? ' [' + e.code + ']' : '') + ': ' + e.message })); }); errBox.appendChild(ul); }
      });
    }
    function drawAi() {
      var A = g.LnpAI; U.clear(aiBox);
      if (!A || !A.usage) { aiBox.appendChild(h('p.k-hint', { text: 'Das KI-Modul ist in diesem Datenpaket nicht enthalten.' })); return; }
      var u = A.usage(), log = (u.log || []).slice(-40).reverse();
      aiBox.appendChild(K.stats([['Aufrufe in dieser Sitzung', U.num(u.calls), u.failed ? u.failed + ' gescheitert' : 'keiner gescheitert'], ['Wiederholungen', U.num(u.repairs), 'nach ungültiger Antwort'], ['Gesendet', U.bytes(u.bytesIn), 'Text an Claude'], ['Empfangen', U.bytes(u.bytesOut), null]]));
      if (!log.length) { aiBox.appendChild(h('p.k-hint', { text: 'In dieser Sitzung wurde noch nichts an Claude gesendet. Suche und Struktursuche senden nie etwas; nur die FTO-Analyse, die KI-Suche und „Claim erklären“ rufen Claude auf. Das Protokoll gilt für die laufende Sitzung und wird nicht gespeichert.' })); return; }
      var tb = h('tbody');
      log.forEach(function (e) { tb.appendChild(h('tr', null, h('td.mono', { text: new Date(e.t).toLocaleTimeString('de-DE') }), h('td', { text: (e.label || '') + (e.repair ? ' (Wiederholung)' : '') }), h('td', { text: e.tierApplied || e.tier || '' }), h('td.num', { text: U.bytes(e.bytesIn) }), h('td.num', { text: U.bytes(e.bytesOut) }), h('td.num', { text: U.num(e.ms) + ' ms' }), h('td', null, h('span.pill.' + (e.ok ? 'good' : 'crit'), { text: e.ok ? 'ok' : (e.code || 'Fehler') })))); });
      aiBox.appendChild(h('div.table-wrap', null, h('table.data', null, h('thead', null, h('tr', null, ['Zeit', 'Schritt', 'Modellstufe', 'gesendet', 'empfangen', 'Dauer', 'Ergebnis'].map(function (t) { return h('th', { text: t }); }))), tb)));
    }

    /* ---------------------------------------------------------- self-test */
    function runTests() {
      testBtn.disabled = true; App.chemUsed = true;
      var tests = [
        ['Patent nachschlagen', function () { return D.patent(0).then(function (p) { return D.byPn(U.pnPretty(p.pn)).then(function (i) { if (i < 0) throw { message: p.pn + ' nicht gefunden' }; return D.patent(i).then(function (q) { if (q.appNo !== p.appNo) throw { message: 'falsche Schrift' }; return U.pnPretty(p.pn) + ' über die formatierte Nummer gefunden'; }); }); }); }],
        ['Volltextsuche', function () { return S.search('"lipid nanoparticle" AND cholesterol', { limit: 5 }).then(function (r) { if (!(r.total > 0) || !r.hits.length) throw { message: 'keine Treffer für eine Standardabfrage' }; if (!r.hits[0].best || !r.hits[0].best.snippet) throw { message: 'Treffer ohne Textstelle' }; return U.num(r.total) + ' Treffer, Textstelle vorhanden'; }); }],
        ['Filter und Zählung', function () { return S.search('', { filters: { auth: ['EP'] }, limit: 1, snippets: false }).then(function (r) { if (c.ep != null && r.total !== c.ep) throw { message: r.total + ' EP-Schriften gezählt, das Manifest nennt ' + c.ep }; return U.num(r.total) + ' EP-Schriften, wie im Manifest'; }); }],
        ['Struktur exakt (DLin-MC3-DMA)', function () { return Ch.search({ query: 'DLin-MC3-DMA', mode: 'exact', limit: 5 }).then(function (r) { if (!r.length) throw { message: 'MC3 nicht gefunden' }; return r[0].id + ' in ' + r[0].nPat + ' Schriften'; }); }],
        ['Teilstruktur (Dimethylaminobutyrat)', function () { return Ch.search({ query: 'CN(C)CCCC(=O)OC', mode: 'sub', limit: 5 }).then(function (r) { if (!(r.total > 0)) throw { message: 'kein Treffer' }; return U.num(r.total) + ' Verbindungen'; }); }],
        ['Ähnlichkeit (ALC-0315, ab 0,70)', function () { return Ch.search({ query: 'ALC-0315', mode: 'sim', minSim: 0.7, limit: 5 }).then(function (r) { if (!r.length) throw { message: 'kein Treffer' }; if (!(r[0].sim >= 0.99)) throw { message: 'bester Treffer nur ' + r[0].sim }; return U.num(r.total) + ' Verbindungen, bester Treffer ' + Math.round(r[0].sim * 100) + ' %'; }); }],
        ['Speicher: schreiben, lesen, löschen', function () { var v = { t: Date.now(), s: 'äöü ✓' }; return St.put('settings', 'selftest', v).then(function () { return St.get('settings', 'selftest'); }).then(function (r) { if (!r || r.t !== v.t || r.s !== v.s) throw { message: 'gelesener Wert weicht ab' }; return St.remove('settings', 'selftest'); }).then(function () { return St.get('settings', 'selftest'); }).then(function (r) { if (r != null) throw { message: 'Eintrag nach dem Löschen noch vorhanden' }; return 'Speicherart: ' + ({ db: 'Artefakt-Datenbank', local: 'Browser-Speicher', memory: 'nur Sitzung' }[St.diag().backend] || St.diag().backend); }); }],
        ['Claude erreichbar', function () { var A = g.LnpAI; if (!A) return Promise.resolve({ skip: 'KI-Modul nicht im Datenpaket' }); return Promise.resolve(A.init()).then(function (ok) { return ok ? 'verfügbar (kein Aufruf gesendet)' : { skip: 'nicht verfügbar; Suche und Struktursuche arbeiten ohne Claude' }; }); }]
      ];
      var rows = tests.map(function (t) { var li = h('li', { data: { s: 'wait' } }, h('span.st', { text: 'wartet' }), h('span.k-steps-t', { text: t[0] }), h('span.info')); return li; });
      var summary = h('p.k-sub', { id: 'sys-test-result', 'aria-live': 'polite', text: 'Test läuft …' });
      U.set(testBox, h('ol.k-steps', null, rows), summary);
      var pass = 0, fail = 0, skip = 0;
      tests.reduce(function (p, t, i) {
        return p.then(function () {
          if (dead) return;
          var li = rows[i], t0 = performance.now(); li.dataset.s = 'run'; li.children[0].textContent = 'läuft';
          return Promise.resolve().then(t[1]).then(function (msg) {
            var ms = Math.round(performance.now() - t0);
            if (msg && msg.skip) { skip++; li.dataset.s = 'wait'; li.children[0].textContent = 'entfällt'; li.children[2].textContent = msg.skip; }
            else { pass++; li.dataset.s = 'ok'; li.children[0].textContent = 'bestanden'; li.children[2].textContent = msg + ' · ' + U.num(ms) + ' ms'; }
          }, function (e) { fail++; li.dataset.s = 'err'; li.children[0].textContent = 'gescheitert'; li.children[2].textContent = U.errText(e); });
        });
      }, Promise.resolve()).then(function () {
        if (dead) return;
        testBtn.disabled = false;
        summary.textContent = fail ? fail + ' von ' + tests.length + ' Prüfungen gescheitert. Die Diagnose unten hilft bei der Fehlersuche.' : pass + ' Prüfungen bestanden' + (skip ? ', ' + skip + ' entfallen' : '') + '.';
        summary.dataset.ok = fail ? '0' : '1';
        drawEngines(); drawAi();
      });
    }

    /* ---------------------------------------------------------- limits and method */
    var P = g.LnpFtoPrompts, limText = null;
    try { limText = P && P.limits ? P.limits('de', snap.ep_register ? U.date(snap.ep_register) : null) : null; } catch (e) { limText = null; }
    var limBox = h('aside.k-limits', { id: 'sys-limits' }, (limText ? String(limText).split('\n') : ['Grenzen dieses Werkzeugs'].concat(LIMITS_FALLBACK)).filter(function (l) { return l.trim(); }).map(function (l, i) { return h(i === 0 ? 'p.k-limits-t' : 'p', { text: l }); }));
    var method = h('div.k-prose', null,
      h('p', { text: 'Der Bestand entsteht außerhalb der Seite aus frei zugänglichen Quellen: SureChEMBL grenzt das Feld ab und liefert die Strukturen, das EPA und das USPTO liefern Bibliografie, Anspruchstexte und Rechtsstand. Eine Liste bekannter Schlüsselfamilien stellt sicher, dass die zentralen LNP-Patente enthalten sind.' }),
      h('p', { text: 'Die Textsuche ist ein Wortindex über Claims, Titel und Abstracts mit Boole-Operatoren, Wortfolgen und Abstandssuche; die Rangfolge gewichtet unabhängige Claims höher. Die Struktursuche vergleicht Fingerabdrücke und prüft Teilstrukturen mit OpenChemLib. Beides läuft vollständig im Browser, keine Abfrage verlässt das Gerät.' }),
      h('p', { text: 'Die FTO-Prüfung arbeitet in festen Schritten: Kandidaten über Struktur, Claim-Text und Schlüsselfamilien; Rechtsstand und Zielmarkt; Triage der unabhängigen Claims; Merkmalsanalyse je Schrift mit wörtlichem Zitat je Merkmal; Unteransprüche; Gegenprüfung aus Sicht des Patentinhabers; Zusammenfassung. Nur diese Schritte senden Text an Claude.' }),
      h('p', { text: 'Was die Seite selbst nachrechnet und nie dem Modell überlässt: Jedes Zitat muss wörtlich im Anspruch stehen, sonst gilt das Merkmal als nicht belegt. Das Ergebnis eines Anspruchs folgt aus seinen Merkmalen. Ein Anspruch mit einer Formel, die nur als Bild vorliegt, ist höchstens „möglich“. Das Risiko ist nie niedriger als das ungünstigere Ergebnis aus Analyse und Gegenprüfung. Äquivalenz wird als Frage an die Kanzlei notiert und nicht entschieden.' }));

    var page = h('div.page.k-page', null,
      K.head('System', 'Datenstand,', 'Diagnose und Grenzen', 'Was im Datenpaket steckt, wie alt es ist, wie die Seite gerade arbeitet und was sie nicht leisten kann.'),
      K.sec('Bestand', 'Was enthalten ist', null, facts, covBox),
      K.sec('Lücken', 'Was fehlt', null, gaps, h('h3.k-h3', { text: 'Größe des Datenpakets: ' + (M.totalBytes ? U.bytes(M.totalBytes) + ' in ' + M.nFiles + ' Dateien' : 'unbekannt') + (cut.budgetMb ? ' (Grenze ' + U.num(cut.budgetMb) + ' MB)' : '') }), h('p.k-note', { text: 'Angaben in kB.' }), sizeBox),
      K.sec('Quellen', 'Stand der Daten', null, stale, sources),
      K.sec('Selbsttest', 'Funktioniert alles?', testBtn, h('p.k-note', { text: 'Prüft Nachschlagen, Volltextsuche, drei Struktursuchen und den Speicher mit bekannten Abfragen. Lädt dafür die Strukturdaten (etwa 19 MB). An Claude wird nichts gesendet.' }), testBox),
      K.sec('Laufzeit', 'Wie die Seite arbeitet', h('span.k-row', null, h('button.btn.sm', { type: 'button', onclick: function () { U.copy(JSON.stringify(App.diag(), null, 1), 'Diagnose kopiert'); } }, U.icon('copy'), 'Diagnose kopieren'), h('button.btn.sm', { type: 'button', onclick: function () { App.shortcuts(); } }, U.icon('help'), 'Tastaturkürzel')), engBox, errBox),
      K.sec('Claude', 'Nutzung in dieser Sitzung', null, aiBox),
      K.sec('Grenzen', 'Was dieses Werkzeug nicht ist', null, limBox),
      K.sec('Methode', 'Wie die Ergebnisse entstehen', null, method));
    host.appendChild(page);
    coverage(); drawEngines(); drawAi();
    var offAi = g.LnpAI && g.LnpAI.onUsage ? g.LnpAI.onUsage(function () { if (!dead) drawAi(); }) : null;
    var offCaps = App.on('caps', function () { if (!dead) drawEngines(); });
    if (R.list(route.params.x).indexOf('test') >= 0) runTests();
    return { update: function (r) { if (R.list(r.params.x).indexOf('test') >= 0) runTests(); return true; }, destroy: function () { dead = true; offCaps(); if (typeof offAi === 'function') offAi(); K.tip.hide(); } };
  }
  g.LnpApp.registerView({ id: 'system', title: 'System', icon: 'system', mount: g.LnpLazyView('system', ['app/views/views.css', 'app/views/lib/kit.js', 'app/views/lib/chart.js'], mount) });
})(window);
