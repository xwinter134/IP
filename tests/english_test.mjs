// English-only guard for user-visible output (CLAUDE.md: "UI copy is English").
//   node tests/english_test.mjs
// Part 1 renders the FTO report fixtures (tests/fixtures/fto-opinion*.json) as HTML and Markdown and fails on umlauts/sharp s,
//        common German words or internal (German-derived) enum codes outside verbatim data: claim/definition/proviso quotes,
//        the generated search queries and SMILES/InChIKeys are removed first (they are quoted as they are).
// Part 2 scans the string literals of web/engine, web/app, web/app/views (and lib) and mcp for German UI text. Comments are not scanned;
//        identifier-like strings (internal codes such as 'wortsinngemaess_erfuellt') are not UI text and are skipped.
//        ALLOW lists the deliberate exceptions (German claim-language handling, search terms for German claims, legacy-value maps).
// No network. Exit code 1 when a check fails.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (c, name, detail) => { if (c) passed++; else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); } };
const section = (t) => console.log('== ' + t);

const UMLAUT = /[ÄÖÜäöüß]/;
// common German function words and the domain terms the report used to leak (whole words, case-insensitive)
const GERMAN_WORDS = ['und', 'oder', 'nicht', 'der', 'die', 'das', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'keine', 'kein', 'mit', 'für', 'fuer', 'von', 'ist',
  'sind', 'wird', 'werden', 'wurde', 'auf', 'aus', 'bei', 'nach', 'zur', 'zum', 'über', 'ueber', 'auch', 'nur', 'noch', 'sich', 'bitte', 'Anspruch', 'Ansprüche',
  'Ansprueche', 'Merkmal', 'Merkmale', 'Merkmalsanalyse', 'Schutzrecht', 'Schutzrechte', 'Rechtsstand', 'Vorprüfung', 'Vorpruefung', 'Gutachten', 'Hinweis',
  'Ergebnis', 'Begründung', 'Begruendung', 'unklar', 'erfüllt', 'erfuellt', 'Zusammenfassung', 'Recherche', 'Gegenstand', 'Prüfung', 'pruefen',
  'Schätzung', 'Schaetzung', 'anhängig', 'Anhaengig', 'Gegenprüfung', 'Ausnahmen', 'Rolle', 'Lieferung', 'Mischen', 'Punkt', 'zwei', 'Testprodukt',
  'Produkt', 'Querschnitt', 'technische', 'Hypothese', 'gering', 'mittel', 'hoch', 'niedrig', 'offen', 'ja', 'nein', 'entfaellt', 'Umgehung', 'Auslegung',
  'Kette', 'Ketten', 'Grund', 'Frage', 'weil', 'Messung', 'Kopfgruppe', 'Partikel', 'Verfahren', 'Zulassung', 'Klinik', 'Forschung', 'Abbrechen', 'Speichern', 'Löschen', 'Zurück', 'Weiter',
  'Fehler', 'Datenstand', 'Erteilt', 'erloschen', 'widerrufen', 'abgelaufen', 'unbekannt', 'Titel', 'Markt', 'Risiko', 'Zitat', 'Urteil'];
const WORD_RE = new RegExp('(^|[^A-Za-zÀ-ſ])(' + GERMAN_WORDS.join('|') + ')(?=$|[^A-Za-zÀ-ſ])', 'i');
// internal codes of the FTO schema (German-derived snake_case identifiers); none may be rendered
const CODE_RE = /\b[a-z0-9]+_[a-z0-9_]*(hoch|mittel|gering|beurteilbar|erfuellt|moeglich|klaeren|fragen|loesungen|anspruch|korpus|zitat|formel|fehlt|gekuerzt|pruefen|ungeprueft|anhaengig|nutzer|merkmal\w*)\b|\b(wortsinngemaess|nicht|zitat|kein|faellt|anspruch|unteransprueche|gegenpruefung|rechtsstand|umgehungsloesungen|offene|zu)_[a-z_]+\b/;

function germanIn(text) {
  const out = [];
  let m = UMLAUT.exec(text); if (m) out.push('umlaut/sharp s: "' + text.slice(Math.max(0, m.index - 30), m.index + 30) + '"');
  m = WORD_RE.exec(text); if (m) out.push('German word "' + m[2] + '": "' + text.slice(Math.max(0, m.index - 30), m.index + 40) + '"');
  m = CODE_RE.exec(text); if (m) out.push('internal code "' + m[0] + '": "' + text.slice(Math.max(0, m.index - 30), m.index + 40) + '"');
  return out;
}

// ------------------------------------------------------------------------------------------------ part 1: rendered reports
section('1 rendered FTO reports are English outside verbatim quotes');
const R = require(path.join(ROOT, 'web/engine/fto-render.js'));
globalThis.self = globalThis;
require(path.join(ROOT, 'web/engine/fto-prompts.js'));
/* every verbatim string of an opinion: claim, definition and proviso quotes, search queries, structures */
function verbatim(op) {
  const out = new Set(), QUOTE_KEYS = /^(claim_quote|definition_quote|quote|einzelnennung_quote|entscheidendes_merkmal|smiles|smiles_fragment|smiles_input|inchikey|query|strict|relaxed|fragment|formel_bezeichnung|geruest)$/;
  (function walk(x, k) {
    if (typeof x === 'string') { if (QUOTE_KEYS.test(k || '') && x.trim()) out.add(x); return; }
    if (Array.isArray(x)) { x.forEach((v) => walk(v, k)); return; }
    if (x && typeof x === 'object') for (const kk of Object.keys(x)) walk(x[kk], kk);
  })(op);
  return [...out].sort((a, b) => b.length - a.length);
}
function htmlText(h) {
  return h.replace(/<style>[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function strip(text, vs) {
  for (const v of vs) { const one = v.replace(/\s+/g, ' ').trim(); text = text.split(v).join(' ').split(one).join(' '); }
  return text;
}
const FIXTURES = ['tests/fixtures/fto-opinion.json', 'tests/fixtures/fto-opinion-evidence.json'];
for (const f of FIXTURES) {
  const op = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const vs = verbatim(op);
  ok(op.lang === 'en' && /^Important notice/.test(op.limits), f + ': stored as an English opinion with the English limits block');
  const md = strip(R.render(op, 'md').replace(/\s+/g, ' '), vs.map((v) => v.replace(/\s+/g, ' ')));
  const html = R.render(op, 'html');
  ok(/<html lang="en">/.test(html), f + ': HTML document is marked English');
  const ht = strip(htmlText(html).replace(/\s+/g, ' '), vs.map((v) => v.replace(/\s+/g, ' ')));
  for (const [name, text] of [['Markdown', md], ['HTML', ht]]) {
    const lines = text.split(/(?<=[.:;|])\s+/), hits = [];
    for (const l of lines) for (const x of germanIn(l)) if (hits.length < 8) hits.push(x);
    ok(!hits.length, f + ': ' + name + ' report has no German outside verbatim quotes', hits.join(' || '));
  }
}
{
  // a stored opinion of an older version (German limits block, lang "de") is still rendered in English
  const op = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURES[0]), 'utf8'));
  op.lang = 'de'; op.limits = 'Wichtiger Hinweis – Grenzen dieser FTO-Vorprüfung\n4. ... aus einem Datenstand vom 2026-08-23 und kann veraltet sein.';
  const md = R.render(op, 'md'), html = R.render(op, 'html');
  ok(md.startsWith('Important notice') && md.endsWith(globalThis.LnpFtoPrompts.limits('en', '2026-08-23')) && /<html lang="en">/.test(html) && !/Wichtiger Hinweis/.test(md + html),
    'legacy opinion (lang "de", German limits block): rendered in English with the English limits block and the same snapshot date');
  const labels = ['5_sehr_hoch', 'nicht_beurteilbar', 'wortsinngemaess_erfuellt', 'kein_unabhaengiger_anspruch', 'anspruch_nicht_im_korpus', 'zitat_nicht_verifiziert', 'unteransprueche_fehlgeschlagen', 'rechtsstand_ungeprueft', 'markush_widerspruch_M1'];
  const bad = labels.filter((c) => germanIn(R.label(c)).length || R.label(c) === c);
  ok(!bad.length, 'label(): internal codes map to English labels', bad.map((c) => c + ' -> ' + R.label(c)).join(', '));
}

// ------------------------------------------------------------------------------------------------ part 2: static scan
section('2 string literals in web/engine, web/app and mcp are English');
/* string literals with their line numbers; comments are skipped; regex literals are skipped by a heuristic */
function literals(src) {
  const out = []; let i = 0, line = 1, prev = '';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c, start = line; let j = i + 1, s = '';
      while (j < n && src[j] !== q) { if (src[j] === '\\') { s += src[j] + src[j + 1]; j += 2; continue; } if (src[j] === '\n') line++; s += src[j]; j++; }
      let val = s; try { val = JSON.parse('"' + s.replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/"/g, '\\"').replace(/\\\\"/g, '\\"') + '"'); } catch (e) { /* keep raw */ }
      out.push({ line: start, s: val }); prev = 'x'; i = j + 1; continue;
    }
    if (c === '/' && /[(,=:[!&|?{};+]|^$|return$/.test(prev)) { // regex literal
      i++; while (i < n && src[i] !== '/' && src[i] !== '\n') { if (src[i] === '\\') i++; else if (src[i] === '[') { while (i < n && src[i] !== ']') { if (src[i] === '\\') i++; i++; } } i++; } i++; while (/[a-z]/.test(src[i] || '')) i++; prev = 'x'; continue;
    }
    if (!/\s/.test(c)) prev = /[A-Za-z0-9_$]/.test(c) ? (/[A-Za-z]/.test(c) ? (prev + c).slice(-6) : 'x') : c;
    i++;
  }
  return out;
}
/* deliberate exceptions: [file (suffix), regular expression on the literal, reason] */
const ALLOW = [
  ['web/engine/fto.js', /A chain \(kette\) is/, 'descriptor note for the model: names the schema field "kette" (an internal code)'],
  ['web/engine/fto.js', /der formel|molprozent|molverh|durchmesser|polydispersit|nukleins|boten\*|cholesterin|lipidnanopartikel|verkapsel|ionisierbar|kationisch|nanopartikel|zusammensetzung|herstell|verfahren|mischen|mikrofluid/i, 'search terms for German claim text (the corpus has German EP claims)'],
  ['web/engine/fto.js', /Präklinik|T-Stück|intravenös|intramuskulär|Forschung|Klinik Phase|Zulassung beantragt|Kommerziell|Impinging-Jet-Mischer|Mikrofluidik|Ethanol-Injektion|sonstiges|subkutan|inhalativ|intrathekal|topisch|andere|leer \(ohne Wirkstoff\)|gemessen/, 'LEGACY_FORM: German option values of profiles saved by older versions, mapped to English'],
  ['web/engine/fto-prompts.js', /mit der Maßgabe/, 'prompt names the German proviso wording so that provisos in German claims are found'],
  ['web/engine/ai.js', /ionisierbares lipid|kationisches lipid|ionisierb/, 'example of German search terms for German claims (query expansion)'],
  ['web/engine/tok.js', /^der die das und oder/, 'stop words for German claim text (tokenizer)'],
  ['web/app/views/system.js', /^äöü ✓$/, 'storage self-test value with non-ASCII characters'],
  ['web/app/views/suche.js', /^lang:de /, 'search syntax example (filter for German claims)']
];
const FILES = [];
for (const d of ['web/engine', 'web/app', 'web/app/views', 'web/app/views/lib', 'mcp', 'mcp/lib']) {
  const dir = path.join(ROOT, d); if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (/\.m?js$/.test(f) && !/worker\.js$|^chem(fp)?\.js$/.test(f)) FILES.push(path.join(d, f));
}
const PROMPT_FILES = /fto-prompts\.js$/;
/* the schema field names and enum codes of the FTO prompt chain: prompts name them (they are codes, not UI text) */
const SCHEMA_CODES = new Set();
(function walk(x) {
  if (Array.isArray(x)) { x.forEach((v) => { if (typeof v === 'string') SCHEMA_CODES.add(v); else walk(v); }); return; }
  if (x && typeof x === 'object') for (const k of Object.keys(x)) { SCHEMA_CODES.add(k); walk(x[k]); }
})(globalThis.LnpFtoPrompts.SCHEMA);
function stripCodes(t) { return t.replace(/[A-Za-z][A-Za-z0-9_]*/g, (w) => (SCHEMA_CODES.has(w) || w.includes('_') ? ' ' : w)); }
const hits = [];
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const { line, s } of literals(src)) {
    if (!/\s/.test(s) && !UMLAUT.test(s)) continue;          // identifier-like: an internal code, a key, a selector
    if ((/^\s*</.test(s) || /[{;]\s*[a-z-]+:[^ ]/.test(s)) && !UMLAUT.test(s)) continue; // markup / CSS fragments: scanned for umlauts only
    // model prompts name internal codes in double quotes ("unklar") and as field paths (markush.ergebnis): those are codes, not UI text
    const t = PROMPT_FILES.test(rel) ? stripCodes(s.replace(/"[a-z0-9_]+"/g, ' ').replace(/\b[a-z_]+\.[a-z_.]+\b/g, ' ')) : s;
    const g = germanIn(t).filter((x) => !/^internal code/.test(x));
    if (!g.length) continue;
    if (ALLOW.some(([f, re]) => rel.endsWith(f) && re.test(s))) continue;
    hits.push(rel + ':' + line + ' ' + g[0]);
  }
}
ok(FILES.length > 20, 'scanned ' + FILES.length + ' files');
ok(!hits.length, 'no German UI text in string literals', '\n    ' + hits.slice(0, 40).join('\n    '));

console.log('\n' + passed + ' checks passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
