// /api/jamo.js — ONE API to rule them all (Vercel Hobby friendly)
// POST { origin:{lat,lon,label?}, minutes:number, mode:"car"|"walk"|"bike"|"train"|"bus"|"plane", style:"known"|"gems", category:string, excludeIds?:string[] }
// Returns { ok:true, top:{...}, alternatives:[...], debug?:... }

import fs from "fs";
import path from "path";

function readJsonFromPublicData(filename) {
  const p = path.join(process.cwd(), "public", "data", filename);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function toRad(x) { return (x * Math.PI) / 180; }
function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}
function normName(s) {
  return norm(s).replace(/[^a-z0-9]+/g, " ").trim();
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  // car + default
  return 70;
}

function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);
  if (c.includes("borgh") && c.includes("citt")) return ["citta", "borgo"];
  if (c === "citta_borghi" || c.includes("citta") && c.includes("borg")) return ["citta", "borgo"];
  if (c === "citta" || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];
  if (c === "mare") return ["mare"];
  if (c === "montagna") return ["montagna"];
  if (c === "natura") return ["natura"];
  if (c === "relax") return ["relax"];
  if (c === "bambini") return ["bambini"];
  return [c];
}

function buildIdFromName(name, lat, lon) {
  const base = normName(name).slice(0, 60).replace(/\s+/g, "_");
  const a = Number.isFinite(lat) ? lat.toFixed(4) : "x";
  const o = Number.isFinite(lon) ? lon.toFixed(4) : "y";
  return `osm_${base}_${a}_${o}`;
}

function pickRadiusKm(minutes, mode) {
  // “vicino davvero”: per tempi piccoli non allarghiamo troppo
  const speed = avgSpeedKmh(mode);
  const km = (speed * (minutes / 60)) * 1.2; // haversine sottostima strade
  return clamp(km, mode === "walk" ? 2 : 5, mode === "bike" ? 18 : 180);
}

// Overpass helpers
async function overpass(query) {
  const url = "https://overpass-api.de/api/interpreter";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Overpass ${r.status}: ${txt.slice(0, 120)}`);
  return JSON.parse(txt);
}

function overpassQueryFor(category, lat, lon, radiusKm, style) {
  const r = Math.round(radiusKm * 1000);

  // NOTE: categoria "mare" => beach/coast, evita città inland
  if (category === "mare") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["natural"="beach"];
        way(around:${r},${lat},${lon})["natural"="beach"];
        node(around:${r},${lat},${lon})["tourism"="beach_resort"];
        way(around:${r},${lat},${lon})["tourism"="beach_resort"];
        node(around:${r},${lat},${lon})["place"="island"]["name"];
      );
      out center 60;
    `;
  }

  if (category === "montagna") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["natural"="peak"];
        node(around:${r},${lat},${lon})["tourism"="viewpoint"];
        way(around:${r},${lat},${lon})["tourism"="viewpoint"];
      );
      out center 80;
    `;
  }

  if (category === "natura") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["waterway"="waterfall"];
        node(around:${r},${lat},${lon})["natural"="wood"];
        way(around:${r},${lat},${lon})["natural"="wood"];
        node(around:${r},${lat},${lon})["natural"="spring"];
        node(around:${r},${lat},${lon})["tourism"="viewpoint"];
        way(around:${r},${lat},${lon})["leisure"="park"];
      );
      out center 100;
    `;
  }

  if (category === "relax") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["amenity"="spa"];
        way(around:${r},${lat},${lon})["amenity"="spa"];
        node(around:${r},${lat},${lon})["natural"="hot_spring"];
        node(around:${r},${lat},${lon})["leisure"="park"];
      );
      out center 80;
    `;
  }

  if (category === "bambini") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["tourism"="theme_park"];
        way(around:${r},${lat},${lon})["tourism"="theme_park"];
        node(around:${r},${lat},${lon})["leisure"="playground"];
        way(around:${r},${lat},${lon})["leisure"="playground"];
        node(around:${r},${lat},${lon})["leisure"="park"];
      );
      out center 80;
    `;
  }

  // città/borghi: gems => village/town + castelli/viewpoint; known => city/town
  if (category === "citta" || category === "borgo" || category === "citta_borghi") {
    if (style === "gems") {
      return `
        [out:json][timeout:25];
        (
          node(around:${r},${lat},${lon})["place"~"village|hamlet|town"]["name"];
          node(around:${r},${lat},${lon})["historic"="castle"]["name"];
          node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
          way(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
        );
        out center 120;
      `;
    }
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["place"~"city|town"]["name"];
      );
      out center 80;
    `;
  }

  // fallback generico: viewpoint/attraction
  return `
    [out:json][timeout:25];
    (
      node(around:${r},${lat},${lon})["tourism"="attraction"]["name"];
      node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
      way(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
    );
    out center 80;
  `;
}

function osmElementToPlace(el) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags["name:en"];
  if (!name) return null;

  let lat = el.lat;
  let lon = el.lon;
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && el.center) {
    lat = el.center.lat;
    lon = el.center.lon;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // “type” euristico
  let type = "natura";
  if (tags.natural === "beach" || tags.tourism === "beach_resort") type = "mare";
  if (tags.place === "city" || tags.place === "town") type = "citta";
  if (tags.place === "village" || tags.place === "hamlet") type = "borgo";
  if (tags.natural === "peak") type = "montagna";
  if (tags.amenity === "spa" || tags.natural === "hot_spring") type = "relax";
  if (tags.tourism === "theme_park" || tags.leisure === "playground") type = "bambini";

  return {
    id: buildIdFromName(name, lat, lon),
    name,
    country: "", // non sempre presente
    type,
    visibility: "chicca",
    lat,
    lng: lon,
    tags: [],
    vibes: [],
    best_when: [],
    why: [],
    what_to_do: [],
    what_to_eat: []
  };
}

function enrichPlace(place, category, style, origin, minutes, mode) {
  // ETA “auto-like” come stima, anche se mode=plane/train/bus (qui la usiamo per vicinanza e coerenza)
  const km = haversineKm(origin.lat, origin.lon, place.lat, place.lng);
  const speed = avgSpeedKmh(mode === "walk" || mode === "bike" ? mode : "car");
  const eta = (km / speed) * 60;

  const isGems = style === "gems";
  const cat = category;

  // WHY + DO/EAT fallback se mancano
  const why = Array.isArray(place.why) && place.why.length ? place.why : [];
  const whatToDo = Array.isArray(place.what_to_do) && place.what_to_do.length ? place.what_to_do : [];
  const whatToEat = Array.isArray(place.what_to_eat) && place.what_to_eat.length ? place.what_to_eat : [];

  const genWhy = [];
  if (!why.length) {
    if (cat === "mare") genWhy.push("Hai scelto mare: qui trovi spiaggia/costa vicina e facile.");
    else if (cat === "montagna") genWhy.push("Hai scelto montagna: panorama e aria fresca senza troppi sbatti.");
    else if (cat === "relax") genWhy.push("Hai scelto relax: posto perfetto per staccare e ricaricare.");
    else if (cat === "natura") genWhy.push("Hai scelto natura: passeggiata e scorci belli a portata di tempo.");
    else if (cat === "bambini") genWhy.push("Hai scelto kids: attività semplice, zero stress.");
    else genWhy.push(isGems ? "Chicca vicina: più piccola, più carina, meno caos." : "Opzione solida e facile per oggi.");
    genWhy.push(`È coerente col tempo: circa ${Math.round(eta)} min (stima).`);
  }

  const genDo = [];
  if (!whatToDo.length) {
    if (cat === "mare") genDo.push("Passeggiata sul lungomare / spiaggia", "Tramonto", "Gelato o aperitivo vista");
    else if (cat === "montagna") genDo.push("Belvedere / viewpoint", "Passeggiata breve", "Rifugio o bar panoramico");
    else if (cat === "relax") genDo.push("Spa/terme (se presenti)", "Parco e camminata lenta", "Cena tranquilla");
    else if (cat === "natura") genDo.push("Sentiero facile", "Punto panoramico", "Picnic se il meteo regge");
    else if (cat === "bambini") genDo.push("Parco giochi / parco", "Attività semplice", "Merenda facile");
    else genDo.push("Passeggiata nel centro", "Punto panoramico", "Caffè e giro senza fretta");
  }

  const genEat = [];
  if (!whatToEat.length) {
    if (cat === "mare") genEat.push("Pesce / fritto", "Gelato", "Aperitivo");
    else genEat.push("Specialità locale", "Dolce tipico", "Aperitivo in centro");
  }

  return {
    ...place,
    distance_km: km,
    eta_min: eta,
    why: why.length ? why : genWhy,
    what_to_do: whatToDo.length ? whatToDo : genDo,
    what_to_eat: whatToEat.length ? whatToEat : genEat
  };
}

function scorePlace(p, origin, minutes, style, category) {
  // vicino per davvero + coerenza col tempo + chicca/known
  const km = p.distance_km ?? haversineKm(origin.lat, origin.lon, p.lat, p.lng);
  const eta = p.eta_min ?? (km / avgSpeedKmh("car")) * 60;

  const t = clamp(1 - (Math.abs(eta - minutes) / Math.max(18, minutes * 0.9)), 0, 1);
  const near = clamp(1 - (eta / (minutes * 1.25)), 0, 1);

  // chicche => penalizza metropoli quando category non è "citta"
  const isCity = norm(p.type) === "citta";
  const isBigCityPenalty = (style === "gems" && isCity && category !== "citta") ? 0.35 : 0;

  const styleBoost = style === "gems"
    ? (norm(p.visibility) === "chicca" ? 1 : 0.85)
    : (norm(p.visibility) === "conosciuta" ? 1 : 0.9);

  return (0.55 * near) + (0.30 * t) + (0.15 * styleBoost) - isBigCityPenalty;
}

function isSamePlace(aName, bLabel) {
  const an = normName(aName);
  const bl = normName(bLabel);
  return an && bl && an === bl;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = norm(body.mode || "car");
    const style = norm(body.style || "known"); // known | gems
    const categoryRaw = body.category ?? "citta_borghi";
    const categoryNorm = norm(categoryRaw);
    const allowedTypes = allowedTypesFromCategory(categoryRaw);
    const excludeIds = new Set(Array.isArray(body.excludeIds) ? body.excludeIds : []);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);
    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}", got: origin });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "minutes must be a positive number" });
    }

    const originLabel = origin.label || "";
    const originObj = { lat: oLat, lon: oLon, label: originLabel };

    // 1) Load curated (baseline “curated”)
    const curated = readJsonFromPublicData("curated.json");
    const curatedPlaces = Array.isArray(curated?.places) ? curated.places : [];

    // 2) Filter curated by category
    const curatedCandidates = curatedPlaces
      .map(p => ({
        ...p,
        type: norm(p.type),
        visibility: norm(p.visibility),
        lat: Number(p.lat),
        lng: Number(p.lng)
      }))
      .filter(p =>
        p.id &&
        p.name &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        !excludeIds.has(p.id)
      )
      .filter(p => {
        // mare non deve mai prendere città inland (Milano ecc) -> solo type mare
        if (allowedTypes.length === 1 && allowedTypes[0] === "mare") return norm(p.type) === "mare";
        // altre categorie: match stretto
        return allowedTypes.includes(norm(p.type));
      })
      .map(p => enrichPlace(p, allowedTypes[0] || "citta_borghi", style, originObj, minutes, mode))
      .filter(p => {
        // evita stessa città/luogo
        if (originLabel && isSamePlace(p.name, originLabel)) return false;
        // evita troppo vicino (es. sei già lì)
        if (p.distance_km < 2) return false;
        return true;
      });

    // 3) “Nearby real-world” fallback via Overpass
    const radiusKm = pickRadiusKm(minutes, mode);
    const needFallback = curatedCandidates.length < 3;

    let osmCandidates = [];
    if (needFallback) {
      // scegli categoria principale da usare in query
      const mainCat = (() => {
        if (allowedTypes.includes("mare")) return "mare";
        if (allowedTypes.includes("montagna")) return "montagna";
        if (allowedTypes.includes("natura")) return "natura";
        if (allowedTypes.includes("relax")) return "relax";
        if (allowedTypes.includes("bambini")) return "bambini";
        if (allowedTypes.includes("borgo") && allowedTypes.includes("citta")) return "citta_borghi";
        if (allowedTypes.includes("borgo")) return "borgo";
        if (allowedTypes.includes("citta")) return "citta";
        return "citta_borghi";
      })();

      const q = overpassQueryFor(mainCat, originObj.lat, originObj.lon, radiusKm, style);
      const data = await overpass(q);
      const els = Array.isArray(data?.elements) ? data.elements : [];

      osmCandidates = els
        .map(osmElementToPlace)
        .filter(Boolean)
        .filter(p => !excludeIds.has(p.id))
        .map(p => enrichPlace(p, mainCat, style, originObj, minutes, mode))
        .filter(p => {
          if (originLabel && isSamePlace(p.name, originLabel)) return false;
          if (p.distance_km < 2) return false;
          // mare: ulteriore sicurezza (solo se realmente mare)
          if (mainCat === "mare" && norm(p.type) !== "mare") return false;
          return true;
        });
    }

    // 4) Merge + score
    const mergedMap = new Map();
    for (const p of [...curatedCandidates, ...osmCandidates]) {
      if (!p?.id) continue;
      if (mergedMap.has(p.id)) continue;
      mergedMap.set(p.id, p);
    }
    let merged = [...mergedMap.values()];

    // se ancora poco, allarga Overpass una volta (solo se serve)
    if (merged.length < 3 && needFallback) {
      const mainCat = allowedTypes.includes("mare") ? "mare" : "citta_borghi";
      const q2 = overpassQueryFor(mainCat, originObj.lat, originObj.lon, Math.min(radiusKm * 1.8, 250), style);
      const data2 = await overpass(q2);
      const els2 = Array.isArray(data2?.elements) ? data2.elements : [];
      const more = els2
        .map(osmElementToPlace)
        .filter(Boolean)
        .filter(p => !excludeIds.has(p.id))
        .map(p => enrichPlace(p, mainCat, style, originObj, minutes, mode))
        .filter(p => {
          if (originLabel && isSamePlace(p.name, originLabel)) return false;
          if (p.distance_km < 2) return false;
          if (mainCat === "mare" && norm(p.type) !== "mare") return false;
          return true;
        });

      for (const p of more) if (!mergedMap.has(p.id)) mergedMap.set(p.id, p);
      merged = [...mergedMap.values()];
    }

    if (!merged.length) {
      return res.status(200).json({
        ok: true,
        top: null,
        alternatives: [],
        message: "Nessuna meta trovata: dataset troppo piccolo o filtri troppo stretti."
      });
    }

    // score e ordina
    const mainCatForScore = allowedTypes.includes("mare") ? "mare" : (allowedTypes[0] || "citta_borghi");
    merged.forEach(p => { p._score = scorePlace(p, originObj, minutes, style, mainCatForScore); });
    merged.sort((a, b) => b._score - a._score);

    // pick top + 2 alts “diverse”
    const top = merged[0];

    // alternative: evita duplicati simili (stesso nome normalizzato)
    const usedNames = new Set([normName(top.name)]);
    const alternatives = [];
    for (const c of merged.slice(1)) {
      if (alternatives.length >= 2) break;
      const n = normName(c.name);
      if (usedNames.has(n)) continue;
      usedNames.add(n);
      alternatives.push(c);
    }

    // se poche alternative, prendi comunque (anche se simili) ma evita 0
    if (alternatives.length < 2) {
      for (const c of merged.slice(1)) {
        if (alternatives.length >= 2) break;
        if (!alternatives.find(x => x.id === c.id)) alternatives.push(c);
      }
    }

    // ripulisci output
    function outPlace(p) {
      return {
        id: p.id,
        name: p.country ? `${p.name}${p.country ? `, ${p.country}` : ""}` : p.name,
        type: p.type,
        visibility: p.visibility,
        lat: p.lat,
        lng: p.lng,
        eta_min: Math.round(p.eta_min),
        distance_km: Math.round(p.distance_km),
        why: (p.why || []).slice(0, 4),
        what_to_do: (p.what_to_do || []).slice(0, 6),
        what_to_eat: (p.what_to_eat || []).slice(0, 5),
        tags: p.tags || [],
        vibes: p.vibes || [],
        best_when: p.best_when || []
      };
    }

    return res.status(200).json({
      ok: true,
      top: outPlace(top),
      alternatives: alternatives.map(outPlace),
      debug: {
        minutes,
        mode,
        style,
        allowedTypes,
        radiusKm: Math.round(radiusKm),
        curatedCount: curatedCandidates.length,
        osmCount: osmCandidates.length
      }
    });
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che public/data/curated.json esista e che Vercel non blocchi Overpass (timeout)."
    });
  }
                                   }
