// scripts/build_region_category.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGION_ID = String(process.env.REGION_ID || "").trim();
const CATEGORY = String(process.env.CATEGORY || "").trim().toLowerCase();

if (!REGION_ID) throw new Error("Missing env REGION_ID (e.g. it-veneto)");

const CATEGORIES = [
  "relax",
  "borghi",
  "cantine",
  "mare",
  "natura",
  "panorami",
  "trekking",
  "family",
  "storia",
  "montagna",
  "citta",
];

if (!CATEGORIES.includes(CATEGORY)) {
  throw new Error(`Missing/invalid env CATEGORY (${CATEGORIES.join("|")})`);
}

const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));
const region = (cfg.regions || []).find((r) => String(r.id) === REGION_ID);
if (!region) throw new Error(`Region not found in configs: ${REGION_ID}`);

const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", `${REGION_ID}-${CATEGORY}.json`);
const CURATED_BORGHI_BY_REGION = {
  "it-piemonte": [
    { name: "Orta San Giulio", lat: 45.7976, lon: 8.4147 },
    { name: "Ricetto di Candelo", lat: 45.5467, lon: 8.1073 },
    { name: "Neive", lat: 44.7246, lon: 8.1164 },
    { name: "Barolo", lat: 44.6109, lon: 7.9427 },
    { name: "La Morra", lat: 44.6387, lon: 7.9306 },
    { name: "Monforte d'Alba", lat: 44.5829, lon: 7.9671 },
    { name: "Serralunga d'Alba", lat: 44.6101, lon: 8.0003 },
    { name: "Vogogna", lat: 46.0101, lon: 8.2932 },
    { name: "Mombaldone", lat: 44.5706, lon: 8.3336 },
    { name: "Usseaux", lat: 45.0483, lon: 7.0276 },
    { name: "Chianale", lat: 44.6527, lon: 6.9967 },
    { name: "Saluzzo", lat: 44.6454, lon: 7.4931 }
  ],

  "it-valle-d-aosta": [
    { name: "Bard", lat: 45.6096, lon: 7.7454 },
    { name: "Étroubles", lat: 45.8198, lon: 7.2305 },
    { name: "Saint-Rhémy-en-Bosses", lat: 45.8357, lon: 7.1828 },
    { name: "Verrès", lat: 45.6668, lon: 7.6890 },
    { name: "Fénis", lat: 45.7358, lon: 7.4968 },
    { name: "Arnad", lat: 45.6431, lon: 7.7217 },
    { name: "Introd", lat: 45.6927, lon: 7.1837 },
    { name: "Avise", lat: 45.7083, lon: 7.1407 }
  ],

  "it-lombardia": [
    { name: "Bellagio", lat: 45.9875, lon: 9.2616 },
    { name: "Varenna", lat: 46.0101, lon: 9.2837 },
    { name: "Tremezzo", lat: 45.9846, lon: 9.2186 },
    { name: "Borghetto sul Mincio", lat: 45.3536, lon: 10.7364 },
    { name: "Castellaro Lagusello", lat: 45.3661, lon: 10.6648 },
    { name: "Sabbioneta", lat: 44.9976, lon: 10.4886 },
    { name: "Bienno", lat: 45.9357, lon: 10.2953 },
    { name: "Lovere", lat: 45.8114, lon: 10.0698 },
    { name: "Monte Isola", lat: 45.7172, lon: 10.0816 },
    { name: "Soncino", lat: 45.4007, lon: 9.8697 },
    { name: "Grazie di Curtatone", lat: 45.1552, lon: 10.6934 },
    { name: "Morimondo", lat: 45.3543, lon: 8.9561 }
  ],

  "it-trentino-alto-adige": [
    { name: "Canale di Tenno", lat: 45.9388, lon: 10.8154 },
    { name: "Rango", lat: 46.0021, lon: 10.8656 },
    { name: "San Lorenzo in Banale", lat: 46.0757, lon: 10.9072 },
    { name: "Mezzano", lat: 46.1558, lon: 11.8074 },
    { name: "Vigo di Fassa", lat: 46.4201, lon: 11.6746 },
    { name: "Glorenza", lat: 46.6715, lon: 10.5566 },
    { name: "Chiusa", lat: 46.6403, lon: 11.5651 },
    { name: "Castelrotto", lat: 46.5666, lon: 11.5601 },
    { name: "Egna", lat: 46.3172, lon: 11.2725 },
    { name: "Vipiteno", lat: 46.8936, lon: 11.4307 }
  ],

  "it-veneto": [
    { name: "Sirmione", lat: 45.4924, lon: 10.6099 },
    { name: "Soave", lat: 45.4208, lon: 11.2453 },
    { name: "Malcesine", lat: 45.7622, lon: 10.8086 },
    { name: "Lazise", lat: 45.5057, lon: 10.7325 },
    { name: "Asolo", lat: 45.7998, lon: 11.9148 },
    { name: "Marostica", lat: 45.7463, lon: 11.6558 },
    { name: "Montagnana", lat: 45.2329, lon: 11.4636 },
    { name: "Cison di Valmarino", lat: 45.9696, lon: 12.1429 },
    { name: "Borghetto", lat: 45.3536, lon: 10.7364 },
    { name: "Castellaro Lagusello", lat: 45.3661, lon: 10.6648 },
    { name: "Arquà Petrarca", lat: 45.2672, lon: 11.7186 },
    { name: "Burano", lat: 45.4859, lon: 12.4167 },
    { name: "Cittadella", lat: 45.6488, lon: 11.7836 },
    { name: "Peschiera del Garda", lat: 45.4389, lon: 10.6920 }
  ],

  "it-friuli-venezia-giulia": [
    { name: "Venzone", lat: 46.3337, lon: 13.1397 },
    { name: "Cividale del Friuli", lat: 46.0919, lon: 13.4322 },
    { name: "Palmanova", lat: 45.9064, lon: 13.3097 },
    { name: "Gradisca d'Isonzo", lat: 45.8909, lon: 13.5012 },
    { name: "Sesto al Reghena", lat: 45.8495, lon: 12.8128 },
    { name: "Clauiano", lat: 45.8754, lon: 13.3304 },
    { name: "Toppo", lat: 46.1892, lon: 12.8136 },
    { name: "Fagagna", lat: 46.1137, lon: 13.0849 },
    { name: "Valvasone", lat: 45.9961, lon: 12.8644 },
    { name: "Cordovado", lat: 45.8452, lon: 12.8815 },
    { name: "Muggia", lat: 45.6048, lon: 13.7675 }
  ],

  "it-liguria": [
    { name: "Tellaro", lat: 44.0569, lon: 9.9304 },
    { name: "Finalborgo", lat: 44.1760, lon: 8.3284 },
    { name: "Apricale", lat: 43.8804, lon: 7.6604 },
    { name: "Dolceacqua", lat: 43.8515, lon: 7.6231 },
    { name: "Cervo", lat: 43.9259, lon: 8.1158 },
    { name: "Noli", lat: 44.2061, lon: 8.4145 },
    { name: "Vernazza", lat: 44.1350, lon: 9.6840 },
    { name: "Manarola", lat: 44.1075, lon: 9.7280 },
    { name: "Portovenere", lat: 44.0508, lon: 9.8346 },
    { name: "Triora", lat: 43.9952, lon: 7.7632 },
    { name: "Varese Ligure", lat: 44.3765, lon: 9.5922 },
    { name: "Bussana Vecchia", lat: 43.8376, lon: 7.8289 }
  ],

  "it-emilia-romagna": [
    { name: "Brisighella", lat: 44.2218, lon: 11.7692 },
    { name: "Dozza", lat: 44.3597, lon: 11.6295 },
    { name: "Castell'Arquato", lat: 44.8523, lon: 9.8694 },
    { name: "Vigoleno", lat: 44.8166, lon: 9.8983 },
    { name: "Bobbio", lat: 44.7698, lon: 9.3867 },
    { name: "Grazzano Visconti", lat: 44.9349, lon: 9.6745 },
    { name: "San Leo", lat: 43.8967, lon: 12.3436 },
    { name: "Santarcangelo di Romagna", lat: 44.0634, lon: 12.4463 },
    { name: "Montegridolfo", lat: 43.8587, lon: 12.6898 },
    { name: "Bertinoro", lat: 44.1484, lon: 12.1340 },
    { name: "Compiano", lat: 44.4967, lon: 9.6622 },
    { name: "Castelvetro di Modena", lat: 44.5048, lon: 10.9430 },
    { name: "Longiano", lat: 44.0748, lon: 12.3278 },
    { name: "Verucchio", lat: 43.9842, lon: 12.4217 }
  ],

  "it-toscana": [
    { name: "San Gimignano", lat: 43.4678, lon: 11.0432 },
    { name: "Monteriggioni", lat: 43.3896, lon: 11.2235 },
    { name: "Volterra", lat: 43.4017, lon: 10.8615 },
    { name: "Pienza", lat: 43.0776, lon: 11.6794 },
    { name: "Pitigliano", lat: 42.6346, lon: 11.6694 },
    { name: "Montepulciano", lat: 43.0987, lon: 11.7871 },
    { name: "Montalcino", lat: 43.0561, lon: 11.4893 },
    { name: "Anghiari", lat: 43.5414, lon: 12.0565 },
    { name: "Cortona", lat: 43.2745, lon: 11.9850 },
    { name: "Suvereto", lat: 43.0789, lon: 10.6785 },
    { name: "Buonconvento", lat: 43.1382, lon: 11.4821 },
    { name: "Radicofani", lat: 42.8965, lon: 11.7697 },
    { name: "Castiglione d'Orcia", lat: 43.0071, lon: 11.6155 },
    { name: "Barga", lat: 44.0739, lon: 10.4843 },
    { name: "Certaldo", lat: 43.5475, lon: 11.0396 },
    { name: "Poppi", lat: 43.7238, lon: 11.7657 },
    { name: "Lucignano", lat: 43.2740, lon: 11.7444 },
    { name: "Radda in Chianti", lat: 43.4871, lon: 11.3747 },
    { name: "Castellina in Chianti", lat: 43.4692, lon: 11.2873 },
    { name: "Casale Marittimo", lat: 43.2971, lon: 10.6153 },
    { name: "Bolgheri", lat: 43.2341, lon: 10.6170 },
    { name: "Capalbio", lat: 42.4536, lon: 11.4213 }
  ],

  "it-umbria": [
    { name: "Assisi", lat: 43.0707, lon: 12.6177 },
    { name: "Spello", lat: 42.9905, lon: 12.6718 },
    { name: "Bevagna", lat: 42.9378, lon: 12.6093 },
    { name: "Montefalco", lat: 42.8929, lon: 12.6504 },
    { name: "Spoleto", lat: 42.7340, lon: 12.7384 },
    { name: "Todi", lat: 42.7828, lon: 12.4066 },
    { name: "Narni", lat: 42.5173, lon: 12.5158 },
    { name: "Trevi", lat: 42.8765, lon: 12.7495 },
    { name: "Rasiglia", lat: 43.0256, lon: 12.8631 },
    { name: "Castiglione del Lago", lat: 43.1275, lon: 12.0474 },
    { name: "Panicale", lat: 43.0289, lon: 12.0998 },
    { name: "Montone", lat: 43.3617, lon: 12.3269 },
    { name: "Corciano", lat: 43.1287, lon: 12.2860 },
    { name: "Bettona", lat: 43.0115, lon: 12.4851 },
    { name: "Deruta", lat: 42.9846, lon: 12.4181 }
  ],

  "it-marche": [
    { name: "Gradara", lat: 43.9399, lon: 12.7584 },
    { name: "Corinaldo", lat: 43.6486, lon: 13.0468 },
    { name: "Offagna", lat: 43.5278, lon: 13.4408 },
    { name: "Torre di Palme", lat: 43.1575, lon: 13.7927 },
    { name: "Sarnano", lat: 43.0340, lon: 13.2990 },
    { name: "Ripatransone", lat: 43.0007, lon: 13.7628 },
    { name: "Grottammare Alta", lat: 42.9880, lon: 13.8686 },
    { name: "Mondavio", lat: 43.6726, lon: 12.9694 },
    { name: "Moresco", lat: 43.0856, lon: 13.7277 },
    { name: "Cingoli", lat: 43.3746, lon: 13.2178 },
    { name: "Frontino", lat: 43.7644, lon: 12.3778 },
    { name: "Montefiore dell'Aso", lat: 43.0514, lon: 13.7515 },
    { name: "San Ginesio", lat: 43.1080, lon: 13.3145 },
    { name: "Fiorenzuola di Focara", lat: 43.9470, lon: 12.8227 },
    { name: "Castel Trosino", lat: 42.8430, lon: 13.6105 },
    { name: "Recanati", lat: 43.4038, lon: 13.5537 },
    { name: "Urbino", lat: 43.7262, lon: 12.6363 },
    { name: "Arquata del Tronto", lat: 42.7725, lon: 13.2966 }
  ],

  "it-lazio": [
    { name: "Civita di Bagnoregio", lat: 42.6277, lon: 12.1136 },
    { name: "Calcata", lat: 42.2195, lon: 12.4262 },
    { name: "Sermoneta", lat: 41.5496, lon: 12.9845 },
    { name: "Subiaco", lat: 41.9269, lon: 13.0893 },
    { name: "Castel Gandolfo", lat: 41.7466, lon: 12.6505 },
    { name: "Nemi", lat: 41.7211, lon: 12.7178 },
    { name: "Greccio", lat: 42.4481, lon: 12.7518 },
    { name: "Bolsena", lat: 42.6444, lon: 11.9855 },
    { name: "Caprarola", lat: 42.3263, lon: 12.2384 },
    { name: "Sperlonga", lat: 41.2589, lon: 13.4344 },
    { name: "Gaeta", lat: 41.2141, lon: 13.5708 },
    { name: "Anagni", lat: 41.7435, lon: 13.1554 },
    { name: "Arpino", lat: 41.6474, lon: 13.6112 },
    { name: "Fumone", lat: 41.7273, lon: 13.2724 },
    { name: "Tuscania", lat: 42.4203, lon: 11.8746 },
    { name: "Vitorchiano", lat: 42.4659, lon: 12.1747 }
  ],

  "it-abruzzo": [
    { name: "Scanno", lat: 41.9038608, lon: 13.880213 },
    { name: "Pescocostanzo", lat: 41.88633, lon: 14.065612 },
    { name: "Pacentro", lat: 42.0499635, lon: 13.9910727 },
    { name: "Barrea", lat: 41.7584905, lon: 13.9907295 },
    { name: "Villetta Barrea", lat: 41.775827, lon: 13.938511 },
    { name: "Opi", lat: 41.7808732, lon: 13.8295241 },
    { name: "Navelli", lat: 42.2378643, lon: 13.729027 },
    { name: "Castelvecchio Calvisio", lat: 42.3106488, lon: 13.6886152 },
    { name: "Rocca Calascio", lat: 42.3280296, lon: 13.6907679 },
    { name: "Santo Stefano di Sessanio", lat: 42.343, lon: 13.644 },
    { name: "Civitella del Tronto", lat: 42.7717, lon: 13.6651 },
    { name: "Guardiagrele", lat: 42.1918, lon: 14.2195 },
    { name: "Tagliacozzo", lat: 42.0695, lon: 13.2542 },
    { name: "Pescasseroli", lat: 41.8087, lon: 13.7897 },
    { name: "Roccascalegna", lat: 42.0625, lon: 14.3068 },
    { name: "Atri", lat: 42.5777, lon: 13.9759 },
    { name: "Città Sant'Angelo", lat: 42.5208, lon: 14.0599 },
    { name: "Penne", lat: 42.4542, lon: 13.9274 },
    { name: "Loreto Aprutino", lat: 42.4315, lon: 13.9836 },
    { name: "Roccaraso", lat: 41.8503, lon: 14.0783 }
  ],

  "it-molise": [
    { name: "Sepino", lat: 41.4078, lon: 14.6198 },
    { name: "Fornelli", lat: 41.6067, lon: 14.1396 },
    { name: "Frosolone", lat: 41.6021, lon: 14.4460 },
    { name: "Oratino", lat: 41.5868, lon: 14.5942 },
    { name: "Ferrazzano", lat: 41.5304, lon: 14.6715 },
    { name: "Agnone", lat: 41.8106, lon: 14.3757 },
    { name: "Scapoli", lat: 41.6143, lon: 14.0595 },
    { name: "Castelpetroso", lat: 41.5619, lon: 14.3447 },
    { name: "Bagnoli del Trigno", lat: 41.7050, lon: 14.4584 },
    { name: "Venafro", lat: 41.4832, lon: 14.0479 }
  ],

  "it-campania": [
    { name: "Atrani", lat: 40.6363, lon: 14.6085 },
    { name: "Furore", lat: 40.6205, lon: 14.5499 },
    { name: "Ravello", lat: 40.6496, lon: 14.6117 },
    { name: "Cetara", lat: 40.6478, lon: 14.7009 },
    { name: "Vietri sul Mare", lat: 40.6721, lon: 14.7278 },
    { name: "Castellabate", lat: 40.2815, lon: 14.9560 },
    { name: "Acciaroli", lat: 40.1756, lon: 15.0267 },
    { name: "Sant'Agata de' Goti", lat: 41.0906, lon: 14.4994 },
    { name: "Cusano Mutri", lat: 41.3387, lon: 14.5071 },
    { name: "Zungoli", lat: 41.1245, lon: 15.2025 },
    { name: "Pietrelcina", lat: 41.1970, lon: 14.8445 },
    { name: "Padula", lat: 40.3373, lon: 15.6566 },
    { name: "Teggiano", lat: 40.3795, lon: 15.5403 },
    { name: "Conca dei Marini", lat: 40.6172, lon: 14.5735 }
  ],

  "it-puglia": [
    { name: "Alberobello", lat: 40.7864, lon: 17.2406 },
    { name: "Locorotondo", lat: 40.7561, lon: 17.3257 },
    { name: "Cisternino", lat: 40.7437, lon: 17.4253 },
    { name: "Ostuni", lat: 40.7291, lon: 17.5770 },
    { name: "Polignano a Mare", lat: 40.9954, lon: 17.2193 },
    { name: "Monopoli", lat: 40.9525, lon: 17.2986 },
    { name: "Otranto", lat: 40.1460, lon: 18.4910 },
    { name: "Specchia", lat: 39.9391, lon: 18.2970 },
    { name: "Presicce", lat: 39.8996, lon: 18.2621 },
    { name: "Vico del Gargano", lat: 41.8958, lon: 15.9569 },
    { name: "Peschici", lat: 41.9460, lon: 16.0167 },
    { name: "Vieste", lat: 41.8825, lon: 16.1764 },
    { name: "Ceglie Messapica", lat: 40.6457, lon: 17.5180 },
    { name: "Martina Franca", lat: 40.7033, lon: 17.3336 },
    { name: "Gallipoli", lat: 40.0559, lon: 17.9926 }
  ],

  "it-basilicata": [
    { name: "Castelmezzano", lat: 40.5286, lon: 16.0456 },
    { name: "Pietrapertosa", lat: 40.5181, lon: 16.0627 },
    { name: "Matera", lat: 40.6664, lon: 16.6043 },
    { name: "Craco", lat: 40.3794, lon: 16.4382 },
    { name: "Venosa", lat: 40.9635, lon: 15.8127 },
    { name: "Acerenza", lat: 40.7937, lon: 15.9376 },
    { name: "Melfi", lat: 40.9961, lon: 15.6518 },
    { name: "Maratea", lat: 39.9942, lon: 15.7188 },
    { name: "Tursi", lat: 40.2467, lon: 16.4693 },
    { name: "Aliano", lat: 40.3137, lon: 16.2298 },
    { name: "Viggianello", lat: 39.9738, lon: 16.0866 },
    { name: "Rotondella", lat: 40.1715, lon: 16.5254 }
  ],

  "it-calabria": [
    { name: "Gerace", lat: 38.2717, lon: 16.2203 },
    { name: "Scilla", lat: 38.2528, lon: 15.7180 },
    { name: "Chianalea", lat: 38.2535, lon: 15.7157 },
    { name: "Stilo", lat: 38.4758, lon: 16.4677 },
    { name: "Altomonte", lat: 39.6991, lon: 16.1297 },
    { name: "Morano Calabro", lat: 39.8419, lon: 16.1390 },
    { name: "Civita", lat: 39.8281, lon: 16.3134 },
    { name: "Rocca Imperiale", lat: 40.1105, lon: 16.5787 },
    { name: "Tropea", lat: 38.6786, lon: 15.8970 },
    { name: "Pentedattilo", lat: 37.9512, lon: 15.7586 },
    { name: "Bova", lat: 37.9964, lon: 15.9324 },
    { name: "Fiumefreddo Bruzio", lat: 39.2356, lon: 16.0706 },
    { name: "Aieta", lat: 39.9285, lon: 15.8230 },
    { name: "Santa Severina", lat: 39.1474, lon: 16.9134 }
  ],

  "it-sicilia": [
    { name: "Erice", lat: 38.0370, lon: 12.5865 },
    { name: "Castelmola", lat: 37.8586, lon: 15.2776 },
    { name: "Cefalù", lat: 38.0394, lon: 14.0229 },
    { name: "Savoca", lat: 37.9533, lon: 15.3400 },
    { name: "Forza d'Agrò", lat: 37.9156, lon: 15.3342 },
    { name: "Marzamemi", lat: 36.7416, lon: 15.1189 },
    { name: "Scicli", lat: 36.7934, lon: 14.7064 },
    { name: "Ragusa Ibla", lat: 36.9257, lon: 14.7429 },
    { name: "Modica", lat: 36.8586, lon: 14.7601 },
    { name: "Noto", lat: 36.8924, lon: 15.0698 },
    { name: "Sperlinga", lat: 37.7665, lon: 14.3506 },
    { name: "Gangi", lat: 37.7974, lon: 14.2040 },
    { name: "Petralia Soprana", lat: 37.7984, lon: 14.1078 },
    { name: "Montalbano Elicona", lat: 38.0238, lon: 15.0134 },
    { name: "Castiglione di Sicilia", lat: 37.8826, lon: 15.1201 },
    { name: "Sambuca di Sicilia", lat: 37.6516, lon: 13.1113 }
  ],

  "it-sardegna": [
    { name: "Bosa", lat: 40.2993, lon: 8.4983 },
    { name: "Castelsardo", lat: 40.9128, lon: 8.7146 },
    { name: "Carloforte", lat: 39.1450, lon: 8.3058 },
    { name: "Posada", lat: 40.6324, lon: 9.7150 },
    { name: "Atzara", lat: 39.9922, lon: 9.0765 },
    { name: "Santu Lussurgiu", lat: 40.1414, lon: 8.6553 },
    { name: "Laconi", lat: 39.8535, lon: 9.0510 },
    { name: "Sadali", lat: 39.8148, lon: 9.2730 },
    { name: "Galtellì", lat: 40.3843, lon: 9.6154 },
    { name: "Orgosolo", lat: 40.2050, lon: 9.3548 },
    { name: "Gavoi", lat: 40.1618, lon: 9.1946 },
    { name: "Tempio Pausania", lat: 40.9006, lon: 9.1040 },
    { name: "Oliena", lat: 40.2761, lon: 9.4045 },
    { name: "Cuglieri", lat: 40.1882, lon: 8.5682 }
  ]
};

const CURATED_MOUNTAINS_BY_REGION = {
  "it-abruzzo": [
    { name: "Campo Imperatore", lat: 42.4429, lon: 13.5587 },
    { name: "Gran Sasso", lat: 42.4699, lon: 13.5654 },
    { name: "Corno Grande", lat: 42.4693, lon: 13.5657 },
    { name: "Prati di Tivo", lat: 42.5067, lon: 13.5566 },
    { name: "Monte Sirente", lat: 42.2150, lon: 13.6750 },
    { name: "Monte Velino", lat: 42.1780, lon: 13.3810 },
    { name: "Passo delle Capannelle", lat: 42.4350, lon: 13.3490 },
    { name: "Majella", lat: 42.0860, lon: 14.0850 },
    { name: "Blockhaus", lat: 42.1560, lon: 14.1180 }
  ],

  "it-sicilia": [
    { name: "Etna", lat: 37.7510, lon: 14.9934 },
    { name: "Rifugio Sapienza", lat: 37.6995, lon: 14.9989 },
    { name: "Crateri Silvestri", lat: 37.6990, lon: 14.9959 },
    { name: "Piano Provenzana", lat: 37.7996, lon: 15.0417 },
    { name: "Piano Battaglia", lat: 37.8754, lon: 14.0234 },
    { name: "Pizzo Carbonara", lat: 37.8750, lon: 14.0250 },
    { name: "Madonie", lat: 37.8833, lon: 14.0167 },
    { name: "Nebrodi", lat: 37.9500, lon: 14.7000 }
  ],

  "it-veneto": [
  { name: "Monte Grappa", lat: 45.8736, lon: 11.7992 },
  { name: "Cima Grappa", lat: 45.8736, lon: 11.7992 },
  { name: "Monte Baldo", lat: 45.7280, lon: 10.8430 },
  { name: "Malcesine Monte Baldo", lat: 45.7640, lon: 10.8080 },
  { name: "Rifugio Telegrafo", lat: 45.7040, lon: 10.8530 },
  { name: "Lessinia", lat: 45.6400, lon: 11.0500 },
  { name: "Corno d'Aquilio", lat: 45.6715, lon: 10.9430 },
  { name: "Monte Pastello", lat: 45.5844, lon: 10.8664 },
  { name: "Recoaro Mille", lat: 45.7050, lon: 11.2210 },
  { name: "Piccole Dolomiti", lat: 45.7400, lon: 11.1900 },
  { name: "Monte Carega", lat: 45.7160, lon: 11.1390 },
  { name: "Altopiano di Asiago", lat: 45.8750, lon: 11.5100 },
  { name: "Monte Verena", lat: 45.9307, lon: 11.4139 },
  { name: "Monte Cengio", lat: 45.8108, lon: 11.3956 },
  { name: "Monte Ortigara", lat: 46.0074, lon: 11.5073 },
  { name: "Cansiglio", lat: 46.0670, lon: 12.4050 },
  { name: "Monte Pizzoc", lat: 46.0404, lon: 12.3471 },
  { name: "Passo Rolle", lat: 46.2960, lon: 11.7860 },
  { name: "Pale di San Martino", lat: 46.2660, lon: 11.8500 },
  { name: "Passo Giau", lat: 46.4831, lon: 12.0560 },
  { name: "Cinque Torri", lat: 46.5085, lon: 12.0488 },
  { name: "Cortina d'Ampezzo", lat: 46.5405, lon: 12.1357 },
  { name: "Monte Cristallo", lat: 46.5754, lon: 12.2005 },
  { name: "Monte Pelmo", lat: 46.4200, lon: 12.1347 },
  { name: "Monte Civetta", lat: 46.3801, lon: 12.0533 },
  { name: "Marmolada", lat: 46.4347, lon: 11.8519 },
  { name: "Tre Cime di Lavaredo", lat: 46.6187, lon: 12.3020 },
  { name: "Lago di Misurina", lat: 46.5847, lon: 12.2536 },
  { name: "Lago di Sorapis", lat: 46.5220, lon: 12.2270 }
],

  "it-trentino-alto-adige": [
    { name: "Seceda", lat: 46.5976, lon: 11.7242 },
    { name: "Alpe di Siusi", lat: 46.5410, lon: 11.6170 },
    { name: "Lago di Braies", lat: 46.6943, lon: 12.0859 },
    { name: "Passo Sella", lat: 46.5086, lon: 11.7570 },
    { name: "Val di Funes", lat: 46.6370, lon: 11.7200 },
    { name: "Catinaccio", lat: 46.4560, lon: 11.6400 },
    { name: "Madonna di Campiglio", lat: 46.2306, lon: 10.8262 }
  ],

  "it-valle-d-aosta": [
    { name: "Monte Bianco", lat: 45.8326, lon: 6.8652 },
    { name: "Courmayeur", lat: 45.7928, lon: 6.9713 },
    { name: "Cervinia", lat: 45.9340, lon: 7.6290 },
    { name: "Gran Paradiso", lat: 45.5180, lon: 7.2660 },
    { name: "Val Ferret", lat: 45.8500, lon: 7.0500 },
    { name: "Pila", lat: 45.6820, lon: 7.3120 }
  ],

  "it-piemonte": [
    { name: "Monviso", lat: 44.6675, lon: 7.0900 },
    { name: "Monte Rosa", lat: 45.9369, lon: 7.8669 },
    { name: "Macugnaga", lat: 45.9690, lon: 7.9670 },
    { name: "Alpe Devero", lat: 46.3140, lon: 8.2610 },
    { name: "Sestriere", lat: 44.9584, lon: 6.8780 },
    { name: "Bardonecchia", lat: 45.0780, lon: 6.7040 }
  ],

  "it-lombardia": [
    { name: "Passo dello Stelvio", lat: 46.5287, lon: 10.4534 },
    { name: "Livigno", lat: 46.5385, lon: 10.1356 },
    { name: "Bormio", lat: 46.4676, lon: 10.3705 },
    { name: "Piani di Bobbio", lat: 45.9590, lon: 9.4970 },
    { name: "Monte Resegone", lat: 45.8367, lon: 9.4483 },
    { name: "Grigna", lat: 45.9500, lon: 9.3833 }
  ],

  "it-friuli-venezia-giulia": [
    { name: "Monte Lussari", lat: 46.4800, lon: 13.5230 },
    { name: "Tarvisio", lat: 46.5058, lon: 13.5869 },
    { name: "Sella Nevea", lat: 46.3890, lon: 13.4750 },
    { name: "Lago del Predil", lat: 46.4200, lon: 13.5700 },
    { name: "Forni di Sopra", lat: 46.4245, lon: 12.5784 },
    { name: "Piancavallo", lat: 46.1060, lon: 12.5190 },
    { name: "Monte Zoncolan", lat: 46.5020, lon: 12.9250 },
    { name: "Dolomiti Friulane", lat: 46.3500, lon: 12.5000 }
  ],

  "it-emilia-romagna": [
    { name: "Corno alle Scale", lat: 44.1260, lon: 10.8130 },
    { name: "Monte Cimone", lat: 44.1936, lon: 10.7003 },
    { name: "Lago Santo Modenese", lat: 44.2300, lon: 10.6100 },
    { name: "Pietra di Bismantova", lat: 44.4160, lon: 10.4140 },
    { name: "Monte Fumaiolo", lat: 43.7870, lon: 12.0750 },
    { name: "Parco dei Cento Laghi", lat: 44.3900, lon: 10.1000 }
  ],

  "it-toscana": [
    { name: "Abetone", lat: 44.1445, lon: 10.6645 },
    { name: "Monte Amiata", lat: 42.8900, lon: 11.6260 },
    { name: "Alpi Apuane", lat: 44.0670, lon: 10.2500 },
    { name: "Monte Forato", lat: 44.0310, lon: 10.3210 },
    { name: "Garfagnana", lat: 44.1000, lon: 10.4000 },
    { name: "Pratomagno", lat: 43.6500, lon: 11.6500 }
  ],

  "it-marche": [
    { name: "Monte Conero", lat: 43.5500, lon: 13.6200 },
    { name: "Monte Vettore", lat: 42.8270, lon: 13.2670 },
    { name: "Monti Sibillini", lat: 42.9000, lon: 13.2500 },
    { name: "Lago di Pilato", lat: 42.8240, lon: 13.2700 },
    { name: "Gola dell'Infernaccio", lat: 42.9470, lon: 13.2580 },
    { name: "Monte Catria", lat: 43.5470, lon: 12.7160 },
    { name: "Monte Nerone", lat: 43.5660, lon: 12.5340 }
  ],

  "it-umbria": [
    { name: "Monte Subasio", lat: 43.0450, lon: 12.6500 },
    { name: "Castelluccio di Norcia", lat: 42.8280, lon: 13.2060 },
    { name: "Piano Grande", lat: 42.8200, lon: 13.2000 },
    { name: "Monte Cucco", lat: 43.3500, lon: 12.7500 },
    { name: "Valnerina", lat: 42.7500, lon: 12.9000 },
    { name: "Monti Sibillini", lat: 42.9000, lon: 13.2500 }
  ],

  "it-lazio": [
    { name: "Monte Terminillo", lat: 42.4690, lon: 12.9970 },
    { name: "Monte Livata", lat: 41.9500, lon: 13.1000 },
    { name: "Campo Staffi", lat: 41.8890, lon: 13.3230 },
    { name: "Campo Catino", lat: 41.8500, lon: 13.3500 },
    { name: "Monti Simbruini", lat: 41.9500, lon: 13.1500 },
    { name: "Monte Circeo", lat: 41.2340, lon: 13.0500 }
  ],

  "it-molise": [
    { name: "Campitello Matese", lat: 41.4600, lon: 14.3900 },
    { name: "Monte Miletto", lat: 41.4670, lon: 14.3900 },
    { name: "Capracotta", lat: 41.8330, lon: 14.2650 },
    { name: "Prato Gentile", lat: 41.8500, lon: 14.2500 },
    { name: "Monti del Matese", lat: 41.4500, lon: 14.4000 }
  ],

  "it-campania": [
    { name: "Vesuvio", lat: 40.8220, lon: 14.4280 },
    { name: "Monte Faito", lat: 40.6500, lon: 14.4500 },
    { name: "Sentiero degli Dei", lat: 40.6200, lon: 14.5400 },
    { name: "Laceno", lat: 40.8100, lon: 15.1000 },
    { name: "Monte Cervati", lat: 40.2800, lon: 15.4400 },
    { name: "Monti Lattari", lat: 40.6500, lon: 14.5200 }
  ],

  "it-puglia": [
    { name: "Foresta Umbra", lat: 41.8000, lon: 15.9830 },
    { name: "Monte Sant'Angelo", lat: 41.7050, lon: 15.9600 },
    { name: "Gargano", lat: 41.8000, lon: 15.9000 },
    { name: "Monti Dauni", lat: 41.4000, lon: 15.2000 },
    { name: "Faeto", lat: 41.3240, lon: 15.1600 }
  ],

  "it-basilicata": [
    { name: "Dolomiti Lucane", lat: 40.5250, lon: 16.0500 },
    { name: "Castelmezzano", lat: 40.5286, lon: 16.0456 },
    { name: "Pietrapertosa", lat: 40.5181, lon: 16.0627 },
    { name: "Monte Pollino", lat: 39.9160, lon: 16.1800 },
    { name: "Monte Sirino", lat: 40.1500, lon: 15.8500 },
    { name: "Parco del Pollino", lat: 39.9500, lon: 16.1000 }
  ],

  "it-calabria": [
    { name: "Sila", lat: 39.3300, lon: 16.5000 },
    { name: "Camigliatello Silano", lat: 39.3300, lon: 16.4500 },
    { name: "Lorica", lat: 39.2500, lon: 16.4800 },
    { name: "Aspromonte", lat: 38.1600, lon: 15.9400 },
    { name: "Gambarie", lat: 38.1700, lon: 15.8300 },
    { name: "Pollino", lat: 39.9160, lon: 16.1800 }
  ],

  "it-sardegna": [
    { name: "Gennargentu", lat: 40.0300, lon: 9.3200 },
    { name: "Punta La Marmora", lat: 39.9880, lon: 9.3240 },
    { name: "Supramonte", lat: 40.2200, lon: 9.5000 },
    { name: "Gola di Gorropu", lat: 40.1800, lon: 9.5150 },
    { name: "Monte Limbara", lat: 40.8500, lon: 9.1800 },
    { name: "Monte Ortobene", lat: 40.3200, lon: 9.3400 }
  ]
};

// ---------------------- UTIL ----------------------
// ---------------------- UTIL ----------------------
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function hasAny(str, arr) {
  return arr.some((k) => str.includes(k));
}
function tagEq(tags, k, v) {
  return String(tags?.[k] ?? "").toLowerCase() === String(v).toLowerCase();
}
function hasTag(tags, k) {
  return tags?.[k] != null && String(tags[k]).trim() !== "";
}
function tagsToStr(tags) {
  return Object.entries(tags || {})
    .map(([k, v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");
}

function overpassAreaSelectorByISO(iso3166_2) {
  return `area["ISO3166-2"="${iso3166_2}"]["boundary"="administrative"]->.a;`;
}

// ---------------------- GLOBAL ANTI-SPAZZATURA ----------------------
function isClearlyIrrelevant(p) {
  const t = p.tags || {};
  const ts = tagsToStr(t);
  const n = normName(p.name || "");

  // trasporti/strade
  if (hasAny(ts, ["highway=", "railway=", "public_transport=", "route=", "junction="])) return true;
  if (hasAny(ts, ["amenity=bus_station", "highway=bus_stop", "highway=platform"])) return true;

  // parking/fuel/charging
  if (
    hasAny(ts, [
      "amenity=parking",
      "amenity=parking_entrance",
      "amenity=parking_space",
      "highway=rest_area",
      "amenity=fuel",
      "amenity=charging_station",
    ])
  ) return true;

  // industrial/commercial/office
  if (
    hasAny(ts, [
      "landuse=industrial",
      "landuse=commercial",
      "building=industrial",
      "building=warehouse",
      "building=office",
      "man_made=works",
    ])
  ) return true;

  // rumore tecnico
  if (hasAny(ts, ["man_made=survey_point", "power=", "telecom=", "pipeline=", "boundary=", "place=locality"])) return true;

  // nomi spazzatura
  if (hasAny(n, ["parcheggio", "stazione", "fermata", "svincolo", "uscita", "cabina", "impianto", "linea", "tratto", "km "])) return true;

  // “SpA azienda” (ma non spa terme)
  const looksCompany = n.endsWith(" spa") || n.includes(" s p a") || n.includes(" s.p.a") || n.includes(" azienda ");
  const looksWellness = hasAny(n, ["terme", "spa", "wellness", "termale", "thermal", "benessere"]);
  if (looksCompany && !looksWellness) return true;

  return false;
}

// ---------------------- OVERPASS QUERIES (CATEGORIE UI) ----------------------
function buildQuery(category, iso3166_2) {
  const header = `[out:json][timeout:240];`;
  const area = overpassAreaSelectorByISO(iso3166_2);

  if (category === "relax") {
    return `
${header}
${area}
(
  node(area.a)["tourism"="spa"];
  way(area.a)["tourism"="spa"];
  relation(area.a)["tourism"="spa"];

  node(area.a)["amenity"="public_bath"];
  way(area.a)["amenity"="public_bath"];
  relation(area.a)["amenity"="public_bath"];

  node(area.a)["amenity"="sauna"];
  way(area.a)["amenity"="sauna"];
  relation(area.a)["amenity"="sauna"];

  node(area.a)["leisure"="spa"];
  way(area.a)["leisure"="spa"];
  relation(area.a)["leisure"="spa"];

  node(area.a)["healthcare"="spa"];
  way(area.a)["healthcare"="spa"];
  relation(area.a)["healthcare"="spa"];

  node(area.a)["natural"="hot_spring"];
  way(area.a)["natural"="hot_spring"];
  relation(area.a)["natural"="hot_spring"];
);
out center tags;
`;
  }

  if (category === "cantine") {
    return `
${header}
${area}
(
  node(area.a)["craft"="winery"];
  way(area.a)["craft"="winery"];
  relation(area.a)["craft"="winery"];

  node(area.a)["shop"="wine"];
  way(area.a)["shop"="wine"];
  relation(area.a)["shop"="wine"];

  node(area.a)["amenity"="wine_bar"];
  way(area.a)["amenity"="wine_bar"];
  relation(area.a)["amenity"="wine_bar"];
);
out center tags;
`;
  }

  if (category === "borghi") {
    // ✅ BORGHl = SOLO insediamenti veri + nuclei storici
    return `
${header}
${area}
(
  node(area.a)["place"="town"]["name"];
  node(area.a)["place"="village"]["name"];
  node(area.a)["place"="hamlet"]["name"];
  node(area.a)["place"="suburb"]["name"];

  node(area.a)["historic"="old_town"]["name"];
  way(area.a)["historic"="old_town"]["name"];
  relation(area.a)["historic"="old_town"]["name"];
);
out center tags;
`;
  }

  if (category === "mare") {
    return `
${header}
${area}
(
  node(area.a)["natural"="beach"];
  way(area.a)["natural"="beach"];
  relation(area.a)["natural"="beach"];

  node(area.a)["tourism"="beach_resort"];
  way(area.a)["tourism"="beach_resort"];
  relation(area.a)["tourism"="beach_resort"];

  node(area.a)["leisure"="marina"];
  way(area.a)["leisure"="marina"];
  relation(area.a)["leisure"="marina"];

  node(area.a)["man_made"="lighthouse"];
  way(area.a)["man_made"="lighthouse"];
  relation(area.a)["man_made"="lighthouse"];
);
out center tags;
`;
  }

  if (category === "natura") {
    return `
${header}
${area}
(
  node(area.a)["waterway"="waterfall"];
  way(area.a)["waterway"="waterfall"];
  relation(area.a)["waterway"="waterfall"];

  node(area.a)["natural"="cave_entrance"];
  way(area.a)["natural"="cave_entrance"];
  relation(area.a)["natural"="cave_entrance"];

  node(area.a)["natural"="spring"];
  way(area.a)["natural"="spring"];
  relation(area.a)["natural"="spring"];

  node(area.a)["natural"="hot_spring"];
  way(area.a)["natural"="hot_spring"];
  relation(area.a)["natural"="hot_spring"];

  relation(area.a)["boundary"="protected_area"];
  way(area.a)["leisure"="nature_reserve"];
  relation(area.a)["leisure"="nature_reserve"];
);
out center tags;
`;
  }

  if (category === "panorami") {
    return `
${header}
${area}
(
  node(area.a)["tourism"="viewpoint"];
  way(area.a)["tourism"="viewpoint"];
  relation(area.a)["tourism"="viewpoint"];

  node(area.a)["man_made"="tower"]["tourism"="attraction"];
  way(area.a)["man_made"="tower"]["tourism"="attraction"];
  relation(area.a)["man_made"="tower"]["tourism"="attraction"];

  node(area.a)["man_made"="observation_tower"];
  way(area.a)["man_made"="observation_tower"];
  relation(area.a)["man_made"="observation_tower"];
);
out center tags;
`;
  }

  if (category === "trekking") {
    return `
${header}
${area}
(
  node(area.a)["tourism"="information"]["information"="guidepost"];
  way(area.a)["tourism"="information"]["information"="guidepost"];
  relation(area.a)["tourism"="information"]["information"="guidepost"];

  node(area.a)["tourism"="information"]["information"="map"];
  node(area.a)["tourism"="information"]["information"="board"];

  node(area.a)["tourism"="alpine_hut"];
  way(area.a)["tourism"="alpine_hut"];
  relation(area.a)["tourism"="alpine_hut"];

  node(area.a)["amenity"="shelter"];
  way(area.a)["amenity"="shelter"];
  relation(area.a)["amenity"="shelter"];
);
out center tags;
`;
  }

  if (category === "family") {
    return `
${header}
${area}
(
  node(area.a)["leisure"="park"];
  way(area.a)["leisure"="park"];
  relation(area.a)["leisure"="park"];

  node(area.a)["leisure"="playground"];
  way(area.a)["leisure"="playground"];
  relation(area.a)["leisure"="playground"];

  node(area.a)["tourism"="theme_park"];
  way(area.a)["tourism"="theme_park"];
  relation(area.a)["tourism"="theme_park"];

  node(area.a)["tourism"="zoo"];
  way(area.a)["tourism"="zoo"];
  relation(area.a)["tourism"="zoo"];

  node(area.a)["tourism"="aquarium"];
  way(area.a)["tourism"="aquarium"];
  relation(area.a)["tourism"="aquarium"];
);
out center tags;
`;
  }

  if (category === "storia") {
    return `
${header}
${area}
(
  node(area.a)["historic"="castle"];
  way(area.a)["historic"="castle"];
  relation(area.a)["historic"="castle"];

  node(area.a)["historic"="ruins"];
  way(area.a)["historic"="ruins"];
  relation(area.a)["historic"="ruins"];

  node(area.a)["historic"="archaeological_site"];
  way(area.a)["historic"="archaeological_site"];
  relation(area.a)["historic"="archaeological_site"];

  node(area.a)["historic"="monument"];
  way(area.a)["historic"="monument"];
  relation(area.a)["historic"="monument"];

  node(area.a)["historic"="memorial"];
  way(area.a)["historic"="memorial"];
  relation(area.a)["historic"="memorial"];

  node(area.a)["historic"="citywalls"];
  node(area.a)["historic"="city_gate"];
  node(area.a)["historic"="fort"];
  way(area.a)["historic"="fort"];
  relation(area.a)["historic"="fort"];
);
out center tags;
`;
  }

  if (category === "montagna") {
    return `
${header}
${area}
(
  node(area.a)["natural"="peak"];
  node(area.a)["natural"="saddle"];

  node(area.a)["tourism"="alpine_hut"];
  way(area.a)["tourism"="alpine_hut"];
  relation(area.a)["tourism"="alpine_hut"];

  node(area.a)["tourism"="viewpoint"];

  node(area.a)["amenity"="shelter"];
  way(area.a)["amenity"="shelter"];
  relation(area.a)["amenity"="shelter"];
);
out center tags;
`;
  }

  // citta
  return `
${header}
${area}
(
  node(area.a)["place"="city"]["name"];
  node(area.a)["place"="town"]["name"];
  node(area.a)["place"="suburb"]["name"];

  node(area.a)["tourism"="attraction"]["name"];
  way(area.a)["tourism"="attraction"]["name"];
  relation(area.a)["tourism"="attraction"]["name"];
);
out center tags;
`;
}

// ---------------------- CATEGORY CLEANUP (rumori specifici) ----------------------

// ✅ BORGHl: se è un’attività (cantina/ristorante/hotel/negozio/ufficio) NON deve passare
function isActivityLike(tags) {
  const t = tags || {};
  const ts = tagsToStr(t);

  // segnali “azienda/attività”
  if (hasTag(t, "amenity")) return true;
  if (hasTag(t, "shop")) return true;
  if (hasTag(t, "craft")) return true;
  if (hasTag(t, "office")) return true;

  // turismo “strutture/servizi” (non nucleo abitato)
  if (hasAny(ts, ["tourism=hotel", "tourism=guest_house", "tourism=hostel", "tourism=apartment", "tourism=camp_site"])) return true;

  // casi classici: cantine
  if (hasAny(ts, ["craft=winery", "shop=wine", "amenity=wine_bar"])) return true;

  return false;
}

function isBorgoNoise(p) {
  const t = p.tags || {};
  const ts = tagsToStr(t);
  const n = normName(p.name || "");

  if (n.includes("borgo eger")) return true;

  if (
    n.startsWith("borgo ") &&
    !n.includes("borghetto")
  ) return true;

  if (
    n === "il borgo" ||
    n === "borgo" ||
    n === "paesetto"
  ) return true;

  if (n.includes("corte dei bissari")) return true;

  if (
    n === "borghetto" &&
    !String(p.id || "").startsWith("curated:")
  ) return true;
  const FAKE_BORGHI = [
  "borgo incile",
  "borgo ottomila",
  "borgo san lorenzo",
  "borgo santa maria immacolata",
  "borgo petricca",
  "borgo strada 14",
  "borgo eger",
  "lago di borgo eger",
  "borgo san marco",
  "borgo frassine",
  "borgo dei gatti",
  "borgo chiavica",
  "borgo furo",
  "borgo serragli"
];

if (FAKE_BORGHI.includes(n)) return true;
  if (n.includes("castello di godego")) return true;
if (n.includes("borgo eger")) return true;
if (n.includes("corte dei bissari")) return true;
  const FAKE_BORGO_NAMES = [
  "borgo san lorenzo",
  "borgo faraone",
  "borgo santa maria immacolata",
  "borgonovo",
  "borgo ottomila",
  "borgo incile",
  "borgo strada 14",
  "borgo di acquabella",
    "nogarole rocca",
"sopracastello",
"borgo bonavicina",
"borgo vecchio",
"borgo santa maria maddalena",
  "borgo petricca"
];
  if (
  n.includes("porta del sole") ||
  n.includes("porta ") ||
  n.includes("ingresso ") ||
  n.includes("accesso ")
) return true;

if (FAKE_BORGO_NAMES.includes(n)) return true;

  // ✅ se è un’attività => fuori (anche se qualcuno l’ha taggata place=hamlet)
  if (isActivityLike(t)) return true;
  const BAD_WORDS = [
  "borgoricco",
  "borgoforte",
  "resana",
  "favaro veneto",
  "mestrino",
  "villorba",
  "sedico",
  "piombino dese",
  "vigodarzere",
  "ponzano",
  "silea",
  "torri di quartesolo",
  "camisano vicentino",
    "occhiobello",
"conselve",
"borgo eger",
"lago di borgo eger",
  "noventa padovana",
  "noventa vicentina"
];

if (BAD_WORDS.includes(n)) return true;

  // museo/attrazione singola NON è un borgo
  if (ts.includes("tourism=museum")) return true;
  if (hasAny(n, ["museo", "galleria", "mostra", "spazio espositivo"])) return true;

  // montagna/trekking NON è borgo
  if (hasAny(n, ["monte", "cima", "passo", "rifugio", "malga"])) return true;
  if (hasAny(ts, ["natural=peak", "tourism=alpine_hut", "amenity=shelter"])) return true;

  // extra: se non è un settlement vero e non è old_town => fuori
 const place = String(t.place || "").toLowerCase();
const isSettlement = ["town", "village", "hamlet"].includes(place);
const isOldTown = tagEq(t, "historic", "old_town");

if (!isSettlement && !isOldTown) return true;
  const pop = Number(t.population || 0);

const TOWN_OK = [
  "asolo",
  "montagnana",
  "cittadella",
  "sirmione",
  "peschiera del garda"
];

if (
  place === "town" &&
  !TOWN_OK.some((x) => n.includes(normName(x)))
) return true;

if (place === "hamlet" && pop < 300) return true;

const NON_BORGHI_ABRUZZO = [
  "alba adriatica",
  "san giovanni teatino",
  "silvi marina",
  "tortoreto",
  "nereto",
  "sant egidio alla vibrata",
  "cepagatti",
  "pianella",
  "mosciano sant angelo",
  "popoli terme"
];

if (REGION_ID === "it-abruzzo" && NON_BORGHI_ABRUZZO.includes(n)) return true;

const ICONIC_BORGHI = [
  "borghetto",
  "valeggio sul mincio",
  "sirmione",
  "cittadella",
  "soave",
  "lazise",
  "malcesine",
  "marostica",
  "asolo",
  "montagnana",
  "cittadella",
  "burano",
  "arqua petrarca",
  "cison di valmarino",
  "castellaro lagusello",
  "sabbioneta"
];

const isIconic = ICONIC_BORGHI.some(x => n.includes(normName(x)));

const hasTouristProof =
  isIconic ||
  tagEq(t, "historic", "old_town") ||
  hasTag(t, "heritage") ||
  tagEq(t, "tourism", "attraction") ||
  hasAny(n, ["borgo", "centro storico", "castello", "rocca", "medievale", "medioevale", "storico"]);

if (place === "hamlet" && !hasTouristProof) return true;
  if (place === "village" && !hasTouristProof) return true;
  const GENERIC_NAMES = [
  "sant'andrea",
  "san polo",
  "sant'eufemia",
  "castelnuovo",
  "rustega",
  "roro",
  "monaro"
];

if (GENERIC_NAMES.includes(n)) return true;

if (
  place === "village" &&
  !hasTouristProof &&
  (
    n.includes("cascina") ||
    n.includes("maso") ||
    n.startsWith("case ") ||
    n.startsWith("corte ") ||
    n.startsWith("contrada ") ||
    n.startsWith("zona ") ||
    n.startsWith("regione ") ||
    n.startsWith("localita ")
  )
) return true;

return false;
}

function isCittaNoise(p) {
  const t = p.tags || {};
  const pt = String(t.place || "").toLowerCase();
  const n = normName(p.name || "");

  if (hasAny(n, ["zona industriale", "area industriale", "interporto"])) return true;
  if (pt === "locality") return true;

  return false;
}

function isRelaxNoise(p) {
  const t = p.tags || {};
  const ts = tagsToStr(t);
  const n = normName(p.name || "");

  if (
    hasAny(ts, [
      "tourism=museum",
      "tourism=gallery",
      "amenity=theatre",
      "amenity=cinema",
      "amenity=library",
      "amenity=arts_centre",
    ])
  ) return true;

  if (
    hasAny(n, [
      "museo",
      "mostra",
      "galleria",
      "spazio multimediale",
      "multimediale",
      "teatro",
      "cinema",
      "biblioteca",
      "auditorium",
      "centro culturale",
      "etnografico",
      "arte",
    ])
  ) return true;

  const strong =
    tagEq(t, "tourism", "spa") ||
    tagEq(t, "leisure", "spa") ||
    tagEq(t, "amenity", "public_bath") ||
    tagEq(t, "amenity", "sauna") ||
    tagEq(t, "healthcare", "spa") ||
    tagEq(t, "natural", "hot_spring");

  const nameStrong = hasAny(n, ["terme", "termale", "thermal", "spa", "wellness", "benessere", "bagni"]);
  if (!strong && !nameStrong) return true;

  return false;
}

// ---------------------- SCORING ----------------------
function scoreRelax(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t, "natural", "hot_spring")) s += 80;
  if (tagEq(t, "amenity", "public_bath")) s += 70;
  if (tagEq(t, "tourism", "spa")) s += 65;
  if (tagEq(t, "leisure", "spa")) s += 60;
  if (tagEq(t, "amenity", "sauna")) s += 55;

  if (String(t["bath:type"] || "").toLowerCase().includes("thermal")) s += 45;
  if (hasAny(n, ["terme", "termale", "thermal"])) s += 40;
  if (hasAny(n, ["spa", "wellness", "benessere"])) s += 20;

  if (hasTag(t, "website") || hasTag(t, "contact:website")) s += 8;
  if (hasTag(t, "opening_hours")) s += 5;
  if (hasTag(t, "phone") || hasTag(t, "contact:phone")) s += 5;

  if (n.includes("s.p.a") || n.includes("azienda")) s -= 25;
  return s;
}

function scoreCantine(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t, "craft", "winery")) s += 80;
  if (tagEq(t, "shop", "wine")) s += 55;
  if (tagEq(t, "amenity", "wine_bar")) s += 35;

  if (hasAny(n, ["cantina", "winery", "enoteca"])) s += 25;
  if (hasAny(n, ["degustaz", "tasting", "wine tour", "wine tasting"])) s += 20;

  if (hasTag(t, "website") || hasTag(t, "contact:website")) s += 8;
  if (hasTag(t, "opening_hours")) s += 5;
  return s;
}

function scoreBorghi(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  const ts = tagsToStr(t);
  let s = 0;
  if (String(t.curated || "").toLowerCase() === "true") {
  s += 1000;
}
    const ICONIC_BORGHI = [
    // Abruzzo
    "scanno",
    "pescocostanzo",
    "santo stefano di sessanio",
    "barrea",
    "villetta barrea",
    "pacentro",
    "castel del monte",
    "navelli",
    "castelvecchio calvisio",
    "rocca calascio",
    "opi",
      "civitella del tronto",
"guardiagrele",
"tagliacozzo",
"pescasseroli",
"roccaraso",
"roccascalegna",
"atri",
"citta sant angelo",
"penne",
"loreto aprutino",

    // Veneto
    "sirmione",
    "soave",
    "malcesine",
    "lazise",
    "asolo",
    "marostica",
    "montagnana",
    "cison di valmarino",
    "borghetto",
    "castellaro lagusello",

    // Toscana
    "san gimignano",
      "montepulciano",
"montalcino",
"anghiari",
"cortona",
"suvereto",
"buonconvento",
"radicofani",
"castiglione d orcia",
"barga",
"certaldo",
"poppi",
"lucignano",
"radda in chianti",
"castellina in chianti",
    "monteriggioni",
    "volterra",
    "pienza",
    "pitigliano",
    "bolgheri"
  ];

  if (ICONIC_BORGHI.some((x) => n.includes(normName(x)))) {
    s += 1500;
  }

  const place = String(t.place || "").toLowerCase();
  const pop = Number(t.population || 0);

if (pop > 20000) s -= 300;
else if (pop > 10000) s -= 150;
  else if (pop > 5000) s -= 50;
if (place === "town") s += 15;
if (place === "village") s += 55;
if (place === "hamlet") s += 25;

  if (ts.includes("historic=old_town")) s += 80;

  if (hasAny(n, ["centro storico", "paese"])) s += 30;
  if (hasTag(t, "wikipedia") || hasTag(t, "wikidata")) s += 12;
  if (hasTag(t, "heritage")) s += 25;
if (hasTag(t, "historic")) s += 25;
  if (hasTag(t, "website") || hasTag(t, "contact:website")) s += 6;

  // bonus: confini amministrativi = più “paese vero”
  if (hasAny(ts, ["admin_level=8", "admin_level=9", "admin_level=10"])) s += 6;

  return s;
}

function scoreMare(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t, "natural", "beach")) s += 80;
  if (tagEq(t, "tourism", "beach_resort")) s += 60;
  if (tagEq(t, "leisure", "marina")) s += 45;
  if (tagEq(t, "man_made", "lighthouse")) s += 35;

  if (hasAny(n, ["spiaggia", "lido", "mare", "baia", "cala"])) s += 20;
  if (hasTag(t, "wikipedia") || hasTag(t, "wikidata")) s += 10;
  if (hasTag(t, "website") || hasTag(t, "contact:website")) s += 6;

  return s;
}

function scoreNatura(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t, "waterway", "waterfall")) s += 85;
  if (tagEq(t, "natural", "cave_entrance")) s += 70;
  if (tagEq(t, "natural", "spring")) s += 55;
  if (tagEq(t, "natural", "hot_spring")) s += 75;
  if (tagEq(t, "boundary", "protected_area")) s += 45;
  if (tagEq(t, "leisure", "nature_reserve")) s += 45;

  if (hasAny(n, ["cascata", "grotte", "grotta", "sorgente", "riserva", "parco", "oasi"])) s += 15;
  if (hasTag(t, "wikipedia") || hasTag(t, "wikidata")) s += 10;
  if (hasTag(t, "website") || hasTag(t, "contact:website")) s += 6;

  return s;
}

function scorePanorami(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t, "tourism", "viewpoint")) s += 85;
  if (tagEq(t, "man_made", "observation_tower")) s += 70;
  if (tagEq(t, "man_made", "tower")) s += 45;

  if (hasAny(n, ["belvedere", "panorama", "vedetta", "viewpoint"])) s += 15;
  if (hasTag(t, "wikipedia") || hasTag(t, "wikidata")) s += 10;

  return s;
}

function scoreTrekking(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t, "tourism", "alpine_hut")) s += 80;
  if (tagEq(t, "amenity", "shelter")) s += 60;
  if (tagEq(t, "tourism", "information") && String(t.information || "").toLowerCase() === "guidepost") s += 65;
  if (tagEq(t, "tourism", "information") && hasAny(String(t.information || "").toLowerCase(), ["map", "board"])) s += 40;

  if (hasAny(n, ["sentiero", "trek", "trekking", "escurs", "rifugio"])) s += 15;
  if (hasTag(t, "wikipedia") || hasTag(t, "wikidata")) s += 8;

  return s;
}

function scoreFamily(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t, "leisure", "playground")) s += 80;
  if (tagEq(t, "leisure", "park")) s += 55;
  if (tagEq(t, "tourism", "theme_park")) s += 85;
  if (tagEq(t, "tourism", "zoo")) s += 75;
  if (tagEq(t, "tourism", "aquarium")) s += 75;

  if (hasAny(n, ["parco", "giochi", "playground", "zoo", "acquario"])) s += 10;
  if (hasTag(t, "website") || hasTag(t, "contact:website")) s += 6;
  if (hasTag(t, "opening_hours")) s += 5;

  return s;
}

function scoreStoria(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t, "historic", "castle")) s += 90;
  if (tagEq(t, "historic", "archaeological_site")) s += 85;
  if (tagEq(t, "historic", "ruins")) s += 70;
  if (tagEq(t, "historic", "fort")) s += 75;
  if (tagEq(t, "historic", "monument")) s += 60;
  if (tagEq(t, "historic", "memorial")) s += 45;
  if (tagEq(t, "historic", "citywalls")) s += 55;
  if (tagEq(t, "historic", "city_gate")) s += 55;

  if (hasAny(n, ["castello", "rocca", "forte", "mura", "porta", "anfiteatro", "sito archeologico"])) s += 15;
  if (hasTag(t, "wikipedia") || hasTag(t, "wikidata")) s += 12;
  if (hasTag(t, "website") || hasTag(t, "contact:website")) s += 6;

  return s;
}

function scoreMontagna(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;
    if (String(t.curated || "").toLowerCase() === "true") {
    s += 3000;
  }

  if (tagEq(t, "natural", "peak")) s += 80;
  if (tagEq(t, "tourism", "alpine_hut")) s += 75;
  if (tagEq(t, "amenity", "shelter")) s += 55;
  if (tagEq(t, "tourism", "viewpoint")) s += 45;
  if (tagEq(t, "natural", "saddle")) s += 35;

  if (hasAny(n, ["monte", "cima", "vetta", "passo", "rifugio", "malga"])) s += 15;
  if (hasTag(t, "wikipedia") || hasTag(t, "wikidata")) s += 10;

  return s;
}

function scoreCitta(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  const pt = String(t.place || "").toLowerCase().trim();
  let s = 0;

  if (pt === "city") s += 85;
  else if (pt === "town") s += 70;
  else if (pt === "suburb") s += 35;

  if (hasAny(n, ["centro", "downtown", "city"])) s += 6;
  if (hasTag(t, "wikipedia") || hasTag(t, "wikidata")) s += 10;
  if (hasTag(t, "website") || hasTag(t, "contact:website")) s += 6;

  const isAttraction = String(t.tourism || "").toLowerCase() === "attraction";
  if (isAttraction && !pt) s -= 10;

  return s;
}

function computeScore(category, p) {
  if (category === "relax") return scoreRelax(p);
  if (category === "cantine") return scoreCantine(p);
  if (category === "borghi") return scoreBorghi(p);
  if (category === "mare") return scoreMare(p);
  if (category === "natura") return scoreNatura(p);
  if (category === "panorami") return scorePanorami(p);
  if (category === "trekking") return scoreTrekking(p);
  if (category === "family") return scoreFamily(p);
  if (category === "storia") return scoreStoria(p);
  if (category === "montagna") return scoreMontagna(p);
  return scoreCitta(p);
}

function visibilityFromScore(score, category) {
  const map = {
    borghi: 70,
    relax: 60,
    cantine: 60,
    mare: 65,
    natura: 65,
    panorami: 70,
    trekking: 65,
    family: 65,
    storia: 70,
    montagna: 65,
    citta: 70,
  };
  const cut = map[category] ?? 65;
  return score >= cut ? "chicca" : "classica";
}

// ---------------------- MAIN ----------------------
async function main() {
  console.log(`[BUILD] ${REGION_ID} • ${CATEGORY} • iso=${region.iso3166_2}`);

  let data;
  try {
    const q = buildQuery(CATEGORY, region.iso3166_2);
    data = await overpass(q, { retries: 9, timeoutMs: 180000 });
  } catch (e) {
    console.error("⚠️ Overpass failed.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Keeping previous dataset (existing file found).");
      return;
    }
    throw e;
  }

  const raw = (data.elements || [])
    .map(toPlace)
    .filter((p) => p && p.lat != null && p.lon != null)
    .filter((p) => (p.name || "").trim() && (p.name || "").trim() !== "(senza nome)")
    .filter((p) => !isClearlyIrrelevant(p));

  let cleaned = raw;

  if (CATEGORY === "relax") cleaned = raw.filter((p) => !isRelaxNoise(p));
  if (CATEGORY === "borghi") cleaned = raw.filter((p) => !isBorgoNoise(p));
  if (CATEGORY === "citta") cleaned = raw.filter((p) => !isCittaNoise(p));
  if (CATEGORY === "borghi") {
  const curated = CURATED_BORGHI_BY_REGION[REGION_ID] || [];

  cleaned = [
    ...cleaned,
    ...curated.map((p) => ({
      id: `curated:borgo:${normName(p.name).replace(/\s+/g, "-")}`,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      tags: {
        name: p.name,
        place: "village",
        tourism: "attraction",
        historic: "old_town",
        curated: "true"
      }
    }))
  ];
}
if (CATEGORY === "montagna") {
  const curated = CURATED_MOUNTAINS_BY_REGION[REGION_ID] || [];

  if (curated.length) {
    cleaned = curated.map((p) => ({
      id: `curated:mountain:${normName(p.name).replace(/\s+/g, "-")}`,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      tags: {
        name: p.name,
        natural: "peak",
        tourism: "attraction",
        curated: "true"
      }
    }));
  }
}

  // dedupe: nome + coordinate
  const seen = new Set();
  const deduped = [];
  for (const p of cleaned) {
    const key = `${normName(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map((p) => {
      const score = computeScore(CATEGORY, p);
      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: CATEGORY,
        visibility: visibilityFromScore(score, CATEGORY),
        tags: Object.entries(p.tags || {}).slice(0, 70).map(([k, v]) => `${k}=${v}`),
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12000);

  await writeJson(OUT, {
    region_id: `${REGION_ID}-${CATEGORY}`,
    label_it: `${region.name} • ${CATEGORY}`,
    generated_at: new Date().toISOString(),
    places,
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
