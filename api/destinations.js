// /api/destinations.js — Overpass LIVE destinations (EU/UK) — v4.0
// GET params:
//   lat, lon (required)
//   radiusKm (optional, default 80, min 5, max 350)
//   cat (optional): ovunque|family|storia|borghi|citta|mare|natura
//
// Returns:
//   { ok:true, meta:{...}, data:{...overpass json...} }
//   { ok:false, error:"...", details?:... }

const OVERPASS = "https://overpass-api.de/api/interpreter";

// conservative caps: live is a helper, not a whole world DB
const DEFAULT_RADIUS_KM = 80;
const MIN_RADIUS_KM = 5;
const MAX_RADIUS_KM = 350;
const TIMEOUT_SEC = 25;

// hard cap output (Overpass "out ... 400" is a soft cap but helps)
const OUT_LIMIT = 450;

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function cleanCat(x) {
  const c = String(x || "ovunque").toLowerCase().trim();
  const allowed = new Set(["ovunque", "family", "storia", "borghi", "citta", "mare", "natura"]);
  return allowed.has(c) ? c : "ovunque";
}

// Build category-specific Overpass blocks (nwr = node/way/relation)
function buildCatQuery(cat, radiusM, lat, lon) {
  // NOTE:
  // - Use nwr so we catch ways/relations (big parks, historic sites, beaches, etc.)
  // - Prefer "tourism/leisure/historic/natural" meaningful tags
  // - Avoid tiny noise like generic leisure=park (too broad) and generic playground (too many)
  //
  // The app already filters/boosts; here we just pull better candidates.

  const around = `(around:${radiusM},${lat},${lon})`;

  if (cat === "family") {
    // "Touristic family" set:
    // - theme parks, water parks, zoos, aquariums, major attractions
    // - swimming pools (nice for kids) + indoor play centers (where tagged)
    // We intentionally DO NOT pull generic leisure=park/playground (too many micro-parks)
    return `
      nwr${around}["tourism"="theme_park"];
      nwr${around}["leisure"="water_park"];
      nwr${around}["tourism"="zoo"];
      nwr${around}["amenity"="zoo"];
      nwr${around}["tourism"="aquarium"];
      nwr${around}["amenity"="aquarium"];
      nwr${around}["tourism"="attraction"];
      nwr${around}["attraction"];
      nwr${around}["amenity"="water_park"];
      nwr${around}["leisure"="amusement_arcade"];
      nwr${around}["leisure"="sports_centre"]["sport"="swimming"];
      nwr${around}["leisure"="swimming_pool"];
      nwr${around}["amenity"="swimming_pool"];
      nwr${around}["leisure"="trampoline_park"];
      nwr${around}["leisure"="indoor_play"];
      nwr${around}["leisure"="play_centre"];
    `;
  }

  if (cat === "storia") {
    // Make "history" actually work:
    // - castles/forts/ruins/towers/monuments/memorials/archaeological sites
    // - museums/galleries
    // - heritage tagged stuff
    // We avoid pulling every church; if you want we can add selective place_of_worship later.
    return `
      nwr${around}["historic"="castle"];
      nwr${around}["historic"="fort"];
      nwr${around}["historic"="ruins"];
      nwr${around}["historic"="archaeological_site"];
      nwr${around}["historic"="monument"];
      nwr${around}["historic"="memorial"];
      nwr${around}["historic"="tower"];
      nwr${around}["historic"="city_gate"];
      nwr${around}["historic"="battlefield"];
      nwr${around}["heritage"];

      nwr${around}["tourism"="museum"];
      nwr${around}["tourism"="gallery"];
      nwr${around}["tourism"="attraction"]["historic"];
      nwr${around}["tourism"="attraction"]["heritage"];
    `;
  }

  if (cat === "borghi") {
    // Villages/hamlets + "old town" / historic centers where tagged
    return `
      node${around}["place"~"^(village|hamlet)$"]["name"];
      nwr${around}["place"~"^(village|hamlet)$"]["name"];
      nwr${around}["historic"="city_gate"]["name"];
      nwr${around}["historic"]["name"]["tourism"="attraction"];
      nwr${around}["tourism"="attraction"]["name"]["old_name"];
    `;
  }

  if (cat === "citta") {
    return `
      node${around}["place"~"^(city|town)$"]["name"];
      nwr${around}["place"~"^(city|town)$"]["name"];
    `;
  }

  if (cat === "mare") {
    // Beaches + seaside attractions + viewpoints + marinas
    return `
      nwr${around}["natural"="beach"];
      nwr${around}["tourism"="beach_resort"];
      nwr${around}["leisure"="marina"];
      nwr${around}["man_made"="pier"];
      nwr${around}["tourism"="attraction"]["name"]["natural"="beach"];
      nwr${around}["tourism"="viewpoint"];
    `;
  }

  if (cat === "natura") {
    return `
      nwr${around}["boundary"="national_park"];
      nwr${around}["leisure"="nature_reserve"];
      nwr${around}["natural"="peak"];
      nwr${around}["waterway"="waterfall"];
      nwr${around}["tourism"="viewpoint"];
      nwr${around}["natural"="gorge"];
      nwr${around}["natural"="cave_entrance"];
      nwr${around}["natural"="hot_spring"];
    `;
  }

  // ovunque: mix "touristic & meaningful" (not too noisy)
  return `
    nwr${around}["tourism"="attraction"];
    nwr${around}["tourism"="museum"];
    nwr${around}["tourism"="theme_park"];
    nwr${around}["leisure"="water_park"];
    nwr${around}["tourism"="zoo"];
    nwr${around}["tourism"="aquarium"];
    nwr${around}["historic"="castle"];
    nwr${around}["historic"="archaeological_site"];
    nwr${around}["natural"="beach"];
    nwr${around}["boundary"="national_park"];
    nwr${around}["leisure"="nature_reserve"];
    nwr${around}["tourism"="viewpoint"];
  `;
}

// Optional post-filter in Overpass:
// Keep only elements with a real name OR a strong tag that we can label later.
// (We cannot do complex OR name fallback in Overpass, but we can reduce noise.)
function buildStrongFilter() {
  // We keep:
  // - named features
  // - OR strong categories even if unnamed (theme_park/water_park/zoo/aquarium/museum/castle/beach/national_park/viewpoint)
  // This avoids tons of unnamed micro-objects.
  return `
    (
      .all["name"];
      .all["tourism"="theme_park"];
      .all["leisure"="water_park"];
      .all["tourism"="zoo"];
      .all["amenity"="zoo"];
      .all["tourism"="aquarium"];
      .all["amenity"="aquarium"];
      .all["tourism"="museum"];
      .all["historic"="castle"];
      .all["historic"="archaeological_site"];
      .all["natural"="beach"];
      .all["boundary"="national_park"];
      .all["leisure"="nature_reserve"];
      .all["tourism"="viewpoint"];
    )->.keep;
  `;
}

export default async function handler(req, res) {
  try {
    const lat = toNum(req.query.lat);
    const lon = toNum(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Invalid lat/lon" });
    }

    const cat = cleanCat(req.query.cat);
    const radiusKm = clamp(
      toNum(req.query.radiusKm ?? DEFAULT_RADIUS_KM) ?? DEFAULT_RADIUS_KM,
      MIN_RADIUS_KM,
      MAX_RADIUS_KM
    );
    const radiusM = Math.round(radiusKm * 1000);

    // Overpass query
    // - gather to .all
    // - then strong filter -> .keep
    // - output tags + center (so ways/relations have center coords)
    const catBlock = buildCatQuery(cat, radiusM, lat, lon);

    const query = `
[out:json][timeout:${TIMEOUT_SEC}];
(
  ${catBlock}
)->.all;

${buildStrongFilter()}

(.keep;)->.out;
out tags center qt ${OUT_LIMIT};
`;

    const r = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(query),
    });

    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: "Overpass error",
        details: txt.slice(0, 800),
        meta: { cat, radiusKm },
      });
    }

    let data = null;
    try { data = JSON.parse(txt); } catch {
      return res.status(502).json({
        ok: false,
        error: "Overpass returned non-JSON",
        details: txt.slice(0, 800),
        meta: { cat, radiusKm },
      });
    }

    // Cache: short (live)
    res.setHeader("Cache-Control", "public, s-maxage=240, stale-while-revalidate=1200");

    return res.status(200).json({
      ok: true,
      meta: {
        cat,
        radiusKm,
        radiusM,
        timeoutSec: TIMEOUT_SEC,
        outLimit: OUT_LIMIT,
      },
      data,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(e) });
  }
}
