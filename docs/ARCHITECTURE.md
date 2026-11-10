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
- `status` is taken from `data/work/status.jsonl.gz` when that file exists at normalize time, else null.

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
independent claims contain `[chem:imgbNNNN.tif]`, the `document.zip` is fetched (priority
order, `--limit`), the referenced TIFFs are converted to 1-bit PNG (longest side at most
1400 px) and stored as `data/work/img/<pn>/<imgid>.png` with `data/work/img/index.jsonl`
(`{pn, img, claim, w, h, bytes}`). US documents get no images in this version.

## Stage 3: `dist/` (written by `pipeline/build_dist.py`)

```
dist/index.html                the page (copied from web/index.html)
dist/app/*.js  dist/app/app.css
dist/engine/*.js               engines + vendor (openchemlib-full.js 8.21.0, fflate)
                               (LnpChem looks for OpenChemLib at engine/../vendor/openchemlib-full.js as in web/,
                               then at engine/openchemlib-full.js; either place works)
dist/data/manifest.json
dist/data/pat-NNN.gz.bin       patent table, columnar JSON chunks of 4000 patents
dist/data/st-NNN.gz.bin        status detail, JSON array per 4000 patents (null where none)
dist/data/idx/…                text index (see pipeline/build_index.mjs)
dist/data/df-NNN.gz.bin        definition paragraphs, aligned with the text shards
dist/data/img-NNN.bin          claim image packs + dist/data/img.json index
dist/data/chem/…               compounds, fingerprints, compound<->patent map: the files named in
                               data/work/chem/chem.json `publish` (see "Chemistry shards")
dist/data/seed.json            seed families, players, CPC definitions, reference lipids
dist/publish_batches.json      [{files:[...], bytes}] each <= 240 files and <= 60 MB
```

Limits of the host: each file <= 15 MB, at most 500 files and 240 MB in total. `.gz.bin`
files are gzip streams of the described payload; with `--enc b64` every binary is written
as base64 text `*.b64.txt` instead and `manifest.enc = "b64"`. The engines read
`manifest.enc` and handle both. No file name contains anything but `[a-z0-9._-/]`.

`manifest.json`:
```
{"v":1,"built":"2026-11-10T12:00:00Z","enc":"bin",
 "snapshots":{"surechembl":"2026-11-03","ep_register":"2026-08-23","ep_text":"2026-11-10","us_text":"2026-11-10"},
 "counts":{"patents":N,"fulltext":N,"claims":N,"compounds":N,"ep":N,"us":N,"wo":N,"seed_expected":126,"seed_present":N},
 "pat":{"chunk":4000,"files":[...]}, "st":{...}, "idx":{...}, "df":{...}, "img":{...}, "chem":{...}}
```

Patent table columns (per chunk, arrays of equal length; the patent index `p` is the
global row number): `pn, auth, kind, pub (yyyymmdd int), app (int|0), prio (int|0),
fam (int), title, asg (index into manifest-level name table chunk-local array asgNames),
player (index into seed.players | -1), cpc ("A|B|C"), tier, seedTier (0 = none),
flags (bit0 text, bit1 defs, bit2 chem image in independent claim, bit3 has compounds,
bit4 has status), st (status code index), exp (yyyymmdd int|0), deIn (1 in force in DE,
0 not, 2 unknown), wo`.

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
   `data/seed/ref_lipids_pubchem.json` plus `pipeline/chem_names.cjs` (synonyms, roles).

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

## Browser engines (all in `web/engine/`, plain scripts, ASCII only, no build step)

Every engine works in three modes and picks the first that works: dedicated Worker from
its own file, Worker from a `blob:` URL built from the same source, main thread. Gzip is
inflated with `DecompressionStream` when present, else with the bundled fflate. Nothing
is fetched from another origin. All functions return promises. Claim text, titles and
names are untrusted input: the UI inserts them with `textContent`, never as HTML.

### `LnpData` (`engine/data.js`)
- `LnpData.init(base = "data/")` -> manifest; loads `seed.json`; patent chunks load lazily.
- `LnpData.manifest`, `LnpData.seed`
- `LnpData.patent(p)` -> `{p, pn, auth, kind, pub, app, prio, fam, title, assignee, player, cpc[], tier, seedTier, text, hasDefs, hasImg, hasCompounds, status, exp, deIn, wo}`
- `LnpData.patents(ps[])` -> array of the same
- `LnpData.byPn("EP3532103B1" | "EP 3 532 103" | "US8,058,069")` -> p | -1 (tolerant of separators and missing kind)
- `LnpData.family(p)` -> p[] (all members in the table)
- `LnpData.status(p)` -> status detail object | null
- `LnpData.all()` -> columnar view of the whole table (loads every chunk; used by landscape and filters)
- `LnpData.links(p)` -> `{espacenet, google, register|null, uspto|null}` URLs
- `LnpData.diag()` -> `{mode: "worker"|"blob"|"main", gzip: "native"|"fflate", enc}`

### `LnpSearch` (`engine/search.js` + `engine/search-core.js` + `engine/tok.js`)
- `LnpSearch.init()`
- `LnpSearch.search(query, opts)` -> `{total, hits, facets, parsed, ms}`
  - `query`: implicit AND, `OR`, `NOT`/`-x`, parentheses, `"phrase"`, `prefix*`,
    `NEAR/n` between two terms, inline fields `cpc:` `asg:` `player:` `auth:` `year:2015-2022`
    `indep:1` `lang:de` `pn:`
  - `opts`: `{filters: {auth[], yearFrom, yearTo, cpc[], players[], status[], tiers[], indepOnly, textOnly, deInForce, expAfter (yyyymmdd), seedOnly, ps (restrict to patent indexes)}, limit=25, offset=0, sort: "score"|"date"|"expiry", facets: true}`
  - `hits[i]` = `{p, score, n (matching claims), best: {n, lang, indep, snippet: [[text, isMatch], ...]}}`
  - `facets` = `{auth:{EP:n,..}, year:{2019:n,..}, player:{..}, status:{..}, tier:{..}, cpc4:{A61K:n,..}}` over the full result set
  - An empty query with filters lists the filtered patents (sorted by date).
- `LnpSearch.claims(p, lang?)` -> `[{n, lang, indep, dep[], text}]` (all languages if `lang` omitted)
- `LnpSearch.highlight(text, parsed)` -> `[[text, isMatch], ...]`
- `LnpSearch.defs(p)` -> string[]
- `LnpSearch.claimImages(p)` -> `[{claim, id, w, h, blob}]` (PNG blobs; empty if none)
- `LnpSearch.suggest(prefix)` -> up to 10 index terms with document frequency

### `LnpChem` (`engine/chem.js` + `engine/chem-worker.js` + `engine/chemfp.js` + `vendor/openchemlib-full.js`)
Pure JS (OpenChemLib 8.21.0 UMD, no wasm, no eval). `chem-worker.js` is the search core: it runs as a dedicated
Worker, inside a `blob:` Worker (OpenChemLib + chemfp.js + chem-worker.js concatenated) or on the main thread.
Substructure search is spread over up to 4 workers (`navigator.hardwareConcurrency`), which join in the background
after `init`. `chemfp.js` (count fingerprint, lipid descriptors, scaffold) is shared with the offline build.

- `LnpChem.init()` (lazy: every call below runs it on first use). Options, all optional:
  `init({base = "data/chem/", enc, manifest, loader, mode: "auto"|"worker"|"blob"|"main", workers, engineBase, oclUrl, resolvePn, pnOf})`
  or `init(manifest, loader)`; `loader(fileName, fileInfo)` -> inflated `Uint8Array` (JSON for `names.json`).
  Without a loader the files are fetched from `base`; `enc` defaults to `LnpData.manifest.enc`; when it is unknown
  the engine tries `x.gz.bin` and then `x.gz.b64.txt`. Resolves to the `diag()` object.
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
last resort; same API in all three. Documents stay under 200 KiB (opinions are split
into a head document and part documents when larger).
- `LnpStore.init()` -> `{backend: "db"|"local"|"memory"}`
- `LnpStore.list(kind)`, `.get(kind, id)`, `.put(kind, id, obj)`, `.remove(kind, id)`, `.onChange(kind, fn)`
- kinds: `profiles`, `opinions`, `marks` (per-patent tag + note), `searches`, `settings`, `diag`

### `LnpAI` (`engine/ai.js`)
Thin wrapper over the Artifact `sample` capability.
- `LnpAI.available()` -> bool, `LnpAI.limits()`
- `LnpAI.json(prompt, {tier, signal, schema, images, onStatus})` -> object; validates against `schema` (small built-in JSON-schema subset validator), retries once with the REPAIR block, never more
- `LnpAI.text(prompt, {tier, signal, onText})`
- Errors are `{code, message}`; `LnpAI.explain(err, lang)` gives UI copy. No automatic retries beyond the single repair.
- `LnpAI.mock(fn)` installs a test double (used by tests and by the demo mode when `sample` is absent).

### `LnpFto` (`engine/fto.js`, `engine/fto-prompts.js`, `engine/fto-render.js`)
Implements `data/probe/method/prompts.md` and `FTO_METHOD.md` (copied to `docs/method/`).
- `LnpFto.normalizeProfile(profileForm, {signal})` -> `ProductFeatures` (step A; chemistry descriptors come from `LnpChem.descriptors`, never from the model)
- `LnpFto.candidates(features, {max})` -> `[{p, routes: ["text","structure","player","seed","manual"], score, why}]` (no model: text queries built from the features, structure search, seed tier 1, user marks)
- `LnpFto.run({profile, features, candidates, depth: "quick"|"standard"|"deep", lang: "de"|"en", markets: ["DE","EP","US"], onEvent, signal})` -> `Opinion`
  - events: `{type: "stage", stage, done, total}`, `{type: "triage", p, rel, why}`, `{type: "chart", p, chart}`, `{type: "redteam", p, report}`, `{type: "text", section, text}`, `{type: "warn", message}`, `{type: "usage", calls}`
  - depth: quick = triage + charts for the top 5, no red team; standard = top 10 with dependent claims and red team; deep = top 20
  - deterministic checks from prompts.md are applied in code: verbatim quote check, literal result recomputed from feature verdicts, final risk = more adverse of chart and red team, expiry and status from `LnpData`, limits block inserted verbatim
- `LnpFto.chartOne(features, p, opts)` -> claim chart for a single patent (used from the patent view)
- `LnpFto.render(opinion, "md"|"html")` -> string (the HTML is a self-contained printable document)
- `Opinion` = `{id, created, lang, profile, features, markets, depth, snapshot (manifest.snapshots), patents: [{p, pn, rel, risk (0-4), riskLabel, status, expiry, charts[], dependent, redteam, digest}], matrix: {features[], rows[]}, sections: {summary, scope, method, findings, equivalents, exemptions, designAround, nextSteps}, limits, usage}`
