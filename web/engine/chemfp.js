/* chemfp.js - lipid-aware chemistry helpers on top of an OpenChemLib (8.21.0) Molecule.
   The same file runs in the offline build (Node, pipeline/chem_build.cjs) and in the browser
   (worker or page), so database values and query values are computed by identical code.
   ASCII only. No eval, no wasm.

   ChemFP.fp(mol)            -> {pk: Uint16Array}   count fingerprint, packed (featureId << 4 | count<=15), ascending
   ChemFP.tanimotoPacked(a, b, bOff, bLen) -> 0..1  count Tanimoto of query a against a slice of a packed database array
   ChemFP.describe(mol, opts)-> lipid descriptors (see below)
   ChemFP.scaffold(OCL, mol) -> {idcode, nTrunc}    structure with hydrocarbon tails truncated, stereo removed
   ChemFP.noStereoHash(OCL, mol) -> uint32          hash of the stereo-free idcode (groups stereo variants)
   ChemFP.row(d)             -> flat numeric record for the columnar descriptor shard (see ChemFP.COLS)
   ChemFP.HEADS, ChemFP.COLS, ChemFP.VERSION
*/
(function (g) {
  'use strict';
  var VERSION = 3; // bump when fp/describe/scaffold output changes: invalidates the build cache
  var NB = 4096;   // feature id space (12 bit)

  function mix(h, v) { h ^= v; h = Math.imul(h, 0x01000193); return (h ^ (h >>> 15)) >>> 0; }
  function hashStr(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i)); return h >>> 0; }

  /* ---------- count fingerprint (ECFP-like radius 2 + topological pairs between key atoms) ---------- */
  function fp(mol, radius) {
    radius = radius === undefined ? 2 : radius;
    mol.ensureHelperArrays(7);
    var n = mol.getAtoms(), cur = new Uint32Array(n), feats = new Map(), a, i, h;
    function add(x) { var k = x % NB; feats.set(k, (feats.get(k) || 0) + 1); }
    for (a = 0; a < n; a++) {
      h = 0x811c9dc5;
      h = mix(h, mol.getAtomicNo(a)); h = mix(h, mol.getConnAtoms(a)); h = mix(h, mol.getAtomCharge(a) + 8);
      h = mix(h, mol.isAromaticAtom(a) ? 1 : 0); h = mix(h, mol.isRingAtom(a) ? 1 : 0); h = mix(h, mol.getAllHydrogens(a));
      cur[a] = h; add(h);
    }
    for (var r = 1; r <= radius; r++) {
      var nxt = new Uint32Array(n);
      for (a = 0; a < n; a++) {
        var nb = [];
        for (i = 0; i < mol.getConnAtoms(a); i++) nb.push(mix(cur[mol.getConnAtom(a, i)], mol.isAromaticBond(mol.getConnBond(a, i)) ? 4 : mol.getConnBondOrder(a, i)));
        nb.sort(function (x, y) { return x - y; });
        h = mix(cur[a], r);
        for (i = 0; i < nb.length; i++) h = mix(h, nb[i]);
        nxt[a] = h; add(h);
      }
      cur = nxt;
    }
    // pairs between hetero atoms, branch points and chain ends: encodes spacer and tail lengths
    var key = [], kt = [];
    for (a = 0; a < n; a++) {
      var z = mol.getAtomicNo(a), dg = mol.getConnAtoms(a);
      if (z !== 6 || dg >= 3 || dg <= 1) { key.push(a); kt.push(mix(mix(mix(0x9747b28c, z), dg), mol.getAtomCharge(a) + 8)); }
    }
    if (key.length <= 64) {
      var dist = new Int16Array(n), queue = new Int32Array(n);
      for (i = 0; i < key.length; i++) {
        dist.fill(-1); var qh = 0, qt = 0; queue[qt++] = key[i]; dist[key[i]] = 0;
        while (qh < qt) { var u = queue[qh++]; for (var c = 0; c < mol.getConnAtoms(u); c++) { var b = mol.getConnAtom(u, c); if (dist[b] < 0) { dist[b] = dist[u] + 1; queue[qt++] = b; } } }
        for (var j = i + 1; j < key.length; j++) {
          var d = dist[key[j]];
          if (d > 0) { var x = Math.min(kt[i], kt[j]), y = Math.max(kt[i], kt[j]); add(mix(mix(mix(0x2545f491, x), y), Math.min(d, 40))); }
        }
      }
    }
    var ids = Array.from(feats.keys()).sort(function (p, q) { return p - q; });
    var pk = new Uint16Array(ids.length);
    for (i = 0; i < ids.length; i++) pk[i] = (ids[i] << 4) | Math.min(15, feats.get(ids[i]));
    return { pk: pk };
  }

  function tanimotoPacked(a, b, bOff, bLen) {
    var i = 0, j = bOff, e = bOff + bLen, mn = 0, mx = 0, na = a.length;
    while (i < na && j < e) {
      var x = a[i], y = b[j], xi = x >> 4, yi = y >> 4;
      if (xi === yi) { var p = x & 15, q = y & 15; if (p < q) { mn += p; mx += q; } else { mn += q; mx += p; } i++; j++; }
      else if (xi < yi) { mx += x & 15; i++; } else { mx += y & 15; j++; }
    }
    while (i < na) mx += a[i++] & 15;
    while (j < e) mx += b[j++] & 15;
    return mx ? mn / mx : 0;
  }

  /* ---------- lipid descriptors ---------- */
  var HEADS = ['none', 'neutral', 'polyether', 'sterol', 'phosphocholine', 'phosphoethanolamine', 'phospho', 'quaternary',
    'polyamine', 'dimethylamino', 'hydroxyalkyl-tert-amine', 'cyclic-tert-amine', 'tert-amine', 'sec-amine', 'prim-amine',
    'heteroaryl', 'amide', 'other-n'];
  var MIN_TAIL = 6;      // hydrocarbon group with at least this many carbons counts as a tail
  var TRUNC_CHAIN = 6;   // linear terminal chain of at least this many carbons is truncated to a methyl in the scaffold
  var MAXT = 6;          // tails stored per compound in the descriptor shard

  function describe(mol, opts) {
    opts = opts || {};
    mol.ensureHelperArrays(7);
    var n = mol.getAtoms(), a, i, b, z;
    var Z = new Uint8Array(n), deg = new Uint8Array(n), nH = new Uint8Array(n);
    var el = { C: 0, N: 0, O: 0, P: 0, S: 0, hal: 0, other: 0 }, charge = 0;
    for (a = 0; a < n; a++) {
      z = mol.getAtomicNo(a); Z[a] = z; deg[a] = mol.getConnAtoms(a); nH[a] = mol.getAllHydrogens(a); charge += mol.getAtomCharge(a);
      if (z === 6) el.C++; else if (z === 7) el.N++; else if (z === 8) el.O++; else if (z === 15) el.P++; else if (z === 16) el.S++;
      else if (z === 9 || z === 17 || z === 35 || z === 53) el.hal++; else el.other++;
    }
    function nbrs(x) { var r = []; for (var k = 0; k < deg[x]; k++) r.push(mol.getConnAtom(x, k)); return r; }
    function order(x, k) { return mol.getConnBondOrder(x, k); }
    // functional carbon: carbon with a multiple bond to a hetero atom (C=O, C=S, C=N, C#N)
    var fC = new Uint8Array(n), carbonyl = new Uint8Array(n);
    for (a = 0; a < n; a++) {
      if (Z[a] !== 6) continue;
      for (i = 0; i < deg[a]; i++) {
        b = mol.getConnAtom(a, i);
        if (Z[b] !== 6 && order(a, i) >= 2 && !mol.isAromaticBond(mol.getConnBond(a, i))) { fC[a] = 1; if ((Z[b] === 8 || Z[b] === 16) && order(a, i) === 2) carbonyl[a] = 1; }
      }
    }
    // --- linkers, by carbonyl carbon ---
    var L = { ester: 0, carbonate: 0, carbamate: 0, amide: 0, urea: 0, thioester: 0, ether: 0, thioether: 0, disulfide: 0, ketal: 0, phosphate: 0, acid: 0, hydroxyl: 0, ketone: 0 };
    var inLinker = new Uint8Array(n); // hetero atoms that are part of a linker (stop atoms for the head walk)
    for (a = 0; a < n; a++) {
      if (!carbonyl[a]) continue;
      var nO = 0, nOH = 0, nN = 0, nS = 0, nb = nbrs(a);
      for (i = 0; i < nb.length; i++) {
        b = nb[i]; if (order(a, i) !== 1) continue;
        if (Z[b] === 8) { if (deg[b] >= 2) { nO++; inLinker[b] = 1; } else nOH++; }
        else if (Z[b] === 7) { nN++; }
        else if (Z[b] === 16) { nS++; inLinker[b] = 1; }
      }
      if (nO + nOH >= 2 && nN === 0) { if (nO >= 2) L.carbonate++; else if (nO === 1) L.ester++; else L.acid++; }
      else if (nO >= 1 && nN >= 1) L.carbamate++;
      else if (nOH >= 1 && nN >= 1) L.carbamate++;
      else if (nN >= 2) L.urea++;
      else if (nS >= 1 && nN >= 1) L.carbamate++;     // thiocarbamate counted with carbamates
      else if (nN === 1) L.amide++;
      else if (nS >= 1) L.thioester++;
      else if (nO === 1) L.ester++;
      else if (nOH === 1) L.acid++;
      else L.ketone++;
    }
    // --- O / S / P based groups ---
    for (a = 0; a < n; a++) {
      z = Z[a];
      if (z === 15) L.phosphate++;
      else if (z === 8) {
        if (deg[a] === 1) { b = mol.getConnAtom(a, 0); if (Z[b] === 6 && !fC[b] && order(a, 0) === 1) L.hydroxyl++; }
        else if (deg[a] === 2) {
          var c0 = mol.getConnAtom(a, 0), c1 = mol.getConnAtom(a, 1);
          if (Z[c0] === 6 && Z[c1] === 6 && !fC[c0] && !fC[c1]) { L.ether++; inLinker[a] = 1; }
        }
      } else if (z === 16) {
        var ss = 0, cc = 0, nb2 = nbrs(a);
        for (i = 0; i < nb2.length; i++) { if (Z[nb2[i]] === 16) ss++; else if (Z[nb2[i]] === 6) cc++; }
        if (ss) { L.disulfide += 0.5; inLinker[a] = 1; }
        else if (deg[a] === 2 && cc === 2 && !fC[nb2[0]] && !fC[nb2[1]]) { L.thioether++; inLinker[a] = 1; }
      }
    }
    L.disulfide = Math.round(L.disulfide);
    // ketal / acetal carbons: sp3 carbon with two single-bonded ether oxygens; those oxygens are not counted as ethers
    for (a = 0; a < n; a++) {
      if (Z[a] !== 6 || fC[a]) continue;
      var eo = 0, nb3 = nbrs(a);
      for (i = 0; i < nb3.length; i++) { b = nb3[i]; if (Z[b] === 8 && deg[b] === 2) { var o0 = mol.getConnAtom(b, 0), o1 = mol.getConnAtom(b, 1); if (Z[o0] === 6 && Z[o1] === 6 && !fC[o0] && !fC[o1]) eo++; } }
      if (eo >= 2) { L.ketal++; L.ether -= 2; }
    }
    if (L.ether < 0) L.ether = 0;
    // --- nitrogen classes ---
    var A = { tertiary: 0, secondary: 0, primary: 0, quaternary: 0, amide: 0, aromatic: 0, other: 0 };
    var basicN = [], nKind = new Uint8Array(n); // 1 tert 2 sec 3 prim 4 quat 5 amide 6 aromatic 7 other
    for (a = 0; a < n; a++) {
      if (Z[a] !== 7) continue;
      var nc = 0, nonC = 0, mult = false, acyl = false, nb4 = nbrs(a);
      for (i = 0; i < nb4.length; i++) {
        b = nb4[i];
        if (Z[b] === 6) { nc++; if (carbonyl[b]) acyl = true; else if (fC[b] && order(a, i) === 1) mult = true; } else nonC++;
        if (order(a, i) > 1) mult = true;
      }
      var k;
      if (mol.isAromaticAtom(a)) k = 6;
      else if (acyl) k = 5;
      else if (mult || nonC) k = 7;
      else if (nc === 4) k = 4;
      else if (nc === 3) k = 1;
      else if (nc === 2) k = 2;
      else if (nc === 1) k = 3;
      else k = 7;
      nKind[a] = k;
      A[['', 'tertiary', 'secondary', 'primary', 'quaternary', 'amide', 'aromatic', 'other'][k]]++;
      if (k >= 1 && k <= 3) basicN.push(a);
    }
    // --- hydrocarbon components and tails ---
    var hc = new Uint8Array(n); for (a = 0; a < n; a++) hc[a] = (Z[a] === 6 && !fC[a]) ? 1 : 0;
    var comp = new Int32Array(n).fill(-1), comps = [];
    for (a = 0; a < n; a++) {
      if (!hc[a] || comp[a] >= 0) continue;
      var id = comps.length, list = [a], qi = 0; comp[a] = id;
      while (qi < list.length) { var u = list[qi++]; for (i = 0; i < deg[u]; i++) { b = mol.getConnAtom(u, i); if (hc[b] && comp[b] < 0) { comp[b] = id; list.push(b); } } }
      comps.push(list);
    }
    var tails = [], isTail = new Uint8Array(n);
    function tailFrom(atoms, root, ext) {
      // atoms: carbons of the tail; root: tail carbon bonded to ext (the atom outside the tail the tail hangs on)
      var inT = new Uint8Array(n), k2, u2; for (k2 = 0; k2 < atoms.length; k2++) inT[atoms[k2]] = 1;
      var acyl = ext >= 0 && carbonyl[ext] === 1 && Z[ext] === 6;
      var t = { nC: atoms.length + (acyl ? 1 : 0), acyl: acyl, nDoubleBonds: 0, nTripleBonds: 0, branched: false, branchPosition: 0, arms: [], nMethylBranches: 0, hasRing: false, hasCyclopropyl: false, hasAromatic: false, atoms: atoms, root: root };
      var depth = new Int16Array(n).fill(-1), par = new Int32Array(n).fill(-1), orderBfs = [root], kids = {};
      depth[root] = acyl ? 2 : 1;
      for (var q = 0; q < orderBfs.length; q++) {
        u2 = orderBfs[q]; kids[u2] = [];
        for (k2 = 0; k2 < deg[u2]; k2++) {
          var v = mol.getConnAtom(u2, k2); if (!inT[v]) continue;
          if (depth[v] < 0) { depth[v] = depth[u2] + 1; par[v] = u2; kids[u2].push(v); orderBfs.push(v); }
          if (v > u2) {
            var cb = mol.getConnBond(u2, k2);
            if (mol.isRingBond(cb)) { t.hasRing = true; if (mol.getBondRingSize(cb) === 3) t.hasCyclopropyl = true; if (mol.isAromaticBond(cb)) t.hasAromatic = true; }
            if (!mol.isAromaticBond(cb)) { var bo = order(u2, k2); if (bo === 2) t.nDoubleBonds++; else if (bo === 3) t.nTripleBonds++; }
          }
        }
      }
      // longest downward path (in carbons) for every node
      var down = {}; for (q = orderBfs.length - 1; q >= 0; q--) { u2 = orderBfs[q]; var best = 0; for (k2 = 0; k2 < kids[u2].length; k2++) best = Math.max(best, down[kids[u2][k2]]); down[u2] = best + 1; }
      for (q = 0; q < orderBfs.length; q++) {
        u2 = orderBfs[q];
        if (kids[u2].length >= 2) {
          if (!t.branched) { t.branched = true; t.branchPosition = depth[u2]; t.arms = kids[u2].map(function (x) { return down[x]; }).sort(function (x, y) { return y - x; }); }
          for (k2 = 0; k2 < kids[u2].length; k2++) if (down[kids[u2][k2]] === 1) t.nMethylBranches++;
        }
      }
      if (!t.branched) t.arms = [atoms.length];
      return t;
    }
    for (var ci = 0; ci < comps.length; ci++) {
      var atoms = comps[ci], att = [], extOf = {};
      for (i = 0; i < atoms.length; i++) {
        a = atoms[i];
        for (var k3 = 0; k3 < deg[a]; k3++) { b = mol.getConnAtom(a, k3); if (!hc[b]) { if (extOf[a] === undefined) { extOf[a] = b; att.push(a); } else if (carbonyl[b]) extOf[a] = b; } }
      }
      if (att.length <= 1) {
        if (atoms.length >= MIN_TAIL) tails.push(tailFrom(atoms, att.length ? att[0] : atoms[0], att.length ? extOf[att[0]] : -1));
        continue;
      }
      // several attachment carbons: prune leaves that are not attachments; what is pruned hangs off the core as tails
      var inC = {}, cdeg = {}, alive = {};
      for (i = 0; i < atoms.length; i++) { inC[atoms[i]] = 1; alive[atoms[i]] = 1; }
      for (i = 0; i < atoms.length; i++) { a = atoms[i]; var dd = 0; for (k3 = 0; k3 < deg[a]; k3++) if (inC[mol.getConnAtom(a, k3)]) dd++; cdeg[a] = dd; }
      var stack = []; for (i = 0; i < atoms.length; i++) { a = atoms[i]; if (cdeg[a] <= 1 && extOf[a] === undefined) stack.push(a); }
      while (stack.length) {
        a = stack.pop(); if (!alive[a]) continue; alive[a] = 0;
        for (k3 = 0; k3 < deg[a]; k3++) { b = mol.getConnAtom(a, k3); if (inC[b] && alive[b]) { cdeg[b]--; if (cdeg[b] <= 1 && extOf[b] === undefined) stack.push(b); } }
      }
      var seen = {};
      for (i = 0; i < atoms.length; i++) {
        a = atoms[i]; if (alive[a] || seen[a]) continue;
        var piece = [a], root = -1, ext = -1; seen[a] = 1;
        for (var pq = 0; pq < piece.length; pq++) {
          var pu = piece[pq];
          for (k3 = 0; k3 < deg[pu]; k3++) { b = mol.getConnAtom(pu, k3); if (!inC[b]) continue; if (alive[b]) { root = pu; ext = b; } else if (!seen[b]) { seen[b] = 1; piece.push(b); } }
        }
        if (piece.length >= MIN_TAIL && root >= 0) tails.push(tailFrom(piece, root, ext));
      }
    }
    tails.sort(function (x, y) { return y.nC - x.nC || y.nDoubleBonds - x.nDoubleBonds; });
    var nEnds = 0, tailC = 0, tailDbl = 0, nBr = 0, cyclo = false;
    for (i = 0; i < tails.length; i++) {
      var t = tails[i]; tailC += t.nC; tailDbl += t.nDoubleBonds; if (t.branched) nBr++; if (t.hasCyclopropyl) cyclo = true;
      nEnds += t.branched ? t.arms.filter(function (x) { return x >= 4; }).length || 1 : 1;
      for (var k4 = 0; k4 < t.atoms.length; k4++) isTail[t.atoms[k4]] = 1;
    }
    // --- head group: around the main basic nitrogen ---
    var rings = 0; try { rings = mol.getRingSet().getSize(); } catch (e) { rings = 0; }
    var mainN = -1, mainKind = 9;
    for (i = 0; i < basicN.length; i++) if (nKind[basicN[i]] < mainKind) { mainKind = nKind[basicN[i]]; mainN = basicN[i]; }
    if (mainN < 0) for (a = 0; a < n; a++) if (nKind[a] === 4) { mainN = a; break; }
    var head = { smiles: '', hasOH: false, nCarbonsToAmine: -1, nMethylOnN: 0, ringN: false, atoms: [] };
    if (mainN >= 0) {
      head.ringN = mol.isRingAtom(mainN);
      var dist = new Int16Array(n).fill(-1), hq = [mainN], allC = new Uint8Array(n); dist[mainN] = 0; allC[mainN] = 1;
      for (var hi = 0; hi < hq.length; hi++) {
        var hu = hq[hi];
        for (i = 0; i < deg[hu]; i++) {
          b = mol.getConnAtom(hu, i); if (dist[b] >= 0) continue;
          if (fC[b] || inLinker[b]) { if (allC[hu] && (head.nCarbonsToAmine < 0 || dist[hu] < head.nCarbonsToAmine)) head.nCarbonsToAmine = dist[hu]; continue; }
          if (isTail[b]) continue;
          dist[b] = dist[hu] + 1; hq.push(b); allC[b] = (allC[hu] && Z[b] === 6) ? 1 : 0;
          if (Z[b] === 8 && deg[b] === 1 && Z[hu] === 6 && dist[b] <= 6 && mol.getAtomCharge(b) === 0) head.hasOH = true;
        }
      }
      for (i = 0; i < deg[mainN]; i++) { b = mol.getConnAtom(mainN, i); if (Z[b] === 6 && deg[b] === 1) head.nMethylOnN++; }
      head.atoms = hq;
    }
    var nBasic = A.tertiary + A.secondary + A.primary, hc2;
    if (el.P > 0) hc2 = A.quaternary ? 'phosphocholine' : (A.primary ? 'phosphoethanolamine' : 'phospho');
    else if (A.quaternary > 0) hc2 = 'quaternary';
    else if (nBasic >= 2) hc2 = 'polyamine';
    else if (nBasic === 1) {
      if (mainKind === 1) hc2 = head.ringN ? 'cyclic-tert-amine' : (head.nMethylOnN >= 2 ? 'dimethylamino' : (head.hasOH ? 'hydroxyalkyl-tert-amine' : 'tert-amine'));
      else hc2 = mainKind === 2 ? 'sec-amine' : 'prim-amine';
    }
    else if (rings >= 4 && el.C >= 17 && el.N === 0) hc2 = 'sterol';
    else if (A.aromatic > 0) hc2 = 'heteroaryl';
    else if (A.amide > 0) hc2 = 'amide';
    else if (el.N > 0) hc2 = 'other-n';
    else if (L.ether >= 3) hc2 = 'polyether';
    else hc2 = n ? 'neutral' : 'none';
    var cls = 'none', cnt = 0;
    ['tertiary', 'quaternary', 'secondary', 'primary'].forEach(function (kk) { if (A[kk] > cnt) { cnt = A[kk]; cls = kk; } });
    var d = {
      heavy: n, el: el, charge: charge, nN: el.N,
      amine: { 'class': cls, count: cnt }, amines: A,
      head: hc2, headgroup: { smiles: '', hasOH: head.hasOH, nCarbonsToAmine: head.nCarbonsToAmine, nMethylOnN: head.nMethylOnN, ringN: head.ringN },
      links: L,
      linkers: ['ester', 'amide', 'carbamate', 'carbonate', 'urea', 'thioester', 'ether', 'thioether', 'disulfide', 'ketal'].filter(function (kk) { return L[kk] > 0; }).map(function (kk) { return { type: kk, count: L[kk] }; }),
      tails: tails, nTails: tails.length, nChainEnds: nEnds, totalCarbons: el.C, tailCarbons: tailC, tailDoubleBonds: tailDbl, nBranchedTails: nBr,
      hasCyclopropyl: cyclo, rings: rings,
      biodegradable: (L.ester + L.carbonate + L.disulfide + L.thioester) > 0
    };
    if (opts.OCL && opts.smiles !== false) {
      // fragment SMILES for the head group and each tail (only on request: used for display, not in the bulk build)
      var frag = function (list) {
        try { var inc = []; for (var q2 = 0; q2 < mol.getAllAtoms(); q2++) inc.push(false); for (q2 = 0; q2 < list.length; q2++) inc[list[q2]] = true; var dst = new opts.OCL.Molecule(list.length + 1, list.length + 1); mol.copyMoleculeByAtoms(dst, inc, true, null); dst.setFragment(false); return dst.toSmiles(); } catch (e) { return ''; }
      };
      d.headgroup.smiles = head.atoms.length ? frag(head.atoms) : '';
      for (i = 0; i < tails.length; i++) tails[i].smiles = frag(tails[i].atoms);
    }
    for (i = 0; i < tails.length; i++) { delete tails[i].atoms; delete tails[i].root; }
    return d;
  }

  /* ---------- scaffold: tails truncated, stereo removed ---------- */
  function scaffold(OCL, mol) {
    var m = mol.getCompactCopy(); m.ensureHelperArrays(7);
    var n = m.getAtoms(), del = new Uint8Array(n), nTrunc = 0, a;
    for (a = 0; a < n; a++) {
      if (m.getAtomicNo(a) !== 6 || m.getConnAtoms(a) !== 1) continue;
      var chain = [a], prev = a, cur = m.getConnAtom(a, 0);
      while (m.getAtomicNo(cur) === 6 && m.getConnAtoms(cur) === 2 && !m.isRingAtom(cur)) {
        chain.push(cur);
        var nx = m.getConnAtom(cur, 0) === prev ? m.getConnAtom(cur, 1) : m.getConnAtom(cur, 0);
        prev = cur; cur = nx;
      }
      if (chain.length >= TRUNC_CHAIN && m.getConnAtoms(cur) !== 1) { for (var i = 0; i < chain.length - 1; i++) del[chain[i]] = 1; nTrunc++; }
    }
    if (nTrunc) { for (a = 0; a < n; a++) if (del[a]) m.markAtomForDeletion(a); m.deleteMarkedAtomsAndBonds(); }
    return { idcode: flatIdcode(OCL, m), nTrunc: nTrunc };
  }
  // idcode without any stereo information. stripStereoInformation() is not reliable on molecules that were built
  // from an idcode without coordinates, so the canonizer is told to neglect stereo instead.
  function flatIdcode(OCL, mol) { return mol.getCanonizedIDCode(OCL.Molecule.CANONIZER_NEGLECT_ANY_STEREO_INFORMATION); }
  function noStereoHash(OCL, mol) { return hashStr(flatIdcode(OCL, mol)); }

  /* ---------- columnar record ---------- */
  // [name, type]; types: u8 u16 i16 u32 f32. Columns filled by the build from other sources are listed in pipeline/chem_build.cjs.
  var COLS = [
    ['heavy', 'u8'], ['nC', 'u8'], ['nN', 'u8'], ['nO', 'u8'], ['nP', 'u8'], ['nS', 'u8'], ['nHal', 'u8'], ['charge', 'i16'],
    ['nTert', 'u8'], ['nSec', 'u8'], ['nPrim', 'u8'], ['nQuat', 'u8'], ['nAmideN', 'u8'], ['nArN', 'u8'], ['nOtherN', 'u8'],
    ['ester', 'u8'], ['carbonate', 'u8'], ['carbamate', 'u8'], ['amide', 'u8'], ['urea', 'u8'], ['thioester', 'u8'], ['ether', 'u8'], ['thioether', 'u8'],
    ['disulfide', 'u8'], ['ketal', 'u8'], ['phosphate', 'u8'], ['hydroxyl', 'u8'], ['acid', 'u8'], ['rings', 'u8'],
    ['head', 'u8'], ['nTails', 'u8'], ['nEnds', 'u8'], ['tailC', 'u8'], ['tailDbl', 'u8'], ['nBranched', 'u8'], ['spacer', 'u8'], ['flags', 'u8'],
    ['t0', 'u8'], ['t1', 'u8'], ['t2', 'u8'], ['t3', 'u8'], ['t4', 'u8'], ['t5', 'u8'],
    ['u0', 'u8'], ['u1', 'u8'], ['u2', 'u8'], ['u3', 'u8'], ['u4', 'u8'], ['u5', 'u8'],
    ['b0', 'u8'], ['b1', 'u8'], ['b2', 'u8'], ['b3', 'u8'], ['b4', 'u8'], ['b5', 'u8']
  ];
  // flags: bit0 biodegradable, bit1 OH near amine, bit2 cyclopropyl in a tail, bit3 ring nitrogen, bit4 stereo defined (set by build)
  // uK: bits 0-3 double bonds (capped 15), bit4 branched, bit5 ring, bit6 acyl (carbonyl carbon counted in tK), bit7 triple bond
  // bK: branch position (0 = linear), counted from the atom the tail hangs on (acyl: carbonyl carbon = 1)
  function c8(x) { return x > 255 ? 255 : x; }
  function row(d) {
    var r = {
      heavy: c8(d.heavy), nC: c8(d.el.C), nN: c8(d.el.N), nO: c8(d.el.O), nP: c8(d.el.P), nS: c8(d.el.S), nHal: c8(d.el.hal), charge: d.charge,
      nTert: c8(d.amines.tertiary), nSec: c8(d.amines.secondary), nPrim: c8(d.amines.primary), nQuat: c8(d.amines.quaternary), nAmideN: c8(d.amines.amide), nArN: c8(d.amines.aromatic), nOtherN: c8(d.amines.other),
      ester: c8(d.links.ester), carbonate: c8(d.links.carbonate), carbamate: c8(d.links.carbamate), amide: c8(d.links.amide), urea: c8(d.links.urea), thioester: c8(d.links.thioester), ether: c8(d.links.ether), thioether: c8(d.links.thioether),
      disulfide: c8(d.links.disulfide), ketal: c8(d.links.ketal), phosphate: c8(d.links.phosphate), hydroxyl: c8(d.links.hydroxyl), acid: c8(d.links.acid), rings: c8(d.rings),
      head: Math.max(0, HEADS.indexOf(d.head)), nTails: c8(d.nTails), nEnds: c8(d.nChainEnds), tailC: c8(d.tailCarbons), tailDbl: c8(d.tailDoubleBonds), nBranched: c8(d.nBranchedTails),
      spacer: d.headgroup.nCarbonsToAmine < 0 ? 255 : c8(d.headgroup.nCarbonsToAmine),
      flags: (d.biodegradable ? 1 : 0) | (d.headgroup.hasOH ? 2 : 0) | (d.hasCyclopropyl ? 4 : 0) | (d.headgroup.ringN ? 8 : 0)
    };
    for (var i = 0; i < MAXT; i++) {
      var t = d.tails[i];
      r['t' + i] = t ? c8(t.nC) : 0;
      r['u' + i] = t ? (Math.min(15, t.nDoubleBonds) | (t.branched ? 16 : 0) | (t.hasRing ? 32 : 0) | (t.acyl ? 64 : 0) | (t.nTripleBonds ? 128 : 0)) : 0;
      r['b' + i] = t ? c8(t.branchPosition) : 0;
    }
    return r;
  }

  var api = { VERSION: VERSION, NB: NB, fp: fp, tanimotoPacked: tanimotoPacked, describe: describe, scaffold: scaffold, noStereoHash: noStereoHash, flatIdcode: flatIdcode, hashStr: hashStr, row: row, COLS: COLS, HEADS: HEADS, MAXT: MAXT, MIN_TAIL: MIN_TAIL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.ChemFP = api;
})(typeof self !== 'undefined' ? self : globalThis);
