export default async function handler(req, res) {
  const key = process.env.ORS_API_KEY;

  // se qui torna false, Vercel NON sta leggendo la key
  res.status(200).json({
    ok: true,
    hasKey: Boolean(key),
    keyStartsWith: key ? key.slice(0, 6) + "..." : null,
  });
}
