const encoder = new TextEncoder();

function b64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importPrivateKey(pem) {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function canonicalPath(url) {
  return new URL(url).pathname + new URL(url).search;
}

async function signRequest({ method, url, body, tenancy, user, fingerprint, privateKeyPem }) {
  const u = new URL(url);
  const date = new Date().toUTCString();
  const bodyBytes = encoder.encode(body || "");
  const digest = await crypto.subtle.digest("SHA-256", bodyBytes);
  const contentSha256 = b64(new Uint8Array(digest));
  const contentLength = String(bodyBytes.byteLength);
  const target = `${method.toLowerCase()} ${canonicalPath(url)}`;

  const headers = {
    date,
    host: u.host,
    "content-length": contentLength,
    "content-type": "application/json",
    "x-content-sha256": contentSha256,
  };

  const signingString = [
    `date: ${date}`,
    `(request-target): ${target}`,
    `host: ${u.host}`,
    `content-length: ${contentLength}`,
    `content-type: application/json`,
    `x-content-sha256: ${contentSha256}`,
  ].join("\n");

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    encoder.encode(signingString)
  );

  headers.authorization = [
    'Signature version="1"',
    'algorithm="rsa-sha256"',
    `headers="date (request-target) host content-length content-type x-content-sha256"`,
    `keyId="${tenancy}/${user}/${fingerprint}"`,
    `signature="${b64(new Uint8Array(signature))}"`,
  ].join(",");

  return headers;
}

function requireConfig(env) {
  const required = [
    "OCI_TENANCY_OCID",
    "OCI_USER_OCID",
    "OCI_KEY_FINGERPRINT",
    "OCI_PRIVATE_KEY",
    "OCI_INSTANCE_OCID",
    "OCI_REGION",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing OCI watchdog configuration: ${missing.join(", ")}`);
}

export async function ociSignedRequest(env, method, path, body = "") {
  requireConfig(env);
  const base = `https://iaas.${env.OCI_REGION}.oraclecloud.com`;
  const url = `${base}${path}`;
  const headers = await signRequest({
    method,
    url,
    body,
    tenancy: env.OCI_TENANCY_OCID,
    user: env.OCI_USER_OCID,
    fingerprint: env.OCI_KEY_FINGERPRINT,
    privateKeyPem: env.OCI_PRIVATE_KEY,
  });

  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!response.ok) {
    throw new Error(`OCI API ${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return data;
}

export async function getInstance(env) {
  return ociSignedRequest(
    env,
    "GET",
    `/20160918/instances/${encodeURIComponent(env.OCI_INSTANCE_OCID)}`
  );
}

export async function instanceAction(env, action) {
  return ociSignedRequest(
    env,
    "POST",
    `/20160918/instances/${encodeURIComponent(env.OCI_INSTANCE_OCID)}/actions/action`,
    JSON.stringify({ action })
  );
}
