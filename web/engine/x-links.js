/* LNP Patent Desk: deep links to external patent and chemistry services (global LnpLinks). Classic script, ASCII.
   URL construction only: nothing here fetches, and nothing is sent anywhere until the user clicks a link.
   Links that the shell already offers (Espacenet, Google Patents, EP Register, USPTO full-text search) are not repeated.
     LnpLinks.patent(P)    -> [{id, label, title, href}]   P = LnpData.patent() object (needs pn; auth, appNo, wo help)
     LnpLinks.compound(x)  -> [{id, label, title, href}]   x = LnpChem hit {id, smiles, inchikey?} | InChIKey | SMILES | SCHEMBL id
     LnpLinks.parsePn(pn)  -> {cc, num, kind, pn} | null
   Limits: the services change their address schemes; a link opens the service's own search or document page, it does not
   prove that the service holds the document. PubChem is addressed by InChIKey only when the hit carries one (OpenChemLib
   in this build cannot compute InChI); otherwise by the SMILES. Registers itself with LnpApp.ext when the shell has it. */
(function (g) {
  'use strict';
  var enc = encodeURIComponent;

  function parsePn(pn) {
    var s = String(pn || '').replace(/[\s\/,.-]+/g, '').toUpperCase();
    var m = /^([A-Z]{2})((?:RE|PP|D|H|T)?\d+)([A-Z]\d?)?$/.exec(s);
    return m ? { cc: m[1], num: m[2], kind: m[3] || '', pn: s } : null;
  }

  // patent links; P needs `pn`. WO and national numbers differ only in where the number goes.
  function patent(P) {
    var out = [], x = P && parsePn(P.pn);
    if (!x) return out;
    var base = x.cc + x.num;
    // PATENTSCOPE: the document page for PCT publications, a publication-number query for everything else
    if (x.cc === 'WO') out.push({ id: 'patentscope', label: 'PATENTSCOPE', title: 'WIPO PATENTSCOPE: PCT publication ' + base, href: 'https://patentscope.wipo.int/search/en/detail.jsf?docId=' + enc(base) });
    else out.push({ id: 'patentscope', label: 'PATENTSCOPE', title: 'WIPO PATENTSCOPE: search for ' + base, href: 'https://patentscope.wipo.int/search/en/result.jsf?query=' + enc('PN:' + base) });
    out.push({ id: 'lens', label: 'Lens', title: 'The Lens: search for ' + x.pn, href: 'https://www.lens.org/lens/search/patent/list?q=' + enc(x.pn) });
    // SureChEMBL document page: CC-number-kind
    out.push({ id: 'surechembl', label: 'SureChEMBL', title: 'SureChEMBL document page (chemistry extracted from the full text)', href: 'https://www.surechembl.org/document/' + enc(x.cc + '-' + x.num + (x.kind ? '-' + x.kind : '')) });
    // USPTO Patent Center opens by application number (digits only); publications without a known application number get no link
    if (x.cc === 'US') {
      var app = String((P && P.appNo) || '').replace(/\D+/g, '');
      if (app.length >= 7 && app.length <= 8) out.push({ id: 'patentcenter', label: 'USPTO Patent Center', title: 'Application ' + P.appNo + ' in Patent Center (file wrapper, assignments)', href: 'https://patentcenter.uspto.gov/applications/' + enc(app) });
    }
    return out;
  }

  var KEY_RE = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/, SCHEMBL_RE = /^SCHEMBL\s*(\d+)$/i;
  // compound links from a hit object, an InChIKey, a SMILES or a SCHEMBL id
  function compound(x) {
    var key = '', smiles = '', sc = '', out = [];
    if (x && typeof x === 'object') {
      key = String(x.inchikey || x.inchiKey || x.InChIKey || '');
      smiles = String(x.smiles || '');
      var id = String(x.id || x.schembl || ''), m = SCHEMBL_RE.exec(id);
      if (m) sc = 'SCHEMBL' + m[1];
    } else {
      var s = String(x == null ? '' : x).trim(), m2 = SCHEMBL_RE.exec(s);
      if (KEY_RE.test(s.toUpperCase())) key = s.toUpperCase(); else if (m2) sc = 'SCHEMBL' + m2[1]; else smiles = s;
    }
    if (!KEY_RE.test(key.toUpperCase())) key = ''; else key = key.toUpperCase();
    if (smiles.length > 1500) smiles = '';                       // a URL has to stay usable
    var term = key || smiles;
    if (key) out.push({ id: 'pubchem', label: 'PubChem', title: 'PubChem: search by InChIKey ' + key, href: 'https://pubchem.ncbi.nlm.nih.gov/#query=' + enc(key) });
    else if (smiles) out.push({ id: 'pubchem', label: 'PubChem', title: 'PubChem: structure search for this SMILES', href: 'https://pubchem.ncbi.nlm.nih.gov/#query=' + enc(smiles) + '&input_type=smiles' });
    if (sc) out.push({ id: 'surechembl', label: 'SureChEMBL', title: 'SureChEMBL compound page ' + sc, href: 'https://www.surechembl.org/chemical/' + enc(sc) });
    if (term) out.push({ id: 'chembl', label: 'ChEMBL', title: 'ChEMBL: search', href: 'https://www.ebi.ac.uk/chembl/g/#search_results/all/query=' + enc(term) });
    return out;
  }

  var L = { patent: patent, compound: compound, parsePn: parsePn, version: 1 };
  g.LnpLinks = L;
  if (typeof module !== 'undefined' && module.exports) module.exports = L;

  /* ---- registration with the shell hooks (LnpApp.ext) */
  var App = g.LnpApp, U = g.LnpUI;
  if (App && App.ext && U && typeof App.ext.links === 'function') {
    App.ext.links(function (P) { return patent(P).map(function (l) { return { label: l.label, href: l.href, title: l.title }; }); });
    App.ext.compoundAction(function (hit) {
      var ls = compound(hit);
      if (!ls.length) return null;
      var row = U.h('div.x-links', null, U.h('span.x-links-l', { text: 'External' }));
      ls.forEach(function (l) { row.appendChild(U.h('a.btn.sm', { href: l.href, title: l.title, target: '_blank', rel: 'noopener noreferrer' }, l.label, U.icon('ext'))); });
      return row;
    });
  }
})(typeof self !== 'undefined' ? self : this);
