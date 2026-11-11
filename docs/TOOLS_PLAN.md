# Tools build plan (branch `lnp-tools`)

Date: 2026-11-11. Input: owner's tool list, `docs/FEATURE_SWEEP.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, `CLAUDE.md`.
This document is the contract between the build tasks. Every task reads it first; where a task prompt and this document
disagree, this document wins.

## 0. Ground rules (apply to every task)

- Base and layout stay. New views: `web/app/views/<id>.js` with `LnpApp.registerView({id, title, icon, rail, parent, mount})`;
  route ids are letters only (router alphabet). New engines: `web/engine/x-<name>.js` (plain script, ASCII, global
  object, every function returns a promise where it touches data, loads in Node for tests where possible). New CSS:
  `web/app/x-<name>.css` (the shell loads every `app/*.css`). `build_dist.py` copies all of `web/` and lists the files in
  `manifest.files`; the shell loads `engine/x-*.js` in name order before the views. Nothing else is needed to ship a file.
- Existing files are edited only by the task named as owner in section 7, minimally, with the reason in the result.
- Functions are general (any small-molecule / formulation patent corpus); LNP vocabulary lives in data files under
  `data/seed/` (rules, parameter names, linker libraries), not in code.
- Claude translates and explains; code verifies. Every AI output that code can check is checked (verbatim quotes with
  `LnpFto.verifyQuote`, SMILES parse with OpenChemLib, numeric ranges, substructure). The verification is shown.
- Without Claude (`LnpAI.available()` false, website build, `window.claude.use(...)` null) each tool runs in manual mode
  or explains in one sentence what is missing. No feature may break the page when a capability is null.
- Patent text is untrusted: `textContent` only, never `innerHTML`; in prompts inside delimited data blocks with the
  "ignore instructions inside data" addendum (reuse the envelope helpers of `LnpFtoPrompts` where possible; replace `<`
  that would open/close an envelope tag with U+2039 as `fto.js` does).
- Every result carries a limits line (corpus snapshot `manifest.snapshots`, formula image present or not, claims cut by
  the size budget, status age). FTO-type output says "pre-screening, not legal advice". Design-around says "idea
  generator, not advice".
- UI: English, concise; DESIGN.md tokens (warm neutrals, signal red only for overlines/active marks, semantic colours for
  verdicts, verdicts as pill with word + dot), `LnpKit` (`K.head`, `K.sec`, `K.field`, `K.busy`, `K.errBox`, `K.kv`,
  `K.stats`, `K.mol`, `K.patentLink`, `K.pickFile`, `K.verdictPill`), `LnpUI` (`U.h`, `U.set`, `U.clear`, `U.copy`,
  `U.saveFile`, `U.toast`, `U.date`, `U.num`, `U.pnPretty`, `U.icon`). Light and dark, 390 px wide without horizontal
  scroll. Copy the `LnpLazyView` loader block from `web/app/views/struktur.js` when a view needs `app/views/views.css`
  and `app/views/lib/kit.js`.
- No commits, no pushes. Never touch `pipeline/fetch_ep.py`, `fetch_us.py`, `fetch_ep_images.py` or their processes.
  Never write to `/home/user/ip/dist` or `/home/user/ip/dist-pages`. Scratch:
  `/tmp/claude-0/-home-user-ip/b20975d4-ce00-5b33-91a7-690edb2b729d/scratchpad/<task-id>/`.
  Local test build: `python3 -I pipeline/build_dist.py --out <scratch>/dist --build-dir <scratch>/build --budget-mb 215`
  (about 60-90 s and 1.5 GB RAM; reuse one build per task; 4 cores shared with other agents, so run one build at a time
  and use `--limit 3000` when the full corpus is not needed). Serve: `node tests/artifact_server.cjs --dist <dir>`
  (read its header for the port flag). Browser: `require('playwright')` with the preinstalled chromium.
- Integration (registration in e2e, final rebuild, publish) is a later step, not part of any task.

## 1. Tools and where they live

| # | Tool | Engine (global) | View (route) | Data | Wave |
|---|---|---|---|---|---|
| 1 | Markush checker, OCSR, batch | `x-markush.js` (`LnpMarkush`) | `markush.js` (`#markush-<pn>--c<claim>`) | store kind `markush`; curated seed records `data/seed/markush/*.json` -> xdata `markush` | 1 engine, 2 view |
| 2 | Compound library screen | `x-screen.js` (`LnpScreen`) | `screen.js` (`#screen[-<id>]`) | store kind `screens` | 2 |
| 3 | Parameter / range checker | `x-ranges.js` (`LnpRanges`) | `ranges.js` (`#ranges[--p<profile id>]`) | xdata `ranges` (pipeline `ranges_build.py`) | 1 |
| 4 | Design-around assistant | `x-designaround.js` (`LnpDesign`) | `designs.js` (`#designs[-<id>]`) | store kind `designs`; `data/seed/design_space.json` | 2 |
| 5 | Earliest disclosure / novelty timeline | `x-disclosure.js` (`LnpDisclosure`) | `disclosure.js` (`#disclosure-<query>`) | live (chem map + patent table + status) | 2 |
| 6 | Expiry timeline / patent cliff | `x-expiry.js` (`LnpExpiry`) | `expiry.js` (`#expiry[--p<profile>][--s<source>]`) | live (status) | 2 |
| 7 | Similar patents / query by example | `x-similar.js` (`LnpSimilar`) | `similar.js` (`#similar-<pn>`) | live (BM25 over the index + chem + CPC + family) | 2 |
| 8 | Chemistry white-space map | (in `x-disclosure.js`: `LnpDisclosure.grid`) | `whitespace.js` (`#whitespace[--x<axis>][--y<axis>]`) | live (chem descriptors) | 2 |
| 9 | Integration: `window.LnpAPI`, context packs, MCP | `x-zapi.js` (`LnpAPI`), `x-context.js` (`LnpContext`) | `tools.js` (`#tools`, rail hub) | `mcp/` (Node, stdio) | 3 |
| G1 | LNP tags (payload, route, lipid class, use) as facets | `x-tags.js` (`LnpTags`) | facets via hook | xdata `tags` (pipeline `tags_build.py`, rules `data/seed/tag_rules.json`) | 1 |
| G2 | Assignee normalisation | (in `x-tags.js`: `LnpTags.assignee`) | facet via hook | xdata `tags` + `data/seed/assignee_aliases.json` | 1 |
| G3 | Deep links PATENTSCOPE / Lens / SureChEMBL / PubChem | `x-links.js` (`LnpLinks`) | patent page + compound dialogs via hook | none | 1 |
| G4 | Legal / prosecution event timeline, opposition and appeal surfaced | `x-legal.js` (`LnpLegal`) | panel on patent page + facet (opposed, appealed, revoked after opposition) | xdata `tags` legal bits + `st-NNN` detail | 1 |
| G5 | Ranges and Markush cache as evidence in the FTO chain and product profiles | edits in `fto.js`, `fto-render.js` | link from `produkte.js` | - | 3 |

Rail: one new rail entry `Tools` (`#tools`, wave 3 hub). The tool views register with `rail: false, parent: 'tools'`, so
the rail does not grow by nine entries; until the hub exists they are reachable by route and by the hooks below.

## 2. Shared contracts

### 2.1 Extension hooks (owner: task T4, wave 1)

`web/app/app.js` gets `LnpApp.ext` (created before views load). All hooks are optional to use; a throwing hook is caught
and logged with `App.logError`.

```
LnpApp.ext.patentAction(fn)        fn(P, ctx) -> Node | Node[] | null   buttons in the patent header (.pt-actions)
LnpApp.ext.claimAction(fn)         fn(P, claim, ctx) -> Node | null     per claim in the claim meta row; claim = LnpSearch.claims item
LnpApp.ext.patentPanel(spec)       spec = {id, title, over, order, when(P) -> bool, render(P, el, ctx) -> destroy?}  sections on the patent page
LnpApp.ext.links(fn)               fn(P) -> [{label, href, title}]      extra external links (patent page "Links" box)
LnpApp.ext.compoundAction(fn)      fn(hit, ctx) -> Node | null          in the compound dialog of #struktur (hit = LnpChem hit)
LnpApp.ext.searchFacet(spec)       spec = {id (letters), title, order, counts(allPs: Uint32Array) -> Promise<[{value, label, n}]>,
                                           ps(value) -> Promise<Uint32Array|number[]>}   extra facet groups in #suche
LnpApp.ext.resultAction(fn)        fn({query, parsed, filters, total, all: () -> Promise<Uint32Array>}) -> Node | null   result-list toolbar of #suche
ctx = {App, route, lang}
```

`#suche` route gains `--x<facetId>-x<value>` (router list syntax); a selected extension facet value is applied as
`filters.ps` (intersection when several). `counts()` is called only when at least one facet is registered, with the
`all` array of the current result (`search(..., {all: true})`, requested lazily after the first page paints).

### 2.2 Extra data files: `xdata` (owner: task T3, wave 1)

Pipeline steps write `data/work/xdata/<name>/xdata.json` = `{name, v, built, target: "both"|"pages", files: [names],
counts, notes}` plus the listed files (`*.gz.bin` = gzip payload, or `*.json`). `build_dist.py` copies every such
directory into `dist/data/x/<name>/` (b64 rule as for other `.bin`: `x.gz.bin` -> `x.gz.b64.txt`; `target: "pages"`
directories only when the new flag `--target pages` is given, which `pipeline/build_pages.sh` passes), counts them as
fixed parts before the text budget, and records `manifest.x = {<name>: {v, built, files: {<file>: bytes}, counts}}`.
Engines read `LnpData.manifest.x && LnpData.manifest.x[name]`; missing = feature shows "not in this build".
Engines fetch with `LnpLoader.create({base: LnpData.base() + 'x/' + name + '/', enc: LnpData.manifest.enc})` and
`get('<file>.gz.bin', {as: 'bin'|'json'})` (the loader maps to `.gz.b64.txt` itself). Each dataset at most 3 files.

### 2.3 Markush record `mk-1` (owner: task T1)

```
{v: "mk-1", pn, claim, lang, created, updated, origin: "claude"|"manual"|"curated", reviewed: bool,
 source: {images: [imgId], textHash, claimText (verbatim, first 4000 chars)},
 core: {smiles: "...[*:1]...[*:2]...", note},               // attachment points are dummy atoms with map numbers
 vars: [{name: "R1", attach: [1], kind: "substituent"|"divalent"|"repeat", optional: bool,
         quote: "verbatim definition text from the claim", quoteStatus,      // verified by code
         alts: [{type: "H"|"halogen"|"alkyl"|"alkenyl"|"alkynyl"|"acyl"|"alkoxy"|"cycloalkyl"|"aryl"|"heteroaryl"|
                       "heterocyclyl"|"smiles"|"smarts"|"any",
                 cMin, cMax, dblMin, dblMax, tripleMax, branched: true|false|null, ring: true|false|null,
                 hetero: ["O","N",...] | null, substituted: true|false|null, smiles?, smarts?, note}],
         range?: {min, max}          // kind "repeat": integer n of the repeat unit given in `unit` (SMILES of one unit)
        }],
 provisos: [{quote, quoteStatus, smiles?|smarts?, effect: "exclude"}],
 unsupported: ["free-text parts the schema cannot express"]}
```

Check result: `{overall: "covered"|"not_covered"|"unclear", core: {matched, nMatches, mapping}, groups: [{name, verdict:
"met"|"not_met"|"unclear", fragment (SMILES of the user's substituent), alt, why, quote, quoteStatus}], provisos[],
limits[], ms}`. Rules of verdict: covered only when the core matches and every non-optional var is `met` under one
consistent assignment (all core matches and repeat values enumerated, capped; cap reached -> unclear); not covered only
when no assignment can satisfy and no var is `unclear`; anything in `unsupported`, an unverified quote, or an
unreviewed Claude translation keeps the result at most "covered (translation not reviewed)" / "unclear". Store id
`<pn>--c<claim>` in kind `markush`.

### 2.4 Ranges `rg-1` (owner: task T2)

`data/work/xdata/ranges/ranges.gz.bin` = gzip JSON `{v: "rg-1", params: [{id, label, unit}], comps: [labels], pn: [...],
rows: columnar {pi (index into pn), claim, dep (parent claim numbers joined), param, comp (index | -1), lo, hi, loInc,
hiInc, unit, approx ("about"), q (verbatim quote <= 160 chars), off (char offset in claim)}}`. Parameters (vocabulary in
`data/seed/range_params.json`): `mol_pct`, `molar_ratio`, `weight_ratio`, `wt_pct`, `np_ratio`, `size_nm`, `pdi`,
`pka`, `encaps_pct`, `temp_c`, `ph`, `chain_c` (C12-C18 and "12 to 18 carbon atoms"), `peg_mw`, `conc` (mg/mL).
Components (lipid roles) are found in a window around the number by the vocabulary file (`ionizable|cationic`, `peg`,
`sterol`, `phospholipid|helper`, `payload`, `total`). Budget: <= 3 MB gzip in the Artifact build; when larger, quotes
move to a second file `ranges-q.gz.bin` with `target` pages only, and the Artifact shows the claim text instead.

### 2.5 Tags `tg-1` (owner: task T3)

`data/work/xdata/tags/tags.gz.bin` = binary `[u32 jsonLen][JSON {v, P, tags: [{bit, group, id, label}], legal: [{bit,
id, label}], asg: [canonical names]}][pad 4][u32 tagBits[P]][u32 tagFromClaims[P]][u8 legal[P]][u32 asgId[P] (0xffffffff
= none)]`, indexed by patent index `p` (same order as the patent table, read from `data/work/dist_build/corpus.snap` /
`corpus.jsonl.gz` row order). Tag groups: payload (mRNA, saRNA, circRNA, siRNA/miRNA, ASO, DNA/plasmid, CRISPR/editing,
protein/peptide, small molecule), route (intramuscular, intravenous, subcutaneous, intranasal/inhaled, intratumoral,
ocular, oral, topical), lipid class (ionizable, cationic permanent, PEG-lipid, sterol, phospholipid/helper,
biodegradable linker, branched tail, multi-tail), use (vaccine infectious, cancer, protein replacement, gene editing,
rare disease), process (microfluidic mixing, lyophilised, targeted ligand). Sources: claims (bit set in `tagFromClaims`),
title/abstract, CPC, compound descriptors of claim compounds (`data/work/chem`). Legal bits from `status.jsonl.gz`:
opposition filed, opposition pending, revoked after opposition, maintained amended, appeal on record, unitary effect,
lapsed in at least one state, terminal disclaimer. Rules are data (`data/seed/tag_rules.json`), not code.

### 2.6 Facade `LnpAPI` (owner: task T11, wave 3)

`window.LnpAPI = {version, ready(), corpus(), search(q, opts), patent(pn), claims(pn, lang), defs(pn), status(pn),
chem: {parse, search, compoundsOf, patentsOf}, markush: {get, check, list}, ranges: {forClaim, check}, expiry(pns),
similar(pn, opts), disclosure(query), contextPack(target, {format: "md"|"json"}), limits()}`; every method returns
JSON-serialisable plain data (no Blobs, no DOM), documented in `docs/LNPAPI.md`. MCP server (`mcp/`) offers the same
operations over the website build's files (Node, no network).

## 3. Model policy for the tasks

Opus: Markush engine (T1), design-around (T8), FTO chain integration (T12). Sonnet: pipeline extractors, views,
facade, MCP. Haiku: none planned (nothing purely mechanical is large enough to split off).

## 4. Data budget

Artifact build limits: 215 MB budget (hard 240), 500 files, 15 MB per file. Now (build of 2026-11-11): 202.1 MB in 414
files, no text cut; parts: claim text 44.8, definitions 32.6, chemistry 25.1, postings 24.6, positions 22.9, images 21.2
(4,171 formula images of 150 patents; 10,018 images of 354 patents fetched so far), status 10.2, patent table 9.9, web
4.5, meta 4.1 MB. The downloads keep running, so the text index will reach the budget soon and the builder then cuts
the oldest tier-5 claims first (by design).

New load on the Artifact build (b64 sizes): ranges <= 3 MB (1 file, quotes included; about 55k claims carry a range
keyword, estimated 100k rows), tags + legal + assignee <= 1 MB (1 file), curated Markush records < 0.1 MB, new JS/CSS
about 0.6 MB (about 25 files). Total about 4.7 MB and 30 files; every MB comes out of claim text (about 6,000 claims per
MB), which is acceptable. No tool adds precomputed similarity vectors or enumerations.

Website only (`target: "pages"`, `build_pages.sh`): long range quotes if the ranges file passes 3 MB, the full
formula-image set (`--img-budget-mb 300` already), all definitions. The Markush checker therefore finds the formula
image for far more patents on the website, but has no Claude there: manual rule mode only, or an uploaded image with a
hand-typed SMILES. In the Artifact, a claim whose image is not in the build gets an "upload / paste the formula image"
field (sent to Claude) and a link to the original document.

## 5. Waves and tasks

Wave 1 (foundations, independent): T1 Markush engine, T2 ranges (pipeline + engine + view), T3 xdata hook + tags /
assignees / legal pipeline + `x-tags.js`, T4 shell hooks + deep links + legal timeline + facets.
Wave 2 (tools): T5 Markush view, T6 library screen, T7 design-around (needs T1, T2), T8 disclosure + white-space,
T9 expiry + similar patents.
Wave 3 (facade and everything): T10 `LnpAPI` + context packs + tools hub, T11 MCP server + `docs/INTEGRATION.md`,
T12 FTO chain / product profile integration of ranges and Markush evidence.

(The task ids in the returned task list are authoritative; section 7 maps files to them.)

## 6. Tests per task

Each task writes its own test file under `tests/` (`tests/<name>_test.cjs` or `.mjs`, Node 22, no new npm packages) and
runs it; Playwright tests use `require('playwright')`, a scratch dist and `tests/artifact_server.cjs`, a mocked
`window.claude` (copy the mock pattern from `tests/e2e.cjs`), check light, dark and 390 px, and assert that no request
leaves the origin. Each task also runs a "no Claude" pass (`window.claude` undefined) and a "null caps" pass
(`claude.use()` resolves null). Results are reported honestly: what ran, what was skipped, timings.

## 7. File ownership (existing files may only be edited by the named task)

| Task | New files | Existing files edited (minimal) |
|---|---|---|
| T1 | `web/engine/x-markush.js`, `data/seed/markush/*.json`, `pipeline/markush_seed.py`, `tests/markush_test.cjs`, `docs/MARKUSH.md` | - |
| T2 | `pipeline/ranges_build.py`, `pipeline/lib/ranges_extract.py`, `data/seed/range_params.json`, `web/engine/x-ranges.js`, `web/app/views/ranges.js`, `web/app/x-ranges.css`, `tests/ranges_test.py`, `tests/ranges_test.cjs` | - |
| T3 | `pipeline/tags_build.py`, `pipeline/lib/asg_norm.py`, `data/seed/tag_rules.json`, `data/seed/assignee_aliases.json`, `web/engine/x-tags.js`, `tests/tags_test.py`, `tests/xdata_test.py` | `pipeline/build_dist.py` (xdata hook, `--target`), `pipeline/build_pages.sh` (`--target pages`), `pipeline/run_all.sh` (call the new pipeline steps), `docs/ARCHITECTURE.md` (one new section "Extra data (xdata)") |
| T4 | `web/engine/x-links.js`, `web/engine/x-legal.js`, `web/app/views/legal.js`, `web/app/views/facets.js`, `web/app/x-legal.css`, `tests/hooks_test.cjs` | `web/app/app.js` (`App.ext`), `web/app/views/patent.js` (hook slots), `web/app/views/suche.js` (facet + result hooks), `web/app/views/struktur.js` (compound hook) |
| T5 | `web/app/views/markush.js`, `web/app/x-markush.css`, `tests/markush_view_test.cjs` | - |
| T6 | `web/engine/x-screen.js`, `web/app/views/screen.js`, `web/app/x-screen.css`, `tests/screen_test.cjs` | - |
| T7 | `web/engine/x-designaround.js`, `web/app/views/designs.js`, `web/app/x-designs.css`, `data/seed/design_space.json`, `tests/designaround_test.cjs` | - |
| T8 | `web/engine/x-disclosure.js`, `web/app/views/disclosure.js`, `web/app/views/whitespace.js`, `web/app/x-chemmaps.css`, `tests/disclosure_test.cjs` | - |
| T9 | `web/engine/x-expiry.js`, `web/engine/x-similar.js`, `web/app/views/expiry.js`, `web/app/views/similar.js`, `web/app/x-expiry.css`, `tests/expiry_similar_test.cjs` | - |
| T10 | `web/engine/x-zapi.js`, `web/engine/x-context.js`, `web/app/views/tools.js`, `web/app/x-tools.css`, `docs/LNPAPI.md`, `tests/api_test.cjs` | - |
| T11 | `mcp/server.mjs`, `mcp/lib/*.mjs`, `mcp/package.json`, `mcp/README.md`, `docs/INTEGRATION.md`, `tests/mcp_test.mjs` | - |
| T12 | `tests/fto_evidence_test.mjs` | `web/engine/fto.js`, `web/engine/fto-render.js`, `web/app/views/produkte.js`, `docs/method/FTO_METHOD.md` (one subsection) |

## 8. Dropped or deferred (not buildable now)

- Semantic / embedding search and embedding-based white-space maps: needs a model in the page (ONNX/wasm is not allowed
  by the CSP) or precomputed vectors (tens of MB); BM25 more-like-this plus chemistry and CPC overlap covers "similar".
- Offline OCSR (MolScribe / DECIMER) at build time: ML stack, GPU/RAM not available; replaced by on-demand Claude OCSR
  validated by OpenChemLib, with "machine-extracted" marking.
- Orange Book / Purple Book overlay and PTE/SPC dates: no such data in the corpus; most LNP products are biologics (no
  Orange Book patent lists); SPCs are national registers without a key-free bulk source. Expiry shows "PTE/SPC not
  checked".
- PTAB / litigation layer, assignment (ownership transfer) data, citations: not in our data; need new fetchers (and for
  citations an OPS key); the fetch jobs must not be disturbed now.
- Prosecution history digest (file wrapper documents): we hold register events only; the timeline uses those and says so.
- Sequence search and SEQ ID mapping: the corpus has no sequence listings.
- CN/JP/KR translation: the corpus has EN/DE text only.
- Monitoring with push alerts, real-time collaboration: need a server. (Saved-search rerun diff already exists.)
- Claude tagging at build time: there is no model at build time; tags are rule-based from data files.
- Patent strength scoring, image search, reaction search, inventor networks (no inventor field): low value or no data.
