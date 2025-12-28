// /api/plan.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const { origin, maxMinutes, mode } = req.body || {};

    if (!origin || !maxMinutes || !mode) {
      return res.status(400).json({
        error: "Missing fields",
        needed: ["origin", "maxMinutes", "mode"]
      });
    }

    // Per ora: stub (ritorna struttura corretta)
    // Nei prossimi step: qui dentro inseriamo logica AEREO/TRENO/BUS
    return res.status(200).json({
      ok: true,
      input: { origin, maxMinutes, mode },
      results: [],
      note: "PLAN endpoint online. Next step: implement mode logic."
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
