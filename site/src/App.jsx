import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, LayersControl } from "react-leaflet";
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

const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSEPR4c3uD3TOEbIaszYujn5o07lqWNSZHD_0coqeYD87PhEVZEGwfXLGR5Lmcdy0BjyoqGQNfYYbol/pub?gid=0&single=true&output=csv";

// Full URLs pass through; filenames resolve against the site folder
const src = (p) => (p.startsWith("http") ? p : BASE + p);

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
function PhotoCarousel({ photos }) {
  const [i, setI] = useState(0);
  if (!photos.length) return null;

  const goTo = (n) => (e) => {
    e.stopPropagation();
    setI((n + photos.length) % photos.length);
  };

  return (
    <div className="carousel">
      <div className="car-name">{fileName(photos[i])}</div>
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

export default function App() {
  const [spots, setSpots] = useState([]);
  const [me, setMe] = useState(null);
  const [map, setMap] = useState(null);
  const [sortBy, setSortBy] = useState("distance");
  const [hovered, setHovered] = useState(null);
  const markerRefs = useRef({});
  const pendingOpen = useRef(null);

  useEffect(() => {
    Papa.parse(SHEET_URL, {
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
                  {talk && <p>Can talk: {talk}</p>}
                  {desc && <p>{desc}</p>}
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
                  <PhotoCarousel photos={photos} />
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </>
  );
}