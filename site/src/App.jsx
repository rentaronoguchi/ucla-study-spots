import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
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

export default function App() {
  const [spots, setSpots] = useState([]);

  useEffect(() => {
    Papa.parse(`${BASE}study-spot-data.csv`, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: ({ data }) => setSpots(data),
    });
  }, []);

  return (
    <MapContainer center={[34.0708, -118.445]} zoom={15} style={{ height: "100%" }}>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
      />
      {spots.map((row) => {
        const lat = parseFloat(row["Latitude"]);
        const lng = parseFloat(row["Longitude"] || row["Lontitude"]);
        if (isNaN(lat) || isNaN(lng)) return null;

        const photos = clean(row["Photos"]).split(";").filter(Boolean);
        const rating = clean(row["Rentaro Rating (5)"]);
        const desc = clean(row["Description"]);
        const talk = clean(row["Can Talk?"]);

        return (
          <Marker key={row["Name"]} position={[lat, lng]}>
            <Popup>
              <div className="popup">
                <h3>{row["Name"]}</h3>
                <p>{row["Area"]} · {row["Category"]}</p>
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
  );
}