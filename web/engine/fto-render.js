/* LNP-FTO opinion renderer (global LnpFtoRender). Plain script, no dependencies.
   render(opinion, "md" | "html" | "json") -> string.
   - Output language: English by default; German only when opinion.lang === "de". Internal codes (risk levels, verdicts,
     flags, schema field names) are mapped to English labels for display; claim quotes stay verbatim.
   - Every rendering STARTS and ENDS with the verbatim limits block (opinion.limits = LIMITS_EN / LIMITS_DE with the
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
    de: {
      title: 'FTO-Vorpr\u00fcfung (kein Rechtsgutachten)', created: 'Erstellt', depth: 'Tiefe', markets: 'M\u00e4rkte', corpus: 'Korpusstand', none: 'keine', yes: 'ja', no: 'nein', unknown: 'unbekannt',
      s_summary: '1. Zusammenfassung', s_overall: 'Gesamtrisiko je Markt (von der App aus den Einzelbewertungen berechnet)', market: 'Markt', risk: 'Risiko', drivers: 'Treibende Schutzrechte',
      pendingApps: 'Anh\u00e4ngige Anmeldungen (gesondert; Anspr\u00fcche ver\u00e4nderlich)', matrix: 'Risikomatrix', right: 'Schutzrecht', rel: 'Relevanz', literal: 'Wortsinn (ung\u00fcnstigster Anspruch)', status: 'Rechtsstand', expiry: 'Ablauf (Sch\u00e4tzung)', notes: 'Hinweise',
      riskBE: 'Analyse / Gegenpr\u00fcfung', noAi: 'Die KI-Funktion stand nicht zur Verf\u00fcgung. Dieses Dokument enth\u00e4lt nur die Recherche und den Rechtsstand, keine Merkmalsanalyse.',
      noCharts: 'Es wurde kein Schutzrecht analysiert.', depthWarn: 'Achtung: Schutzrechte mit Triage-Relevanz A oder B wurden wegen der gew\u00e4hlten Tiefe NICHT analysiert', seeNotCharted: 'siehe Abschnitt 6',
      warnings: 'Hinweise der App zu diesem Lauf', modelSummary: 'Zusammenfassende Bewertung (Claude; aus den Einzelbewertungen, nicht bindend)', synthFailed: 'Die zusammenfassende Bewertung (Synthese) ist fehlgeschlagen', synthFlags: 'Hinweise der App zur Synthese',
      s_profile: '2. Gepr\u00fcfter Gegenstand (Produktprofil, wie verstanden)', ionLipid: 'Ionisierbares Lipid', name: 'Name', structDesc: 'Strukturbeschreibung', formula: 'Summenformel', mw: 'Molmasse', computed: 'von der App berechnet (OpenChemLib), nicht vom Modell',
      otherLipids: 'Weitere Lipide', role: 'Rolle', composition: 'Zusammensetzung (mol-% des Gesamtlipids)', basis: 'Basis', payload: 'Payload', particle: 'Partikel', process: 'Verfahren', formulation: 'Formulierung / Lagerung', use: 'Anwendung', acts: 'Handlungen und M\u00e4rkte',
      features: 'Merkmalsliste des Produkts', id: 'ID', category: 'Kategorie', statement: 'Aussage', value: 'Wert', source: 'Quelle', certainty: 'Sicherheit', assumptions: 'Annahmen', openData: 'Offene Fragen zum Produkt', profileWarn: 'Hinweise der App zum Profil',
      modelText: 'Darstellung durch Claude', s_search: '3. Recherche (Protokoll zur Nachvollziehbarkeit)', snapshot: 'Korpus und Datenst\u00e4nde', counts: 'Umfang', structRoute: 'Strukturrecherche (exakt / Teilstruktur / \u00c4hnlichkeit je Lipid)', lipid: 'Lipid', mode: 'Modus', compounds: 'Verbindungen', pubs: 'Fundstellen',
      textRoute: 'Textrecherche (erzeugte boolesche Anfragen, w\u00f6rtlich)', query: 'Anfrage', hits: 'Treffer', taken: 'ausgewertet', seedRoute: 'Schl\u00fcsselfamilien der beobachteten Anmelder', tier: 'Stufe', semRoute: 'Semantische Suche (Claude)', candidates: 'Kandidaten', triage: 'Triage',
      charted: 'analysiert', s_patents: '4. Einzelbewertung der analysierten Schutzrechte', assignee: 'Inhaber/Anmelder', assessedFor: 'Bewertet f\u00fcr', found: 'Gefunden \u00fcber', relevance: 'Triage', expiryBasis: 'Grundlage', riskFinal: 'Risiko (final = das nachteiligere aus Analyse und Gegenpr\u00fcfung)',
      riskChartDead: 'Ergebnis der Merkmalsanalyse (hypothetisch, Recht nicht mehr in Kraft)', appNotes: 'Pr\u00fcfungen der App', failed: 'Analyse fehlgeschlagen', claim: 'Anspruch', claimChart: 'Merkmalsanalyse', feature: 'Merkmal', quote: 'Anspruchswortlaut (Zitat)', quoteCheck: 'Zitatpr\u00fcfung', product: 'Produkt',
      verdict: 'Urteil', reasoning: 'Begr\u00fcndung / Auslegung / Kl\u00e4rung', resultApp: 'Ergebnis (aus den Merkmalszeilen berechnet)', resultModel: 'Modell', resultE: 'Gegenpr\u00fcfung', resultFinal: 'final', markush: 'Formelpr\u00fcfung (Markush)', scaffold: 'Ger\u00fcst', variables: 'Variablen', mappings: 'Zuordnungen',
      provisos: 'Ma\u00dfgaben', equivalence: 'Fragen zur \u00c4quivalenz f\u00fcr die anwaltliche Pr\u00fcfung (hier NICHT entschieden)', eqNote: 'Einsch\u00e4tzung des Modells, keine Entscheidung', replaced: 'Austauschmittel', dependent: 'Unteranspr\u00fcche (R\u00fcckzugspositionen)', added: 'Zusatzmerkmal (Zitat)',
      chain: 'Kette (App)', species: 'Einzelnennung', fallback: 'R\u00fcckzugspositionen', constructionHints: 'Auslegungshinweise aus den Unteranspr\u00fcchen', revision: '\u00dcberpr\u00fcfung empfohlen', redteam: 'Gegenpr\u00fcfung (Sicht des Patentinhabers)', attack: 'Angriff', patentee: 'Argument Patentinhaber',
      counter: 'Gegenargument', outcome: 'Ergebnis', otherRoutes: 'Weitere Angriffswege', revised: 'Revidiertes Risiko der Gegenpr\u00fcfung', questions: 'Offene Fragen f\u00fcr die anwaltliche Pr\u00fcfung', designAround: 'Umgehungsideen (nur Ideen: technische Hypothesen, fachlich und rechtlich zu validieren)',
      exemptions: 'Ausnahmen und Rolle (Einsch\u00e4tzung des Modells)', shortVerdict: 'Kurzfazit (Claude)', s_cross: '5. \u00dcbergreifende Punkte (Claude; aus den Einzelbewertungen)', crossPatterns: 'Querschnitt', timeline: 'Zeitachse (Ablaufdaten sind Sch\u00e4tzungen)', exemptionsAll: 'Ausnahmen',
      daAll: 'Umgehungsideen im Quervergleich (nur Ideen)', collides: 'Kollision mit', redAll: 'Gegenpr\u00fcfung', pendingText: 'Anh\u00e4ngige Anmeldungen', s_not: '6. Nicht analysierte Schutzrechte und Gr\u00fcnde', reason: 'Grund', s_next: '7. N\u00e4chste Schritte', prio: 'Priorit\u00e4t', step: 'Schritt', why: 'Warum',
      alwaysNext: 'Stets empfohlen (Methodik)', openQ: 'Offene Fragen', s_usage: 'Nutzung', calls: 'Aufrufe', resumed: 'aus Zwischenstand \u00fcbernommene Schritte', notAssessed: 'nicht bewertet', estimate: 'Sch\u00e4tzung', flagsLabel: 'Kennzeichen', dependentFailed: 'Unteranspruchsanalyse fehlgeschlagen', redteamFailed: 'Gegenpr\u00fcfung fehlgeschlagen',
      forcedBy: 'von der App auf \u201eunklar\u201c gesetzt', modelRisk: 'Risiko laut Modell', construction: 'Auslegung', broad: 'weit', narrow: 'eng', definition: 'Definition', clarification: 'Kl\u00e4rung', assumption: 'Annahme', numeric: 'Zahlenvergleich', imagesSent: 'gesendete Formelbilder', claimsLang: 'Anspruchssprache'
    },
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
      textRoute: 'Text search (generated boolean queries, verbatim)', query: 'Query', hits: 'Hits', taken: 'Evaluated', seedRoute: 'Key families of the watched applicants', tier: 'Tier', semRoute: 'Semantic search (Claude)', candidates: 'Candidates', triage: 'Triage',
      charted: 'Analysed', s_patents: '4. Individual assessment of the analysed patent rights', assignee: 'Proprietor/applicant', assessedFor: 'Assessed for', found: 'Found via', relevance: 'Triage', expiryBasis: 'Basis', riskFinal: 'Risk (final = the more adverse of chart and red team)',
      riskChartDead: 'Result of the claim chart (hypothetical, patent right no longer in force)', appNotes: 'App checks', failed: 'Analysis failed', claim: 'Claim', claimChart: 'Claim chart', feature: 'Feature', quote: 'Claim wording (quote)', quoteCheck: 'Quote check', product: 'Product',
      verdict: 'Verdict', reasoning: 'Reasoning / construction / clarification', resultApp: 'Result (computed from the feature rows)', resultModel: 'Model', resultE: 'Red team', resultFinal: 'Final', markush: 'Formula test (Markush)', scaffold: 'Scaffold', variables: 'Variables', mappings: 'Mappings',
      provisos: 'Provisos', equivalence: 'Equivalence questions for counsel (NOT decided here)', eqNote: 'model view, not a decision', replaced: 'Replaced means', dependent: 'Dependent claims (fallback positions)', added: 'Added feature (quote)',
      chain: 'Chain (app)', species: 'Named individually', fallback: 'Fallback positions', constructionHints: 'Construction hints from the dependent claims', revision: 'Review recommended', redteam: 'Red team (patentee view)', attack: 'Attack', patentee: 'Patentee argument',
      counter: 'Counter-argument', outcome: 'Outcome', otherRoutes: 'Further routes of attack', revised: 'Revised risk of the red team', questions: 'Open questions for counsel', designAround: 'Design-around ideas (ideas only: technical hypotheses, to be validated technically and legally)',
      exemptions: 'Exemptions and role (model view)', shortVerdict: 'Short verdict (Claude)', s_cross: '5. Cross-cutting points (Claude; from the individual assessments)', crossPatterns: 'Cross-patent patterns', timeline: 'Timeline (expiry dates are estimates)', exemptionsAll: 'Exemptions',
      daAll: 'Design-around ideas cross-checked (ideas only)', collides: 'Collides with', redAll: 'Red team', pendingText: 'Pending applications', s_not: '6. Patent rights not analysed, and why', reason: 'Reason', s_next: '7. Next steps', prio: 'Priority', step: 'Step', why: 'Why',
      alwaysNext: 'Always recommended (method)', openQ: 'Open questions', s_usage: 'Usage', calls: 'calls', resumed: 'steps taken from saved state', notAssessed: 'not assessed', estimate: 'estimate', flagsLabel: 'Flags', dependentFailed: 'Dependent-claim analysis failed', redteamFailed: 'Red team failed',
      forcedBy: 'set to "unclear" by the app', modelRisk: 'Risk according to the model', construction: 'Construction', broad: 'broad', narrow: 'narrow', definition: 'Definition', clarification: 'Clarification', assumption: 'Assumption', numeric: 'Numeric comparison', imagesSent: 'formula images sent', claimsLang: 'Claim language'
    }
  };
  var RISK = {
    de: { '5_sehr_hoch': 'sehr hoch (5)', '4_hoch': 'hoch (4)', '3_mittel': 'mittel (3)', '2_gering': 'gering (2)', '1_sehr_gering': 'sehr gering (1)', nicht_beurteilbar: 'nicht beurteilbar' },
    en: { '5_sehr_hoch': 'very high (5)', '4_hoch': 'high (4)', '3_mittel': 'medium (3)', '2_gering': 'low (2)', '1_sehr_gering': 'very low (1)', nicht_beurteilbar: 'cannot be assessed' }
  };
  /* English labels for the internal codes (schema enum values, app flags, modifiers) and for the schema field names
     that appear as row labels. The codes themselves never change; German output shows them as they are. */
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
    gegenpruefung_fehlgeschlagen: 'red-team review failed', eskalation_durch_gegenpruefung: 'escalated by the red-team review', triage_ohne_ergebnis: 'no triage result', analyse_fehlgeschlagen: 'analysis failed',
    unbekannte_nummer_in_zeitachse: 'unknown number in the timeline', formulierung_pruefen: 'check wording', gesamtrisiko_abweichend: 'overall risk differs from the computed one',
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
    land: 'Country', akt: 'Act', zeitpunkt: 'Timing', geplant_ab: 'Planned from', zweck: 'Purpose', abstand: 'Distance (failing variables)', konfidenz: 'Confidence', 'nicht zugeordnet': 'Not mapped',
    'Versuchsprivileg \u00a7 11 Nr. 2 PatG': 'Experimental-use exemption (\u00a7 11 No. 2 PatG)', 'Zulassungsprivileg \u00a7 11 Nr. 2b PatG': 'Regulatory (Bolar) exemption (\u00a7 11 No. 2b PatG)',
    'US safe harbor \u00a7 271(e)(1)': 'US safe harbor (35 U.S.C. \u00a7 271(e)(1))', Kipppunkt: 'Tipping point', lipid_zu_nukleinsaeure_gewicht: 'Lipid : nucleic acid (w/w)', chargenvariabilitaet: 'Batch variability'
  };
  /* label(code, lang): display text of an internal code. German: the code as it is. English: the mapped label; compound
     flags are resolved by their prefix; unknown codes are shown with blanks instead of underscores. */
  function label(c, lang) {
    c = str(c);
    if (lang === 'de' || !c) return c;
    if (Object.prototype.hasOwnProperty.call(CODE_EN, c)) return CODE_EN[c];
    var m = /^markush_widerspruch_(.+)$/.exec(c); if (m) return 'formula test contradicts the verdict (' + m[1] + ')';
    m = /^unteransprueche_(.+)$/.exec(c); if (m) return 'dependent claims: ' + label(m[1], lang);
    m = /^rechtsstand_(.+)$/.exec(c); if (m) return 'legal status: ' + label(m[1], lang);
    return c.replace(/_/g, ' ');
  }
  /* a value that may be a code or free text: mapped only when it is a known code */
  function soft(v, lang) { v = str(v); return lang !== 'de' && Object.prototype.hasOwnProperty.call(CODE_EN, v) ? CODE_EN[v] : v; }
  function field(k, lang) { return lang !== 'de' && Object.prototype.hasOwnProperty.call(FIELD_EN, k) ? FIELD_EN[k] : k; }
  var LIT = {
    de: { wortsinngemaess_erfuellt: 'wortsinngem\u00e4\u00df erf\u00fcllt', wortsinngemaess_moeglich: 'wortsinngem\u00e4\u00df m\u00f6glich', wortsinngemaess_nicht_erfuellt: 'wortsinngem\u00e4\u00df nicht erf\u00fcllt', nicht_beurteilbar: 'nicht beurteilbar' },
    en: { wortsinngemaess_erfuellt: 'literally met', wortsinngemaess_moeglich: 'literally possible', wortsinngemaess_nicht_erfuellt: 'literally not met', nicht_beurteilbar: 'cannot be assessed' }
  };
  var VERD = { de: { erfuellt: 'erf\u00fcllt', nicht_erfuellt: 'nicht erf\u00fcllt', unklar: 'unklar', moeglich: 'm\u00f6glich' }, en: { erfuellt: 'met', nicht_erfuellt: 'not met', unklar: 'unclear', moeglich: 'possible' } };
  var QCHK = {
    de: { ok: 'w\u00f6rtlich im Anspruch gefunden', elided: 'ABWEICHEND: nur mit Auslassung gefunden', approx: 'ABWEICHEND: nur bei gelockerter Schreibweise gefunden', fail: 'NICHT VERIFIZIERT: Zitat steht nicht im Anspruchstext', empty: 'NICHT VERIFIZIERT: kein Zitat' },
    en: { ok: 'found verbatim in the claim', elided: 'DEVIATING: found only with an omission', approx: 'DEVIATING: found only with relaxed spelling', fail: 'NOT VERIFIED: quote is not in the claim text', empty: 'NOT VERIFIED: no quote' }
  };
  var NEXT = {
    de: ['Markush-/Strukturrecherche in CAS STN (REGISTRY + MARPAT) und/oder Derwent Markush f\u00fcr das ionisierbare Lipid und das PEG-Lipid.',
      'Aktueller Rechtsstand aus den Registern (EP-Register einschlie\u00dflich Einspruchsakte, DPMAregister, UPC-Register/Opt-out, USPTO Patent Center, PTAB), INPADOC-Familie, ESZ/PTE.',
      'Durchsicht der Erteilungsakten der h\u00f6chstbewerteten Schutzrechte (\u00c4nderungen, Erkl\u00e4rungen).',
      'Analytische Daten zur Kl\u00e4rung unklarer Merkmale (gemessene mol-% im Partikel, Gr\u00f6\u00dfe nach der im Patent genannten Methode, pKa, Verkapselung).',
      'Schriftliche Stellungnahme einer Patentanw\u00e4ltin oder eines Patentanwalts vor GMP- oder kommerziellen Festlegungen.',
      '\u00dcberwachung der anh\u00e4ngigen Anmeldungen und Teilanmeldungen/Continuations der betroffenen Familien und der beobachteten Anmelder.'],
    en: ['Markush/structure search in CAS STN (REGISTRY + MARPAT) and/or Derwent Markush for the ionizable lipid and the PEG-lipid.',
      'Current legal status from the registers (EP Register incl. opposition file, DPMAregister, UPC register/opt-out, USPTO Patent Center, PTAB), INPADOC family, SPC/PTE.',
      'File-wrapper review for the top-rated rights (amendments, statements).',
      'Analytical data to resolve unclear features (measured mol-% in the particle, size by the method named in the patent, pKa, encapsulation).',
      'Written opinion of a patent attorney before GMP or commercial commitments.',
      'Monitoring of pending applications and divisionals/continuations of the affected families and the watched applicants.']
  };
  var REASON = {
    de: { dead: 'Rechtsstand (abgelaufen/erloschen/widerrufen)', triage_c: 'Triage C (anderer Gegenstand)', depth_limit: 'au\u00dferhalb der gew\u00e4hlten Tiefe', no_text: 'kein Anspruchstext im Korpus', text_cut: 'Anspruchstext nicht im Datenpaket', wo: 'WO-Ver\u00f6ffentlichung', market: 'kein Zielmarkt', no_ai: 'KI nicht verf\u00fcgbar' },
    en: { dead: 'legal status (expired/lapsed/revoked)', triage_c: 'triage C (different subject)', depth_limit: 'outside the selected depth', no_text: 'no claim text in the corpus', text_cut: 'claim text not in the data package', wo: 'WO publication', market: 'no target market', no_ai: 'AI not available' }
  };

  // ------------------------------------------------------------------------------------------------ node model
  /* nodes: {h: level, t} | {p: text, cls?} | {ul: [text]} | {table: {head: [..], rows: [[..]], cls?}} | {limits: text} | {md: model text} | {kv: [[k, v]]} */
  function build(op) {
    var lang = op.lang === 'de' ? 'de' : 'en', L = T[lang], N = [], syn = op.synthesis || null, de = lang === 'de';
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
      [L.corpus, [snap.ep_text ? (de ? 'EP-Text ' : 'EP full text ') + snap.ep_text : '', snap.us_text ? (de ? 'US-Text ' : 'US full text ') + snap.us_text : '', snap.ep_register ? (de ? 'EP-Register ' : 'EP Register ') + snap.ep_register : '', snap.surechembl ? 'SureChEMBL ' + snap.surechembl : ''].filter(Boolean).join('; ')], ['ID', op.id]]);

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
    kv([[L.snapshot, Object.keys(snap).map(function (k) { return k + ' ' + snap[k]; }).join('; ')],
      [L.counts, rec && rec.counts ? Object.keys(rec.counts).map(function (k) { return k + ' ' + rec.counts[k]; }).join('; ') : null],
      [L.candidates, se.candidates], [L.triage, se.triage ? 'A ' + (se.triage.A || 0) + ', B ' + (se.triage.B || 0) + ', C ' + (se.triage.C || 0) : null], [L.charted, se.charted]]);
    if (rec) {
      if (arr(rec.structure).length) { h(3, L.structRoute); table([L.lipid, L.role, L.mode, L.compounds, L.pubs], rec.structure.map(function (s) { return [s.lipid, s.role, de ? s.mode : ({ exact: 'exact', sub: 'substructure', sim: 'similarity' }[s.mode] || s.mode), s.error ? 'ERR: ' + s.error : s.compounds, s.publications]; })); }
      if (arr(rec.text).length) { h(3, L.textRoute); table(['', L.query, L.hits, L.taken], rec.text.map(function (t) { return [t.label, t.query, t.error ? 'ERR: ' + t.error : t.total, t.taken]; }), 'queries'); }
      if (arr(rec.seed).length) { h(3, L.seedRoute); table([L.tier, L.hits], rec.seed.map(function (s) { return [s.tier, s.error ? 'ERR: ' + s.error : s.total]; })); }
      if (rec.semantic) { h(3, L.semRoute); kv([['strict', rec.semantic.queries && rec.semantic.queries.strict], ['relaxed', rec.semantic.queries && rec.semantic.queries.relaxed], [L.hits, rec.semantic.hits], [L.calls, rec.semantic.calls], ['degraded', arr(rec.semantic.degraded).join(', ') || rec.semantic.error]]); }
      ul(arr(rec.notes).concat(rec.cut ? [(de ? 'Weitere Kandidaten unterhalb der Auswahlgrenze: ' : 'Further candidates below the cut-off: ') + rec.cut] : []));
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
            kv([[L.scaffold, mk.geruest], [fld('abstand'), val(mk.abstand)], [fld('konfidenz'), code(mk.konfidenz)], [fld('nicht zugeordnet'), arr(mk.nicht_zugeordnete_teile).join('; ')], [L.species, code(mk.einzelverbindung_genannt)]]);
            table([L.variables, L.definition, L.quoteCheck], arr(mk.variablen).map(function (v) { return [v.name, v.definition_quote, v.app ? QCHK[lang][v.app.quote] : '']; }));
            arr(mk.mappings).forEach(function (mp) { table([L.mappings + ' ' + str(mp.mapping_id) + ' (' + (de ? '' : 'all met: ') + code(mp.alle_erfuellt) + ')', 'Fragment', L.verdict, L.reasoning], arr(mp.zuordnung).map(function (zz) { return [zz.variable, zz.fragment + (zz.zaehlung ? ' [' + zz.zaehlung + ']' : ''), verd(zz.verdict), str(zz.begruendung) + (zz.naechster_zulaessiger_wert ? ' (' + zz.naechster_zulaessiger_wert + ')' : '')]; })); });
            table([L.provisos, de ? 'schlie\u00dft Produkt aus' : 'excludes product', L.reasoning], arr(mk.massgaben).map(function (v) { return [v.quote, code(v.schliesst_produkt_aus), v.begruendung]; }));
          });
          if (arr(c.aequivalenz).length) {
            h(5, L.equivalence);
            ul(c.aequivalenz.map(function (q) { return q.feature_id + ': ' + L.replaced + ' = ' + str(q.austauschmittel) + '; ' + L.eqNote + ': ' + code(q.aequivalenz_risiko) + '. ' + str(q.begruendung); }));
          }
        });
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
          if (miss.length) rr.push([rc.claim_no, '', de ? 'Vollst\u00e4ndigkeit' : 'completeness', miss.join(' | '), '', '']);
        });
        table([L.claim, L.feature, L.attack, L.patentee, L.counter, L.outcome], rr);
        if (arr(rt.weitere_angriffswege).length) { h(5, L.otherRoutes); ul(rt.weitere_angriffswege.map(function (w) { return code(w.weg) + ' (' + code(w.relevanz) + '): ' + str(w.beschreibung); })); }
        if (rt.revidiert) p(L.revised + ': ' + risk(rt.revidiert.risiko) + '. ' + str(rt.revidiert.begruendung));
      }
      if (ch) {
        var qs = arr(gs.offene_fragen).concat(rt ? arr(rt.zu_klaeren) : []);
        arr(ch.claims).forEach(function (c) { arr(c.merkmale).forEach(function (m) { if (m.app && m.app.verdict === 'unklar' && m.klaerung) qs.push(L.claim + ' ' + c.claim_no + ' ' + m.feature_id + ': ' + m.klaerung); if (m.app && !m.app.verified) qs.push(L.claim + ' ' + c.claim_no + ' ' + m.feature_id + ': ' + (QCHK[lang][m.app.quote] || '') + (de ? ' - am Originaldokument pr\u00fcfen' : ' - check against the original document')); }); if (arr(c.aequivalenz).length) qs.push(L.claim + ' ' + c.claim_no + ': ' + (de ? '\u00c4quivalenz f\u00fcr ' : 'equivalence for ') + c.aequivalenz.map(function (q) { return q.feature_id; }).join(', ') + (de ? ' (nicht entschieden)' : ' (not decided)')); });
        if (qs.length) { h(4, L.questions); ul(qs); }
        if (arr(gs.umgehungsloesungen).length) { h(4, L.designAround); ul(gs.umgehungsloesungen.map(function (u) { return str(u.feature_id) + ': ' + str(u.aenderung) + ' [' + code(u.robustheit) + '] - ' + str(u.vorbehalt); })); }
        var ex = gs.ausnahmen || {}, ro = gs.rolle_des_nutzers || {};
        if (ex.erlaeuterung || ro.erlaeuterung) { h(4, L.exemptions); kv([[fld('Versuchsprivileg \u00a7 11 Nr. 2 PatG'), code(ex.versuchsprivileg_par11_nr2)], [fld('Zulassungsprivileg \u00a7 11 Nr. 2b PatG'), code(ex.zulassungsprivileg_par11_nr2b)], [fld('US safe harbor \u00a7 271(e)(1)'), code(ex.us_safe_harbor_271e1)], [fld('Kipppunkt'), ex.kipppunkt], ['', ex.erlaeuterung], [de ? 'unmittelbar' : 'Direct infringement by the user', code(ro.unmittelbar)], [de ? 'mittelbar' : 'Indirect / contributory infringement', code(ro.mittelbar_par10_patg_oder_271bc)], ['', ro.erlaeuterung]]); }
        if (arr(gs.hinweise).length) ul(gs.hinweise);
      }
    });

    // 5 cross-cutting model texts
    if (syn) {
      h(2, L.s_cross);
      if (syn.querschnitt) { h(3, L.crossPatterns); md(syn.querschnitt); }
      if (arr(syn.zeitachse).length) { h(3, L.timeline); table([L.right, L.expiry, L.notes], syn.zeitachse.map(function (zt) { var m = arr(op.matrix).filter(function (x) { return x.pn === zt.patent_id; })[0]; return [zt.patent_id, (m && m.expiry) || zt.ablauf_geschaetzt, zt.bemerkung]; })); }
      if (syn.ausnahmen) { h(3, L.exemptionsAll); md(syn.ausnahmen); }
      if (arr(syn.umgehungsloesungen).length) { h(3, L.daAll); table([de ? '\u00c4nderung' : 'Change', L.right, L.collides, de ? 'Bewertung' : 'Assessment'], syn.umgehungsloesungen.map(function (u) { return [u.aenderung, arr(u.betrifft_schutzrechte).join(', '), arr(u.kollision_mit_anderen).join(', '), u.bewertung]; })); }
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
      table([L.right, de ? 'Titel' : 'Title', L.status, L.expiry, L.reason], groups[k].map(function (n) { return [n.pn, n.title, n.status, n.expiry, n.text]; }));
    });

    // 7 next steps
    h(2, L.s_next);
    if (syn && arr(syn.naechste_schritte).length) table([L.prio, L.step, L.why], syn.naechste_schritte.slice().sort(function (a, b) { return (a.prioritaet || 0) - (b.prioritaet || 0); }).map(function (s) { return [s.prioritaet, s.schritt, s.warum]; }));
    h(3, L.alwaysNext); ul(NEXT[lang]);
    if (syn && arr(syn.offene_fragen).length) { h(3, L.openQ); ul(syn.offene_fragen); }
    if (op.usage || op.run) { h(3, L.s_usage); p((op.run ? op.run.calls + ' ' + L.calls + (op.run.resumedSteps ? ', ' + op.run.resumedSteps + ' ' + L.resumed : '') : '') + (op.usage ? '; ' + op.usage.bytesIn + ' / ' + op.usage.bytesOut + ' bytes in/out' : '')); }
    N.push({ limits: str(op.limits) });
    return { nodes: N, lang: lang, title: str(op.title || L.title) };
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
  var CSS = 'body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1f24;background:#fff;max-width:1100px;margin:0 auto;padding:24px 16px}' +
    'h1{font-size:24px;margin:20px 0 8px}h2{font-size:19px;margin:28px 0 8px;border-bottom:2px solid #1c1f24;padding-bottom:4px}h3{font-size:16px;margin:20px 0 6px}h4{font-size:14px;margin:16px 0 4px}h5{font-size:13px;margin:12px 0 4px}' +
    'p{margin:6px 0}ul{margin:6px 0 6px 20px;padding:0}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12.5px}th,td{border:1px solid #c9ced6;padding:4px 6px;vertical-align:top;text-align:left;overflow-wrap:anywhere}' +
    'th{background:#eef1f5}.limits{white-space:pre-wrap;border:2px solid #8a1f11;background:#fdf3f1;padding:12px;font:12.5px/1.45 system-ui,sans-serif;margin:0 0 16px}.warn{border-left:4px solid #b54708;background:#fff6e8;padding:6px 10px;font-weight:600}' +
    'dl{margin:6px 0;display:grid;grid-template-columns:minmax(120px,240px) 1fr;gap:2px 12px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}.model{border-left:3px solid #c9ced6;padding-left:10px}.tw{overflow-x:auto}' +
    '@media print{body{max-width:none;padding:0;font-size:11px}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}.tw{overflow:visible}}';
  function toHtml(doc) {
    var out = [];
    doc.nodes.forEach(function (n) {
      if (n.limits !== undefined) out.push('<pre class="limits">' + esc(n.limits) + '</pre>');
      else if (n.h) { var l = Math.max(1, Math.min(6, n.h)); out.push('<h' + l + '>' + esc(n.t) + '</h' + l + '>'); }
      else if (n.p !== undefined) out.push('<p' + (n.cls === 'warn' ? ' class="warn"' : '') + '>' + esc(n.p) + '</p>');
      else if (n.md !== undefined) out.push('<div class="model">' + mdToHtml(n.md) + '</div>');
      else if (n.ul) out.push('<ul>' + n.ul.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      else if (n.kv) out.push('<dl>' + n.kv.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl>');
      else if (n.table) out.push('<div class="tw"><table><thead><tr>' + n.table.head.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        n.table.rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>');
    });
    return '<!doctype html>\n<html lang="' + (doc.lang === 'de' ? 'de' : 'en') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(doc.title) + '</title><style>' + CSS + '</style></head><body>\n' + out.join('\n') + '\n</body></html>';
  }

  function toJson(op) {
    var o = { hinweis: str(op.limits) }, k;
    for (k in op) if (Object.prototype.hasOwnProperty.call(op, k) && k !== 'hinweis' && k !== 'hinweis_ende') o[k] = op[k];
    o.hinweis_ende = str(op.limits);
    return JSON.stringify(o, null, 1);
  }
  function render(op, fmt) {
    if (!op || typeof op !== 'object') throw { code: 'bad_opinion', message: 'no opinion' };
    if (!str(op.limits)) throw { code: 'bad_opinion', message: 'opinion without limits block is not rendered' };
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
