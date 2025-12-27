// /api/overpass.js
// Proxy + cache per Overpass (più veloce e stabile da mobile)

export default async function handler(req, res) {
  // CORS (così funziona anche se apri il sito ovunque)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing query" });
    }

    const endpoints = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter"
    ];

    // Cache Vercel (CDN): 10 minuti “fresh”, poi può servire stale mentre aggiorna
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");

    let lastErr = null;

    for (const url of endpoints) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "data=" + encodeURIComponent(query),
        });

        if (!r.ok) {
          lastErr = `Overpass ${url} status ${r.status}`;
          continue;
        }

        const data = await r.json();
        return res.status(200).json(data);
      } catch (e) {
        lastErr = String(e);
      }
    }

    return res.status(502).json({ error: "Overpass failed", details: lastErr });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
