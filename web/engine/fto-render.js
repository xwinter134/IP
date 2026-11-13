/* LNP-FTO opinion renderer (global LnpFtoRender). Plain script, no dependencies.
   render(opinion, "md" | "html" | "json") -> string.
   - Output language: English only (a stored opinion's "lang" is ignored). Internal codes (risk levels, verdicts, flags,
     schema field names; ASCII German-derived identifiers that are never shown) are mapped to English labels for display;
     claim quotes and the generated search queries stay verbatim.
   - Every rendering STARTS and ENDS with the verbatim limits block (opinion.limits = LIMITS_EN with the
     status snapshot date filled in). Markdown: first and last characters; HTML: first and last element of <body>;
     JSON: first key "hinweis" and last key "hinweis_ende".
   - Model output and patent text are untrusted. The document is first built as a list of plain-data nodes; the HTML
     serialiser escapes every string (& < > " ') and never emits a tag, attribute or URL taken from data. The HTML is a
     self-contained printable document without scripts and without external resources. Markdown is plain text.
   Sections: summary with risk matrix, product profile as understood, search record, per-patent sections (claim chart,
   dependent claims, red-team view, questions for counsel, design-around ideas), patents not charted and why, next steps. */
(function (g) {
  'use strict';
  function arr(x) { return Array.isArray(x) ? x : []; }
  function str(x) { return x == null ? '' : String(x); }
  function esc(s) { return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  var T = {
    en: {
      title: 'FTO pre-screen (not a legal opinion)', created: 'Created', depth: 'Depth', markets: 'Markets', corpus: 'Corpus snapshot', none: 'none', yes: 'yes', no: 'no', unknown: 'unknown',
      s_summary: '1. Summary', s_overall: 'Overall risk per market (computed by the app from the individual assessments)', market: 'Market', risk: 'Risk', drivers: 'Driving patent rights',
      pendingApps: 'Pending applications (separate; claims may change)', matrix: 'Risk matrix', right: 'Patent right', rel: 'Relevance', literal: 'Literal infringement (worst claim)', status: 'Legal status', expiry: 'Expiry (estimate)', notes: 'Notes',
      riskBE: 'Claim chart / red team', noAi: 'The AI feature was not available. This document only contains the search and the legal status, no claim charts.',
      noCharts: 'No patent right was analysed.', depthWarn: 'Attention: patent rights with triage relevance A or B were NOT analysed because of the selected depth', seeNotCharted: 'see section 6',
      warnings: 'App notes on this run', modelSummary: 'Summary assessment (Claude; from the individual assessments, not binding)', synthFailed: 'The summary assessment (synthesis) failed', synthFlags: 'App notes on the synthesis',
      s_profile: '2. Subject of the screen (product profile as understood)', ionLipid: 'Ionizable lipid', name: 'Name', structDesc: 'Structure description', formula: 'Formula', mw: 'Molecular weight', computed: 'computed by the app (OpenChemLib), not by the model',
      otherLipids: 'Other lipids', role: 'Role', composition: 'Composition (mol-% of total lipid)', basis: 'Basis', payload: 'Payload', particle: 'Particle', process: 'Process', formulation: 'Formulation / storage', use: 'Use', acts: 'Acts and markets',
      features: 'Product feature list', id: 'ID', category: 'Category', statement: 'Statement', value: 'Value', source: 'Source', certainty: 'Certainty', assumptions: 'Assumptions', openData: 'Open questions on the product', profileWarn: 'App notes on the profile',
      modelText: 'Description by Claude', s_search: '3. Search record (for reproducibility)', snapshot: 'Corpus and snapshots', counts: 'Size', structRoute: 'Structure search (exact / substructure / similarity per lipid)', lipid: 'Lipid', mode: 'Mode', compounds: 'Compounds', pubs: 'Occurrences',
      textRoute: 'Text search (generated boolean queries, verbatim; they include German terms so that German-language claims are found too)', query: 'Query', hits: 'Hits', taken: 'Evaluated', seedRoute: 'Key families of the watched applicants', tier: 'Tier', semRoute: 'Semantic search (Claude)', candidates: 'Candidates', triage: 'Triage',
      charted: 'Analysed', s_patents: '4. Individual assessment of the analysed patent rights', assignee: 'Proprietor/applicant', assessedFor: 'Assessed for', found: 'Found via', relevance: 'Triage', expiryBasis: 'Basis', riskFinal: 'Risk (final = the more adverse of chart and red team)',
      riskChartDead: 'Result of the claim chart (hypothetical, patent right no longer in force)', appNotes: 'App checks', failed: 'Analysis failed', claim: 'Claim', claimChart: 'Claim chart', feature: 'Feature', quote: 'Claim wording (quote)', quoteCheck: 'Quote check', product: 'Product',
      verdict: 'Verdict', reasoning: 'Reasoning / construction / clarification', resultApp: 'Result (computed from the feature rows)', resultModel: 'Model', resultE: 'Red team', resultFinal: 'Final', markush: 'Formula test (Markush)', scaffold: 'Scaffold', variables: 'Variables', mappings: 'Mappings',
      provisos: 'Provisos', equivalence: 'Equivalence questions for counsel (NOT decided here)', eqNote: 'model view, not a decision', replaced: 'Replaced means', dependent: 'Dependent claims (fallback positions)', added: 'Added feature (quote)',
      chain: 'Chain (app)', species: 'Named individually', fallback: 'Fallback positions', constructionHints: 'Construction hints from the dependent claims', revision: 'Review recommended', redteam: 'Red team (patentee view)', attack: 'Attack', patentee: 'Patentee argument',
      counter: 'Counter-argument', outcome: 'Outcome', otherRoutes: 'Further routes of attack', revised: 'Revised risk of the red team', questions: 'Open questions for counsel', designAround: 'Design-around ideas (ideas only: technical hypotheses, to be validated technically and legally)',
      exemptions: 'Exemptions and role (model view)', shortVerdict: 'Short verdict (Claude)', s_cross: '5. Cross-cutting points (Claude; from the individual assessments)', crossPatterns: 'Cross-patent patterns', timeline: 'Timeline (expiry dates are estimates)', exemptionsAll: 'Exemptions',
      daAll: 'Design-around ideas cross-checked (ideas only)', collides: 'Collides with', redAll: 'Red team', pendingText: 'Pending applications', s_not: '6. Patent rights not analysed, and why', reason: 'Reason', s_next: '7. Next steps', prio: 'Priority', step: 'Step', why: 'Why',
      alwaysNext: 'Always recommended (method)', openQ: 'Open questions', s_usage: 'Usage', calls: 'calls', resumed: 'steps taken from saved state', notAssessed: 'not assessed', estimate: 'estimate', flagsLabel: 'Flags', dependentFailed: 'Dependent-claim analysis failed', redteamFailed: 'Red team failed',
      forcedBy: 'set to "unclear" by the app', modelRisk: 'Risk according to the model', construction: 'Construction', broad: 'broad', narrow: 'narrow', definition: 'Definition', clarification: 'Clarification', assumption: 'Assumption', numeric: 'Numeric comparison', imagesSent: 'formula images sent', claimsLang: 'Claim language',
      evidence: 'Evidence computed by the app', evIntro: 'Computed by code from stored data, not a model output. This evidence only adds flags, questions and risk floors; it never lowers a risk.', evApplied: 'Rules applied', evMarkush: 'Markush check (code-verified; stored and curated records)', evNoRecord: 'No stored or curated Markush record for this publication.',
      evTranslation: 'Translation', evReviewed: 'reviewed', evNotReviewed: 'not reviewed', evOrigin: 'Origin', evGroup: 'Group found', evRanges: 'Numeric ranges in the claims (compared by code)', evParam: 'Parameter', evRange: 'Claimed range', evQuoteSrc: 'Quote source', evLimits: 'Limits of this evidence', evRoute: 'Markush route (stored and curated records, code-verified)', evNoRanges: 'No claim of this publication states a range for the compared values.'
    }
  };
  var RISK = {
    en: { '5_sehr_hoch': 'very high (5)', '4_hoch': 'high (4)', '3_mittel': 'medium (3)', '2_gering': 'low (2)', '1_sehr_gering': 'very low (1)', nicht_beurteilbar: 'cannot be assessed' }
  };
  /* English labels for the internal codes (schema enum values, app flags, modifiers) and for the schema field names
     that appear as row labels. The codes themselves never change and are never shown. */
  var CODE_EN = {
    ja: 'yes', nein: 'no', offen: 'open', entfaellt: 'n/a', hoch: 'high', mittel: 'medium', niedrig: 'low', gering: 'low', keine: 'none',
    erfuellt: 'met', nicht_erfuellt: 'not met', unklar: 'unclear', moeglich: 'possible', nicht_beurteilbar: 'cannot be assessed',
    wortsinngemaess_erfuellt: 'literally met', wortsinngemaess_moeglich: 'literally possible', wortsinngemaess_nicht_erfuellt: 'literally not met',
    '5_sehr_hoch': 'very high (5)', '4_hoch': 'high (4)', '3_mittel': 'medium (3)', '2_gering': 'low (2)', '1_sehr_gering': 'very low (1)',
    formel_fehlt: 'formula not available', faellt_unter_formel: 'falls under the formula', faellt_nicht_unter_formel: 'does not fall under the formula',
    haelt: 'finding holds', wackelt: 'finding is shaky', faellt: 'finding fails', robust: 'robust', knapp: 'narrow margin', greift: 'applies', greift_nicht: 'does not apply',
    lipid_struktur: 'lipid structure', komponente: 'component', verhaeltnis: 'ratio', payload: 'payload', partikel: 'particle', verfahren: 'process', formulierung: 'formulation', anwendung: 'use', handlung: 'act',
    stoff: 'compound', zusammensetzung: 'composition', herstellungsverfahren: 'manufacturing process', verwendung_behandlung: 'use / method of treatment', product_by_process: 'product-by-process', vorrichtung: 'device', kit: 'kit',
    sonstiges: 'other', sonstige: 'other', nutzer: 'user', berechnet: 'computed', annahme: 'assumption', original: 'original', machine_translation: 'machine translation', ocr: 'OCR', unbekannt: 'unknown',
    kopfgruppe: 'head group', spacer: 'spacer', linker: 'linker', kette: 'chain', helferlipid_phospholipid: 'helper lipid / phospholipid', sterol: 'sterol', peg_lipid: 'PEG-lipid', polymer_lipid_sonstig: 'other polymer lipid',
    permanent_kationisch: 'permanently cationic lipid', targeting: 'targeting lipid', ionizable_lipid: 'ionizable lipid', phospholipid: 'phospholipid',
    gesamtlipid_nominal_einsatz: 'total lipid, nominal (as charged)', gesamtlipid_gemessen_partikel: 'total lipid, measured in the particle', leer: 'empty (no payload)',
    t_stueck: 'T-junction', impinging_jet: 'impinging jet', mikrofluidik_herringbone: 'microfluidics (herringbone)', mikrofluidik_bifurkierend_toroidal: 'microfluidics (bifurcating/toroidal)', ethanol_injektion: 'ethanol injection', extrusion: 'extrusion',
    selbst: 'in-house', cdmo: 'CDMO', kooperationspartner: 'collaboration partner',
    forschung: 'research', praeklinik: 'preclinical', klinik_phase_1_2: 'clinical phase 1/2', klinik_phase_3: 'clinical phase 3', zulassung_beantragt: 'marketing authorisation applied for', kommerziell: 'commercial',
    herstellen: 'making', gebrauchen: 'using', anbieten: 'offering', inverkehrbringen: 'placing on the market', einfuehren: 'importing', ausfuehren: 'exporting', besitzen: 'keeping', liefern_an_dritte: 'supplying to third parties',
    derzeit: 'current', geplant: 'planned',
    versuchsprivileg_bolar_derzeit_einschlaegig: 'experimental-use / Bolar exemption currently relevant', rechtsstand_ungeprueft: 'legal status unverified', anmeldung_ansprueche_veraenderlich: 'application: claims may change',
    uebersetzung: 'translation', einspruch_ipr_anhaengig: 'opposition / IPR pending', familie_mit_anhaengigen_anmeldungen: 'family with pending applications', produktdaten_unvollstaendig: 'product data incomplete',
    weitere_auslegung: 'broader construction', produktfakten: 'product facts', markush_mapping: 'Markush mapping', aequivalenz: 'equivalence', massgabe: 'proviso', gegenfehler: 'opposite error', vollstaendigkeit: 'completeness',
    anderer_unabhaengiger_anspruch: 'another independent claim', andere_anspruchskategorie: 'another claim category', mittelbare_verletzung: 'indirect infringement', verfahrenserzeugnis: 'product directly obtained by a process',
    anhaengige_anmeldung_anspruchsaenderung: 'pending application: claim amendment', teilanmeldung_continuation: 'divisional / continuation',
    kein_unabhaengiger_anspruch: 'not an independent claim', anspruch_nicht_im_korpus: 'claim not in the corpus', zitat_abweichend: 'quote deviates', zitat_nicht_verifiziert: 'quote not verified',
    definitionszitat_nicht_verifiziert: 'definition quote not verified', markush_zitat_nicht_verifiziert: 'formula quote not verified', markush_unklar: 'formula test unclear', text_gekuerzt: 'text shortened',
    literal_neu_berechnet: 'literal result recomputed', anspruch_fehlt_in_analyse: 'claim missing from the analysis', urteil_von_app_auf_unklar_gesetzt: 'verdict set to unclear by the app', ungueltiges_urteil: 'invalid verdict',
    einzelnennung_zitat_nicht_verifiziert: 'quote for the individually named compound not verified', kette_neu_berechnet: 'chain result recomputed', unteransprueche_fehlgeschlagen: 'dependent-claim analysis failed',
    gegenpruefung_fehlgeschlagen: 'red-team review failed', eskalation_durch_gegenpruefung: 'escalated by the red-team review', triage_ohne_ergebnis: 'no triage result', analyse_fehlgeschlagen: 'analysis failed', triage_c_ueberstimmt: 'triage C overridden by a code-verified Markush hit',
    unbekannte_nummer_in_zeitachse: 'unknown number in the timeline', formulierung_pruefen: 'check wording', gesamtrisiko_abweichend: 'overall risk differs from the computed one',
    markush_covered: 'Markush check: covered (code-verified, translation reviewed)', markush_covered_unreviewed: 'Markush check: covered (code-verified, translation not reviewed)', markush_contradicts_chart: 'Markush check contradicts the claim chart',
    range_outside: 'product value outside a claimed range (risk not lowered)', ranges_all_inside: 'all compared product values inside the claimed ranges', all_inside: 'all inside', no_range: 'no range', not_covered: 'not covered', covered: 'covered', not_met: 'not met',
    expired: 'expired', lapsed: 'lapsed', revoked: 'revoked', withdrawn: 'withdrawn', refused: 'refused', lapsed_de: 'lapsed in DE'
  };
  var FIELD_EN = {
    typ: 'Type', nukleosidmodifikation: 'Nucleoside modification', laenge_nt: 'Length (nt)', kodiert_fuer: 'Encodes', anzahl_spezies: 'Number of species',
    groesse_nm: 'Size (nm)', groesse_methode: 'Size method', pdi: 'PDI', verkapselung_prozent: 'Encapsulation (%)', zeta_mv: 'Zeta potential (mV)', morphologie: 'Morphology',
    mischprinzip: 'Mixing principle', geraet: 'Device', flussratenverhaeltnis_waessrig_zu_organisch: 'Flow rate ratio aqueous:organic', gesamtflussrate_ml_min: 'Total flow rate (mL/min)', loesungsmittel: 'Solvent',
    ethanol_prozent_bei_mischung: 'Ethanol at mixing (%)', waessriger_puffer: 'Aqueous buffer', ph_bei_mischung: 'pH at mixing', temperatur_c: 'Temperature (\u00b0C)', nachbehandlung: 'Post-processing', schritte_frei: 'Process steps',
    ort_der_herstellung: 'Manufacturing site', hersteller: 'Manufacturer', endpuffer: 'Final buffer', kryoprotektor: 'Cryoprotectant', lyophilisiert: 'Lyophilised', lagerung: 'Storage',
    applikationsweg: 'Route of administration', indikationsklasse: 'Indication class', zielgewebe: 'Target tissue', dosis: 'Dose',
    entwicklungsstand: 'Development stage', regulatorischer_zweck: 'Regulatory purpose', oeffentlicher_auftraggeber_us: 'US government contract',
    land: 'Country', akt: 'Act', zeitpunkt: 'Timing', geplant_ab: 'Planned from', zweck: 'Purpose', abstand: 'Distance (failing variables)', konfidenz: 'Confidence',
    lipid_zu_nukleinsaeure_gewicht: 'Lipid : nucleic acid (w/w)', chargenvariabilitaet: 'Batch variability'
  };
  /* label(code): English display text of an internal code; compound flags are resolved by their prefix; unknown codes
     are shown with blanks instead of underscores (tests/english_test.mjs guards that every code in use is mapped). */
  function label(c, lang) {
    c = str(c);
    if (!c) return c;
    if (Object.prototype.hasOwnProperty.call(CODE_EN, c)) return CODE_EN[c];
    var m = /^markush_widerspruch_(.+)$/.exec(c); if (m) return 'formula test contradicts the verdict (' + m[1] + ')';
    m = /^unteransprueche_(.+)$/.exec(c); if (m) return 'dependent claims: ' + label(m[1], lang);
    m = /^rechtsstand_(.+)$/.exec(c); if (m) return 'legal status: ' + label(m[1], lang);
    return c.replace(/_/g, ' ');
  }
  /* a value that may be a code or free text: mapped only when it is a known code */
  function soft(v) { v = str(v); return Object.prototype.hasOwnProperty.call(CODE_EN, v) ? CODE_EN[v] : v; }
  function field(k) { k = str(k); return Object.prototype.hasOwnProperty.call(FIELD_EN, k) ? FIELD_EN[k] : k.replace(/_/g, ' '); }
  var LIT = {
    en: { wortsinngemaess_erfuellt: 'literally met', wortsinngemaess_moeglich: 'literally possible', wortsinngemaess_nicht_erfuellt: 'literally not met', nicht_beurteilbar: 'cannot be assessed' }
  };
  var VERD = { en: { erfuellt: 'met', nicht_erfuellt: 'not met', unklar: 'unclear', moeglich: 'possible' } };
  var QCHK = {
    en: { ok: 'found verbatim in the claim', elided: 'DEVIATING: found only with an omission', approx: 'DEVIATING: found only with relaxed spelling', fail: 'NOT VERIFIED: quote is not in the claim text', empty: 'NOT VERIFIED: no quote' }
  };
  var NEXT = {
    en: ['Markush/structure search in CAS STN (REGISTRY + MARPAT) and/or Derwent Markush for the ionizable lipid and the PEG-lipid.',
      'Current legal status from the registers (EP Register incl. opposition file, DPMAregister, UPC register/opt-out, USPTO Patent Center, PTAB), INPADOC family, SPC/PTE.',
      'File-wrapper review for the top-rated rights (amendments, statements).',
      'Analytical data to resolve unclear features (measured mol-% in the particle, size by the method named in the patent, pKa, encapsulation).',
      'Written opinion of a patent attorney before GMP or commercial commitments.',
      'Monitoring of pending applications and divisionals/continuations of the affected families and the watched applicants.']
  };
  var REASON = {
    en: { dead: 'legal status (expired/lapsed/revoked)', triage_c: 'triage C (different subject)', depth_limit: 'outside the selected depth', no_text: 'no claim text in the corpus', text_cut: 'claim text not in the data package', wo: 'WO publication', market: 'no target market', no_ai: 'AI not available' }
  };

  // ------------------------------------------------------------------------------------------------ node model
  /* nodes: {h: level, t} | {p: text, cls?} | {ul: [text]} | {table: {head: [..], rows: [[..]], cls?}} | {limits: text} | {md: model text} | {kv: [[k, v]]} */
  function build(op) {
    var lang = 'en', L = T.en, N = [], syn = op.synthesis || null; // English only; a stored opinion's lang is ignored
    function risk(r) { return r ? (RISK[lang][r] || str(r)) : L.notAssessed; }
    function lit(r) { return r ? (LIT[lang][r] || str(r)) : '-'; }
    function verd(v) { return VERD[lang][v] || str(v); }
    function code(c) { return label(c, lang); }
    function codes(a) { return arr(a).map(code).join(', '); }
    function fld(k) { return field(k, lang); }
    function h(l, t) { N.push({ h: l, t: str(t) }); }
    function p(t, cls) { if (str(t)) N.push({ p: str(t), cls: cls || null }); }
    function ul(a) { a = arr(a).map(str).filter(Boolean); if (a.length) N.push({ ul: a }); }
    function table(head, rows, cls) { if (rows.length) N.push({ table: { head: head, rows: rows.map(function (r) { return r.map(function (c) { return c == null ? '' : str(c); }); }), cls: cls || null } }); }
    function md(t) { if (str(t).trim()) N.push({ md: str(t) }); }
    function kv(a) { a = a.filter(function (x) { return x[1] !== null && x[1] !== undefined && str(x[1]) !== ''; }); if (a.length) N.push({ kv: a.map(function (x) { return [str(x[0]), str(x[1])]; }) }); }
    function val(v) { return v === null || v === undefined || v === '' ? null : (typeof v === 'boolean' ? (v ? L.yes : L.no) : str(v)); }
    var snap = op.snapshot || {};

    N.push({ limits: str(op.limits) });
    h(1, op.title || L.title);
    kv([[L.created, str(op.finished || op.created).slice(0, 16).replace('T', ' ')], [L.depth, op.depth], [L.markets, arr(op.markets).join(', ')],
      [L.corpus, [snap.ep_text ? 'EP full text ' + snap.ep_text : '', snap.us_text ? 'US full text ' + snap.us_text : '', snap.ep_register ? 'EP Register ' + snap.ep_register : '', snap.surechembl ? 'SureChEMBL ' + snap.surechembl : ''].filter(Boolean).join('; ')], ['ID', op.id]]);

    // 1 summary
    h(2, L.s_summary);
    if (!op.aiUsed) p(L.noAi, 'warn');
    var missed = arr(op.notCharted).filter(function (n) { return n.reason === 'depth_limit'; });
    if (missed.length) p(L.depthWarn + ': ' + missed.map(function (n) { return n.pn + ' (' + str(n.rel) + ')'; }).join(', ') + ' - ' + L.seeNotCharted + '.', 'warn');
    if (op.overall) {
      h(3, L.s_overall);
      table([L.market, L.risk, L.drivers], arr(op.overall.markets).map(function (m) { return [m.market === 'EP_UPC' ? 'EP / UPC' : m.market, risk(m.risk), arr(m.drivers).join(', ')]; }));
      if (op.overall.pending && op.overall.pending.risk) p(L.pendingApps + ': ' + risk(op.overall.pending.risk) + ' - ' + arr(op.overall.pending.drivers).join(', '));
    }
    h(3, L.matrix);
    if (!arr(op.matrix).length) p(L.noCharts);
    table([L.right, L.market, L.rel, L.risk, L.riskBE, L.literal, L.status, L.expiry, L.notes], arr(op.matrix).map(function (m) {
      return [m.pn, arr(m.markets).join('/'), m.rel, risk(m.risk), risk(m.riskB) + ' / ' + (m.riskE ? risk(m.riskE) : '-'), lit(m.literal), m.status, m.expiry ? m.expiry + ' (' + L.estimate + ')' : L.unknown, codes(m.flags)];
    }), 'matrix');
    if (syn) { h(3, L.modelSummary); md(syn.zusammenfassung); if (syn.app && arr(syn.app.flags).length) p(L.synthFlags + ': ' + codes(syn.app.flags) + (arr(syn.app.wording).length ? ' (' + syn.app.wording.map(function (w) { return '"' + w.phrase + '"'; }).join(', ') + ')' : ''), 'warn'); }
    if (op.synthesisFailed) p(L.synthFailed + ': ' + str(op.synthesisFailed.message), 'warn');
    if (arr(op.warnings).length) { h(3, L.warnings); ul(op.warnings); }

    // 2 profile
    var pf = op.profile || {}, il = pf.ionizable_lipid || {}, ds = il.descriptors || {}, z = pf.zusammensetzung || {}, mol = z.molprozent || {};
    h(2, L.s_profile);
    p(pf.bezeichnung);
    h(3, L.ionLipid);
    kv([[L.name, [il.name_user, il.name_normalised].filter(Boolean).join(' / ')], ['SMILES', il.smiles], ['InChIKey', il.inchikey], [L.formula + ' (' + L.computed + ')', ds.formula], [L.mw, ds.mw], ['pKa', il.pka_apparent], [L.structDesc, il.strukturbeschreibung]]);
    if (arr(pf.weitere_lipide).length) { h(3, L.otherLipids); table([L.role, L.name, 'SMILES', 'PEG-MW'], pf.weitere_lipide.map(function (l) { return [code(l.rolle), [l.name_user, l.name_normalised].filter(Boolean).join(' / '), l.smiles, l.peg_mw]; })); }
    h(3, L.composition);
    kv([[code('ionizable_lipid'), val(mol.ionizable_lipid)], [code('phospholipid'), val(mol.phospholipid)], [code('sterol'), val(mol.sterol)], [code('peg_lipid'), val(mol.peg_lipid)], [code('sonstige'), val(mol.sonstige)], [L.basis, soft(z.basis, lang)], ['N/P', val(z.np_verhaeltnis)]]);
    [[L.payload, pf.payload], [L.particle, pf.partikel], [L.process, pf.verfahren], [L.formulation, pf.formulierung_lagerung], [L.use, pf.anwendung]].forEach(function (s) {
      var o = s[1] || {}, rows = [], k;
      for (k in o) { var v = Array.isArray(o[k]) ? o[k].join('; ') : val(o[k]); if (v) rows.push([fld(k), soft(v, lang)]); }
      if (rows.length) { h(3, s[0]); kv(rows); }
    });
    var hd = pf.handlungen || {};
    h(3, L.acts);
    kv([[fld('entwicklungsstand'), soft(hd.entwicklungsstand, lang)], [L.markets, arr(hd.maerkte).join(', ')], [fld('regulatorischer_zweck'), hd.regulatorischer_zweck]]);
    table(['land', 'akt', 'zeitpunkt', 'geplant_ab', 'zweck'].map(fld), arr(hd.akte).map(function (a) { return [a.land, soft(a.akt, lang), soft(a.zeitpunkt, lang), a.geplant_ab, a.zweck]; }));
    h(3, L.features);
    table([L.id, L.category, L.statement, L.value, L.source, L.certainty], arr(pf.merkmalsliste).map(function (f) { return [f.id, code(f.kategorie), f.aussage, (f.wert == null ? '' : soft(f.wert, lang)) + (f.einheit ? ' ' + f.einheit : ''), code(f.quelle), code(f.sicherheit)]; }));
    if (arr(pf.annahmen).length) { h(3, L.assumptions); ul(pf.annahmen); }
    if (arr(pf.offene_fragen).length) { h(3, L.openData); ul(pf.offene_fragen); }
    if (pf._app && arr(pf._app.warnings).length) { h(3, L.profileWarn); ul(pf._app.warnings); }
    if (syn && syn.gegenstand) { h(3, L.modelText); md(syn.gegenstand); }

    // 3 search record
    var se = op.search || {}, rec = se.record || null;
    h(2, L.s_search);
    kv([[L.snapshot, Object.keys(snap).map(function (k) { return ({ ep_text: 'EP full text', us_text: 'US full text', ep_register: 'EP Register', surechembl: 'SureChEMBL', corpus: 'corpus' }[k] || field(k)) + ' ' + snap[k]; }).join('; ')],
      [L.counts, rec && rec.counts ? Object.keys(rec.counts).map(function (k) { return k + ' ' + rec.counts[k]; }).join('; ') : null],
      [L.candidates, se.candidates], [L.triage, se.triage ? 'A ' + (se.triage.A || 0) + ', B ' + (se.triage.B || 0) + ', C ' + (se.triage.C || 0) : null], [L.charted, se.charted]]);
    if (rec) {
      if (arr(rec.structure).length) { h(3, L.structRoute); table([L.lipid, L.role, L.mode, L.compounds, L.pubs], rec.structure.map(function (s) { return [s.lipid, s.role, ({ exact: 'exact', sub: 'substructure', sim: 'similarity' }[s.mode] || s.mode), s.error ? 'ERR: ' + s.error : s.compounds, s.publications]; })); }
      if (arr(rec.text).length) { h(3, L.textRoute); table(['', L.query, L.hits, L.taken], rec.text.map(function (t) { return [t.label, t.query, t.error ? 'ERR: ' + t.error : t.total, t.taken]; }), 'queries'); }
      if (arr(rec.seed).length) { h(3, L.seedRoute); table([L.tier, L.hits], rec.seed.map(function (s) { return [s.tier, s.error ? 'ERR: ' + s.error : s.total]; })); }
      if (rec.markush) { h(3, L.evRoute); kv([['Records', rec.markush.records], [L.lipid, rec.markush.lipids], ['Checks', rec.markush.checked], ['Not covered', rec.markush.notCovered]]);
        table([L.lipid, L.right, L.claim, L.outcome, L.evTranslation], arr(rec.markush.covered).concat(arr(rec.markush.unclear)).map(function (x) { return [x.lipid, x.pn, x.claim, code(x.overall), x.overall === 'covered' ? (x.reviewed ? L.evReviewed : L.evNotReviewed) : '']; })); }
      if (rec.semantic) { h(3, L.semRoute); kv([['strict', rec.semantic.queries && rec.semantic.queries.strict], ['relaxed', rec.semantic.queries && rec.semantic.queries.relaxed], [L.hits, rec.semantic.hits], [L.calls, rec.semantic.calls], ['degraded', arr(rec.semantic.degraded).join(', ') || rec.semantic.error]]); }
      ul(arr(rec.notes).concat(rec.cut ? [('Further candidates below the cut-off: ') + rec.cut] : []));
    }
    if (syn && syn.recherche) { h(3, L.modelText); md(syn.recherche); }

    // 4 per patent
    h(2, L.s_patents);
    if (!arr(op.patents).length) p(L.noCharts);
    var einzel = {}; if (syn) arr(syn.einzelbewertungen).forEach(function (x) { einzel[x.patent_id] = x; });
    arr(op.patents).forEach(function (e) {
      var ch = e.chart, rt = e.redteam, da = e.dependent, gs = (ch && ch.gesamt) || {};
      h(3, e.pn + ' - ' + str(e.title));
      kv([[L.assignee, e.assignee], [L.assessedFor, arr(e.markets).join(', ') + ' (' + e.jurisdiction + ')'], [L.relevance, str(e.rel) + (e.relWhy ? ': ' + e.relWhy : '')], [L.found, arr(e.why).join(' | ')],
        [L.status, e.status + (e.right && arr(e.right.notes).length ? '; ' + e.right.notes.join('; ') : '')], [L.expiry, e.expiry && e.expiry.date ? e.expiry.date + ' (' + L.estimate + ')' : L.unknown], [L.expiryBasis, e.expiry && e.expiry.basis],
        [L.riskFinal, risk(e.risk && e.risk.final) + ' [' + L.riskBE + ': ' + risk(e.risk && e.risk.b) + ' / ' + (e.risk && e.risk.e ? risk(e.risk.e) : '-') + ']'],
        [L.riskChartDead, e.risk && e.risk.chart ? risk(e.risk.chart) : null], [L.modelRisk, ch && ch.app && ch.app.risk_model ? risk(ch.app.risk_model) : null],
        [L.flagsLabel, codes(e.flags)], [L.claimsLang, e.claimsLang], [L.imagesSent, ch && ch.app && ch.app.images_sent ? ch.app.images_sent : null]]);
      if (e.failed) p(L.failed + ': ' + str(e.failed.message), 'warn');
      if (ch && ch.app && arr(ch.app.notes).length) { h(4, L.appNotes); ul(ch.app.notes.concat(rt && rt.app ? arr(rt.app.notes) : [])); }
      if (einzel[e.pn]) { h(4, L.shortVerdict); p(einzel[e.pn].kurzfazit); md(einzel[e.pn].text); }
      if (ch) {
        if (ch.textqualitaet && arr(ch.textqualitaet.probleme).length) ul(ch.textqualitaet.probleme);
        arr(ch.claims).forEach(function (c) {
          var a = c.app || {};
          h(4, L.claimChart + ': ' + L.claim + ' ' + c.claim_no + ' (' + code(c.kategorie) + ')');
          kv([[L.resultApp, lit(a.literal)], [L.resultModel, a.literal_model ? lit(a.literal_model) : null], [L.resultE, a.literal_e ? lit(a.literal_e) : null], [L.resultFinal, a.literal_final ? lit(a.literal_final) : null], [L.flagsLabel, codes(a.flags)]]);
          table([L.feature, L.quote, L.quoteCheck, L.product, L.verdict, L.reasoning], arr(c.merkmale).map(function (m) {
            var x = m.app || {}, au = m.auslegung || {}, nu = m.numerik || null, parts = [str(m.begruendung)];
            if (au.weite_auslegung || au.enge_auslegung) parts.push(L.construction + ': ' + L.broad + ' = ' + str(au.weite_auslegung) + '; ' + L.narrow + ' = ' + str(au.enge_auslegung));
            if (au.definition_quote) parts.push(L.definition + (au.definition_para ? ' [' + au.definition_para + ']' : '') + ': "' + au.definition_quote + '"' + (x.def_quote && x.def_quote !== 'ok' ? ' (' + QCHK[lang][x.def_quote] + ')' : ''));
            if (nu && (nu.anspruch_min != null || nu.anspruch_max != null)) parts.push(L.numeric + ': ' + str(nu.anspruch_min) + ' - ' + str(nu.anspruch_max) + ' ' + str(nu.einheit) + '; ' + L.product + ' ' + str(nu.produktwert) + '; \u0394 ' + str(nu.abstand_zur_grenze));
            if (m.annahme) parts.push(L.assumption + ': ' + m.annahme);
            if (m.klaerung) parts.push(L.clarification + ': ' + m.klaerung);
            if (x.redteam) parts.push(L.redteam + ': ' + code(x.redteam));
            return [m.feature_id, m.claim_quote, QCHK[lang][x.quote] || str(x.quote), [str(m.product_value), arr(m.product_refs).join(', ')].filter(Boolean).join(' [') + (arr(m.product_refs).length && m.product_value ? ']' : ''),
              verd(x.verdict || m.verdict) + (x.forced ? ' (' + L.forcedBy + ': ' + code(x.forced) + '; ' + L.resultModel + ': ' + verd(m.verdict) + ')' : ''), parts.filter(Boolean).join(' \u2014 ')];
          }), 'chart');
          arr(c.merkmale).forEach(function (m) {
            var mk = m.markush; if (!mk) return;
            h(5, L.markush + ' ' + m.feature_id + ': ' + code(mk.app_ergebnis || mk.ergebnis) + (mk.app_ergebnis && mk.app_ergebnis !== mk.ergebnis ? ' (' + L.resultModel + ': ' + code(mk.ergebnis) + ')' : ''));
            kv([[L.scaffold, mk.geruest], [fld('abstand'), val(mk.abstand)], [fld('konfidenz'), code(mk.konfidenz)], ['Not mapped', arr(mk.nicht_zugeordnete_teile).join('; ')], [L.species, code(mk.einzelverbindung_genannt)]]);
            table([L.variables, L.definition, L.quoteCheck], arr(mk.variablen).map(function (v) { return [v.name, v.definition_quote, v.app ? QCHK[lang][v.app.quote] : '']; }));
            arr(mk.mappings).forEach(function (mp) { table([L.mappings + ' ' + str(mp.mapping_id) + ' (' + 'all met: ' + code(mp.alle_erfuellt) + ')', 'Fragment', L.verdict, L.reasoning], arr(mp.zuordnung).map(function (zz) { return [zz.variable, zz.fragment + (zz.zaehlung ? ' [' + zz.zaehlung + ']' : ''), verd(zz.verdict), str(zz.begruendung) + (zz.naechster_zulaessiger_wert ? ' (' + zz.naechster_zulaessiger_wert + ')' : '')]; })); });
            table([L.provisos, 'excludes product', L.reasoning], arr(mk.massgaben).map(function (v) { return [v.quote, code(v.schliesst_produkt_aus), v.begruendung]; }));
          });
          if (arr(c.aequivalenz).length) {
            h(5, L.equivalence);
            ul(c.aequivalenz.map(function (q) { return q.feature_id + ': ' + L.replaced + ' = ' + str(q.austauschmittel) + '; ' + L.eqNote + ': ' + code(q.aequivalenz_risiko) + '. ' + str(q.begruendung); }));
          }
        });
      }
      var ev = e.app && e.app.evidence;
      if (ev) {
        h(4, L.evidence);
        p(L.evIntro);
        if (arr(ev.applied).length) { h(5, L.evApplied); ul(ev.applied.map(function (a) { return str(a.text) + (a.to && a.to !== a.from ? ' [' + risk(a.from) + ' -> ' + risk(a.to) + ']' : ''); })); }
        if (ev.markush) {
          h(5, L.evMarkush);
          if (!arr(ev.markush.records).length) p(L.evNoRecord);
          table([L.claim, L.lipid, L.outcome, L.evTranslation, L.evOrigin, L.reasoning], arr(ev.markush.results).map(function (r) { return [r.claim, r.lipid, code(r.overall) + (r.raw && r.raw !== r.overall ? ' (raw: ' + code(r.raw) + ')' : ''), r.reviewed ? L.evReviewed : L.evNotReviewed, r.origin, arr(r.reasons).join('; ')]; }));
          arr(ev.markush.results).forEach(function (r) {
            table([L.claim + ' ' + r.claim + ' / ' + r.lipid + ': ' + L.variables, L.verdict, L.evGroup, L.reasoning, L.quote, L.quoteCheck], arr(r.groups).map(function (gr) { return [gr.name, code(gr.verdict), gr.fragment, gr.why, gr.quote, gr.quoteStatus ? (QCHK[lang][gr.quoteStatus] || gr.quoteStatus) : '']; }));
            table([L.provisos, L.outcome, L.quoteCheck], arr(r.provisos).map(function (pv) { return [pv.quote, pv.matched ? 'applies' : str(pv.why), pv.quoteStatus ? (QCHK[lang][pv.quoteStatus] || pv.quoteStatus) : '']; }));
          });
          ul(arr(ev.markush.errors).map(function (x) { return 'ERR: ' + [x.lipid, x.claim != null ? L.claim + ' ' + x.claim : '', x.reason].filter(Boolean).join(' - '); }));
        }
        if (ev.ranges) {
          var rgv = ev.ranges;
          h(5, L.evRanges);
          if (rgv.reason) p(rgv.reason);
          else if (!arr(rgv.claims).length) p(L.evNoRanges);
          var rrows = [];
          arr(rgv.claims).forEach(function (c) { arr(c.values).forEach(function (v) { if (v.status === 'no_range') return; rrows.push([c.claim + (c.indep ? '' : ' (dep.)'), v.label + (v.comp ? ' (' + v.comp + ')' : ''), str(v.value) + (v.unit ? ' ' + v.unit : ''), str(v.range) + (v.inherited ? ' [' + L.claim + ' ' + v.fromClaim + ']' : '') + (v.approx ? ' (about)' : '') + (v.compUnknown ? ' (component not identified)' : ''), code(v.status), v.quote, str(v.quoteSource) + (v.quoteVerified === true ? ' (verified)' : v.quoteVerified === false ? ' (NOT verified)' : '')]); }); });
          table([L.claim, L.evParam, L.product, L.evRange, L.outcome, L.quote, L.evQuoteSrc], rrows);
          ul(rgv.notes);
        }
        if (arr(ev.limits).length) { h(5, L.evLimits); ul(ev.limits); }
      }
      if (e.dependentFailed) p(L.dependentFailed + ': ' + str(e.dependentFailed.message), 'warn');
      if (da) {
        h(4, L.dependent);
        var rows = [];
        arr(da.unteransprueche).forEach(function (u) {
          var zs = arr(u.zusatzmerkmale);
          if (!zs.length) rows.push([u.claim_no, '', '', verd((u.app && u.app.ketten_ergebnis) || u.ketten_ergebnis), code(u.einzelnennung)]);
          zs.forEach(function (zz, i) { rows.push([i ? '' : u.claim_no, zz.claim_quote + (zz.app && zz.app.quote !== 'ok' ? ' [' + QCHK[lang][zz.app.quote] + ']' : ''), verd((zz.app && zz.app.verdict) || zz.verdict) + ': ' + str(zz.begruendung), i ? '' : verd((u.app && u.app.ketten_ergebnis) || u.ketten_ergebnis), i ? '' : code(u.einzelnennung) + (u.einzelnennung_quote ? ': "' + u.einzelnennung_quote + '"' : '')]); });
        });
        table([L.claim, L.added, L.verdict, L.chain, L.species], rows);
        if (arr(da.rueckzugspositionen).length) { h(5, L.fallback); ul(da.rueckzugspositionen.map(function (r) { return L.claim + ' ' + r.unabhaengiger_anspruch + ' -> ' + (r.engster_noch_treffender_anspruch == null ? '-' : L.claim + ' ' + r.engster_noch_treffender_anspruch) + (r.produkt_faellt_heraus_bei ? ' (' + r.produkt_faellt_heraus_bei + ')' : '') + ': ' + str(r.erlaeuterung); })); }
        if (arr(da.auslegungshinweise).length) { h(5, L.constructionHints); ul(da.auslegungshinweise.map(function (r) { return str(r.begriff) + ' (' + L.claim + ' ' + r.unteranspruch + '): ' + str(r.hinweis); })); }
        if (arr(da.revision_empfohlen).length) { h(5, L.revision); ul(da.revision_empfohlen.map(function (r) { return L.claim + ' ' + r.claim_no + ' ' + str(r.feature_id) + ': ' + str(r.grund); })); }
      }
      if (e.redteamFailed) p(L.redteamFailed + ': ' + str(e.redteamFailed.message), 'warn');
      if (rt) {
        h(4, L.redteam);
        var rr = [];
        arr(rt.claims).forEach(function (rc) {
          arr(rc.angriffe).forEach(function (a2) { rr.push([rc.claim_no, a2.feature_id, codes(a2.angriffsart), a2.argument_patentinhaber, a2.gegenargument_nutzer, code(a2.ergebnis) + ' -> ' + verd(a2.verdict_revidiert)]); });
          arr(rc.gegenfehler).forEach(function (a2) { rr.push([rc.claim_no, a2.feature_id, code('gegenfehler'), a2.problem, '', verd(a2.verdict_revidiert)]); });
          var v = rc.vollstaendigkeit || {}, miss = arr(v.fehlende_merkmale).concat(arr(v.zitatfehler)).concat(arr(v.uebersehene_alternativen));
          if (miss.length) rr.push([rc.claim_no, '', 'completeness', miss.join(' | '), '', '']);
        });
        table([L.claim, L.feature, L.attack, L.patentee, L.counter, L.outcome], rr);
        if (arr(rt.weitere_angriffswege).length) { h(5, L.otherRoutes); ul(rt.weitere_angriffswege.map(function (w) { return code(w.weg) + ' (' + code(w.relevanz) + '): ' + str(w.beschreibung); })); }
        if (rt.revidiert) p(L.revised + ': ' + risk(rt.revidiert.risiko) + '. ' + str(rt.revidiert.begruendung));
      }
      if (ch) {
        var qs = arr(gs.offene_fragen).concat(rt ? arr(rt.zu_klaeren) : []).concat(ev ? arr(ev.questions) : []);
        arr(ch.claims).forEach(function (c) { arr(c.merkmale).forEach(function (m) { if (m.app && m.app.verdict === 'unklar' && m.klaerung) qs.push(L.claim + ' ' + c.claim_no + ' ' + m.feature_id + ': ' + m.klaerung); if (m.app && !m.app.verified) qs.push(L.claim + ' ' + c.claim_no + ' ' + m.feature_id + ': ' + (QCHK[lang][m.app.quote] || '') + ' - check against the original document'); }); if (arr(c.aequivalenz).length) qs.push(L.claim + ' ' + c.claim_no + ': ' + 'equivalence for ' + c.aequivalenz.map(function (q) { return q.feature_id; }).join(', ') + ' (not decided)'); });
        if (qs.length) { h(4, L.questions); ul(qs); }
        if (arr(gs.umgehungsloesungen).length) { h(4, L.designAround); ul(gs.umgehungsloesungen.map(function (u) { return str(u.feature_id) + ': ' + str(u.aenderung) + ' [' + code(u.robustheit) + '] - ' + str(u.vorbehalt); })); }
        var ex = gs.ausnahmen || {}, ro = gs.rolle_des_nutzers || {};
        if (ex.erlaeuterung || ro.erlaeuterung) { h(4, L.exemptions); kv([['Experimental-use exemption (\u00a7 11 No. 2 PatG)', code(ex.versuchsprivileg_par11_nr2)], ['Regulatory (Bolar) exemption (\u00a7 11 No. 2b PatG)', code(ex.zulassungsprivileg_par11_nr2b)], ['US safe harbor (35 U.S.C. \u00a7 271(e)(1))', code(ex.us_safe_harbor_271e1)], ['Tipping point', ex.kipppunkt], ['', ex.erlaeuterung], ['Direct infringement by the user', code(ro.unmittelbar)], ['Indirect / contributory infringement', code(ro.mittelbar_par10_patg_oder_271bc)], ['', ro.erlaeuterung]]); }
        if (arr(gs.hinweise).length) ul(gs.hinweise);
      }
    });

    // 5 cross-cutting model texts
    if (syn) {
      h(2, L.s_cross);
      if (syn.querschnitt) { h(3, L.crossPatterns); md(syn.querschnitt); }
      if (arr(syn.zeitachse).length) { h(3, L.timeline); table([L.right, L.expiry, L.notes], syn.zeitachse.map(function (zt) { var m = arr(op.matrix).filter(function (x) { return x.pn === zt.patent_id; })[0]; return [zt.patent_id, (m && m.expiry) || zt.ablauf_geschaetzt, zt.bemerkung]; })); }
      if (syn.ausnahmen) { h(3, L.exemptionsAll); md(syn.ausnahmen); }
      if (arr(syn.umgehungsloesungen).length) { h(3, L.daAll); table(['Change', L.right, L.collides, 'Assessment'], syn.umgehungsloesungen.map(function (u) { return [u.aenderung, arr(u.betrifft_schutzrechte).join(', '), arr(u.kollision_mit_anderen).join(', '), u.bewertung]; })); }
      if (syn.gegenpruefung) { h(3, L.redAll); md(syn.gegenpruefung); }
      if (syn.anhaengige_anmeldungen) { h(3, L.pendingText); md(syn.anhaengige_anmeldungen); }
    }

    // 6 not charted
    h(2, L.s_not);
    var groups = {}, order = ['depth_limit', 'no_text', 'text_cut', 'dead', 'triage_c', 'no_ai', 'market', 'wo'];
    arr(op.notCharted).forEach(function (n) { (groups[n.reason] = groups[n.reason] || []).push(n); });
    if (!arr(op.notCharted).length) p(L.none);
    order.concat(Object.keys(groups).filter(function (k) { return order.indexOf(k) < 0; })).forEach(function (k) {
      if (!groups[k]) return;
      h(3, (REASON[lang][k] || k) + ' (' + groups[k].length + ')');
      table([L.right, 'Title', L.status, L.expiry, L.reason], groups[k].map(function (n) { return [n.pn, n.title, n.status, n.expiry, n.text]; }));
    });

    // 7 next steps
    h(2, L.s_next);
    if (syn && arr(syn.naechste_schritte).length) table([L.prio, L.step, L.why], syn.naechste_schritte.slice().sort(function (a, b) { return (a.prioritaet || 0) - (b.prioritaet || 0); }).map(function (s) { return [s.prioritaet, s.schritt, s.warum]; }));
    h(3, L.alwaysNext); ul(NEXT[lang]);
    if (syn && arr(syn.offene_fragen).length) { h(3, L.openQ); ul(syn.offene_fragen); }
    if (op.usage || op.run) { h(3, L.s_usage); p((op.run ? op.run.calls + ' ' + L.calls + (op.run.resumedSteps ? ', ' + op.run.resumedSteps + ' ' + L.resumed : '') : '') + (op.usage ? '; ' + op.usage.bytesIn + ' / ' + op.usage.bytesOut + ' bytes in/out' : '')); }
    N.push({ limits: str(op.limits) });
    /* presentation metadata for the HTML cover and summary (derived from the same fields; not rendered by Markdown/JSON) */
    var rights = {};
    arr(op.matrix).forEach(function (m) { if (m && m.pn) rights[m.pn] = { risk: str(m.risk) }; });
    var meta = { id: str(op.id), created: str(op.finished || op.created).slice(0, 10), snapshot: str(op.statusSnapshot || snap.ep_register || '').slice(0, 10), rights: rights,
      markets: op.overall ? arr(op.overall.markets).map(function (m) { return { market: m.market === 'EP_UPC' ? 'EP / UPC' : str(m.market), risk: str(m.risk), drivers: arr(m.drivers).map(str) }; }) : [],
      pending: op.overall && op.overall.pending && op.overall.pending.risk ? { risk: str(op.overall.pending.risk), drivers: arr(op.overall.pending.drivers).map(str) } : null,
      nPatents: arr(op.patents).length, nNot: arr(op.notCharted).length, aiUsed: !!op.aiUsed };
    return { nodes: N, lang: lang, title: str(op.title || L.title), meta: meta };
  }

  // ------------------------------------------------------------------------------------------------ markdown
  function cell(s) { return str(s).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim(); }
  function toMarkdown(doc) {
    var out = [];
    doc.nodes.forEach(function (n) {
      if (n.limits !== undefined) out.push(n.limits);
      else if (n.h) out.push(new Array(n.h + 1).join('#') + ' ' + str(n.t).replace(/\r?\n+/g, ' '));
      else if (n.p !== undefined) out.push((n.cls === 'warn' ? '**' + n.p.replace(/\*/g, '') + '**' : n.p));
      else if (n.md !== undefined) out.push(n.md.trim());
      else if (n.ul) out.push(n.ul.map(function (x) { return '- ' + x.replace(/\r?\n+/g, ' '); }).join('\n'));
      else if (n.kv) out.push(n.kv.map(function (x) { return '- ' + (x[0] ? x[0] + ': ' : '') + x[1].replace(/\r?\n+/g, ' '); }).join('\n'));
      else if (n.table) out.push('| ' + n.table.head.map(cell).join(' | ') + ' |\n|' + n.table.head.map(function () { return ' --- |'; }).join('') + '\n' + n.table.rows.map(function (r) { return '| ' + r.map(cell).join(' | ') + ' |'; }).join('\n'));
    });
    return out.join('\n\n');
  }

  // ------------------------------------------------------------------------------------------------ html
  /* model text ("Markdown, no HTML"): escaped first, then only paragraphs, line breaks, simple lists and **bold** */
  function mdToHtml(t) {
    var blocks = str(t).replace(/\r/g, '').split(/\n{2,}/), out = [];
    function inline(s) { return esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>'); }
    blocks.forEach(function (b) {
      var lines = b.split('\n').filter(function (l) { return l.trim(); });
      if (!lines.length) return;
      if (lines.every(function (l) { return /^\s*([-*]|\d+[.)])\s+/.test(l); })) out.push('<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*([-*]|\d+[.)])\s+/, '')) + '</li>'; }).join('') + '</ul>');
      else if (/^#{1,6}\s/.test(lines[0]) && lines.length === 1) out.push('<p><strong>' + inline(lines[0].replace(/^#{1,6}\s+/, '')) + '</strong></p>');
      else out.push('<p>' + lines.map(inline).join('<br>') + '</p>');
    });
    return out.join('\n');
  }
  /* Report design: the app's tokens (warm neutrals, header-band gradient, risk scale) with system font fallbacks only; no remote fonts,
     images or scripts. Light theme for paper; an optional dark theme for on-screen reading. Print: A4, running footer in the page margin
     boxes (where the browser supports them), headings kept with their content, tables split by row with a repeated header. */
  var CSS = ':root{--bg:#fff;--surface:#faf9f9;--muted:#f2efef;--line:#e7e4e4;--line-strong:#d7d0d0;--text:#292424;--dim:#574e4e;--faint:#796b6b;' +
    '--good:#3b7b34;--warn:#b45309;--crit:#bc2706;--info:#4128da;--good-bg:#edf5ec;--warn-bg:#fbf1e3;--crit-bg:#fbece8;--info-bg:#eeecfb;' +
    '--risk0:#3b7b34;--risk1:#8a9a2a;--risk2:#b45309;--risk3:#dc2b05;--risk4:#97260c;--band-a:#473f96;--band-b:#6b3d89;--band-c:#953c65;--band-d:#a03d57;--band-e:#b0412a;' +
    '--font:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--mono:"Martian Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}' +
    '@media screen and (prefers-color-scheme:dark){:root{--bg:#171212;--surface:#1c1717;--muted:#292424;--line:#3a3232;--line-strong:#4a4040;--text:#f2efef;--dim:#c9c0c0;--faint:#a99d9d;' +
    '--good:#78d771;--warn:#fcd34d;--crit:#fa856b;--info:#9ca8ff;--good-bg:#1d2b1b;--warn-bg:#33290f;--crit-bg:#381b14;--info-bg:#201f3d;--risk0:#78d771;--risk1:#c3d45c;--risk2:#fcd34d;--risk3:#f95834;--risk4:#fa856b}}' +
    '*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    'body{margin:0 auto;max-width:980px;padding:24px 16px 56px;background:var(--bg);color:var(--text);font:14.5px/1.55 var(--font);overflow-wrap:break-word}' +
    'h1,h2,h3,h4,h5{font-weight:600;letter-spacing:-.02em;line-height:1.25;margin:0;break-after:avoid;page-break-after:avoid}' +
    'h2{font-size:23px;letter-spacing:-.03em;margin:0 0 14px}h3{font-size:17px;margin:26px 0 8px}h4{font-size:14.5px;margin:20px 0 6px}h5{font-size:13px;margin:14px 0 4px;color:var(--dim)}' +
    'p{margin:6px 0}ul,ol{margin:6px 0;padding-left:20px}li{margin:2px 0}strong{font-weight:600}' +
    /* notice (the verbatim limits block, first and last element of the document) */
    'pre.limits{white-space:pre-wrap;overflow-wrap:break-word;margin:0 0 18px;padding:14px 16px 14px 18px;border:1px solid var(--crit);border-left:6px solid var(--crit);border-radius:10px;background:var(--crit-bg);color:var(--text);font:13px/1.5 var(--font);break-inside:avoid;page-break-inside:avoid}' +
    'pre.limits::first-line{font-weight:700;color:var(--crit)}body>pre.limits:last-child{margin:36px 0 0}' +
    /* cover */
    '.cover{position:relative;overflow:hidden;border-radius:16px;padding:30px 32px 26px;color:#fff;background:linear-gradient(120deg,var(--band-a) 0%,var(--band-b) 28%,var(--band-c) 56%,var(--band-d) 78%,var(--band-e) 100%);break-inside:avoid;page-break-inside:avoid}' +
    '.cover .mark{display:flex;align-items:center;gap:10px;font-size:15px;letter-spacing:-.01em}.cover .mark .lg{display:inline-block;width:22px;height:22px;border-radius:7px;border:2px solid #ffffffcc;background:linear-gradient(135deg,#ffffff55,#ffffff11)}.cover .mark strong{font-weight:700}.cover .mark span{font-weight:300}' +
    '.cover .kick{margin:34px 0 8px;font:600 11px/1.2 var(--font);letter-spacing:.12em;text-transform:uppercase;opacity:.85}' +
    '.cover h1{font-size:33px;font-weight:600;letter-spacing:-.032em;line-height:1.12;margin:0;max-width:30ch}' +
    '.cover .tag{display:inline-block;margin:16px 0 0;padding:5px 12px;border:1px solid #ffffffb3;border-radius:999px;background:#ffffff1f;font-size:12.5px;font-weight:600}' +
    '.cover dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px 20px;margin:26px 0 0;padding-top:16px;border-top:1px solid #ffffff55}.cover dt{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;font-weight:500}.cover dd{margin:2px 0 0;font-size:13px;font-weight:500;overflow-wrap:anywhere}' +
    /* contents */
    '.toc{margin:26px 0 0;padding:18px 22px;border:1px solid var(--line);border-radius:12px;background:var(--surface);break-inside:avoid;page-break-inside:avoid}.toc h2{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 8px}' +
    '.toc ol{list-style:none;margin:0;padding:0}.toc>ol>li{margin:5px 0;font-weight:500}.toc ol ol{margin:3px 0 6px 18px}.toc ol ol li{font-weight:400;font-size:13px;margin:2px 0;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.toc a{color:var(--text);text-decoration:none;border-bottom:1px solid var(--line-strong)}.toc a:hover{border-bottom-color:var(--text)}' +
    /* sections */
    '.sec{margin:44px 0 0}.sec>h2{padding-bottom:8px;border-bottom:2px solid var(--text)}' +
    '.right{margin:30px 0 0;padding:18px 20px 6px;border:1px solid var(--line);border-top:4px solid var(--line-strong);border-radius:12px;background:var(--bg)}.right.r5,.right.r4{border-top-color:var(--risk4)}.right.r3{border-top-color:var(--risk3)}.right.r2{border-top-color:var(--risk2)}.right.r1{border-top-color:var(--risk0)}' +
    '.rhead{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;justify-content:space-between;break-after:avoid;page-break-after:avoid}.rhead h3{margin:0;font-size:18px}' +
    /* risk, verdict and quote markers: always text plus a symbol, never colour alone */
    '.rk{display:inline-flex;align-items:center;gap:7px;padding:2px 9px 2px 8px;border:1px solid var(--line-strong);border-left:4px solid var(--faint);border-radius:6px;background:var(--surface);font-size:.92em;font-weight:600;line-height:1.35;white-space:nowrap}' +
    '.rk .pips{font-size:.72em;letter-spacing:.06em;color:var(--faint)}.rk.r1{border-left-color:var(--risk0)}.rk.r1 .pips{color:var(--risk0)}.rk.r2{border-left-color:var(--risk1)}.rk.r2 .pips{color:var(--risk1)}.rk.r3{border-left-color:var(--risk2)}.rk.r3 .pips{color:var(--risk2)}.rk.r4{border-left-color:var(--risk3)}.rk.r4 .pips{color:var(--risk3)}.rk.r5{border-left-color:var(--risk4)}.rk.r5 .pips{color:var(--risk4)}' +
    '.rk.r0::before{content:"?";font-weight:700;color:var(--faint)}.rsep{color:var(--faint);margin:0 4px}' +
    '.vd,.qm{display:inline-block;padding:1px 7px;border:1px solid var(--line-strong);border-radius:6px;font-size:.92em;font-weight:600;line-height:1.4}.vd .g,.qm .g{margin-right:5px}' +
    '.vd.met{border-color:var(--crit);background:var(--crit-bg)}.vd.not{border-color:var(--good);background:var(--good-bg)}.vd.unc{border-color:var(--warn);background:var(--warn-bg)}' +
    '.qm.ok{border-color:var(--good);background:var(--good-bg)}.qm.dev{border-color:var(--warn);background:var(--warn-bg)}.qm.bad{border-color:var(--crit);background:var(--crit-bg);color:var(--crit)}' +
    /* executive summary */
    '.exec{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:16px;margin:0 0 20px;break-inside:avoid;page-break-inside:avoid}' +
    '.hero{padding:18px 20px;border:1px solid var(--line-strong);border-left:8px solid var(--faint);border-radius:12px;background:var(--surface)}.hero.r1{border-left-color:var(--risk0)}.hero.r2{border-left-color:var(--risk1)}.hero.r3{border-left-color:var(--risk2)}.hero.r4{border-left-color:var(--risk3)}.hero.r5{border-left-color:var(--risk4)}' +
    '.hero .lab{font:600 11px/1.2 var(--font);letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}.hero .lvl{display:block;margin:6px 0 2px;font-size:30px;font-weight:600;letter-spacing:-.03em;line-height:1.1}.hero .pips{display:block;font-size:15px;letter-spacing:.14em;color:var(--faint)}.hero.r1 .pips{color:var(--risk0)}.hero.r2 .pips{color:var(--risk1)}.hero.r3 .pips{color:var(--risk2)}.hero.r4 .pips{color:var(--risk3)}.hero.r5 .pips{color:var(--risk4)}.hero .why{margin:8px 0 0;font-size:12.5px;color:var(--dim)}' +
    '.mk{display:grid;gap:8px;align-content:start}.mk .row{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}.mk .row strong{font-weight:600}.mk .cnt{font-size:12.5px;color:var(--dim);padding:0 2px}' +
    /* callouts */
    '.co{margin:16px 0;padding:2px 14px 8px;border:1px solid var(--line);border-left:4px solid var(--line-strong);border-radius:8px;background:var(--surface)}.co>h4,.co>h5:first-child{margin-top:10px}' +
    '.co.evidence{border-left-color:var(--info);background:var(--info-bg)}.co.openq{border-left-color:var(--warn);background:var(--warn-bg)}.co.redteam{border-left-color:var(--risk3)}.co.da{border-left-color:var(--good)}.co.appnotes{border-left-color:var(--faint)}.co.verdict{border-left-color:var(--band-a)}' +
    '.co{break-inside:avoid;page-break-inside:avoid}.co.evidence{break-inside:auto;page-break-inside:auto}table.chart th:nth-child(3){width:16%}table.chart td:nth-child(3){min-width:15ch}.co table{background:var(--bg)}' +
    /* facts, prose, tables */
    'dl.kv{display:grid;grid-template-columns:minmax(120px,230px) 1fr;gap:3px 16px;margin:8px 0}dl.kv dt{font-weight:600;color:var(--dim)}dl.kv dd{margin:0;overflow-wrap:anywhere}' +
    '.facts{padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);break-inside:avoid;page-break-inside:avoid}' +
    '.model{border-left:3px solid var(--line-strong);padding:0 0 0 12px;margin:8px 0}.warn{border:1px solid var(--warn);border-left:5px solid var(--warn);border-radius:8px;background:var(--warn-bg);padding:7px 12px;font-weight:600}' +
    '.tw{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-size:12.5px;line-height:1.45}' +
    'th{padding:6px 8px;border-bottom:2px solid var(--text);text-align:left;vertical-align:bottom;font-weight:600;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--dim)}td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left;overflow-wrap:break-word}table.matrix td{overflow-wrap:anywhere}' +
    'thead{display:table-header-group}tfoot{display:table-footer-group}tr{break-inside:avoid;page-break-inside:avoid}' +
    'table.chart td.q{font-family:var(--font);font-style:italic;color:var(--text);border-left:3px solid var(--line-strong);background:var(--surface)}table.chart td.f{font-family:var(--mono);font-size:.88em;white-space:nowrap}table.chart td.f+td{min-width:22ch}' +
    'td .rk{display:flex;width:max-content;max-width:100%;margin:1px 0;white-space:nowrap;padding:1px 7px 1px 6px}td .rk .pips{display:none}td .rsep{display:none}table.matrix td:first-child{font-weight:600}table.matrix{font-size:11.5px;table-layout:fixed;min-width:760px}table.matrix th{overflow-wrap:anywhere}table.matrix th:nth-child(1){width:11%}table.matrix th:nth-child(2){width:8%}table.matrix th:nth-child(3){width:9.5%}table.matrix th:nth-child(4),table.matrix th:nth-child(5){width:11.5%}table.matrix th:nth-child(6){width:9%}table.matrix th:nth-child(7){width:14%}table.matrix th:nth-child(8){width:9%}table.matrix th:nth-child(9){width:16%}table.matrix td .rk{white-space:normal;padding:1px 5px}table.queries td{font-family:var(--mono);font-size:.86em}' +
    '.about{margin:36px 0 0;padding:18px 22px;border:1px solid var(--line);border-radius:12px;background:var(--surface);font-size:13px;color:var(--dim);break-inside:avoid;page-break-inside:avoid}.about h2{font-size:15px;color:var(--text);margin:0 0 6px}.about h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:14px 0 4px}.about ul{margin:4px 0}' +
    '.about .scale{display:flex;flex-wrap:wrap;gap:6px 8px;margin:6px 0}' +
    '.endnote{margin:20px 0 0;font-size:11.5px;color:var(--faint)}' +
    '@media (max-width:720px){body{font-size:14px;padding:16px}.cover{padding:22px 20px}.cover h1{font-size:25px}.exec{grid-template-columns:1fr}dl.kv{grid-template-columns:1fr;gap:0}dl.kv dd{margin-bottom:6px}.right{padding:14px 14px 4px}.rk{white-space:normal}}' +
    '@page{size:A4;margin:16mm 14mm 20mm}' +
    '@media print{html{font-size:10pt}body{max-width:none;margin:0;padding:0;background:#fff;color:#292424;font-size:9.6pt;line-height:1.45}:root{--bg:#fff}' +
    'h2{font-size:15pt}h3{font-size:12pt;margin-top:16px}h4{font-size:10.5pt;margin-top:13px}h5{font-size:9.6pt}' +
    '.cover{padding:20px 22px 18px;border-radius:10px}.cover h1{font-size:23pt}.cover .kick{margin-top:22px}.cover dl{margin-top:16px}' +
    'body>pre.limits:first-child{font-size:8pt;line-height:1.35;padding:8px 12px 8px 14px;margin-bottom:12px}pre.limits{font-size:9pt}' +
    '.toc{margin-top:14px;padding:12px 16px}.sec{margin-top:26px}.right{margin-top:20px;padding:12px 14px 2px;border-radius:8px}.right+.right{break-before:page;page-break-before:always}' +
    '.tw{overflow:visible}table{font-size:8.2pt}table.matrix{font-size:7.4pt;min-width:0}table.matrix th{font-size:6.4pt;letter-spacing:0}th{font-size:7.2pt}th,td{padding:4px 5px}.rk,.vd,.qm{font-size:.94em}.hero .lvl{font-size:22pt}' +
    'h2,h3,h4,h5,.rhead{break-after:avoid;page-break-after:avoid}.co>h4{break-after:avoid}p,li{orphans:3;widows:3}a{color:inherit;text-decoration:none}.tw{break-inside:auto}}';
  var UI = {
    en: { kick: 'Freedom-to-operate pre-screening', tag: 'Pre-screening, not legal advice', toc: 'Contents', overall: 'Overall risk', basis: 'Highest level across the target markets, computed by the app from the individual assessments.',
      pendingL: 'Pending applications', analysed: 'patent rights analysed', notAn: 'not analysed', byAI: 'AI analysis not available in this run', drivers: 'Driven by', about: 'How to read this report', scale: 'Risk scale (1 to 5; "cannot be assessed" is not a low risk)',
      markers: 'Marks', mq: 'quote found verbatim in the claim text (checked by code)', md: 'quote found only with an omission or relaxed spelling, to be checked by hand', mb: 'quote not verified; the row is treated as unclear',
      mv: 'Verdict "met" means the claim feature is found in the product; it is the adverse reading for the product.', method: 'Method', mt: 'Quotes are verified against the claim text, numeric ranges and structure matches are computed in code, and the final risk is the more adverse of the claim chart and the red-team review. The model only translates and explains. Evidence computed by the app only adds flags, questions and risk floors; it never lowers a risk.',
      foot: 'LNP Patent Desk \u00b7 FTO pre-screening, not legal advice', snap: 'Status snapshot', page: 'Page', of: 'of', end: 'This document is a pre-screening and not legal advice. It is based on the corpus snapshot and legal status stated above; see the limits block.', created: 'Created', cannot: 'cannot be assessed' }
  };
  function lvl(code) { var m = /^(\d)_/.exec(str(code)); return m ? +m[1] : 0; }
  function pips(n) { return n ? '<span class="pips" aria-hidden="true">' + new Array(n + 1).join('\u25cf') + new Array(6 - n).join('\u25cb') + '</span>' : ''; }
  /* only fixed text and the safe characters of a date may enter a CSS string */
  function cssStr(s) { return str(s).replace(/[^0-9A-Za-z .,:\-\u00b7]/g, '').replace(/\u00b7/g, '\\00b7 '); }
  function toHtml(doc) {
    var lang = 'en', L = T.en, U = UI.en, meta = doc.meta || { rights: {}, markets: [] }, out = [], nodes = doc.nodes;
    function riskChip(code, text) { var n = lvl(code); return '<span class="rk r' + n + '">' + pips(n) + '<span>' + esc(text || RISK[lang][code] || code || L.notAssessed) + '</span></span>'; }
    var byLabel = {}; Object.keys(RISK[lang]).forEach(function (k) { byLabel[RISK[lang][k]] = k; });
    var qByLabel = {}; Object.keys(QCHK[lang]).forEach(function (k) { qByLabel[QCHK[lang][k]] = k; });
    var vByLabel = {}; Object.keys(VERD[lang]).forEach(function (k) { vByLabel[VERD[lang][k]] = k; });
    var QCLS = { ok: ['ok', '\u2714'], elided: ['dev', '\u2248'], approx: ['dev', '\u2248'], fail: ['bad', '\u2716'], empty: ['bad', '\u2716'] };
    var VCLS = { erfuellt: ['met', '\u25a0'], nicht_erfuellt: ['not', '\u25a1'], unklar: ['unc', '?'], moeglich: ['unc', '\u25d0'] };
    /* a table cell: a risk level, a verdict or a quote check becomes a text-plus-symbol marker; everything else is plain escaped text */
    function cell(c, ch) {
      var parts = c.split(' / '), k;
      if (parts.length && parts.every(function (x) { return Object.prototype.hasOwnProperty.call(byLabel, x); })) return parts.map(function (x) { return riskChip(byLabel[x], x); }).join('<span class="rsep">/</span>');
      if (ch) {
        if (Object.prototype.hasOwnProperty.call(qByLabel, c)) { k = QCLS[qByLabel[c]]; return '<span class="qm ' + k[0] + '"><span class="g" aria-hidden="true">' + k[1] + '</span>' + esc(c) + '</span>'; }
        if (Object.prototype.hasOwnProperty.call(vByLabel, c)) { k = VCLS[vByLabel[c]]; return '<span class="vd ' + k[0] + '"><span class="g" aria-hidden="true">' + k[1] + '</span>' + esc(c) + '</span>'; }
      }
      return esc(c);
    }
    function tableHtml(t) {
      var ch = t.cls === 'chart', cls = t.cls === 'chart' || t.cls === 'matrix' || t.cls === 'queries' ? ' class="' + t.cls + '"' : '';
      return '<div class="tw"><table' + cls + '><thead><tr>' + t.head.map(function (c) { return '<th scope="col">' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        t.rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (ch && i === 1 ? ' class="q"' : ch && i === 0 ? ' class="f"' : '') + '>' + cell(c, ch) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    }
    var CO = {}; [['evidence', 'evidence'], ['questions', 'openq'], ['openQ', 'openq'], ['redteam', 'redteam'], ['designAround', 'da'], ['appNotes', 'appnotes'], ['shortVerdict', 'verdict']].forEach(function (x) { if (L[x[0]]) CO[L[x[0]]] = x[1]; });

    // first pass: ids for the contents list
    var toc = [], secNo = 0, rightNo = 0, i, n;
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (n.h === 2) { secNo++; toc.push({ id: 's' + secNo, t: n.t, sub: [] }); }
      else if (n.h === 3 && toc.length && /^4\./.test(toc[toc.length - 1].t)) { rightNo++; toc[toc.length - 1].sub.push({ id: 'r' + rightNo, t: n.t }); }
    }
    function rightKey(t) { return str(t).split(' - ')[0]; }

    // cover
    var title = '', coverKv = null, started = 0;
    for (i = 0; i < nodes.length; i++) { if (nodes[i].h === 1) { title = nodes[i].t; if (nodes[i + 1] && nodes[i + 1].kv) coverKv = nodes[i + 1].kv; break; } }
    var cover = '<header class="cover"><div class="mark" aria-label="LNP Patent Desk"><span class="lg" aria-hidden="true"></span><span><strong>LNP</strong> <span>Patent Desk</span></span></div><p class="kick">' + esc(U.kick) + '</p><h1>' + esc(title) + '</h1><p class="tag">' + esc(U.tag) + '</p>' +
      (coverKv ? '<dl>' + coverKv.map(function (x) { return '<div><dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd></div>'; }).join('') + '</dl>' : '') + '</header>';
    var tocHtml = '<nav class="toc" aria-label="' + esc(U.toc) + '"><h2>' + esc(U.toc) + '</h2><ol>' + toc.map(function (e) {
      return '<li><a href="#' + e.id + '">' + esc(e.t) + '</a>' + (e.sub.length ? '<ol>' + e.sub.map(function (s) { var m = meta.rights[rightKey(s.t)]; return '<li><a href="#' + s.id + '">' + esc(s.t) + '</a>' + (m && m.risk ? riskChip(m.risk) : '') + '</li>'; }).join('') + '</ol>' : '') + '</li>';
    }).join('') + '</ol></nav>';
    // executive summary block
    function hero() {
      var top = 0, anyNa = false;
      meta.markets.forEach(function (m) { var l = lvl(m.risk); if (l > top) top = l; if (!l) anyNa = true; });
      var topCode = top ? ['', '1_sehr_gering', '2_gering', '3_mittel', '4_hoch', '5_sehr_hoch'][top] : 'nicht_beurteilbar';
      var drivers = []; meta.markets.forEach(function (m) { if (lvl(m.risk) === top) m.drivers.forEach(function (d) { if (drivers.indexOf(d) < 0) drivers.push(d); }); });
      var h = '<div class="exec"><div class="hero r' + top + '"><span class="lab">' + esc(U.overall) + '</span><span class="lvl">' + esc(RISK[lang][topCode]) + '</span>' + pips(top) + '<p class="why">' + esc(U.basis) + (drivers.length ? ' ' + esc(U.drivers) + ' ' + esc(drivers.join(', ')) + '.' : '') + (anyNa && top ? ' ' + esc(RISK[lang].nicht_beurteilbar.charAt(0).toUpperCase() + RISK[lang].nicht_beurteilbar.slice(1)) + ' \u2260 ' + esc(RISK[lang]['1_sehr_gering']) + '.' : '') + '</p></div><div class="mk">';
      meta.markets.forEach(function (m) { h += '<div class="row"><strong>' + esc(m.market) + '</strong>' + riskChip(m.risk) + '</div>'; });
      if (meta.pending) h += '<div class="row"><strong>' + esc(U.pendingL) + '</strong>' + riskChip(meta.pending.risk) + '</div>';
      h += '<div class="cnt">' + esc(meta.nPatents + ' ' + U.analysed + (meta.nNot ? ' \u00b7 ' + meta.nNot + ' ' + U.notAn : '') + (meta.aiUsed ? '' : ' \u00b7 ' + U.byAI)) + '</div></div></div>';
      return h;
    }

    // main pass
    var stack = [], inRights = false, secIdx = 0, rIdx = 0, firstSec = true;
    function popTo(level) { while (stack.length && stack[stack.length - 1].level >= level) out.push(stack.pop().close); }
    out.push(null); // limits (first)
    out.push(cover, tocHtml);
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (n.limits !== undefined) { if (i === 0) { out[0] = '<pre class="limits">' + esc(n.limits) + '</pre>'; } else { popTo(0); out.push(aboutHtml(), '<pre class="limits">' + esc(n.limits) + '</pre>'); } }
      else if (n.h === 1) { /* in the cover */ }
      else if (n.kv && nodes[i - 1] && nodes[i - 1].h === 1) { /* in the cover */ }
      else if (n.h === 2) {
        popTo(0); secIdx++; inRights = /^4\./.test(n.t);
        out.push('<section class="sec' + (firstSec ? ' first' : '') + '" id="s' + secIdx + '"><h2>' + esc(n.t) + '</h2>' + (/^1\./.test(n.t) ? hero() : '')); stack.push({ level: 2, close: '</section>' }); firstSec = false;
      } else if (n.h === 3 && inRights) {
        popTo(3); rIdx++; var rm = meta.rights[rightKey(n.t)], rl = rm ? lvl(rm.risk) : 0;
        out.push('<section class="right r' + rl + '" id="r' + rIdx + '"><div class="rhead"><h3>' + esc(n.t) + '</h3>' + (rm && rm.risk ? riskChip(rm.risk) : '') + '</div>'); stack.push({ level: 3, close: '</section>' });
      } else if (n.h) {
        var l = Math.max(1, Math.min(6, n.h)); popTo(l);
        var co = CO[n.t];
        if (co && l >= 3) { out.push('<div class="co ' + co + '">'); stack.push({ level: l, close: '</div>' }); }
        out.push('<h' + l + '>' + esc(n.t) + '</h' + l + '>');
      }
      else if (n.p !== undefined) out.push('<p' + (n.cls === 'warn' ? ' class="warn"' : '') + '>' + esc(n.p) + '</p>');
      else if (n.md !== undefined) out.push('<div class="model">' + mdToHtml(n.md) + '</div>');
      else if (n.ul) out.push('<ul>' + n.ul.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      else if (n.kv) out.push('<dl class="kv' + (inRights && stack.length && stack[stack.length - 1].level === 3 ? ' facts' : '') + '">' + n.kv.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl>');
      else if (n.table) out.push(tableHtml(n.table));
    }
    popTo(0);
    function aboutHtml() {
      var scale = [1, 2, 3, 4, 5].map(function (k) { return riskChip(['', '1_sehr_gering', '2_gering', '3_mittel', '4_hoch', '5_sehr_hoch'][k]); }).join('') + riskChip('nicht_beurteilbar');
      return '<aside class="about" aria-label="' + esc(U.about) + '"><h2>' + esc(U.about) + '</h2><h3>' + esc(U.scale) + '</h3><div class="scale">' + scale + '</div><h3>' + esc(U.markers) + '</h3><ul>' +
        '<li><span class="qm ok"><span class="g" aria-hidden="true">\u2714</span>' + esc(QCHK[lang].ok) + '</span> ' + esc(U.mq) + '</li>' +
        '<li><span class="qm dev"><span class="g" aria-hidden="true">\u2248</span>' + esc(QCHK[lang].elided.split(':')[0]) + '</span> ' + esc(U.md) + '</li>' +
        '<li><span class="qm bad"><span class="g" aria-hidden="true">\u2716</span>' + esc(QCHK[lang].fail.split(':')[0]) + '</span> ' + esc(U.mb) + '</li></ul><p>' + esc(U.mv) + '</p><h3>' + esc(U.method) + '</h3><p>' + esc(U.mt) + '</p></aside>';
    }
    var foot = '@page{@bottom-left{content:"' + cssStr(U.foot + ' \u00b7 ' + (meta.snapshot ? U.snap + ' ' + meta.snapshot : '')) + '";font:7.5pt Arial,sans-serif;color:#574e4e;vertical-align:top;padding-top:6mm}' +
      '@bottom-right{content:"' + cssStr(U.page) + ' " counter(page) " ' + cssStr(U.of) + ' " counter(pages);font:7.5pt Arial,sans-serif;color:#574e4e;vertical-align:top;padding-top:6mm}}';
    return '<!doctype html>\n<html lang="' + lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>' + esc(doc.title) + '</title><style>' + CSS + foot + '</style></head><body>\n' + out.join('\n') + '\n</body></html>';
  }

  function toJson(op) {
    var o = { hinweis: str(op.limits) }, k;
    for (k in op) if (Object.prototype.hasOwnProperty.call(op, k) && k !== 'hinweis' && k !== 'hinweis_ende') o[k] = op[k];
    o.hinweis_ende = str(op.limits);
    return JSON.stringify(o, null, 1);
  }
  /* compatibility: an opinion saved by an older version may carry the German limits block; it is replaced by the
     English block (same content, same snapshot date) so that no German text is rendered around the report */
  function englishLimits(op) {
    var P = g.LnpFtoPrompts, l = str(op.limits);
    if (!/^Wichtiger Hinweis/.test(l) || !P || typeof P.limits !== 'function') return op;
    var m = /Datenstand vom (\S+?) und/.exec(l), o = {}, k;
    for (k in op) if (Object.prototype.hasOwnProperty.call(op, k)) o[k] = op[k];
    o.limits = P.limits('en', (m && m[1]) || op.statusSnapshot || null);
    return o;
  }
  function render(op, fmt) {
    if (!op || typeof op !== 'object') throw { code: 'bad_opinion', message: 'no opinion' };
    if (!str(op.limits)) throw { code: 'bad_opinion', message: 'opinion without limits block is not rendered' };
    op = englishLimits(op);
    if (fmt === 'json') return toJson(op);
    var doc = build(op);
    return fmt === 'html' ? toHtml(doc) : toMarkdown(doc);
  }
  /* body fragment for the page: the same nodes without the document frame (strings escaped the same way) */
  function fragment(op) { var h = toHtml(build(op)); return h.slice(h.indexOf('<body>') + 6, h.lastIndexOf('</body>')).trim(); }

  var api = { render: render, fragment: fragment, build: build, esc: esc, mdToHtml: mdToHtml, CSS: CSS, label: label, field: field };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.LnpFtoRender = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
