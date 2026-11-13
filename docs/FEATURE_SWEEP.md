# Feature sweep: patent search and FTO pre-screening tools (chem / pharma / biotech)

Date: 2026-11-11. Purpose: make sure the next build of our LNP patent search and FTO pre-screening app omits no important function.

Method and caveats. Research was done by web search over vendor pages, help centres, registries and a few independent reviews. Most commercial feature claims are vendor marketing; where a number or capability has no independent check it is marked **(M)**. Where a search returned nothing for a tool (Cypris, Tradespace, Cortellis expiry/SPC detail, Espacenet and Google Patents chemistry, DrugPatentWatch product page, IFI Claims API) this is stated rather than guessed, and the "which tools" column leaves those tools out. Our current state is taken from the task brief.

Legend. Have: yes / partial / no. FTO value: H / M / L. Buildable: yes / partly / no on our static, browser-only LNP corpus with optional Claude calls.

## 1. Feature matrix

### 1.1 Search

| Feature | Tools | Do we have it | FTO value | Buildable here |
|---|---|---|---|---|
| Boolean, phrase, proximity, field search | Orbit, PatBase, Derwent, Lens, Espacenet, PATENTSCOPE, Google Patents, STN | yes | H | yes (done) |
| Semantic / neural ranking | Amplified, IPRally, XLSCOUT, Patsnap, Solve, Patlytics, NLPatent (all M) | no | M | partly: precompute embeddings offline (build step), ship ANN index or small quantised vectors; browser query embedding needs a small ONNX model in the page or a Claude call |
| Graph-based similarity (claims as concept graphs) | IPRally (trained on examiner citations, M) | no | M | no (proprietary model); approximate with claim-element embeddings |
| Query by example document / "find similar" | Ambercite, Google Patents "similar", Amplified, IPRally, XLSCOUT Novelty Checker | no | H | yes: embeddings or TF-IDF over claim 1 + abstract; also CPC and shared-compound overlap |
| Citation search (forward/backward, cited-by) | Espacenet (citation export), Google Patents, Lens, Orbit, Ambercite, Derwent | no | M | partly: only if citations are in our data; add from EPO OPS / Lens at build time |
| Classification browse (CPC/IPC tree + search) | Espacenet, Orbit, STN thesauri, PatBase | partial (facets only) | M | yes: ship CPC scheme titles, tree facet, co-classification counts |
| Number search / bulk number list | all | partial | M | yes |
| Saved searches, alert on new hits | all commercial | partial (saved, no alerts) | M | partly: browser-only cannot push; offer rebuild-time diff or exported feed (see 1.7) |
| Search-in-image (drawing search) | IPRally (image search, M) | no | L | no |

### 1.2 Chemistry

| Feature | Tools | Have | FTO value | Buildable |
|---|---|---|---|---|
| Exact / substructure / similarity structure search | Orbit Chemistry, PatBase Chemical Explorer (Tanimoto ranked), PATENTSCOPE (exact + substructure since 2019), SureChEMBL, Patsnap, CAS | yes (85k compounds) | H | yes (done) |
| Where-found flag (claims / description / drawing) | SureChEMBL, PATENTSCOPE (title/abstract/claims/description) | yes | H | yes (done) |
| True Markush search (generic structure retrieval) | CAS MARPAT, Derwent DWPIM (>2.4M Markush records), Orbit (drawing-based, "not indexed" per help), Patsnap (OCSR-based, M) | no | H | partly: no curated Markush index exists. Parse claim text R-group definitions with Claude into structured Markush (core SMILES + R-group lists), enumerate or match with RDKit-WASM substructure with R-group constraint. Quality needs per-patent validation. |
| Markush enumeration / coverage test ("is my compound inside this Markush?") | MARPAT, DWPIM, Orbit enumeration | no | H | partly: for a given patent, Claude extracts Markush, deterministic check via RDKit.js; this is the single most FTO-relevant chemistry check |
| R-group / SAR analysis, scaffold and series analysis | Patsnap Lead Compound Analyzer (M), Reaxys, Orbit | no | M | yes: Murcko scaffold clustering with RDKit.js over our 85k compounds, per-patent scaffold table |
| Reaction search | Reaxys, SciFinder (CAS) | no | L for LNP (lipid synthesis routes only) | no, out of scope |
| Name-to-structure and structure-to-name | PATENTSCOPE (name or InChI/InChIKey input), SureChEMBL, PubChem | partial | M | partly: bundle OPSIN-JS or call PubChem PUG-REST; IUPAC name extraction is already implied by our corpus |
| OCSR / image-to-structure | SureChEMBL (EPO/WIPO from images), Patsnap (95.5% precision claimed, M), PATENTSCOPE (drawings), Minesoft | partial (claim formula images shown, no OCSR) | H | partly: run MolScribe / DECIMER offline at build time on formula images, store SMILES with a confidence flag; SureChEMBL notes image-to-structure errors, so mark as machine-extracted |
| Compound-to-patent linking | SureChEMBL, PubChem (767M links, 37M structures, 25M patents from Google Patents), Reaxys | yes | H | yes (done); add PubChem/ChEMBL cross-links by InChIKey |
| Property filters (MW, logP, lipid class, ionisable amine pKa) | Reaxys, Patsnap, Orbit | no | M | yes: compute with RDKit offline; filter facets; LNP-specific classes (ionisable lipid, PEG lipid, helper) |
| Polymer / PEG-lipid handling (variable chain lengths) | MARPAT excludes some classes (alloys, polymers, salts) | no | M | partly: normalise repeat-unit notation in a dedicated field |
| Chemical name text indexing (synonyms, trade names) | PATENTSCOPE, Minesoft, SureChEMBL | partial | M | yes |

### 1.3 Biologics and nucleic acids

| Feature | Tools | Have | FTO value | Buildable |
|---|---|---|---|---|
| Sequence search (BLAST-style) on patent sequences | Lens PatSeq Finder (BLAST+, free; one paper reports 147M sequences, old snapshot), Patsnap Bio (1.5B sequences claimed, M), EBI patent sequence data | no | H for mRNA / siRNA payloads | partly: ship only sequences from our LNP corpus (small); k-mer index in-browser, or deep-link to PatSeq for the full universe |
| Exact-claim sequence match (SEQ ID in claims) | Patsnap Bio, STN | no | H | yes: parse SEQ ID NO references in claims, map to sequence listing |
| Chemical-modification filters (2'-OMe, PS, N1-methylpseudouridine) | Patsnap Bio (alignment direction and chemically modified filters, Oct release) | no | H for mRNA/siRNA | yes: regex/ Claude tagging of modified nucleotides in claims |
| CDR / antibody search | Patsnap Bio, PatSeq text search by species | no | M (out of LNP core) | partly |
| Codon-optimised / UTR / cap analog family detection | none observed | no | M | partly (see opportunities) |

### 1.4 Legal status and regulatory

| Feature | Tools | Have | FTO value | Buildable |
|---|---|---|---|---|
| Legal status (family-wide) | Derwent (AI-derived DWPI/INPADOC status), Espacenet (INPADOC legal events), Orbit, PatBase, Google Patents; always verify at national register | partial (EP Register) | H | partly: EP Register is covered; US via USPTO Patent Center / PEDS, other offices via INPADOC/OPS at build time |
| Expiry estimate incl. PTE / PTA / SPC | DrugPatentWatch (marketing blog claims; Orange Book dates), Cortellis Product Intelligence (LOE and patent strength score, per webinar page), Orbit | partial (estimate only) | H | partly: PTA from USPTO data (PEDS), PTE from FDA/ Orange Book, SPC from national registers. EU SPC is national; centralised SPC register is only proposed (Council 2025 notes) |
| Orange Book / Purple Book linkage | DrugPatentWatch, FDA OB (public), Cortellis | no | H (for approved LNP products, e.g. COVID mRNA vaccines are biologics so Purple Book has no patent list; Orange Book covers small-molecule NCE only) | yes for OB: FDA OB data file is public; note most LNP products are biologics, so Purple Book "patent list" only exists via BPCIA exchanges |
| Oppositions / EPO opposition status | EP Register (federated), Orbit, PatBase | partial | H | yes: EP Register events already parsed; add opposition parties, outcome, appeals |
| PTAB / IPR / litigation | Derwent, Orbit, Lex Machina-type tools, DrugPatentWatch (docket reconciliation blog), Robins Kaplan quarterly ANDA bulletins | no | H | partly: CourtListener / PTAB API public data; map by patent number |
| Licensing and assignments | Orbit, PatSnap, Derwent, USPTO assignment DB | no | M | partly: USPTO assignment data; EP Register transfers |
| Patent strength / value scoring | PatentSight (LexisNexis, Patent Asset Index), Cortellis patent strength score | no | L | no for score; partly for simple proxies |
| Paediatric extension and data exclusivity | DrugPatentWatch, Cortellis | no | M | partly |

### 1.5 Analytics

| Feature | Tools | Have | FTO value | Buildable |
|---|---|---|---|---|
| Landscape charts, trends | all commercial | yes | M | yes (done) |
| White-space / topic maps (embeddings, clustering) | Patsnap, Orbit, XLSCOUT, Amplified | no | M | yes: precomputed 2D UMAP of claim embeddings |
| Citation graph | Google Patents, Lens, Orbit, Ambercite | no | M | partly |
| Family graph | Espacenet, Orbit | partial (family + compare) | M | yes |
| Assignee normalisation, ultimate parent | PatentSight (current assignee weekly, via Reaxys), Orbit, Derwent | partial/unknown | H (who to approach for licence) | partly: build alias table; M&A parent needs external data |
| Inventor networks | Orbit, Patsnap | no | L | yes |
| Claim-scope comparison across patents | Solve, Patlytics (M) | partial (family compare) | H | yes: Claude-based, extend family compare to any two patents |
| Technology classification (LNP lipid class, payload, route, target organ) | none specific | no | H | yes: Claude tagging at build time (opportunity 1) |

### 1.6 FTO workflow

| Feature | Tools | Have | FTO value | Buildable |
|---|---|---|---|---|
| Claim charting, element mapping | Solve, Patlytics, DeepIP, XLSCOUT (all M) | yes (verified verbatim quotes) | H | done |
| Risk scoring / risk matrix | DeepIP (M), Patlytics (M) | yes | H | done |
| Red team / adversarial review | none observed | yes | H | done |
| Claim construction from specification definitions | none observed explicitly | partial (definitions excerpt) | H | yes: extend with "means" tables, prosecution disclaimers |
| Prosecution history / file wrapper | Solve (compiles prosecution histories into FTO, M), USPTO PFW MCP servers (community), EP Register | no | H | partly: EP Register documents and USPTO Patent Center are public; fetch at build time, summarise amendments and arguments, flag estoppel |
| Design-around suggestions | Solve/Patlytics (M, unspecified) | no | H | yes: Claude over charts: which element to vary; cross-check against dependent claims and other families |
| Invalidity / prior-art search for blocking patents | Solve, Patlytics, XLSCOUT Novelty Checker, Orbit | no | H | partly: our corpus prior art only; deep-link NPL searches |
| Jurisdiction scoping (where in force) | Orbit, PatBase | partial | H | yes: per-country status table; SPC overlay |
| Claim dependency tree, multilingual | few | yes (EN/DE) | M | done |
| Report export (md/html/json); DOCX/PDF | Solve, DeepIP (Word integration, M) | partial | M | yes: add DOCX/PDF via browser print |
| Collaboration, review, comments | Orbit, Patsnap, DeepIP | partial (notes) | M | partly: sharing via exported JSON; real-time needs backend |
| Audit trail (inputs, model, prompts, quotes verified) | DeepIP "audit-ready" (M) | partial | H | yes: store prompt hash, model, corpus version, quote-verification result in export |
| Product profile / feature extraction | DeepIP (M) | yes | H | done |
| Client-privacy / no-training assurance | Solve, DeepIP (M) | n/a | H | design point: Claude API data policy, local-only storage |

### 1.7 Monitoring, integrations, AI assistants, coverage

| Feature | Tools | Have | FTO value | Buildable |
|---|---|---|---|---|
| Watchlist, alerts on legal-status / new publications | all commercial; DrugPatentWatch (blog) | partial (watchlist, no push) | H | partly: scheduled build (CI) produces change report; email via external service |
| API / bulk data | Lens (premium API), PatSeq bulk FASTA monthly, SureChEMBL bulk (EBI FTP), EPO OPS, IFI Claims (API not verified here) | no (we are consumers) | M | yes: publish our enriched corpus as downloadable JSON/Parquet |
| MCP / agent access | community USPTO MCP servers (PyPI patent-mcp-server, others); no major vendor MCP verified. A Patsnap blog says EPO/USPTO/Lens lack production-ready MCP (M) | no | M | yes: small MCP over our corpus (search, get claims, compare) |
| Q&A over patents (chat) | Patsnap Eureka, Orbit, Solve, Patlytics | partial (FTO chain only) | M | yes: grounded Q&A with verbatim quote verification |
| Summarisation / plain-language | all AI tools | partial | L-M | yes |
| Translation (CN/JP/KR claims) | Reaxys (titles/abstracts/claims translated to English), Orbit, Patsnap | partial (EN/DE) | H when searching Asian filings | partly: Claude translation with source-text retention; flag machine translation |
| Coverage: patents | Orbit >75M (M), Reaxys 38M+ patents (105 offices), XLSCOUT 136M (M), Minesoft ChemX 88M (M), SureChEMBL five authorities incl. CNIPA | LNP subset only | H | scope decision: coverage statement and "not in corpus" warnings |
| Coverage: non-patent literature | Reaxys, XLSCOUT, Orbit | no | M | partly: link PubMed / bioRxiv by DOI |

## 2. What the free tools already do, and what we should not duplicate

- **Google Patents:** per-document similar documents and citation views are described in a comparison source; it is "an aggregation and search layer, not a system of record" ([CASRAI comparison](https://casrai.org/compare/espacenet-vs-google-patents-vs-uspto-patent-public-search)). I could not verify its chemistry features.
- **Espacenet:** CPC/IPC browse, INPADOC family and legal events, citation and family exports ([WIPO INSPIRE](https://inspire.wipo.int/node/1727)).
- **PATENTSCOPE:** chemical search by name, structure drawing, MOL/SMILES/image upload, substructure since 2019, indexed on InChIKeys, only for "developed formulas" ([WIPO 2016](https://www.wipo.int/en/web/patentscope/w/news/2016/news_0008), [WIPO 2019](https://www.wipo.int/portal/en/news/2019/article_0032.html)).
- **Lens:** PatSeq Finder (BLAST+), text search by source species, Explorer, Analyzer, bulk FASTA ([Lens bio](https://lens.org/lens/bio)).
- **SureChEMBL 2.0 (2025):** five authorities including CNIPA, image-to-structure for EPO/WIPO, bulk compound-patent relationship files ([ChEMBL blog](https://chembl.blogspot.com/2025/05/surechembl20-announcement.html)).
- **PubChem:** 767 million links between 37 million structures and 25 million patents, imported from Google Patents BigQuery ([Sci Data 2024](https://doi.org/10.1038/s41597-024-03371-4)).
- **Orange Book / Purple Book:** public FDA data. PTAB studies show about half of challenged Orange Book patent claims instituted ([IPWatchdog](https://ipwatchdog.com/2021/08/30/key-insights-ptabs-updated-orange-book-biologic-patent-study/)).

Implication: our edge is not generic coverage; it is deep, verifiable, LNP-specific analysis on top of these free layers (deep-link to them rather than rebuild).

## 3. Prioritised gap list (top 15 for next build)

1. **Markush extraction and "is compound X covered by claim Y" check.** Claude parses core + R-group definitions in each claim into a structured record at build time; RDKit.js verifies a user SMILES (substructure with R-group lists). CAS MARPAT and DWPIM do this commercially; CAS itself warns SciFinder Markush is not for FTO ([OSU guide](https://guides.osu.edu/scifinder/markush)), so a transparent, per-patent verifiable approach is valuable.
2. **Query by example / similar patents.** Precomputed embeddings of claim 1 + abstract plus shared-compound and shared-CPC overlap; show "why similar".
3. **OCSR on claim formula images.** Run MolScribe or DECIMER offline on stored images, add SMILES with confidence and flag "machine-extracted"; feeds structure search where text names are absent (SureChEMBL does this for EPO/WIPO; known error modes).
4. **Orange Book / regulatory overlay.** Join FDA Orange Book patents and exclusivities by patent number to our corpus; note COVID-type LNP products are biologics so use Purple Book / BPCIA litigation data instead.
5. **PTE / PTA / SPC-aware expiry.** Pull PTA from USPTO, PTE from FDA, SPC from national registers and EPO unitary data; show range plus confidence rather than one date.
6. **Prosecution history digest.** Fetch EP Register and USPTO file wrapper documents at build time; Claude summarises amendments, arguments, disclaimers; link to claim terms for estoppel flags.
7. **Opposition / litigation / PTAB layer.** EP opposition events (already in register), CourtListener and PTAB API by patent number; badge on search results.
8. **Sequence search for mRNA/siRNA.** In-browser k-mer search over sequences in our corpus plus deep link to Lens PatSeq for the wider universe; chemical-modification tags.
9. **LNP taxonomy tagging.** Claude-tagged fields (ionisable lipid class, PEG-lipid, helper lipid ratio, payload type, route, target tissue, manufacturing method); facets and claim-element templates.
10. **Citation and CPC data.** Add forward/backward citations and CPC tree browse from EPO OPS at build time; co-citation list in detail view.
11. **Assignee normalisation and licensing/ownership.** Alias table, parent mapping, assignment/transfer events; "who to approach" panel.
12. **Design-around assistant.** Per claim chart, Claude proposes which limitation to vary, checks candidate against dependent claims and other families in the corpus, with verified quotes.
13. **Audit trail and report export upgrade.** Include prompt hashes, model id, corpus version, quote verification results; DOCX/PDF export.
14. **Monitoring by scheduled rebuild.** Nightly CI diff of status, new publications, new hits for saved searches; produce RSS/JSON and optional e-mail.
15. **Agent access (MCP) and data export.** Thin MCP server and downloadable JSON/Parquet of enriched corpus; matches community patent MCP servers ([PyPI](https://pypi.org/project/patent-mcp-server/)).

Lower priority: reaction search (low LNP value), patent strength scoring (proprietary, low FTO value), image search.

## 4. Opportunities (gaps no tool seems to cover well)

1. **Verifiable claim-text quoting everywhere.** Vendor pages describe "citation-backed" claim charts ([Solve](https://www.solveintelligence.com/capabilities/claim-charts), [Patlytics](https://patlytics.ai/blog/top-patent-analysis-tools-2025)) but none state deterministic verbatim-quote verification; ours exists, so extend it to every AI output.
2. **LNP-specific ontology and claim-element templates.** No general tool offers lipid-class, ratio, payload facets; Patsnap Bio and Patsnap Chemical are generic ([Patsnap](https://www.patsnap.com/resources/blog/articles/chemical-structure-patent-search-tools-2025)).
3. **Markush check that is transparent and testable.** MARPAT/DWPIM are curated but opaque and paywalled; CAS says its Markush search is a preliminary tool ([OSU guide](https://guides.osu.edu/scifinder/markush)); Orbit says Markush is "not indexed" and a drawing is used as a search mode ([Questel help](https://intelligence.help.questel.com/en/support/solutions/articles/77000465653-how-to-use-markush-structure-drawing)).
4. **Combined chemistry plus sequence plus formulation claim check.** Chemistry and bio modules are sold as separate products (Patsnap blog notes it does not explain how they connect); LNPs need lipid + payload + ratio in one chart.
5. **FTO expiry with explicit uncertainty.** DrugPatentWatch argues expiry dates alone mislead and that dockets and settlements decide generic entry ([blog](https://www.drugpatentwatch.com/blog/the-role-of-litigation-data-in-predicting-generic-drug-launches/)); no tool seen shows a probabilistic range with reasons (PTA, PTE, SPC, terminal disclaimer, maintenance fees, opposition).
6. **Claim construction assistant tied to the specification's own definitions.** No vendor page found describing explicit definition-to-claim-term linking with lexicography flags.
7. **Free-tool federation.** Free layers (PatSeq, PATENTSCOPE chemistry, SureChEMBL, PubChem, Orange Book) are separate sites; an LNP-focused cross-link hub is missing.
8. **Reproducible, shareable FTO snapshots.** Corpus version + prompts + model + quote checks in one exportable file; DeepIP markets "audit-ready" (M) but formats are closed.
9. **Machine-translation transparency for CN/JP/KR.** Reaxys states translations of titles, abstracts and claims ([Reaxys release](https://pharmiweb.com/press-release/2022-02-02/reaxys-to-enhance-chemistry-patents-with-patent-provenance-for-greater-competitive-intelligence-insights)); no source describes showing original and translation with term-level glossary and confidence.
10. **Agent-ready patent tooling.** A roundup says EPO OPS, USPTO, BigQuery and Lens lack production-ready MCP servers ([Patsnap blog](https://www.patsnap.com/resources/blog/articles/mcp-server-for-patent-data-best-tools-2026/), vendor source, M); community USPTO servers exist but cover file wrapper and full text only. An LNP-corpus MCP with chemistry and claims is an open niche.

## 5. Sources

Questel / Orbit
- [Orbit Chemistry](https://questel.com/orbit-software-suite/orbit-chemistry)
- [Improved Markush structure search](https://www.questel.com/communication/orbit-intelligence-improved-markush-structure-search-en.html)
- [How to use Markush structure drawing (Questel help)](https://intelligence.help.questel.com/en/support/solutions/articles/77000465653-how-to-use-markush-structure-drawing)

Patsnap
- [Chemical structure patent search tools](https://www.patsnap.com/resources/blog/articles/chemical-structure-patent-search-tools-2025)
- [Markush analysis](https://www.patsnap.com/resources/blog/articles/analyze-markush-structures-patents-3)
- [Bio October release](https://www.patsnap.com/resources/blog/key-precision-updates-in-patsnaps-october-bio-release/)
- [MCP server for patent data](https://www.patsnap.com/resources/blog/articles/mcp-server-for-patent-data-best-tools-2026/)

CAS / STN / Derwent / Clarivate
- [CAS MARPAT factsheet](https://origin-www.cas.org/sites/default/files/documents/marpat_100121.pdf)
- [CAS chemical patent search](https://cas.org/solutions/stn-ip-protection-suite/chemical-patent-search)
- [OSU SciFinder Markush guide](https://guides.osu.edu/scifinder/markush)
- [DWPI on CAS STNext (DWPIM >2.4M, DCR >4.6M)](https://www.cas.org/sites/default/files/documents/DWPI-CAS-STNext_April-2024.pdf)
- [Derwent Patent Search (WIPO INSPIRE)](https://inspire.wipo.int/node/356)
- [Clarivate Cortellis Product Intelligence page](https://clarivate.com/life-sciences-healthcare/?p=582070)

Elsevier / LexisNexis / Minesoft
- [Reaxys patent provenance with PatentSight](https://pharmiweb.com/press-release/2022-02-02/reaxys-to-enhance-chemistry-patents-with-patent-provenance-for-greater-competitive-intelligence-insights)
- [Reaxys patent expansion 2023](https://supportcontent.elsevier.com/RightNow%20Next%20Gen/Reaxys/Customer%20facing%20-%20Patent%20expansion%20July%202023.pdf)
- [Minesoft Chemical Explorer manual](https://knowledge.minesoft.com/wp-content/uploads/2019/03/Chemical-explorer-manual.pdf)
- [Minesoft ChemX listing](https://platform.softwareone.com/product/minesoft-chemx/PCP-3574-9453)

AI-native tools
- [Solve Intelligence FTO](https://www.solveintelligence.com/capabilities/freedom-to-operate)
- [Solve claim charts](https://www.solveintelligence.com/capabilities/claim-charts)
- [Patlytics comparison (vendor)](https://patlytics.ai/blog/top-patent-analysis-tools-2025)
- [DeepIP vs Solve (vendor)](https://www.deepip.ai/blog/deepip-vs-solve-intelligence-ai-patent-software-comparison-2026)
- [PatSeer AI search platforms](https://patseer.com/top-5-ai-patent-search-platforms-to-watch-in-2025/)
- [XLSCOUT key features](https://xlscout.ai/wp-content/uploads/2026/08/XLSCOUT_Key_Features.pdf)
- [NLPatent (WIPO INSPIRE)](https://inspire.wipo.int/nlpatent)
- [Ambercite vs Reaxys comparison page](https://slashdot.org/software/comparison/Ambercite-vs-Reaxys/)

Free / public
- [PATENTSCOPE chemical search 2016](https://www.wipo.int/en/web/patentscope/w/news/2016/news_0008)
- [PATENTSCOPE substructure 2019](https://www.wipo.int/portal/en/news/2019/article_0032.html)
- [Lens bio / PatSeq](https://lens.org/lens/bio)
- [PatSeq paper (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7416664)
- [SureChEMBL 2.0 announcement](https://chembl.blogspot.com/2025/05/surechembl20-announcement.html)
- [SureChEMBL update (MacInChem)](https://macinchem.org/2025/05/04/surechembl-update/)
- [NextMove on image-to-structure errors](https://nextmovesoftware.com/blog/2016/07/)
- [PubChem patent data (Sci Data 2024)](https://doi.org/10.1038/s41597-024-03371-4)
- [EBI patent data resources](https://ebi.ac.uk/patentdata)
- [Espacenet (WIPO INSPIRE)](https://inspire.wipo.int/node/1727)
- [Espacenet vs Google Patents (CASRAI)](https://casrai.org/compare/espacenet-vs-google-patents-vs-uspto-patent-public-search)

Regulatory / legal
- [DrugPatentWatch: litigation data](https://www.drugpatentwatch.com/blog/the-role-of-litigation-data-in-predicting-generic-drug-launches/)
- [DrugPatentWatch: tentative approvals](https://www.drugpatentwatch.com/blog/how-to-use-tentative-drug-approvals-to-anticipate-generic-entry/)
- [PTAB Orange Book / biologic study](https://ipwatchdog.com/2021/08/30/key-insights-ptabs-updated-orange-book-biologic-patent-study/)
- [Robins Kaplan ANDA bulletin](https://www.robinskaplan.com/newsroom/insights/generically-speaking-hatch-waxman-bulletin-2025-q4-new-anda-cases)
- [EPO: protection beyond 20 years (SPC data)](https://epo.org/en/searching-for-patents/helpful-resources/patent-knowledge-news/protection-beyond-20-years-data-spcs)
- [EPO Unitary Patent register](https://epo.org/en/service-support/faq/law-practice/unitary-patent/register-unitary-patent-protection/there-specific)
- [Council note on centralised SPC register (proposal)](https://data.consilium.europa.eu/doc/document/WK-5449-2025-INIT/en/pdf)
- [Mewburn Ellis: SPCs and PTEs](https://www.mewburn.com/law-practice-library/supplementary-protection-certificates-patent-term-extensions)

Agents / MCP
- [patent-mcp-server on PyPI](https://pypi.org/project/patent-mcp-server/)

Not verified in this sweep (no usable source retrieved): Cypris, Tradespace, Amplified/IPRally primary docs, IFI Claims API, Google Patents chemistry search, Espacenet chemistry, DrugPatentWatch product feature page, Cortellis SPC/PTE handling, Orbit Sophia, LexisNexis TotalPatent, PatentSight scoring detail. Treat rows relying on them as unconfirmed.
