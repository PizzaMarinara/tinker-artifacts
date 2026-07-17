import { expect, test } from "bun:test";
import worker, { type Env } from "../server/cf";

const env: Env = {
  UPLOAD_KEYS: "",
  ARTIFACTS: {
    async put() {},
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
    async delete() {},
  },
};

test("GET /a/:id serves the viewer with CSP, top bar, and download button", async () => {
  const res = await worker.fetch(new Request("https://share.test/a/some-id"), env);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  const csp = res.headers.get("Content-Security-Policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  const html = await res.text();
  expect(html).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
  expect(html).toContain("renderMd");
  expect(html).toContain('id="bar"');
  expect(html).toContain("Download");
  expect(html).toContain("X-Expires-At");
  expect(html).not.toContain("inject:viewer-md.js");
});

test("GET /d/:id serves the delete confirm page with CSP", async () => {
  const res = await worker.fetch(new Request("https://share.test/d/some-id"), env);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
  const html = await res.text();
  expect(html).toContain("Delete this artifact?");
  expect(html).toContain("X-Delete-Token");
});

test("GET / serves the landing page", async () => {
  const res = await worker.fetch(new Request("https://share.test/"), env);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("tinker-artifacts");
});

test("generated pages are in sync with their sources", async () => {
  const viewerSrc = await Bun.file("server/viewer.html").text();
  const mdJs = await Bun.file("server/viewer-md.js").text();
  const mergedViewer = viewerSrc.replace("<!-- inject:viewer-md.js -->", "<script>\n" + mdJs + "\n</script>");
  expect((await import("../server/viewer-html")).default).toBe(mergedViewer);
  expect((await import("../server/delete-html")).default).toBe(await Bun.file("server/delete.html").text());
  expect((await import("../server/landing-html")).default).toBe(await Bun.file("server/landing.html").text());
});
