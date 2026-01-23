import fs from "fs";
import path from "path";

const OUT = "public/data/mai_fatto/mai_fatto_it_abruzzo.json";

const ideas = [];
let id = 1;

function add(o){
  ideas.push({
    id: `mf_ab_${String(id++).padStart(5,"0")}`,
    country_code: "IT",
    region: "Abruzzo",
    repeatable: true,
    source: "mai_fatto_abruzzo_v2",
    info_url: "",
    ...o
  });
}

/* ===== NATURA / WOW ===== */
add({
  title: "Gole segrete del Tirino",
  place: "Fiume Tirino",
  city: "Capestrano",
  lat: 42.267,
  lon: 13.774,
  category: "natura",
  duration_bucket: "2h",
  duration_min: 120,
  wow_score: 88,
  why: "Acqua limpidissima e silenzio totale: sembra lontano dal mondo, ma è a un’ora scarsa."
});

/* ===== TRAMONTO ===== */
add({
  title: "Tramonto sul Gran Sasso da Campo Imperatore basso",
  place: "Campo Imperatore",
  city: "L'Aquila",
  lat: 42.448,
  lon: 13.602,
  category: "tramonto",
  duration_bucket: "1h",
  duration_min: 75,
  wow_score: 84,
  why: "Qui la luce si spegne lenta, senza folla e senza baracconi."
});

/* ===== FAMILY ===== */
add({
  title: "Parco avventura naturale sul Tirino",
  place: "Area fluviale Tirino",
  city: "Bussi",
  lat: 42.205,
  lon: 13.844,
  category: "family",
  duration_bucket: "2h",
  duration_min: 140,
  wow_score: 80,
  why: "Spazio vero, acqua, natura: i bambini si muovono liberi senza attrazioni finte."
});

/* ===== BICI ===== */
add({
  title: "Ciclabile nascosta del Tirino",
  place: "Valle del Tirino",
  city: "Capestrano",
  lat: 42.261,
  lon: 13.770,
  category: "bici",
  duration_bucket: "2h",
  duration_min: 130,
  wow_score: 86,
  why: "Pianeggiante, fresca e fuori dai circuiti classici."
});

/* ===== MOTO ===== */
add({
  title: "Strada dimenticata verso Rocca Calascio",
  place: "SP7",
  city: "Calascio",
  lat: 42.325,
  lon: 13.689,
  category: "moto",
  duration_bucket: "2h",
  duration_min: 150,
  wow_score: 90,
  why: "Curve pulite, panorama aperto, zero traffico turistico."
});

/* ===== FOOD ===== */
add({
  title: "Trattoria di montagna fuori rotta",
  place: "Frazione montana",
  city: "Navelli",
  lat: 42.235,
  lon: 13.727,
  category: "food",
  duration_bucket: "1h",
  duration_min: 90,
  wow_score: 78,
  why: "Cucina vera abruzzese, senza menu turistici."
});

/* ===== RELAX ===== */
add({
  title: "Terme silenziose di Popoli",
  place: "Popoli Terme",
  city: "Popoli",
  lat: 42.167,
  lon: 13.833,
  category: "relax",
  duration_bucket: "1h",
  duration_min: 80,
  wow_score: 76,
  why: "Pace vera, senza dover organizzare nulla."
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify({
    updated_at: new Date().toISOString(),
    count: ideas.length,
    area: "Abruzzo — Mai fatto (curato)",
    ideas
  }, null, 2)
);

console.log("✅ Mai fatto Abruzzo scritto:", ideas.length);
