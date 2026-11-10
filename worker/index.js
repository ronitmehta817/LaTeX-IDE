// Google sign-in for the editor. The browser still calls Google Drive itself;
// this Worker only keeps the refresh token, sealed in an HttpOnly cookie, and
// trades it for the short-lived access tokens the browser uses.

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const SCOPES = `openid email ${DRIVE_SCOPE}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SESSION_COOKIE = "google_session";
const HANDSHAKE_COOKIE = "google_handshake";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const HANDSHAKE_MAX_AGE = 10 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "===".slice((base64.length + 3) % 4)), (char) =>
    char.charCodeAt(0),
  );
}

function randomToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

// Safari drops Secure cookies on http://localhost, so they are Secure only over HTTPS.
function cookie(url, name, value, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Max-Age=${maxAge}; Path=/auth; HttpOnly; SameSite=Lax${secure}`;
}

async function sessionKey(secret) {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sessionKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

async function unseal(text, secret) {
  const [iv, data] = text.split(".");
  if (!iv || !data) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv) },
      await sessionKey(secret),
      fromBase64Url(data),
    );
    return JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
}

// The ID token comes straight from Google's token endpoint over TLS, so its
// claims can be trusted without checking the signature.
function readIdToken(idToken) {
  try {
    return JSON.parse(decoder.decode(fromBase64Url(String(idToken).split(".")[1])));
  } catch {
    return null;
  }
}

function json(status, body, cookies = []) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

function crossSite(request, url) {
  const origin = request.headers.get("Origin");
  return Boolean(origin) && origin !== url.origin;
}

async function requestTokens(env, params) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
}

async function login(env, url) {
  const state = randomToken();
  const verifier = randomToken();
  const consent = url.searchParams.get("consent") === "1";
  const challenge = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: "code",
    scope: SCOPES,
    state,
    code_challenge: toBase64Url(new Uint8Array(challenge)),
    code_challenge_method: "S256",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: consent ? "consent" : "select_account",
  }).toString();
  return redirect(google.toString(), [
    cookie(url, HANDSHAKE_COOKIE, `${state}.${verifier}.${consent ? 1 : 0}`, HANDSHAKE_MAX_AGE),
  ]);
}

async function callback(request, env, url) {
  const [state, verifier, consent] = readCookie(request, HANDSHAKE_COOKIE).split(".");
  const cleared = cookie(url, HANDSHAKE_COOKIE, "", 0);
  const fail = (code, detail) => {
    console.log(JSON.stringify({ event: "google_sign_in_failed", code, detail }));
    return redirect(`/?google_error=${code}`, [cleared]);
  };

  const error = url.searchParams.get("error");
  if (error) return fail(error === "access_denied" ? "cancelled" : "failed", error);
  if (!state || !verifier || url.searchParams.get("state") !== state) {
    return fail("state_mismatch");
  }

  const tokens = await requestTokens(env, {
    grant_type: "authorization_code",
    code: url.searchParams.get("code") ?? "",
    code_verifier: verifier,
    redirect_uri: `${url.origin}/auth/callback`,
  });
  if (!tokens.ok) return fail("failed", tokens.body.error ?? tokens.status);
  if (!String(tokens.body.scope ?? "").split(" ").includes(DRIVE_SCOPE)) {
    return fail("drive_permission");
  }
  if (!tokens.body.refresh_token) {
    // Google sends a refresh token only from its consent screen, which it
    // skips for apps the account has already allowed.
    if (consent !== "1") return redirect("/auth/login?consent=1", [cleared]);
    return fail("failed", "no_refresh_token");
  }
  const claims = readIdToken(tokens.body.id_token);
  if (claims?.aud !== env.GOOGLE_CLIENT_ID) return fail("failed", "id_token_audience");

  const session = await seal(
    { refreshToken: tokens.body.refresh_token, email: claims.email ?? "" },
    env.SESSION_SECRET,
  );
  return redirect("/", [cleared, cookie(url, SESSION_COOKIE, session, SESSION_MAX_AGE)]);
}

async function token(request, env, url) {
  if (crossSite(request, url)) return json(403, { error: "forbidden" });
  const sealed = readCookie(request, SESSION_COOKIE);
  const signedOut = () =>
    json(401, { error: "signed_out" }, sealed ? [cookie(url, SESSION_COOKIE, "", 0)] : []);
  const session = sealed ? await unseal(sealed, env.SESSION_SECRET) : null;
  if (!session?.refreshToken) return signedOut();

  const tokens = await requestTokens(env, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
  });
  if (tokens.body.error === "invalid_grant") return signedOut();
  if (!tokens.ok || !tokens.body.access_token) {
    console.log(
      JSON.stringify({ event: "google_token_failed", status: tokens.status, error: tokens.body.error }),
    );
    return json(502, { error: "google_unavailable" });
  }
  return json(
    200,
    {
      accessToken: tokens.body.access_token,
      expiresIn: tokens.body.expires_in,
      email: session.email,
    },
    [cookie(url, SESSION_COOKIE, sealed, SESSION_MAX_AGE)],
  );
}

// NVIDIA's API sends no CORS headers, so browsers can only reach it through
// the app's own origin. This proxy forwards /proxy/nvidia/* requests to
// integrate.api.nvidia.com, mirroring the Vite dev-server proxy.
const NVIDIA_TARGET = "https://integrate.api.nvidia.com";
const NVIDIA_PREFIX = "/proxy/nvidia";

function nvidiaProxy(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": url.origin,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const targetPath = url.pathname.replace(/^\/proxy\/nvidia/, "") || "/";
  const targetUrl = `${NVIDIA_TARGET}${targetPath}${url.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");

  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
  }).then((upstream) => {
    const proxyHeaders = new Headers(upstream.headers);
    proxyHeaders.set("Access-Control-Allow-Origin", url.origin);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: proxyHeaders,
    });
  }).catch((error) => {
    return new Response(
      JSON.stringify({ error: { message: `Proxy error: ${error.message || String(error)}` } }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": url.origin,
        },
      },
    );
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // NVIDIA proxy — runs before auth so it works even without Google credentials.
    if (url.pathname.startsWith(NVIDIA_PREFIX)) {
      return nvidiaProxy(request, url);
    }

    const route = `${request.method} ${url.pathname}`;
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
      return request.method === "GET"
        ? redirect("/?google_error=not_configured")
        : json(404, { error: "not_configured" });
    }
    try {
      if (route === "GET /auth/login") return await login(env, url);
      if (route === "GET /auth/callback") return await callback(request, env, url);
      if (route === "POST /auth/token") return await token(request, env, url);
      if (route === "POST /auth/logout") {
        if (crossSite(request, url)) return json(403, { error: "forbidden" });
        return json(204, undefined, [cookie(url, SESSION_COOKIE, "", 0)]);
      }
      return json(404, { error: "not_found" });
    } catch (error) {
      console.error(JSON.stringify({ event: "google_auth_error", route, message: String(error) }));
      return request.method === "GET"
        ? redirect("/?google_error=failed")
        : json(502, { error: "google_unavailable" });
    }
  },
};
