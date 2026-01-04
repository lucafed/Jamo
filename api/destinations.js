// /api/destinations.js — LIVE places via Overpass (EU/UK) — v4.0 (NO TIMEOUT)
// GET /api/destinations?lat=..&lon=..&radiusKm=..&cat=family|mare|borghi|storia|natura|montagna|citta|relax|ovunque
//
// Strategy:
// - Progressive tiers (A -> B -> C) with small-to-large radii to avoid Overpass timeouts.
// - Uses nwr (node/way/relation) + out center to get coords for ways/relations.
// - Avoids huge generic selectors like ["historic"] without constraints.
// - Returns meta.alt_kind for "mare" fallback to "acqua" (lake/river) if no beach found.

const OVERPASS = "https://overpass-api.de/api/interpreter";

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function normCat(s) {
  const x = String(s || "").toLowerCase().trim();
  return x || "ovunque";
}
function around(radiusM, lat, lon) {
  return `(around:${radiusM},${lat},${lon})`;
}

function buildQL(parts, radiusM, lat, lon, limit = 220) {
  const a = around(radiusM, lat, lon);
  const body = parts.map(p => p(a)).join("\n");
  return `
[out:json][timeout:22];
(
${body}
);
out center tags qt ${limit};
`;
}

// ---- TIER DEFINITIONS ----
// Each tier is an array of functions (a) => `nwr${a}["k"="v"];` etc.
// Keep them focused to avoid huge scans.

const TIERS = {
  // FAMILY: tier A = tourist attractions; tier B = strong family; tier C = fallback (parks/spa/etc.)
  family: [
    { // A
      name: "A",
      limit: 240,
      q: [
        (a)=>`nwr${a}["tourism"="theme_park"];`,
        (a)=>`nwr${a}["leisure"="amusement_park"];`,
        (a)=>`nwr${a}["leisure"="water_park"];`,
        (a)=>`nwr${a}["amenity"="water_park"];`,
        (a)=>`nwr${a}["tourism"="zoo"];`,
        (a)=>`nwr${a}["tourism"="aquarium"];`,
        (a)=>`nwr${a}["tourism"="attraction"]["attraction"];`,
        (a)=>`nwr${a}["tourism"="attraction"]["name"];`,
      ],
    },
    { // B
      name: "B",
      limit: 260,
      q: [
        (a)=>`nwr${a}["amenity"="swimming_pool"];`,
        (a)=>`nwr${a}["leisure"="swimming_pool"];`,
        (a)=>`nwr${a}["leisure"="amusement_arcade"];`,
        (a)=>`nwr${a}["leisure"="trampoline_park"];`,
        (a)=>`nwr${a}["sport"="climbing"];`,
        (a)=>`nwr${a}["leisure"="playground"];`,
      ],
    },
    { // C (fallback, includes spas because you said OK, but LAST)
      name: "C",
      limit: 280,
      q: [
        (a)=>`nwr${a}["leisure"="park"];`,
        (a)=>`nwr${a}["tourism"="museum"];`,
        (a)=>`nwr${a}["amenity"="spa"];`,
        (a)=>`nwr${a}["leisure"="spa"];`,
        (a)=>`nwr${a}["natural"="hot_spring"];`,
        (a)=>`nwr${a}["amenity"="public_bath"];`,
      ],
    },
  ],

  // MARE: only true sea beach in main tiers. If none -> alt_kind "acqua" (lakes/rivers)
  mare: [
    {
      name: "A",
      limit: 220,
      q: [
        (a)=>`nwr${a}["natural"="beach"];`,
        (a)=>`nwr${a}["tourism"="beach_resort"];`,
        (a)=>`nwr${a}["leisure"="beach_resort"];`,
      ],
    },
    {
      name: "B",
      limit: 220,
      q: [
        (a)=>`nwr${a}["seamark:type"="beach"];`,
        (a)=>`nwr${a}["seamark:landmark:category"="beach"];`,
      ],
    },
  ],

  // NATURA: strong natural highlights, avoid generic "natural" without value constraints
  natura: [
    {
      name: "A",
      limit: 260,
      q: [
        (a)=>`nwr${a}["boundary"="national_park"];`,
        (a)=>`nwr${a}["leisure"="nature_reserve"];`,
        (a)=>`nwr${a}["boundary"="protected_area"];`,
      ],
    },
    {
      name: "B",
      limit: 300,
      q: [
        (a)=>`nwr${a}["natural"="waterfall"];`,
        (a)=>`nwr${a}["waterway"="waterfall"];`,
        (a)=>`nwr${a}["natural"="gorge"];`,
        (a)=>`nwr${a}["natural"="cave_entrance"];`,
        (a)=>`nwr${a}["natural"="peak"];`,
        (a)=>`nwr${a}["tourism"="viewpoint"];`,
      ],
    },
    {
      name: "C",
      limit: 300,
      q: [
        (a)=>`nwr${a}["natural"="lake"];`,
        (a)=>`nwr${a}["water"="lake"];`,
        (a)=>`nwr${a}["leisure"="park"];`,
        (a)=>`nwr${a}["natural"="spring"];`,
      ],
    },
  ],

  // STORIA: constrain historic values, avoid exploding "historic" wildcard
  storia: [
    {
      name: "A",
      limit: 260,
      q: [
        (a)=>`nwr${a}["historic"~"^(castle|fort|archaeological_site|ruins|monument|memorial)$"];`,
        (a)=>`nwr${a}["tourism"="museum"];`,
      ],
    },
    {
      name: "B",
      limit: 280,
      q: [
        (a)=>`nwr${a}["amenity"="theatre"];`,
        (a)=>`nwr${a}["tourism"="attraction"]["historic"~"^(castle|fort|archaeological_site|ruins)$"];`,
        (a)=>`nwr${a}["tourism"="artwork"];`,
      ],
    },
    {
      name: "C",
      limit: 280,
      q: [
        (a)=>`nwr${a}["historic"="city_gate"];`,
        (a)=>`nwr${a}["historic"="citywalls"];`,
        (a)=>`nwr${a}["historic"="church"];`, // common but still bounded
      ],
    },
  ],

  // BOR GHI / CITTA: cheap and safe
  borghi: [
    { name:"A", limit: 260, q: [(a)=>`nwr${a}["place"="village"];`, (a)=>`nwr${a}["place"="town"];`] },
  ],
  citta: [
    { name:"A", limit: 260, q: [(a)=>`nwr${a}["place"~"^(city|town)$"];`] },
  ],
  montagna: [
    { name:"A", limit: 280, q: [(a)=>`nwr${a}["natural"="peak"];`, (a)=>`nwr${a}["tourism"="viewpoint"];`] },
    { name:"B", limit: 280, q: [(a)=>`nwr${a}["sport"="skiing"];`, (a)=>`nwr${a}["aerialway"];`] },
  ],
  relax: [
    { name:"A", limit: 260, q: [(a)=>`nwr${a}["amenity"="spa"];`, (a)=>`nwr${a}["leisure"="spa"];`, (a)=>`nwr${a}["natural"="hot_spring"];`, (a)=>`nwr${a}["amenity"="public_bath"];`] },
  ],
  ovunque: [
    { name:"A", limit: 220, q: [(a)=>`nwr${a}["tourism"="attraction"];`, (a)=>`nwr${a}["tourism"="viewpoint"];`, (a)=>`nwr${a}["place"~"^(city|town|village)$"];`] },
  ],
};

// For "mare": fallback to lakes/rivers if beach none found
const MARE_FALLBACK_ACQUA = [
  (a)=>`nwr${a}["natural"="lake"];`,
  (a)=>`nwr${a}["water"="lake"];`,
  (a)=>`nwr${a}["waterway"="river"];`,
  (a)=>`nwr${a}["waterway"="riverbank"];`,
  (a)=>`nwr${a}["tourism"="viewpoint"];`,
];

// ---- fetch helper ----
async function overpassFetch(query) {
  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });
  const txt = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text: txt };
  let data = null;
  try { data = JSON.parse(txt); } catch {}
  if (!data) return { ok: false, status: 502, text: "Invalid JSON from Overpass" };
  return { ok: true, data };
}

function countElements(data) {
  return Array.isArray(data?.elements) ? data.elements.length : 0;
}

function isTimeoutRemark(data) {
  const rem = String(data?.remark || "");
  return rem.toLowerCase().includes("timed out");
}

function mergeDatasets(list) {
  // merge by (type,id)
  const seen = new Set();
  const out = { version: 0.6, generator: "Jamo merge", elements: [] };
  for (const d of list) {
    const els = Array.isArray(d?.elements) ? d.elements : [];
    for (const e of els) {
      const k = `${e.type}:${e.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.elements.push(e);
    }
  }
  return out;
}

// Progressive radii: starts small to avoid timeouts and speed up.
function radiiKmPlan(requestedKm) {
  const maxKm = clamp(Number(requestedKm) || 120, 5, 450);

  // Good defaults: 10/20/35/60/90/120... but never exceed requested
  const plan = [10, 20, 35, 60, 90, 120, 180, 240, 320, 450].filter(x => x <= maxKm);

  // If requested is small (<10) then single
  if (!plan.length) return [maxKm];

  // Ensure last equals requested (so user gets full range)
  if (plan[plan.length - 1] !== maxKm) plan.push(maxKm);

  return plan;
}

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const reqRadiusKm = clamp(Number(req.query.radiusKm || 120), 5, 450);
    const cat = normCat(req.query.cat);

    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Invalid lat/lon" });
    }

    const tiers = TIERS[cat] || TIERS.ovunque;
    const radii = radiiKmPlan(reqRadiusKm);

    let usedTier = null;
    let usedRadiusKm = null;
    let altKind = ""; // for mare fallback: "acqua"
    const attempts = [];
    let bestData = null;

    // 1) Progressive tier & radius
    outer: for (const t of tiers) {
      for (const km of radii) {
        const radiusM = Math.round(km * 1000);
        const ql = buildQL(t.q, radiusM, lat, lon, t.limit);
        const r = await overpassFetch(ql);

        if (!r.ok) {
          // Overpass errors - keep attempt
          attempts.push({ tier: t.name, radiusKm: km, ok: false, status: r.status });
          continue;
        }

        const data = r.data;
        const cnt = countElements(data);
        const timedOut = isTimeoutRemark(data);

        attempts.push({ tier: t.name, radiusKm: km, ok: true, count: cnt, timedOut });

        // If timeout -> try smaller radius next, do not accept
        if (timedOut) continue;

        // Accept if we have enough results or if it's the last radius of this tier
        if (cnt >= 18 || km === radii[radii.length - 1]) {
          usedTier = t.name;
          usedRadiusKm = km;
          bestData = data;
          break outer;
        }

        // else: keep searching bigger within same tier
        bestData = data; // keep last non-timeout
        usedTier = t.name;
        usedRadiusKm = km;
      }
    }

    // 2) Mare fallback to "acqua" if no beach found
    if (cat === "mare") {
      const cnt = countElements(bestData);
      if (!bestData || cnt === 0 || isTimeoutRemark(bestData)) {
        // fallback plan (still progressive but simpler)
        altKind = "acqua";
        const fbAttempts = [];
        let fbData = null;
        for (const km of radii) {
          const radiusM = Math.round(km * 1000);
          const ql = buildQL(MARE_FALLBACK_ACQUA, radiusM, lat, lon, 240);
          const r = await overpassFetch(ql);
          if (!r.ok) { fbAttempts.push({ tier:"F", radiusKm: km, ok:false, status:r.status }); continue; }
          const data = r.data;
          const c = countElements(data);
          const timedOut = isTimeoutRemark(data);
          fbAttempts.push({ tier:"F", radiusKm: km, ok:true, count:c, timedOut });
          if (timedOut) continue;
          fbData = data;
          if (c >= 18) { usedTier = "F"; usedRadiusKm = km; break; }
          usedTier = "F"; usedRadiusKm = km;
        }
        attempts.push(...fbAttempts);
        bestData = fbData || bestData;
      }
    }

    const finalCount = countElements(bestData);

    // Cache short to avoid hammering Overpass while user taps
    res.setHeader("Cache-Control", "public, s-maxage=90, stale-while-revalidate=600");

    return res.status(200).json({
      ok: true,
      data: bestData || { version: 0.6, generator: "Jamo empty", elements: [] },
      meta: {
        cat,
        requestedRadiusKm: reqRadiusKm,
        usedRadiusKm: usedRadiusKm ?? null,
        usedTier: usedTier ?? null,
        count: finalCount,
        alt_kind: altKind || "",
        attempts: attempts.slice(0, 18), // keep small
      },
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(e) });
  }
}
