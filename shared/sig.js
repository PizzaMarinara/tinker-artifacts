// Shared HTTP message-signature helpers (strict RFC 9421 profile).
// Plain JS with globalThis exports so the worker verifier, the CLI signer,
// and tests all build byte-identical signature bases. Import for side effects.
(function () {
  function b64Encode(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64Decode(s) {
    var b = atob(s);
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function b64uEncode(bytes) {
    return b64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64uDecode(s) {
    return b64Decode(s.replace(/-/g, "+").replace(/_/g, "/"));
  }

  async function contentDigestHeader(bodyBytes) {
    var digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes));
    return "sha-256=:" + b64Encode(digest) + ":";
  }

  var COMPONENTS = '("@method" "@path" "@query" "content-digest")';

  function signatureParams(created, keyid) {
    return COMPONENTS + ";created=" + created + ';keyid="' + keyid + '";alg="ed25519"';
  }

  function buildSignatureBase(method, path, query, contentDigest, created, keyid) {
    return (
      '"@method": ' + method.toUpperCase() + "\n" +
      '"@path": ' + path + "\n" +
      '"@query": ' + query + "\n" +
      '"content-digest": ' + contentDigest + "\n" +
      '"@signature-params": ' + signatureParams(created, keyid)
    );
  }

  function buildSignatureInput(created, keyid) {
    return "sig1=" + signatureParams(created, keyid);
  }

  var SIG_INPUT_RE = /^sig1=\("@method" "@path" "@query" "content-digest"\);created=(\d{1,12});keyid="([A-Za-z0-9_.-]{1,64})";alg="ed25519"$/;

  function parseSignatureInput(header) {
    var m = SIG_INPUT_RE.exec(header);
    return m ? { created: Number(m[1]), keyid: m[2] } : null;
  }

  var SIG_RE = /^sig1=:([A-Za-z0-9+/]+={0,2}):$/;

  function parseSignature(header) {
    var m = SIG_RE.exec(header);
    return m ? m[1] : null;
  }

  globalThis.tinkerSig = {
    b64Encode: b64Encode,
    b64Decode: b64Decode,
    b64uEncode: b64uEncode,
    b64uDecode: b64uDecode,
    contentDigestHeader: contentDigestHeader,
    buildSignatureBase: buildSignatureBase,
    buildSignatureInput: buildSignatureInput,
    parseSignatureInput: parseSignatureInput,
    parseSignature: parseSignature,
  };
})();
