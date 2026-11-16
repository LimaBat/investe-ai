// Intermediário de IA do Investe.AI (Cloudflare Workers, plano gratuito).
// O programa manda a pergunta para cá; só este servidor conhece as chaves do Groq e do Gemini.
// Segredos (wrangler secret put ...): GROQ_KEY, GEMINI_KEY (opcional, reserva e pesquisa no Google), APP_TOKEN (opcional).
// Reajuste na nuvem (nuvem.js): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BRAPI_TOKEN (opcional), TELEGRAM_TOKEN e TELEGRAM_BOT (opcionais).
import { googleWeb } from "./google_web.js";
import { nuvemRotas, nuvemAgendado } from "./nuvem.js";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type,x-app-token,x-app-versao,x-cookie,accept,accept-language,authorization", "Access-Control-Allow-Methods": "POST,GET,PATCH,OPTIONS", "Access-Control-Max-Age": "86400" };

// ---- versão para navegador: repassa os pedidos de dados (o Yahoo, o Banco Central e as notícias não aceitam pedidos de páginas web).
// Só para estes sites; os cookies vão e voltam em cabeçalhos próprios (o navegador não deixa a página mexer nos cookies de outro site).
const WEB_HOSTS = /(^|\.)yahoo\.com$|^api\.bcb\.gov\.br$|^olinda\.bcb\.gov\.br$|^news\.google\.com$|^economia\.awesomeapi\.com\.br$|^brapi\.dev$|^api\.coingecko\.com$|^(www|openidconnect)\.googleapis\.com$/;
const UA_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
async function webProxy(req, url) {
  let alvo;
  try { alvo = new URL(url.searchParams.get("u") || ""); } catch { return new Response("endereço inválido", { status: 400, headers: CORS }); }
  if (!/^https?:$/.test(alvo.protocol) || !WEB_HOSTS.test(alvo.hostname)) return new Response("site não permitido", { status: 403, headers: CORS });
  const h = new Headers({ "user-agent": UA_WEB });
  for (const k of ["accept", "accept-language", "content-type", "authorization"]) { const v = req.headers.get(k); if (v) h.set(k, v); }
  const ck = req.headers.get("x-cookie"); if (ck) h.set("cookie", ck);
  let r;
  try {
    r = await fetch(alvo.toString(), { method: req.method, headers: h, redirect: "manual", body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer() });
  } catch (e) { return new Response("falha ao acessar " + alvo.hostname, { status: 502, headers: CORS }); }
  const out = new Headers(CORS);
  out.set("access-control-expose-headers", "x-set-cookie,x-location,x-status,content-type");
  out.set("x-status", String(r.status));
  const ct = r.headers.get("content-type"); if (ct) out.set("content-type", ct);
  const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  if (sc.length) out.set("x-set-cookie", btoa(unescape(encodeURIComponent(JSON.stringify(sc)))));
  const loc = r.headers.get("location"); if (loc) out.set("x-location", new URL(loc, alvo).toString());
  out.set("cache-control", "no-store");
  // redirecionamentos voltam como 200 (com x-status e x-location) para o navegador não segui-los sozinho
  return new Response(r.status >= 300 && r.status < 400 ? null : r.body, { status: r.status >= 300 && r.status < 400 ? 200 : r.status, headers: out });
}
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
    if (url.pathname === "/saude") return json({ ok: true, groq: !!env.GROQ_KEY, gemini: !!env.GEMINI_KEY, nuvem: !!(env.NUVEM && env.GOOGLE_CLIENT_SECRET), google_web: !!(env.GOOGLE_WEB_CLIENT_ID && env.GOOGLE_WEB_CLIENT_SECRET), telegram: !!env.TELEGRAM_TOKEN });
    if (url.pathname.startsWith("/nuvem/") || url.pathname.startsWith("/tg/")) return nuvemRotas(req, env, url, { json, groq });
    if (url.pathname === "/web/p") return webProxy(req, url);
    if (url.pathname.startsWith("/oauth/web/")) return googleWeb(req, env, url, { json, CORS });
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
  // reajuste da carteira na nuvem: roda sozinho a cada 15 minutos (ver [triggers] no wrangler.toml)
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(nuvemAgendado(env, { groq }));
  },
};
