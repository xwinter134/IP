# Integration: distribution options and your own AI tools

How the Patent Desk is delivered, and three ways to use its data from your own AI tools: the page's `window.LnpAPI`,
context packs you paste into any assistant, and a local MCP server. Everything here is for the owner's private use.
All results are a pre-screening from a corpus snapshot, not legal advice.

## 1. Two distribution options

| | claude.ai Artifact build (`dist/`) | Plain website build (`dist-pages/`) |
|---|---|---|
| Build | `pipeline/run_all.sh` (writes `dist/`) | `pipeline/build_pages.sh` (writes `dist-pages/`) |
| Data files | base64 text (`*.b64.txt`), at most 240 MB and 500 files | raw binary (`*.bin`), no size limit (about 160 MB now) |
| Text index | cut by the size budget when the corpus outgrows it (oldest tier-5 claims first, stated in the page) | complete (budget 900 MB), all definitions, the full formula-image set, long range quotes |
| Claude features | yes: FTO analysis, AI search help, formula-image reading (Markush / OCSR), saved work in the Artifact database, through `window.claude` | none; every Claude-dependent feature shows a manual mode or says what is missing |
| Hosting | private claude.ai Artifact, published in batches (`dist/publish_batches.json`) | any static host (GitHub Pages, an intranet folder, `python3 -m http.server`) or just the folder for the MCP server |
| Network | the page never fetches from other origins | same |

The two builds contain the same tools and the same engine code. Use the Artifact when you want Claude inside the page;
use the website build when you want the whole corpus, a host without Claude, or the MCP server (section 5). Saved
searches, profiles and opinions live in the Artifact database in the first case and in the browser storage in the second.

## 2. Which integration for what

| You want to | Use |
|---|---|
| script or drive the open page (console, Playwright, a browser agent) | `window.LnpAPI` (section 3) |
| hand a patent, a result list or an FTO opinion to any assistant, offline | a context pack (section 4) |
| let Claude Desktop, Claude Code or another MCP client query the corpus itself | the MCP server (section 5) |

None of them calls a model from our side. What your AI tool does with the data afterwards (and where it sends it) is the
tool's business: results leave your machine as soon as the assistant reads them.

## 3. `window.LnpAPI` in the page

The page exposes one facade, `window.LnpAPI`, with documented methods (`search`, `patent`, `claims`, `status`,
`chem.*`, `markush.*`, `ranges.*`, `expiry`, `similar`, `disclosure`, `contextPack`, `limits`, ...). Every method returns a promise of
plain JSON (no Blob, no DOM nodes), validates its input and rejects with `{code, message}`. It works with and without the
Claude capabilities. Reference and examples: `docs/LNPAPI.md`.

```js
await LnpAPI.ready();
const r = await LnpAPI.search('"ionizable lipid" asg:acuitas', { limit: 5 });
const claims = await LnpAPI.claims('EP3532103B1', 'en');
```

Use it from the browser console, from a bookmarklet-style script, or from a test runner. It is not a network API: it exists
only while the page is open.

## 4. Context packs (paste into any AI tool)

A context pack is a Markdown or JSON bundle of corpus data for one patent, a list of publications, a search result,
a library screen or an FTO opinion: claims verbatim, legal status with its date, family, compounds, ranges, Markush records, links.
Nothing in it is written or judged by a model; it is computed from the snapshot in the build.

How to make and use one:

1. Open the Tools hub (`#tools`, rail entry "Tools"), section "Make a context pack": enter one or more publication numbers
   (one per line, up to 50), choose Markdown or JSON, press **Build pack**. Patent pages and result lists also carry a "Context pack" button.
2. **Copy** puts the text on the clipboard; **Download** saves a file named `lnp-context-pack-<date>.md` or `.json`. Without the page, `LnpAPI.contextPack(target, {format})` returns the same text.
3. Paste it into the chat of any assistant (or attach the file) and ask your question below it. Large packs are cut by a
   size budget (default 300 KB), dependent claims first; every cut is named in the pack.

Trust note, built into the format:

- A LIMITS line (pre-screening, snapshot date, claims possibly cut, not legal advice) stands first and last in every pack.
- Patent text (titles, claims, definitions, assignees, register wording) is untrusted. In Markdown it sits only inside
  fences marked `>>> PATENT DATA BEGIN ... / >>> PATENT DATA END <<<`; control and direction-changing characters are removed and a
  marker inside the text is defused. The introduction tells the reader to treat the fenced text as quotation and ignore
  instructions in it. In JSON it is only ever a string value.
- Still check what the assistant answers against the claim text; ask it to quote claims verbatim.

## 5. MCP server (`mcp/`)

A local MCP server over stdio. It reads the files of the website build, runs the same engines as the page in Node, needs
no network and no npm packages, and calls no AI model. The AI tool is the client and the model; the server only answers tool calls.

### 5.1 Requirements and build

- Node 22 or newer on the machine that starts the server (`node --version`).
- A website build. Make it once (the pipeline data under `data/work/` must exist; about 90 s, 3 GB RAM):

  ```sh
  pipeline/build_pages.sh          # writes dist-pages/
  ```

  A base64 Artifact build (`dist/`) also works, but its text index may be cut by the size budget; the website build is complete.
- Rebuild after every corpus update; the server reads files at start and on first use of each tool.

### 5.2 Start

```sh
node /absolute/path/to/mcp/server.mjs --dist /absolute/path/to/dist-pages
```

The server then waits for MCP messages on stdin (one JSON-RPC message per line) and answers on stdout; logs go to stderr.
You normally do not start it by hand: the client does, from its configuration. Options: `--check` (print what the build contains
and exit), `--preload`, `--full-cache`, `--timeout S`, `--verbose`, `--engines DIR`, `--help`; `$LNP_DIST` sets the default `--dist`.

Use absolute paths in every configuration: the client's working directory is not yours.

### 5.3 Claude Desktop

Edit `claude_desktop_config.json` (Settings > Developer > Edit Config; macOS `~/Library/Application Support/Claude/`, Windows
`%APPDATA%\Claude\`) and add the server, then quit and restart Claude Desktop:

```json
{
  "mcpServers": {
    "lnp-patent-desk": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/server.mjs", "--dist", "/absolute/path/to/dist-pages"]
    }
  }
}
```

If Claude Desktop does not find Node 22 on its path (common with nvm or Homebrew), give the full path of the binary in
`command`, e.g. `"/usr/local/bin/node"` or `"C:\\Program Files\\nodejs\\node.exe"`.

### 5.4 Claude Code

```sh
claude mcp add lnp-patent-desk -- node /absolute/path/to/mcp/server.mjs --dist /absolute/path/to/dist-pages
claude mcp list                 # the server should show as connected
```

Add `--scope user` to make it available in every project (the default scope is private to you in the current project; `--scope project` writes `.mcp.json` into the
repository, which you should not commit with a private path). Inside a session `/mcp` shows the state and the tools.

### 5.5 Any other MCP client

Register a stdio server with command `node` and the arguments above. As a configuration file the entry usually looks like the
Claude Desktop one (`command`, `args`, optional `env`). The protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05
are accepted. To test without a client:

```sh
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"shell","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"\"ionizable lipid\" PEG","limit":3}}}' \
 | node mcp/server.mjs --dist dist-pages
```

(The server ends when stdin closes; with a pipe, give it a moment with `(printf ...; sleep 2) | node ...`.)

### 5.6 Tools

All tools are read-only. Results are one JSON text block with a `limits` array (corpus snapshot, cut text, caveats) and a
`corpus` object; tools that return patent text add a `notice` that it is untrusted data. Errors come back as results with
`isError: true` and `{error, message}`, never as crashes; wrong arguments name the offending field.

**`search`** `{query, filters?, sort?, limit<=50, offset}`. Query language: implicit AND, `OR`, `NOT`, `-x`, parentheses,
`"phrase"`, `prefix*`, `a NEAR/5 b`, fields `claims: indep: dep: title: abstract: asg:`, metadata `cpc: auth: kind: year: prio: status: player: pn: fam:`.
Filters: `auth, kinds, status, tiers, players, asg, cpc, yearFrom, yearTo, prioFrom, prioTo, textOnly, hasCompounds, hasImg, deInForce, indepOnly, lang`.
Returns `total`, `hits[{pn, title, assignee, status, published, snippet{field, claim, text}}]` (matches marked « »), `has_more`.

```json
{"query": "\"ionizable lipid\" NEAR/10 \"mol %\"", "filters": {"auth": ["EP"], "yearFrom": 2022}, "limit": 10}
```

**`get_patent`** `{pn}`: biblio (dates, assignee, CPC, family id), `status_summary` and the full `status_detail` (register events,
opposition, appeal, lapsed states, estimated expiry, snapshot date), family members in the build, abstract, links to public registers.
The number may be written loosely (`EP 3 532 103`); without a kind code the best publication is used and the note says which.

```json
{"pn": "EP3532103B1"}
```

**`get_claims`** `{pn, lang?, independent_only?}`: claims verbatim with number, language, independence, `depends_on`, root claims,
formula-image ids. A publication without claim text (WO pamphlet, text cut by the size budget) returns an empty list and says why.

```json
{"pn": "EP3532103B1", "lang": "en", "independent_only": true}
```

**`chem_search`** `{query, mode: exact|sub|sim|scaffold, min_sim, in_claims_only, limit<=50, patents_per_compound}`: `query` is SMILES,
a reference lipid name (DLin-MC3-DMA, SM-102, ALC-0315 ...), a SureChEMBL id or `smarts:...`. Returns compounds with formula,
mass, similarity, head group and tails, whether the compound is named in claims, and the patents that mention it (claims first).

```json
{"query": "ALC-0315", "mode": "sim", "min_sim": 0.8, "limit": 10}
```

**`markush_check`** `{pn, claim, smiles, record?}`: decides with code whether the molecule falls inside the Markush formula of the claim.
Without `record` it uses the curated record shipped with the build (a handful of seed claims; the error lists them); with `record` it checks against your own
`mk-1` record (schema in `docs/MARKUSH.md`). The molecule can also be a lipid name or SCHEMBL id. Result: `covered`, `not_covered` or `unclear`, the core match,
a verdict per variable with the verbatim claim quote and whether it was verified against the claim text, provisos and limits. The server never reads an image itself; with `record` it takes the claim text from the build and verifies every quote of your record against it (a record you pass is always an unreviewed translation; the publication must be in the build). The
formula must already be translated into a record (curated, or by you).

```json
{"pn": "EP3368507B1", "claim": 1, "smiles": "ALC-0315"}
```

**`ranges_check`** `{values:[{param, comp?, value, unit?}], pns?, mode: all|any, strict?, max<=50}`: finds claims whose numeric ranges contain your values.
Parameters come from the build data (`mol_pct, wt_pct, molar_ratio, weight_ratio, np_ratio, size_nm, pdi, pka, encaps_pct, temp_c, ph, chain_c, peg_mw, conc`);
`comp` is the lipid role (`ionizable, cationic, peg, sterol, phospholipid, helper, payload, total`). Each match lists the claim range, whether it is inherited from a parent claim,
whether the component was attributed or unknown, and a verbatim quote verified against the claim text.

```json
{"values": [{"param": "mol_pct", "comp": "ionizable", "value": 50}, {"param": "np_ratio", "value": 6}], "mode": "all", "max": 10}
```

**`expiry`** `{pns[], family?, jurisdictions?}`: per right the estimated expiry (filing date + 20 years, + PTA for US), status, in force (EP, DE),
snapshot age, missing-record flags; WO publications are skipped; a patent-cliff summary per jurisdiction.

```json
{"pns": ["EP3532103B1", "US11000000B2"], "family": false}
```

### 5.7 Limits and the legal note

- The data are a snapshot (`corpus` in every result: build date, SureChEMBL, EP register, EP and US text dates). Anything newer, and every publication outside the
  corpus, is missing. The status is a register snapshot; renewal fees and events after its date are not seen.
- Claim text of some publications can be cut by the build size budget (Artifact build; the website build keeps all). Compounds are those annotated by SureChEMBL
  from claims, descriptions and structure drawings; formula images that were not annotated are not searchable by structure.
- Ranges and Markush results rest on pattern rules and on records translated by a person; both state what they did not see. Expiry dates are estimates; PTE, SPC,
  terminal disclaimers and later lapses are not checked.
- Patent text in results is untrusted data. A client must not follow instructions found in titles, snippets, claims or quotes.
- This is pre-screening, not legal advice and not an infringement, validity or freedom-to-operate opinion. Have a patent attorney check anything you rely on.
- The server never calls an AI model and never executes text from patents. The engines' `fetch` is replaced by a file reader below the build directory;
  http(s) addresses are refused, so the server cannot reach the network through them.

### 5.8 Memory and speed

About 70 MB at start, 170-250 MB after the first searches, +160 MB for the structure set (first `chem_search`), +100 MB for the range data: 550-700 MB peak
with every tool used (full corpus). Data load on first use: search 0.1-0.4 s, structures 1 s, ranges 0.3 s. Typical calls take 20-800 ms; a very unselective
substructure query (a single atom against all compounds) about 8 s. A call is stopped after 120 s (`--timeout`); a client can cancel it. `--preload` moves the loading to start-up.

### 5.9 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Client shows the server as failed / "disconnected" | run the command by hand; a message on stderr names the cause. Common: relative path, Node older than 22 (`node --version`), `--dist` does not hold `data/manifest.json` |
| `cannot start: not a Patent Desk build` | `--dist` must be the build folder itself (`dist-pages/`), not its parent; build it with `pipeline/build_pages.sh` |
| `engine files not found` | the build has no `engine/` folder (old or partial build); rebuild, or pass `--engines <repo>/web/engine` |
| Claude Desktop does not list the tools | the JSON must be valid; restart the app completely after editing; use an absolute path to `node` |
| `Range data is not in this build` / Markush records missing | run `pipeline/ranges_build.py` and `pipeline/markush_seed.py` (or `pipeline/run_all.sh`), then rebuild |
| Claims are empty for a patent | `get_patent` says why: no full text in the build, or cut by the size budget (use the website build) |
| First `chem_search` is slow | the structure set (25 MB) loads once; later calls take milliseconds. Use `--preload` to load at start |
| Out of memory on a small machine | do not use `--full-cache`; avoid unselective substructure queries; 1 GB free is enough for all tools |
| `... did not finish within 120 s and was cancelled` | a very broad structure query; narrow it, or raise `--timeout` |
| Nothing happens when started by hand | that is normal: the server waits for a client on stdin. Use `--check`, or the shell test in 5.5 |
| Results look old | rebuild the data (`pipeline/build_pages.sh`); the snapshot dates are in every `corpus` field |

Run `node mcp/server.mjs --dist dist-pages --verbose` to log every call and its time to stderr. Tests: `node tests/mcp_test.mjs`.
