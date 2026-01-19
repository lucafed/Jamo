// scripts/build_events_all.mjs
// Jamo — Events builder (VENETO TEST, NON PUÒ USCIRE VUOTO)

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const OUT = "public/data/events/events_all.json";
const DAYS_AHEAD = 90;

// Bounding box Veneto
const BBOX = {
  minLat: 44.79,
  minLon: 10.57,
  maxLat: 46.68,
  maxLon: 13.10,
};

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function isoNow() {
  return new Date().toISOString();
}

async function fetchOverpassEvents() {
  const query = `
[out:json][timeout:25];
(
  node["event"]( ${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon} );
  node["amenity"="theatre"]( ${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon} );
  node["amenity"="arts_centre"]( ${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon} );
  node["leisure"="sports_centre"]( ${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon} );
);
out tags center;
`;

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "User-Agent": "JamoEventsBot/1.0",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) throw new Error("Overpass failed");

  const json = await res.json();
  return json.elements || [];
}

function normalizeEvent(el) {
  const t = el.tags || {};
  return {
    title: t.name || "Evento",
    lat: el.lat,
    lon: el.lon,
    area: t.addr?.city || t.addr?.town || "Veneto",
    country_code: "IT",
    category:
      t.event ||
      t.amenity ||
      t.leisure ||
      "evento",
    start: t.start_date || null,
  };
}

async function main() {
  console.log("▶ Building events (VENETO)…");

  let raw = [];
  try {
    raw = await fetchOverpassEvents();
  } catch (e) {
    console.error("❌ Overpass error", e);
  }

  const events = raw
    .map(normalizeEvent)
    .filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon));

  const payload = {
    updated_at: isoNow(),
    count: events.length,
    days_ahead: DAYS_AHEAD,
    events,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log("✔ events_all.json written:", events.length);
}

main();
