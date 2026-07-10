// Minimal Markdown renderer for the artifact viewer.
// Inlined into viewer.html by scripts/gen-viewer.ts; tests import it and use
// the globalThis exports (an inline <script> cannot use ESM exports).

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeUrl(u) {
  return /^(https?:|mailto:|#|\/)/i.test(u) ? u : "";
}

function inlineMd(s) {
  s = escapeHtml(s);
  // URL group tolerates one level of balanced parens (e.g. Wikipedia-style
  // links) while still stopping at the real closing paren of the markdown
  // link/image syntax.
  var URL_RE = "((?:[^\\s()]|\\([^()]*\\))+)";
  s = s.replace(new RegExp("!\\[([^\\]]*)\\]\\(" + URL_RE + "\\)", "g"), function (_m, alt, url) {
    return safeUrl(url) ? '<img alt="' + alt + '" src="' + url + '">' : alt;
  });
  s = s.replace(new RegExp("\\[([^\\]]+)\\]\\(" + URL_RE + "\\)", "g"), function (_m, text, url) {
    return safeUrl(url) ? '<a href="' + url + '" target="_blank" rel="noopener">' + text + "</a>" : text;
  });
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}

// Lines that terminate a paragraph because they start another block.
var BLOCK_START = /^(#{1,6}\s|```|\||>|\s*[-*]\s|\s*\d+\.\s|\s*$)/;

function renderMd(src) {
  var lines = src.replace(/\r\n/g, "\n").split("\n");
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^```/.test(line)) {
      i++;
      var code = [];
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
      continue;
    }
    var h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push("<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">");
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      var ul = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        ul.push("<li>" + inlineMd(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>");
        i++;
      }
      out.push("<ul>" + ul.join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      var ol = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        ol.push("<li>" + inlineMd(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
        i++;
      }
      out.push("<ol>" + ol.join("") + "</ol>");
      continue;
    }
    if (/^>\s?/.test(line)) {
      var q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push("<blockquote>" + renderMd(q.join("\n")) + "</blockquote>");
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      var cells = function (l) {
        return l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(function (c) {
          return inlineMd(c.trim());
        });
      };
      var head = cells(line);
      i += 2;
      var rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push(
        "<table><thead><tr>" +
          head.map(function (c) { return "<th>" + c + "</th>"; }).join("") +
          "</tr></thead><tbody>" +
          rows.map(function (r) {
            return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
          }).join("") +
          "</tbody></table>",
      );
      continue;
    }
    var para = [line];
    i++;
    while (i < lines.length && !BLOCK_START.test(lines[i])) { para.push(lines[i]); i++; }
    out.push("<p>" + inlineMd(para.join(" ")) + "</p>");
  }
  return out.join("\n");
}

var MD_CSS =
  ":root{color-scheme:light dark}" +
  "body{margin:0;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;line-height:1.6}" +
  "main{max-width:44rem;margin:0 auto;padding:2rem 1.25rem}" +
  "pre{background:rgba(127,127,127,.12);padding:1rem;border-radius:8px;overflow-x:auto}" +
  "code{background:rgba(127,127,127,.12);padding:.1em .3em;border-radius:4px;font-family:ui-monospace,monospace;font-size:.9em}" +
  "pre code{background:none;padding:0}" +
  "table{border-collapse:collapse;display:block;overflow-x:auto}" +
  "th,td{border:1px solid rgba(127,127,127,.35);padding:.4em .7em;text-align:left}" +
  "blockquote{margin:0;padding-left:1em;border-left:3px solid rgba(127,127,127,.4)}" +
  "img{max-width:100%}";

function mdPage(title, bodyHtml) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + escapeHtml(title) + "</title><style>" + MD_CSS + "</style></head>" +
    "<body><main>" + bodyHtml + "</main></body></html>"
  );
}

globalThis.renderMd = renderMd;
globalThis.mdPage = mdPage;
globalThis.escapeHtmlMd = escapeHtml;
