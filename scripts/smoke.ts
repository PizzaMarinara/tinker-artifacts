// Full-lifecycle check against a RUNNING server (bun run dev, or production).
// One-time setup: bun cli/tinker-share.ts keygen dev
//   → paste the printed line into .dev.vars as UPLOAD_KEYS=… and restart dev.
// Then: TINKER_SHARE_URL=http://localhost:8787 bun run smoke
import { decryptEnvelope, deleteArtifact, loadConfig, push } from "../cli/tinker-share";

const config = loadConfig();
const file = "samples/notes.md";

const { viewUrl, deleteUrl } = await push(file, "1h", config);
const m = viewUrl.match(/\/a\/([^#]+)#(.+)$/);
if (!m) throw new Error(`unexpected view link shape: ${viewUrl}`);
const [, id, key] = m;

const ct = await fetch(`${config.url}/api/artifacts/${id}`);
if (!ct.ok) throw new Error(`ciphertext fetch failed: HTTP ${ct.status}`);
if (!Number(ct.headers.get("X-Expires-At"))) throw new Error("missing X-Expires-At header");
const envelope = await decryptEnvelope(new Uint8Array(await ct.arrayBuffer()), key);
if (envelope.content !== (await Bun.file(file).text())) throw new Error("decrypted content mismatch");

const viewer = await fetch(`${config.url}/a/${id}`);
if (!viewer.ok || !(await viewer.text()).includes("renderMd")) throw new Error("viewer page not served");
if (!(await fetch(`${config.url}/d/${id}`)).ok) throw new Error("delete page not served");
if (!(await fetch(`${config.url}/`)).ok) throw new Error("landing page not served");

await deleteArtifact(deleteUrl);
const gone = await fetch(`${config.url}/api/artifacts/${id}`);
if (gone.status !== 404) throw new Error(`expected 404 after delete, got ${gone.status}`);

console.log("smoke OK — full lifecycle verified (push → fetch/decrypt → pages → delete → gone)");
