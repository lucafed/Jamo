// /api/destinations.js — Overpass live destinations (EU/UK) — v3.0
// ✅ Supports category filter: ?cat=family|borghi|citta|mare|natura|storia|ovunque
// ✅ Uses nwr (node/way/relation) so it finds big parks like Gardaland (often relation/way)
// ✅ For family: focuses on TRUE tourist attractions (theme parks, water parks, zoo, aquarium, attractions…)
// ✅ Output includes "center" for ways/relations (so frontend can compute distance)

const OVERPASS = "https://overpass-api.de/api/interpreter";

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function normCat(x) {
  const c = String(x || "").toLowerCase().trim();
  const allowed = new Set(["family", "borghi", "citta", "mare", "natura", "storia", "ovunque"]);
  return allowed.has(c) ? c : "ovunque";
}

// Build Overpass "nwr(...)..." blocks for a category
function blocksForCat(cat, radiusM, lat, lon) {
  const around = `(around:${radiusM},${lat},${lon})`;

  // NOTE: nwr = node/way/relation
  // For ways/relations we use "out center" later so we get lat/lon.

  if (cat === "family") {
    // Focus on real attractions, NOT small local parks.
    return `
      nwr${around}["tourism"="theme_park"];
      nwr${around}["leisure"="water_park"];
      nwr${around}["amenity"="zoo"];
      nwr${around}["tourism"="zoo"];
      nwr${around}["amenity"="aquarium"];
      nwr${around}["tourism"="aquarium"];
      nwr${around}["leisure"="swimming_pool"];
      nwr${around}["sport"="swimming"];
      nwr${around}["tourism"="attraction"];
      nwr${around}["tourism"="museum"]; /* spesso family-friendly */
      nwr${around}["leisure"="amusement_arcade"];
      nwr${around}["tourism"="viewpoint"]; /* belvedere “wow” */
    `;
  }

  if (cat === "borghi") {
    return `
      nwr${around}["place"~"^(village|hamlet)$"];
      nwr${around}["tourism"="attraction"]["historic"];
      nwr${around}["historic"="castle"];
      nwr${around}["historic"="ruins"];
      nwr${around}["historic"="monument"];
    `;
  }

  if (cat === "citta") {
    return `
      nwr${around}["place"~"^(city|town)$"];
      nwr${around}["tourism"="attraction"];
      nwr${around}["tourism"="museum"];
      nwr${around}["historic"="castle"];
      nwr${around}["historic"="monument"];
    `;
  }

  if (cat === "mare") {
    return `
      nwr${around}["natural"="beach"];
      nwr${around}["amenity"="bathing_place"];
      nwr${around}["leisure"="beach_resort"];
      nwr${around}["tourism"="attraction"]["natural"="beach"];
      nwr${around}["tourism"="viewpoint"];
      nwr${around}["man_made"="lighthouse"];
    `;
  }

  if (cat === "storia") {
    return `
      nwr${around}["tourism"="museum"];
      nwr${around}["historic"="castle"];
      nwr${around}["historic"="ruins"];
      nwr${around}["historic"="monument"];
      nwr${around}["historic"="archaeological_site"];
      nwr${around}["tourism"="attraction"]["historic"];
      nwr${around}["amenity"="theatre"];
    `;
  }

  if (cat === "natura") {
    return `
      nwr${around}["boundary"="national_park"];
      nwr${around}["leisure"="nature_reserve"];
      nwr${around}["natural"="peak"];
      nwr${around}["natural"="waterfall"];
      nwr${around}["tourism"="viewpoint"];
      nwr${around}["natural"="cave_entrance"];
      nwr${around}["natural"="gorge"];
      nwr${around}["waterway"="waterfall"];
    `;
  }

  // ovunque: mix di cose belle/turistiche
  return `
    nwr${around}["tourism"="theme_park"];
    nwr${around}["leisure"="water_park"];
    nwr${around}["tourism"="attraction"];
    nwr${around}["tourism"="museum"];
    nwr${around}["historic"="castle"];
    nwr${around}["historic"="monument"];
    nwr${around}["natural"="beach"];
    nwr${around}["boundary"="national_park"];
    nwr${around}["leisure"="nature_reserve"];
    nwr${around}["tourism"="viewpoint"];
    nwr${around}["natural"="waterfall"];
  `;
}

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Invalid lat/lon" });
    }

    const cat = normCat(req.query.cat);
    const radiusKm = clamp(Number(req.query.radiusKm || 80), 5, 350); // live nearby
    const radiusM = Math.round(radiusKm * 1000);

    // Bigger limit for family (more chances to include the “big names”)
    const outLimit = (cat === "family") ? 900 : 650;

    const query = `
[out:json][timeout:25];
(
  ${blocksForCat(cat, radiusM, lat, lon)}
);
out tags center qt ${outLimit};
`;

    const r = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(query),
    });

    const txt = await r.text().catch(() => "");
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: "Overpass error",
        status: r.status,
        details: txt.slice(0, 400),
      });
    }

    let data = null;
    try { data = JSON.parse(txt); } catch {
      return res.status(502).json({ ok: false, error: "Bad JSON from Overpass", details: txt.slice(0, 200) });
    }

    // Cache CDN 6 min: enough to keep it snappy, avoids hammering Overpass
    res.setHeader("Cache-Control", "public, s-maxage=360, stale-while-revalidate=1200");

    return res.status(200).json({
      ok: true,
      input: { lat, lon, radiusKm, cat },
      data
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(e?.message || e) });
  }
}
