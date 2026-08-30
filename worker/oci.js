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
  const body = String(pem)
    .replace(/^\uFEFF/, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\r?\nOCI_API_KEY\s*$/i, "")
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
  const u = new URL(url);
  return u.pathname + u.search;
}

async function signRequest({ method, url, body, tenancy, user, fingerprint, privateKeyPem }) {
  const u = new URL(url);
  const normalizedMethod = method.toLowerCase();
  const target = `${normalizedMethod} ${canonicalPath(url)}`;

  // OCI accepts x-date and prefers it when present. Using x-date avoids any
  // intermediary/runtime Date header normalization or replacement.
  const xDate = new Date().toUTCString();

  const headers = {
    "x-date": xDate,
    host: u.host,
  };

  let signingString;
  let signedHeaders;

  if (normalizedMethod === "get" || normalizedMethod === "delete") {
    signedHeaders = "(request-target) x-date host";
    signingString = [
      `(request-target): ${target}`,
      `x-date: ${xDate}`,
      `host: ${u.host}`,
    ].join("\n");
  } else {
    const bodyText = body || "";
    const bodyBytes = encoder.encode(bodyText);
    const digest = await crypto.subtle.digest("SHA-256", bodyBytes);
    const contentSha256 = b64(new Uint8Array(digest));
    const contentLength = String(bodyBytes.byteLength);

    headers["content-length"] = contentLength;
    headers["content-type"] = "application/json";
    headers["x-content-sha256"] = contentSha256;

    // Match OCI's documented POST signing set exactly.
    signedHeaders = "(request-target) x-date host content-length content-type x-content-sha256";
    signingString = [
      `(request-target): ${target}`,
      `x-date: ${xDate}`,
      `host: ${u.host}`,
      `content-length: ${contentLength}`,
      `content-type: application/json`,
      `x-content-sha256: ${contentSha256}`,
    ].join("\n");
  }

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    encoder.encode(signingString)
  );

  headers.authorization = [
    'Signature version="1"',
    `keyId="${tenancy}/${user}/${fingerprint}"`,
    'algorithm="rsa-sha256"',
    `headers="${signedHeaders}"`,
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
  if (missing.length) {
    throw new Error(`Missing OCI watchdog configuration: ${missing.join(", ")}`);
  }
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

  const requestInit = { method, headers };
  if (method !== "GET" && method !== "DELETE") requestInit.body = body;

  const response = await fetch(url, requestInit);
  const text = await response.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `OCI API ${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`
    );
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
  // OCI's InstanceAction operation takes the action as a query parameter,
  // not as a path segment or JSON body field:
  //   POST /20160918/instances/{instanceId}?action=START
  // The request body is empty for standard power actions (START/STOP/RESET).
  return ociSignedRequest(
    env,
    "POST",
    `/20160918/instances/${encodeURIComponent(env.OCI_INSTANCE_OCID)}?action=${encodeURIComponent(action)}`,
    ""
  );
}
