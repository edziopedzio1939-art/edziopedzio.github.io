// ╔════════════════════════════════════════════════════════════╗
// ║         ADAMOS v3 — BACKEND dla CLAUDE (Anthropic)         ║
// ║                                                            ║
// ║  Wersja dla Claude zamiast Gemini.                         ║
// ║  Klucz API jest tu BEZPIECZNY (nikt go nie zobaczy).       ║
// ╠════════════════════════════════════════════════════════════╣
// ║  CO USTAWIĆ:                                               ║
// ║   1. Wklej ten kod do Workera na dash.cloudflare.com       ║
// ║   2. Ustaw sekret ANTHROPIC_API_KEY (NIE Gemini!)          ║
// ║   3. Deploy                                                ║
// ║  Klucz zdobędziesz na: https://console.anthropic.com       ║
// ╚════════════════════════════════════════════════════════════╝


// ═══════════════════════════════════════════════════════════════
//  USTAWIENIA
// ═══════════════════════════════════════════════════════════════

// Model Claude. Haiku = najtańszy i szybki (idealny do chatbota).
// Inne opcje: "claude-sonnet-4-6" (wyższa jakość, droższy)
const MODEL = "claude-haiku-4-5-20251001";

// Limit zapytań na użytkownika (ochrona przed nadużyciem)
const RATE_LIMIT_MAX    = 15;
const RATE_LIMIT_WINDOW = 60000;  // 1 minuta

// Maksymalna długość rozmowy
const MAX_HISTORY = 60;

// Maksymalna długość odpowiedzi (w tokenach)
const MAX_TOKENS = 500;

// Dozwolone domeny (CORS). "*" = wszystkie (OK do testów).
const ALLOWED_ORIGINS = ["*"];


// ═══════════════════════════════════════════════════════════════
//  RATE LIMITER
// ═══════════════════════════════════════════════════════════════
const rateMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const hits = (rateMap.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (hits.length >= RATE_LIMIT_MAX) return false;
  hits.push(now);
  rateMap.set(ip, hits);
  if (rateMap.size > 5000) {
    for (const [k, v] of rateMap) {
      if (v.every(t => now - t > RATE_LIMIT_WINDOW)) rateMap.delete(k);
    }
  }
  return true;
}


// ═══════════════════════════════════════════════════════════════
//  CORS
// ═══════════════════════════════════════════════════════════════
function corsHeaders(origin) {
  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowed  = allowAll || ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin":  allowed ? (origin || "*") : "null",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}


// ═══════════════════════════════════════════════════════════════
//  GŁÓWNY HANDLER
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url    = new URL(request.url);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status:  "ok",
        model:   MODEL,
        hasKey:  !!env.ANTHROPIC_API_KEY,
        message: env.ANTHROPIC_API_KEY
          ? "Backend działa i ma klucz API ✓"
          : "⚠ Backend działa, ale BRAK klucza ANTHROPIC_API_KEY!",
      }, 200, origin);
    }

    // Tylko POST /chat
    if (request.method !== "POST" || url.pathname !== "/chat") {
      return json({ error: "Nie znaleziono. Użyj POST /chat" }, 404, origin);
    }

    // Klucz API
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Brak klucza API na serwerze. Ustaw ANTHROPIC_API_KEY." }, 500, origin);
    }

    // Rate limit
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    if (!checkRateLimit(ip)) {
      return json({ error: "Zbyt wiele wiadomości. Odczekaj chwilę i spróbuj ponownie." }, 429, origin);
    }

    // Odczyt danych
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Nieprawidłowe dane (zły JSON)." }, 400, origin);
    }

    if (!Array.isArray(body.history)) {
      return json({ error: "Brak historii rozmowy." }, 400, origin);
    }
    if (body.history.length > MAX_HISTORY) {
      return json({ error: "Rozmowa zbyt długa — odśwież stronę aby zacząć od nowa." }, 429, origin);
    }

    // ── Przekształć historię z formatu Gemini na format Claude ──
    // Frontend wysyła historię w formacie Gemini: { role:'user'|'model', parts:[{text}] }
    // Claude oczekuje:                              { role:'user'|'assistant', content:'...' }
    const messages = body.history.map(m => ({
      role:    m.role === "model" ? "assistant" : "user",
      content: (m.parts && m.parts[0] && m.parts[0].text) || m.content || "",
    }));

    // ── Zbuduj zapytanie do Claude ──
    const claudePayload = {
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     body.systemPrompt || "Jesteś pomocnym asystentem.",
      messages:   messages,
    };

    // ── Wywołaj Anthropic API ──
    try {
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method:  "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(claudePayload),
      });

      const data = await claudeRes.json();

      // Błąd zwrócony przez Anthropic
      if (data.error) {
        return json({ error: "Claude: " + (data.error.message || "nieznany błąd") }, 502, origin);
      }

      // Wyciągnij tekst odpowiedzi (format Claude: content[0].text)
      const reply = data?.content?.[0]?.text;
      if (!reply) {
        return json({ error: "Claude zwrócił pustą odpowiedź." }, 502, origin);
      }

      // Sukces!
      return json({ reply }, 200, origin);

    } catch (err) {
      return json({ error: "Błąd połączenia z Claude: " + err.message }, 502, origin);
    }
  },
};
