import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API =
  import.meta.env.VITE_QUEUE_API_URL?.replace(/\/$/, "") ||
  "http://127.0.0.1:8787";

const DEEZER = "https://api.deezer.com";

async function deezerSearch(query) {
  const url = `${DEEZER}/search?q=${encodeURIComponent(query)}&limit=25`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Deezer search failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Deezer search failed");
  return data.data || [];
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
  return data;
}

function TrackResult({ item, onAdd }) {
  return (
    <button className="track-line result" onClick={() => onAdd(item)}>
      <div className="thumb">
        {item.album?.cover_medium ? (
          <img src={item.album.cover_medium} alt="" />
        ) : (
          "♪"
        )}
      </div>
      <div className="track-copy">
        <strong>{item.title}</strong>
        <small>
          {item.artist?.name} · {item.album?.title}
        </small>
      </div>
      <span className="arrow">+</span>
    </button>
  );
}

function QueueView({ queue, loading, onRefresh, onRemove, onNext }) {
  if (loading) return <div className="empty">Loading queue…</div>;

  if (!queue?.tracks?.length) {
    return (
      <div className="empty">
        Queue empty.
        <button className="tiny-btn" onClick={onRefresh}>
          Initialize
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="toolbar">
        <button className="tiny-btn" onClick={onRefresh}>
          Refresh
        </button>
        <button className="tiny-btn" onClick={onNext}>
          Next
        </button>
      </div>
      {queue.tracks.map((t) => (
        <div className="track-line" key={t.queue_entry_id}>
          <div className="track-copy">
            <strong>{t.title}</strong>
            <small>
              {t.artist} · {t.album_name || "Unknown album"}
            </small>
          </div>
          <span className="status">{t.storage_status || "missing"}</span>
          <button
            className="tiny-btn"
            onClick={() => onRemove(t.queue_entry_id)}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}

function SearchView({ onAdd }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e?.preventDefault();
    if (!query.trim()) return;

    setBusy(true);
    setError("");
    try {
      setResults(await deezerSearch(query.trim()));
    } catch (err) {
      setError(err.message);
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="toolbar" onSubmit={submit}>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Song, artist, album…"
        />
        <button className="tiny-btn" type="submit">
          Search
        </button>
      </form>

      {error && <div className="banner">{error}</div>}
      {busy && <div className="empty">Searching Deezer…</div>}

      {!busy &&
        results.map((item) => (
          <TrackResult key={item.id} item={item} onAdd={onAdd} />
        ))}

      {!busy && query && !results.length && !error && (
        <div className="empty">No results.</div>
      )}
    </>
  );
}

function normalizeDeezer(item) {
  return {
    title: item.title,
    artist: item.artist?.name || "Unknown artist",
    album_id: item.album?.id ?? null,
    album_name: item.album?.title ?? null,
    source: "deezer",
    source_id: String(item.id),
    source_url: `https://www.deezer.com/track/${item.id}`,
    artwork_url: item.album?.cover_xl || item.album?.cover_medium || null,
    duration_ms: Number(item.duration || 0) * 1000,
    metadata_json: {
      deezer: item,
    },
  };
}

function App() {
  const [screen, setScreen] = useState("Music");
  const [queue, setQueue] = useState(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [message, setMessage] = useState("");

  const menu = useMemo(
    () => ["Music", "Playlists", "Search", "Queue", "Acquisition", "Settings"],
    []
  );

  async function refreshQueue(initialize = false) {
    setQueueLoading(true);
    setMessage("");
    try {
      if (initialize) {
        await api("/api/queue/initialize", {
          method: "POST",
          body: JSON.stringify({ queue_key: "default" }),
        });
      }
      setQueue(await api("/api/queue?queue_key=default"));
    } catch (err) {
      setMessage(err.message);
    } finally {
      setQueueLoading(false);
    }
  }

  useEffect(() => {
    refreshQueue();
  }, []);

  async function addSearchResult(item) {
    try {
      const track = normalizeDeezer(item);
      await api("/api/queue/add", {
        method: "POST",
        body: JSON.stringify({ queue_key: "default", track }),
      });
      setMessage(`Added: ${track.title}`);
      await refreshQueue();
      setScreen("Queue");
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function removeQueueEntry(id) {
    try {
      await api(`/api/queue/${id}`, { method: "DELETE" });
      await refreshQueue();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function nextTrack() {
    try {
      await api("/api/queue/next", {
        method: "POST",
        body: JSON.stringify({ queue_key: "default" }),
      });
      await refreshQueue();
    } catch (err) {
      setMessage(err.message);
    }
  }

  function content() {
    switch (screen) {
      case "Search":
        return <SearchView onAdd={addSearchResult} />;
      case "Queue":
        return (
          <QueueView
            queue={queue}
            loading={queueLoading}
            onRefresh={() => refreshQueue()}
            onRemove={removeQueueEntry}
            onNext={nextTrack}
          />
        );
      case "Acquisition":
        return <AcquisitionView />;
      case "Playlists":
        return (
          <div className="empty">
            Playlists will use the existing playlist_entries table.
          </div>
        );
      case "Settings":
        return (
          <div className="empty">
            Queue API: <code>{API}</code>
          </div>
        );
      default:
        return <NowPlaying queue={queue} />;
    }
  }

  return (
    <main className="ipod-page">
      <section className="ipod">
        <div className="screen">
          <div className="screen-top">
            <span>iPod</span>
            <span className="battery">
              <i />
            </span>
          </div>

          <div className="screen-body">
            {message && <div className="banner">{message}</div>}

            <div className="menu-list">
              {menu.map((name) => (
                <button
                  key={name}
                  className={`menu-row ${screen === name ? "selected" : ""}`}
                  onClick={() => {
                    setMessage("");
                    setScreen(name);
                    if (name === "Queue") refreshQueue();
                  }}
                >
                  <span>{name}</span>
                  <span className="arrow">›</span>
                </button>
              ))}
            </div>

            {content()}
          </div>
        </div>

        <Wheel
          onMenu={() => setScreen("Music")}
          onPrev={() => setScreen("Queue")}
          onNext={() => nextTrack()}
          onSelect={() => {
            if (screen === "Music") setScreen("Queue");
          }}
        />

        <div className="footer">daksh music · D1 queue</div>
      </section>
    </main>
  );
}

function NowPlaying({ queue }) {
  const current = queue?.tracks?.[queue?.state?.current_index || 0];

  return (
    <div className="now-playing">
      <div className="art">
        {current?.artwork_url ? (
          <img src={current.artwork_url} alt="" />
        ) : (
          "♪"
        )}
      </div>
      <div className="np-info">
        <strong>{current?.title || "Nothing playing"}</strong>
        <small>{current?.artist || "—"}</small>
        <small>{current?.album_name || "—"}</small>
        <div className="progress">
          <i />
        </div>
        <div className="time">
          <span>0:00</span>
          <span>
            {current?.duration_ms
              ? `${Math.floor(current.duration_ms / 60000)}:${String(
                  Math.floor((current.duration_ms % 60000) / 1000)
                ).padStart(2, "0")}`
              : "0:00"}
          </span>
        </div>
      </div>
    </div>
  );
}

function AcquisitionView() {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setError("");
      const data = await api("/api/acquisition?limit=20");
      setJobs(data.jobs || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <div className="toolbar">
        <button className="tiny-btn" onClick={refresh}>
          Refresh
        </button>
      </div>
      {error && <div className="banner">{error}</div>}
      {!jobs.length && <div className="empty">No acquisition jobs.</div>}
      {jobs.map((job) => (
        <div className="track-line" key={job.id}>
          <div className="track-copy">
            <strong>{job.title}</strong>
            <small>{job.artist}</small>
          </div>
          <span className={`status ${job.status}`}>{job.status}</span>
        </div>
      ))}
    </>
  );
}

function Wheel({ onMenu, onPrev, onNext, onSelect }) {
  return (
    <div className="wheel-area">
      <div className="wheel">
        <button className="menu" onClick={onMenu}>
          MENU
        </button>
        <button className="prev" onClick={onPrev}>
          ‹
        </button>
        <button className="next" onClick={onNext}>
          ›
        </button>
        <button className="play">▶❙❙</button>
        <button className="center" aria-label="Select" onClick={onSelect} />
      </div>
      <div className="click-hint">TOUCH / DRAG / SCROLL · SELECT</div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
