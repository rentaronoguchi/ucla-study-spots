import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, LayersControl } from "react-leaflet";
import Papa from "papaparse";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";
import { supabase } from "./supabase";

// Fixes Leaflet's default marker icon under Vite
L.Marker.prototype.options.icon = L.icon({
  iconUrl: icon,
  shadowUrl: iconShadow,
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

const BASE = import.meta.env.BASE_URL;

const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSEPR4c3uD3TOEbIaszYujn5o07lqWNSZHD_0coqeYD87PhEVZEGwfXLGR5Lmcdy0BjyoqGQNfYYbol/pub?gid=0&single=true&output=csv";

// "Levels" tab: one row per level of a multi-level spot
const LEVELS_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSEPR4c3uD3TOEbIaszYujn5o07lqWNSZHD_0coqeYD87PhEVZEGwfXLGR5Lmcdy0BjyoqGQNfYYbol/pub?gid=663956636&single=true&output=csv";

// Full URLs pass through; filenames resolve against the site folder
const src = (p) =>
  p.startsWith("http") ? p
  : p.includes("/") ? BASE + p
  : BASE + "images/" + p;

// Treat blanks, "?" and "NA" as empty
const clean = (v) => {
  v = (v || "").trim();
  return v === "?" || v.toUpperCase() === "NA" ? "" : v;
};

const miles = (m) => `${(m / 1609.34).toFixed(2)} mi`;

const num = (v) => {
  const n = parseFloat(clean(v));
  return isNaN(n) ? -1 : n;
};

// Reads a column by name, ignoring case, spacing, and a hidden BOM
const field = (r, name) => {
  const key = Object.keys(r).find(
    (k) => k.replace(/^\uFEFF/, "").trim().toLowerCase() === name.toLowerCase()
  );
  return key ? r[key] || "" : "";
};

// Finds the Can Talk column regardless of "?", spacing, case, or a hidden BOM
const talkOf = (r) => {
  const key = Object.keys(r).find((k) =>
    k.replace(/^\uFEFF/, "").trim().toLowerCase().startsWith("can talk")
  );
  return key ? r[key] || "" : "";
};

// Only an explicit "No" means you can't talk
const canTalk = (v) => clean(v).toLowerCase() !== "no";
const isOut = (r) => r["Category"] === "Outside";
const catColor = (r) => (isOut(r) ? "#2563eb" : "#f97316");
const mkPin = (cls) =>
  L.icon({
    iconUrl: icon,
    shadowUrl: iconShadow,
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    className: cls,
  });
const pinOut = mkPin("pin-out");
const pinIn = mkPin("pin-in");
const byDist = (a, b) => (a.dist ?? 0) - (b.dist ?? 0);

// Opens Google Maps walking directions from the user's location to the spot
const directionsUrl = (lat, lng) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;

// "images/young-research-library-quiet.jpg" -> "young-research-library-quiet.jpg"
const fileName = (p) => p.split("/").pop();

// Red (low) -> green (high)
const ratingColor = (r) => `hsl(${(r / 5) * 120}, 70%, 42%)`;

const sorters = {
  distance: byDist,
  rating: (a, b) =>
    num(b.row["Rentaro Rating (5)"]) - num(a.row["Rentaro Rating (5)"]) || byDist(a, b),
  inside: byDist,
  outside: byDist,
  talk: byDist,
};

const ZOOM = 17;

// File name on top, one big photo with arrows/counter, clickable thumbnails
function PhotoCarousel({ photos, captions }) {
  const [i, setI] = useState(0);
  if (!photos.length) return null;

  const goTo = (n) => (e) => {
    e.stopPropagation();
    setI((n + photos.length) % photos.length);
  };

  return (
    <div className="carousel">
      <div className="car-name">{captions ? captions[i] : fileName(photos[i])}</div>
      <div className="car-main">
        <img
          src={src(photos[i])}
          alt={fileName(photos[i])}
          onClick={photos.length > 1 ? goTo(i + 1) : undefined}
          style={{ cursor: photos.length > 1 ? "pointer" : "default" }}
        />
        {photos.length > 1 && (
          <>
            <button className="car-btn prev" onClick={goTo(i - 1)}>‹</button>
            <button className="car-btn next" onClick={goTo(i + 1)}>›</button>
            <span className="car-count">{i + 1} / {photos.length}</span>
          </>
        )}
      </div>

      {photos.length > 1 && (
        <div className="car-thumbs">
          {photos.map((p, n) => (
            <img
              key={p}
              src={src(p)}
              alt={fileName(p)}
              title={fileName(p)}
              className={n === i ? "active" : ""}
              onClick={goTo(n)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Badge text/colors for a level's Can Talk value
const talkBadge = (v) => {
  const t = (v || "").toLowerCase();
  if (!t) return null;
  if (t === "no") return { text: "Quiet", bg: "#dbeafe", fg: "#1e40af" };
  if (t === "yes") return { text: "Can talk", bg: "#dcfce7", fg: "#166534" };
  return { text: v, bg: "#f3f4f6", fg: "#374151" };
};

// Stack of levels (highest on top). Tap a bar to see that level's info and photos.
// `levels` is sorted lowest -> highest.
// Stack of levels (highest on top). Default shows photos from every level;
// tap a level to see just that level, tap it again (or "All photos") to go back.
// `levels` is sorted lowest -> highest.
// Stack of levels (highest on top). Levels that share an Order (same floor,
// different areas) sit side by side in one row. Default shows photos from every
// level; tap a level to see just that one, tap it again (or "All photos") to go back.
// `levels` is sorted lowest -> highest.
function LevelStack({ levels, spotPhotos }) {
  const [sel, setSel] = useState(null); // null = all levels
  const cur = sel == null ? null : levels[sel];

  // Group levels that share an Order. They're already sorted by Order, so
  // equal orders are adjacent, and areas keep their sheet order.
  const groups = [];
  levels.forEach((l, n) => {
    const order = l.order || 0;
    const last = groups[groups.length - 1];
    if (last && last.order === order) last.items.push({ l, n });
    else groups.push({ order, items: [{ l, n }] });
  });
  const topDown = [...groups].reverse(); // highest floor first
  const hasSideBySide = groups.some((g) => g.items.length > 1);

  // Photos for the carousel, each with a caption naming its level
  let photos, captions;
  if (cur) {
    photos = cur.photos;
    captions = cur.photos.map(() => cur.name);
  } else {
    const all = topDown
      .flatMap((g) => g.items)
      .flatMap(({ l }) => l.photos.map((p) => ({ p, name: l.name })));
    if (all.length) {
      photos = all.map((x) => x.p);
      captions = all.map((x) => x.name);
    } else {
      // No level has its own photos: fall back to the spot's main photos
      photos = spotPhotos;
      captions = undefined;
    }
  }

  const levelBtn = ({ l, n }, side) => {
    const badge = talkBadge(l.talk);
    const active = n === sel;
    return (
      <button
        key={n}
        onClick={(e) => {
          e.stopPropagation();
          setSel(active ? null : n);
        }}
        style={{
          display: "flex",
          flexDirection: side ? "column" : "row",
          justifyContent: side ? "center" : "space-between",
          alignItems: side ? "flex-start" : "center",
          gap: side ? 4 : 8,
          flex: 1,
          minWidth: 0,
          padding: "6px 10px",
          borderRadius: 6,
          border: active ? "2px solid #2563eb" : "1px solid #d1d5db",
          background: active ? "#eff6ff" : "#fff",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          fontWeight: active ? 600 : 400,
        }}
      >
        <span>{l.name}</span>
        {badge && (
          <span
            style={{
              padding: "1px 8px",
              borderRadius: 999,
              background: badge.bg,
              color: badge.fg,
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {badge.text}
          </span>
        )}
      </button>
    );
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          margin: "6px 0 4px",
        }}
      >
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          Levels · top is highest
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSel(null);
          }}
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            border: sel == null ? "2px solid #2563eb" : "1px solid #d1d5db",
            background: sel == null ? "#eff6ff" : "#fff",
            fontSize: 12,
            fontWeight: sel == null ? 600 : 400,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          All photos
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {topDown.map((g) => (
          <div key={g.order} style={{ display: "flex", gap: 4 }}>
            {g.items.map((it) => levelBtn(it, g.items.length > 1))}
          </div>
        ))}
      </div>

      {cur?.desc && <p style={{ margin: "8px 0 0" }}>{cur.desc}</p>}

      {cur && !cur.photos.length && (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#9ca3af" }}>
          No photos for this level yet.
        </p>
      )}
      <PhotoCarousel key={sel ?? "all"} photos={photos} captions={captions} />
    </div>
  );
}

function AuthBar({ session }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [username, setUsername] = useState("");

  useEffect(() => {
    if (!session) return setUsername("");
    supabase.from("profiles").select("username").eq("id", session.user.id).single()
      .then(({ data }) => setUsername(data?.username || ""));
  }, [session]);

  const send = async () => {
    setErr("");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + BASE },
    });
    if (error) setErr(error.message);
    else setSent(true);
  };
  const google = () =>
  supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + BASE },
  });

  const rename = async () => {
    const name = prompt("Username", username)?.trim();
    if (!name) return;
    const { error } = await supabase.from("profiles").update({ username: name }).eq("id", session.user.id);
    if (error) alert(error.message);
    else setUsername(name);
  };

  if (session)
    return (
      <div className="auth">
        Signed in as <b>{username || "…"}</b>
        <button className="link" onClick={rename}>edit</button>
        <button className="link" onClick={() => supabase.auth.signOut()}>sign out</button>
      </div>
    );

  return (
    <div className="auth">
      {sent ? (
        <>Check your email for the sign-in link.</>
      ) : (
        <>
          <button onClick={google}>Continue with Google</button>
          {/* <input
            type="email"
            placeholder="Email to sign in"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && email && send()}
          />
          <button onClick={send} disabled={!email}>Send magic link</button> */}
        </>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function Friends({ session }) {
  const me = session.user.id;
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");

  const load = async () => {
    const { data: fs } = await supabase.from("friendships").select("requester, addressee, status");
    const list = fs || [];
    const ids = [...new Set(list.flatMap((f) => [f.requester, f.addressee]))].filter((id) => id !== me);
    let names = {};
    if (ids.length) {
      const { data: ps } = await supabase.from("profiles").select("id, username").in("id", ids);
      names = Object.fromEntries((ps || []).map((p) => [p.id, p.username]));
    }
    setRows(
      list.map((f) => {
        const other = f.requester === me ? f.addressee : f.requester;
        return { ...f, other, name: names[other] || "…", incoming: f.addressee === me };
      })
    );
  };

  useEffect(() => { load(); }, [me]);
  useEffect(() => {
    const ch = supabase.channel("friends-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, load)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [me]);

  const add = async () => {
    setMsg("");
    const name = q.trim();
    if (!name) return;
    const { data: p } = await supabase.from("profiles").select("id").eq("username", name).maybeSingle();
    if (!p) return setMsg("No user with that username");
    if (p.id === me) return setMsg("That's you");
    if (rows.some((r) => r.other === p.id)) return setMsg("Already requested or friends");
    const { error } = await supabase.from("friendships").insert({ requester: me, addressee: p.id });
    if (error) return setMsg(error.message);
    setQ("");
    setMsg("Request sent");
    load();
  };

  const accept = async (r) => {
    await supabase.from("friendships").update({ status: "accepted" })
      .eq("requester", r.requester).eq("addressee", r.addressee);
    load();
  };

  const remove = async (r) => {
    await supabase.from("friendships").delete()
      .eq("requester", r.requester).eq("addressee", r.addressee);
    load();
  };

  const incoming = rows.filter((r) => r.status === "pending" && r.incoming);
  const outgoing = rows.filter((r) => r.status === "pending" && !r.incoming);
  const friends = rows.filter((r) => r.status === "accepted");

  return (
    <details className="friends">
      <summary>
        Friends ({friends.length}){incoming.length > 0 && <span className="badge">{incoming.length}</span>}
      </summary>

      <div className="f-add">
        <input
          placeholder="Add by username"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button onClick={add}>Add</button>
      </div>
      {msg && <div className="f-msg">{msg}</div>}

      {incoming.map((r) => (
        <div className="f-row" key={r.other}>
          <span>{r.name} <small>wants to be friends</small></span>
          <span>
            <button onClick={() => accept(r)}>Accept</button>
            <button className="link" onClick={() => remove(r)}>Decline</button>
          </span>
        </div>
      ))}
      {outgoing.map((r) => (
        <div className="f-row" key={r.other}>
          <span>{r.name} <small>pending</small></span>
          <button className="link" onClick={() => remove(r)}>Cancel</button>
        </div>
      ))}
      {friends.map((r) => (
        <div className="f-row" key={r.other}>
          <span>{r.name}</span>
          <button className="link" onClick={() => remove(r)}>Remove</button>
        </div>
      ))}
    </details>
  );
}

export default function App() {
  const [spots, setSpots] = useState([]);
  const [levels, setLevels] = useState({});
  const [me, setMe] = useState(null);
  const [map, setMap] = useState(null);
  const [sortBy, setSortBy] = useState("distance");
  const [hovered, setHovered] = useState(null);
  const markerRefs = useRef({});
  const pendingOpen = useRef(null);
  const [session, setSession] = useState(null);
  const [active, setActive] = useState(null);
  const [live, setLive] = useState([]);

  useEffect(() => {
    Papa.parse(SHEET_URL, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: ({ data }) => setSpots(data),
    });

    // Levels tab: group rows by spot name, sorted lowest -> highest by Order
    Papa.parse(LEVELS_URL, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: ({ data }) => {
        const grouped = {};
        data.forEach((r) => {
          const spot = field(r, "Spot").trim();
          if (!spot) return;
          grouped[spot] = grouped[spot] || [];
          grouped[spot].push({
            order: parseFloat(field(r, "Order")),
            name: field(r, "Level").trim(),
            talk: clean(field(r, "Can Talk")),
            photos: clean(field(r, "Photos"))
              .split(";")
              .map((p) => p.trim())
              .filter(Boolean),
            desc: clean(field(r, "Description")),
          });
        });
        Object.values(grouped).forEach((arr) =>
          arr.sort((a, b) => (a.order || 0) - (b.order || 0))
        );
        setLevels(grouped);
      },
    });

    const id = navigator.geolocation.watchPosition(
      (p) => setMe([p.coords.latitude, p.coords.longitude]),
      (e) => console.warn("Location denied:", e.message),
      { enableHighAccuracy: true }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  useEffect(() => {
    if (!map) return;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  
  useEffect(() => {
    if (!session) return setActive(null);
    supabase.from("checkins").select("spot_name")
      .eq("user_id", session.user.id)
      .is("ended_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("started_at", { ascending: false }).limit(1)
      .then(({ data }) => setActive(data?.[0]?.spot_name || null));
  }, [session]);

  useEffect(() => {
    if (!session) return setLive([]);
    const load = async () => {
      const { data } = await supabase.from("checkins")
        .select("user_id, spot_name, profiles(username)")
        .is("ended_at", null)
        .gt("expires_at", new Date().toISOString())
        .neq("user_id", session.user.id);
      setLive(data || []);
    };
    load();
    const ch = supabase.channel("live-checkins")
      .on("postgres_changes", { event: "*", schema: "public", table: "checkins" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, load)
      .subscribe();
    const t = setInterval(load, 60000); // drops expired check-ins
    return () => { supabase.removeChannel(ch); clearInterval(t); };
  }, [session]);

  const checkIn = async (name) => {
    const { error } = await supabase.rpc("check_in", { spot: name });
    if (error) alert(error.message);
    else setActive(name);
  };

  const checkOut = async () => {
    const { error } = await supabase.rpc("check_out");
    if (error) alert(error.message);
    else setActive(null);
  };

  // Fly to a spot, then open its popup (same as clicking the waypoint)
  const selectSpot = (name, lat, lng) => {
    if (!map) return;

    // Cancel the previous click's queued popup and animation
    if (pendingOpen.current) {
      map.off("moveend", pendingOpen.current);
      pendingOpen.current = null;
    }
    map.stop();
    map.closePopup();

    const open = () => {
      map.off("moveend", open);
      pendingOpen.current = null;
      const marker = markerRefs.current[name];
      if (marker && map.hasLayer(marker)) marker.openPopup();
    };

    const center = map.getCenter();
    const alreadyThere =
      map.getZoom() === ZOOM &&
      Math.abs(center.lat - lat) < 1e-6 &&
      Math.abs(center.lng - lng) < 1e-6;

    if (alreadyThere) {
      open();
    } else {
      pendingOpen.current = open;
      map.on("moveend", open);
      map.flyTo([lat, lng], ZOOM);
    }
  };

  const items = spots
    .map((row) => {
      const lat = parseFloat(row["Latitude"]);
      const lng = parseFloat(row["Longitude"] || row["Lontitude"]);
      if (isNaN(lat) || isNaN(lng)) return null;
      const dist = me ? L.latLng(me).distanceTo([lat, lng]) : null;
      return { row, lat, lng, dist };
    })
    .filter(Boolean)
    .filter(({ row }) =>
      sortBy === "outside" ? isOut(row)
      : sortBy === "inside" ? !isOut(row)
      : sortBy === "talk" ? canTalk(talkOf(row))
      : true
    );
  items.sort(sorters[sortBy]);

  const here = {};
  live.forEach((c) => (here[c.spot_name] ||= []).push(c.profiles?.username || "?"));

  return (
    <>
      <div className="list">
        <h2>
          Study spots
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value);
              setHovered(null);
            }}
          >
            <option value="distance">Distance</option>
            <option value="rating">Rating</option>
            <option value="inside">Inside only</option>
            <option value="outside">Outside only</option>
            <option value="talk">Can talk only</option>
          </select>
        </h2>
        <AuthBar session={session} />
        {session && active && (
          <div className="mine">
            <span className="dot" />
            <span
              className="mine-text"
              onClick={() => {
                const s = spots.find((r) => r["Name"] === active);
                if (s) selectSpot(s["Name"], parseFloat(s["Latitude"]), parseFloat(s["Longitude"] || s["Lontitude"]));
              }}
            >
              Studying at <b>{active}</b>
            </span>
            <button onClick={checkOut}>Leave</button>
          </div>
        )}
        {session && <Friends session={session} />}
        {session && live.length > 0 && (
          <div className="live">
            <div className="live-title">Studying now</div>
            {live.map((c) => (
              <div
                className="live-row"
                key={c.user_id}
                onClick={() => {
                  const s = spots.find((r) => r["Name"] === c.spot_name);
                  if (s) selectSpot(s["Name"], parseFloat(s["Latitude"]), parseFloat(s["Longitude"] || s["Lontitude"]));
                }}
              >
                <span className="dot" />
                <b>{c.profiles?.username}</b> at {c.spot_name}
              </div>
            ))}
          </div>
        )}
        {items.map(({ row, lat, lng, dist }) => {
          const r = parseFloat(clean(row["Rentaro Rating (5)"]));
          const hasR = !isNaN(r);
          const cell = talkOf(row).trim();
          const showTalk = sortBy === "talk" && hovered === row["Name"];
          const lv = levels[row["Name"].trim()];
          return (
            <div
              key={row["Name"]}
              className="list-item"
              style={{ borderRight: `4px solid ${catColor(row)}` }}
              onMouseEnter={() => setHovered(row["Name"])}
              onMouseLeave={() => setHovered(null)}
              onClick={() => selectSpot(row["Name"], lat, lng)}
            >
              <div className="rating">
                <span className="rating-num" style={{ color: hasR ? ratingColor(r) : "#9ca3af" }}>
                  {hasR ? r : "–"}
                </span>
                <div className="bar">
                  {hasR && <i style={{ width: `${(r / 5) * 100}%`, background: ratingColor(r) }} />}
                </div>
              </div>
              <div className="li-body">
                <div className="li-top">
                  <b>{row["Name"]}</b>
                  {dist != null && <span className="pill">{miles(dist)}</span>}
                </div>
                <small>
                  {row["Area"]} · {row["Category"]}
                  {lv ? ` · ${lv.length} levels` : ""}
                  {here[row["Name"]] ? ` · ${here[row["Name"]].length} friend${here[row["Name"]].length > 1 ? "s" : ""} here` : ""}
                </small>
                {showTalk && (
                  <div
                    style={{
                      marginTop: 4,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "#eef2ff",
                      color: "#3730a3",
                      fontSize: 12,
                      width: "fit-content",
                    }}
                  >
                    Can talk: {cell || "(blank)"}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <MapContainer
        ref={setMap}
        center={[34.0708, -118.445]}
        zoom={15}
        style={{ position: "fixed", inset: 0 }}
      >
        <LayersControl position="topleft">

          <LayersControl.BaseLayer checked name="Original">
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution="&copy; OpenStreetMap contributors"
            />
          </LayersControl.BaseLayer>

          <LayersControl.BaseLayer name="Voyager">
            <TileLayer
              url="https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_51jj_1_e353c9e2c37ed983759151c7"
              attribution="&copy; OpenStreetMap contributors &copy; CARTO"
            />
          </LayersControl.BaseLayer>

          <LayersControl.BaseLayer name="Satellite">
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              attribution="Tiles &copy; Esri"
            />
          </LayersControl.BaseLayer>
        </LayersControl>
        {me && (
          <CircleMarker
            center={me}
            radius={9}
            pathOptions={{ color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1 }}
          />
        )}
        {items.map(({ row, lat, lng, dist }) => {
          const photos = clean(row["Photos"])
            .split(";")
            .map((p) => p.trim())
            .filter(Boolean);
          const rating = clean(row["Rentaro Rating (5)"]);
          const desc = clean(row["Description"]);
          const talk = clean(talkOf(row));
          const lv = levels[row["Name"].trim()];

          return (
            <Marker
              key={row["Name"]}
              position={[lat, lng]}
              icon={isOut(row) ? pinOut : pinIn}
              ref={(m) => {
                if (m) markerRefs.current[row["Name"]] = m;
                else delete markerRefs.current[row["Name"]];
              }}
            >
              <Popup>
                <div className="popup">
                  <h3>{row["Name"]}</h3>
                  <p>{row["Area"]} · {row["Category"]}</p>
                  {dist != null && <p>Distance: {miles(dist)}</p>}
                  {rating && <p>Rating: {rating}/5</p>}
                  {talk && !lv && <p>Can talk: {talk}</p>}
                  {desc && <p>{desc}</p>}
                  {here[row["Name"]] && <p>Studying here: <b>{here[row["Name"]].join(", ")}</b></p>}
                  {session && (
                    active === row["Name"]
                      ? <button className="chk out" onClick={checkOut}>Leave</button>
                      : <button className="chk" onClick={() => checkIn(row["Name"])}>I'm studying here</button>
                  )}
                  <a
                    href={directionsUrl(lat, lng)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-block",
                      margin: "6px 0",
                      padding: "6px 12px",
                      borderRadius: 6,
                      background: "#2563eb",
                      color: "#fff",
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    Get directions
                  </a>
                  {lv ? (
                    <LevelStack levels={lv} spotPhotos={photos} />
                  ) : (
                    <PhotoCarousel photos={photos} />
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </>
  );
}