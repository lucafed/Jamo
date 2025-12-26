const VERSION = "0.2";
const $ = (id) => document.getElementById(id);

$("ver").textContent = VERSION;

const btnTrip = $("btn");        // 🎰 DECIDI PER ME (viaggio)
const btnLocal = $("btnLocal");  // 🏠 cosa fare vicino casa
const slot = $("slot");
const meta = $("meta");

/** IDEE "VICINO CASA" (cose da fare senza meta specifica) **/
const localIdeas = [
  { text:"Passeggiata ‘a caso’ 20 minuti: scegli una direzione e non cambiare strada finché suona il timer.", time:30, mood:"chill", budget:0, place:"outdoor" },
  { text:"Vai a prenderti un caffè nel bar che non hai mai provato (anche se è a 10 minuti).", time:60, mood:"social", budget:10, place:"outdoor" },
  { text:"Allenamento lampo: 3 giri (10 squat, 10 piegamenti, 20'' plank).", time:20, mood:"active", budget:0, place:"indoor" },
  { text:"Decluttering: butta o regala 5 cose che non usi da mesi.", time:30, mood:"focus", budget:0, place:"indoor" },
  { text:"Scegli un punto panoramico vicino e vacci solo per 15 minuti (foto obbligatoria).", time:120, mood:"chill", budget:0, place:"outdoor" },
  { text:"Micro-uscita: gelato / snack + 10 minuti seduto fuori senza telefono.", time:60, mood:"chill", budget:10, place:"outdoor" },
  { text:"Serata ‘mini evento’: cerca cosa c’è stasera (cinema, mostra, live) e scegli il primo che ti ispira.", time:240, mood:"social", budget:30, place:"outdoor" }
];

/** DESTINAZIONI (luoghi) — versione base “Italia generica” **/
const destinations = [
  {
    id:"roma",
    name:"Roma",
    range:"far",
    modes:["train","bus","plane","car"],
    time:{ train:"~1–3h (dipende da dove sei)", bus:"~2–5h", plane:"~1h + trasferimenti", car:"~2–4h" },
    why:"Musei, passeggiate infinite, cibo ovunque.",
    todo:["Fontana di Trevi + Pantheon", "Trastevere al tramonto", "Fori Imperiali / Colosseo", "Gelato e passeggiata sul Tevere"],
    affiliate:{ tickets:"/go?type=city&dest=roma" }
  },
  {
    id:"firenze",
    name:"Firenze",
    range:"far",
    modes:["train","bus","car"],
    time:{ train:"~1–4h", bus:"~2–5h", car:"~2–5h" },
    why:"Arte, centro compatto, vista da Piazzale Michelangelo.",
    todo:["Duomo + centro", "Uffizi o Accademia", "Ponte Vecchio", "Piazzale Michelangelo"],
    affiliate:{ tickets:"/go?type=city&dest=firenze" }
  },
  {
    id:"napoli",
    name:"Napoli",
    range:"far",
    modes:["train","bus","plane","car"],
    time:{ train:"~1–4h", bus:"~2–6h", plane:"~1h + trasferimenti", car:"~2–5h" },
    why:"Energia pura, pizza, lungomare.",
    todo:["Spaccanapoli", "Lungomare", "Pizza ‘seria’", "Museo Archeologico"],
    affiliate:{ tickets:"/go?type=city&dest=napoli" }
  },
  {
    id:"bologna",
    name:"Bologna",
    range:"mid",
    modes:["train","bus","car"],
    time:{ train:"~1–3h", bus:"~2–4h", car:"~2–4h" },
    why:"Cibo top, portici, vibe studentesca.",
    todo:["Due Torri", "Portici + centro", "Mercato / tagliere", "San Luca (se hai energie)"],
    affiliate:{ tickets:"/go?type=city&dest=bologna" }
  },
  {
    id:"venezia",
    name:"Venezia",
    range:"far",
    modes:["train","bus","plane","car"],
    time:{ train:"~2–6h", bus:"~3–7h", plane:"~1h + trasferimenti", car:"~3–6h" },
    why:"Unica al mondo, passeggiata senza meta.",
    todo:["Rialto", "San Marco", "Bacari & cicchetti", "Isola (Murano/Burano) se hai tempo"],
    affiliate:{ tickets:"/go?type=city&dest=venezia" }
  },
  {
    id:"perugia",
    name:"Perugia",
    range:"mid",
    modes:["train","bus","car"],
    time:{ train:"~1–3h", bus:"~1–3h", car:"~1–3h" },
    why:"Centro storico, salita e vista, cioccolato.",
    todo:["Centro + corso", "Panorama", "Aperitivo", "Musei/mostre"],
    affiliate:{ tickets:"/go?type=city&dest=perugia" }
  }
];

/** Filtri: per ora semplici, senza GPS */
function readFilters(){
  // se non hai più i select nel tuo index, mettiamo default
  const timeEl = $("f_time");
  const moodEl = $("f_mood");
  const budgetEl = $("f_budget");
  const placeEl = $("f_place");

  return {
    time: timeEl ? timeEl.value : "any",
    mood: moodEl ? moodEl.value : "any",
    budget: budgetEl ? budgetEl.value : "any",
    place: placeEl ? placeEl.value : "any",
  };
}

function pickOne(list){ return list[Math.floor(Math.random()*list.length)]; }

function matchesIdea(a,f){
  if (f.time !== "any" && a.time > Number(f.time)) return false;
  if (f.mood !== "any" && a.mood !== f.mood) return false;
  if (f.budget !== "any" && a.budget > Number(f.budget)) return false;
  if (f.place !== "any" && a.place !== "any" && a.place !== f.place) return false;
  return true;
}

/** Slot animation util */
async function spinText(pool, finalText, metaText){
  btnTrip && (btnTrip.disabled = true);
  btnLocal && (btnLocal.disabled = true);

  let ticks = 18;
  for (let i=0;i<ticks;i++){
    slot.textContent = pickOne(pool).text ?? pickOne(pool).name;
    meta.textContent = "Jamo sta scegliendo…";
    navigator.vibrate?.(15);
    await new Promise(r=>setTimeout(r, 40 + i*i*6));
  }

  slot.textContent = finalText;
  meta.textContent = metaText || "";

  btnTrip && (btnTrip.disabled = false);
  btnLocal && (btnLocal.disabled = false);
}

/** 1) Cosa fare vicino casa */
async function decideLocal(){
  const f = readFilters();
  const pool = localIdeas.filter(x=>matchesIdea(x,f));
  if (!pool.length){
    slot.textContent = "Con questi filtri non trovo nulla 😅 Allenta un po’ i filtri.";
    meta.textContent = "";
    return;
  }

  const chosen = pickOne(pool);
  await spinText(
    pool.map(x=>({text:x.text})),
    chosen.text,
    `🏠 Vicino casa  •  ⏱️ ${chosen.time} min  •  💶 €${chosen.budget}`
  );
}

/** 2) Dove andare (luogo) */
async function decideWhere(){
  // Per ora scegliamo in base al tempo: se poco → mid/near, se tanto → far
  const f = readFilters();
  const t = f.time === "any" ? 240 : Number(f.time);

  let pool = destinations;
  if (t <= 60) pool = destinations.filter(d=>d.range !== "far");
  if (t >= 240) pool = destinations;

  const chosen = pickOne(pool);

  // slot show names
  await spinText(
    pool.map(d=>({text:`📍 ${d.name}`})),
    `📍 Vai a ${chosen.name}`,
    `${chosen.why}  •  🚗 ${chosen.time.car || "—"}  •  🚆 ${chosen.time.train || "—"}`
  );

  // (facoltativo) dopo 800ms mostra anche “cosa fare lì”
  setTimeout(()=>{
    meta.textContent = `Cosa fare a ${chosen.name}: ${chosen.todo.slice(0,3).join(" • ")}`;
  }, 800);
}

btnLocal?.addEventListener("click", decideLocal);
btnTrip?.addEventListener("click", decideWhere);

/** PWA install (se già lo avevi) */
let deferredPrompt = null;
const installBtn = $("installBtn");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.hidden = false;
});
installBtn?.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (installBtn) installBtn.hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(()=>{});
  });
}
