/* LNP Patent Desk: How to. Route: #howto, deep link #howto-<id> (for example #howto-markush). Step-by-step tutorials with screenshots.
   The text comes from app/views/lib/howto-data.js (the same source makes docs/TUTORIALS.md), the pictures from app/howto/<id>-<n>.jpg
   (made by tests/howto_shots.cjs from the website build, light theme). All text is inserted with textContent; nothing here reads patent text.
   A picture that cannot be loaded (a build without the image files) is replaced by its description. Needs no capability and no data. */
(function (g) {
  'use strict';
  var U = g.LnpUI, R = g.LnpRouter, h = U.h;
  if (!g.LnpLazyView) g.LnpLazyView = (function () {
    var reg = {};
    function one(n) {
      return reg[n] || (reg[n] = new Promise(function (res, rej) {
        var el;
        if (/\.css$/.test(n)) { el = document.createElement('link'); el.rel = 'stylesheet'; el.href = n; el.onload = el.onerror = function () { res(true); }; }
        else { el = document.createElement('script'); el.src = n; el.async = false; el.onload = function () { res(true); }; el.onerror = function () { delete reg[n]; rej({ code: 'script', message: 'could not be loaded: ' + n }); }; }
        document.head.appendChild(el);
      }));
    }
    return function (id, need, real) {
      return function (host, route, App) {
        var inst = null, dead = false;
        need.reduce(function (p, n) { return p.then(function () { return one(n); }); }, Promise.resolve()).then(function () { if (!dead) inst = real(host, route, App); }).catch(function (e) {
          App.logError('view ' + id, e);
          if (!dead) g.LnpUI.set(host, g.LnpUI.h('div.page', null, g.LnpUI.h('p.notice.err', { text: 'The view could not be built: ' + g.LnpUI.errText(e) })));
        });
        return { update: function (r) { return inst && inst.update ? inst.update(r) : false; }, destroy: function () { dead = true; try { if (typeof inst === 'function') inst(); else if (inst && inst.destroy) inst.destroy(); } catch (e) { App.logError('view ' + id, e); } } };
      };
    };
  })();

  var IMG_DIR = 'app/howto/';

  function mount(host, route, App) {
    var K = g.LnpKit, D = g.LnpHowtoData, dead = false, lightbox = null;
    var T = D.tutorials, byId = {};
    T.forEach(function (t) { byId[t.id] = t; });
    var cur = byId[route.arg] ? route.arg : T[0].id;

    var listEl = h('nav.hw-list', { 'aria-label': 'Tutorials' });
    var artEl = h('article.hw-art', { id: 'hw-art', tabindex: '-1' });
    var page = h('div.page.k-page.hw-page', { data: { tutorial: cur } },
      K.head('How to', 'Step by step,', 'with the real screens', 'Short tutorials for the main parts of the Patent Desk. Every step has a picture of the page as it looks in the website build; "Try it" opens the same page here. Everything shown is a pre-screening aid, not legal advice.'),
      h('div.hw-grid', null, listEl, artEl),
      wordsBox());
    host.appendChild(page);

    function wordsBox() {
      var dl = h('dl.hw-words');
      D.words.forEach(function (w) { dl.appendChild(h('dt', { text: w[0] })); dl.appendChild(h('dd', { text: w[1] })); });
      return h('details.k-fold.hw-gloss', { id: 'hw-gloss' }, h('summary', null, U.icon('help'), h('span', { text: 'Words used in these tutorials' })), h('div.k-fold-body', null, dl));
    }

    function href(id) { return R && R.build ? R.build({ view: 'howto', arg: id }) : '#howto-' + id; }
    function drawList() {
      U.clear(listEl);
      T.forEach(function (t, i) {
        var a = h('a.hw-item', { href: href(t.id), data: { id: t.id }, 'aria-current': t.id === cur ? 'page' : null,
          onclick: function (ev) { if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return; ev.preventDefault(); choose(t.id, true); } },
          h('span.hw-n', { text: String(i + 1) }), h('span.hw-t', { text: t.title }));
        listEl.appendChild(a);
      });
    }

    /* ---------------------------------------------------------- picture with a full-size view */
    function closeBox() { if (!lightbox) return; var b = lightbox; lightbox = null; b.el.parentNode && b.el.parentNode.removeChild(b.el); document.removeEventListener('keydown', b.key, true); try { if (b.prev && b.prev.focus) b.prev.focus(); } catch (e) { /* ignore */ } }
    function openBox(src, alt) {
      closeBox();
      var prev = document.activeElement;
      var close = h('button.btn.sm.hw-lb-x', { type: 'button', 'aria-label': 'Close', onclick: closeBox }, U.icon('x'), 'Close');
      var open = h('a.btn.sm', { href: src, target: '_blank', rel: 'noopener' }, U.icon('ext'), 'Open in a new tab');
      var el = h('div.hw-lb', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Screenshot: ' + alt, onmousedown: function (ev) { if (ev.target === el) closeBox(); } },
        h('div.hw-lb-bar', null, h('span.hw-lb-cap', { text: alt }), open, close),
        h('div.hw-lb-body', null, h('img', { src: src, alt: alt })));
      function key(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeBox(); } else if (ev.key === 'Tab') { ev.preventDefault(); close.focus(); } }
      document.addEventListener('keydown', key, true);
      document.getElementById('overlays').appendChild(el);
      lightbox = { el: el, key: key, prev: prev };
      try { close.focus(); } catch (e) { /* ignore */ }
    }
    function picture(step) {
      var src = IMG_DIR + step.img + '.jpg';
      var im = h('img', { src: src, alt: step.alt, loading: 'lazy', decoding: 'async', width: '1366', height: '854' });
      var btn = h('button.hw-shot', { type: 'button', 'aria-label': 'Enlarge screenshot: ' + step.alt, title: 'Click to enlarge', onclick: function () { openBox(src, step.alt); } }, im);
      im.addEventListener('error', function () {
        U.set(fig, h('p.hw-miss', { role: 'img', 'aria-label': step.alt, text: 'Screenshot not available in this build: ' + step.alt }));
      });
      var fig = h('figure.hw-fig', null, btn);
      return fig;
    }

    /* ---------------------------------------------------------- one tutorial */
    function tryLink(r, label) {
      if (!r) return null;
      return h('a.btn.sm.hw-try', { href: r, 'aria-label': (label || 'Try it') + ': open ' + r.replace(/^#/, '').split('-')[0] }, U.icon('link'), label || 'Try it');
    }
    function draw() {
      var t = byId[cur];
      page.dataset.tutorial = cur;
      var steps = h('ol.hw-steps');
      t.steps.forEach(function (s, i) {
        steps.appendChild(h('li.hw-step', { data: { step: String(i + 1), img: s.img || '' } },
          h('div.hw-step-body', null, h('p.hw-text', { text: s.text }), s.route && s.route !== t.route ? h('p.hw-act', null, tryLink(s.route, 'Try it')) : null),
          s.img ? picture(s) : null));
      });
      var lim = h('ul.hw-limits-list');
      t.limits.concat(D.common).forEach(function (x) { lim.appendChild(h('li', { text: x })); });
      var idx = T.indexOf(t), prev = T[idx - 1], next = T[idx + 1];
      U.set(artEl,
        h('header.hw-head', null,
          h('p.overline', { text: 'Tutorial ' + (idx + 1) + ' of ' + T.length }),
          h('h2.hw-title', { text: t.title }),
          h('p.hw-sum', { text: t.summary }),
          h('p.hw-act', null, tryLink(t.route, 'Try it'))),
        steps,
        h('aside.hw-limits', { 'aria-label': 'Limits' }, h('h3', { text: 'Limits' }), lim),
        h('nav.hw-pn', { 'aria-label': 'Previous and next tutorial' },
          prev ? h('a.btn.sm', { href: href(prev.id), onclick: function (ev) { ev.preventDefault(); choose(prev.id, true); } }, U.icon('back'), prev.title) : h('span'),
          next ? h('a.btn.sm', { href: href(next.id), onclick: function (ev) { ev.preventDefault(); choose(next.id, true); } }, next.title, U.icon('back', 'hw-fwd')) : h('span')));
      Array.prototype.forEach.call(listEl.children, function (a) { if (a.dataset.id === cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    }
    function choose(id, push) {
      if (!byId[id]) id = T[0].id;
      var changed = id !== cur; cur = id;
      if (push && R && R.go) R.go({ view: 'howto', arg: id }, { silent: true });
      closeBox(); draw();
      if (changed || push) { var v = document.getElementById('view'); if (v) v.scrollTop = 0; try { artEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }

    drawList(); draw();
    return {
      update: function (r) { if (dead) return true; var id = byId[r.arg] ? r.arg : T[0].id; if (id !== cur) choose(id, false); return true; },
      destroy: function () { dead = true; closeBox(); }
    };
  }

  g.LnpApp.registerView({ id: 'howto', title: 'How to', icon: 'help', rail: true,
    mount: g.LnpLazyView('howto', ['app/views/views.css', 'app/views/lib/kit.js', 'app/views/lib/howto-data.js', 'app/x-howto.css'], mount) });
})(window);
