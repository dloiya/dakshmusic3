import worker from "./worker.js";

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extra,
    },
  });

function cookie(req) {
  const value = req.headers.get("Cookie") || "";
  const match = value.match(/(?:^|;\s*)music_session=([^;]+)/);
  return match?.[1] || null;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function requireAuth(env, req) {
  const token = cookie(req);
  if (!token || !env.DB) return false;

  const idHash = await sha256(token);
  const row = await env.DB.prepare(
    `
    SELECT id_hash
    FROM sessions
    WHERE id_hash = ?
      AND expires_at > ?
    `
  ).bind(idHash, Math.floor(Date.now() / 1000)).first();

  return !!row;
}

async function uploadAudio(env, req, jobId) {
  const supplied = req.headers.get("X-Callback-Secret");

  if (!supplied || supplied !== env.CALLBACK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!env.DB) return json({ error: "Database is not configured" }, 500);
  if (!env.AUDIO_BUCKET) return json({ error: "R2 storage is not configured" }, 500);

  const job = await env.DB.prepare(
    `SELECT * FROM download_jobs WHERE id = ?`
  ).bind(jobId).first();

  if (!job) return json({ error: "Job not found" }, 404);

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") || null;
  const format = url.searchParams.get("format") || "flac";
  const contentType =
    req.headers.get("content-type") ||
    (format === "mp3" ? "audio/mpeg" : "audio/flac");
  const storageKey = `tracks/${job.track_id}.${format}`;

  await env.AUDIO_BUCKET.put(storageKey, req.body, {
    httpMetadata: { contentType },
  });

  await env.DB.prepare(
    `
    UPDATE download_jobs
    SET
      status = 'complete',
      provider = ?,
      drive_file_id = ?,
      format = ?,
      mime_type = ?,
      error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `
  ).bind(provider, storageKey, format, contentType, jobId).run();

  if (job.kind === "general") {
    await env.DB.prepare(
      `
      INSERT OR REPLACE INTO general_cache
        (track_id, drive_file_id, last_accessed_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      `
    ).bind(job.track_id, storageKey).run();

    const keep = Math.max(
      1,
      Number.parseInt(env.GENERAL_CACHE_LIMIT || "25", 10) || 25
    );

    const old = await env.DB.prepare(
      `
      SELECT id, drive_file_id
      FROM general_cache
      ORDER BY last_accessed_at DESC
      LIMIT -1 OFFSET ?
      `
    ).bind(keep).all();

    for (const row of old.results || []) {
      await env.DB.prepare(
        `DELETE FROM general_cache WHERE id = ?`
      ).bind(row.id).run();

      if (row.drive_file_id) {
        try {
          await env.AUDIO_BUCKET.delete(row.drive_file_id);
        } catch (e) {
          console.error("Failed to delete evicted R2 object:", row.drive_file_id, e);
        }
      }
    }
  }

  return json({ ok: true, storage_key: storageKey });
}

async function removePlaylistEntry(env, entryId) {
  const entry = await env.DB.prepare(
    `SELECT position FROM playlist_entries WHERE id = ?`
  ).bind(entryId).first();

  if (!entry) return json({ error: "Playlist entry not found" }, 404);

  await env.DB.prepare(
    `DELETE FROM playlist_entries WHERE id = ?`
  ).bind(entryId).run();

  await env.DB.prepare(
    `UPDATE playlist_entries SET position = position - 1 WHERE position > ?`
  ).bind(entry.position).run();

  return json({ ok: true });
}

async function clearPlaylist(env) {
  await env.DB.prepare(`DELETE FROM playlist_entries`).run();
  return json({ ok: true });
}

async function movePlaylistEntry(env, entryId, requestedPosition) {
  const entry = await env.DB.prepare(
    `SELECT position FROM playlist_entries WHERE id = ?`
  ).bind(entryId).first();

  if (!entry) return json({ error: "Playlist entry not found" }, 404);

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM playlist_entries`
  ).first();

  const count = Number(countRow?.count || 0);
  const target = Math.min(
    count,
    Math.max(1, Number.parseInt(requestedPosition, 10) || 1)
  );
  const current = Number(entry.position);

  if (target === current) return json({ ok: true, position: current });

  if (target < current) {
    await env.DB.prepare(
      `
      UPDATE playlist_entries
      SET position = position + 1
      WHERE position >= ? AND position < ?
      `
    ).bind(target, current).run();
  } else {
    await env.DB.prepare(
      `
      UPDATE playlist_entries
      SET position = position - 1
      WHERE position > ? AND position <= ?
      `
    ).bind(current, target).run();
  }

  await env.DB.prepare(
    `UPDATE playlist_entries SET position = ? WHERE id = ?`
  ).bind(target, entryId).run();

  return json({ ok: true, position: target });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    const audioUploadMatch = url.pathname.match(
      /^\/api\/v1\/jobs\/([^/]+)\/audio$/
    );

    if (
      audioUploadMatch &&
      (req.method === "PUT" || req.method === "POST")
    ) {
      // Machine-to-machine acquisition endpoint. It intentionally bypasses
      // the normal music-session authentication and uses CALLBACK_SECRET.
      return uploadAudio(env, req, audioUploadMatch[1]);
    }

    // Playlist-management endpoints. The existing worker owns the normal
    // playlist GET/POST routes; these endpoints add mutation operations.
    if (url.pathname === "/api/v1/playlist" && req.method === "DELETE") {
      if (!(await requireAuth(env, req))) {
        return json({ error: "Authentication required" }, 401);
      }
      return clearPlaylist(env);
    }

    const entryMatch = url.pathname.match(
      /^\/api\/v1\/playlist\/([0-9]+)$/
    );

    if (entryMatch && (req.method === "DELETE" || req.method === "PATCH")) {
      if (!(await requireAuth(env, req))) {
        return json({ error: "Authentication required" }, 401);
      }

      const entryId = Number(entryMatch[1]);

      if (req.method === "DELETE") {
        return removePlaylistEntry(env, entryId);
      }

      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      return movePlaylistEntry(env, entryId, body.position);
    }

    return worker.fetch(req, env, ctx);
  },
};
