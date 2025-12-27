module.exports = (req, res) => {
  const k = process.env.ORS_API_KEY || "";
  res.status(200).json({
    hasKey: !!k,
    keyLength: k.length,
    project: process.env.VERCEL_PROJECT_NAME || null,
    env: process.env.VERCEL_ENV || null
  });
};
