// /api/destinations.js — Overpass live destinations (EU/UK) — v3.2
// ✅ category filter: ?cat=family|borghi|citta|mare|natura|storia|ovunque
// ✅ uses nwr + out center (finds big POIs as ways/relations)
// ✅ family includes REAL kid attractions + water parks + theme parks + zoo/aquarium + pools + ALSO terme/spa (as requested)
// ✅ storia boosted: castles/fort/tower/ruins/archaeology + museums + historic churches/abbeys/monasteries

const OVERPASS = "https://overpass-api.de/api/interpreter";

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function normCat(x) {
  const c = String(x || "").toLowerCase().trim();
  const allowed = new Set(["family", "borghi", "citta", "mare", "natura", "storia", "ovunque"]);
  return allowed.has(c) ? c : "ovunque";
}

function blocksForCat(cat, radiusM, lat, lon) {
  const around = `(around:${radiusM},${lat},${lon})`;

  if (cat === "family") {
    // Real attractions + kids + ALSO terme/spa (user requested)
    return `
      nwr${around}["tourism"="theme_park"];
      nwr${around}["leisure"="water_park"];
      nwr${around}["tourism"="attraction"];
      nwr${around}["amenity"="zoo"];
      nwr${around}["tourism"="zoo"];
      nwr${around}["amenity"="aquarium"];
      nwr${around}["tourism"="aquarium"];
      nwr${around}["leisure"="swimming_pool"];
      nwr${around}["sport"="swimming"];
      nwr${around}["tourism"="museum"];          /* spesso family-friendly */
      nwr${around}["amenity"="spa"];             /* TERME/SPA ok */
      nwr${around}["amenity"="public_bath"];     /* TERME/SPA ok */
      nwr${around}["natural"="hot_spring"];      /* TERME/SPA ok */
    `;
  }

  if (cat === "storia") {
    // BIG BOOST: includes the stuff you were missing near L'Aquila area
    // - castles / forts / towers / gates / ruins / archaeology
    // - museums / galleries
    // - historic churches/abbeys/monasteries/cathedrals (often mapped as place_of_worship + building=church)
    return `
      nwr${around}["historic"="castle"];
      nwr${around}["historic"="fort"];
      nwr${around}["historic"="ruins"];
      nwr${around}["historic"="monument"];
      nwr${around}["historic"="memorial"];
      nwr${around}["historic"="archaeological_site"];
      nwr${around}["man_made"="tower"];
      nwr${around}["historic"="city_gate"];

      nwr${around}["tourism"="museum"];
      nwr${around}["tourism"="gallery"];
      nwr${around}["tourism"="attraction"]["historic"];

      /* chiese / abbazie / monasteri (molto frequenti in Italia) */
      nwr${around}["amenity"="place_of_worship"]["building"~"^(church|cathedral|chapel)$"];
      nwr${around}["amenity"="place_of_worship"]["name"~"(?i)(abbazia|abbey|monastero|monastery|convento|san |santa )"];
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
      nwr${around}["tourism"="viewpoint"];
      nwr${around}["man_made"="lighthouse"];
    `;
  }

  if (cat === "natura") {
    return `
      nwr${around}["boundary"="national_park"];
      nwr${around}["leisure"="nature_reserve"];
      nwr${around}["natural"="peak"];
      nwr${around}["natural"="waterfall"];
      nwr${around}["waterway"="waterfall"];
      nwr${around}["tourism"="viewpoint"];
      nwr${around}["natural"="cave_entrance"];
      nwr${around}["natural"="gorge"];
    `;
  }

  // ovunque: mix turistico forte
  return `
    nwr${around}["tourism"="theme_park"];
    nwr${around}["leisure"="water_park"];
    nwr${around}["tourism"="attraction"];
    nwr${around}["tourism"="museum"];
    nwr${around}["historic"="castle"];
    nwr${around}["historic"="archaeological_site"];
    nwr${around}["man_made"="tower"];
    nwr${around}["natural"="beach"];
    nwr${around}["boundary"="national_park"];
    nwr${around}["leisure"="nature_reserve"];
    nwr${around}["tourism"="viewpoint"];
    nwr${around}["amenity"="spa"];
    nwr${around}["amenity"="public_bath"];
    nwr${around}["natural"="hot_spring"];
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

    // live "nearby" default; allow up to 350km if you pass radiusKm
    const radiusKm = clamp(Number(req.query.radiusKm || 90), 5, 350);
    const radiusM = Math.round(radiusKm * 1000);

    // higher limit for family/storia (more POIs)
    const outLimit = (cat === "family" || cat === "storia") ? 1100 : 750;

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

    // Cache CDN a bit (don’t hammer Overpass)
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
