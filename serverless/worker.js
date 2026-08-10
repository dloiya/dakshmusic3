const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extra,
    },
  });

const now = () => Math.floor(Date.now() / 1000);

/* =========================================================
   ENCODING / CRYPTO
   ========================================================= */

function b64(bytes) {
  let s = "";
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }

  return btoa(s)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function hex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(text) {
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text)
    )
  );
}

/*
 * Must match the browser password-generation script:
 *
 * PBKDF2
 * SHA-256
 * 310000 iterations
 * 256-bit output
 */
async function pbkdf2(password, saltB64) {
  if (!saltB64) {
    throw new Error("PASSWORD_SALT is not configured");
  }

  let normalized = saltB64
    .replaceAll("-", "+")
    .replaceAll("_", "/");

  normalized += "=".repeat(
    (4 - (normalized.length % 4)) % 4
  );

  const binary = atob(normalized);

  const raw = Uint8Array.from(
    binary,
    (c) => c.charCodeAt(0)
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: raw,
      iterations: 310000,
      hash: "SHA-256",
    },
    key,
    256
  );

  return b64(new Uint8Array(bits));
}

/* =========================================================
   COOKIE / SESSION
   ========================================================= */

function cookie(req) {
  const value = req.headers.get("Cookie") || "";

  const match = value.match(
    /(?:^|;\s*)music_session=([^;]+)/
  );

  return match?.[1] || null;
}

async function requireAuth(env, req) {
  const token = cookie(req);

  if (!token) {
    return false;
  }

  const idHash = await sha256(token);

  const row = await env.DB.prepare(
    `
    SELECT id_hash
    FROM sessions
    WHERE id_hash = ?
      AND expires_at > ?
    `
  )
    .bind(idHash, now())
    .first();

  return !!row;
}

async function sessionCookie(env) {
  if (!env.DB) {
    throw new Error("D1 binding DB is not configured");
  }

  const token = b64(
    crypto.getRandomValues(
      new Uint8Array(32)
    )
  );

  const idHash = await sha256(token);

  await env.DB.prepare(
    `
    INSERT OR REPLACE INTO sessions
      (id_hash, expires_at)
    VALUES
      (?, ?)
    `
  )
    .bind(
      idHash,
      now() + 60 * 60 * 24 * 30
    )
    .run();

  return [
    `music_session=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=2592000",
  ].join("; ");
}

/* =========================================================
   AUTH
   ========================================================= */

async function login(env, req) {
  if (!env.PASSWORD_HASH || !env.PASSWORD_SALT) {
    console.error(
      "PASSWORD_HASH or PASSWORD_SALT is not configured"
    );

    return json(
      {
        error:
          "Authentication is not configured",
      },
      500
    );
  }

  if (!env.DB) {
    console.error(
      "D1 binding DB is not configured"
    );

    return json(
      {
        error:
          "Database is not configured",
      },
      500
    );
  }

  let body;

  try {
    body = await req.json();
  } catch {
    return json(
      {
        error: "Invalid JSON body",
      },
      400
    );
  }

  const password = String(
    body?.password || ""
  );

  if (!password) {
    return json(
      {
        error: "Password is required",
      },
      400
    );
  }

  try {
    const actual = await pbkdf2(
      password,
      env.PASSWORD_SALT
    );

    if (actual !== env.PASSWORD_HASH) {
      return json(
        {
          error: "Invalid password",
        },
        401
      );
    }

    const session = await sessionCookie(env);

    return json(
      {
        ok: true,
      },
      200,
      {
        "Set-Cookie": session,
      }
    );
  } catch (e) {
    console.error(
      "LOGIN ERROR:",
      e?.stack || e
    );

    return json(
      {
        error:
          "Login failed",
      },
      500
    );
  }
}

/* =========================================================
   DEEZER
   ========================================================= */

async function deezer(path, params = {}) {
  const url = new URL(
    `https://api.deezer.com/${path}`
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Deezer HTTP ${response.status}`
    );
  }

  return response.json();
}

async function search(env, req) {
  const url = new URL(req.url);

  const q = url.searchParams.get("q");

  if (!q) {
    return json(
      {
        error: "q is required",
      },
      400
    );
  }

  const data = await deezer("search", {
    q,
    limit: "25",
  });

  return json({
    items: (data.data || []).map((x) => ({
      source: "deezer",
      source_id: String(x.id),
      source_url: x.link,
      title: x.title,
      artist: x.artist?.name || null,
      album: x.album?.title || null,
      album_id: x.album?.id
        ? String(x.album.id)
        : null,
      duration_ms:
        (x.duration || 0) * 1000,
      artwork_url:
        x.album?.cover_xl ||
        x.album?.cover_big ||
        null,
    })),
  });
}

/* =========================================================
   TRACKS / PLAYLIST
   ========================================================= */

async function nextPosition(env) {
  const row = await env.DB.prepare(
    `
    SELECT COALESCE(MAX(position), 0) + 1 AS p
    FROM playlist_entries
    `
  ).first();

  return row?.p || 1;
}

async function getOrCreateTrack(env, body) {
  let track = null;

  if (body.source_id) {
    track = await env.DB.prepare(
      `
      SELECT *
      FROM tracks
      WHERE source_id = ?
      `
    )
      .bind(body.source_id)
      .first();
  }

  if (track) {
    return track;
  }

  const result = await env.DB.prepare(
    `
    INSERT INTO tracks (
      source,
      source_id,
      source_url,
      title,
      artist,
      album,
      album_id,
      duration_ms,
      artwork_url
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      body.source || "deezer",
      body.source_id || null,
      body.source_url || null,
      body.title,
      body.artist || null,
      body.album || null,
      body.album_id || null,
      body.duration_ms || null,
      body.artwork_url || null
    )
    .run();

  return await env.DB.prepare(
    `
    SELECT *
    FROM tracks
    WHERE id = ?
    `
  )
    .bind(result.meta.last_row_id)
    .first();
}

/* =========================================================
   GITHUB ACTIONS
   ========================================================= */

async function dispatchAcquisition(
  env,
  job,
  track
) {
  if (
    !env.GITHUB_TOKEN ||
    !env.GITHUB_OWNER ||
    !env.GITHUB_REPO
  ) {
    throw new Error(
      "GitHub Actions dispatch is not configured"
    );
  }

  const url =
    `https://api.github.com/repos/` +
    `${env.GITHUB_OWNER}/` +
    `${env.GITHUB_REPO}/` +
    `actions/workflows/acquire-audio.yml/dispatches`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      Accept:
        "application/vnd.github+json",

      Authorization:
        `Bearer ${env.GITHUB_TOKEN}`,

      "X-GitHub-Api-Version":
        "2026-03-10",

      "User-Agent":
        "personal-music-server",

      "Content-Type":
        "application/json",
    },

    body: JSON.stringify({
      ref: "main",

      inputs: {
        job_id: job.id,
        source_url:
          track.source_url || "",
        title:
          track.title || "",
        artist:
          track.artist || "",
        album:
          track.album || "",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub dispatch failed: ` +
      `${response.status} ` +
      `${await response.text()}`
    );
  }
}

/* =========================================================
   DOWNLOAD QUEUE
   ========================================================= */

async function enqueue(
  env,
  trackId,
  kind
) {
  const id =
    crypto.randomUUID();

  const track =
    await env.DB.prepare(
      `
      SELECT *
      FROM tracks
      WHERE id = ?
      `
    )
      .bind(trackId)
      .first();

  if (!track) {
    throw new Error(
      "Track not found"
    );
  }

  await env.DB.prepare(
    `
    INSERT INTO download_jobs
      (id, track_id, kind, status)
    VALUES
      (?, ?, ?, 'queued')
    `
  )
    .bind(
      id,
      trackId,
      kind
    )
    .run();

  try {
    await dispatchAcquisition(
      env,
      { id },
      track
    );

    await env.DB.prepare(
      `
      UPDATE download_jobs
      SET
        status = 'dispatched',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
      .bind(id)
      .run();

  } catch (e) {
    await env.DB.prepare(
      `
      UPDATE download_jobs
      SET
        status = 'failed',
        error = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
      .bind(
        String(e),
        id
      )
      .run();

    throw e;
  }

  return id;
}

/* =========================================================
   PLAYLIST
   ========================================================= */

async function playlist(
  env,
  method,
  req
) {
  if (method === "GET") {
    const { results } =
      await env.DB.prepare(
        `
        SELECT
          p.id AS entry_id,
          p.position,
          t.*
        FROM playlist_entries p
        JOIN tracks t
          ON t.id = p.track_id
        ORDER BY p.position
        `
      ).all();

    return json(results);
  }

  if (method === "POST") {
    const body = await req.json();

    if (!body.title) {
      return json(
        {
          error:
            "Track title is required",
        },
        400
      );
    }

    const track =
      await getOrCreateTrack(
        env,
        body
      );

    const position =
      await nextPosition(env);

    await env.DB.prepare(
      `
      INSERT INTO playlist_entries
        (track_id, position)
      VALUES
        (?, ?)
      `
    )
      .bind(
        track.id,
        position
      )
      .run();

    const jobId =
      await enqueue(
        env,
        track.id,
        "general"
      );

    return json(
      {
        track_id: track.id,
        position,
        job_id: jobId,
      },
      201
    );
  }

  return json(
    {
      error:
        "Method not allowed",
    },
    405
  );
}

/* =========================================================
   JOB STATUS
   ========================================================= */

async function jobStatus(
  env,
  id
) {
  const row =
    await env.DB.prepare(
      `
      SELECT *
      FROM download_jobs
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  return row
    ? json(row)
    : json(
        {
          error:
            "Job not found",
        },
        404
      );
}

/* =========================================================
   ACQUISITION CALLBACK
   ========================================================= */

async function callback(
  env,
  req
) {
  const supplied =
    req.headers.get(
      "X-Callback-Secret"
    );

  if (
    !supplied ||
    supplied !==
      env.CALLBACK_SECRET
  ) {
    return json(
      {
        error:
          "Unauthorized",
      },
      401
    );
  }

  const body =
    await req.json();

  if (!body.job_id) {
    return json(
      {
        error:
          "job_id is required",
      },
      400
    );
  }

  await env.DB.prepare(
    `
    UPDATE download_jobs
    SET
      status = ?,
      provider = ?,
      drive_file_id = ?,
      format = ?,
      mime_type = ?,
      error = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `
  )
    .bind(
      body.status,
      body.provider || null,
      body.drive_file_id || null,
      body.format || null,
      body.mime_type || null,
      body.error || null,
      body.job_id
    )
    .run();

  if (
    body.status === "complete" &&
    body.drive_file_id
  ) {
    const job =
      await env.DB.prepare(
        `
        SELECT *
        FROM download_jobs
        WHERE id = ?
        `
      )
        .bind(body.job_id)
        .first();

    if (
      job?.kind === "general"
    ) {
      await env.DB.prepare(
        `
        INSERT OR REPLACE INTO general_cache
          (
            track_id,
            drive_file_id,
            last_accessed_at
          )
        VALUES
          (?, ?, CURRENT_TIMESTAMP)
        `
      )
        .bind(
          job.track_id,
          body.drive_file_id
        )
        .run();

      /*
       * Keep maximum 25 general-cache entries.
       */
      const old =
        await env.DB.prepare(
          `
          SELECT id, drive_file_id
          FROM general_cache
          ORDER BY last_accessed_at DESC
          LIMIT -1 OFFSET 25
          `
        ).all();

      for (
        const row of
          old.results || []
      ) {
        await env.DB.prepare(
          `
          DELETE FROM general_cache
          WHERE id = ?
          `
        )
          .bind(row.id)
          .run();
      }
    }
  }

  return json({
    ok: true,
  });
}

/* =========================================================
   GOOGLE DRIVE
   ========================================================= */

async function driveToken(env) {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error(
      "Google Drive credentials are not configured"
    );
  }

  const response =
    await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/x-www-form-urlencoded",
        },

        body:
          new URLSearchParams({
            client_id:
              env.GOOGLE_CLIENT_ID,

            client_secret:
              env.GOOGLE_CLIENT_SECRET,

            refresh_token:
              env.GOOGLE_REFRESH_TOKEN,

            grant_type:
              "refresh_token",
          }),
      }
    );

  if (!response.ok) {
    throw new Error(
      `Google token refresh failed: ` +
      `${response.status}`
    );
  }

  const data =
    await response.json();

  if (!data.access_token) {
    throw new Error(
      "Google did not return an access token"
    );
  }

  return data.access_token;
}

/* =========================================================
   PLAYBACK
   ========================================================= */

async function playback(
  env,
  trackId
) {
  const row =
    await env.DB.prepare(
      `
      SELECT
        t.*,
        g.drive_file_id
      FROM tracks t
      JOIN general_cache g
        ON g.track_id = t.id
      WHERE t.id = ?
      `
    )
      .bind(trackId)
      .first();

  if (!row) {
    return json(
      {
        error:
          "Track is not in the server cache",
      },
      409
    );
  }

  const token =
    await driveToken(env);

  const response =
    await fetch(
      `https://www.googleapis.com/drive/v3/files/` +
      `${encodeURIComponent(row.drive_file_id)}` +
      `?alt=media`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,
        },
      }
    );

  if (!response.ok) {
    return json(
      {
        error:
          "Drive download failed",
      },
      502
    );
  }

  await env.DB.prepare(
    `
    UPDATE tracks
    SET
      play_count = play_count + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `
  )
    .bind(trackId)
    .run();

  await env.DB.prepare(
    `
    UPDATE general_cache
    SET last_accessed_at =
      CURRENT_TIMESTAMP
    WHERE track_id = ?
    `
  )
    .bind(trackId)
    .run();

  return new Response(
    response.body,
    {
      status: 200,

      headers: {
        "content-type":
          row.mime_type ||
          (
            row.format === "mp3"
              ? "audio/mpeg"
              : "audio/flac"
          ),

        "cache-control":
          "private, max-age=60",

        "content-disposition":
          `inline; filename="${encodeURIComponent(
            row.title || "track"
          )}.${row.format || "flac"}"`,
      },
    }
  );
}

/* =========================================================
   FRONTEND
   ========================================================= */

async function frontend(
  env,
  req
) {
  if (!env.ASSETS) {
    return new Response(
      "Frontend assets are not configured.",
      {
        status: 500,
        headers: {
          "content-type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }

  return env.ASSETS.fetch(req);
}

/* =========================================================
   MAIN ROUTER
   ========================================================= */

export default {
  async fetch(req, env) {
    try {
      const url =
        new URL(req.url);

      const path =
        url.pathname;

      /*
       * Health endpoint.
       * Doesn't require authentication.
       */
      if (
        path ===
        "/api/v1/health"
      ) {
        return json({
          status: "ok",
          environment:
            env.ENVIRONMENT ||
            "production",
        });
      }

      /*
       * Login endpoint.
       * Doesn't require an existing session.
       */
      if (
        path ===
          "/api/v1/auth/login" &&
        req.method === "POST"
      ) {
        return login(
          env,
          req
        );
      }

      /*
       * Acquisition callback.
       * Authenticated using CALLBACK_SECRET.
       */
      if (
        path ===
          "/api/v1/jobs/callback" &&
        req.method === "POST"
      ) {
        return callback(
          env,
          req
        );
      }

      /*
       * Everything that isn't an API
       * request is served from frontend/.
       *
       * This is what allows:
       *
       * /
       * /index.html
       * /assets/...
       *
       * to work.
       */
      if (
        !path.startsWith(
          "/api/"
        )
      ) {
        return frontend(
          env,
          req
        );
      }

      /*
       * Everything below this point
       * requires authentication.
       */
      if (
        !(await requireAuth(
          env,
          req
        ))
      ) {
        return json(
          {
            error:
              "Authentication required",
          },
          401
        );
      }

      /* =====================================================
         AUTH
         ===================================================== */

      if (
        path ===
        "/api/v1/auth/me"
      ) {
        return json({
          authenticated: true,
        });
      }

      if (
        path ===
          "/api/v1/auth/logout" &&
        req.method === "POST"
      ) {
        const token =
          cookie(req);

        if (token) {
          await env.DB.prepare(
            `
            DELETE FROM sessions
            WHERE id_hash = ?
            `
          )
            .bind(
              await sha256(token)
            )
            .run();
        }

        return json(
          {
            ok: true,
          },
          200,
          {
            "Set-Cookie":
              "music_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
          }
        );
      }

      /* =====================================================
         SEARCH / PLAYLIST
         ===================================================== */

      if (
        path === "/api/v1/search" &&
        req.method === "GET"
      ) {
        return search(env, req);
      }

      if (
        path === "/api/v1/playlist"
      ) {
        return playlist(
          env,
          req.method,
          req
        );
      }

      /* =====================================================
         JOBS
         ===================================================== */

      const jobMatch = path.match(
        /^\/api\/v1\/jobs\/([^/]+)$/
      );

      if (
        jobMatch &&
        req.method === "GET"
      ) {
        return jobStatus(
          env,
          jobMatch[1]
        );
      }

      /* =====================================================
         PLAYBACK
         ===================================================== */

      const playMatch = path.match(
        /^\/api\/v1\/playback\/(\d+)$/
      );

      if (
        playMatch &&
        req.method === "GET"
      ) {
        return playback(
          env,
          Number(playMatch[1])
        );
      }

      return json(
        {
          error: "Not found",
        },
        404
      );
    } catch (e) {
      console.error(e);

      return json(
        {
          error: String(
            e?.message || e
          ),
        },
        500
      );
    }
  },
};

