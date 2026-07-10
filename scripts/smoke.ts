// End-to-end check against a RUNNING server (bun run dev, or production).
//   TINKER_SHARE_URL=http://localhost:8787 TINKER_SHARE_TOKEN=dev-token bun run smoke
import { decryptEnvelope, loadConfig, push } from "../cli/tinker-share";

const config = loadConfig();
const file = "samples/notes.md";

const link = await push(file, "1h", config);
const m = link.match(/\/a\/([^#]+)#(.+)$/);
if (!m) throw new Error(`unexpected link shape: ${link}`);
const [, id, key] = m;

const ct = await fetch(`${config.url}/api/artifacts/${id}`);
if (!ct.ok) throw new Error(`ciphertext fetch failed: HTTP ${ct.status}`);
const envelope = await decryptEnvelope(new Uint8Array(await ct.arrayBuffer()), key);
const original = await Bun.file(file).text();
if (envelope.content !== original) throw new Error("decrypted content does not match original");

const viewer = await fetch(`${config.url}/a/${id}`);
if (!viewer.ok || !(await viewer.text()).includes("renderMd")) throw new Error("viewer page not served");

console.log("smoke OK — open this in a browser to eyeball it:");
console.log(link);
