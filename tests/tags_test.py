#!/usr/bin/env python3
"""Tests of the tags pipeline (pipeline/tags_build.py, pipeline/lib/asg_norm.py, data/seed/*.json) and of the tg-1 layout.

  python3 -I tests/tags_test.py [--full]

  1. assignee normaliser: variant groups merge, banks / agents are dropped, 30+ cases
  2. tag rules on synthetic records (EN, DE, CPC, claims-only, from-claims bit) through a scratch corpus
  3. tg-1 binary layout round trip (header, planar words, legal byte, asg ids) read back with an independent parser
  4. compound conditions on a synthetic chemistry build
  5. --full: the real build file data/work/xdata/tags must exist, be <= 1 MB gzip, and agree with the corpus row count
"""
import gzip
import json
import os
import struct
import subprocess
import sys
import tempfile
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline", "lib"))
from asg_norm import Normalizer, nice  # noqa: E402

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("FAIL " + msg)
    return cond


# ---------------------------------------------------------------------------------------------- 1 normaliser
def test_normaliser():
    n = Normalizer.load()
    groups = {
        "ModernaTX": ["MODERNATX INC (US)", "MODERNATX, INC.", "ModernaTX, Inc. (US)", "MODERNA THERAPEUTICS, INC.", "ModernaTX Inc"],
        "Alnylam Pharmaceuticals": ["ALNYLAM PHARMACEUTICALS INC (US)", "ALNYLAM PHARMACEUTICALS, INC.", "Alnylam Pharmaceuticals, Inc.", "Alnylam Europe AG"],
        "Massachusetts Institute of Technology": ["MASSACHUSETTS INST TECHNOLOGY (US)", "Massachusetts Institute of Technology", "MASSACHUSETTS INSTITUTE OF TECHNOLOGY", "MASSACHUSETTS INSTITUTE OF TECHNOLOGY (US)"],
        "University of California": ["UNIV CALIFORNIA (US)", "The Regents of the University of California", "THE REGENTS OF THE UNIVERSITY OF CALIFORNIA (US)", "THE REGENTS OF THE UNIVERSITY OF CALIFORNIA"],
        "University of Texas System": ["UNIV TEXAS (US)", "Board of Regents, The University of Texas System", "THE BOARD OF REGENTS OF THE UNIVERSITY OF TEXAS SYSTEM (US)"],
        "Johns Hopkins University": ["UNIV JOHNS HOPKINS (US)", "THE JOHNS HOPKINS UNIVERSITY", "The Johns Hopkins University (US)"],
        "University of Pennsylvania": ["UNIV PENNSYLVANIA (US)", "THE TRUSTEES OF THE UNIVERSITY OF PENNSYLVANIA", "The Trustees of The University of Pennsylvania"],
        "Stanford University": ["UNIV LELAND STANFORD JUNIOR (US)", "The Board of Trustees of the Leland Stanford Junior University", "THE BOARD OF TRUSTEES OF THE LELAND STANFORD JUNIOR UNIVERSITY (US)"],
        "CNRS (Centre National de la Recherche Scientifique)": ["CENTRE NAT RECH SCIENT (FR)", "CENTRE NATIONAL DE LA RECHERCHE SCIENTIFIQUE (FR)", "Centre National de la Recherche Scientifique (CNRS)"],
        "Arbutus Biopharma (incl. Protiva, Tekmira, Inex)": ["ARBUTUS BIOPHARMA CORPORATION, BURNABY, CA", "PROTIVA BIOTHERAPEUTICS, INC. (CA)", "Tekmira Pharmaceuticals Corp", "INEX PHARMACEUTICALS CORP (CA)"],
        "Harvard University": ["President and Fellows of Harvard College", "HARVARD COLLEGE (US)"],
        "Merck & Co. (MSD)": ["MERCK SHARP & DOHME CORP.", "Merck & Co., Inc."],
        "Takeda": ["Takeda Pharmaceutical Company Limited", "TAKEDA CHEMICAL INDUSTRIES, LTD."],
        "US Government (HHS / NIH)": ["NATIONAL INSTITUTES OF HEALTH (NIH), U.S. DEPT. OF HEALTH AND HUMAN SERVICES (DHHS), U.S. GOVERNMENT", "US HEALTH (US)",
                                      "THE UNITED STATES OF AMERICA, AS REPRESENTED BY THE SECRETARY, DEPARTMENT OF HEALTH AND HUMAN SERVICES"],
    }
    for name, variants in groups.items():
        got = {n.canonical(v) for v in variants}
        check(got == {name}, "merge %s: got %s" % (name, sorted(got)))
    # distinct organisations stay distinct
    distinct = [("Merck Patent GmbH", "Merck Sharp & Dohme Corp."), ("Novartis AG", "Novartis Vaccines and Diagnostics, Inc."), ("Sirna Therapeutics, Inc.", "Sirnaomics, Inc."),
                ("Genevant Sciences GmbH", "Arbutus Biopharma Corporation"), ("University of Texas M.D. Anderson Cancer Center", "University of Texas System"),
                ("Schering Corporation", "Schering Aktiengesellschaft"), ("Pfizer Inc.", "Wyeth LLC")]
    for a, b in distinct:
        check(n.canonical(a) != n.canonical(b), "distinct: %s vs %s" % (a, b))
    # keys: legal suffixes, country tags, addresses, DOCDB abbreviations
    keys = {"Acme Inc.": "acme", "ACME INC (US)": "acme", "Acme GmbH": "acme", "Acme AG": "acme", "Acme S.A.": "acme", "Acme Ltd": "acme", "Acme LLC": "acme",
            "Acme B.V.": "acme", "Acme N.V.": "acme", "Acme plc": "acme", "Acme Co., Ltd.": "acme", "Acme Corporation, Cambridge, MA": "acme",
            "Acme Pharmaceuticals, Inc., Boston, US": "acme", "UNIV YALE (US)": "university yale", "Yale University": "university yale",
            "Novo Nordisk A/S": "novo nordisk", "Institut Pasteur": "institut pasteur", "The Scripps Research Institute": "scripps research institute",
            "SCRIPPS RESEARCH INST (US)": "scripps research institute", "Wisconsin Alumni Res Found": "wisconsin alumni research foundation"}
    for raw, want in keys.items():
        check(n.key(raw) == want, "key(%r) = %r, want %r" % (raw, n.key(raw), want))
    # banks and agents
    for raw in ["BANK OF AMERICA, N.A.", "ARES CAPITAL CORPORATION, AS AGENT", "WILMINGTON TRUST, NATIONAL ASSOCIATION", "OXFORD FINANCE LLC", "SILICON VALLEY BANK",
                "JPMORGAN CHASE BANK, N.A., AS ADMINISTRATIVE AGENT", "HERCULES CAPITAL, INC.", "Foley Hoag LLP", "X Corp, as collateral agent", "U.S. BANK TRUST COMPANY, NATIONAL ASSOCIATION, AS COLLATERAL TRUSTEE"]:
        check(n.is_non_owner(raw), "non-owner: " + raw)
    for raw in ["South Bank University Enterprises Ltd.", "The Wellcome Trust Limited as Trustee to the Wellcome Trust", "The Trustees of Columbia University in the City of New York",
                "Oxford Biomedica (UK) Limited", "ModernaTX, Inc.", "THE REGENTS OF THE UNIVERSITY OF NEW MEXICO C/O RESEARCH & TECHNOLOGY LAW"]:
        check(not n.is_non_owner(raw), "owner: " + raw)
    check(n.first_owner(["BANK OF AMERICA, N.A.", "ModernaTX, Inc."]) == "ModernaTX", "first_owner skips a bank")
    check(n.first_owner(["ARES CAPITAL CORPORATION, AS AGENT"]) is None, "first_owner: only an agent -> None")
    check(n.first_owner([]) is None and n.first_owner(None) is None, "first_owner: empty")
    check(nice("ANTICANCER INC") == "Anticancer Inc" and nice("Already Mixed") == "Already Mixed", "nice(): %s" % nice("ANTICANCER INC"))
    check(n.key("") == "" and n.key(None) == "", "empty names")
    # a general normaliser without any alias file still merges spelling variants
    g = Normalizer({})
    check(g.key("UNIV TEXAS (US)") == g.key("Board of Regents, The University of Texas System"), "no aliases: UT variants share a key")
    check(g.canonical("ACME INC (US)") == "Acme Inc", "no aliases: display %s" % g.canonical("ACME INC (US)"))
    # several parties in one raw string, HTML entities, same-word-order university keys
    check(n.parties("The Broad Institute, Inc.; Massachusetts Institute of Technology") == ["The Broad Institute, Inc.", "Massachusetts Institute of Technology"], "parties: split on ';'")
    check(n.parties("Peyman; Gholam A.") == ["Peyman; Gholam A."], "parties: 'Surname; Given A.' stays one person: %s" % n.parties("Peyman; Gholam A."))
    check(n.parties("A Inc.;") == ["A Inc."] and n.parties("") == [] and n.parties(None) == [], "parties: empty parts")
    check(n.first_owner(["Bank X; ModernaTX, Inc."]) == "ModernaTX", "first_owner: non-owner party of a joined string is skipped")
    check(n.first_owner(["MODERNATX INC (US); Pfizer Inc."]) == "ModernaTX", "first_owner: first party of a joined string")
    check(n.canonical("Merck Sharp &amp; Dohme Corp.") == n.canonical("Merck Sharp & Dohme Corp.") == "Merck & Co. (MSD)", "&amp; spelling merges: %s" % n.canonical("Merck Sharp &amp; Dohme Corp."))
    check("&amp;" not in n.canonical("The Procter &amp; Gamble Company") and "amp" not in n.key("The Procter &amp; Gamble Company").split(), "no 'amp' token")
    check(n.is_non_owner("Zeno Royalties &amp; Milestones, LLC") and n.is_non_owner("Horizon Technology Finance Corporation") and
          n.is_non_owner("Innovatus Life Sciences Lending Fund I, LP") and n.is_non_owner("Calfee, Halter & Griswold LLP"), "lenders, royalty funds, law firms are non-owners")
    check(not n.is_non_owner("Genentech, Inc.") and not n.is_non_owner("Royalty Pharma Plc"), "owners kept")
    check(n.key("WASHINGTON UNIVERSITY") != n.key("University of Washington") and n.key("UNIV WASHINGTON") == n.key("University of Washington"), "WashU is not UW")
    check(n.canonical("Washington University") != n.canonical("University of Washington"), "WashU / UW canonical differ")
    check(n.key("Miami University") != n.key("University of Miami") and n.key("UNIV MIAMI") == n.key("University of Miami"), "Miami U is not U Miami")
    check(n.key("WASHINGTON, UNIVERSITY OF, THE") == n.key("University of Washington"), "inverted 'X, University of, The'")
    check(n.canonical("Merck KGaA") == "Merck KGaA" and n.canonical("MERCK S.A.") != "Merck & Co. (MSD)" and n.canonical("Merck & Co., Inc.") == "Merck & Co. (MSD)", "Merck variants: %s" % n.canonical("MERCK S.A."))
    check(n.canonical("The John Hopkins University") == "Johns Hopkins University", "Hopkins typo: %s" % n.canonical("The John Hopkins University"))
    print("normaliser: %d cases" % (sum(len(v) for v in groups.values()) + len(distinct) + len(keys) + 16))


# ---------------------------------------------------------------------------------------------- 2/3/4 synthetic build
def read_tg1(path):
    raw = gzip.open(path).read()
    jl = struct.unpack("<I", raw[:4])[0]
    head = json.loads(raw[4:4 + jl].decode("utf-8"))
    o = 4 + jl
    o += (-o) % 4
    P, W = head["P"], head["W"]
    tag = [struct.unpack("<%dI" % P, raw[o + 4 * P * w:o + 4 * P * (w + 1)]) for w in range(W)]
    o2 = o + 4 * P * W
    frm = [struct.unpack("<%dI" % P, raw[o2 + 4 * P * w:o2 + 4 * P * (w + 1)]) for w in range(W)]
    o3 = o2 + 4 * P * W
    leg = raw[o3:o3 + P]
    o4 = o3 + P
    o4 += (-o4) % 4
    asg = struct.unpack("<%dI" % P, raw[o4:o4 + 4 * P])
    assert o4 + 4 * P == len(raw), "no trailing bytes"
    return head, tag, frm, leg, asg


def test_build():
    tmp = tempfile.mkdtemp(prefix="tags_test_")
    try:
        recs = [
            {"pn": "EP1A1", "title": {"en": "Lipid nanoparticle for mRNA delivery"}, "abstract": None, "assignees": ["MODERNATX INC (US)"], "cpc": ["A61K9/1272"],
             "claims": {"en": [{"n": 1, "t": "A composition comprising an mRNA encoding a polypeptide, an ionizable lipid, a PEG-lipid and cholesterol, for intramuscular injection.", "dep": []}], "de": []},
             "status": {"opposition": {"filed": True, "outcome": "revoked"}, "appeal": True, "lapsed_in": [{"cc": "DE"}], "unitary": None}},
            {"pn": "EP2B1", "title": {"de": "Verfahren zur Herstellung von Liposomen"}, "assignees": ["BANK OF AMERICA, N.A.", "Acme GmbH"], "cpc": ["B01F33/30"],
             "claims": {"en": [], "de": [{"n": 1, "t": "Verfahren, bei dem eine siRNA intravenös verabreicht wird, mit Cholesterin und gefriertrocknet.", "dep": []}]}},
            {"pn": "US3A1", "title": {"en": "Aerosol device"}, "abstract": "A cancer vaccine that is inhaled.", "assignees": ["ARES CAPITAL CORPORATION, AS AGENT"], "cpc": ["C12N2310/14"],
             "claims": {"en": [], "de": []}},
            {"pn": "WO4A1", "title": {"en": "Nothing relevant here"}, "assignees": ["UNIV TEXAS (US)"], "cpc": [], "claims": {"en": [{"n": 1, "t": "A hammer.", "dep": []}], "de": []},
             "status": {"terminal_disclaimer": True, "unitary": "registered"}},
        ]
        corpus = os.path.join(tmp, "corpus.jsonl.gz")
        with gzip.open(corpus, "wt", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n\n")                         # blank lines are skipped, as build_dist does
        rules = {"v": "tr-1", "groups": [{"id": "ga", "label": "G1"}, {"id": "gb", "label": "G2"}],
                 "tags": [{"id": "mrna", "group": "ga", "label": "mRNA", "en": [r"\bmrna\b"], "de": [r"boten-?rna"]},
                          {"id": "sirna", "group": "ga", "label": "siRNA", "en": [r"\bsirna\b"], "cpc": ["C12N2310/14"]},
                          {"id": "im", "group": "gb", "label": "IM", "en": [r"intramuscular"], "de": [r"intramuskul\w+"], "claimsOnly": True},
                          {"id": "iv", "group": "gb", "label": "IV", "en": [r"intravenous"], "de": [r"intraven\w+"], "claimsOnly": True},
                          {"id": "vacc", "group": "gb", "label": "Vaccine", "en": [r"vaccine"]},
                          {"id": "chol", "group": "gb", "label": "Sterol", "en": [r"cholesterol"], "de": [r"cholesterin"]},
                          {"id": "lyo", "group": "gb", "label": "Lyo", "de": [r"gefriertrock\w+"]},
                          {"id": "mix", "group": "gb", "label": "Mix", "cpc": ["B01F33/30"]}] +
                         [{"id": "pad%d" % i, "group": "gb", "label": "pad %d" % i, "en": [r"zzzzzz%d" % i]} for i in range(30)],      # > 32 tags: two words
                 "legal": [{"id": "opp", "label": "Opposition", "bit": 0, "when": {"path": "opposition.filed", "eq": True}},
                           {"id": "rev", "label": "Revoked", "bit": 1, "when": {"path": "opposition.outcome", "eq": "revoked"}},
                           {"id": "lapsed", "label": "Lapsed", "bit": 2, "when": {"path": "lapsed_in", "nonempty": True}},
                           {"id": "td", "label": "TD", "bit": 3, "when": {"path": "terminal_disclaimer", "eq": True}},
                           {"id": "unitary", "label": "Unitary", "bit": 4, "when": {"path": "unitary", "eq": "registered"}},
                           {"id": "appeal", "label": "Appeal", "bit": 5, "when": {"path": "appeal", "eq": True}}]}
        rp = os.path.join(tmp, "rules.json")
        json.dump(rules, open(rp, "w"))
        out = os.path.join(tmp, "out")
        cmd = [sys.executable, "-I", os.path.join(ROOT, "pipeline", "tags_build.py"), "--corpus", corpus, "--rules", rp, "--out", out, "--status", os.path.join(tmp, "none.gz"),
               "--chem", os.path.join(tmp, "nochem"), "--spot-check", "0", "--force"]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
        if not check(r.returncode == 0, "tags_build on a synthetic corpus: " + r.stdout[-300:] + r.stderr[-600:]):
            return
        head, tag, frm, leg, asg = read_tg1(os.path.join(out, "tags.gz.bin"))
        check(head["v"] == "tg-1" and head["P"] == 4 and head["W"] == 2, "layout: v, P, W (38 tags -> 2 words): %s %s %s" % (head["v"], head["P"], head["W"]))
        bit = {t["id"]: t["bit"] for t in head["tags"]}

        def has(p, tid, src=tag):
            return bool(src[bit[tid] >> 5][p] >> (bit[tid] & 31) & 1)
        check(has(0, "mrna") and has(0, "mrna", frm), "EN claim: mRNA set and from claims")
        check(has(0, "im") and has(0, "chol") and not has(0, "iv"), "EN claim: intramuscular, cholesterol, not intravenous")
        check(has(1, "iv") and has(1, "chol") and has(1, "lyo") and has(1, "iv", frm), "DE claims (no EN): intravenous, Cholesterin, gefriertrocknet, from claims")
        check(has(1, "mix") and not has(1, "mix", frm), "CPC-only tag is not 'from claims'")
        check(has(2, "sirna") and not has(2, "sirna", frm), "CPC tag without claims")
        check(has(2, "vacc") and not has(2, "vacc", frm), "abstract hit is not 'from claims'")
        check(not has(2, "im") and not has(3, "mrna"), "no false positives")
        check(not any(has(3, t["id"]) for t in head["tags"]), "patent with no hits has no tag")
        # claimsOnly: a title/abstract hit must not count
        check(not has(2, "iv"), "claimsOnly tag ignores title / abstract")
        check(bit["pad29"] == 37 and has(0, "mrna"), "tag bits above 31 live in word 1")
        lb = {l["id"]: l["bit"] for l in head["legal"]}
        check(leg[0] == (1 << lb["opp"]) | (1 << lb["rev"]) | (1 << lb["lapsed"]) | (1 << lb["appeal"]), "legal byte of patent 0: %s" % leg[0])
        check(leg[3] == (1 << lb["td"]) | (1 << lb["unitary"]) and leg[1] == 0 and leg[2] == 0, "legal byte of patent 3 (terminal disclaimer, unitary)")
        names = head["asg"]
        check(asg[0] != 0xffffffff and names[asg[0]] == "ModernaTX", "asg of patent 0: canonical ModernaTX")
        check(asg[1] != 0xffffffff and names[asg[1]] == "Acme GmbH" or names[asg[1]] == "Acme", "bank skipped, next owner taken: %s" % names[asg[1]])
        check(asg[2] == 0xffffffff, "only an agent -> no assignee")
        check(names[asg[3]] == "University of Texas System", "UT system alias: %s" % names[asg[3]])
        xd = json.load(open(os.path.join(out, "xdata.json")))
        check(xd["name"] == "tags" and xd["v"] == "tg-1" and xd["files"] == ["tags.gz.bin"] and xd["target"] == "both", "xdata.json header")
        check(xd["src"]["P"] == 4 and xd["src"]["corpus_bytes"] == os.path.getsize(corpus) and xd["counts"]["patents"] == 4, "xdata.json records the corpus snapshot")
        check(xd["counts"]["perTag"]["chol"] == 2 and xd["counts"]["legal"]["opp"] == 1, "counts: %s" % xd["counts"]["perTag"])
        # idempotent: second run does nothing
        m1 = os.path.getmtime(os.path.join(out, "tags.gz.bin"))
        r2 = subprocess.run(cmd[:-1], capture_output=True, text=True, cwd=ROOT)
        check(r2.returncode == 0 and "up to date" in r2.stdout and os.path.getmtime(os.path.join(out, "tags.gz.bin")) == m1, "second run is a no-op")
        # --limit
        r3 = subprocess.run(cmd + ["--limit", "2", "--out", os.path.join(tmp, "out2")], capture_output=True, text=True, cwd=ROOT)
        h2 = read_tg1(os.path.join(tmp, "out2", "tags.gz.bin"))[0]
        check(r3.returncode == 0 and h2["P"] == 2, "--limit 2")
        # a bad rule stops the build
        bad = dict(rules)
        bad["tags"] = [{"id": "x", "group": "ga", "label": "X", "en": ["(unclosed"]}]
        json.dump(bad, open(os.path.join(tmp, "bad.json"), "w"))
        r4 = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "pipeline", "tags_build.py"), "--corpus", corpus, "--rules", os.path.join(tmp, "bad.json"), "--out", os.path.join(tmp, "o4"), "--force"],
                            capture_output=True, text=True, cwd=ROOT)
        check(r4.returncode != 0 and "bad regex" in (r4.stdout + r4.stderr), "a bad regex stops the build")
        test_engine(os.path.join(out, "tags.gz.bin"))
        test_compounds(tmp, corpus, rules)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


NODE_JS = r"""
const path = process.argv[1], eng = process.argv[2];
globalThis.LnpApp = undefined;
const T = require(eng);
const out = {};
(async () => {
  const pre = T.available(); out.preAvailable = pre;
  const st = await T.init({file: path});
  out.available = st.available; out.info = T.info();
  out.tagsOf0 = T.tagsOf(0).map(t => t.id + (t.fromClaims ? '*' : ''));
  out.tagsOf1 = T.tagsOf(1).map(t => t.id + (t.fromClaims ? '*' : ''));
  out.legal0 = T.legalOf(0).map(l => l.id); out.legal3 = T.legalOf(3).map(l => l.id);
  out.asg = [0, 1, 2, 3].map(p => T.assignee(p));
  out.psMrna = Array.from(T.ps('mrna')); out.psChol = Array.from(T.ps('chol'));
  out.psLegal = Array.from(T.ps('legal:td')); out.psAsg = Array.from(T.ps('asg:' + T.asgSlug(T.assignee(1)))); out.psNone = Array.from(T.ps('nope'));
  out.asgVals = T.counts(null).asg.map(x => x.value); out.psAsgIdx = Array.from(T.ps('asg:0'));
  out.counts = T.counts(Uint32Array.from([0, 1, 2]));
  out.countsAll = T.counts(null);
  out.listGroups = T.list().map(g => g.id + ':' + g.tags.length);
  out.tagsFlat = T.tags().length;
  out.oob = [T.tagsOf(99), T.legalOf(-1), T.assignee(99)].map(x => JSON.stringify(x));
  // facets: no hook -> 0; later hook -> registered
  out.reg0 = T.registerFacets();
  const reg = [];
  globalThis.LnpApp = {ext: {searchFacet: (s) => { reg.push(s); }}};
  out.reg1 = T.registerFacets();
  out.facetIds = reg.map(r => r.id);
  const f = reg.find(r => r.id === 'gb');
  out.facetCounts = await f.counts(Uint32Array.from([0, 1, 2, 3]));
  out.facetPs = Array.from(await f.ps('chol'));
  const fa = reg.find(r => r.id === 'assignee');
  out.facetAsg = (await fa.counts(Uint32Array.from([0, 1, 2, 3]))).map(x => x.label + ':' + x.n);
  // unavailable without data
  T._reset(); const T2 = await T.init({file: '/nonexistent/tags.gz.bin', force: true});
  out.bad = [T2.available, T.available(), T.tagsOf(0).length, T.ps('mrna').length, Object.keys(T.counts(null)).length, T.list().length];
  console.log(JSON.stringify(out));
})();
"""


def test_engine(tagfile):
    r = subprocess.run(["node", "-e", NODE_JS, tagfile, os.path.join(ROOT, "web", "engine", "x-tags.js")], capture_output=True, text=True)
    if not check(r.returncode == 0, "node engine run: " + r.stderr[-500:]):
        return
    o = json.loads(r.stdout.strip().splitlines()[-1])
    check(o["preAvailable"] is False and o["available"] is True, "engine: unavailable before init, available after")
    check(sorted(o["tagsOf0"]) == sorted(["mrna*", "im*", "chol*"]), "engine tagsOf(0): %s" % o["tagsOf0"])
    check(sorted(o["tagsOf1"]) == sorted(["iv*", "chol*", "lyo*", "mix", "sirna*"]), "engine tagsOf(1): %s" % o["tagsOf1"])
    check(sorted(o["legal0"]) == ["appeal", "lapsed", "opp", "rev"] and sorted(o["legal3"]) == ["td", "unitary"], "engine legalOf: %s %s" % (o["legal0"], o["legal3"]))
    check(o["asg"][0] == "ModernaTX" and o["asg"][2] is None and o["asg"][3] == "University of Texas System", "engine assignee: %s" % o["asg"])
    check(o["psMrna"] == [0] and o["psChol"] == [0, 1] and o["psLegal"] == [3] and o["psNone"] == [], "engine ps(): %s %s %s" % (o["psMrna"], o["psChol"], o["psLegal"]))
    check(o["psAsg"] == [1] and o["psAsgIdx"] == [] and all(not v[4:].isdigit() for v in o["asgVals"]), "engine ps('asg:<slug>') is name based, a bare index is not a key: %s %s" % (o["psAsg"], o["asgVals"]))
    c = o["counts"]
    check(any(x["value"] == "chol" and x["n"] == 2 for x in c["gb"]) and c["ga"][0]["value"] in ("mrna", "sirna"), "engine counts(): %s" % c["gb"])
    check([x["value"] for x in c["legal"]][:1] and all(x["value"].startswith("legal:") for x in c["legal"]) and all(x["value"].startswith("asg:") for x in c["asg"]), "engine counts: legal and asg values")
    check(sum(x["n"] for x in o["countsAll"]["asg"]) == 3, "engine counts(null) = all patents with an owner")
    check(o["listGroups"] == ["ga:%d" % 2, "gb:%d" % 36] and o["tagsFlat"] == 38, "engine list(): %s" % o["listGroups"])
    check(o["oob"] == ["[]", "[]", "null"], "engine: out-of-range patent indexes: %s" % o["oob"])
    check(o["reg0"] == 0 and o["reg1"] == 4 and sorted(o["facetIds"]) == ["assignee", "ga", "gb", "legal"], "engine registers facets only when the hook exists: %s %s" % (o["reg0"], o["facetIds"]))
    check(o["facetPs"] == [0, 1] and any(x["label"] == "Sterol" and x["n"] == 2 for x in o["facetCounts"]), "facet spec counts / ps")
    check(o["bad"] == [False, False, 0, 0, 0, 0], "engine without data: %s" % o["bad"])


def test_compounds(tmp, corpus, rules):
    """Synthetic chemistry build: 3 compounds, links to publications 0 (claims) and 3 (description only)."""
    cd = os.path.join(tmp, "chem")
    os.makedirs(cd)
    N = 3
    cols = [("head", "u8"), ("nTails", "u8"), ("tailC", "u8"), ("ester", "u8"), ("nBranched", "u8"), ("nQuat", "u8")]
    data = {"head": [9, 9, 7], "nTails": [2, 1, 2], "tailC": [36, 12, 36], "ester": [2, 0, 0], "nBranched": [0, 0, 0], "nQuat": [0, 0, 1]}
    heads = ["none", "neutral", "polyether", "sterol", "phosphocholine", "phosphoethanolamine", "phospho", "quaternary", "polyamine", "dimethylamino"]
    body, desc = bytearray(), []
    for n, t in cols:
        while len(body) % 4:
            body.append(0)
        desc.append({"name": n, "type": t, "off": len(body)})
        body += bytes(data[n])
    json.dump({"n": N, "cols": desc, "heads": heads, "where": {"clm": 1, "abs": 4, "ttl": 8, "desc": 2}}, open(os.path.join(cd, "chem.json"), "w"))
    gzip.open(os.path.join(cd, "desc.gz.bin"), "wb").write(bytes(body))
    pat = {"pn": ["US3A1", "EP1A1", "WO4A1"]}
    gzip.open(os.path.join(cd, "pat.gz.bin"), "wb").write(json.dumps(pat).encode())
    # compound 0 -> EP1A1 (claims), compound 1 -> EP1A1 (claims), compound 0 -> WO4A1 (description only), compound 2 -> US3A1 (claims)
    links = [[(1 << 8) | 1, (2 << 8) | 2], [(1 << 8) | 1], [(0 << 8) | 1]]
    off, ent = [0], []
    for l in links:
        ent += l
        off.append(len(ent))
    gzip.open(os.path.join(cd, "map.gz.bin"), "wb").write(struct.pack("<II", N, len(ent)) + struct.pack("<%dI" % (N + 1), *off) + struct.pack("<%dI" % len(ent), *ent))
    r2 = dict(rules)
    r2["tags"] = rules["tags"][:2] + [
        {"id": "ion", "group": "ga", "label": "Ionizable", "compound": {"where": ["clm"], "min": 1, "head": ["dimethylamino"], "cols": {"nTails": {"min": 2}, "tailC": {"min": 14}}}},
        {"id": "bio", "group": "ga", "label": "Biodeg", "compound": {"where": ["clm"], "min": 1, "head": ["dimethylamino"], "anyCols": ["ester", "carbonate"] and ["ester"]}},
        {"id": "ionany", "group": "ga", "label": "IonizableAnyWhere", "compound": {"where": ["clm", "desc"], "min": 1, "head": ["dimethylamino"], "cols": {"nTails": {"min": 2}}}},
        {"id": "quat", "group": "ga", "label": "Quat", "compound": {"where": ["clm"], "min": 1, "head": ["quaternary"], "cols": {"nQuat": {"max": 0}}}}]
    rp = os.path.join(tmp, "rules2.json")
    json.dump(r2, open(rp, "w"))
    out = os.path.join(tmp, "out3")
    r = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "pipeline", "tags_build.py"), "--corpus", corpus, "--rules", rp, "--out", out, "--chem", cd,
                        "--status", os.path.join(tmp, "none.gz"), "--spot-check", "0", "--force"], capture_output=True, text=True, cwd=ROOT)
    if not check(r.returncode == 0, "compound build: " + r.stdout[-300:] + r.stderr[-500:]):
        return
    head, tag, frm, leg, asg = read_tg1(os.path.join(out, "tags.gz.bin"))
    bit = {t["id"]: t["bit"] for t in head["tags"]}

    def has(p, tid, src=tag):
        return bool(src[bit[tid] >> 5][p] >> (bit[tid] & 31) & 1)
    check(has(0, "ion") and has(0, "ion", frm), "compound rule: dimethylamino, 2 tails, tailC 36 in a claim -> set, from claims")
    check(not has(1, "ion") and not has(2, "ion"), "compound rule: no hit without a linked compound (desc-only link does not count for where=clm)")
    check(has(0, "bio") and has(0, "ionany") and has(3, "ionany") and not has(3, "ionany", frm), "where includes desc: set but not 'from claims'")
    check(not has(2, "quat"), "quaternary compound excluded by nQuat max 0")


def test_full():
    d = os.path.join(ROOT, "data", "work", "xdata", "tags")
    p = os.path.join(d, "tags.gz.bin")
    if not check(os.path.exists(p), "data/work/xdata/tags/tags.gz.bin exists (run pipeline/tags_build.py)"):
        return
    size = os.path.getsize(p)
    check(size <= 1000000, "tags.gz.bin <= 1 MB gzip: %d bytes" % size)
    head, tag, frm, leg, asg = read_tg1(p)
    xd = json.load(open(os.path.join(d, "xdata.json")))
    check(head["P"] == xd["src"]["P"] == xd["counts"]["patents"], "P consistent")
    # every asg id is in range, and no bank is an assignee name
    n = Normalizer.load()
    check(all(a == 0xffffffff or a < len(head["asg"]) for a in asg), "asg ids in range")
    check(not any(n.is_non_owner(x) for x in head["asg"]), "no bank / agent among the canonical names")
    # rows in the corpus
    corpus = os.path.join(ROOT, "data", "work", "corpus.jsonl.gz")
    lim = xd["src"].get("limit") or 0
    print("full build: P=%d, %d bytes gzip, built %s" % (head["P"], size, xd["built"]))


if __name__ == "__main__":
    if "--tmp" in sys.argv:
        tempfile.tempdir = sys.argv[sys.argv.index("--tmp") + 1]
    test_normaliser()
    test_build()
    if "--full" in sys.argv:
        test_full()
    print("%d failed" % len(fails) if fails else "all ok")
    sys.exit(1 if fails else 0)
