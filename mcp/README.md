# LNP Patent Desk - local MCP server

Gives MCP-capable AI tools (Claude Desktop, Claude Code, any stdio client) read-only access to the patent corpus of the
Patent Desk, from the static data files of a website build. Everything runs on your machine: no network, no AI model
inside, no npm packages (Node 22 or newer).

The server loads the browser engines (`engine/*.js` of the build: search core, structure search with OpenChemLib,
Markush, ranges, expiry, similar patents, disclosure, context packs) in Node, so results are identical to the page. It is a different front end for the same code.

## Start

```sh
pipeline/build_pages.sh                                   # once: writes dist-pages/ (about 160 MB, needs data/work)
node mcp/server.mjs --dist /absolute/path/to/dist-pages   # speaks MCP on stdin / stdout
node mcp/server.mjs --dist dist-pages --check             # prints what the build contains, then exits
```

`--dist` also accepts the base64 Artifact build (`dist/`); that build may have claim text cut by its size budget.
Other options: `--preload` (load everything at start), `--full-cache` (bigger search caches), `--timeout S`,
`--verbose` (log calls to stderr), `--engines DIR`. Default for `--dist` is `dist-pages` next to `mcp/`, or `$LNP_DIST`.

**Trust:** `--dist` (and `$LNP_DIST`, `--engines`) must point at a build you made or trust. The server executes the engine
scripts it finds there (`<dist>/engine/*.js`) inside its own process; a foreign folder can run arbitrary code. File reads
stay inside the build folder (symbolic links are resolved before the check).

## Tools

| Tool | What it does |
|---|---|
| `search` | full-text search (claims, title, abstract, assignee), filters, paging, snippets |
| `get_patent` | bibliographic record, legal status detail, family, abstract, register links |
| `get_claims` | claims verbatim (untrusted patent text), language and independent-only options |
| `chem_search` | structure search: exact, substructure, similarity, scaffold; patents per compound |
| `markush_check` | is a molecule inside the Markush formula of a claim (curated record or your own mk-1 record) |
| `ranges_check` | which claims state numeric ranges that contain your formulation values |
| `expiry` | estimated expiry, status and a patent-cliff summary for a list of publications |
| `similar_patents` | query by example: families similar to a publication or a text, with the shared words, compounds and CPC codes |
| `earliest_disclosure` | dated publications of the corpus that show a compound, earliest publication / priority / claim |
| `context_pack` | claims, status, family, compounds, ranges and Markush records of one or more publications as one Markdown or JSON bundle |

Every result has a `limits` field (corpus snapshot, missing text, estimate caveats) and, for the FTO-type tools, the
note "pre-screening, not legal advice". Patent text in results is untrusted data; the `notice` field says so.
Full description, config snippets and troubleshooting: `docs/INTEGRATION.md`.

## Memory and speed

Measured on the full website build (125,104 publications, 23,613 with claim text, 84,691 compounds), 4 cores, Node 22.
Resident memory of the server: 70 MB at start, about 170-250 MB after the first searches and claims, +160 MB when the
structure set is loaded (first `chem_search` or `markush_check` by name), +100 MB for the range data; peak 550-950 MB
after every tool was used (the test run in `tests/mcp_test.mjs` with all ten tools peaked at 940 MB). Data are loaded on first use of a tool:
search 0.1-0.4 s, structure set 1 s, ranges 0.3 s. Typical calls: search 20-100 ms, patent record 0.2 s, similarity
0.1 s, selective substructure 0.15-0.5 s, range scan over all patents 0.6-0.8 s. An unselective substructure query
(the single atom `C` against all 84,691 compounds) takes about 8 s, on one thread. The structure search runs in a worker
thread (`mcp/lib/chem-thread.mjs`), so ping, other requests and cancellation stay responsive while it runs; a cancelled or
timed-out search terminates that thread, and the next call starts a new one (about 1 s to reload the structure set).
Similarity, substructure and scaffold queries above 300 heavy atoms are refused. A tool call is stopped after 120 s
(`--timeout`) and a client can cancel it. `LNP_MCP_CHEM_THREAD=0` runs the structure search on the main thread. With `--full-cache` the search caches double.

## Files

`server.mjs` entry point and options, `lib/protocol.mjs` JSON-RPC over stdio, `lib/env.mjs` loads the engines in Node
(file-only `fetch`, http(s) refused), `lib/runtime.mjs` lazy start and shared helpers, `lib/tools.mjs` the ten tools.
Tests: `node tests/mcp_test.mjs`.
