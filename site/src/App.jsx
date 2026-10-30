import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker } from "react-leaflet";
import Papa from "papaparse";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";

// Fixes Leaflet's default marker icon under Vite
L.Marker.prototype.options.icon = L.icon({
  iconUrl: icon,
  shadowUrl: iconShadow,
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

const BASE = import.meta.env.BASE_URL;

// Treat blanks, "?" and "NA" as empty
const clean = (v) => {
  v = (v || "").trim();
  return v === "?" || v.toUpperCase() === "NA" ? "" : v;
};

const miles = (m) => `${(m / 1609.34).toFixed(1)} mi`;

const num = (v) => {
  const n = parseFloat(clean(v));
  return isNaN(n) ? -1 : n;
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
const byDist = (a, b) => (a.dist ?? 0) - (b.dist ?? 0);

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

export default function App() {
  const [spots, setSpots] = useState([]);
  const [me, setMe] = useState(null);
  const [map, setMap] = useState(null);
  const [sortBy, setSortBy] = useState("distance");
  const [hovered, setHovered] = useState(null);
  const markerRefs = useRef({});
  const pendingOpen = useRef(null);

  useEffect(() => {
    Papa.parse(`${BASE}study-spot-data.csv`, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: ({ data }) => setSpots(data),
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
        {items.map(({ row, lat, lng, dist }) => {
          const r = parseFloat(clean(row["Rentaro Rating (5)"]));
          const hasR = !isNaN(r);
          const cell = talkOf(row).trim();
          const showTalk = sortBy === "talk" && hovered === row["Name"];
          return (
            <div
              key={row["Name"]}
              className="list-item"
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
                <small>{row["Area"]} · {row["Category"]}</small>
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
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        {me && (
          <CircleMarker
            center={me}
            radius={9}
            pathOptions={{ color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1 }}
          />
        )}
        {items.map(({ row, lat, lng, dist }) => {
          const photos = clean(row["Photos"]).split(";").filter(Boolean);
          const rating = clean(row["Rentaro Rating (5)"]);
          const desc = clean(row["Description"]);
          const talk = clean(talkOf(row));

          return (
            <Marker
              key={row["Name"]}
              position={[lat, lng]}
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
                  {talk && <p>Can talk: {talk}</p>}
                  {desc && <p>{desc}</p>}
                  {photos.map((p) => (
                    <img key={p} src={BASE + p.trim()} alt={row["Name"]} />
                  ))}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </>
  );
}