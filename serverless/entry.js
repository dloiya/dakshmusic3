import worker from "./worker.js";

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extra,
    },
  });

async function uploadAudio(env, req, jobId) {
  const supplied = req.headers.get("X-Callback-Secret");

  if (!supplied || supplied !== env.CALLBACK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!env.DB) {
    return json({ error: "Database is not configured" }, 500);
  }

  if (!env.AUDIO_BUCKET) {
    return json({ error: "R2 storage is not configured" }, 500);
  }

  const job = await env.DB.prepare(
    `
    SELECT *
    FROM download_jobs
    WHERE id = ?
    `
  ).bind(jobId).first();

  if (!job) {
    return json({ error: "Job not found" }, 404);
  }

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") || null;
  const format = url.searchParams.get("format") || "flac";
  const contentType =
    req.headers.get("content-type") ||
    (format === "mp3" ? "audio/mpeg" : "audio/flac");

  const storageKey = `tracks/${job.track_id}.${format}`;

  await env.AUDIO_BUCKET.put(storageKey, req.body, {
    httpMetadata: {
      contentType,
    },
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
  ).bind(
    provider,
    storageKey,
    format,
    contentType,
    jobId
  ).run();

  if (job.kind === "general") {
    await env.DB.prepare(
      `
      INSERT OR REPLACE INTO general_cache
        (track_id, drive_file_id, last_accessed_at)
      VALUES
        (?, ?, CURRENT_TIMESTAMP)
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
          console.error(
            "Failed to delete evicted R2 object:",
            row.drive_file_id,
            e
          );
        }
      }
    }
  }

  return json({
    ok: true,
    storage_key: storageKey,
  });
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
      // Machine-to-machine acquisition endpoint. It is intentionally
      // handled before worker.js's normal music-session authentication.
      return uploadAudio(
        env,
        req,
        audioUploadMatch[1]
      );
    }

    return worker.fetch(req, env, ctx);
  },
};
