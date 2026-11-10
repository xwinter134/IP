/* LNP Patent Desk: small chart kit (global LnpChart). Classic script; needs ui.js and lib/kit.js.
   Inline SVG / plain HTML marks, no library. Rules followed: one axis, bars at most 24 px with a rounded data end,
   2 px surface gap between stacked segments, recessive grid, legend for two or more series, text in text tokens,
   hover tooltip on every mark, every mark is a link or a button into the search view. Colours are CSS custom
   properties (--s1..--s8, --s-other, --h0..--h5) defined for light and dark in views.css. */
(function (g) {
  'use strict';
  var U = g.LnpUI, K = g.LnpKit, h = U.h, NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, text) {
    var el = document.createElementNS(NS, tag), k;
    for (k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  }
  function niceMax(v) {
    if (!(v > 0)) return 4;
    var raw = v / 4, e = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / e, step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e;
    if (step < 1) step = 1;
    return Math.ceil(v / step) * step > 4 * step ? 5 * step : 4 * step;
  }
  function ticks(max) { var n = 4; if (max % 5 === 0 && (max / 5) % 1 === 0 && isFive(max)) n = 5; var out = []; for (var i = 0; i <= n; i++) out.push(max * i / n); return out; }
  function isFive(max) { var q = max / 5, e = Math.pow(10, Math.floor(Math.log10(q))), m = Math.round(q / e * 100) / 100; return m === 1 || m === 2 || m === 2.5 || m === 5; }
  function tickText(v) { return v >= 10000 ? (v / 1000).toLocaleString('en-GB') + 'k' : U.num(Math.round(v * 10) / 10); }
  function legend(series) {
    return h('div.k-legend', null, series.map(function (x) { return h('span', null, h('i', { style: { background: x.color } }), x.name); }));
  }
  var C = {};
  C.color = function (i) { return 'var(--s' + (i + 1) + ')'; };
  C.OTHER = 'var(--s-other)';

  /* stacked columns: {cats[], series[{name, color, values[]}], unit, height, onClick(ci, si), label} -> destroy() */
  C.stacked = function (host, o) {
    var wrap = h('div.k-chart'), plot = h('div.k-plot');
    if (o.series.length > 1) wrap.appendChild(legend(o.series));
    wrap.appendChild(plot); host.appendChild(wrap);
    var n = o.cats.length, totals = o.cats.map(function (_, i) { return o.series.reduce(function (a, x) { return a + (x.values[i] || 0); }, 0); });
    var max = niceMax(Math.max.apply(null, totals.concat([1]))), H = o.height || 260;
    function tipFor(ev, ci, si) {
      var rows = [];
      o.series.forEach(function (x, j) { if (x.values[ci]) rows.push([x.name, U.num(x.values[ci]), x.color, j === si]); });
      rows.reverse();
      if (o.series.length > 1) rows.push(['Total', U.num(totals[ci]), null]);
      K.tip.show(ev, (o.catTitle ? o.catTitle(o.cats[ci]) : String(o.cats[ci])), rows.length ? rows : [[o.unit || 'Count', '0', null]], o.onClick ? 'Click to open the selection in Search' : null);
    }
    function draw(W) {
      U.clear(plot);
      var mL = 44, mR = 8, mT = 8, mB = 24, pw = Math.max(60, W - mL - mR), ph = H - mT - mB, band = pw / n, bw = Math.max(2, Math.min(24, band - 2));
      var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': o.label || '' });
      ticks(max).forEach(function (t) {
        var y = mT + ph - t / max * ph;
        svg.appendChild(s('line', { x1: mL, x2: W - mR, y1: y, y2: y, 'class': t === 0 ? 'k-axis' : 'k-grid' }));
        svg.appendChild(s('text', { x: mL - 6, y: y + 3.5, 'text-anchor': 'end', 'class': 'k-tick' }, tickText(t)));
      });
      var every = Math.max(1, Math.ceil(38 / band));
      for (var ci = 0; ci < n; ci++) (function (ci) {
        var x0 = mL + ci * band, x = x0 + (band - bw) / 2, yBase = mT + ph, acc = 0;
        var hit = s('rect', { x: x0, y: mT, width: band, height: ph + mB, 'class': 'k-hit', tabindex: o.onClick ? '0' : null, role: o.onClick ? 'button' : null, 'aria-label': o.cats[ci] + ': ' + U.num(totals[ci]) + ' ' + (o.unit || '') });
        hit.addEventListener('mousemove', function (ev) { tipFor(ev, ci, -1); });
        hit.addEventListener('mouseleave', K.tip.hide);
        hit.addEventListener('focus', function (ev) { tipFor(ev, ci, -1); });
        hit.addEventListener('blur', K.tip.hide);
        if (o.onClick) {
          hit.addEventListener('click', function () { K.tip.hide(); o.onClick(ci, -1); });
          hit.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); K.tip.hide(); o.onClick(ci, -1); } });
        }
        svg.appendChild(hit);
        var last = -1; o.series.forEach(function (x2, j) { if (x2.values[ci] > 0) last = j; });
        o.series.forEach(function (ser, si) {
          var v = ser.values[ci] || 0; if (!v) return;
          var y1 = yBase - acc / max * ph, y0 = yBase - (acc + v) / max * ph; acc += v;
          var hh = y1 - y0, gap = hh > 4 && si !== last ? 2 : 0, top = y0 + gap, r = si === last ? Math.min(4, bw / 2, Math.max(0, hh)) : 0;
          if (y1 - top < .5) return;
          var d = 'M' + x + ',' + y1 + 'V' + (top + r) + (r ? 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top : '') + 'H' + (x + bw - r) + (r ? 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) : '') + 'V' + y1 + 'Z';
          var seg = s('path', { d: d, 'class': 'k-seg' + (o.onClick ? ' k-click' : '') }); seg.style.fill = ser.color;
          seg.addEventListener('mousemove', function (ev) { tipFor(ev, ci, si); });
          seg.addEventListener('mouseleave', K.tip.hide);
          if (o.onClick) seg.addEventListener('click', function () { K.tip.hide(); o.onClick(ci, si); });
          svg.appendChild(seg);
        });
        if (ci % every === (n - 1) % every) svg.appendChild(s('text', { x: x0 + band / 2, y: H - 7, 'text-anchor': 'middle', 'class': 'k-tick' }, String(o.cats[ci])));
      })(ci);
      plot.appendChild(svg);
    }
    return K.onResize(plot, draw);
  };

  /* horizontal bars as links: {rows[{label, value, href, sub}], color, unit, max} */
  C.hbars = function (host, o) {
    var max = o.max || Math.max.apply(null, o.rows.map(function (r) { return r.value; }).concat([1]));
    var box = h('div.k-hbars');
    o.rows.forEach(function (r) {
      var bar = h('span.k-hbar-bar', { style: { width: Math.max(.5, r.value / max * 100) + '%', background: r.color || o.color || C.color(0) } });
      var a = h(r.href ? 'a.k-hbar' : 'div.k-hbar', { href: r.href || null, title: r.title || null }, h('span.k-hbar-l', { text: r.label }), h('span.k-hbar-t', null, bar), h('span.k-hbar-v', { text: U.num(r.value) }));
      a.addEventListener('mousemove', function (ev) { K.tip.show(ev, r.label, [[o.unit || 'Count', U.num(r.value), r.color || o.color || C.color(0)]].concat(r.sub ? [[r.sub[0], r.sub[1], null]] : []), r.href ? 'Click to open the selection in Search' : null); });
      a.addEventListener('mouseleave', K.tip.hide);
      box.appendChild(a);
    });
    host.appendChild(box);
    return box;
  };

  /* one whole split into parts: {parts[{name, value, color, href}], unit} */
  C.segbar = function (host, o) {
    var total = o.parts.reduce(function (a, p) { return a + p.value; }, 0) || 1;
    var bar = h('div.k-segbar', { role: 'img', 'aria-label': o.label || '' }), leg = h('div.k-legend.k-legend-v');
    o.parts.forEach(function (p) {
      if (!p.value) return;
      var pct = p.value / total * 100, txt = pct.toFixed(pct < 10 ? 1 : 0) + '%';
      var seg = h(p.href ? 'a' : 'span', { href: p.href || null, style: { 'flex-grow': String(p.value), background: p.color }, 'aria-label': p.name + ': ' + U.num(p.value) });
      seg.addEventListener('mousemove', function (ev) { K.tip.show(ev, p.name, [[o.unit || 'Count', U.num(p.value), p.color], ['Share', txt, null]], p.href ? 'Click to open the selection in Search' : null); });
      seg.addEventListener('mouseleave', K.tip.hide);
      bar.appendChild(seg);
      leg.appendChild(h(p.href ? 'a' : 'span', { href: p.href || null }, h('i', { style: { background: p.color } }), p.name, h('b', { text: U.num(p.value) }), h('em', { text: txt })));
    });
    host.appendChild(h('div.k-chart', null, bar, leg));
  };

  /* heat map as a table: {rows[], cols[], v[r][c], href(r, c), rowHref(r), colHref(c), colTitle(c), unit} */
  C.heat = function (host, o) {
    var max = 1; o.v.forEach(function (row) { row.forEach(function (x) { if (x > max) max = x; }); });
    function step(x) { return x <= 0 ? 0 : Math.max(1, Math.min(5, Math.ceil(5 * Math.sqrt(x / max)))); }
    var t = h('table.k-heat'), hr = h('tr', null, h('th'));
    o.cols.forEach(function (c, ci) { hr.appendChild(h('th', { scope: 'col', title: o.colTitle ? o.colTitle(ci) : null }, o.colHref ? h('a', { href: o.colHref(ci), text: c }) : c)); });
    t.appendChild(h('thead', null, hr));
    var tb = h('tbody');
    o.rows.forEach(function (r, ri) {
      var tr = h('tr', null, h('th', { scope: 'row' }, o.rowHref ? h('a', { href: o.rowHref(ri), text: r }) : r));
      o.cols.forEach(function (c, ci) {
        var x = o.v[ri][ci] || 0, cell = h(x && o.href ? 'a' : 'span', { href: x && o.href ? o.href(ri, ci) : null, 'class': 'k-hm' + step(x), text: x ? U.num(x) : '·', 'aria-label': r + ', ' + c + ': ' + U.num(x) });
        cell.addEventListener('mousemove', function (ev) { K.tip.show(ev, r + ' × ' + c, [[o.unit || 'Count', U.num(x), null]].concat(o.colTitle ? [[o.colTitle(ci), '', null]] : []), x && o.href ? 'Click to open the selection in Search' : null); });
        cell.addEventListener('mouseleave', K.tip.hide);
        tr.appendChild(h('td', null, cell));
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    var sc = h('div.k-heat-scale', null, h('span', { text: 'few' }), [1, 2, 3, 4, 5].map(function (i) { return h('i.k-hm' + i, { title: 'up to ' + U.num(Math.round(max * Math.pow(i / 5, 2))) }); }), h('span', { text: 'many (max. ' + U.num(max) + ')' }));
    host.appendChild(h('div.k-chart', null, h('div.k-heat-wrap', null, t), sc));
  };

  /* expiry timeline: {rows[{label, href, end: "yyyy-mm-dd" | null, lv: 0..4 | -1, dead, pending, note}], from: "yyyy-mm-dd"} */
  C.timeline = function (host, o) {
    var y0 = Number(String(o.from).slice(0, 4)), ends = o.rows.map(function (r) { return r.end ? Number(r.end.slice(0, 4)) + 1 : 0; });
    var y1 = Math.max(y0 + 5, Math.max.apply(null, ends.concat([0]))); if (y1 - y0 > 26) y1 = y0 + 26;
    var span = y1 - y0, stepY = span > 16 ? 5 : span > 8 ? 2 : 1;
    function pos(iso) { var t = Date.parse(iso), a = Date.parse(y0 + '-01-01'), b = Date.parse(y1 + '-01-01'); return Math.max(0, Math.min(100, (t - a) / (b - a) * 100)); }
    var box = h('div.k-tl', { role: 'img', 'aria-label': o.label || 'Timeline of estimated expiry dates' }), ax = h('div.k-tl-ax', null, h('span'));
    var track = h('div.k-tl-years');
    for (var y = y0; y <= y1; y += stepY) track.appendChild(h('span', { style: { left: (y - y0) / span * 100 + '%' }, text: String(y) }));
    ax.appendChild(track); box.appendChild(ax);
    var now = pos(o.from);
    o.rows.forEach(function (r) {
      var line = h('div.k-tl-track', null, h('i.k-tl-now', { style: { left: now + '%' } }));
      for (var yy = y0; yy <= y1; yy += stepY) line.appendChild(h('i.k-tl-grid', { style: { left: (yy - y0) / span * 100 + '%' } }));
      if (r.end && !r.dead) {
        var e = pos(r.end);
        if (e > now) line.appendChild(h('span.k-tl-bar' + (r.pending ? '.pending' : ''), { data: { lv: String(r.lv) }, style: { left: now + '%', width: (e - now) + '%' } }));
        line.appendChild(h('span.k-tl-end', { style: { left: Math.min(e, 99) + '%' }, text: r.end.slice(0, 4) }));
      } else line.appendChild(h('span.k-tl-none', { style: { left: now + '%' }, text: r.dead ? 'no longer in force' : 'expiry unknown' }));
      var row = h('div.k-tl-row', null, r.href ? h('a.mono', { href: r.href, text: r.label }) : h('span.mono', { text: r.label }), line);
      row.addEventListener('mousemove', function (ev) { K.tip.show(ev, r.label, [['Expiry (estimate)', r.end ? U.date(r.end) : 'unknown', null], ['Risk', r.risk || '–', null]].concat(r.note ? [[r.note, '', null]] : [])); });
      row.addEventListener('mouseleave', K.tip.hide);
      box.appendChild(row);
    });
    host.appendChild(box);
  };

  /* table twin of a chart, folded away: {head[], rows[][]} */
  C.table = function (host, o) {
    var t = h('table.data'), tb = h('tbody');
    t.appendChild(h('thead', null, h('tr', null, o.head.map(function (x) { return h('th', { text: x }); }))));
    o.rows.forEach(function (r) { tb.appendChild(h('tr', null, r.map(function (c, i) { return h('td' + (i ? '.num' : ''), { text: typeof c === 'number' ? U.num(c) : String(c) }); }))); });
    t.appendChild(tb);
    host.appendChild(h('details.k-tablefold', null, h('summary', { text: 'As table' }), h('div.table-wrap', null, t)));
  };

  g.LnpChart = C;
})(window);
