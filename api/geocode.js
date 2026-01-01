// /api/geocode.js — robust geocoding (Nominatim) — v1.0
// GET /api/geocode?q=...
// Returns: { ok:true, result:{ label, lat, lon }, candidates?:[...] } or { ok:false, error }

const TTL_MS = 1000 * 60 * 60 * 24; // 24h
const cache = new Map(); // q -> { ts, data }

function now() { return Date.now(); }

function cleanQ(q) {
  return String(q || "").trim().replace(/\s+/g, " ");
}

function shortLabelFromDisplayName(displayName) {
  // prova a rendere la label corta: "Comune, Provincia, Regione, Italia"
  const parts = String(displayName || "").split(",").map(s => s.trim()).filter(Boolean);
  return parts.slice(0, 3).join(", ") || displayName || "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Use GET" });
    }

    const qRaw = req.query?.q;
    const q = cleanQ(Array.isArray(qRaw) ? qRaw[0] : qRaw);

    if (!q) {
      return res.status(400).json({ ok: false, error: "Missing q" });
    }

    // cache
    const hit = cache.get(q.toLowerCase());
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json(hit.data);
    }

    const url =
      "https://nominatim.openstreetmap.org/search" +
      `?format=jsonv2&limit=5&addressdetails=1&accept-language=it` +
      `&q=${encodeURIComponent(q)}`;

    const r = await fetch(url, {
      headers: {
        // IMPORTANTISSIMO per Nominatim: serve un UA “reale”
        "User-Agent": "Jamo/1.0 (Vercel) - geocoding",
        "Accept": "application/json",
      },
    });

    if (!r.ok) {
      const data = { ok: false, error: `Geocode upstream error (${r.status})` };
      cache.set(q.toLowerCase(), { ts: now(), data });
      return res.status(200).json(data);
    }

    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) {
      const data = { ok: false, error: "Nessun risultato trovato" };
      cache.set(q.toLowerCase(), { ts: now(), data });
      return res.status(200).json(data);
    }

    // pick best:
    // - se ci sono risultati in Italia, preferiscili (ma non obbligatorio)
    const it = arr.find(x => (x.address?.country_code || "").toLowerCase() === "it");
    const best = it || arr[0];

    const lat = Number(best.lat);
    const lon = Number(best.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const data = { ok: false, error: "Risultato senza coordinate valide" };
      cache.set(q.toLowerCase(), { ts: now(), data });
      return res.status(200).json(data);
    }

    const result = {
      label: shortLabelFromDisplayName(best.display_name),
      lat,
      lon,
    };

    const candidates = arr.slice(0, 5).map(x => ({
      label: shortLabelFromDisplayName(x.display_name),
      lat: Number(x.lat),
      lon: Number(x.lon),
      country_code: (x.address?.country_code || "").toUpperCase(),
    })).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon));

    const data = { ok: true, result, candidates };
    cache.set(q.toLowerCase(), { ts: now(), data });

    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}
