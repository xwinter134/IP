# LNP FTO — architecture

Private, single-user freedom-to-operate pre-screening tool for lipid nanoparticles
(LNP) and ionizable lipids. No API keys are required; two optional keys (EPO OPS,
USPTO ODP) can later improve legal status.

## Shape

```
pipeline/  offline build (Python 3.13 + Node 22)      -> data/ (ignored) -> dist/ (ignored)
web/       static single-page app (no backend)        -> copied into dist/
dist/      what is published as a private claude.ai Artifact (page + data files)
```

The page is static. Search (text and chemical structure) runs in the browser, so
queries never leave the machine. Only the FTO analysis sends text to Claude, through
the Artifact `sample` capability. Saved work lives in the Artifact `db` capability.

## Data sources (all key-free)

| Purpose | Source |
|---|---|
| Field discovery + compounds | SureChEMBL bulk (CC BY 4.0), snapshot pinned in `pipeline/config.py` |
| EP discovery by CPC | EPO Linked Open EP Data SPARQL, Publication Server search backend |
| EP full text | EPO Publication Server REST `document.xml` |
| EP legal status | EP Register ST.36 public snapshot (BDDS product 16) + lapse lists in B2/B3 XML |
| US discovery + full text + PTA | USPTO Patent Public Search JSON API (ppubs) |
| Key families (must-hit set) | `data/seed/seed_families.json` (verified by fetch) |

Google Patents and Lens are not used for bulk (throttled / terms). WO pamphlets have
no key-free bulk full text; WO publications are carried as biblio + compounds only and
the EP/US family member supplies the claims.

## Directories under `data/` (git-ignored except `data/seed/`)

```
data/seed/                 committed: seed families, CPC field, assignee variants, reference lipids
data/probe/                probe output incl. SureChEMBL subset (data/probe/surechembl/out/*.parquet)
data/cache/ep/<ID>.xml     raw EPO XML, ID like EP3532103NWB1
data/cache/us/<GUID>.json.gz  raw ppubs full-text JSON (gzip), GUID like US-8058069-B2
data/cache/disc/           raw discovery responses (SPARQL, ppubs search pages)
data/work/targets.parquet  one row per publication known to the tool (see below)
data/work/fetch_ep.jsonl   fetch log (append-only): {id, ok, bytes, ts, err}
data/work/fetch_us.jsonl
data/logs/
```

## `data/work/targets.parquet` (written by `pipeline/discover.py`)

One row per publication. Columns:

| column | type | notes |
|---|---|---|
| `pn` | str | canonical `CC` + number + kind, no separators: `EP3532103B1`, `US8058069B2`, `US20170210697A1`, `WO2017075531A1` |
| `auth` | str | `EP` / `US` / `WO` |
| `kind` | str | |
| `pub_date` | date | |
| `family_id` | int64 / null | DOCDB simple family from SureChEMBL where known |
| `app_number` | str / null | EP: 8 digits; US: as given by ppubs |
| `title` | str / null | |
| `assignees` | list[str] | raw |
| `cpc` | list[str] | normalised without blanks: `A61K9/5123` |
| `tier` | int | SureChEMBL tier 1-4, 5 = found only by EPO/USPTO discovery, 0 = seed only |
| `sources` | list[str] | subset of `surechembl`, `epo_sparql`, `epo_ipc`, `ppubs`, `seed` |
| `seed_family` | str / null | `family_id` field of the seed record |
| `seed_tier` | int / null | |
| `fetch` | bool | full text wanted |
| `fetch_id` | str / null | EP: publication-server id of the latest B (or full-text A); US: ppubs guid |
| `fetch_source` | str / null | `epo` / `USPAT` / `US-PGPUB` |
| `priority` | float | higher = fetch earlier |

Rules for `fetch`:
- EP: the latest B publication (B1/B2/B3/B9) of each EP application; if no B exists
  and the application was filed 2017 or later, the A publication when it has full text
  (Euro-PCT stubs are skipped).
- US: every grant; a pre-grant publication only when the same application has no
  grant and it was published 2018 or later.
- WO: never (biblio + compounds only).

Priority: seed tier 1 > seed tier 2 > lipid-specific classes (C07C/C07D lipid amines,
A61K47/18, 47/543, 47/544, 9/5123, 9/1272) > other core > context; newer before older
within a band.

## Conventions

- Python: stdlib + `duckdb`, `pyarrow`, `lxml`. Run with `python3 pipeline/<script>.py`.
  Every script is resumable and idempotent, takes `--limit N` for a smoke run and logs
  progress every 100 items to stdout.
- Polite fetching: one host = one sequential stream, at least 1 s between requests,
  generic User-Agent, exponential backoff on 429/403/5xx, stop after 20 consecutive
  failures. Nothing that identifies the user or project goes into a request.
- Raw responses are cached before parsing, so parser changes never need a re-fetch.

## Stage 2: corpus, status, images

### `data/work/corpus.jsonl.gz` (written by `pipeline/normalize.py`)

One JSON object per publication in `targets.parquet` (all of them, with or without full
text), sorted by (main CPC, family, pn) so related patents sit in the same shards.

```
{
 "pn": "EP3532103B1", "auth": "EP", "kind": "B1",
 "family": 62025447 | null,            // DOCDB simple family; else synthetic negative id per application
 "app_number": "17800986", "app_date": "2017-10-26", "pub_date": "2025-12-03",
 "grant_date": "2025-12-03" | null, "priority_date": "2016-10-26" | null,
 "title": {"en": "...", "de": "..."},   // whichever exist
 "assignees": ["Acuitas Therapeutics Inc."],   // cleaned: proprietors for EP B, no banks/agents
 "player": "Acuitas" | null,            // from data/seed/assignee_variants.json regex
 "cpc": ["A61K9/5123", ...], "tier": 1, "seed_family": "ACU-2016" | null, "seed_tier": 1 | null,
 "text": true,                          // full text present
 "text_src": "epo-xml" | "ppubs" | null,
 "claims": {"en": [{"n":1,"t":"...","dep":[]}, ...], "de": [...]},   // French is dropped
 "has_chem_img": true,                  // an independent claim contains a [chem:...] placeholder
 "defs": ["paragraph", ...],            // definition paragraphs from the description, <= 8000 chars total
 "abstract": "..." | null,
 "wo": "WO2018081480A1" | null,
 "status": { ... } | null               // merged from data/work/status.jsonl.gz, see below
}
```

`defs` selection (implemented in `pipeline/lib/norm_text.py`): description paragraphs (a paragraph = one
line of the flattened description, leading "(31)" / "[0031]" numbers removed) that look like prose (letters >= 55%)
and contain a trigger. Tier A = defining phrases ("as used herein", "the term", "refers to", "is defined",
"im Sinne der", "bezeichnet", "bedeutet" ...), tier B = field vocabulary ("pKa", "mol %", "molar ratio",
"N/P", "cationic lipid", "ionizable"), tier C = weak words ("means", "alkyl"; paragraphs <= 600 chars).
Tiers are taken in that order, shortest first inside a tier, paragraphs cut at 1500 chars, until 8000 characters
are reached; the selection is written in document order. Biblio-only records have `defs: []`.

Notes on the record (stage 2 as built):
- One record per row of `targets.parquet`, plus one per cached document whose publication number has no row
  (none so far) and per seed member without a row (none so far). Sorted by (main CPC, family, pn).
- A patent table row exists per publication kind. When the fetched text is the B9/B2 of an application whose
  B1 is also a row (e.g. seed EP2350043B1 -> fetched EP2350043B9), the text sits on the B9/B2 record and the
  B1 record stays biblio-only (the claims may differ after opposition).
- `claims[lang][i]` = `{n, t, dep, img?}`; `img` (EP only) lists the image ids behind the `[chem]` placeholders
  of that claim (`imgb0095` for `imgb0095.tif`). `dep` for EP uses the cross-language consensus where
  en/de/fr agree in length. A claim that merely refers to another claim of a different category ("A composition
  comprising the compound of claim 1") has `dep` = [1], i.e. "independent" means "refers to no claim".
  `has_chem_img` = such an independent claim contains `[chem]` or `[STR]`. Cancelled US claims ("4-15.
  (canceled)") are dropped, numbers of the others are kept. French claims are dropped; an A document with
  French claims only has text = true and empty claims.
- `family` < 0 = synthetic (no DOCDB family): crc32 of the WO number when the record is linked to a WO through its
  PCT publication, else of the application number. `wo` = WO of the PCT publication when known, else the earliest
  WO row of the same DOCDB family; `A1` is assumed when the PCT publication has no row.
- `priority_date` = earliest priority claim, else filing date; `app_number` EP = 8 digits without check digit.
- Parse cache: `data/work/norm/{ep,us}/<file stem>.json.gz` + `data/work/norm/index.json` (file name, mtime,
  size, parser version `PARSER_VERSION` in `pipeline/lib/norm_doc.py`; bump it to force a reparse).
- `status` is taken from `data/work/status.jsonl.gz` when that file exists at normalize time, else null
  (`build_dist.py` prefers the status file over this copy). The fields are `code` and `text` (not `status_code`).
- `player`: the regex of `data/seed/assignee_variants.json`, with one restriction (`PlayerMatcher` in
  `pipeline/lib/norm_text.py`): the patterns that name a whole university system (`university of texas`,
  `british columbia`, also in the DOCDB forms `UNIV TEXAS`, `UNIV BRITISH COLUMBIA`) only count for publications inside
  the LNP field (tier 0-4 or a seed family), not for tier 5 context publications; the company names of the same player
  (Precision NanoSystems, ReCode Therapeutics) always count. Effect: "UT Southwestern / ReCode" 1,697 -> 707
  publications, "UBC (Cullis) / Precision NanoSystems" 494 -> 335. The UT label still covers every campus of the system.

### `data/work/status.jsonl.gz` (written by `pipeline/status.py`)

One object per publication that has status information:

```
{
 "pn": "EP3532103B1",
 "src": "ep-register" | "ep-xml" | "us-calc" | "seed",
 "asof": "2026-08-23",                  // snapshot date of the source
 "code": "granted" | "pending" | "lapsed" | "revoked" | "withdrawn" | "refused" | "expired" | "unknown",
 "text": "The patent has been granted",        // source wording
 "expiry_est": "2037-10-26",            // filing date + 20 years (+ PTA days for US); an estimate
 "pta_days": 153 | null,
 "lapsed_in": [{"cc":"DE","date":"2024-03-01"}],
 "in_force_de": true | false | null,    // EP: granted, not revoked, DE not in lapsed_in, not past expiry
 "opposition": {"filed": true, "opponents": ["..."], "outcome": "maintained_amended" | "revoked" | "rejected" | "pending" | null} | null,
 "appeal": true | false | null,
 "unitary": "registered" | "requested" | null,
 "fees_paid_years": [3,4,5,6,7,8,9],
 "last_fee_date": "2025-10-10" | null,
 "events": [{"date":"...","text":"..."}],      // at most 12, newest first
 "note": "..." | null                   // seed litigation note with its source tag, verbatim
}
```

Implementation notes (as built; `src` additionally takes `"pct"` for WO):

- WO records: `src:"pct"`, `code:"unknown"`, `text:"PCT publication (no rights; see national/regional members)"`, `in_force_de:false`, `expiry_est:null`.
- Extra optional fields (readers must ignore what they do not know): EP `filing`, `grant` (date of the B publication), `app`, `wo`, `applicant`, `status_code_num` (register code), `children` (divisional application numbers), `appeal_detail[{num,result,result_date}]`, `opposition.date_first_filed`, `opposition.note` (e.g. "all opponents withdrawn"; `outcome` is then null), `estimate` (text); US `filing`, `term_base` (earliest effective non-provisional filing date), `term_base_from_chain`, `terminal_disclaimer` (true | null: not visible in ppubs data), `chain`, `not_checked` (what the US estimate does not cover), `estimate`; any record with seed data: `seed:{family, gp_status, gp_expiry_event, gp_litigation[], gp_legal_events[], fetched}`.
- EP `code`: derived from the register status text; `expired` = granted and `expiry_est` before `asof`; `lapsed` = granted but every designated state is in `lapsed_in`. `in_force_de` is `true` only for granted patents with unitary effect registered, or DE designated and not in `lapsed_in`, and not expired; `false` for pending/revoked/refused/withdrawn; `null` for unknown status. `opposition.outcome`: `revoked` (revocation date / status), `maintained_amended` (B2 / maintained-as-amended date / interlocutory decision), `rejected`, `pending`.
- The register is a snapshot (`asof`, currently 2026-08-23): later events, and renewal fees that fell due after it, are not seen. `lapsed_in` lists contracting states recorded as lapsed in the register, not states where a fee is merely overdue.
- US `code`: `granted` for B/E/C kinds (text says maintenance fees are not checked), `expired` when the estimated term has ended, `pending` for A kinds without a granted sibling; an A publication whose application is known to be granted gets `granted` with "granted as USxxxB2". Seed Google-Patents statuses that show expiry/revocation override a computed `granted`/`pending` (`src:"seed"`), since maintenance-fee lapses are invisible to the calculation.
- Cache layout: `data/cache/register/index.json` (central directory of the 14.8 GB ZIP), `data/cache/register/rec/<chunk>.jsonl.gz` (extracted register records of target applications), `data/cache/register/manifest.json` (application numbers already looked up per chunk), `data/cache/status/us_meta.json` (per-file US metadata cache), `data/work/status_register.jsonl` (per-chunk fetch log), `data/work/status_summary.json` (coverage numbers of the last build).

### Claim formula images (`pipeline/fetch_ep_images.py`)

EP claims carry structure formulae only as TIFF images. For EP full-text documents whose
claims contain `[chem]` placeholders (corpus `claims[].img`, only publications with a cached XML), the
script reads `document.zip` by HTTP range requests (central directory + the referenced TIFF members; if the
server ignores Range and answers 200 with the whole file, that body is used; measured: about 1 in 4 zips is
served ranged, mean transfer 4 MB per document, zips are 1 to 49 MB, median 2.5 MB), converts the TIFFs to
PNG (trimmed, at most 900 px wide; 1-bit when no downscale is needed, else 2-bit grey; mean 3.8 kB) and stores
`data/work/img/<pn>/<imgid>.png`, `data/work/img/index.jsonl` (`{pn, img, claim, w, h, bytes}`, claim = first claim
citing the image) and `data/work/img/done.jsonl` (one line per processed document). Order: seed tier, tier,
newest first. Options: `--limit` (documents per run, default 150), `--max-hours`, `--budget-mb` (default 25),
`--max-per-doc` (default 60, lowest claim numbers first), `--interval` (default 3 s, sequential),
`--retry-failed`, `--pn`, `--dry-run`. Resumable (done.jsonl). US documents get no images in this version.

## Stage 3: `dist/` (written by `pipeline/build_dist.py`, text index by `pipeline/build_index.mjs`)

```
python3 pipeline/build_dist.py [--out dist] [--budget-mb 215] [--enc b64|bin] [--max-files 500] [--limit N]
                               [--defs-reserve-mb 10] [--img-budget-mb 25] [--img-dir DIR] [--no-chem] [--no-web] [--force]
                               [--corpus FILE] [--build-dir data/work/dist_build]
node tests/search_test.mjs [--work DIR] [--no-browser] [--perf DIST_DIR]      # builds its own dist copies in a temp dir
```

`build_dist.py` is safe to run at any time, also while the downloads and `normalize.py` are running: it reads the
corpus through a hard link taken at start (`data/work/dist_build/corpus.snap.jsonl.gz`), calls `build_index.mjs`
(streaming, two passes, about 1.5 GB RAM and 80 s for 1.1 M claims) only when corpus, keep list or builder changed, and
rewrites a file in `dist/` only when its content changed. `data/work/status.jsonl.gz`, `data/work/img/` and
`data/work/chem/` are optional. Work files: `data/work/dist_build/{keep.bin, cut.jsonl, model.json, dist_report_<enc>.json, idx_<enc>/}`.

```
File names below are the logical names. The Artifact host refuses `*.bin` files (learned from the first publish), so
the default build (`--enc b64`) writes every `x.bin` as base64 text `x.b64.txt`; `--enc bin` writes the raw files and is
for local tests only (`node tests/artifact_server.cjs --dist DIR --bin`).

dist/index.html                the page (web/ is copied as it is: index.html, app/, engine/, vendor/)
dist/app/*.js  dist/app/app.css  dist/app/views/*.js
dist/engine/*.js               engines (tok.js, loader.js, data.js, search.js, search-worker.js, chem*.js, ...)
dist/vendor/*.js               openchemlib-full.js 8.21.0, fflate.js 0.8.2 (gunzip fallback)
dist/data/manifest.json
dist/data/pat-NNN.gz.bin       patent table, columnar JSON chunks of 4000 patents
dist/data/st-NNN.gz.bin        status detail, JSON array per 4000 patents (null where none)
dist/data/meta.gz.bin          binary columns of the whole table for filters, facets, sorting (see below)
dist/data/pn.gz.bin            all publication numbers, one per line (line number = p)
dist/data/cpc.gz.bin           full CPC codes per patent for the cpc: filter
dist/data/idx/docs.gz.bin      unit table of the text index
dist/data/idx/p-NNN.gz.bin     postings shards (terms sorted, shard chosen by first term)
dist/data/idx/q-NNN.gz.bin     position shards (phrases, NEAR)
dist/data/idx/t-NNN.gz.bin     claim text shards (also abstract and German title)
dist/data/idx/lex.gz.bin       most frequent terms with document frequency (suggestions)
dist/data/df-NNN.gz.bin        definition paragraphs (own patent ranges, `manifest.df.start`)
dist/data/img-NNN.bin          claim image packs (PNG files back to back) + dist/data/img.json index
dist/data/chem/…               compounds, fingerprints, compound<->patent map: the files named in
                               data/work/chem/chem.json `publish` (see "Chemistry shards")
dist/data/seed.json            {families, players: [{name}], assignees, cpc, lipids} from data/seed/
dist/publish_batches.json      [{files:[...], bytes}] each <= 240 files and <= 60 MB, page and engines first
```

Limits of the host: each file <= 15 MB, at most 500 files and 240 MB in total (checked by the builder, which exits
non-zero when one is broken). `.gz.bin` files are gzip streams of the described payload; with `--enc b64` (the default)
every `*.bin` is written as base64 text `*.b64.txt` instead and `manifest.enc = "b64"` (a third larger than `--enc bin`,
so the budget cut bites earlier; build of 2026-11-10 18:35 UTC: 182.5 MB in 373 files, 4 publish batches, no cut). The status detail is taken from
`data/work/status.jsonl.gz` when it has a record for the publication (it is written after the corpus), else from the
corpus record. The engines read `manifest.enc` and handle both. No file name contains anything but
`[a-z0-9._-/]`.

`manifest.json`:
```
{"v":1,"built":"2026-11-10T12:00:00Z","enc":"b64",
 "snapshots":{"surechembl":"2026-11-03","ep_register":"2026-08-23","ep_text":"2026-11-10","us_text":"2026-11-10","corpus":"…Z"},
 "counts":{"patents":N,"fulltext":N,"fulltextAvailable":N,"claims":N,"compounds":N,"ep":N,"us":N,"wo":N,"families":N,
           "withStatus":N,"withDefs":N,"seed_expected":126,"seed_present":N,"seed_fulltext":N},
 "players":[names], "statusCodes":["","granted","pending","lapsed","revoked","withdrawn","refused","expired","unknown"], "kinds":[...],
 "pat":{"chunk":4000,"files":[...]}, "st":{"chunk":4000,"files":[...]},
 "meta":{"file":"meta.gz.bin"}, "pn":{"file":"pn.gz.bin"}, "cpc":{"file":"cpc.gz.bin"},
 "idx":{"v":3,"tok":1,"D":units,"P":patents,"nTerms":N,"k1":1.2,"b":0.75,"avg":{"claim","title","abstract","asg"},
        "docs":"docs.gz.bin","lex":"lex.gz.bin","post":[[file, firstTerm, bytes],...],"pos":[[file, firstTerm, bytes],...],
        "text":{"start":[first p per shard],"files":[[file, bytes],...]},"counts":{units, claims, claimsEn, claimsDe, indep, textPatents, abstracts, titleDe}},
 "df":{"start":[...],"files":[[file, bytes],...],"patents":N},
 "img":{"index":"img.json","packs":[...],"images":N,"patents":N,"cut":N} | null,
 "chem":{"dir":"chem/","files":[...],"n":N,"nPat":N,"snapshot":"…"} | null, "seed":"seed.json",
 "cut":{"applied":bool,"budgetMb":215,"defsReserveMb":10,"rule":"…","attempts":[…],
        "text":{"available","kept","cut","claimsCut","claimCharsCut"},"defs":{"available","kept","cut","cutDefsOnly"},
        "byTier":{"tier5":{"claims":n,"defs":n},…},"lastKept":{pn,tier,pub},"firstCut":{pn,tier,pub},"examples":[pn,…]},
 "flagBits":{"text":1,"defs":2,"chemImg":4,"compounds":8,"status":16,"textCut":32,"defsCut":64},
 "sizes":{"claim text":bytes,"postings":…,…}, "bytesPerClaim":n, "nFiles":n, "totalBytes":n,
 "files":{"data/pat-000.gz.bin":[bytes,"sha256"],…}}        // every file of dist except manifest.json and publish_batches.json
```
File names inside `pat`, `st`, `idx`, `df`, `img`, `chem` are relative to `data/` (`idx` files to `data/idx/`).

Patent table columns (per chunk, arrays of equal length; the patent index `p` is the
global row number = line number of `corpus.jsonl.gz`): `pn, auth, kind, pub (yyyymmdd int), app (int|0), prio (int|0),
grant (int|0), appNo, fam (int32; ids outside the int32 range are folded to -1,100,000,000 - id mod 1e9), title
(English, else German), asg (index into the chunk-local array asgNames; assignees joined with "; "),
player (index into manifest.players | -1), cpc ("A|B|C"), tier, seedTier (0 = none), seedFam,
flags (bit0 claims present, bit1 definitions, bit2 chem image in independent claim, bit3 has compounds,
bit4 has status, bit5 claims cut by the budget, bit6 definitions cut by the budget), st (index into
manifest.statusCodes), exp (yyyymmdd int|0), deIn (1 in force in DE, 0 not, 2 unknown), wo`.

Binary files (little endian):
- `meta.gz.bin`: `[u32 jsonLen][JSON {v, P, cols: [{name, type: i32|u32|u16|u8, off, n}], auth[], kinds[], st[], c4[]}][pad to 4][columns]`;
  columns `fam pub prio exp c4off c4 auth kind player(255 = none) tier seedTier flags st deIn`; `c4off/c4` = CPC subclass
  (4 characters) indexes per patent for the facet.
- `cpc.gz.bin`: `[u32 jsonLen][JSON {codes[] sorted, n, width}][pad][u32 off[P+1]][u16|u32 code index[n]]`.
- `idx/docs.gz.bin`: `[u32 D][u32 P][u32 first[P+1]][u16 len[D]][u16 claimNo[D]][u8 flag[D]]`. A unit is one searchable
  text; flag bit0 independent claim, bit1 German, bits 2-3 kind (0 claim, 1 title, 2 abstract, 3 assignee). Every patent
  has a title unit and an assignee unit, an abstract unit when there is one, a second title unit when a German title
  exists next to the English one, and one unit per claim and language.
- `idx/p-NNN.gz.bin`: `[u32 dictLen][JSON {t: terms, d: df, o: offsets}][varint (unit delta - 1, tf) ...]`;
  `idx/q-NNN.gz.bin`: `[u32 dictLen][JSON {t, o}][per posting: tf position deltas as varints]`.
- `idx/t-NNN.gz.bin`, `df-NNN.gz.bin`: block container `[u32 n][u32 p[n]][u32 off[n+1]][n JSON blocks]`; text block =
  `{"c": [[n, flags, dep[], text, img[]?], ...], "a": abstract|0, "td": German title|0}`, definition block = array of
  paragraphs. The browser keeps the inflated bytes and parses one block on demand.
- `img.json`: `{v, p: [patent indexes], e: [[[claim, imgId, w, h, pack, offset, bytes], ...], ...]}`.

Tokenizer (`web/engine/tok.js`, shared by build and browser, `idx.tok` = its version): NFKD, combining marks removed,
lower case, sharp s -> ss, tokens `[a-z0-9]+`; English and German stop words and tokens over 40 characters are not
indexed but keep their position. Ranking: BM25 (k1 1.2, b 0.75, average length per field) per unit, weight 1.3 for
independent claims, 1.6 title, 0.9 abstract; patent score = best unit + 0.1 x the other matching units (capped at
2 x best).

Size budget (`--budget-mb`, default 215, hard limit 240): the fixed parts (page, chemistry, patent table, status,
images) are measured first; the rest goes to the text index. When the available full text does not fit, publications
are ranked by (seed tier, tier 0..5, newest first) and
1. seed-family publications keep claims and definitions,
2. claims are kept along that order as far as the budget minus `--defs-reserve-mb` reaches,
3. definition paragraphs are kept along the same order (only for publications that kept their claims),
4. what is left goes back to the claims.
A publication that loses its claims stays in the patent table (title / abstract / assignee search, status, compounds)
with flag bit5; one that loses only its definitions gets bit6. The builder fits a small size model (bytes per claim
character / definition character), rebuilds the index until it lands within 3 % under the budget (usually 2 runs),
logs the cut per tier, writes `data/work/dist_build/cut.jsonl` and records it in `manifest.cut` for the UI.
Measured (tests/search_test.mjs, 2026-11-10): real corpus 4,116 full texts / 110,546 claims: 58 MB, 166 files,
170 bytes per claim (postings 52 + positions 46 + text 66 + docs 6), no cut. Synthetic full scale (125,104
publications, 50,000 full texts, 1.34 M claims): 214.7 MB in 474 files, 150 bytes per claim, 42,678 full texts kept
(7,322 oldest tier 5 cut), definitions for 5,248 publications.

## Chemistry shards (`pipeline/chem_build.cjs` -> `data/work/chem/`, copied to `dist/data/chem/`)

`node pipeline/chem_build.cjs [--threads 3] [--limit N] [--no-export] [--out DIR]`
1. `pipeline/chem_export.py` (DuckDB) writes TSV under `data/work/chem/_in/`: the `lipid_candidate` rows of
   `compounds_subset.parquet`, and `lipid_candidate_map.parquet` joined to `targets.parquet` on the publication
   number without dashes (`WO-2017075531-A1` = `WO2017075531A1`). Publications not in `targets.parquet` are dropped.
2. Per compound, with the vendored OpenChemLib and `web/engine/chemfp.js`: idcode (parsed with coordinates, so E/Z
   and R/S are kept), FFP512, count fingerprint, descriptors, scaffold key, stereo-free hash, MW, cLogP. Cached in
   `data/work/chem/_cache/calc-v<ChemFP.VERSION>.jsonl` by compound id + SMILES hash: a re-run computes only new or
   changed compounds (cold 85k compounds: about 6 min on 3 threads; cached: 7 s). Output is deterministic.
3. Compounds with the same idcode are merged; rows are ordered by scaffold key, then MW. `names.json` is built from
   `data/seed/ref_lipids_pubchem.json` plus `pipeline/chem_names.cjs` (synonyms, roles; an entry with its own `smiles`
   adds a reference lipid that is not in the seed file: ALC-0159 as a surrogate with the PEG chain cut to one unit, DOPC).
   20 reference lipids; cholesterol resolves by name to its structure but is not in the compound set (`c: -1`).

Files (`*.gz.bin` = gzip of the payload, little endian; `_in/` and `_cache/` are not published):

| file | payload |
|---|---|
| `chem.json` | `{v, built, snapshot, ocl, fpVersion, n, nPat, nLinks, nScaf, files: {idc|ffp|fp|desc|scaf|map|pat: {file, bytes, raw}}, names, publish: [file names], cols: [{name, type, off}], heads[], where: {clm:1, desc:2, abs:4, ttl:8, img:16, mol:32}, stats}` |
| `idc.gz.bin` | OCL idcodes, one per line (line number = compound index `c`) |
| `ffp.gz.bin` | Int32 x 16 per compound (FFP512 substructure pre-screen) |
| `fp.gz.bin` | `[u32 n][u32 total][u32 off[n+1]][u16 packed[total]]`, packed = feature id (12 bit) << 4 or count (max 15), ascending |
| `desc.gz.bin` | descriptor columns back to back, each padded to 4 bytes; name, type (`u8 u16 i16 u32 f32`) and offset in `chem.json` `cols`: `id` (SCHEMBL number), `mw`, `logp` (x100), `ns` (hash of the stereo-free idcode), `scaf` (scaffold index), `nPat`, `nFam`, `nClm`, `nPatG`, `wbits`, element and nitrogen-class counts, linker counts, `head`, `nTails`, `nEnds`, `tailC`, `tailDbl`, `nBranched`, `spacer`, `flags`, `t0..t5` (tail carbons), `u0..u5` (bits 0-3 double bonds, 4 branched, 5 ring, 6 acyl, 7 triple), `b0..b5` (branch position) |
| `scaf.gz.bin` | scaffold idcodes, one per line, sorted (line number = `scaf`) |
| `map.gz.bin` | compound -> publications: `[u32 n][u32 links][u32 off[n+1]][u32 entry[links]]`, entry = publication index << 8 or where bits |
| `pat.gz.bin` | JSON `{pn: [...], fam: [...]}`: the publications of the chemistry set (publication index = position), `pn` as in `targets.parquet` |
| `names.json` | reference lipids `[{name, synonyms[], role, note, smiles, cid, inchikey, idcode, c, variants[]}]` |

The publication -> compounds map is the inverse of `map.gz.bin`; the browser builds it on first use (about 1 M
entries, a few ms) instead of shipping it twice. The chemistry set carries its own publication numbers, so it does
not depend on the patent index `p` of `corpus.jsonl.gz`; `LnpChem` maps `pn` to `p` at run time. `build_dist.py`
copies the `publish` files unchanged (base64 variant: `x.gz.bin` -> `x.gz.b64.txt`, `chem.json` and `names.json`
stay JSON) and may set patent flag bit3 from `pat.gz.bin`. Current build: 84,691 compounds, 33,258 publications,
1,061,376 links, 18.8 MB in 9 files (largest `fp.gz.bin` 10.2 MB).

## Extra data (xdata)

Optional datasets that a pipeline step (outside `build_dist.py`) writes next to the chemistry build and that engines
`web/engine/x-*.js` read. `build_dist.py` knows nothing about their content, only about the directory layout.

```
data/work/xdata/<name>/xdata.json   {name, v, built, target: "both" | "pages", files: [names], files_pages?: [names], counts: {...}, notes}
data/work/xdata/<name>/<file>       each listed file: *.gz.bin (gzip payload) or *.json; at most 3 files per dataset, names [a-z0-9._-]
```

`python3 -I pipeline/build_dist.py [--xdata-dir data/work/xdata] [--target artifact|pages]` copies every dataset to
`dist/data/x/<name>/<file>`: `x.gz.bin` becomes `x.gz.b64.txt` with `--enc b64` and stays `x.gz.bin` with `--enc bin`,
`*.json` is copied as it is. With the default `--target artifact` only datasets with `target: "both"` are used and only
their `files`; `--target pages` (passed by `pipeline/build_pages.sh`) adds datasets with `target: "pages"` and the
`files_pages` of every dataset (for example long quotes that do not fit the Artifact budget). The bytes of all xdata
files (after base64) are counted with the fixed parts before the text budget is computed, so the text cut absorbs them,
and are reported as `manifest.sizes.xdata`. Files count towards `manifest.files`, the publish batches (rank after the
patent table, before the text index), the 500-file and the 15 MB-per-file limits; a missing listed file, an unreadable
`xdata.json`, more than 3 files or a bad name stops the build.

`manifest.x` exists only when at least one dataset was included:

```
"x": {"<name>": {"v": <xdata v>, "built": "<xdata built>", "files": {"<logical file name>": <bytes on disk>}, "counts": {...}}}
```

The file names in `files` are the logical names (`tags.gz.bin`), the sizes are those of the published files (base64
included). Engines read `LnpData.manifest.x && LnpData.manifest.x[name]`; a missing entry means "not in this build" and
the feature says so. They fetch with `LnpLoader.create({base: LnpData.base() + 'x/' + name + '/', enc: LnpData.manifest.enc})`
and `get('<file>.gz.bin', {as: 'bin' | 'json'})`; the loader maps `.gz.bin` to `.gz.b64.txt` itself.

Datasets so far (`docs/TOOLS_PLAN.md` 2.4, 2.5): `ranges` (`pipeline/ranges_build.py`), `markush` (`pipeline/markush_seed.py`) and
`tags` (`pipeline/tags_build.py`: tags, legal bits and canonical assignee per patent index `p`, format `tg-1`, rules in
`data/seed/tag_rules.json` and `data/seed/assignee_aliases.json`, engine `LnpTags`). Datasets indexed by `p` record the
corpus snapshot they were built from (`counts.snapshot`, `counts.patents`) so that the engine can warn when the dist was
built from another corpus file. `pipeline/run_all.sh` runs the three steps (each only when its script exists) before
`build_dist.py`.

Assignee normalisation (`pipeline/lib/asg_norm.py`): a raw string may hold several `;`-separated parties (split before the
first-owner and non-owner logic; `Surname; Given A.` stays one person); HTML entities are decoded; `X University` and
`University of X` are one key only for the X listed in `university_prefix_merge` (Washington University and the University of
Washington stay apart; DOCDB `UNIV X` = `University of X`); `raw_regex` aliases split a key that is too short (Merck & Co.
vs Merck S.A.). `LnpTags` assignee facet values are `asg:<slug>` (slug of the canonical name), stable across rebuilds;
`registerFacets` appends "(stale snapshot)" to the facet titles and sets `note` when `info().mismatch` is set. The vaccine
tag is "Vaccine / infectious disease": any vaccine term or infectious-disease name, cancer vaccines included.

## Browser engines (all in `web/engine/`, plain scripts, ASCII only, no build step)

Every engine works in three modes and picks the first that works: dedicated Worker from
its own file, Worker from a `blob:` URL built from the same source, main thread. Gzip is
inflated with `DecompressionStream` when present, else with the bundled fflate. Nothing
is fetched from another origin. All functions return promises. Claim text, titles and
names are untrusted input: the UI inserts them with `textContent`, never as HTML.

### `LnpLoader` (`engine/loader.js`)
- `LnpLoader.create({base, enc: "auto"|"bin"|"b64", gzip: "auto"|"fflate", vendorUrl, cacheBytes, sizes, onProgress, fetch})`
  -> `{get(name, {as: "bin"|"json"|"text", cache}), bin, json, text, on(fn), setEnc, setSizes, url(name), diag()}`.
  `get("x.gz.bin")` fetches `x.gz.bin` (or `x.gz.b64.txt`), inflates it and resolves to an `ArrayBuffer`; results sit in
  an LRU cache (by bytes); concurrent requests for one file share one fetch. Progress events
  `{type: "start"|"progress"|"done"|"error", name, loaded, total, active}`. Errors are plain objects
  `{code: "http"|"network"|"gzip"|"no_gzip"|"b64"|"parse", message, name, url, status}`.
- `LnpLoader.spawn({name, file, sources, timeoutMs, modes})` starts a Worker from a file or from a `blob:` URL and
  checks that it answers; `LnpLoader.gunzip(bytes)`.

### `LnpData` (`engine/data.js`; needs `loader.js`, `tok.js`)
- `LnpData.init(base = "data/")` or `init({base, mode: "auto"|"worker"|"blob"|"main", gzip, engineBase, vendorUrl, timeoutMs})`
  -> manifest; loads `seed.json`; patent chunks load lazily. Fetch + inflate run in a loader Worker when possible.
- `LnpData.manifest`, `LnpData.seed`
- `LnpData.patent(p)` -> `{p, pn, auth, kind, pub, app, prio, grant, appNo, fam, title, assignee, player, playerIdx, cpc[], tier, seedTier, seedFam, text, hasDefs, hasImg, hasCompounds, hasStatus, textCut, defsCut, status, exp, deIn, wo}`
  (`status` = status code string; `textCut` / `defsCut` = removed by the size budget); rejects with `{code: "range"}`.
- `LnpData.patents(ps[])` -> array of the same
- `LnpData.byPn("EP3532103B1" | "EP 3 532 103 B1" | "US 8,058,069" | "US 2017/0210697 A1" | "WO2017/075531" | "WO 17/075531")` -> p | -1.
  Tolerant of blanks, commas, dots, slashes, dashes, lower case, a missing kind code and a missing country (EP and US
  are tried). Without a kind code the best publication of that number is returned: full text first, then B kinds, then
  the newest. A B / C / E kind that has no claim text of its own leads to the later publication of the same number that
  has it (seed EP2350043B1 -> EP2350043B9, EP3394030B1 -> EP3394030B2; the patent view says so); `byPn(input, {exact: true})`
  returns the record that was asked for. `LnpData.textSibling(p)` -> p of that publication | -1.
  `LnpData.allPn(input)` -> p[] (every kind of the number). The parser is `LnpTok.pn(input)`.
- `LnpData.family(p)` -> p[] (all members in the table)
- `LnpData.status(p)` -> status detail object | null
- `LnpData.all()` -> columnar view of the whole table `{n, pn[], auth[], kind[], title[], assignee[], cpc[] ("A|B"), wo[], appNo[], seedFam[], pub, app, prio, grant, exp, fam (Int32Array), player (Int16Array), tier, seedTier, flags, st, deIn (Uint8Array), players[], statusCodes[]}` (loads every chunk; used by landscape and filters)
- `LnpData.meta()` -> the binary columns only (one 2.8 MB file instead of every chunk); `LnpData.metaBuffer()` -> the
  inflated file itself. The parsed-chunk cache holds the whole table (32 chunks now), so `all()` and row reads never
  download a chunk twice.
- `LnpData.links(p | patentObject)` -> `{espacenet, google, register|null, uspto|null}` URLs; `LnpData.linksOf(patentObject)` is synchronous
- `LnpData.diag()` -> `{mode: "worker"|"blob"|"main", gzip: "native"|"fflate", enc, tried[], patents, fetches, bytes}`
- `LnpData.onProgress(fn)`, `LnpData.reset()`

### `LnpSearch` (`engine/search.js` page side + `engine/search-worker.js` core + `engine/tok.js` + `engine/loader.js`)
`search-worker.js` is the search core (`LnpSearchCore`): it runs as a dedicated Worker from its own file, inside a
`blob:` Worker (tok.js + loader.js + search-worker.js concatenated) or on the main thread; it also loads in Node
(tests). It reads `meta.gz.bin` itself, so it does not depend on `LnpData`.
- `LnpSearch.init({base = "data/", mode: "auto"|"worker"|"blob"|"main", gzip, engineBase, vendorUrl, timeoutMs})`
  -> `{mode, D, P, terms, claims, ms, gzip, enc, tried[]}` (lazy: every call below runs it on first use). When `LnpData`
  is already initialised on the same `base`, the manifest and the meta file are taken from it (`share: false` switches
  that off), so the boot downloads each once. `lowMemory` (default: `navigator.deviceMemory` <= 4 or a phone) halves the
  caches of the core; `diag().lowMemory` reports it.
- `LnpSearch.search(query, opts)` -> `{total, hits, facets, parsed, ms, timing, totalFamilies?, all?}`
  - `query`: implicit AND, `AND`, `OR`, `NOT` / `-x`, parentheses, `"exact phrase"` (stop words inside keep their
    place), `prefix*` (2 characters at least), `a NEAR/n b` (default n = 5; operands: words, phrases, prefixes, OR groups,
    NEAR groups), a word with separators (`C12-200`, `DLin-MC3-DMA`) = phrase.
    Text fields, also as groups `title:(a OR b)`: `claims:` `indep:` `dep:` `title:` `abstract:` `asg:` (a bare word
    in `asg:` matches the beginning of a name token); `same:(...)` = all conditions inside one claim.
    Metadata: `cpc:A61K9/51` (prefix; `|` or `,` separated lists), `auth:` `kind:` `year:2015-2022` (`2019`, `2021-`,
    `-2010`), `prio:` `exp:` (years), `player:` `pn:"EP 3 532 103"` `fam:` `tier:` `seed:1` `seedtier:` `status:granted`
    `text:1` `inforce:1` `compounds:1`. Switches: `lang:de|en`, `indep:1` (independent claims only), `scope:claim`.
    A bare word searches claims, title and abstract (not the assignee). Boolean operators combine on the level of the
    PATENT (terms may sit in different claims); phrases and NEAR always match inside one claim / title / abstract.
    `opts.scope = "claim"` (or `same:`) makes AND / NOT work inside one claim.
  - `opts`: `{filters: {auth[], kinds[], yearFrom, yearTo, prioFrom, prioTo, cpc[], players[] (names or indexes), status[], tiers[], seedTiers[], indepOnly, lang, textOnly, hasCompounds, hasImg, deInForce, expAfter (yyyymmdd), seedOnly, asg (query text), pn[], fam, ps (restrict to patent indexes)}, limit=25, offset=0, sort: "score"|"date"|"expiry", group: "family", facets: true, snippets: true, perHit: 3, snippetLength: 280, scope: "patent"|"claim", all: false}`
  - `hits[i]` = `{p, score, n (matching claims), fam, best: {n, lang, indep, field: "claim"|"title"|"abstract"|"assignee", score, snippet: [[text, isMatch], ...]}, top: [up to perHit best units, same shape]}`;
    with `group: "family"` one hit per family (best member) plus `members: p[]`, `nMembers`, and `totalFamilies` on the result.
  - `facets` = `{auth:{EP:n,..}, year:{2019:n,..}, player:{..}, status:{..}, tier:{..}, seedTier:{..}, kind:{..}, cpc4:{A61K:n,..}, text: n, deInForce: n}` over the full result set
  - `parsed` = `{query, ast, unit, warnings: [{code, message}]}` (pass it to `highlight`); `all: true` adds `all: Uint32Array` of every matching p.
  - An empty query with filters lists the filtered patents (sorted by date).
- `LnpSearch.claims(p, lang?)` -> `[{n, lang, indep, dep[], text, children[], roots[], img?[]}]` (all languages if `lang` omitted;
  `children` = claims that refer to this one, `roots` = the independent claims it finally depends on)
- `LnpSearch.abstract(p)` -> string | null
- `LnpSearch.highlight(text, parsed | queryString)` -> `[[text, isMatch], ...]` (pieces concatenate to `text`; one span per occurrence, a phrase is one span)
- `LnpSearch.snippets(ps[], parsed)` -> hits with best units for patents outside the current page
- `LnpSearch.defs(p)` -> string[]
- `LnpSearch.claimImages(p)` -> `[{claim, id, w, h, blob}]` (PNG blobs; empty if none)
- `LnpSearch.suggest(prefix, k = 10)` -> `[{term, df}]` index terms completing the last word, most frequent first
- `LnpSearch.parse(query)`, `LnpSearch.diag()`, `LnpSearch.onProgress(fn)`, `LnpSearch.reset()`
- Measured on the synthetic full-scale index (1.14 M claims, Chromium, local server): init about 100 ms, first query
  on a fresh engine 150-450 ms, warm 3-50 ms.

### `LnpChem` (`engine/chem.js` + `engine/chem-worker.js` + `engine/chemfp.js` + `vendor/openchemlib-full.js`)
Pure JS (OpenChemLib 8.21.0 UMD, no wasm, no eval). `chem-worker.js` is the search core: it runs as a dedicated
Worker, inside a `blob:` Worker (OpenChemLib + chemfp.js + chem-worker.js concatenated) or on the main thread.
Substructure search is spread over up to 4 workers (`navigator.hardwareConcurrency`), which join in the background
after `init`. `chemfp.js` (count fingerprint, lipid descriptors, scaffold) is shared with the offline build.

- `LnpChem.init()` (lazy: every call below runs it on first use). Options, all optional:
  `init({base = "data/chem/", enc, manifest, loader, mode: "auto"|"worker"|"blob"|"main", workers, engineBase, oclUrl, resolvePn, pnOf})`
  or `init(manifest, loader)`; `loader(fileName, fileInfo)` -> inflated `Uint8Array` (JSON for `names.json`).
  Without a loader the files are fetched from `base`; `enc` defaults to `LnpData.manifest.enc`; when it is unknown
  the engine tries `x.gz.bin` and then `x.gz.b64.txt`. Resolves to the `diag()` object. A damaged or missing file
  rejects with `{code: "http"|"b64"|"gzip", message (names the file), data: true, file}`; a failed start is remembered
  for 8 s, so the `names()` / `parse()` / `search()` calls of one view do not each download the 25 MB again. A build
  without the chemistry set (`LnpData.manifest.chem === null`) rejects with `code: "no_chem"` without a request.
  `LnpChem.reset()` drops the engine. On small devices (`navigator.deviceMemory` <= 4 or a phone) two workers are
  used instead of four.
- `LnpChem.diag()` -> `{mode: "worker"|"blob"|"main", workers, n, publications, links, scaffolds, ocl, snapshot, built, ms: {fetch, load, init, pool}, tried[], gzip}`
- `LnpChem.parse(input)` -> `{ok, kind: "name"|"smiles"|"molfile"|"id"|"smarts"|"idcode"|"compound", name?, c?, id?, smiles, idcode, formula, mw}` or `{ok: false, error}`.
  `input`: SMILES, molfile (V2000/V3000), a reference lipid name or synonym (case, blanks and hyphens ignored:
  "mc3", "ALC 0315", "Lipid H"), `SCHEMBL<number>`, `smarts:<SMARTS>`, a compound index `c`, or `{smiles|molfile|idcode|smarts|c}`.
- `LnpChem.search({query | smiles | molfile | idcode | c, mode, limit (or k) = 100, minSim = 0.5, filters, sort, maxPatents = 25, onProgress, signal, all})`
  -> array of hits, best first, with the extra properties `total` (all matches), `ms`, `mode`, `truncated`, `stats`, `engine`
  (and `all`: `Uint32Array` of every matching `c` when `all: true`, substructure only).
  - `mode: "exact"`: same structure (`match: "exact"`) plus its stereo variants (`match: "stereo-variant"`: same
    connectivity, other or no E/Z and R/S; SureChEMBL splits one lipid over several such entries).
  - `mode: "sub"`: substructure (FFP512 pre-screen + OpenChemLib SSSearcher, identical to an unscreened search; stereo
    is ignored). Hits are ranked by count-fingerprint similarity to the query unless `sort` says otherwise.
  - `mode: "sim"`: count-fingerprint Tanimoto >= `minSim` (ECFP-like radius 2 plus topological pairs between hetero
    atoms, branch points and chain ends; separates chain-length variants, which OCL's FFP512 does not).
  - `mode: "scaffold"`: every compound with the same scaffold key (hydrocarbon chains of 6 or more carbons cut to a
    methyl, stereo removed): same head group, linkers and branching pattern with any tails.
  - `sort`: `"sim"` (default) | `"claims"` (publications with the compound in the claims) | `"patents"` | `"mw"`.
  - `filters`: `{mwMin, mwMax, head: name | [names], amine: "tertiary"|"secondary"|"primary"|"quaternary"|"amide", inClaims: bool, where: ["clm","desc","abs","ttl","img","mol"] (any), branched: bool, biodegradable: bool, tailLen: [min, max] (longest tail), unsat: [min, max], pns: [publication numbers] | ps: [patent indexes], <column>: n | [min, max]}`;
    `<column>` is any descriptor column (`ester`, `nTert`, `nTails`, `nEnds`, `nPat`, ...). Unknown keys reject with `code: "bad_filter"`.
  - `onProgress({mode, phase: "scan"|"rank"|"done", done, total, found, ms, partial?})`: substructure scans report after
    every chunk of 1024 compounds; the first event with at least 20 matches carries `partial` (hit objects without
    `sim`) so the UI can paint before the scan ends. `signal` (AbortSignal) rejects with `code: "cancelled"`.
  - hit = `{c, id: "SCHEMBL…", sim, match?, smiles, idcode, formula, mw, nPat, nFam, nClaims, inClaims, where: {clm, desc, abs, ttl, img, mol}, nPatGlobal, desc, patents: [{p, pn, fam, where}], morePatents}`.
    `c` is the row number in this build only; store `id` in saved work. `nPat`/`nFam`/`nClaims` count publications in the
    tool; `nPatGlobal` is the SureChEMBL-wide publication count (high = commodity compound). `patents` lists at most
    `maxPatents` publications, claims hits first; `p` is the patent index (`resolvePn(pn)` option, else `LnpData`, else -1).
    `desc` = `{head, amine: {class, count}, amines: {tertiary, secondary, primary, quaternary, amide, aromatic, other}, linkers: {ester: n, ...}, nTails, nChainEnds, tails: [{nC, nDoubleBonds, branched, branchPosition, ring, acyl}], tailCarbons, tailDoubleBonds, nBranchedTails, heavy, nC, nN, nO, nP, nS, charge, rings, nCarbonsToAmine, hasOH, biodegradable, hasCyclopropyl, stereo, logPest, scaffold}`.
- `LnpChem.patentsOf(c)` -> `[{p, pn, fam, where: {clm, desc, abs, ttl, img, mol}}]` (all, claims hits first). Where-found
  flags say in which part of the publication SureChEMBL found the structure; they are not proof of claim coverage.
- `LnpChem.compoundsOf(pOrPn, k = 200)` -> `[{c, id, smiles, idcode, formula, mw, where (in this publication), whereAll, nPat, nFam, nPatGlobal, desc}]` with `.total`;
  claims hits first, then drawn structures, then the most specific compounds (lowest `nPatGlobal`).
- `LnpChem.compound(cOrId)` -> one hit object without `sim`; `LnpChem.byId("SCHEMBL123")` -> `c | -1`
- `LnpChem.svg(smilesOrNameOrC, w, h)` or `svg(x, {w, h, mono})` -> SVG string generated by OCL from a parsed molecule
  and re-coloured: bonds and carbon labels use `currentColor` (follows light and dark theme), hetero atoms a mid-tone
  of their element colour (`mono: true` = everything `currentColor`); no `<style>`, `<script>` or ids inside.
- `LnpChem.descriptors(input)` -> lipid descriptors computed, not estimated:
  `{formula, mw, charge, heavy, el: {C, N, O, P, S, hal}, nN, amine: {class: "tertiary"|"secondary"|"primary"|"quaternary"|"none", count}, amines, head, headgroup: {smiles, hasOH, nCarbonsToAmine, nMethylOnN, ringN}, links: {ester, carbonate, carbamate, amide, urea, thioester, ether, thioether, disulfide, ketal, phosphate, acid, hydroxyl, ketone}, linkers: [{type, count}], tails: [{smiles, nC, acyl, branched, branchPosition, arms[], nDoubleBonds, nTripleBonds, nMethylBranches, hasRing, hasCyclopropyl}], nTails, nChainEnds, totalCarbons, tailCarbons, tailDoubleBonds, nBranchedTails, rings, biodegradable, logPest, smiles, idcode, scaffold: {idcode, smiles, index, truncatedChains}}`
  - a tail is a hydrocarbon group of 6 or more carbons hanging on one hetero atom or carbonyl carbon; `nC` counts the
    carbonyl carbon for acyl tails (`acyl: true`, stearoyl = 18); `branchPosition` counts from the atom the tail hangs on
    (2-hexyldecanoate: 2, heptadecan-9-yl: 1); `arms` are the chain lengths after the first branch point
    (ALC-0315: two tails `16 acyl, arms [8, 6]`; SM-102: `17, arms [8, 8]` and `11`; MC3: one group `37, arms [18, 18]`);
    `nChainEnds` counts linear tails plus arms of 4 or more carbons (ALC-0315 4, SM-102 3, MC3 2).
  - `head`: `neutral, polyether, sterol, phosphocholine, phosphoethanolamine, phospho, quaternary, polyamine, dimethylamino, hydroxyalkyl-tert-amine, cyclic-tert-amine, tert-amine, sec-amine, prim-amine, heteroaryl, amide, other-n`.
  - `headgroup.nCarbonsToAmine`: carbons between the main amine nitrogen and the nearest linker (-1 if none).
- `LnpChem.names()` -> `[{name, synonyms[], smiles, role: "ionizable"|"cationic"|"helper"|"sterol"|"peg", note, c (-1 if not in the set), variants[] (c of the stereo variants)}]` (reference lipids)
- `LnpChem.editor(el, {smiles, molfile, fragment, onChange, scale, background})` -> `{getSmiles(), getMolfile(), getIdcode(), getState(), setSmiles(s), setMolfile(m), setFragment(bool), clear(), destroy()}`
  (OCL `StructureEditor.createSVGEditor`, loaded on the main thread on first use; canvas based, no extra requests, no
  wasm/eval; it paints dark on transparent, so the element gets a white background unless `background: false`).
  `onChange({smiles, idcode, molfile, empty})`. Pass `{molfile: ed.getMolfile()}` to `search`.

### `LnpStore` (`engine/store.js`)
Persistence on the Artifact `db` capability with a `localStorage` fallback and an in-memory
last resort; same API in all three. The backend is chosen once in `init()`: `db` when `claude.use("db")` answers
within 5 s and a first read succeeds, else `local` (keys `lnp:<kind>/<id>`), else `memory`. A db write that is refused
later (view-only viewer, quota) is kept in the local backend for the visit and `diag().readonly` is set.
- `LnpStore.init()` -> `{backend: "db"|"local"|"memory"}` (lazy: every call below runs it on first use)
- `LnpStore.get(kind, id)` -> the stored value | `null`; `LnpStore.entry(kind, id)` -> `{id, updated, value}` | `null`
- `LnpStore.put(kind, id, value)` -> `{id, updated, backend}`; `LnpStore.remove(kind, id)`
- `LnpStore.list(kind)` -> the stored values, newest first. Plain objects come back as shallow copies with the
  document id filled in as `id` when the value has none (plus non-enumerable `_id`, `_updated`).
  `LnpStore.entries(kind, {values: false}?)` -> `[{id, updated, value}]` for callers that need the write time.
- `LnpStore.onChange(kind, fn)` -> unsubscribe; `fn({type: "put"|"remove", kind, id, value?})` for writes of this page
- `LnpStore.diag()` -> `{backend, readonly, log[], kinds, partChars}`; `LnpStore.cleanId(id)`
- kinds: `profiles`, `opinions`, `marks`, `searches`, `settings`, `diag`. Ids are reduced to `[A-Za-z0-9_.~:@+-]`
  (other characters become `_`, at most 150 characters).
- Storage layout in `db`: collection = kind, document `<kind>/<id>` = `{u: ISO time, v: value}`. A value whose
  ASCII-escaped JSON is longer than 120,000 characters is split: head `{u, n, len}` plus `<kind>-parts/<id>.<i>` =
  `{s: text}` (parts are written before the head, surplus parts of an older version are deleted), so every document
  stays far below the 256 KiB limit whatever the caller stores.
- Documents written by the app shell:
  - `marks/<pn>` = `{pn, star, tag, note, title, player, ts}` (watchlist star, tag and note of one publication; removed
    when all three are empty)
  - `searches/<id>` = `{name, q, hash, filters, sort, total, ts}` (`hash` is the deep link of the search view)
  - `settings/fto-selection` = `{pns: [...], q?, from: "suche"|"patent"|"merkliste", ts}`: the publications handed to
    the FTO view ("FTO pruefen"); the FTO view reads it on mount
  - `diag/boot` = `{v, at, ok, ms: {store, data, meta, index, views, ready | failed}, engines: {data, search, chem},
    enc, built, snapshots, counts, gzip, worker, store, caps: {claude, sample, db, downloads, user}, ai, aiAvailable,
    fto, views[], route, ua: {browser, major, os, mobile}, viewport, theme, dark, errors: [{t, where, code, message}]}`,
    rewritten 1.5 s after boot and after every logged error (also when the data files could not be loaded)

### `LnpAI` (`engine/ai.js`)
Thin wrapper over the Artifact `sample` capability (`const sample = await claude.use("sample")`). The page must declare
`capabilities: {sample: {images: true}}` for claim formula images to reach Claude; with `{sample: {}}` everything works
and formula features are marked `formel_fehlt`. No dependencies; `LnpSearch` / `LnpData` are only used by
`semanticSearch` and `explainClaim` (replaceable with `LnpAI.configure({search, data})`).
- `LnpAI.init()` -> bool (asks `claude.use("sample")` once; `null` or no `window.claude` = not available);
  `LnpAI.available()` -> bool (sync, after `init`; false after `not_granted` and similar); `LnpAI.state()`;
  `LnpAI.limits()` -> `{maxPromptBytes, images?: {maxCount, maxInputBytes, mediaTypes}, modelTiers?}` (never rejects).
- `LnpAI.text(prompt, {tier, signal, onText, images, cache, label})` -> `{text, truncated, tier, tierApplied, cuts, bytesIn, bytesOut, imagesSent, imagesDropped, input}`.
  `prompt` = a string, a list of turns `{role, content}`, or a list of parts `{t, cut, label, mode, min, close}`
  (`cut: 0` = never shortened; otherwise shortened in descending `cut` order, `mode` `"tail"` | `"headtail"` | `"drop"`).
- `LnpAI.json(prompt, {schema, check, tier, signal, images, onText, onStatus, meta, cache, label})` -> parsed value. Uses
  `sample()` (not `sample.json`) and its own extraction: whole reply, code fence, first balanced `{...}`/`[...]`, first-to-last
  bracket, each also without trailing commas. Validates against `schema` with the built-in JSON-schema subset validator
  (`type`, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `minItems`, `maxItems`, `pattern`,
  `minLength`, `maxLength`, `minimum`, `maximum`, `anyOf`) and against `check(value) -> errors[]`. On failure exactly ONE
  repair call is made: the first prompt, the first reply and the REPAIR block of `prompts.md` with the validation errors;
  a second failure rejects with `{code: "invalid_json" | "schema_invalid", errors, text}`. `meta` (an object you pass in)
  receives `{repaired, calls, cuts, bytesIn, bytesOut, tier, tierApplied, imagesSent, imagesDropped, truncatedOutput}`;
  `onStatus` gets `{type: "repair" | "truncated" | "tier" | "images_dropped", ...}`.
- 256 KiB cap: `LnpAI.bytes(s)` counts UTF-8 bytes; `LnpAI.fit(prompt, cap)` -> `{input, bytes, cuts: [{label, mode, originalBytes, removedBytes}]}`
  shortens deterministically and leaves a marker `[... TRUNCATED BY APP: n bytes removed from <label> ...]` at each cut;
  when the fixed parts alone are too large the call rejects `prompt_too_large` without sending anything.
- Model tiers (`tier` = a task name or a tier): `expand`, `rerank`, `triage` / `T` -> `quick`; `normalize` / `A`, `chart` / `B`,
  `dependent` / `C`, `explain` -> `default`; `redteam` / `E`, `synthesis` / `D` -> `complex`. A tier missing from
  `limits().modelTiers` falls back to `default`; a substituted tier is reported through `onStatus`.
- Calls are queued (one `sample` call at a time). `signal` (AbortSignal) rejects `{code: "cancelled"}`, also while queued.
- Errors are `{code, message, text?}` (codes of `sample.d.ts` plus `unavailable`, `schema_invalid`). `not_granted`,
  `sampling_disabled`, `not_declared`, `capability_disabled`, `capability_removed` switch the feature off for the view
  (`available()` false, no further call is sent); `rate_limited` is never retried. `LnpAI.message(err, lang)` gives the
  German / English UI copy, `LnpAI.action(err)` -> `"off" | "wait" | "login" | "retry" | "none"`, `LnpAI.isFatal(err)`.
- `LnpAI.usage()` -> `{calls, ok, failed, repairs, bytesIn, bytesOut, images, ms, byTier, last, log[]}` (in memory);
  `LnpAI.onUsage(fn)`.
- `LnpAI.semanticSearch(query, {n = 60, batch = 30, filters, signal, onStage})` ->
  `{hits: [{p, pn, title, claimNo, lang, score (0-3 | null), reason, check[], bm25, bm25Rank, text}], expansion, queries: {strict, relaxed, cpc}, used, calls, degraded[], total}`:
  query expansion (1 call) -> BM25 on independent claims with the expanded boolean query (strict, plus relaxed when
  fewer than n/2 hits) -> re-ranking in batches of 30 claims (sequential) -> merged ranking with a one-line reason per
  hit. Without Claude, or when a call fails, the BM25 order is kept and `degraded` says why.
- `LnpAI.explainClaim(pn | p, claimNo, {lang, signal, onText})` -> `{text, truncated, pn, claimNo, claimLang, cuts}`: plain-language
  explanation of one claim with the claims it refers to and the definitions excerpt. `LnpAI.explain(...)` is both:
  `explain(err, lang)` = `message(err, lang)`, `explain(pn, claimNo, opts)` = `explainClaim`.
- `LnpAI.mock(fn, {limits})` installs a test double (`fn(input, options)` -> string | `{text, truncated}` | JSON value;
  throw `{code}` to simulate failures); `LnpAI.mock(null)` removes it; `LnpAI.reset()`.

### `LnpFto` (`engine/fto.js`, `engine/fto-prompts.js`, `engine/fto-render.js`)
Implements `docs/method/FTO_METHOD.md` and `docs/method/prompts.md`. `fto-prompts.js` (`LnpFtoPrompts`) carries the
prompt blocks and JSON schemas of `prompts.md` verbatim in a generated section (`node tests/fto_test.mjs --gen-prompts`;
the test fails when the section drifts from the document) plus the data envelopes and the app addendum. Engines are
taken from the globals or from `LnpFto.configure({data, search, chem, store, ai, prompts, render, now})`.
- `LnpFto.normalizeProfile(form, {signal, lang, onEvent})` -> `ProductFeatures` (schema `pf-1` of `prompts.md`) with an extra
  `_app` block `{model, created, form, lipids[], warnings[]}`. `form` = `{name, lipids: [{role: "ionizable"|"helper"|"sterol"|"peg"|"other", name, smiles, molPct, pka, pegMw, cas}], ratioBasis, np, payload: {type, modification, lengthNt, encodes}, particle: {sizeNm, sizeMethod, pdi, encapsulationPct, zetaMv, morphology}, process: {mixing, device, frr, tfr, solvent, ethanolPct, buffer, ph, tempC, post[], site, maker}, formulation: {buffer, cryo, lyo, storage}, use: {route, indication, tissue, dose}, stage, markets: ["DE","EP","UPC","US"], launchDate, acts[], freeText}`.
  Structures are parsed and described by `LnpChem` (formula, MW, counts, head group, linkers, chains with carbon counts
  and branching); step A only arranges and words the profile. SMILES, InChIKey, descriptors and every number that the form
  carries are put back over the model output. Without Claude (or when step A fails twice) the deterministic profile is
  returned with `_app.model = false`.
- `LnpFto.candidates(profile, {max = 90, markets, manual: [p | pn], semantic: bool | text, signal, onEvent})` ->
  `[{p, pn, auth, kind, title, assignee, player, status, text, family, routes: ["structure","markush","text","seed","semantic","manual","family"], score, why[]}]`
  with a property `record` (the search record: every generated query verbatim with hit counts, the structure searches,
  seed counts, corpus snapshot and counts, notes). No model call except for the optional semantic route. Routes: exact /
  substructure / similarity (>= 0.8) search for each lipid (weighted by role and by whether SureChEMBL found the structure
  in the claims), "markush" = the user's lipid is disclosed in the document and an independent claim has a formula image,
  boolean claim queries generated from the profile, seed families of the watched players, family members of hits in the
  target jurisdictions. Seed tier 1 and user marks are always in the result; WO publications are pointers only.
- `LnpFto.run(profile, {patents, searchRecord, depth: "quick"|"standard"|"deep", lang, markets, onEvent, signal, id, persist})`
  (also `run({profile | features, candidates | patents, ...})`) -> `Opinion`. `patents` = result of `candidates()` (or a list
  of `p` / `pn`); omitted = `candidates()` is run.
  - Chain, strictly sequential: status and jurisdiction gate (no model) -> T triage in batches of 10 (independent claims
    clipped to 2200 + 800 characters) -> per patent B claim chart (independent claims verbatim with numbers, definitions
    excerpt with paragraph ids, formula images when `limits().images`), C dependent claims (all claims + checked chart
    summary; A patents, at depth deep also B), E red team (unless every claim is already "met" and nothing is flagged)
    -> digest built by the app -> D synthesis.
  - depth: quick = triage + charts for the top 5, no C, no E; standard = top 10 with C and E; deep = top 20, and expired /
    lapsed / revoked rights are charted too. Order of analysis: in force before dead, A before B, granted before pending,
    then candidate score. Everything not charted is listed with its reason (`dead`, `triage_c`, `depth_limit`, `no_text`,
    `text_cut`, `wo`, `market`, `no_ai`).
  - Jurisdiction: EP publications are assessed for the selected markets among DE / EP / UPC with `in_force_de`, lapses and
    opposition from `LnpData.status`; US publications for US. Expiry is always an estimate shown with its basis. A status
    older than 6 months (measured on the snapshot date of the source), unknown or missing is "ungeprueft" and treated as
    in force; a revocation with an appeal on record is treated as in force.
  - events: `{type: "stage", stage: "status"|"triage"|"patent"|"chart"|"dependent"|"redteam"|"synthesis"|"structure"|"text", done, total, pn}`,
    `{type: "triage", p, pn, rel, why}`, `{type: "chart", p, pn, chart, risk}`, `{type: "dependent", ...}`, `{type: "redteam", p, pn, report, risk}`,
    `{type: "text", section, text}` (streamed model text of the running step), `{type: "repair", step, errors, detail}`,
    `{type: "warn", message}`, `{type: "usage", calls, usage}`, `{type: "saved" | "resumed", step}`, `{type: "resume", id, steps}`, `{type: "done", id}`.
  - Resumable: the opinion id is derived from the inputs (profile, depth, language, markets, patents, corpus snapshot).
    A head document `{id, kind: "fto-opinion", state: "running"|"done"|"cancelled"|"paused", steps, args, error, summary}` and one
    document per finished step are written through `LnpStore` (kind `opinions`; step documents have `part: 1`, ids
    `<id>--<step>` and `<id>--<step>-c<i>`, at most 60,000 characters each, so list views must skip documents with
    `part`). A saved step is reused only when the hash of its prompt is unchanged. The same `run()` call after a reload, or
    `LnpFto.resume(id, {onEvent, signal})`, continues after the last finished step. `LnpStore` needs `get`, `put`,
    `remove`, `list(kind)` (documents with `id`); without it an in-memory store is used.
  - A stop (`cancelled`), `rate_limited`, `not_granted` and the like reject with `{code, message, id, userMessage}`; other
    failures of one step (invalid after the repair, refused) are recorded for that patent ("nicht beurteilbar") and the
    chain goes on.
  - Checks applied in code, never left to the model: every `claim_quote` must be a substring of the claim text after
    whitespace normalisation (`app.quote`: `ok` | `elided` | `approx` | `fail` | `empty`; only `ok` is verified, `fail` marks
    the row `zitat_nicht_verifiziert`); a "nicht_erfuellt" that rests on an unverified quote, on a formula that exists
    only as an unsent image, or on an unclear Markush test counts as "unklar"; the literal result of a claim is
    recomputed from the rows (all met -> literally met); truncated or formula-less claims are at most "possible"; every
    independent claim must appear in the chart; risk floors (literally met + granted -> 5, possible -> at least 3,
    formula missing -> "nicht beurteilbar"); final risk = the more adverse of B and E, a lower red-team value is never
    taken over; chain results of dependent claims are recomputed; the overall risk per market is computed from the final
    risks; patent numbers in the synthesis must exist in the digests; sweeping "free / no infringement" wording is
    flagged. Equivalence is rendered as a question for counsel and changes nothing by itself.
  - Prompt-injection defence: instructions first, then data in delimited blocks; a `<` that would open or close an
    envelope tag inside patent or user text is replaced by U+2039; the addendum tells the model to ignore instructions in
    data; nothing from the model or the patents is rendered as HTML without escaping.
- `LnpFto.chartOne(profile, pn | p, {depth = "quick", lang, markets, signal, onEvent})` -> one entry of `Opinion.patents` (plus
  `limits`, `warnings`); nothing is saved.
- `LnpFto.render(opinion, "md" | "html" | "json")` -> string. Every rendering starts and ends with the verbatim limits block
  (`LIMITS_DE` / `LIMITS_EN` with the status snapshot date). HTML is a self-contained printable document (inline CSS, no
  scripts, no links, fixed tag set, every string escaped); `LnpFtoRender.fragment(opinion)` is the same without the
  document frame. Sections: summary with risk matrix, product profile as understood, search record, per patent (status,
  claim chart, formula test, equivalence questions, dependent claims, red team, questions for counsel, design-around
  ideas), cross-cutting points, rights not analysed and why, next steps.
- `LnpFto.list()` (heads only), `LnpFto.load(id)` -> saved `Opinion`, `LnpFto.remove(id)`; pure helpers `verifyQuote`,
  `literalFromVerdicts`, `maxRisk`, `rightOf`, `statusLabel`, `checkChart`, `textQueries`.
- `Opinion` = `{v, id, created, finished, lang, depth, markets, aiUsed, title, snapshot (manifest.snapshots), statusSnapshot, limits, profile, search: {record, candidates, triage: {A, B, C}, charted, report}, patents: [{p, pn, auth, kind, title, assignee, family, filing, routes, why, jurisdiction, markets, rel, relWhy, status (text), right: {granted, pending, dead, deadReason, code, src, asof, stale, unverified, inForceDe, lapsedIn, opposition, modifiers, notes, expiry}, expiry: {date, basis, estimate: true, ptaDays}, risk: {b, e, final, chart?}, literal: {b, e, final, claim}, flags[], failed, chart (ClaimChart + `app` blocks), dependent, redteam, digest (ChartDigest)}], notCharted: [{p, pn, reason, text, rel, status, expiry}], overall: {markets: [{market: "DE"|"EP_UPC"|"US", risk, drivers[]}], pending}, synthesis (Opinion schema `op-1` of prompts.md + `app`) | null, matrix: [{pn, jurisdiction, markets, rel, risk, riskB, riskE, literal, status, expiry, expiryBasis, dead, pending, flags}], warnings[], usage, run: {calls, resumedSteps}}`.
  Risk codes: `1_sehr_gering` ... `5_sehr_hoch`, `nicht_beurteilbar` (ranks between 3 and 4).

## Work views (`web/app/views/`)

`struktur.js`, `produkte.js`, `fto.js`, `landschaft.js`, `merkliste.js`, `system.js` register themselves with
`LnpApp.registerView`. They share `app/views/views.css` (classes prefixed `k-`), `app/views/lib/kit.js` (`LnpKit`: page
furniture, descriptor and risk vocabulary, depiction box, chart tooltip, file picker) and `app/views/lib/chart.js`
(`LnpChart`: stacked columns as inline SVG; bar lists, segmented bar, heat map and expiry timeline as HTML marks; every
mark carries a tooltip and a link into the search view). The shell loads only `app/views/*.js`, so each view file starts
with the same small loader (`LnpLazyView(id, files, mount)`): it fetches the css and the lib files once, in order,
before the first mount; nothing in the shell had to change. No view assigns `innerHTML`.

Routes (alphabet of `router.js`):
- `#struktur[-<query>][--m<exact|sub|sim|scaffold>][--t<min similarity %>][--n<pn>][--c<SCHEMBL id>][--f<filters>][--s<sort>]`;
  `f` = list of `tl<min>-<max>` (longest tail), `nt<n>`, `es<n>`, `am<class>`, `cl1`; `c` opens the compound with its
  publications (claims first, then granted rights with an open term, then later expiry).
- `#produkte[-<profile id> | -beispiel]`, `#fto[-<opinion id>][--p<profile id>][--d<quick|standard|deep>]`,
  `#landschaft[--rkern]`, `#merkliste[--t<tag>][--s<exp|pn>]`, `#system[--xtest]` (starts the self-test).

Documents written by these views (through `LnpStore`):
- `profiles/<id>` = the form of `LnpFto.normalizeProfile` plus `{id, example, updated}`; export files are
  `{kind: "lnp-profile", v: 1, profile}` or `{kind: "lnp-profiles", v: 1, profiles: []}` (import accepts both, a bare
  profile or a list, and always assigns new ids). `window.LnpProfile = {example(), blank(), clean(doc)}` (produkte.js).
- `settings/pf-<profile id>` = `{stamp, features}`: the normalised profile (`pf-1`), reused while the profile and the
  availability of Claude are unchanged, so the candidate search does not repeat step A.
- `settings/fto-selection`: `from` also takes `"struktur"`.
- `searches/<id>.snap` = `{ts, built, total, pns: "EP… US…"}` (watchlist, "Stand übernehmen"): the result list of a
  saved search (up to 5,000 publications) against which a rerun marks what is new; without it a rerun falls back to
  "published after the search was saved".

Call estimate shown before a run (view `fto`): triage `ceil(n / 10)` for the selected publications with claim text,
one chart call per charted publication (`LnpFto.DEPTH[depth].n` at most), up to one dependent-claims call and one
red-team call each at depth standard / deep, one synthesis call; repairs (at most one per step) and split charts of
long claim sets are named but not counted.

`engine/loader.js` (worker service): concurrent `get` requests for one file share one fetch and so one ArrayBuffer;
all but the last waiter now receive a copy, the last takes the buffer by transfer. Before, the second transfer threw
inside the worker and the caller never got an answer (seen when `LnpData.patents()` touched more chunks than the
chunk LRU holds, e.g. in `LnpFto.candidates`).

## Build and test entry points

```
pipeline/run_all.sh                 normalize -> status --no-fetch -> chemistry (if an input is newer) -> build_dist (b64)
pipeline/run_all.sh batches [-v]    the publish batches of dist/ (reads dist/publish_batches.json)
pipeline/run_all.sh check           the three engine tests and the end-to-end test
make dist | batches | test | e2e | serve
```
Measured on the build machine (4 cores), 125,104 publications, 15,148 to 17,995 full texts, 381,533 to 453,234 claims:
normalize 36-77 s (depends on how many new cache files have to be parsed), status 15-58 s, chemistry 10 s (cached),
build_dist 59-60 s (25-30 s when the text index is unchanged); `pipeline/run_all.sh` in all 152 s.

`tests/artifact_server.cjs` serves a dist the way the host does: `index.html` wrapped in a document skeleton, the
host's Content-Security-Policy on every response, `*.bin` answered with 404 (unless `--bin`). Modes: `host`; `blob`
(file workers 404, so `blob:` workers take over); `strict` (`worker-src 'none'`, engines on the main thread). Faults
per path: `404`, `corrupt`, `truncate`, `slow`.

`tests/e2e.cjs` (Playwright, Chromium) drives the published form of the page: `node tests/e2e.cjs [--dist dist]
[--only main,mobile,noclaude,nullcaps,blob,strict,bin,faults,fixture,perf] [--shots DIR] [--report FILE] [--bin DIR]`.
`window.claude` is mocked in the page (sample with canned JSON per FTO step, db, downloads); requests leaving the
origin are aborted and counted, Google Fonts are answered locally. `bin` (only on request) checks the raw-binary build.

Measured by `tests/e2e.cjs --only perf` (headless Chromium, local server, base64 build, 125,104 publications): cold boot
to ready 220-380 ms, first result list painted about 0.5-0.65 s after 47 requests / 7.8 MB (the first list touches 15 of
the 32 patent-table chunks); search: first run of a query 20-380 ms, repeated 5-40 ms; patent page to claims 220-320 ms;
structure set ready 0.5-0.9 s after 25 MB, exact / similarity / scaffold under 1 s, an unselective substructure query
over all 84,691 compounds 2.5-3.8 s. Page JS heap 28 MB after boot and 89 MB with the structure set and the whole table;
resident memory of all renderer processes (page and workers) 280 MB after boot, 600 MB after 80 different searches,
975 MB with the structure set and four workers (550 / 835 MB with the small-device settings).

