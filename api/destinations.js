// /api/destinations.js — Overpass: MULTI-CATEGORY (EU/UK) — v4.0
// GET /api/destinations?lat=..&lon=..&radiusKm=..&cat=family|borghi|citta|mare|natura|storia|ovunque
//
// Returns Overpass JSON with node/way/relation + center for ways/relations.
//
// Notes:
// - radiusKm clamped 3..200
// - out center => coordinate for ways/relations
// - cache 10 min

const OVERPASS = "https://overpass-api.de/api/interpreter";

function catFromReq(req) {
  const c = String(req.query.cat || "ovunque").toLowerCase().trim();
  const allowed = new Set(["family", "borghi", "citta", "mare", "natura", "storia", "ovunque"]);
  return allowed.has(c) ? c : "ovunque";
}

// Build Overpass block with nwr(...) lines
function buildQueryBlock(cat, radiusM, lat, lon) {
  const around = `around:${radiusM},${lat},${lon}`;

  // Helpers
  const nwr = (filter) => `  nwr(${around})${filter};`;

  // --- Category blocks ---
  const placesBlock = `
  // -------- PLACES (citta/borghi) --------
${nwr(`["place"~"^(city|town|village|hamlet)$"]`)}
`;

  const mareBlock = `
  // -------- MARE / BALNEARE --------
${nwr(`["natural"="beach"]`)}
${nwr(`["leisure"="beach_resort"]`)}
${nwr(`["amenity"="bathing_place"]`)}
`;

  const naturaBlock = `
  // -------- NATURA / WOW --------
${nwr(`["boundary"="national_park"]`)}
${nwr(`["leisure"="nature_reserve"]`)}
${nwr(`["leisure"="park"]`)}
${nwr(`["natural"="waterfall"]`)}
${nwr(`["tourism"="viewpoint"]`)}
${nwr(`["natural"="peak"]`)}
`;

  const storiaBlock = `
  // -------- STORIA / CULTURA TURISTICA --------
${nwr(`["historic"="castle"]`)}
${nwr(`["historic"="ruins"]`)}
${nwr(`["tourism"="museum"]`)}
${nwr(`["tourism"="attraction"]`)}
${nwr(`["tourism"="gallery"]`)}
`;

  const familyBlock = `
  // -------- FAMILY / ATTIVITA' --------
${nwr(`["tourism"="theme_park"]`)}
${nwr(`["leisure"="water_park"]`)}
${nwr(`["leisure"="swimming_pool"]`)}
${nwr(`["sport"="swimming"]`)}
${nwr(`["amenity"="spa"]`)}
${nwr(`["amenity"="public_bath"]`)}
${nwr(`["natural"="hot_spring"]`)}
${nwr(`["amenity"="zoo"]`)}
${nwr(`["amenity"="aquarium"]`)}
${nwr(`["leisure"="playground"]`)}
${nwr(`["tourism"="picnic_site"]`)}
${nwr(`["leisure"="miniature_golf"]`)}
${nwr(`["leisure"="sports_centre"]`)}
`;

  // Decide what to include
  if (cat === "borghi") return placesBlock;
  if (cat === "citta") return placesBlock;
  if (cat === "mare") return `${mareBlock}\n${placesBlock}`;     // utile includere anche i centri vicini
  if (cat === "natura") return `${naturaBlock}\n${placesBlock}`; // idem
  if (cat === "storia") return `${storiaBlock}\n${placesBlock}`; // idem
  if (cat === "family") return `${familyBlock}\n${placesBlock}`; // family + base places

  // ovunque = mix completo (buon compromesso)
  return `${familyBlock}\n${storiaBlock}\n${naturaBlock}\n${mareBlock}\n${placesBlock}`;
}

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    const radiusKm = Math.min(200, Math.max(3, Number(req.query.radiusKm || 25)));
    const radiusM = Math.round(radiusKm * 1000);

    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: "Invalid lat/lon" });
    }

    const cat = catFromReq(req);
    const block = buildQueryBlock(cat, radiusM, lat, lon);

    const query = `
[out:json][timeout:25];
(
${block}
);
out tags center qt 1800;
`;

    const r = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(query)
    });

    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({ error: "Overpass error", details: txt.slice(0, 500) });
    }

    const data = JSON.parse(txt);

    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    return res.status(200).json({
      ok: true,
      cat,
      radiusKm,
      data
    });

  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
