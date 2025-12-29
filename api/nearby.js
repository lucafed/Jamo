// api/nearby.js
// Trova mete vicine in EU/UK usando OpenStreetMap Overpass (gratis)
// POST body: { lat:number, lon:number, minutes:number, mode:"car"|"walk"|"bike", category:string, style:"known"|"gems" }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body = req.body || {};
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    const minutes = Number(body.minutes || 60);
    const mode = String(body.mode || "car");
    const category = String(body.category || "citta_borghi");
    const style = String(body.style || "known");

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "lat/lon required" });
    }

    // velocità realistiche (km/h)
    const speed =
      mode === "walk" ? 4.2 :
      mode === "bike" ? 14 :
      70; // car

    // raggio coerente col tempo (metri)
    // fattore 1.25 perché strade ≠ linea d’aria
    const radiusM = Math.max(1500, Math.min(250000, Math.round((speed * (minutes / 60)) * 1000 * 1.25)));

    const q = buildOverpassQuery({ lat, lon, radiusM, category, style });
    const url = "https://overpass-api.de/api/interpreter";

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "data=" + encodeURIComponent(q)
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(502).json({ error: "Overpass error", status: r.status, body: t.slice(0, 250) });
    }

    const data = await r.json();
    const elements = Array.isArray(data?.elements) ? data.elements : [];

    const places = elements
      .map(el => normalizeElement(el))
      .filter(Boolean);

    // dedup per id
    const seen = new Set();
    const unique = [];
    for (const p of places) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      unique.push(p);
    }

    return res.status(200).json({
      ok: true,
      input: { lat, lon, minutes, mode, category, style, radiusM },
      count: unique.length,
      places: unique.slice(0, 80)
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

function normalizeElement(el) {
  if (!el) return null;

  const tags = el.tags || {};
  const name = tags["name:it"] || tags["name"] || "";
  const lat = Number(el.lat || el.center?.lat);
  const lon = Number(el.lon || el.center?.lon);

  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const kind = classify(tags);

  // id stabile
  const id = `osm_${el.type}_${el.id}`;

  return {
    id,
    name,
    lat,
    lng: lon,
    type: kind.type,       // "citta" | "borgo" | "mare" | "montagna" | "natura" | "relax" | "bambini"
    visibility: kind.visibility, // "conosciuta" | "chicca"
    why: kind.why,
    what_to_do: kind.what_to_do,
    what_to_eat: [] // OSM non è ottimo per food; possiamo aggiungerlo dopo con fallback/AI
  };
}

function classify(tags) {
  // euristiche semplici ma efficaci
  const place = tags.place || "";
  const tourism = tags.tourism || "";
  const natural = tags.natural || "";
  const leisure = tags.leisure || "";
  const amenity = tags.amenity || "";
  const historic = tags.historic || "";
  const boundary = tags.boundary || "";
  const man_made = tags.man_made || "";
  const highway = tags.highway || "";
  const waterway = tags.waterway || "";

  // città/borghi
  if (place === "city" || place === "town" || boundary === "administrative") {
    return { type: "citta", visibility: "conosciuta", why: ["City break facile: passeggi, musei, cibo."], what_to_do: ["Centro storico", "Piazza principale", "Punto panoramico"] };
  }
  if (place === "village" || place === "hamlet" || place === "isolated_dwelling") {
    return { type: "borgo", visibility: "chicca", why: ["Borgo piccolo: vibe slow e carino."], what_to_do: ["Passeggiata tra vicoli", "Belvedere", "Bar/gelato in piazza"] };
  }

  // mare
  if (natural === "beach" || tourism === "beach" || tags["seamark:type"] || tags.coastline === "yes") {
    return { type: "mare", visibility: "conosciuta", why: ["Mare vicino: relax e aria buona."], what_to_do: ["Passeggiata lungomare", "Spiaggia", "Tramonto"] };
  }

  // montagna / natura
  if (natural === "peak" || natural === "ridge" || tags.mountain_pass) {
    return { type: "montagna", visibility: "chicca", why: ["Montagna: panorami e aria pulita."], what_to_do: ["Belvedere", "Passeggiata semplice", "Foto panorama"] };
  }
  if (natural || waterway || tourism === "viewpoint" || tourism === "attraction" || man_made === "waterfall") {
    return { type: "natura", visibility: "chicca", why: ["Natura: gita facile, zero stress."], what_to_do: ["Sentiero breve", "Punto foto", "Picnic veloce"] };
  }

  // relax / bambini
  if (amenity === "spa" || leisure === "sauna" || tags["bath:type"]) {
    return { type: "relax", visibility: "conosciuta", why: ["Relax: stacchi subito."], what_to_do: ["Terme/SPA", "Passeggiata", "Cena tranquilla"] };
  }
  if (tourism === "theme_park" || tourism === "zoo" || leisure === "park" || leisure === "playground") {
    return { type: "bambini", visibility: "conosciuta", why: ["Perfetto con bambini: divertimento facile."], what_to_do: ["Giro parco", "Area giochi", "Pausa gelato"] };
  }

  // default: chicca generica
  return { type: "natura", visibility: "chicca", why: ["Posto vicino e interessante, ideale per cambiare aria."], what_to_do: ["Giro veloce", "Punto panoramico", "Caffè in zona"] };
}

function buildOverpassQuery({ lat, lon, radiusM, category, style }) {
  // Filtri per categoria (solo tag sensati)
  // NB: Overpass = linguaggio query; usiamo out center per way/relation
  const cat = String(category || "").toLowerCase();

  const wantCities = cat.includes("citta") || cat.includes("borghi");
  const wantBorgoOnly = cat === "borgo";
  const wantCityOnly = cat === "citta";

  const parts = [];

  if (wantCities) {
    // città e borghi (place=*)
    parts.push(`
      node(around:${radiusM},${lat},${lon})["place"~"city|town|village|hamlet"];
    `);
  } else if (cat === "mare") {
    parts.push(`
      node(around:${radiusM},${lat},${lon})["natural"="beach"];
      way(around:${radiusM},${lat},${lon})["natural"="beach"];
      relation(around:${radiusM},${lat},${lon})["natural"="beach"];
      node(around:${radiusM},${lat},${lon})["tourism"="beach"];
    `);
  } else if (cat === "montagna") {
    parts.push(`
      node(around:${radiusM},${lat},${lon})["natural"~"peak|ridge"];
      node(around:${radiusM},${lat},${lon})["tourism"="viewpoint"];
    `);
  } else if (cat === "natura") {
    parts.push(`
      node(around:${radiusM},${lat},${lon})["tourism"="viewpoint"];
      node(around:${radiusM},${lat},${lon})["man_made"="waterfall"];
      node(around:${radiusM},${lat},${lon})["natural"];
      way(around:${radiusM},${lat},${lon})["natural"];
    `);
  } else if (cat === "relax") {
    parts.push(`
      node(around:${radiusM},${lat},${lon})["amenity"="spa"];
      node(around:${radiusM},${lat},${lon})["leisure"="sauna"];
    `);
  } else if (cat === "bambini") {
    parts.push(`
      node(around:${radiusM},${lat},${lon})["tourism"~"theme_park|zoo"];
      node(around:${radiusM},${lat},${lon})["leisure"~"park|playground"];
    `);
  } else {
    // fallback generico: viewpoint/attraction/natural
    parts.push(`
      node(around:${radiusM},${lat},${lon})["tourism"="viewpoint"];
      node(around:${radiusM},${lat},${lon})["tourism"="attraction"];
      node(around:${radiusM},${lat},${lon})["natural"];
    `);
  }

  // Se "gems": preferisci cose “non metropoli” → niente city/town
  // (lo facciamo già nel classify/score lato client, ma qui riduciamo rumore)
  const gems = String(style) === "gems";
  if (gems && wantCities && !wantCityOnly) {
    // se voglio città+borghi e gems → più borghi: village/hamlet
    return `
      [out:json][timeout:25];
      (
        node(around:${radiusM},${lat},${lon})["place"~"village|hamlet"];
        node(around:${radiusM},${lat},${lon})["tourism"="viewpoint"];
        node(around:${radiusM},${lat},${lon})["man_made"="waterfall"];
        node(around:${radiusM},${lat},${lon})["natural"="beach"];
        node(around:${radiusM},${lat},${lon})["natural"];
      );
      out center 80;
    `;
  }

  // città-only o combo normale
  let cityFilter = "";
  if (wantBorgoOnly) cityFilter = `["place"~"village|hamlet"]`;
  if (wantCityOnly) cityFilter = `["place"~"city|town"]`;

  if (wantCities && cityFilter) {
    return `
      [out:json][timeout:25];
      (
        node(around:${radiusM},${lat},${lon})${cityFilter};
      );
      out center 80;
    `;
  }

  return `
    [out:json][timeout:25];
    (
      ${parts.join("\n")}
    );
    out center 80;
  `;
}
