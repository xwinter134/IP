# Markush checker (`LnpMarkush`, `web/engine/x-markush.js`)

Checks whether one concrete molecule falls under a claim that defines compounds by a drawn general formula (a
"Markush" formula). Claude translates the claim into a record; code decides. The output is a pre-screening, not
legal advice: the record is a reading of the claim, and claim construction is for a patent attorney.

Files: `web/engine/x-markush.js` (engine), `data/seed/markush/<pn>-c<claim>.json` (curated records),
`pipeline/markush_seed.py` (curated records -> xdata `markush`), `tests/markush_test.cjs` (tests).

## 1. Record format `mk-1`

```
{v: "mk-1", pn, claim, lang, created, updated, origin: "claude"|"manual"|"curated", reviewed: bool,
 source: {images: [imgId], textHash, claimText (verbatim; curated: first 4000 chars,
         translate(): first 20000), defsText (the definitions sent with the claim, or null)},
 core: {smiles, note},
 vars: [{name, attach: [n...], kind: "substituent"|"divalent"|"repeat", optional, quote, quoteStatus, alts: [...],
         range: {min, max}, unit, note}],
 provisos: [{quote, quoteStatus, smiles? | smarts? | when?, effect: "exclude", note}],
 unsupported: ["text" | {text, vars: [names], effect: "broadens"|"narrows"|"unknown"}]}
```

`LnpMarkush.schema` is the JSON schema of this object (JSON-schema subset of `LnpAI.json`); `validate(record)` adds
the checks a schema cannot express.

### Core and attachment points

`core.smiles` is the drawn formula as SMILES. Every variable position is a dummy atom with a map number `[*:n]`;
each number occurs once. Fixed atoms are written as drawn; a fixed atom without an attachment carries hydrogen only
(a molecule with an extra group on such an atom does not match).

| kind | dummy in the core | replaced by |
|---|---|---|
| `substituent` | one neighbour | nothing: the group found on the molecule is cut off at the attachment bond and judged against `alts` |
| `divalent` | two neighbours (a linker), or one neighbour (a terminal group that contains further variables) | each `smiles` alternative in turn, grafted into the core; the generic alternatives (`alkyl`, `aryl`, ...) are judged on the group found between the two core atoms |
| `repeat` | two neighbours (or one: a terminal chain) | `n` copies of `unit`, every `n` in `range` (`n = 0` joins the neighbours directly) |

Direction: the neighbour written first in the SMILES is the left end. A linker alternative is written left to right
with unnumbered `*` for its ends, exactly as the claim writes it: `-C(O)O-` is `*C(=O)O*`, `-OC(O)-` is `*OC(=O)*`,
a direct bond is `**`. Alternatives may contain further numbered dummies for nested variables (`-C(=O)OR4` is
`*C(=O)O[*:12]` plus a var `R4` with `attach: [12]`); the numbers must still be unique in the whole record. A repeat
`unit` either has two `*` (`*CCO*`: left end C, right end O) or none (`C`: first and last atom are the ends); a
numbered dummy inside the unit repeats with every copy ("R6 at each occurrence"). One repeat variable used at several
positions takes the same `n` everywhere; use separate variables for independent counts.

### Alternatives

`{type, cMin, cMax, dblMin, dblMax, tripleMax, branched, ring, hetero, substituted, smiles, smarts, note}`

| type | judged by code |
|---|---|
| `H` | no group at the attachment |
| `halogen` | one F, Cl, Br or I atom (`hetero` restricts the set) |
| `alkyl`, `alkenyl`, `alkynyl` | bound through carbon; acyclic hydrocarbon; carbon count; C=C count (defaults: alkyl 0, alkenyl at least 1, any number); C#C count (alkynyl at least 1); `branched` true/false |
| `acyl` | bound through a carbonyl carbon; carbon count includes the carbonyl carbon |
| `alkoxy` | bound through O, alkyl part counted |
| `cycloalkyl`, `heterocyclyl` | attachment atom in a non-aromatic ring; hetero atoms in the ring (`hetero` restricts) |
| `aryl`, `heteroaryl` | attachment atom aromatic; carbocyclic or with ring hetero atoms (`hetero` restricts) |
| `smiles` | exact match of the group with its attachment point(s), canonical stereo-free OpenChemLib idcode |
| `smarts` | OpenChemLib SMARTS substructure search in the group (the attachment point is a dummy atom) |
| `any` | any group except H |

`substituted`: `false` = must be a plain group, `true` = must carry a substituent, `null` / absent = optional. A
group that carries hetero atoms, rings or aromatic parts beyond the type's own is **unclear** when substitution is
optional or required (the claim does not say which substituents count, so code cannot decide), and **not met** when
the claim requires an unsubstituted group. "Saturated or unsaturated" alkyl is written as `dblMax: 99, tripleMax: 99`.

### Provisos

`effect` is always `exclude`. `smiles`: the molecule is that compound (stereo-free); `smarts`: the pattern occurs in
the molecule; `when: [{var, n} | {var, alt} | {var, absent: true}]`: the combination of variable values of one
assignment is excluded (all conditions together), e.g. "m, n and p are not simultaneously 0". A proviso without any of
these is shown, not checked, and keeps a "covered" result at "unclear".

### Quotes

Every variable and proviso carries `quote`, the verbatim definition from the claim. `quoteStatus` is computed by code
with the semantics of `LnpFto.verifyQuote` (`ok`, `elided`, `approx`, `fail`, `empty`; the engine uses
`LnpFto.verifyQuote` when `fto.js` is loaded, else an identical copy). Only `ok` counts as verified. Records typed by
hand (`origin: "manual"`) may leave `quote` empty (`quoteStatus: "manual"`: the user's own rule; the result says so).
`check()` never trusts a stored `quoteStatus` over code: whenever `source.claimText` or `source.defsText` is present and the
quote is non-empty, the status is recomputed (a stored `ok` that does not verify becomes `fail`, so the group is
unclear). Without any source text a stored status can only lower trust: `fail` / `approx` / `elided` are kept, a stored
`ok` becomes `unverified` (or `manual` for the user's own `origin: "manual"` record).

### Placeholder core

`core.smiles: "*"` (or `"[*]"`) marks a claim whose formula could not be read (image missing or unreadable). Such a
record is valid (vars are checked on their own; their map numbers are not cross-checked), and `check()` always returns
`overall: "unclear"`, `caveat: "no_core"`, `core.placeholder: true`, a reason that nothing was compared, and a limit that
asks for the core SMILES.

### Unsupported parts

Whatever the format cannot express goes into `unsupported` ("R8 and R9 together form a ring", functional definitions,
conditions across variables). Objects name the affected variables and the effect; plain strings are matched to
variable names by word. Nothing is dropped silently.

## 2. Algorithm of `check(record, molecule, opts)`

1. Parse the molecule (SMILES, molfile, idcode or OCL Molecule); keep the largest fragment (counter-ions dropped, the
   limits say so). Bad input throws `{code: "molecule"}` instead of giving a result: unbalanced parentheses or
   brackets, attachment points (`*`, `[*:n]`) or dummy atoms, text that is not a SMILES, and an idcode that does not
   round-trip exactly through OpenChemLib (OCL would otherwise turn arbitrary text into a junk molecule).
2. Expand depth-first: repeat values and `smiles` alternatives of linkers are grafted into the core one variable at a
   time; generic linker alternatives become a "cut" (judged later). Before a branch is extended, the partial core
   (unexpanded positions cut out) is matched against the molecule; a partial core is a subgraph of every completion, so
   a miss prunes the whole branch. Element counts prune too. `opts.maxCores` (default 500 concrete cores) and
   `opts.maxNodes` (default 20 x maxCores) cap the search; reaching a cap makes a "not covered" result "unclear".
3. Match each concrete core: own subgraph matcher over OpenChemLib-perceived graphs (element, aromaticity, bond types;
   fixed atoms with exactly their drawn degree; no bonds between core atoms that the core does not have). Every
   mapping is enumerated (`opts.maxMappings`, default 256), so symmetric cores are handled. The matched concrete core
   is cross-checked with `OCL.SSSearcher` (fixed atoms carry the "no more neighbours" query feature); a disagreement
   keeps the result at "unclear". Reason for the own matcher: OpenChemLib 8.21's JavaScript API exposes
   `isFragmentInMolecule` but no match list.
4. For each mapping, the extra neighbours of each core atom are assigned to its attachment points in every injective
   way (two R groups on one atom, an absent group = H). Each group is cut off (atoms reachable from the attachment
   neighbour outside the core image) and judged against its variable's alternatives. A group that is joined to a
   second attachment (ring closure between substituents) is unclear.
5. The assignment with the fewest failing variables is kept (ties: the reading with the larger core). The search
   stops at the first fully met assignment.
6. When nothing is covered, an explanation pass relaxes repeat ranges and lets one linker take any group, and shows
   the reading that fails only on those variables (e.g. `n = 6, rule 1-5: not met`). It never changes the verdict and
   its own limits (time budget `opts.relaxMs`, default 150 ms) never make a result unclear.

## 3. Verdict rules

Per group: `met`, `not_met`, `unclear`, or `n/a` (the variable does not occur in this assignment, e.g. R4 when R3 took
an alternative without R4). Overall:

- `covered`: the core matches and every variable is met (or n/a) under one assignment, and no proviso excludes it.
- `not_covered`: every assignment has at least one `not_met` variable, or no core match exists, or a proviso excludes
  the molecule.
- `unclear`: otherwise, and in these cases:
  - a variable whose quote is not `ok` (or `manual`) is held at `unclear` (whether it was met or not);
  - an unsupported part that names a variable makes that group `unclear`; a part marked `broadens` only turns
    `not_met` into `unclear` (a met group stays met);
  - an unsupported part that names no variable: "covered" becomes "unclear" unless it is marked `broadens`;
    "not covered" becomes "unclear" unless it is marked `narrows`;
  - when no core match exists at all, a linker or repeat variable with an unverified quote or an unsupported part
    makes "not covered" "unclear" (substituent rules cannot change whether the core occurs);
  - a matching proviso with an unverified quote, or a proviso code cannot check, keeps "covered" at "unclear";
  - a search cap was reached.
- Unreviewed Claude translation (`origin: "claude"`, `reviewed: false`): "covered" stays `covered` with
  `caveat: "translation_not_reviewed"`; "not covered" is reported as `unclear` with the same caveat (`raw` keeps
  `not_covered`), because a translation error could hide coverage.

Result: `{v, overall, raw, caveat, reasons[], pn, claim, origin, reviewed, core: {matched, nMatches, mapping
[[coreAtom, moleculeAtom]], smiles (the concrete core), choices, oclVerified}, groups: [{name, kind, verdict, why,
fragment (SMILES of the group, '*' = attachment), alt, value (repeat n), quote, quoteStatus, forced, relaxed}],
provisos: [{quote, quoteStatus, matched, why, when}], limits[], molecule: {smiles, formula, mw, heavyAtoms}, stats,
ms}`. Every result carries limits (stereochemistry ignored; salts, solvates, charges, tautomers not considered;
pre-screening, not legal advice; plus "translated by Claude, not reviewed", "formula translated from an image",
"optionally substituted groups with hetero atoms are unclear" where they apply).

## 4. What is not supported (and how it shows)

- "Optionally substituted" with unspecified substituents: a plain hydrocarbon group is judged exactly; a group with
  hetero atoms or rings is `unclear`.
- Two variables "taken together" forming a ring: `unsupported`; such a group shows as `unclear`.
- Polymers and PEG: only as a repeat variable; "z has a mean value of 30 to 60" is checked for the single molecule
  given. When a repeat variable's quote or note says "mean" or "average", `result.limits` says so.
- Conditions across variables other than `when` provisos ("the total number of carbons in R1 and R2 is ..."):
  `unsupported`.
- Stereochemistry, charges, salts, tautomers, isotopes: ignored (charges are not compared in core matching).
- A linker judged as a generic group directly followed by a substituent variable (e.g. M1 = "an aryl group" then
  R'): the split between the two is not decided by code -> `unclear`.
- Aromatic rings that only appear when repeat units close a ring: not perceived as aromatic.

## 5. Claude (translate, OCSR) and manual mode

- `translate({pn, claim, claimText, images, imageIds, defs, lang, signal, onText})` -> record with `origin: "claude"`,
  `reviewed: false`. One `LnpAI.json` call (tier `chart`) with the schema and a code check: `validate()` plus a
  verbatim check of every quote against the claim text (and the definitions). On failure exactly one repair call
  (`LnpAI.json`); if only quotes still fail, the record is kept and the failed quotes carry `quoteStatus: "fail"`,
  which makes those groups unclear. Prompt: instructions first, then `<claim>`, `<definitions>`, `<image_notes>` data
  blocks; control and invisible format characters (zero-width, soft hyphen, BOM, bidi marks) are removed from data
  first, then a `<` that would open or close an envelope tag becomes U+2039; the model is told to ignore
  instructions in the data, transcribe the drawn core with `[*:n]`, copy definitions verbatim and put what it cannot
  express into `unsupported`. Missing or unreadable formula image (rule R8): the model puts "formula image missing" in
  `unsupported` and, unless the text alone gives the structure, returns the placeholder core `"*"`; `translate()` then
  returns that record and `check()` answers unclear (see Placeholder core).
- `ocsr(imageBlob, {hint, signal})` -> `{smiles, ok, formula, mw, dummies, canonical, errors[], note:
  "machine-extracted", modelNote, repaired, calls}`. The SMILES is parsed by OpenChemLib (unbalanced parentheses are
  rejected even where OpenChemLib would accept them); a parse failure gets one repair call with the error, then
  `{ok: false}`.
- Without Claude (`LnpAI.available()` false, website build, `claude.use("sample")` null) both reject
  `{code: "no_ai", message}`; callers offer manual mode: the user types the core SMILES and the rules
  (`origin: "manual"`), and `check()` works the same.

## 6. Store, curated records, batch

- `get(pn, claim)`, `put(record)` (sets `id = "<pn>--c<claim>"`, bumps `updated`; LnpStore kind `markush`, in-memory
  map without LnpStore), `list({curated})`, `remove(pn, claim)`. `get()` returns the curated record when nothing is
  stored; editing and saving a curated record stores it as the user's own (`origin: "manual"`).
- Curated records: `data/seed/markush/<pn>-c<claim>.json`, hand-read from the claim image and claim text, with a
  reference compound `ref` for the tests. `python3 -I pipeline/markush_seed.py [--corpus]` checks their shape and
  quotes (stdlib only; `--corpus` also compares the stored claim text with `data/work/corpus.jsonl.gz`) and writes
  `data/work/xdata/markush/{xdata.json, curated.json}` (TOOLS_PLAN 2.2, `target: "both"`). The engine loads
  `curated.json` from `LnpData.manifest.x.markush` through `LnpLoader`, else uses none (`configure({curated})` in
  tests).
- `batch(molecule, [{pn, claim}] | "all-cached", {signal, onProgress})` -> `[{pn, claim, result | null, reason:
  null | "no_record" | "invalid_record" | "error"}]`, stored and curated records only, no model calls.
- `claimsWithFormula(p)` -> independent claims with formula images or a `[chem]` / `[STR]` placeholder, with the image
  blobs of each claim (`LnpSearch.claims`, `LnpSearch.claimImages`).

Curated records (5): EP3350157B1 c1 (Moderna, formula IA; SM-102), EP3368507B1 c1 (Acuitas, IG; ALC-0315),
EP3766916B1 c1 (Acuitas, PEG lipid II; ALC-0159), EP2350043B9 c1 (Arbutus/Alnylam, II; DLin-KC2-DMA),
EP3221293B1 c1 (Arcturus, III; ATX-100).

## 7. Worked example: SM-102 against EP3350157B1 claim 1

Claim 1 (excerpt): "A compound of Formula (IA): [chem] ... wherein l is selected from 1, 2, 3, 4, and 5; m is selected
from 5, 6, 7, 8, and 9; M1 is a bond or M'; M and M' are independently selected from -C(O)O-, -OC(O)-, ... each R' is
linear C1-18 alkyl; R4 is -(CH2)nQ, in which Q is OH or -OC(O)N(R)2 ... R2 and R3 are independently selected from the
group consisting of H, C1-14 alkyl, and C2-14 alkenyl."

Record core: `N(CC[*:1][*:2][*:3])([*:4][*:5]C([*:6])[*:7])[*:8][*:9]` with `l` = repeat `C` at 1 (1-5), `M1` =
divalent at 2 (`**`, `*C(=O)O*`, `*OC(=O)*`, `*C(=O)N([*:12])*`, ...), `R'` = substituent at 3 (and inside the amide
and phosphate alternatives: 12-15), `m` = repeat at 4 (5-9), `M` = divalent at 5, `R2`/`R3` at 6/7, `n` = repeat at
8 (1-5), `Q` = terminal group at 9 (`*O`, `*OC(=O)N([*:10])[*:11]` with `R` at 10, 11).

SM-102 `CCCCCCCCCCCOC(=O)CCCCCN(CCCCCCCC(=O)OC(CCCCCCCC)CCCCCCCC)CCO`:

```
overall covered (core confirmed by OCL)
l   met  l = 3, rule 1-5: met
M1  met  group *C(=O)O* (alternative 2 of 8): met
R'  met  C11 alkyl (linear), rule unsubstituted linear C1-C18 alkyl: met
m   met  m = 7, rule 5-9: met
M   met  group *C(=O)O* (alternative 1 of 7): met
R2  met  C8 alkyl (linear), rule unsubstituted C1-C14 alkyl: met
R3  met  C8 alkyl (linear), rule unsubstituted C1-C14 alkyl: met
n   met  n = 2, rule 1-5: met
Q   met  group *O (alternative 1 of 2): met
R   n/a  not present in this assignment
```

Near misses: branched C11 ester (`R' ... branched, rule requires linear`), a C15 R2 (`C15 outside C1-C14`), a
hydroxyhexyl head (`n = 6, rule 1-5: not met`, shown by the explanation pass), `m = 10`: each `not_covered` with the
failing group named.

## 8. Tests

`node tests/markush_test.cjs [--verbose] [--json FILE]`: validate(); toy cores (benzene R1/R2, symmetric amine,
symmetric diester core); carbon-range, C=C and branching boundaries; linker direction (`-OC(O)-` vs `-C(O)O-`),
generic alkylene linkers; repeat ranges, PEG unit, `n = 0`, per-unit attachments; provisos (SMILES, SMARTS, `when`);
unsupported parts, quote states, unreviewed translations; H for absent groups; the cap; all curated records against
their reference lipid and 3-4 near misses each; translate() and ocsr() with `LnpAI.mock` (valid reply, failed quote ->
`fail` -> unclear, repair, SMILES repair, missing-image placeholder, no Claude); forged or stale stored quote states;
invalid molecule input (junk text, unbalanced SMILES, `*`); sanitize() against control and zero-width characters; store,
curated fallback, batch, claimsWithFormula; timing.

`ready()` loads OpenChemLib and runs one tiny check as a warm-up, so the first real `check()` does not pay the JIT
start-up (measured: about 300 ms inside `ready()`, then 67 ms for the first ALC-0159 check in a fresh Node process).
