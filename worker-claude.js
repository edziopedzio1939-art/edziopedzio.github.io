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
function buildSystemPrompt(pub, prv){
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

      const system = buildSystemPrompt(pub || {}, prv || {});
      const messages = body.history.map(m => ({
        role: m.role === "model" ? "assistant" : "user",
        content: (m.parts && m.parts[0] && m.parts[0].text) || m.content || "",
      }));

      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
        });
        const data = await r.json();
        if (data.error) return json({ error: "Claude: " + (data.error.message || "nieznany błąd") }, 502, origin);
        const reply = data && data.content && data.content[0] && data.content[0].text;
        if (!reply) return json({ error: "Claude zwrócił pustą odpowiedź." }, 502, origin);
        return json({ reply }, 200, origin);
      } catch (e) {
        return json({ error: "Błąd połączenia z Claude: " + e.message }, 502, origin);
      }
    }

    return json({ error: "Nieznana ścieżka." }, 404, origin);
  },
};
