# About the data

What the LNP Patent Desk holds, where it comes from, how it was processed, and what is missing. Every number
below was read from the pipeline code, its summary files or the build manifests of the last complete builds. Where
something could not be determined it says so. The results of the tool are a pre-screening, not legal advice.

**Snapshot.** Both builds described here were made from the same corpus file, written 2026-11-12 08:30 UTC:
the claude.ai Artifact build (`dist/`, built 2026-11-12 08:58 UTC) and the website build (`dist-pages/`,
built 2026-11-12 08:58 UTC). The US full-text download (`pipeline/fetch_us.py`) continues after these builds, so
the US numbers grow with the next build. All counts are for that snapshot.

| Source snapshot | Date |
|---|---|
| SureChEMBL bulk release (field subset, compounds) | 2026-11-03 |
| Field discovery (EPO and USPTO searches) | 2026-11-10 |
| EP Register legal-status snapshot | 2026-08-23 (53,602 records) and 2026-08-27 (8,431 records) |
| EP full text (EPO Publication Server) | last download 2026-11-11 |
| US full text (USPTO Patent Public Search) | last download in the build 2026-11-12, still running |
| Corpus (normalised records) | 2026-11-12 08:30 UTC |

Abbreviations: EP = European patent (EPO), US = United States patent (USPTO), WO = international (PCT) application
published by WIPO. CPC / IPC = patent classification codes. A1/A2 = published application, B1/B2 = granted patent.
LNP = lipid nanoparticle. BM25 = a standard ranking formula for text search.

## 1. Scope: how the corpus was defined

The corpus is the union of five discovery routes (`pipeline/discover.py`, `pipeline/discover_us.py`). It covers three
offices only: EP, US and WO. Publication dates run from 1979 (EP, WO) and 1910 (US, a few old references) to
2026-11-11 (EP), 2026-11-05 (US) and 2026-10-29 (WO). There is no date floor in any query.

1. **SureChEMBL field subset** (51,121 publications, 16,074 families). From the SureChEMBL bulk release 2026-11-03
   all EP/US/WO rows with a CPC or IPC code starting with `A61K 9/51`, `A61K 9/127`, `C12N 15/88`, `A61K 47/69`,
   `A61K 47/54`, `A61K 48/00`, `A61K 31/7105`, `A61K 31/7088`, `C07C 219/`, `C07C 229/`, `C07C 217/` or
   `C07C 271/` were taken and given a tier:
   - tier 1: an LNP-specific code (A61K9/5123, 9/1271, 9/1272, 47/6911, 47/6929, 47/543, 47/544, C12N15/88);
   - tier 2: a nanoparticle / liposome / transfection code together with lipid chemistry (C07C groups above, any
     C07D), A61K48 or an RNA payload code;
   - tier 3: one of the four amino-lipid C07C groups together with A61K47/69, 47/54, A61K48 or an RNA code;
   - tier 4 (compound-driven): publications outside tiers 1-3 that, according to SureChEMBL, name at least one of
     3,205 "marker lipids" in their claims or at least 10 of them anywhere. A marker lipid is a compound of molecular
     weight 350-1500 with a long carbon chain and nitrogen, no phosphorus, seen in at least 5 core families, with at
     least 30 % of all its SureChEMBL patents inside tiers 1-3.
2. **EPO Linked Open EP Data (SPARQL)**: every EP application classified (inventive or additional) in one of 39 core
   CPC codes (43 core codes of `data/seed/cpc_field.json` minus four mixer / microfluidics codes that are too broad
   alone): 30,829 applications. The codes are A61K9/127, 9/1271, 9/1272, 9/1277, 9/1278, 9/51, 9/5123, 9/5192, 9/19,
   A61K47/10, 47/14, 47/18, 47/22, 47/24, 47/28, 47/543, 47/544, 47/60, 47/6911, 47/6929, A61K48/0008, 48/0025,
   48/0033, 48/0041, C12N15/88, C12N2320/32, C07C229/12, 229/16, 219/06, 235/06, 271/20, C07D295/13, B01F25/433,
   B01F23/41, B01F25/23, B01F2101/22, B01J13/02, B01J13/04, B82Y5/00. No keyword filter is applied to EP.
3. **EPO Publication Server IPC search** (granted B publications only) for 16 IPC symbols (A61K9/127, 9/51,
   C12N15/88, A61K47/18, 47/24, 47/28, 47/54, 47/69, A61K48/00, C07C229/12, 229/16, 219/06, 235/06, 271/20,
   C07D295/13, B82Y5/00): 9,470 publication numbers.
4. **USPTO Patent Public Search ("ppubs")**, grants (USPAT) and pre-grant publications (US-PGPUB), 60 queries:
   - 11 core CPC codes alone (A61K9/5123, 9/1271, 9/1272, 9/1277, A61K47/6911, 47/6929, 47/543, 47/544, C12N15/88,
     A61K48/0033, 48/0041);
   - 9 broad CPC codes (A61K9/51, 9/127, A61K47/18, 47/22, 47/24, 47/28, A61K31/7105, 31/7088, 31/713) AND an LNP
     word in the claims: `"lipid nanoparticle" OR LNP OR "cationic lipid" OR "ionizable lipid" OR "amino lipid" OR
     "nucleic acid-lipid particle" OR "nucleic acid lipid particle" OR liposom$`;
   - A61K39 AND `mRNA NEAR5 "lipid nanoparticle"` in the claims; C12N15/113 AND "lipid nanoparticle(s)" in the claims;
   - 10 chemistry classes (C07C219, 229, 217, 271, 323, C07D295, 207, 211, 233, C07F9/10) AND a delivery word anywhere
     (the list above plus `lipid NEAR3 (delivery OR nanoparticle OR particle)`);
   - 3 manufacturing classes (B01F33/30, B01F25/43, B01L3/5027) AND `"lipid nanoparticle" OR liposom$ OR "nucleic
     acid" OR "lipid particle"` in the claims;
   - 20 company groups by assignee name (regexes in `data/seed/assignee_variants.json`) AND `lipid OR nanoparticle
     OR liposom$` in the claims;
   - the US numbers of the seed families (5 queries of up to 20 numbers).
   Union: 45,156 publications (17,229 grants, 27,927 pre-grant), of which 25,491 were not known from SureChEMBL.
5. **Seed families** (`data/seed/seed_families.json`): 62 hand-picked key families (19 tier 1, 43 tier 2) with
   126 member publications (39 EP, 87 US). All 126 are in the corpus.

All EP publications (every kind code) of every EP application found by any route are rows of the table.
Result: **125,104 publications** (EP 62,091, US 49,706, WO 13,307) in **52,620 families**.

| Corpus tier | Publications | Meaning |
|---|---|---|
| 1 | 39,223 | SureChEMBL tier 1 (EP siblings inherit the tier of their application) |
| 2 | 6,781 | SureChEMBL tier 2 |
| 3 | 935 | SureChEMBL tier 3 |
| 4 | 4,916 | SureChEMBL tier 4 (compound-driven) |
| 5 | 73,249 | found only by the EPO / USPTO class and keyword searches |

## 2. Sources and access

| Source | Access | What it gives | Rate limits and failures met |
|---|---|---|---|
| SureChEMBL bulk data (EMBL-EBI, CC BY 4.0), release 2026-11-03 | parquet files over HTTPS (range requests, one full 5.15 GB download of the patent-compound map) | publication list with CPC, family id, assignee, title; compounds (SMILES, InChIKey, weight) and where in each publication SureChEMBL found them | no failures logged under `data/logs` |
| EPO Linked Open EP Data | SPARQL endpoint `data.epo.org/linked-data` | EP applications by CPC, publications and kind codes, filing and grant dates, DOCDB family, English title, applicants, CPC | all responses cached; 12 EP numbers could not be tied to an application |
| EPO Publication Server | REST `data.epo.org/publication-server` | search by IPC and number (kind codes, file sizes); full-text `document.xml` of B and A publications; `document.zip` for claim formula images | full text: 21,401 of 21,401 wanted documents downloaded, 0 failures (the server reports a weekly quota; it was never close to its limit). Images: the run stopped on HTTP 429 (throttled) on 2026-11-12 01:11 after 2,008 documents (2,007 OK, 1 failed with 429) |
| EP Register | public ST.36 snapshot (EPO bulk data product 16, about 14.8 GB ZIP), read chunk by chunk with range requests | procedural status, opposition, appeal, lapses, renewal fees, unitary effect, designated states | 38,578 of 38,614 EP applications found; 36 publications fall back to the Publication Server XML |
| USPTO Patent Public Search (ppubs) | the JSON API behind ppubs.uspto.gov | search hits (biblio, CPC, family id); full text: claims, abstract, description, assignee, related-application chain, patent term adjustment (PTA) | many HTTP 429 answers (7,376 retry lines in the fetch log, each retried after a pause); of 20,666 documents tried by 2026-11-12 08:46 UTC, 71 lines report HTTP 404 "not found" and 9 an empty document (19 documents never succeeded) |
| Google Patents | single pages, not bulk | only to check the 62 seed families (status notes dated 2026-11-10) | not used for the corpus |

Not used: EPO OPS (needs a key; no OPS data is in this build), USPTO Open Data Portal, Lens, WIPO PATENTSCOPE full
text. All requests are sequential with a pause of at least 1.1 s per host and a generic user agent
(`pipeline/config.py`); every raw response is cached before parsing.

## 3. Coverage

### 3.1 What the corpus holds (both builds, before any size cut)

| | EP | US | WO | All |
|---|---|---|---|---|
| Publications | 62,091 | 49,706 | 13,307 | 125,104 |
| Families (distinct ids, offices overlap) | 35,716 | 22,520 | 11,878 | 52,620 |
| Full text wanted by the fetch rules | 21,401 | 28,674 | 0 | 50,075 |
| Full text downloaded and parsed | 21,401 (34.5 %) | 20,310 (40.9 %) | 0 | 41,711 (33.3 %) |
| ... of what was wanted | 100 % | 70.8 % | - | 83.3 % |
| With claims | 21,387 (34.4 %) | 20,291 (40.8 %) | 0 | 41,678 (33.3 %) |
| Claims (EN + DE counted separately) | 613,169 | 505,658 | 0 | 1,118,827 |
| With English claims / German claims | 21,341 / 18,904 | 20,291 / 0 | 0 | |
| With definition paragraphs | 19,537 (31.5 %) | 19,936 (40.1 %) | 0 | 39,473 (31.6 %) |
| With an abstract | 2,542 | 20,310 | 0 | 22,852 |
| With a legal-status record | 62,069 (99.96 %) | 20,339 (40.9 %) | 13,307 (placeholder only) | 95,715 (76.5 %) |
| Linked to extracted compounds | 8,603 (13.9 %) | 16,277 (32.7 %) | 8,378 (63.0 %) | 33,258 (26.6 %) |
| Formula image placeholder in an independent claim | 4,024 | 5,046 | - | 9,070 |
| With formula images downloaded | 2,007 | 0 | - | 2,007 |

Percentages are of all publications of that office unless stated. "Full text wanted": EP = the latest B
publication of each application, or the A publication when there is no B, the application was filed in 2017 or
later and the A has its own text; US = every grant, and a pre-grant publication only when it was published in 2018 or
later and its application has no grant. WO is never fetched. The rest of the 125,104 rows are bibliographic records
(number, dates, title, assignee, CPC, family, status).

Why EP rows without full text: 18,859 EP applications have a B publication (only the latest B is fetched; the other
kinds of the same application stay biblio-only; in all, 40,690 EP rows have no full text); 10,268 applications have no B and were filed
before 2017; 6,956 applications have only a Euro-PCT A publication without its own text (the text is the WO
pamphlet); 1 has no A publication.

The US full text is incomplete because the download runs in priority order: seed families first, then lipid-specific
classes, then other core classes, newest first within each band. At the snapshot the bands with seed, lipid-specific
or core-class publications were nearly complete (16,756 of 16,772); the lowest band (publications without a core CPC code)
had 3,554 of 11,902. By year of publication, US full text covers 13,419 of 18,412 publications of 2020-2026 but only
4,299 of 19,729 of 2010-2019. The download continues: at 2026-11-12 08:46 UTC the cache held 20,647 US documents;
the next build picks up the new ones.

### 3.2 Artifact build versus website build

| | Artifact build (`dist/`) | Website build (`dist-pages/`) |
|---|---|---|
| Size budget | 215 MB (host limit 240 MB, 500 files, 15 MB per file); data as base64 text, which is about a third larger | 900 MB budget; raw binary files |
| Built size / files | 214.67 MB / 460 files | 438.63 MB / 623 files |
| Publications in the table and searchable by title, abstract, assignee | 125,104 | 125,104 |
| Publications with claims in the build | 28,523 of 41,678 (68.4 %): EP 10,311 (48.2 %), US 18,212 (89.8 %) | 41,678 (100 %) |
| Claims in the search index | 730,863 | 1,118,827 |
| Publications with definition paragraphs | 5,218 of 39,473 (13.2 %): EP 971, US 4,247 | 39,473 (100 %) |
| Search index | 1,025,300 searchable units, 313,840 terms | 1,413,264 units, 426,591 terms |
| Formula images | 4,943 images of 181 publications (25 MB image budget; 37,870 images left out) | 42,813 images of 2,007 publications |
| Compounds | 84,691 | 84,691 |
| Range quotes | not shipped as a file; cut from the claim text when it is in the build | separate quote file (`ranges-q.gz.bin`) |
| Claude features (AI search help, FTO analysis, Markush translation, reading formula images) | yes | no (manual modes only) |

The text cut of the Artifact build (`pipeline/build_dist.py`): seed-family publications always keep claims and
definitions; then claims are kept by priority (seed tier, then tier 0 to 5, newest first); then definition
paragraphs in the same order, with 10 MB reserved for them. In this build all 13,155 publications that lost their
claims (EP 11,076, US 2,079; 387,964 claims, 117.0 million characters) were tier 5, the oldest of that tier:
published from 1976-01-13 to 2019-10-16 (first cut: EP2948477B1, last kept: EP2921171B1, both of 2019-10-16). 34,255
publications lost their definition paragraphs (22,551 of them kept their claims). The cut shifts by a few hundred publications
between builds; the System view shows the exact figures of the build in use. A
publication that lost its claims stays in the table with its biblio data, status and compounds, can be found by
title, abstract or assignee, and is flagged "text cut" in the app. The full list is written to
`data/work/dist_build/cut.jsonl`.

## 4. Processing

**Normalisation** (`pipeline/normalize.py`, `pipeline/lib/norm_doc.py`, `norm_text.py`, `epo_pubserver.py`,
`us_parse.py`). One JSON record per publication. EP: claims in English and German are kept, French is dropped (an
A publication with French claims only keeps no claims: 14 EP full texts have no claims, 46 have German claims
only). US: canceled claims are dropped; claim dependencies are parsed (with a fallback for typos such as "claim of
1"); line numbers that old OCR'd US texts carry inside sentences are removed. Formula images in claims become the
placeholders `[chem]` (EP, image id kept) or `[STR]` (US); tables in EP XML are flattened to text with cells
separated by `|`. The description itself is not stored: only "definition paragraphs" (description paragraphs with
defining phrases such as "as used herein", "refers to", "bezeichnet", or field words such as pKa, mol %, N/P), at
most 8,000 characters per publication. Assignees are cleaned (country tails removed, banks and agents dropped); for
EP B publications the proprietors at grant are used. Twenty company groups ("players") are assigned by regex.

**Families.** The DOCDB simple family id (same priority claims) from SureChEMBL, the EPO linked data or ppubs; when
missing, a family is linked through the PCT publication number; otherwise a synthetic family per application (EP
6,308 records, US 32, WO 15). Simple families do not join continuation-in-part or other filings with different
priorities.

**Legal status** (`pipeline/status.py`). EP: EP Register snapshot (status text, opposition and its outcome, appeal,
lapses in states, renewal fees, unitary effect); 36 EP publications without a register record get "published
application" from the Publication Server XML; 22 EP publications have no status record. Expiry is estimated as
filing date + 20 years. US: no status source is used; for downloaded documents the expiry is computed as the
earliest non-provisional effective filing date along the continuation/division chain + 20 years + PTA days. A grant
is shown as "granted (maintenance fees not checked)", a pre-grant publication as "pending/published (grant status
not checked)" unless the same application's grant is in the corpus. WO: "PCT publication, no rights".

| Status code | EP | US |
|---|---|---|
| granted | 21,002 | 8,402 |
| pending | 8,356 | 10,073 |
| expired | 17,837 | 1,861 |
| withdrawn | 12,572 | 1 |
| revoked | 1,074 | 0 |
| refused | 906 | 0 |
| lapsed | 322 | 2 |

EP oppositions in the register data: 2,995 opposed patents (1,245 revoked, 1,112 maintained as amended, 341
oppositions rejected, 168 pending, 129 without an outcome), 1,752 with an appeal, 2,182 with unitary effect.

**Search index** (`pipeline/build_index.mjs`, tokenizer `web/engine/tok.js`, the same file in the browser). BM25
(k1 = 1.2, b = 0.75) over separate units: English title, German title, abstract, assignee names, and every claim
(English and German), with positions for phrase search and a flag for independent claims. Tokens: Unicode
decomposed, accents removed, lower case, ß to ss, tokens are runs of `a-z` and `0-9` only, at most 40 characters;
a short English/German stop-word list is not indexed but keeps its position. There is no stemming. Definition
paragraphs and CPC codes are not in the text index (CPC is a filter, definitions are shown on the patent page and
given to the FTO analysis).

**Compounds** (`pipeline/chem_export.py`, `pipeline/chem_build.cjs`). The structures are SureChEMBL's: SureChEMBL
extracts compounds from the patent text (chemical names and identifiers), from images and from attached MOL files with
its own automated methods (not re-checked here), and its map records where each compound was found (claims, description, abstract, title, image, MOL file). This tool runs
no name-to-structure conversion and no image recognition at build time. From the subset, only "lipid candidates"
are kept: molecular weight 350-1500, a long carbon chain in the SMILES, and either found in at most 2,000 patents
worldwide or with at least 5 % of its patents in the LNP core (this removes common solvents, salts and small drugs).
84,913 such compounds were parsed with OpenChemLib 8.21.0 (0 unparsable) and merged by canonical structure to
84,691 unique compounds in 53,882 scaffolds, linked to 33,258 publications (1,061,376 compound-publication links).
SureChEMBL found 8,799 of them in claims; 35,730 were found only in images or MOL files, not in the text. Per
compound the build computes the OpenChemLib substructure index, a fingerprint for similarity, molecular weight,
cLogP and lipid descriptors (head group class, tails). 20 reference lipids (MC3, ALC-0315, SM-102 ...) carry names
and synonyms (`pipeline/chem_names.cjs`; 19 of them match a compound of the set; the CAS numbers there were not
re-checked against a registry).

**Numeric ranges** (`pipeline/ranges_build.py`, `pipeline/lib/ranges_extract.py`, vocabulary
`data/seed/range_params.json`). Rule-based, no model: numbers, units, "about", comparators and "between ... and"
are read from English claims (German claims only for a publication without English claims). 14
parameters: mol %, wt %, molar ratio, weight ratio, N/P ratio, particle size (nm), PDI, pKa, encapsulation %,
temperature, pH, carbon chain length, PEG molecular weight, concentration. 830,138 claims read, 334,677 range rows
in 99,964 claims of 24,041 publications; 5,157 repeated claim numbers were skipped. Each row keeps the offset of the
match in the claim, so the quote shown is cut verbatim from the claim text; a quote stored in the file is checked
against the claim text when the claim is in the build.

**Tags** (`pipeline/tags_build.py`, rules `data/seed/tag_rules.json`). 33 rule-based tags (payload such as mRNA,
siRNA, CRISPR; route such as IV, IM, inhalation; lipid type; indication; process) from regexes on English/German
claims, title and abstract, CPC prefixes and the descriptors of linked compounds; 87,784 publications have at least
one tag. Legal bits (opposition, revoked, maintained, appeal, unitary, lapsed) come from the status records.

**Assignee normalisation** (`pipeline/lib/asg_norm.py`, aliases `data/seed/assignee_aliases.json`): spelling variants
are reduced to one canonical name (16,568 canonical names; 122,421 publications have an assignee).

**Markush records** (`pipeline/markush_seed.py`): 5 hand-written ("curated") records for 5 claims of 5 publications
(EP2350043B9, EP3221293B1, EP3350157B1, EP3368507B1, EP3766916B1), 39 variables. The script checks every
definition quote verbatim against the stored claim text. Any other Markush claim is checked only if a user (or, in
the Artifact, Claude) translates it into a record first.

## 5. What is missing, and what cannot be indexed

- **Other offices**: no CN, JP, KR, DE national, other national patents or utility models; no WO full text (WO
  publications are biblio + compounds; the EP or US family member supplies the claims).
- **Languages**: EP claims in English and German only; French claims are dropped. Characters outside a-z and 0-9
  (Greek letters, ≤, °, superscripts) are not searchable as such.
- **Descriptions**: the description is not searchable; only selected definition paragraphs (at most 8,000
  characters) are kept. Examples, tables and figures of the description are not in the corpus.
- **Full text not (yet) downloaded**: US 8,364 wanted documents were missing at the snapshot (the download continues);
  19 US documents could not be fetched (404 or empty); EP applications without a B filed before 2017 and Euro-PCT
  stubs have no text (see 3.1).
- **Structures in images**: claim formula images are not read at build time (no OCR / structure recognition). Images
  were downloaded for 2,007 of 4,024 EP publications with formula images in an independent claim (stopped by
  HTTP 429); US formula images are not downloaded. In the Artifact, Claude can read a formula image on request
  (marked "machine-extracted", parsed by OpenChemLib).
- **Compounds**: only SureChEMBL's extraction, and only lipid candidates (see 4); polymers such as full-length PEG
  lipids have no discrete structure; compounds SureChEMBL missed are missing here. Compound links exist for
  publications in the SureChEMBL release only.
- **Markush scope**: no Markush search (no MARPAT or similar); generic claims are matched only through the 5 curated
  records or a record made on demand.
- **Sequences**: no sequence listings, no sequence search.
- **Legal status**: EP Register as of 2026-08-23 / 2026-08-27 only; national lapses reach the register only when
  notified; no SPC (supplementary protection certificates) or PTE (US term extension); no US maintenance fees,
  terminal disclaimers, assignments, re-examination, IPR/PTAB or litigation; US status only for downloaded
  documents (20,339 of 49,706); UPC opt-outs are not recorded.
- **Ownership**: assignees are as published (EP proprietor at grant, US assignee at issue); later transfers are not
  tracked.
- **Citations, inventors, prosecution files**: not in the corpus.
- **Unpublished applications**: anything filed in roughly the last 18 months is not yet public.

## 6. Known error sources

| Source of error | Effect | What checks it |
|---|---|---|
| Discovery by classes and keywords | relevant patents with unusual classes or wording are missing; tier 5 contains off-topic patents (EP has no keyword filter) | seed families: all 126 found |
| Fetch rules | only the latest B of an EP application is read; claims of earlier B1 or of the A may differ | - |
| French-only or image-only claims | claim text missing or with `[chem]` / `[STR]` gaps | `has_chem_img` flag, image placeholders shown |
| SureChEMBL extraction | wrong or missing structures from names and images (its own automated method) | parsed by OpenChemLib; where-found flags shown |
| Lipid-candidate filter | compounds outside MW 350-1500 or without a long chain are not in the set | - |
| Range parser | missed or misattributed ranges (component = nearest component word; bare "%" has no basis; "about" taken literally) | quote cut verbatim at the stored offset |
| Tags | regex rules can over- or under-tag | rule tests on synthetic records (`tests/tags_test.py`); random spot-check sample printed by `tags_build.py` |
| Families | simple families only; synthetic families for 6,355 records | - |
| Status age | EP Register snapshot about 2.5 months older than the build; US status is a calculation | status date shown with every status |
| Artifact text cut | 13,155 publications without claims in the Artifact | "text cut" flag; website build has them |

What code decides and what Claude does: quotes in an FTO analysis must be substrings of the claim text (checked in
`web/engine/fto.js`); numeric ranges are extracted and compared in code; structure and Markush matches are computed
with OpenChemLib. Claude (Artifact build only) translates and explains: it maps claim features to the product,
translates a Markush claim into a record (marked "not reviewed") and can read a formula image (marked
"machine-extracted"). Its verdicts are a pre-screening, not legal advice.

## 7. Reproduce or update

The raw data (`data/`) is not in git; the pipeline fetches it again. Discovery: `python3 -I pipeline/discover_us.py`
then `python3 -I pipeline/discover.py`; downloads: `pipeline/fetch_ep.py`, `pipeline/fetch_us.py`,
`pipeline/status.py` (EP Register), `pipeline/fetch_ep_images.py`; all are resumable and cache every response.
Build: `pipeline/run_all.sh` (normalise, status, chemistry, ranges, tags, Markush records, Artifact build in
`dist/`) and `pipeline/build_pages.sh` (website build in `dist-pages/`). The SureChEMBL subset is cut once with the
probe script `build_subset.py` (kept under `data/probe/`, not in git). Counts of a new build are in
`dist/data/manifest.json` (`counts`, `cut`, `x`) and on the System page of the app.
