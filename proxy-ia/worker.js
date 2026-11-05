// Intermediário de IA do Investe.AI (Cloudflare Workers, plano gratuito).
// O programa manda a pergunta para cá; só este servidor conhece as chaves do Groq e do Gemini.
// Segredos (wrangler secret put ...): GROQ_KEY, GEMINI_KEY (opcional, reserva e pesquisa no Google), APP_TOKEN (opcional).
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type,x-app-token,x-app-versao", "Access-Control-Allow-Methods": "POST,GET,OPTIONS" };
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
const GEMINI_MODELOS = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"];

async function groq(env, sistema, msgs) {
  const modelo = env.GROQ_MODEL || "openai/gpt-oss-120b";
  const corpo = { model: modelo, max_tokens: 1600, messages: [{ role: "system", content: sistema }, ...msgs] };
  if (modelo.startsWith("openai/gpt-oss")) Object.assign(corpo, { max_tokens: 6000, reasoning_effort: "medium" });
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.GROQ_KEY }, body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error("groq " + r.status);
  const j = await r.json();
  const texto = ((j.choices || [])[0]?.message?.content || "").trim();
  if (!texto) throw new Error("groq sem texto");
  return { texto, modelo, fontes: [], aviso: null };
}

async function gemini(env, sistema, msgs, web) {
  const contents = msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  for (const modelo of GEMINI_MODELOS) {
    const corpo = { systemInstruction: { parts: [{ text: sistema }] }, contents, generationConfig: { maxOutputTokens: 8192 } };
    if (web) corpo.tools = [{ google_search: {} }];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY }, body: JSON.stringify(corpo),
    });
    if (r.status === 404 || r.status === 429 || r.status >= 500) continue;  // tenta o próximo modelo
    if (!r.ok) throw new Error("gemini " + r.status);
    const j = await r.json(), c = (j.candidates || [])[0] || {};
    const texto = (c.content?.parts || []).map(p => p.text || "").join("").trim();
    if (!texto) continue;
    const fontes = (c.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean)
      .map(w => ({ titulo: w.title || w.uri, link: w.uri })).slice(0, 8);
    return { texto, modelo, fontes, aviso: null };
  }
  throw new Error("gemini indisponível");
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/saude") return json({ ok: true, groq: !!env.GROQ_KEY, gemini: !!env.GEMINI_KEY });
    if (url.pathname !== "/chat" || req.method !== "POST") return json({ erro: "Não encontrado." }, 404);
    if (env.APP_TOKEN && req.headers.get("x-app-token") !== env.APP_TOKEN) return json({ erro: "Acesso negado." }, 403);
    if (env.LIMITE) {  // limite por pessoa (endereço de internet), definido no wrangler.toml
      const { success } = await env.LIMITE.limit({ key: req.headers.get("cf-connecting-ip") || "?" });
      if (!success) return json({ erro: "Muitas perguntas seguidas. Espere um minuto e tente de novo." }, 429);
    }
    let d;
    try { d = await req.json(); } catch { return json({ erro: "Pedido inválido." }, 400); }
    const msgs = (Array.isArray(d.mensagens) ? d.mensagens : []).slice(-12)
      .map(m => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "").slice(0, 8000) }))
      .filter(m => m.content);
    const sistema = String(d.sistema || "").slice(0, 30000);
    if (!msgs.length) return json({ erro: "Pergunta vazia." }, 400);
    if (d.web && env.GEMINI_KEY) {
      try { return json(await gemini(env, sistema, msgs, true)); } catch (e) { /* segue para o Groq */ }
    }
    try {
      if (!env.GROQ_KEY) throw new Error("sem chave do Groq");
      return json(await groq(env, sistema, msgs));
    } catch (e) {
      if (env.GEMINI_KEY) {
        try { const r = await gemini(env, sistema, msgs, false); r.aviso = "O Groq não respondeu agora; esta resposta veio do Gemini."; return json(r); } catch (e2) { }
      }
      return json({ erro: "A IA não respondeu agora. Tente de novo em instantes." }, 502);
    }
  },
};
