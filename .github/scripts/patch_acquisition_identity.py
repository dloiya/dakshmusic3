from pathlib import Path

p = Path('serverless/entry.js')
s = p.read_text()
old = '''  if (!track.duration_ms) throw new Error(`Track ${track.natural_key || trackId} has no canonical duration_ms; refusing acquisition without identity data`);\n'''
new = '''  // Imported Apple Music tracks can be missing duration_ms. Resolve the\n  // canonical duration from the Apple/iTunes catalog before dispatching so\n  // acquisition still has recording identity data.\n  if (!track.duration_ms && String(track.source || '').toLowerCase() === 'apple' && track.source_id) {\n    try {\n      const lookup = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(track.source_id)}`);\n      if (lookup.ok) {\n        const data = await lookup.json();\n        const millis = Number(data?.results?.[0]?.trackTimeMillis || 0);\n        if (millis > 0) {\n          await env.DB.prepare(`UPDATE tracks SET duration_ms=? WHERE id=?`).bind(Math.round(millis), trackId).run();\n          track.duration_ms = Math.round(millis);\n        }\n      }\n    } catch (e) {\n      console.warn('Unable to backfill Apple duration', trackId, e);\n    }\n  }\n  if (!track.duration_ms) throw new Error(`Track ${track.natural_key || trackId} has no canonical duration_ms; refusing acquisition without identity data`);\n'''
if old not in s:
    raise SystemExit('duration guard not found')
p.write_text(s.replace(old, new, 1))
