// /api/destinations.js — LIVE places via Overpass (EU/UK) — v3.2
// GET /api/destinations?lat=..&lon=..&radiusKm=..&cat=family|mare|borghi|storia|natura|montagna|citta|relax|ovunque
//
// Returns: { ok:true, data:<overpass json>, meta:{cat,radiusKm,count} }

const OVERPASS = "https://overpass-api.de/api/interpreter";

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function normCat(s) {
  const x = String(s || "").toLowerCase().trim();
  return x || "ovunque";
}
function around(radiusM, lat, lon) {
  return `(around:${radiusM},${lat},${lon})`;
}

/**
 * IMPORTANT CHANGES vs older versions:
 * - Uses nwr (node/way/relation)
 * - DOES NOT require ["name"] in query (name can be missing or in name:it/brand/operator)
 * - Uses `out center tags` to get coordinates for ways/relations
 * - Wider tag coverage for mare/natura/storia/family
 */
function buildQuery(cat, radiusM, lat, lon) {
  const a = around(radiusM, lat, lon);

  // Small generic fallback: towns/villages (helps "borghi/citta" even if other tags fail)
  const PLACES = `
    nwr${a}["place"~"^(city|town|village)$"];
  `;

  let block = "";

  if (cat === "mare") {
    block = `
      // beaches and seaside
      nwr${a}["natural"="beach"];
      nwr${a}["tourism"="beach_resort"];
      nwr${a}["leisure"="beach_resort"];
      nwr${a}["natural"="coastline"];
      nwr${a}["seamark:type"="beach"];
      nwr${a}["seamark:landmark:category"="beach"];

      // seaside leisure / viewpoints near coast
      nwr${a}["tourism"="viewpoint"];
      nwr${a}["tourism"="attraction"]["natural"="beach"];
      nwr${a}["tourism"="attraction"]["natural"="coastline"];
    `;
  }

  else if (cat === "natura") {
    block = `
      // protected areas
      nwr${a}["boundary"="national_park"];
      nwr${a}["boundary"="protected_area"];
      nwr${a}["leisure"="nature_reserve"];

      // highlights
      nwr${a}["natural"="peak"];
      nwr${a}["natural"="ridge"];
      nwr${a}["natural"="gorge"];
      nwr${a}["natural"="waterfall"];
      nwr${a}["waterway"="waterfall"];
      nwr${a}["natural"="cave_entrance"];
      nwr${a}["natural"="spring"];
      nwr${a}["natural"="hot_spring"];
      nwr${a}["natural"="lake"];
      nwr${a}["water"="lake"];
      nwr${a}["natural"="wood"];

      // parks + viewpoints
      nwr${a}["leisure"="park"];
      nwr${a}["tourism"="viewpoint"];
    `;
  }

  else if (cat === "storia") {
    block = `
      // historic generic (monuments, ruins, etc.)
      nwr${a}["historic"];
      nwr${a}["ruins"];
      nwr${a}["castle_type"];
      nwr${a}["historic"="castle"];
      nwr${a}["historic"="fort"];
      nwr${a}["historic"="archaeological_site"];
      nwr${a}["historic"="monument"];
      nwr${a}["historic"="memorial"];

      // museums / attractions
      nwr${a}["tourism"="museum"];
      nwr${a}["tourism"="attraction"];
      nwr${a}["tourism"="artwork"];
      nwr${a}["amenity"="theatre"];
    `;
  }

  else if (cat === "family") {
    block = `
      // theme parks / amusement / attractions
      nwr${a}["tourism"="theme_park"];
      nwr${a}["leisure"="amusement_park"];
      nwr${a}["tourism"="attraction"];
      nwr${a}["attraction"];

      // water parks / pools
      nwr${a}["leisure"="water_park"];
      nwr${a}["amenity"="water_park"];
      nwr${a}["amenity"="swimming_pool"];
      nwr${a}["leisure"="swimming_pool"];

      // zoo / aquarium
      nwr${a}["tourism"="zoo"];
      nwr${a}["amenity"="zoo"];
      nwr${a}["tourism"="aquarium"];
      nwr${a}["amenity"="aquarium"];

      // playground / indoor fun (named OR not named)
      nwr${a}["leisure"="playground"];
      nwr${a}["leisure"="amusement_arcade"];
      nwr${a}["leisure"="trampoline_park"];
      nwr${a}["sport"="climbing"];

      // also allow spas (you said ok in family)
      nwr${a}["amenity"="spa"];
      nwr${a}["leisure"="spa"];
      nwr${a}["amenity"="public_bath"];
      nwr${a}["amenity"="sauna"];
      nwr${a}["natural"="hot_spring"];
    `;
  }

  else if (cat === "relax") {
    block = `
      nwr${a}["amenity"="spa"];
      nwr${a}["leisure"="spa"];
      nwr${a}["natural"="hot_spring"];
      nwr${a}["amenity"="public_bath"];
      nwr${a}["amenity"="sauna"];
      nwr${a}["leisure"="sauna"];
    `;
  }

  else if (cat === "montagna") {
    block = `
      nwr${a}["natural"="peak"];
      nwr${a}["natural"="ridge"];
      nwr${a}["tourism"="viewpoint"];
      nwr${a}["aerialway"];
      nwr${a}["sport"="skiing"];
      nwr${a}["piste:type"];
    `;
  }

  else if (cat === "borghi") {
    block = `
      ${PLACES}
      nwr${a}["place"="village"];
      nwr${a}["tourism"="attraction"]["historic"];
      nwr${a}["historic"="citywalls"];
      nwr${a}["historic"="castle"];
    `;
  }

  else if (cat === "citta") {
    block = `
      nwr${a}["place"~"^(city|town)$"];
      nwr${a}["tourism"="attraction"];
      nwr${a}["tourism"="museum"];
      nwr${a}["historic"];
    `;
  }

  else {
    // ovunque
    block = `
      ${PLACES}
      nwr${a}["tourism"="attraction"];
      nwr${a}["tourism"="viewpoint"];
      nwr${a}["historic"];
      nwr${a}["natural"="beach"];
      nwr${a}["natural"="peak"];
      nwr${a}["leisure"="water_park"];
      nwr${a}["tourism"="theme_park"];
      nwr${a}["boundary"="national_park"];
      nwr${a}["leisure"="nature_reserve"];
    `;
  }

  // Always include PLACES so the response isn't empty (helps near inland too)
  const ql = `
[out:json][timeout:25];
(
  ${block}
  ${PLACES}
);
out center tags qt 600;
`;
  return ql;
}

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radiusKm = clamp(Number(req.query.radiusKm || 120), 5, 450);
    const radiusM = Math.round(radiusKm * 1000);
    const cat = normCat(req.query.cat);

    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Invalid lat/lon" });
    }

    const query = buildQuery(cat, radiusM, lat, lon);

    const r = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(query)
    });

    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: "Overpass error", details: txt.slice(0, 500) });
    }

    const data = JSON.parse(txt);
    const count = Array.isArray(data?.elements) ? data.elements.length : 0;

    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=900");
    return res.status(200).json({ ok: true, data, meta: { cat, radiusKm, count } });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(e) });
  }
}
