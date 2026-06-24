// ╔══════════════════════════════════════════════════════════════╗
// ║   ASYSTENT — BACKEND (tryb POŁĄCZONY, Claude)                 ║
// ║                                                              ║
// ║  Co ustawić w Cloudflare:                                    ║
// ║   1. Sekrety:  ANTHROPIC_API_KEY  oraz  ADMIN_KEY            ║
// ║      (npx wrangler secret put ANTHROPIC_API_KEY  itd.)      ║
// ║   2. KV namespace podpięty pod nazwą  CONFIGS                ║
// ║      w wrangler.toml:                                        ║
// ║        [[kv_namespaces]]                                     ║
// ║        binding = "CONFIGS"                                   ║
// ║        id = "....(z dashboardu KV)...."                      ║
// ║   3. Deploy                                                  ║
// ╚══════════════════════════════════════════════════════════════╝

const MODEL       = "claude-haiku-4-5-20251001"; // tani i szybki; "claude-sonnet-4-6" = lepszy/drozszy
const MAX_TOKENS  = 500;
const MAX_HISTORY = 60;
const RATE_MAX    = 20;
const RATE_WINDOW = 60000;
const ALLOWED_ORIGINS = ["*"]; // na produkcji wpisz konkretne domeny

// ── rate limit (best-effort, w pamieci) ──
const rateMap = new Map();
function rateOk(ip){
  const now = Date.now();
  const hits = (rateMap.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (hits.length >= RATE_MAX) return false;
  hits.push(now); rateMap.set(ip, hits);
  return true;
}

// ── CORS ──
function cors(o){
  const all = ALLOWED_ORIGINS.includes("*");
  const ok  = all || ALLOWED_ORIGINS.includes(o);
  return {
    "Access-Control-Allow-Origin":  ok ? (o || "*") : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age":       "86400",
  };
}
function json(d, s, o){
  return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(o) } });
}

async function sha256(s){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── budowa instrukcji bota z danych PRYWATNYCH (serwer, nie przegladarka) ──
function buildSystemPrompt(pub, prv, staff){
  const b = (prv && prv.business) || {};
  const o = [];
  const botName = (pub && pub.botName) || "asystentem";
  const name = b.name || botName || "naszej firmy";
  o.push('Jesteś ' + botName + ' — wirtualnym asystentem firmy "' + name + '"' + (b.type ? ' (' + b.type + ')' : '') + '.');
  o.push('', 'ZASADY:');
  o.push('- Odpowiadaj po polsku, ciepło i konkretnie — maksymalnie ok. 5 zdań albo krótka lista.');
  o.push('- Opieraj się WYŁĄCZNIE na informacjach z sekcji DANE FIRMY poniżej.');
  o.push('- Nigdy nie zmyślaj cen, godzin, dostępności ani szczegółów. Jeśli czegoś nie ma w danych — powiedz wprost, że nie masz tej informacji.');
  const contact = b.phone || b.email;
  o.push('- Gdy nie znasz odpowiedzi lub sprawa wykracza poza dane — zaproponuj kontakt' + (contact ? ': ' + contact : ' z firmą') + '.');
  o.push('- Nie obiecuj rzeczy spoza oferty firmy.');
  o.push('- Gdy klient chce zarezerwować stolik/wizytę albo złożyć zamówienie: dopytaj o brakujące dane, a po ich skompletowaniu ZAPISZ je odpowiednim narzędziem (rezerwacja/zamówienie) i krótko potwierdź klientowi.');
  o.push('- Po zapisaniu rezerwacji ZAWSZE podaj klientowi jej 4-cyfrowy KOD i powiedz, że posłuży do odwołania rezerwacji.');
  o.push('- Gdy klient chce ODWOŁAĆ rezerwację: poproś o 4-cyfrowy kod, sprawdź ją narzędziem (sprawdz_rezerwacje), powtórz szczegóły i POPROŚ O POTWIERDZENIE; dopiero po wyraźnym „tak" użyj narzędzia anuluj_rezerwacje.');
  o.push('- Rezerwacje są w PRZEDZIAŁACH czasowych (domyślnie 90 minut). Informuj klienta o przedziale, np. „19:00–20:30". Jeśli klient poda inny czas trwania, przekaż go jako czas_trwania.');
  o.push('- Gdy klient pyta o wolny termin LUB gdy zapis rezerwacji zwróci BRAK miejsc — użyj sprawdz_dostepnosc i zaproponuj najbliższą wolną godzinę. Nie zapisuj rezerwacji bez wolnego stolika w danym oknie.');
  o.push('- Dzisiejsza data to ' + new Date().toISOString().slice(0,10) + '. Daty względne („dziś", „jutro", „w piątek") przeliczaj na format RRRR-MM-DD przy zapisie rezerwacji.');
  if (prv && prv.tone) { o.push('', 'STYL ROZMOWY:', prv.tone); }
  o.push('', '━━━ DANE FIRMY ━━━');
  const f = (k, v) => { if (v && String(v).trim()) o.push(k + ': ' + String(v).trim()); };
  f('Nazwa', b.name); f('Branża', b.type); f('Adres', b.address);
  f('Telefon', b.phone); f('E-mail', b.email); f('Strona', b.website); f('Godziny otwarcia', b.hours);
  const blk = (t, v) => { if (v && String(v).trim()) o.push('', t, String(v).trim()); };
  blk('O firmie:', b.about);
  blk('Oferta / produkty / usługi / cennik:', b.offer);
  blk('Częste pytania:', b.faq);
  blk('Dodatkowe informacje:', b.extra);
  if (staff) {
    const un = (staff.dishes || []).filter(d => d && d.available === false && d.name).map(d => d.name);
    if (un.length) o.push('', '⚠ CHWILOWO NIEDOSTĘPNE DZIŚ (nie proponuj tych pozycji; jeśli ktoś o nie zapyta — powiedz, że dziś niedostępne): ' + un.join(', '));
    if (staff.traffic === 'high') o.push('', 'UWAGA: obecnie DUŻY ruch w lokalu. Uprzedzaj o możliwym dłuższym czasie oczekiwania i — jeśli to lokal gastronomiczny — sugeruj rezerwację lub późniejszą godzinę.');
    else if (staff.traffic === 'low') o.push('', 'Obecnie mały ruch w lokalu — możesz zapewnić gościa, że zostanie szybko obsłużony, bez kolejek.');
    if (staff.tables && staff.tables.length) {
      const free = staff.tables.filter(t => t && t.status === 'free').length;
      o.push('', 'STOLIKI TERAZ (na sali): ' + free + ' wolnych z ' + staff.tables.length + ' (stan bieżący ustawiany przez obsługę). Dostępność na rezerwację w danym oknie sprawdzaj narzędziem sprawdz_dostepnosc, a nie tym stanem.');
    }
  }
  return o.join('\n');
}

async function readSite(env, siteId){
  const [pub, prv] = await Promise.all([
    env.CONFIGS.get("pub:" + siteId, "json"),
    env.CONFIGS.get("prv:" + siteId, "json"),
  ]);
  return { pub, prv };
}
async function verify(env, siteId, key){
  if (!siteId || !key) return false;
  const stored = await env.CONFIGS.get("key:" + siteId);
  if (!stored) return false;
  return (await sha256(key)) === stored;
}

// ── narzędzia bota (function calling): rezerwacje i zamówienia ──
const TOOLS = [
  {
    name: "zapisz_rezerwacje",
    description: "Zapisuje rezerwację stolika lub wizyty zgłoszoną przez klienta. Użyj dopiero, gdy znasz datę, godzinę i liczbę osób.",
    input_schema: {
      type: "object",
      properties: {
        imie: { type: "string", description: "Imię/nazwisko" },
        data: { type: "string", description: "Data w formacie RRRR-MM-DD (przelicz 'dziś'/'jutro' na konkretną datę)" },
        godzina: { type: "string", description: "Godzina, np. 19:00" },
        czas_trwania: { type: "integer", description: "Czas trwania rezerwacji w minutach (domyślnie 90, jeśli klient nie poda)" },
        liczba_osob: { type: "integer", description: "Liczba osób" },
        telefon: { type: "string", description: "Telefon, jeśli podany" },
        uwagi: { type: "string", description: "Dodatkowe uwagi" }
      },
      required: ["data", "godzina", "liczba_osob"]
    }
  },
  {
    name: "zapisz_zamowienie",
    description: "Zapisuje zamówienie złożone przez klienta (np. na wynos). Użyj, gdy klient potwierdzi pozycje.",
    input_schema: {
      type: "object",
      properties: {
        pozycje: { type: "string", description: "Pozycje z ilościami, np. '2x Margherita, 1x cola'" },
        imie: { type: "string" },
        telefon: { type: "string" },
        odbior: { type: "string", description: "Sposób/godzina odbioru lub dostawy" },
        uwagi: { type: "string" }
      },
      required: ["pozycje"]
    }
  },
  {
    name: "sprawdz_rezerwacje",
    description: "Znajduje rezerwację po 4-cyfrowym kodzie podanym przez klienta (np. gdy chce ją odwołać). Zwraca szczegóły do potwierdzenia.",
    input_schema: { type: "object", properties: { kod: { type: "string", description: "4-cyfrowy kod rezerwacji" } }, required: ["kod"] }
  },
  {
    name: "anuluj_rezerwacje",
    description: "Anuluje rezerwację po 4-cyfrowym kodzie. Użyj DOPIERO po wyraźnym potwierdzeniu przez klienta.",
    input_schema: { type: "object", properties: { kod: { type: "string", description: "4-cyfrowy kod rezerwacji" } }, required: ["kod"] }
  },
  {
    name: "sprawdz_dostepnosc",
    description: "Sprawdza, czy o danej godzinie jest wolny stolik na rezerwację (w przedziale czasowym). Użyj, gdy klient pyta o wolny termin albo gdy zapis rezerwacji zwrócił brak miejsc. Podaj datę i godzinę.",
    input_schema: { type: "object", properties: { data: { type: "string", description: "Data RRRR-MM-DD" }, godzina: { type: "string", description: "Godzina HH:MM" }, liczba_osob: { type: "integer" }, czas_trwania: { type: "integer", description: "Minuty (domyślnie 90)" } }, required: ["data", "godzina"] }
  }
];

async function callClaude(env, payload) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

function res4code(list) {
  let c, tries = 0;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); tries++; }
  while (list.some(r => r.code === c && r.status !== "cancelled") && tries < 25);
  return c;
}
function toMin(t){ const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "")); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function hhmm(min){ return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"); }
function ovl(aS, aE, bS, bE){ return aS < bE && bS < aE; }
// zwraca id stolika wolnego w oknie [startM, startM+dur) danego dnia, mieszczącego liczbę osób; null gdy brak
function pickTable(tables, reservations, date, startM, dur, people){
  if (!Array.isArray(tables) || !tables.length || startM == null) return null;
  const endM = startM + dur, ppl = +people || 0;
  const ordered = tables.slice().sort((a, b) => {
    const af = (a.seats || 2) >= ppl ? 0 : 1, bf = (b.seats || 2) >= ppl ? 0 : 1;
    if (af !== bf) return af - bf;
    return ((a.seats || 2) - (b.seats || 2)) || (a.id - b.id);
  });
  for (const t of ordered){
    if (ppl && (t.seats || 2) < ppl) continue;
    const conflict = reservations.some(r => r.tableId === t.id && r.date === date && r.status !== "cancelled" && r.status !== "no-show" && ovl(startM, endM, toMin(r.time), toMin(r.time) + (r.durationMin || 90)));
    if (!conflict) return t.id;
  }
  return null;
}

async function handleTool(env, siteId, name, input, clientId) {
  input = input || {};

  if (name === "sprawdz_rezerwacje") {
    const list = (await env.CONFIGS.get("reservations:" + siteId, "json")) || [];
    const r = list.find(x => x.code === String(input.kod || "").trim() && x.status !== "cancelled");
    if (!r) return "Nie znaleziono aktywnej rezerwacji o tym kodzie. Poproś klienta o sprawdzenie kodu.";
    return "Znaleziono rezerwację: stolik " + (r.tableId || "?") + ", " + (r.date || "") + " " + (r.time || "") + ", " + (r.people || "?") + " os." + (r.name ? ", " + r.name : "") + ". Potwierdź te szczegóły z klientem, zanim anulujesz.";
  }

  if (name === "anuluj_rezerwacje") {
    let list = (await env.CONFIGS.get("reservations:" + siteId, "json")) || [];
    const r = list.find(x => x.code === String(input.kod || "").trim() && x.status !== "cancelled");
    if (!r) return "Nie znaleziono aktywnej rezerwacji o tym kodzie.";
    r.status = "cancelled";
    await env.CONFIGS.put("reservations:" + siteId, JSON.stringify(list));
    try {
      const staff = await env.CONFIGS.get("staff:" + siteId, "json");
      if (staff && Array.isArray(staff.tables) && r.tableId != null) {
        const stillUsed = list.some(x => x.tableId === r.tableId && !["cancelled", "no-show", "completed"].includes(x.status));
        const tb = staff.tables.find(x => x && x.id === r.tableId && x.status === "reserved");
        if (tb && !stillUsed) { tb.status = "free"; await env.CONFIGS.put("staff:" + siteId, JSON.stringify(staff)); }
      }
    } catch (e) {}
    let events = (await env.CONFIGS.get("events:" + siteId, "json")) || [];
    events.unshift({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), type: "reservation", text: "ANULOWANO: stolik " + (r.tableId || "?") + ", " + (r.date || "") + " " + (r.time || "") + " (kod " + r.code + ")", at: Date.now() });
    await env.CONFIGS.put("events:" + siteId, JSON.stringify(events.slice(0, 50)));
    return "Rezerwacja anulowana. Potwierdź to klientowi.";
  }

  if (name === "sprawdz_dostepnosc") {
    const list = (await env.CONFIGS.get("reservations:" + siteId, "json")) || [];
    const staff = await env.CONFIGS.get("staff:" + siteId, "json");
    const tables = (staff && Array.isArray(staff.tables)) ? staff.tables : [];
    const dur = Math.max(15, +input.czas_trwania || 90);
    const startM = toMin(input.godzina);
    if (startM == null) return "Podaj godzinę w formacie HH:MM, aby sprawdzić dostępność.";
    const at = pickTable(tables, list, input.data || "", startM, dur, input.liczba_osob);
    if (at != null) return "Jest wolny stolik na " + input.godzina + "–" + hhmm(startM + dur) + " (stolik " + at + "). Możesz zaproponować klientowi tę godzinę.";
    const sugg = [];
    for (let off = 30; off <= 240 && sugg.length < 3; off += 30) {
      const s = startM + off;
      if (s + dur > 24 * 60) break;
      if (pickTable(tables, list, input.data || "", s, dur, input.liczba_osob) != null) sugg.push(hhmm(s));
    }
    if (sugg.length) return "Na " + input.godzina + " brak wolnego stolika. Najbliższe wolne godziny: " + sugg.join(", ") + ". Zaproponuj je klientowi.";
    return "Na " + input.godzina + " i w najbliższych godzinach brak wolnych stolików tego dnia. Zaproponuj inny dzień lub kontakt z lokalem.";
  }

  let type, text, extra = {};
  if (name === "zapisz_rezerwacje") {
    type = "reservation";
    const dur = Math.max(15, +input.czas_trwania || 90);
    const startM = toMin(input.godzina);
    const list = (await env.CONFIGS.get("reservations:" + siteId, "json")) || [];
    const staff = await env.CONFIGS.get("staff:" + siteId, "json");
    const tables = (staff && Array.isArray(staff.tables)) ? staff.tables : [];
    let tableId = null;
    if (startM != null && tables.length) {
      tableId = pickTable(tables, list, input.data || "", startM, dur, input.liczba_osob);
      if (tableId == null) {
        return "BRAK wolnego stolika w oknie " + input.godzina + "–" + hhmm(startM + dur) + " dnia " + (input.data || "") + ". NIE zapisuj rezerwacji. Użyj sprawdz_dostepnosc, zaproponuj klientowi inną godzinę i zapytaj, czy pasuje.";
      }
    }
    if (tableId != null && staff && Array.isArray(staff.tables)) {
      const tb = staff.tables.find(t => t && t.id === tableId);
      if (tb && tb.status === "free") { tb.status = "reserved"; await env.CONFIGS.put("staff:" + siteId, JSON.stringify(staff)); }
    }
    const code = res4code(list);
    const endStr = startM != null ? hhmm(startM + dur) : "";
    const resv = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), code, tableId, date: input.data || "", time: input.godzina || "", durationMin: dur, people: input.liczba_osob || null, name: input.imie || "", phone: input.telefon || "", uwagi: input.uwagi || "", status: "pending", at: Date.now() };
    list.unshift(resv);
    await env.CONFIGS.put("reservations:" + siteId, JSON.stringify(list.slice(0, 200)));
    const p = [];
    if (tableId != null) p.push("Stolik " + tableId);
    if (input.liczba_osob) p.push(input.liczba_osob + " os.");
    if (input.data) p.push(input.data);
    p.push((input.godzina || "") + (endStr ? "–" + endStr : ""));
    if (input.imie) p.push(input.imie);
    if (input.telefon) p.push("tel. " + input.telefon);
    text = p.join(", ") + " · kod " + code;
    extra = { date: resv.date, time: resv.time, durationMin: dur, people: resv.people, name: resv.name, phone: resv.phone, tableId, code };
    let events = (await env.CONFIGS.get("events:" + siteId, "json")) || [];
    events.unshift(Object.assign({ id: Date.now() + "-r-" + Math.random().toString(36).slice(2, 6), type, text, at: Date.now() }, extra));
    await env.CONFIGS.put("events:" + siteId, JSON.stringify(events.slice(0, 50)));
    return "Zapisano rezerwację (" + (input.godzina || "") + (endStr ? "–" + endStr : "") + (tableId != null ? ", stolik " + tableId : "") + "). KOD dla klienta: " + code + ". Koniecznie podaj klientowi ten 4-cyfrowy kod i powiedz, że posłuży do odwołania.";
  } else if (name === "zapisz_zamowienie") {
    type = "order";
    const p = [];
    if (input.pozycje) p.push(input.pozycje);
    if (input.odbior) p.push("odbiór: " + input.odbior);
    if (input.imie) p.push(input.imie);
    if (input.telefon) p.push("tel. " + input.telefon);
    if (input.uwagi) p.push("(" + input.uwagi + ")");
    text = p.join(" — ") || "Zamówienie";
    extra = { items: input.pozycje || "", name: input.imie || "", phone: input.telefon || "" };
    const orders = (await env.CONFIGS.get("orders:" + siteId, "json")) || [];
    orders.unshift({ id: Date.now() + "-o-" + Math.random().toString(36).slice(2, 6), clientId: clientId || "", items: input.pozycje || "", name: input.imie || "", phone: input.telefon || "", odbior: input.odbior || "", uwagi: input.uwagi || "", status: "new", at: Date.now() });
    await env.CONFIGS.put("orders:" + siteId, JSON.stringify(orders.slice(0, 200)));
    let events = (await env.CONFIGS.get("events:" + siteId, "json")) || [];
    events.unshift(Object.assign({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), type, text, at: Date.now() }, extra));
    await env.CONFIGS.put("events:" + siteId, JSON.stringify(events.slice(0, 50)));
    return "Zapisano i przekazano obsłudze.";
  } else {
    return "Nieznane narzędzie.";
  }
}

export default {
  async fetch(request, env){
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", model: MODEL, hasKey: !!env.ANTHROPIC_API_KEY, hasKV: !!env.CONFIGS }, 200, origin);
    }

    // ── PUBLICZNY wyglad (czyta widget na stronie klienta) ──
    if (request.method === "GET" && url.pathname === "/config") {
      const siteId = url.searchParams.get("site");
      if (!siteId) return json({ error: "Brak parametru site" }, 400, origin);
      const pub = await env.CONFIGS.get("pub:" + siteId, "json");
      if (!pub) return json({ error: "Nie znaleziono konfiguracji" }, 404, origin);
      return json({ config: pub }, 200, origin);
    }

    if (request.method !== "POST") return json({ error: "Użyj POST" }, 404, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Zły JSON" }, 400, origin); }

    // ── WIDGET: status zamówień danego klienta (po clientId; bez hasła) ──
    if (url.pathname === "/order-status") {
      if (!body.siteId || !body.clientId) return json({ orders: [] }, 200, origin);
      const list = (await env.CONFIGS.get("orders:" + body.siteId, "json")) || [];
      const mine = list.filter(o => o.clientId && o.clientId === body.clientId).map(o => ({ id: o.id, items: o.items, status: o.status, at: o.at }));
      return json({ orders: mine }, 200, origin);
    }

    // ── PANEL: wczytaj do edycji (wymaga hasla) ──
    if (url.pathname === "/owner/load") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      const { pub, prv } = await readSite(env, body.siteId);
      return json({ public: pub || {}, private: prv || {} }, 200, origin);
    }

    // ── PANEL: zapisz (wymaga hasla) ──
    if (url.pathname === "/owner/save") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      await Promise.all([
        env.CONFIGS.put("pub:" + body.siteId, JSON.stringify(body.public || {})),
        env.CONFIGS.put("prv:" + body.siteId, JSON.stringify(body.private || {})),
      ]);
      return json({ ok: true }, 200, origin);
    }

    // ── PANEL KELNERA: wczytaj stan + zgłoszenia ──
    if (url.pathname === "/staff/load") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      const [staff, events, reservations, history, orders] = await Promise.all([
        env.CONFIGS.get("staff:" + body.siteId, "json"),
        env.CONFIGS.get("events:" + body.siteId, "json"),
        env.CONFIGS.get("reservations:" + body.siteId, "json"),
        env.CONFIGS.get("history:" + body.siteId, "json"),
        env.CONFIGS.get("orders:" + body.siteId, "json"),
      ]);
      return json({ staff: staff || null, events: events || [], reservations: reservations || [], history: history || [], orders: orders || [] }, 200, origin);
    }

    // ── PANEL KELNERA: zapisz stan (stoliki, dania, ruch) ──
    if (url.pathname === "/staff/save") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      await env.CONFIGS.put("staff:" + body.siteId, JSON.stringify(body.staff || {}));
      return json({ ok: true }, 200, origin);
    }

    // ── PANEL KELNERA: pobierz zgłoszenia (odpytywanie) ──
    if (url.pathname === "/staff/events") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      const events = await env.CONFIGS.get("events:" + body.siteId, "json");
      return json({ events: events || [] }, 200, origin);
    }

    // ── PANEL KELNERA: oznacz zgłoszenie jako obsłużone (usuń) ──
    if (url.pathname === "/staff/seen") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      let events = (await env.CONFIGS.get("events:" + body.siteId, "json")) || [];
      const removed = events.find(e => e.id === body.id);
      events = events.filter(e => e.id !== body.id);
      await env.CONFIGS.put("events:" + body.siteId, JSON.stringify(events));
      if (removed) {
        let history = (await env.CONFIGS.get("history:" + body.siteId, "json")) || [];
        history.unshift(Object.assign({}, removed, { seenAt: Date.now() }));
        await env.CONFIGS.put("history:" + body.siteId, JSON.stringify(history.slice(0, 100)));
      }
      return json({ ok: true, events }, 200, origin);
    }

    // ── PANEL KELNERA: status/usunięcie rezerwacji ──
    if (url.pathname === "/staff/res") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      let list = (await env.CONFIGS.get("reservations:" + body.siteId, "json")) || [];
      const r = list.find(x => x.id === body.id);
      if (r) {
        const freeUp = body.del || ["completed", "no-show", "cancelled"].includes(body.status);
        if (body.del) list = list.filter(x => x.id !== body.id);
        else if (body.status) r.status = body.status;
        await env.CONFIGS.put("reservations:" + body.siteId, JSON.stringify(list));
        if (r.tableId != null && freeUp) {
          try {
            const staff = await env.CONFIGS.get("staff:" + body.siteId, "json");
            if (staff && Array.isArray(staff.tables)) {
              const stillUsed = list.some(x => x.tableId === r.tableId && !["cancelled", "no-show", "completed"].includes(x.status));
              const t = staff.tables.find(x => x && x.id === r.tableId && x.status === "reserved");
              if (t && !stillUsed) { t.status = "free"; await env.CONFIGS.put("staff:" + body.siteId, JSON.stringify(staff)); }
            }
          } catch (e) {}
        }
      }
      const reservations = (await env.CONFIGS.get("reservations:" + body.siteId, "json")) || [];
      return json({ ok: true, reservations }, 200, origin);
    }

    // ── PANEL KELNERA: status/usunięcie zamówienia ──
    if (url.pathname === "/staff/order") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      let list = (await env.CONFIGS.get("orders:" + body.siteId, "json")) || [];
      const o = list.find(x => x.id === body.id);
      if (o) {
        if (body.del) list = list.filter(x => x.id !== body.id);
        else if (body.status) o.status = body.status;
        await env.CONFIGS.put("orders:" + body.siteId, JSON.stringify(list));
      }
      const orders = (await env.CONFIGS.get("orders:" + body.siteId, "json")) || [];
      return json({ ok: true, orders }, 200, origin);
    }

    // ── PANEL KELNERA: wyczyść historię powiadomień ──
    if (url.pathname === "/staff/history-clear") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      await env.CONFIGS.put("history:" + body.siteId, JSON.stringify([]));
      return json({ ok: true }, 200, origin);
    }

    // ── DODAJ ZGŁOSZENIE (na razie do testów; docelowo doda je bot) ──
    if (url.pathname === "/event/add") {
      if (!await verify(env, body.siteId, body.editKey)) return json({ error: "Zły identyfikator lub hasło" }, 401, origin);
      if (!body.text) return json({ error: "Brak treści zgłoszenia." }, 400, origin);
      let events = (await env.CONFIGS.get("events:" + body.siteId, "json")) || [];
      events.unshift({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), type: body.type || "order", text: String(body.text).slice(0, 300), at: Date.now() });
      events = events.slice(0, 50);
      await env.CONFIGS.put("events:" + body.siteId, JSON.stringify(events));
      return json({ ok: true }, 200, origin);
    }

    // ── OPERATOR: zaloz/zaktualizuj firme (Ty) ──
    if (url.pathname === "/admin/site") {
      if (!env.ADMIN_KEY || (request.headers.get("X-Admin-Key") || "") !== env.ADMIN_KEY)
        return json({ error: "Brak lub zły klucz administratora" }, 401, origin);
      if (!body.siteId || !body.editKey) return json({ error: "Wymagane: siteId i editKey" }, 400, origin);
      await env.CONFIGS.put("key:" + body.siteId, await sha256(body.editKey));
      if (body.public)  await env.CONFIGS.put("pub:" + body.siteId, JSON.stringify(body.public));
      if (body.private) await env.CONFIGS.put("prv:" + body.siteId, JSON.stringify(body.private));
      return json({ ok: true, siteId: body.siteId }, 200, origin);
    }

    // ── ROZMOWA ── (prompt budowany na serwerze)
    if (url.pathname === "/chat") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "Brak klucza API na serwerze." }, 500, origin);
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      if (!rateOk(ip)) return json({ error: "Zbyt wiele wiadomości. Odczekaj chwilę." }, 429, origin);
      if (!body.siteId) return json({ error: "Brak siteId." }, 400, origin);
      if (!Array.isArray(body.history)) return json({ error: "Brak historii rozmowy." }, 400, origin);
      if (body.history.length > MAX_HISTORY) return json({ error: "Rozmowa zbyt długa — odśwież stronę." }, 429, origin);

      const { pub, prv } = await readSite(env, body.siteId);
      if (!pub && !prv) return json({ error: "Nie znaleziono konfiguracji bota." }, 404, origin);

      const staff = await env.CONFIGS.get("staff:" + body.siteId, "json");
      const system = buildSystemPrompt(pub || {}, prv || {}, staff || null);
      let messages = body.history.map(m => ({
        role: m.role === "model" ? "assistant" : "user",
        content: (m.parts && m.parts[0] && m.parts[0].text) || m.content || "",
      }));

      try {
        let finalText = "";
        const doneTools = new Set();
        for (let step = 0; step < 4; step++) {
          const data = await callClaude(env, { model: MODEL, max_tokens: MAX_TOKENS, system, tools: TOOLS, messages });
          if (data.error) return json({ error: "Claude: " + (data.error.message || "nieznany błąd") }, 502, origin);
          const content = data.content || [];
          const text = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
          if (text) finalText = text;
          const toolUses = content.filter(c => c.type === "tool_use");
          if (!toolUses.length) break;
          messages.push({ role: "assistant", content });
          const results = [];
          for (const tu of toolUses) {
            let out;
            if (doneTools.has(tu.name)) out = "To zgłoszenie zostało już zapisane w tej rozmowie — NIE zapisuj go ponownie, tylko potwierdź klientowi.";
            else { out = await handleTool(env, body.siteId, tu.name, tu.input, body.clientId); doneTools.add(tu.name); }
            results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
          }
          messages.push({ role: "user", content: results });
        }
        if (!finalText) finalText = "Gotowe — zapisałem. Czy mogę jeszcze w czymś pomóc?";
        return json({ reply: finalText }, 200, origin);
      } catch (e) {
        return json({ error: "Błąd połączenia z Claude: " + e.message }, 502, origin);
      }
    }

    return json({ error: "Nieznana ścieżka." }, 404, origin);
  },
};
