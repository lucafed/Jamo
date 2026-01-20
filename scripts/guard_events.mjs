import fs from "fs";

const p = "public/data/events/events_all.json";

if (!fs.existsSync(p)) {
  console.error("❌ events_all.json missing");
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(p, "utf8"));
const count = Number(j.count || 0);

console.log("events_all.json:", {
  updated_at: j.updated_at,
  count
});

if (!count) {
  console.error("❌ Dataset empty, aborting commit");
  process.exit(1);
}

console.log("✅ Dataset OK");
