// scripts/build_maifatto_it_abruzzo.mjs
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
// ROBUST • VERONA-STYLE • categorie COMPLETE • sempre commit

import fs from "fs";
import path from "path";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const GRID = { cols: 5, rows: 5 };
const ABRUZZO_BBOX = { w: 13.0, s: 41.65, e: 14.85, n: 42.95 };
const TARGET_IDEAS = 2600;
const SLEEP = 1200;

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "").trim();
const low = s => norm(s).toLowerCase();

function mkdirp(p){ fs.mkdirSync(p, { recursive:true }); }
function writeJSON(p,o){
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(o,null,2));
}

function center(el){
  if (el.lat && el.lon) return { lat:el.lat, lon:el.lon };
  if (el.center) return el.center;
  return null;
}

// ---------- CLASSIFY (VERONA STYLE) ----------
function classify(t){
  if (!t) return "natura";

  // FOOD
  if (
    ["restaurant","pub","cafe","bar","fast_food","ice_cream"].includes(t.amenity) ||
    ["bakery","cheese","farm_shop","deli","wine"].includes(t.shop) ||
    t.tourism === "winery"
  ) return "food";

  // FAMILY
  if (
    t.leisure === "park" ||
    t.tourism === "zoo" ||
    t.tourism === "theme_park" ||
    t.amenity === "community_centre"
  ) return "family";

  // PIOGGIA (indoor veri)
  if (
    ["museum","gallery"].includes(t.tourism) ||
    ["cinema","theatre","arts_centre","library"].includes(t.amenity)
  ) return "pioggia";

  // RELAX
  if (t.natural === "spring" || t.amenity === "spa") return "relax";

  // NATURA
  if (
    ["waterfall","cave","cave_entrance","peak","cliff"].includes(t.natural) ||
    t.waterway === "waterfall"
  ) return "natura";

  // BICI
  if (
    t.highway === "cycleway" ||
    t.route === "bicycle" ||
    t.network === "rcn"
  ) return "bici";

  // MOTO
  if (
    t.mountain_pass === "yes" ||
    t.highway === "mountain_pass"
  ) return "moto";

  // TRAMONTO
  if (t.tourism === "viewpoint") return "tramonto";

  return "natura";
}

function bucket(cat){
  if (["food","pioggia","tramonto"].includes(cat)) return "1h";
  return "2h";
}

function duration(cat){
  const r = {
    food:[50,110], pioggia:[45,90], tramonto:[60,110],
    relax:[60,120], family:[80,150],
    bici:[70,150], moto:[80,160], natura:[90,170]
  };
  const [a,b] = r[cat] || [60,120];
  return Math.round(a + Math.random()*(b-a));
}

function why(cat){
  return {
    food:"Sosta locale autentica, non il posto turistico standard.",
    family:"Posto adatto ai bambini veri, non un parco finto.",
    bici:"Percorso piacevole e scenografico, senza stress.",
    moto:"Strada o spot che vale il giro.",
    pioggia:"Ottimo piano B al coperto, interessante davvero.",
    relax:"Atmosfera tranquilla per staccare.",
    natura:"Angolo naturale poco ovvio.",
    tramonto:"Luce e panorama che cambiano tutto."
  }[cat] || "Meta poco ovvia che vale l’uscita.";
}

// ---------- OVERPASS QUERIES ----------
function qAll(b){
return `
[out:json][timeout:180];
(
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave_entrance"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="peak"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="museum"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="library"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"](${b.s},${b.w},${b.n},${b.e});
  nwr["highway"="cycleway"](${b.s},${b.w},${b.n},${b.e});
  nwr["route"="bicycle"](${b.s},${b.w},${b.n},${b.e});
  nwr["mountain_pass"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

async function fetchOverpass(q){
  for (const ep of ENDPOINTS){
    try{
      const r = await fetch(ep,{
        method:"POST",
        headers:{ "content-type":"application/x-www-form-urlencoded" },
        body:"data="+encodeURIComponent(q)
      });
      if (r.ok) return r.json();
    }catch{}
  }
  throw new Error("Overpass failed");
}

function tiles(){
  const t=[];
  const dx=(ABRUZZO_BBOX.e-ABRUZZO_BBOX.w)/GRID.cols;
  const dy=(ABRUZZO_BBOX.n-ABRUZZO_BBOX.s)/GRID.rows;
  for(let y=0;y<GRID.rows;y++)
    for(let x=0;x<GRID.cols;x++)
      t.push({
        w:ABRUZZO_BBOX.w+dx*x,
        e:ABRUZZO_BBOX.w+dx*(x+1),
        s:ABRUZZO_BBOX.s+dy*y,
        n:ABRUZZO_BBOX.s+dy*(y+1),
      });
  return t;
}

// ---------- MAIN ----------
(async()=>{
  const map=new Map();
  for (const tile of tiles()){
    const j=await fetchOverpass(qAll(tile));
    for (const el of j.elements||[]){
      if (!el.tags?.name) continue;
      const c=center(el); if(!c) continue;
      const cat=classify(el.tags);
      map.set(`${el.type}:${el.id}`,{
        id:`it_${el.type}_${el.id}`,
        title:el.tags.name,
        place:el.tags.name,
        city:"",
        region:"Abruzzo",
        country_code:"IT",
        lat:c.lat, lon:c.lon,
        category:cat,
        duration_bucket:bucket(cat),
        duration_min:duration(cat),
        why:why(cat),
        repeatable:true,
        source:"osm_overpass"
      });
    }
    await sleep(SLEEP);
  }

  const ideas=[...map.values()].slice(0,TARGET_IDEAS);

  const out={
    _build_id:"abruzzo_"+Date.now(),
    updated_at:new Date().toISOString(),
    count:ideas.length,
    area:"Abruzzo — Mai fatto (VERONA STYLE FULL)",
    ideas
  };

  const p="public/data/mai_fatto/mai_fatto_it_abruzzo.json";
  writeJSON(p,out);
  console.log("✅ WRITTEN",ideas.length);
})();
