// /api/places.js  (Next.js / Vercel)
// GET: /api/places?lat=..&lon=..&radius=2500&kind=any
// Ritorna punti di interesse "cosa vedere/fare" con ranking + dedup.
// Ultra-stabile: Overpass pool + retry + fallback server.

const OVERPASS_POOL = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function mapsUrl(lat, lon, name) {
  const q = encodeURIComponent(name ? name : `${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function overpassRequest(query, attempts = 2) {
  for (let a = 0; a < attempts; a++) {
    for (const base of OVERPASS_POOL) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000); // 12s hard timeout
        const r = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "data=" + encodeURIComponent(query),
          signal: ctrl.signal
        }).finally(() => clearTimeout(t));

        const text = await r.text();
        if (!r.ok) {
          // retry su errori temporanei
          if ([429, 502, 503, 504].includes(r.status)) continue;
          throw new Error(`Overpass error (${r.status})`);
        }

        return JSON.parse(text);
      } catch {
        continue;
      }
    }
    await sleep(250 * (a + 1));
  }
  throw new Error("Overpass error (status 504)");
}

// Categorie “umane” -> Overpass filters
function buildPOIQuery({ lat, lon, radius, kind }) {
  const r = Math.round(radius);

  // Base POI (sempre utile)
  const base = `
    node(around:${r},${lat},${lon})["tourism"="attraction"];
    node(around:${r},${lat},${lon})["tourism"="museum"];
    node(around:${r},${lat},${lon})["tourism"="gallery"];
    node(around:${r},${lat},${lon})["historic"];
    node(around:${r},${lat},${lon})["tourism"="viewpoint"];
    node(around:${r},${lat},${lon})["leisure"="park"];
    node(around:${r},${lat},${lon})["amenity"="theatre"];
    node(around:${r},${lat},${lon})["amenity"="cinema"];
    node(around:${r},${lat},${lon})["amenity"="zoo"];
    node(around:${r},${lat},${lon})["amenity"="aquarium"];
    node(around:${r},${lat},${lon})["tourism"="theme_park"];
    node(around:${r},${lat},${lon})["leisure"="water_park"];
    node(around:${r},${lat},${lon})["amenity"="place_of_worship"];
  `.trim();

  // Filtri opzionali per “tema”
  // (NB: nel tuo UI hai categorie tipo mare/montagna/bambini. Qui le agganciamo al server.)
  const byKind = {
    any: base,
    city: `
      ${base}
      node(around:${r},${lat},${lon})["amenity"="marketplace"];
      node(around:${r},${lat},${lon})["tourism"="information"];
    `.trim(),

    sea: `
      ${base}
      node(around:${r},${lat},${lon})["natural"="beach"];
      node(around:${r},${lat},${lon})["tourism"="viewpoint"];
      node(around:${r},${lat},${lon})["leisure"="marina"];
    `.trim(),

    mountain: `
      ${base}
      node(around:${r},${lat},${lon})["natural"="peak"];
      node(around:${r},${lat},${lon})["tourism"="viewpoint"];
      node(around:${r},${lat},${lon})["waterway"="waterfall"];
      node(around:${r},${lat},${lon})["leisure"="nature_reserve"];
    `.trim(),

    kids: `
      node(around:${r},${lat},${lon})["tourism"="theme_park"];
      node(around:${r},${lat},${lon})["leisure"="water_park"];
      node(around:${r},${lat},${lon})["amenity"="zoo"];
      node(around:${r},${lat},${lon})["amenity"="aquarium"];
      node(around:${r},${lat},${lon})["leisure"="playground"];
      node(around:${r},${lat},${lon})["leisure"="park"];
      node(around:${r},${lat},${lon})["tourism"="museum"];
    `.trim()
  };

  const body = byKind[kind] || byKind.any;

  // Solo node = più veloce e meno 504.
  return `
[out:json][timeout:18];
(
  ${body}
);
out tags qt 120;
`.trim();
}

function classify(tags = {}) {
  // etichetta “umana”
  if (tags.tourism === "museum") return { label: "Museo", emoji: "🏛️" };
  if (tags.tourism === "gallery") return { label: "Galleria", emoji: "🖼️" };
  if (tags.tourism === "viewpoint") return { label: "Panorama", emoji: "🌄" };
  if (tags.tourism === "attraction") return { label: "Attrazione", emoji: "⭐" };
  if (tags.natural === "beach") return { label: "Spiaggia", emoji: "🏖️" };
  if (tags.natural === "peak") return { label: "Vetta / Monte", emoji: "⛰️" };
  if (tags.waterway === "waterfall") return { label: "Cascata", emoji: "💧" };
  if (tags.leisure === "park") return { label: "Parco", emoji: "🌳" };
  if (tags.leisure === "playground") return { label: "Area bimbi", emoji: "🧸" };
  if (tags.amenity === "zoo") return { label: "Zoo", emoji: "🦁" };
  if (tags.amenity === "aquarium") return { label: "Acquario", emoji: "🐠" };
  if (tags.tourism === "theme_park") return { label: "Parco divertimenti", emoji: "🎢" };
  if (tags.leisure === "water_park") return { label: "Parco acquatico", emoji: "🛝" };
  if (tags.historic) return { label: "Sito storico", emoji: "🏰" };
  if (tags.amenity === "place_of_worship") return { label: "Chiesa / Santuario", emoji: "⛪" };
  if (tags.amenity === "theatre") return { label: "Teatro", emoji: "🎭" };
  if (tags.amenity === "cinema") return { label: "Cinema", emoji: "🎬" };
  return { label: "Punto di interesse", emoji: "📍" };
}

function rank(tags = {}) {
  // ranking semplice ma efficace
  let s = 0;
  const hasWiki = !!(tags.wikidata || tags.wikipedia);

  // preferisci elementi “noti” (wiki) e più “turistici”
  if (hasWiki) s += 30;

  if (tags.tourism === "museum") s += 35;
  if (tags.tourism === "viewpoint") s += 30;
  if (tags.historic) s += 28;
  if (tags.tourism === "attraction") s += 24;
  if (tags.natural === "beach") s += 30;
  if (tags.waterway === "waterfall") s += 32;
  if (tags.natural === "peak") s += 26;
  if (tags.leisure === "park") s += 18;

  // penalizza cose poco “visitabili”
  if (tags.access === "private") s -= 40;
  if (tags.tourism === "information") s -= 10;

  // nome presente = molto meglio
  if (tags.name || tags["name:it"]) s += 10;

  return s;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radius = clamp(req.query.radius || 2500, 800, 12000); // metri
    const kind = String(req.query.kind || "any").toLowerCase(); // any|city|sea|mountain|kids

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Invalid lat/lon" });
    }

    // Step radius (se Overpass è sotto stress)
    const radii = [radius, Math.round(radius * 0.75), Math.round(radius * 0.55)];

    let data = null;
    for (const r of radii) {
      const q = buildPOIQuery({ lat, lon, radius: r, kind });
      try {
        data = await overpassRequest(q, 2);
        break;
      } catch {
        data = null;
      }
    }

    if (!data) {
      return res.status(200).json({
        elements: [],
        message: "Overpass è lento/giù (504). Riprova tra poco."
      });
    }

    const els = (data.elements || [])
      .map((el) => {
        if (el.type !== "node") return null;

        const tags = el.tags || {};
        const name = tags.name || tags["name:it"] || null;
        if (!name) return null;

        // scarta roba chiaramente non visitabile
        if (tags.access === "private") return null;

        const { label, emoji } = classify(tags);

        return {
          name,
          lat: el.lat,
          lon: el.lon,
          label,
          emoji,
          score: rank(tags),
          maps_url: mapsUrl(el.lat, el.lon, name),
          tags
        };
      })
      .filter(Boolean);

    // dedup + ordina per score
    const unique = uniqBy(els, p => `${p.name.toLowerCase()}_${p.lat.toFixed(4)}_${p.lon.toFixed(4)}`)
      .sort((a, b) => (b.score - a.score))
      .slice(0, 10); // top 10

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).json({ elements: unique });

  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
