"""Central configuration of the LNP FTO pipeline: paths, snapshot, CPC lists, fetch rules, pacing.

Import as `import config` or `from config import DATA, CACHE_EP, ...` (scripts put pipeline/ on sys.path).
Stdlib only.  The data directory can be moved with the environment variable LNP_DATA; the committed
seed files always live in <repo>/data/seed.
"""
import json
import os

# ----------------------------------------------------------------------------- paths
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("LNP_DATA") or os.path.join(ROOT, "data")
SEED = os.path.join(ROOT, "data", "seed")          # committed, not under LNP_DATA
PROBE = os.path.join(DATA, "probe")
CACHE = os.path.join(DATA, "cache")
CACHE_EP = os.path.join(CACHE, "ep")               # <fetch_id>.xml     e.g. EP3532103NWB1.xml
CACHE_US = os.path.join(CACHE, "us")               # <guid>.json        e.g. US-8058069-B2.json
CACHE_DISC = os.path.join(CACHE, "disc")           # raw discovery responses
CACHE_DISC_EPO = os.path.join(CACHE_DISC, "epo")   # SPARQL + Publication Server search responses
WORK = os.path.join(DATA, "work")
LOGS = os.path.join(DATA, "logs")
DIST = os.path.join(ROOT, "dist")

TARGETS = os.path.join(WORK, "targets.parquet")
US_DISCOVERY = os.path.join(WORK, "us_discovery.parquet")
DISCOVER_SUMMARY = os.path.join(WORK, "discover_summary.json")
FETCH_EP_LOG = os.path.join(WORK, "fetch_ep.jsonl")
FETCH_US_LOG = os.path.join(WORK, "fetch_us.jsonl")

SEED_FAMILIES = os.path.join(SEED, "seed_families.json")
SEED_CPC_FIELD = os.path.join(SEED, "cpc_field.json")
SEED_ASSIGNEES = os.path.join(SEED, "assignee_variants.json")

# ----------------------------------------------------------------------------- SureChEMBL
SURECHEMBL_SNAPSHOT = "2026-11-03"                 # release the subset was cut from (CC BY 4.0)
SURECHEMBL_DIR = os.path.join(PROBE, "surechembl", "out")
SURECHEMBL_PATENTS = os.path.join(SURECHEMBL_DIR, "patents_subset.parquet")

# ----------------------------------------------------------------------------- CPC field
# Mixer / microfluidics codes: listed as core in the seed file but far too broad on their own;
# they only count together with an LNP keyword ("context: needs LNP keyword").
CPC_MIXER_CONTEXT = ["B01F33/30", "B01F25/4331", "B01F25/4317", "B01L3/5027"]


def _load_cpc_field():
    try:
        with open(SEED_CPC_FIELD, encoding="utf-8") as f:
            field = json.load(f)
    except OSError:
        return [], []
    core = [x["cpc"] for x in field if x.get("role") == "core" and x["cpc"] not in CPC_MIXER_CONTEXT]
    context = [x["cpc"] for x in field if x.get("role") != "core"] + CPC_MIXER_CONTEXT
    return core, context


CPC_CORE, CPC_CONTEXT = _load_cpc_field()          # 39 core, 16 context (12 from the seed file + 4 mixers)

# Lipid-specific classes: third priority band (after seed tier 1 and seed tier 2).
CPC_LIPID_SPECIFIC = ["C07C229/12", "C07C229/16", "C07C219/06", "C07C235/06", "C07C271/20", "C07D295/13",
                      "A61K47/18", "A61K47/543", "A61K47/544", "A61K9/5123", "A61K9/1272"]

# EPO Publication Server IPC search.
# (a) exact IPC symbols used for *discovery* of B publications (source `epo_ipc`): the field-specific
#     groups only -- the broad excipient groups (A61K47/10, /14, /22, /60, A61K9/19) are covered by CPC.
EPO_IPC_DISCOVERY = ["A61K9/127", "A61K9/51", "C12N15/88", "A61K47/18", "A61K47/24", "A61K47/28",
                     "A61K47/54", "A61K47/69", "A61K48/00", "C07C229/12", "C07C229/16", "C07C219/06",
                     "C07C235/06", "C07C271/20", "C07D295/13", "B82Y5/00"]
# (b) IPC main groups searched as a *lookup index only* (kind codes, correction codes, file sizes of
#     numbers already known): B kinds for all years, A kinds from FETCH_EP_A_MIN_FILING_YEAR on.
EPO_IPC_INDEX_GROUPS = ["A61K9", "A61K47", "A61K48", "C12N15", "C07C229", "C07C219", "C07C235", "C07C271",
                        "C07D295", "B82Y5", "B01J13", "B01F33", "B01F25", "B01F23", "B01L3"]
EPO_B_KINDS = ["B1", "B2", "B3", "B8", "B9"]
EPO_A_KINDS = ["A1", "A2", "A8", "A9"]
EPO_SEARCH_PAGE_SIZE = 2000                        # accepted by the backend; size=1 timed out (504)
EPO_SPARQL_BATCH = 150                             # publication numbers per VALUES lookup

# ----------------------------------------------------------------------------- fetch rules
FETCH_EP_B_KINDS = ("B1", "B2", "B3", "B9")        # full specifications; B8 is a corrected front page
FETCH_EP_A_KINDS = ("A1", "A2", "A9")              # A3 = search report only, A8 = corrected front page
FETCH_EP_A_MIN_FILING_YEAR = 2017                  # A publication only if no B and filed >= this year
EP_A_FULLTEXT_MIN_XML_BYTES = 20000                # Euro-PCT stubs are ~5-15 kB of biblio
EP_A_FULLTEXT_MIN_PDF_PAGES = 3                    # used when the search record has no xmlFileSize
FETCH_US_PREGRANT_MIN_PUB_YEAR = 2018              # pre-grant only if no grant and published >= this year
US_GRANT_KINDS = ("A", "B1", "B2", "E", "E1", "E2")  # 7/8-digit or RE numbers  -> ppubs source USPAT
US_PREGRANT_KINDS = ("A1", "A2", "A9")             # 11-digit numbers          -> ppubs source US-PGPUB

# priority bands (higher = fetch earlier); recency is added as a fraction < 1
BAND_SEED_T1, BAND_SEED_T2, BAND_LIPID, BAND_CORE, BAND_CONTEXT = 5, 4, 3, 2, 1

# ----------------------------------------------------------------------------- polite fetching
USER_AGENT = "Mozilla/5.0"                         # generic; nothing identifying goes into a request
MIN_INTERVAL_S = 1.1                               # per host, sequential
HTTP_TIMEOUT_S = 120
BACKOFF_BASE_S = 5                                 # 5, 10, 20, 40, ... on 429/403/5xx/network errors
BACKOFF_MAX_S = 300
HTTP_RETRIES = 4
MAX_CONSECUTIVE_FAILURES = 20
PROGRESS_EVERY = 100

EPO_PUBSERVER = "https://data.epo.org/publication-server"
EPO_PUBSERVER_REST = EPO_PUBSERVER + "/rest/v1.2"
EPO_SPARQL = "https://data.epo.org/linked-data/query"


def ensure_dirs():
    for d in (CACHE_EP, CACHE_US, CACHE_DISC, CACHE_DISC_EPO, WORK, LOGS):
        os.makedirs(d, exist_ok=True)
