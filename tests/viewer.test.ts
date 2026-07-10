import { expect, test } from "bun:test";
import worker, { type Env } from "../server/worker";

const env: Env = {
  AUTH_TOKEN: "test-token",
  ARTIFACTS: {
    async put() {},
    async get() { return null; },
  },
};

test("GET /a/:id serves the viewer page with CSP", async () => {
  const res = await worker.fetch(new Request("https://share.test/a/some-id"), env);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  const csp = res.headers.get("Content-Security-Policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  const html = await res.text();
  expect(html).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
  expect(html).toContain("renderMd"); // viewer-md.js was inlined
  expect(html).not.toContain("inject:viewer-md.js"); // placeholder replaced
});

test("viewer-html.ts is in sync with its sources", async () => {
  const html = await Bun.file("server/viewer.html").text();
  const mdJs = await Bun.file("server/viewer-md.js").text();
  const merged = html.replace("<!-- inject:viewer-md.js -->", "<script>\n" + mdJs + "\n</script>");
  const generated = (await import("../server/viewer-html")).default;
  expect(generated).toBe(merged);
});
