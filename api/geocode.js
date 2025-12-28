// /api/geocode.js
// Geocoding stabile: Nominatim via server (Vercel) + cache + fallback multi-request

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// Piccolo helper fetch con timeout
async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(5, Math.max(1, Number(req.query.limit || 3)));

    if (!q) return res.status(400).json({ error: "Missing q" });

    const url =
      `${NOMINATIM}?format=json&limit=${limit}` +
      `&addressdetails=1&accept-language=it&q=${encodeURIComponent(q)}`;

    // Nominatim richiede User-Agent identificabile
    const r = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Jamo/1.0 (Vercel; geocode)",
        "Accept": "application/json",
        "Accept-Language": "it",
      },
    });

    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        error: "Geocode provider error",
        status: r.status,
        details: txt.slice(0, 300),
      });
    }

    const raw = JSON.parse(txt);
    const results = (raw || []).map(x => ({
      display_name: x.display_name,
      lat: Number(x.lat),
      lon: Number(x.lon),
      type: x.type,
      class: x.class,
      importance: x.importance,
    })).filter(x => isFinite(x.lat) && isFinite(x.lon));

    // Cache forte (le coordinate di un indirizzo cambiano raramente)
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({ results });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
