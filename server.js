import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import health from "./api/health.js";
import geocode from "./api/geocode.js";
import suggest from "./api/suggest.js";
import plan from "./api/plan.js";
import places from "./api/places.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Frontend statico
app.use(express.static(path.join(__dirname, "public")));

// Espone i JSON curated al browser
app.use("/data", express.static(path.join(__dirname, "data")));

// API
app.get("/api/health", health);
app.get("/api/geocode", geocode);
app.get("/api/suggest", suggest);
app.post("/api/plan", plan);
app.get("/api/places", places);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jamo running on http://localhost:${PORT}`));
