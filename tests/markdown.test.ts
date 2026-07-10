import { expect, test } from "bun:test";
import "../server/viewer-md.js";

const renderMd = (globalThis as any).renderMd as (s: string) => string;
const mdPage = (globalThis as any).mdPage as (t: string, b: string) => string;

test("headings", () => {
  expect(renderMd("# Title")).toBe("<h1>Title</h1>");
  expect(renderMd("### Sub")).toBe("<h3>Sub</h3>");
});

test("paragraph with inline styles", () => {
  expect(renderMd("hello **bold** *em* `code`")).toBe(
    "<p>hello <strong>bold</strong> <em>em</em> <code>code</code></p>",
  );
});

test("multi-line paragraph joins with spaces, blank line splits", () => {
  expect(renderMd("one\ntwo\n\nthree")).toBe("<p>one two</p>\n<p>three</p>");
});

test("links open in new tab", () => {
  expect(renderMd("[x](https://e.com)")).toBe(
    '<p><a href="https://e.com" target="_blank" rel="noopener">x</a></p>',
  );
});

test("unordered and ordered lists", () => {
  expect(renderMd("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  expect(renderMd("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
});

test("fenced code is escaped verbatim", () => {
  expect(renderMd("```\n<script>alert(1)</script>\n```")).toBe(
    "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
  );
});

test("raw html in text is escaped", () => {
  expect(renderMd("<img src=x onerror=alert(1)>")).toContain("&lt;img");
});

test("table with header row", () => {
  expect(renderMd("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
    "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("blockquote and hr", () => {
  expect(renderMd("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
  expect(renderMd("---")).toBe("<hr>");
});

test("unsafe url schemes are not linked", () => {
  expect(renderMd("[x](javascript:alert(1))")).toBe("<p>x</p>");
  expect(renderMd("![x](javascript:alert(1))")).toBe("<p>x</p>");
  expect(renderMd("[rel](/docs/page)")).toBe('<p><a href="/docs/page" target="_blank" rel="noopener">rel</a></p>');
});

test("mdPage escapes title and wraps body", () => {
  const page = mdPage("<t>", "<p>x</p>");
  expect(page).toContain("<title>&lt;t&gt;</title>");
  expect(page).toContain("<main><p>x</p></main>");
});
