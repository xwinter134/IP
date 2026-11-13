"""Assignee normalisation: raw applicant / proprietor strings -> one canonical name per organisation.

The normaliser is general (any patent corpus); everything corpus-specific lives in data/seed/assignee_aliases.json:

  {"v": 1,
   "non_owner": ["regex on the lower-cased raw string", ...],     banks, security agents, law firms: never an owner
   "owner_override": ["regex", ...],                              cancels a non_owner hit ("South Bank University")
   "abbrev": {"inst": "institute", ...},                          DOCDB abbreviations expanded before keying
   "stopwords": ["of", "the", ...],                               dropped from the key
   "legal_suffixes": ["inc", "gmbh", ...],                        dropped at the end of the key (repeatedly)
   "trailing_descriptors": ["pharmaceuticals", ...],              dropped at the end too (after the legal form)
   "university_prefix_merge": ["yale", ...],                      "X University" and "University of X" are ONE organisation only for these X
   "aliases": [{"name": "ModernaTX", "keys": ["modernatx"], "regex": ["^moderna"], "raw_regex": ["..."]}, ...]}   key -> display name
                                                                  (raw_regex is tried on the cleaned lower-case raw string when no key matches)

  from asg_norm import Normalizer
  n = Normalizer.load()                  # reads the seed file
  n.key("MODERNATX INC (US)")            -> "modernatx"
  n.is_non_owner("BANK OF AMERICA, N.A.") -> True
  n.canonical("UNIV CALIFORNIA (US)")    -> "University of California"   (alias) or the cleaned spelling
  n.first_owner(["BANK OF AMERICA, N.A.", "ModernaTX, Inc."]) -> "ModernaTX"
  n.parties("A Inc.; B GmbH")            -> ["A Inc.", "B GmbH"]   (one raw string may hold several ';'-separated assignees;
                                                                     a person "Surname; Given A." stays one party)
  HTML entities ("&amp;") are decoded first.

key() steps: accents folded, case folded, "(US)" country tags and "c/o" tails dropped, an address after a comma dropped when
the name already ends in a legal form ("Arbutus Biopharma Corp., Burnaby, CA"), punctuation removed, DOCDB abbreviations
expanded (UNIV, INST, NAT, RECH, SCIENT, PHARM ...), governance prefixes removed ("The Regents of", "Board of Regents,",
"Board of Trustees of"), the DOCDB form "UNIV X" and "University of X" share the key "university x" ("X University" keeps its own key "x university" unless X is
listed in university_prefix_merge: Washington University and the University of Washington are different institutions), stopwords and
trailing legal forms / descriptors dropped. Two spellings with the same key are the same organisation; the alias table
then gives the display name (and merges different keys such as "moderna" and "modernatx").
"""
import html
import json
import os
import re
import unicodedata

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ALIASES = os.path.join(os.path.dirname(os.path.dirname(_HERE)), "data", "seed", "assignee_aliases.json")

_CC = set("AT AU BE BR CA CH CN CZ DE DK ES FI FR GB HK IE IL IN IT JP KR LU MX NL NO NZ PL PT RU SE SG TW US ZA IS HU SI EP WO".split())
_COUNTRY_TAIL = re.compile(r"\s*(?:\(\s*[A-Z]{2}\s*\)|[,;]\s*[A-Z]{2})\s*$")
_GOV = [  # governance prefixes: "The Regents of the University of California" = "University of California"
    r"^(?:the )?board of regents(?: of)?(?: the)? ", r"^(?:the )?regents of(?: the)? ", r"^(?:the )?board of trustees of(?: the)? ",
    r"^(?:the )?trustees of(?: the)? ", r"^(?:the )?board of governors of(?: the)? ", r"^president and fellows of ",
    r"^(?:the )?board of supervisors of(?: the)? ", r"^(?:the )?curators of(?: the)? ",
]
_GOV = [re.compile(x) for x in _GOV]
_SPACES = re.compile(r"\s+")


def _fold(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


_DEFAULTS = {
    "abbrev": {"univ": "university", "inst": "institute", "nat": "national", "rech": "recherche", "scient": "scientifique",
               "pharm": "pharmaceuticals", "pharma": "pharmaceuticals", "lab": "laboratories", "labs": "laboratories",
               "res": "research", "dev": "development", "med": "medical", "tech": "technology", "found": "foundation",
               "hosp": "hospital", "chem": "chemical", "int": "international", "ind": "industries", "sys": "systems",
               "biotechnol": "biotechnology", "technol": "technology", "cent": "center", "centre": "center"},
    "stopwords": ["of", "the", "and", "de", "la", "le", "les", "du", "des", "et", "und", "der", "die", "das", "fur", "for"],
    "legal_suffixes": ["inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "llc", "lp", "llp", "gmbh", "ag", "sa",
                       "sas", "sarl", "bv", "nv", "ab", "as", "plc", "kg", "kgaa", "kk", "oy", "spa", "srl", "se", "pty", "ulc", "ltda", "sl", "na",
                       "pllc", "holdings", "group", "usa", "us", "mbh", "ohg", "ev", "ltee", "pte"],
    "trailing_descriptors": ["pharmaceuticals", "pharmaceutical", "therapeutics", "therapeutic", "biopharma", "pharma", "biotherapeutics"],
    "non_owner": [],
    "university_prefix_merge": [],
    "aliases": [],
}

_ORGWORD = re.compile(r"\b(?:inc|corp|corporation|co|company|ltd|limited|llc|llp|lp|gmbh|ag|sa|bv|nv|plc|university|universit\w*|institut\w*|institute|college|hospital|"
                      r"foundation|laborator\w*|pharma\w*|therapeutics|technolog\w*|research|center|centre|council|school|society|trust|group|holdings|"
                      r"department|ministry|government|systems|sciences|biotech\w*)\b", re.I)


class Normalizer:
    def __init__(self, cfg=None):
        cfg = cfg or {}
        d = dict(_DEFAULTS)
        d.update({k: v for k, v in cfg.items() if v is not None})
        self.abbrev = dict(_DEFAULTS["abbrev"])
        self.abbrev.update(cfg.get("abbrev") or {})
        self.stop = set(d["stopwords"])
        self.suffix = set(d["legal_suffixes"])
        self.desc = set(d["trailing_descriptors"])
        self.non_owner = [re.compile(x, re.I) for x in d["non_owner"]]
        self.uni_merge = set(cfg.get("university_prefix_merge") or [])
        self.override = [re.compile(x, re.I) for x in (cfg.get("owner_override") or [])]
        self.alias_keys = {}
        self.alias_rx = []
        self.raw_rx = []                # regex on the cleaned lower-case raw string, for names whose key is too short ('Merck & Co' vs 'Merck S.A.')
        self.names = []
        for a in d["aliases"]:
            name = a["name"]
            self.names.append(name)
            for k in a.get("keys") or []:
                self.alias_keys[k] = name
            for rx in a.get("regex") or []:
                self.alias_rx.append((re.compile(rx), name))
            for rx in a.get("raw_regex") or []:
                self.raw_rx.append((re.compile(rx), name))
        self._cache = {}

    @classmethod
    def load(cls, path=None):
        path = path or DEFAULT_ALIASES
        return cls(_load_json(path) if os.path.exists(path) else {})

    # ------------------------------------------------------------------ cleaning
    @staticmethod
    def clean(raw):
        """Raw string -> readable name: spaces, country tags, text after 'c/o'."""
        n = html.unescape(html.unescape(str(raw or "")))           # "&amp;" (also double-escaped "&amp;amp;")
        n = _SPACES.sub(" ", n).strip(" ,;")
        n = re.split(r"\s+c/o\s+", n, flags=re.I)[0]
        for _ in range(2):
            m = _COUNTRY_TAIL.search(n)
            if m and len(n) > 6 and re.search(r"[A-Z]{2}", m.group(0)) and re.sub(r"[^A-Z]", "", m.group(0)) in _CC:
                n = n[:m.start()].rstrip(" ,;")
            else:
                break
        return n

    def is_non_owner(self, raw):
        s = _fold(html.unescape(str(raw or ""))).lower()
        return any(rx.search(s) for rx in self.non_owner) and not any(rx.search(s) for rx in self.override)

    def _tokens(self, s):
        s = s.replace("&", " and ").replace("a/s", "as")
        s = re.sub(r"(?<=\b[a-z])\.(?=[a-z]\b)", "", s)         # n.v. -> nv, b.v. -> bv
        s = re.sub(r"[\W_]+", " ", s)
        return s.split()

    def key(self, raw):
        k = self._cache.get(raw)
        if k is not None:
            return k
        s = _fold(self.clean(raw)).lower()
        # address after the legal form: "arbutus biopharma corp., burnaby, ca" -> "arbutus biopharma corp."
        parts = [p.strip() for p in s.split(",")]
        if len(parts) > 1:
            head = self._tokens(parts[0])
            if head and (head[-1] in self.suffix or head[-1] in self.desc) and len(head) > 1:
                s = parts[0]
            else:
                # keep "Board of Regents, The University of Texas System"; drop trailing 2-letter country / state codes
                while len(parts) > 1 and re.fullmatch(r"[a-z]{2}", parts[-1]):
                    parts.pop()
                s = ", ".join(parts)
        for rx in _GOV:
            s2 = rx.sub("", s.replace(",", " ").strip())
            if s2 != s.replace(",", " ").strip() and s2:
                s = s2
                break
        s = re.sub(r"^(.+?),\s*(?:the )?univ(?:ersity)?(?: of)?(?:,\s*the)?$", r"university of \1", s)      # "WASHINGTON, UNIVERSITY OF, THE"
        toks = [self.abbrev.get(t, t) for t in self._tokens(s)]
        toks = [t for t in toks if t not in self.stop]
        # "X university" -> "university x" only for the X listed in university_prefix_merge; "university system" tail dropped
        if "university" in toks and len(toks) > 1:
            i = toks.index("university")
            if i > 0 and " ".join(toks[:i]) in self.uni_merge:
                toks = ["university"] + toks[:i] + toks[i + 1:]
            if toks[0] == "university":
                if toks[-1] == "system" and len(toks) > 2:
                    toks = toks[:-1]
        while len(toks) > 1 and (toks[-1] in self.suffix or toks[-1] in self.desc):
            toks.pop()
        k = " ".join(toks)
        if len(self._cache) < 400000:
            self._cache[raw] = k
        return k

    # ------------------------------------------------------------------ canonical
    def alias(self, key):
        n = self.alias_keys.get(key)
        if n:
            return n
        for rx, name in self.alias_rx:
            if rx.search(key):
                return name
        return None

    def raw_alias(self, raw):
        """Display name from the raw_regex entries (matched on the cleaned lower-case raw string), or None."""
        if not self.raw_rx:
            return None
        c = _fold(self.clean(raw)).lower()
        for rx, name in self.raw_rx:
            if rx.search(c):
                return name
        return None

    def canonical(self, raw, display=None):
        """Display name of the organisation behind `raw`: alias table first, then `display` (a preferred spelling of the
        same key, e.g. the most frequent mixed-case spelling) or the cleaned raw string."""
        k = self.key(raw)
        a = self.alias(k)
        if a:
            return a
        a = self.raw_alias(raw)
        if a:
            return a
        return display or nice(self.clean(raw))

    def _is_person_pair(self, a, b):
        """'Peyman; Gholam A.': a surname, then given names (an initial or plain words), no organisation words."""
        ta, tb = a.split(), b.split()
        if not (1 <= len(ta) <= 2 and 1 <= len(tb) <= 3) or _ORGWORD.search(a) or _ORGWORD.search(b):
            return False
        if self.is_non_owner(a) or self.is_non_owner(b):
            return False
        if not all(re.fullmatch(r"[^\W\d_][\w'.-]*", t) for t in ta + tb):
            return False
        return any(re.fullmatch(r"[A-Z]\.?", t) or re.fullmatch(r"[A-Z]\.[A-Z]\.?", t) for t in tb)

    def parties(self, raw):
        """One raw assignee string -> list of cleaned party strings: HTML entities decoded, split on ';'.
        A two-part string that reads 'Surname; Given name' stays one party."""
        s = html.unescape(html.unescape(str(raw or "")))
        parts = [p.strip(" ,") for p in s.split(";")]
        parts = [p for p in parts if p]
        if len(parts) == 2 and self._is_person_pair(parts[0], parts[1]):
            return [parts[0] + "; " + parts[1]]
        return parts

    def first_owner_party(self, names):
        """First owner party (a cleaned raw string, not yet canonical) over all names and their ';' parts, or None."""
        for n in names or []:
            for p in self.parties(n):
                if p and not self.is_non_owner(p) and self.key(p):
                    return p
        return None

    def first_owner(self, names):
        """First assignee party that is an owner (not a bank / agent) -> canonical name, or None."""
        p = self.first_owner_party(names)
        return self.canonical(p) if p else None


_UP = {"llc", "lp", "llp", "nv", "bv", "sa", "ag", "se", "kk", "usa", "uk", "us", "mit", "ucla", "nih", "cnrs", "gmbh", "kgaa", "pty", "ltd", "plc", "ab", "oy", "as",
       "spa", "srl", "ii", "iii", "iv", "vi", "vii", "viii", "ix", "csiro", "inra", "inserm", "basf", "dsm", "bms", "gsk", "tno", "kg", "r&d", "rd", "ibm", "3m", "ge", "ucb", "aim", "cdc", "ut", "md"}
_LOWER = {"of", "the", "and", "de", "la", "le", "du", "des", "for", "und", "et"}


def nice(name):
    """ALL CAPS / mixed spellings -> readable: an all-caps name is title-cased (small words and legal forms kept);
    a mixed-case name is returned as is."""
    if not name:
        return name
    letters = [c for c in name if c.isalpha()]
    if letters and not all(c.isupper() for c in letters):
        return name
    out = []
    for i, w in enumerate(name.split(" ")):
        lw = w.lower().strip(".,;")
        if lw in _UP and len(lw) <= 5:
            out.append(w.upper() if lw not in ("ltd", "gmbh", "pty", "plc") else (w.capitalize() if lw != "gmbh" else "GmbH"))
        elif lw in _LOWER and i > 0:
            out.append(lw)
        elif "'" in w or "-" in w:
            out.append("-".join(p.capitalize() for p in w.lower().split("-")))
        else:
            out.append(w.capitalize())
    return " ".join(out)
