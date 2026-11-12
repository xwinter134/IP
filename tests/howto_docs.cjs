/* docs/TUTORIALS.md is generated from web/app/views/lib/howto-data.js (the same text the "How to" view shows).
     node tests/howto_docs.cjs           write docs/TUTORIALS.md
     node tests/howto_docs.cjs --check   exit 1 when the file is out of date (used by tests/howto_test.cjs) */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'web/app/views/lib/howto-data.js'));
const OUT = path.join(ROOT, 'docs/TUTORIALS.md');

function anchor(n, t) { return (n + '-' + t).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-'); }
function render() {
  const L = [];
  L.push('# How to: step-by-step tutorials', '');
  L.push('Short tutorials for the LNP Patent Desk with real screenshots. The same text is in the app under **How to** (`#howto`, a single tutorial at `#howto-markush`).');
  L.push('The screenshots show the website build in the light theme (made by `tests/howto_shots.cjs`); the Claude features exist only in the claude.ai Artifact version.');
  L.push('Everything shown is a pre-screening aid, not legal advice.', '');
  L.push('This file is generated from `web/app/views/lib/howto-data.js` by `node tests/howto_docs.cjs`; edit the data file, not this one.', '');
  L.push('## Contents', '');
  D.tutorials.forEach((t, i) => L.push((i + 1) + '. [' + t.title + '](#' + anchor(i + 1, t.title) + ')'));
  L.push('', '## Words used in these tutorials', '');
  D.words.forEach((w) => L.push('- **' + w[0] + '**: ' + w[1]));
  D.tutorials.forEach((t, i) => {
    L.push('', '## ' + (i + 1) + '. ' + t.title, '', t.summary, '');
    L.push('Try it in the app: `' + t.route + '`', '');
    t.steps.forEach((s, j) => {
      L.push('**Step ' + (j + 1) + '.' + (s.head ? ' ' + s.head + '.' : '') + '** ' + s.text, '');
      if (s.list) { s.list.forEach((x) => L.push('- ' + x)); L.push(''); }
      if (s.table) {
        const cell = (c) => String(c).replace(/\|/g, '\\|');
        L.push('| ' + s.table.cols.map(cell).join(' | ') + ' |', '|' + s.table.cols.map(() => '---').join('|') + '|');
        s.table.rows.forEach((r) => L.push('| ' + r.map(cell).join(' | ') + ' |'));
        L.push('');
      }
      if (s.link) L.push('[' + s.link.label + '](' + s.link.href + ')', '');
      if (s.img) L.push('![' + s.alt.replace(/[\[\]]/g, '') + '](../web/app/howto/' + s.img + '.jpg)', '');
      if (s.route && s.route !== t.route) L.push('Try it: `' + s.route + '`', '');
    });
    L.push('**Limits**', '');
    t.limits.concat(D.common).forEach((x) => L.push('- ' + x));
  });
  return L.join('\n') + '\n';
}
if (require.main === module) {
  const text = render();
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (have !== text) { console.error('docs/TUTORIALS.md is out of date: run node tests/howto_docs.cjs'); process.exit(1); }
    console.log('docs/TUTORIALS.md is up to date');
  } else { fs.writeFileSync(OUT, text); console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + text.length + ' bytes)'); }
}
module.exports = { render };
