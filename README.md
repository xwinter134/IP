# LNP FTO

A private, single-user tool for patent search and freedom-to-operate (FTO) pre-screening in the field of lipid
nanoparticles (LNP) and ionizable lipids. It is a static page: full-text search over patent claims, chemical
structure search over the lipids named in patents, legal status, a patent landscape, a watchlist, and a guided FTO
pre-screening of a product profile against selected patents.

It is a research aid, not legal advice. Every FTO result is a pre-screening that has to be checked by a patent
attorney; legal status and expiry dates are estimates from public snapshots.

## How it is put together

```
pipeline/   offline build (Python 3 + Node 22): discovery, download, normalisation, legal status, chemistry, dist
web/        the page (plain scripts, no build step, no backend)
dist/       build output: page + data files, published as a private claude.ai Artifact
tests/      engine tests and an end-to-end test in headless Chromium
docs/       ARCHITECTURE.md (formats, APIs), DESIGN.md, method/ (FTO method and prompts)
data/       seed lists (committed) and caches / work files (git-ignored)
```

Search and structure search run in the browser; queries never leave the machine. Only the FTO analysis and the
optional "explain" / AI search functions send text to Claude, through the Artifact `sample` capability. Saved work
(profiles, opinions, watchlist) lives in the Artifact `db` capability, with the browser's local storage as fallback.

Data sources (no API keys): SureChEMBL bulk data, EPO publication server and EP register snapshot, USPTO Patent
Public Search. See `docs/ARCHITECTURE.md`.

## Rebuild

Requirements: Python 3.13 with `duckdb`, `pyarrow`, `lxml`; Node 22; for the end-to-end test Playwright with Chromium.

```
make dist          # = pipeline/run_all.sh: normalize -> status -> chemistry (if stale) -> dist/
make batches       # list the publish batches of dist/ (pipeline/run_all.sh batches -v: with file names)
make test          # engine tests
make e2e           # end-to-end test of dist/ behind a server that mimics the Artifact host
make serve         # look at dist/ locally: http://127.0.0.1:8787
```

The single steps, all incremental and re-runnable at any time:

```
python3 pipeline/normalize.py            # caches -> data/work/corpus.jsonl.gz            (about 40 s)
python3 pipeline/status.py --no-fetch    # cached register records -> status.jsonl.gz     (about 60 s)
node pipeline/chem_build.cjs             # compounds -> data/work/chem/                    (10 s cached, 6 min cold)
python3 pipeline/build_dist.py           # -> dist/ and dist/publish_batches.json          (about 60 s, 25 s unchanged)
```

The downloads (`pipeline/discover.py`, `fetch_ep.py`, `fetch_us.py`, `status.py --fetch-only`, `fetch_ep_images.py`)
are separate, slow and rate-limited; they are resumable and only ever run one at a time per host. The build works on
whatever is in the caches at that moment.

## Publishing

`dist/` is published as it is. `dist/publish_batches.json` splits the files into batches (page and engines first)
that each stay under the per-request limits of the host. The host limits are 500 files, 240 MB in total and 15 MB per
file; the builder checks them and cuts the oldest low-priority full texts when the budget is exceeded.

The host does not serve `*.bin` files, so binary data is published as base64 text (`*.b64.txt`). That is the default
of `build_dist.py`; `--enc bin` writes raw binaries (a third smaller) for local use only
(`node tests/artifact_server.cjs --dist DIR --bin`).

## Limits

- Coverage is what the downloads have reached: EP and US full text for the publications selected in
  `data/work/targets.parquet`, WO publications as bibliography and compounds only. The system view of the page shows
  the counts and snapshot dates of the build.
- Legal status: EP from a register snapshot (events after the snapshot date are not seen), US computed from the
  publication data (no maintenance-fee check, terminal disclaimers not visible). Publications without a status record
  show none.
- Structures come from SureChEMBL's automatic extraction; "found in the claims" is a hint, not proof of claim scope.
  Markush formulae in EP claims are images and are not searchable as structures.
- Claude can be wrong. Quotes from claims are verified by the page against the claim text; everything else is
  marked as an assessment.
