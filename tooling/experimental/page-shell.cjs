'use strict';
/**
 * EXPERIMENTAL (`features.livePage`) — the read-only live page shell. CLAUDE CODE HOSTED-ARTIFACT PAGE
 * RUNTIME ONLY: it needs a published page with a document store (`window.claude.use('db')`). Elsewhere the
 * rendered board file is the page, and this file has no use. See EXPERIMENTS.md.
 *
 * WHAT IT IS. A page body that holds NO run data of its own. It reads, live, the section documents that
 * `npx builder run board-render <key> --json` writes (one document per board section, a large section
 * split into numbered parts), from the page store's `page` collection, and renders them. With no data it
 * renders an em-dash notice and says so.
 * (folder layout: node scripts/board-render.mjs in place of npx builder run board-render)
 *
 * WHAT IT MAY NOT DO. Viewers are read-only: the store is declared with reads for viewers and writes for
 * the owner only, and the page carries no control that writes — no write call, no click handler, no
 * click-to-advance status, no tick box. The markdown board is the truth and the rendered board file is
 * the canonical local copy; a viewer who could flip a status here would be editing a projection the board
 * never agreed to.
 *
 * COST. The page shows only what the render wrote. Accounting cells are derived from the harness's own
 * records at the pricing table's rate version, never an invoice, and an em-dash means unmeasured, never
 * zero. Per-seat cost belongs on a page only when the page is organisation-internal.
 *
 * `renderDocs` is self-contained on purpose — it is inlined into the page by `toString()`, so the function
 * the tests hold is byte-for-byte the function the page runs. Keep it ES5 and free of outer references.
 */

/** Declared when the shell is published: readers at `interact`, writes by the owner only. */
const PAGE_CAPABILITIES = { db: { rules: [{ path: '', read: 'interact', write: 'owner' }] } };

/** The collection the section documents live in. */
const PAGE_COLLECTION = 'page';

function renderDocs(docs) {
  var DASH = '—';
  var esc = function (v) {
    return String(v === null || v === undefined || v === '' ? DASH : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };
  var list = (docs || []).filter(function (d) {
    return d && typeof d.id === 'string' && Array.isArray(d.rows);
  });
  if (list.length === 0) {
    return '<p class="empty">' + DASH + ' No page data yet. Sections appear once the run loads them; until then the rendered board file is the only copy.</p>';
  }
  var groups = {};
  list.forEach(function (d) {
    var base = d.id.split('~')[0];
    (groups[base] = groups[base] || []).push(d);
  });
  return Object.keys(groups)
    .map(function (base) {
      return groups[base].sort(function (a, b) {
        return (a.part || 0) - (b.part || 0);
      });
    })
    .sort(function (a, b) {
      return (a[0].order || 0) - (b[0].order || 0);
    })
    .map(function (parts) {
      var head = parts[0];
      var expected = head.parts || 1;
      var rows = [];
      parts.forEach(function (p) {
        rows = rows.concat(p.rows);
      });
      var missing = expected > parts.length
        ? '<p class="warn">' + (expected - parts.length) + ' of ' + expected + ' part(s) of this section have not arrived — it is incomplete, not short.</p>'
        : '';
      var columns = Array.isArray(head.columns) ? head.columns : [];
      var body = rows.length === 0
        ? '<p class="empty">' + DASH + ' none recorded</p>'
        : '<div class="scroll"><table><thead><tr>' +
          columns.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + columns.map(function (_, i) { return '<td>' + esc(r[i]) + '</td>'; }).join('') + '</tr>';
          }).join('') +
          '</tbody></table></div>';
      return '<section><h2>' + esc(head.title) + '<span>' + esc(head.subtitle) + '</span></h2>' + missing + body + '</section>';
    })
    .join('\n');
}

const STYLE = `:root{--bg:#fbfbfa;--fg:#15191e;--dim:#687482;--line:#e2e5e9;--warn:#935f00;--mono:ui-monospace,"SF Mono",Consolas,monospace}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#101317;--fg:#e5ebf1;--dim:#8d97a3;--line:#29313a;--warn:#d6a03a}}
:root[data-theme="dark"]{--bg:#101317;--fg:#e5ebf1;--dim:#8d97a3;--line:#29313a;--warn:#d6a03a}
body{background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 18px 70px}
.status{font-family:var(--mono);font-size:12px;letter-spacing:2px;color:var(--dim)}
h1{font-size:26px;margin:6px 0 4px}
.lede{color:var(--dim);margin:0 0 10px;max-width:80ch}
h2{font-family:var(--mono);font-size:11.5px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);margin:30px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:12px}
h2 span{letter-spacing:0;text-transform:none;color:var(--fg)}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--dim);padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.empty{color:var(--dim);border:1px dashed var(--line);border-radius:8px;padding:12px}.warn{color:var(--warn)}
code{font-family:var(--mono);font-size:.9em}`;

const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page body (the hosted-page publisher wraps it in its own document skeleton).
 * @param {{title: string, key: string}} opts
 */
function shellHtml({ title, key }) {
  return `<title>${escText(title)}</title>
<style>${STYLE}</style>
<main class="wrap">
<div class="status" id="status">WAITING FOR DATA</div>
<h1>${escText(title)}</h1>
<p class="lede">A read-only projection of the <code>${escText(key)}</code> task board. The markdown board wins on any disagreement; accounting is derived at the rate version the render names, and an em-dash means unmeasured, never zero.</p>
<div id="page">${renderDocs([])}</div>
</main>
<script>
var renderDocs = ${renderDocs.toString()};
(function () {
  var status = document.getElementById('status');
  var page = document.getElementById('page');
  if (!window.claude || typeof window.claude.use !== 'function') {
    status.textContent = 'NO LIVE DATA IN THIS VIEW';
    return;
  }
  window.claude.use('db').then(function (db) {
    if (!db) {
      status.textContent = 'NO LIVE DATA IN THIS VIEW';
      return;
    }
    db.collection('${PAGE_COLLECTION}').onSnapshot(
      function (snap) {
        page.innerHTML = renderDocs(snap.docs.map(function (d) {
          return Object.assign({}, d.data(), { id: d.id });
        }));
        status.textContent = 'LIVE · ' + snap.size + ' SECTION DOCUMENT(S)';
      },
      function (e) {
        status.textContent = 'LIVE DATA STOPPED (' + e.code + ')';
      }
    );
  });
})();
</script>
`;
}

module.exports = { PAGE_CAPABILITIES, PAGE_COLLECTION, renderDocs, shellHtml };
