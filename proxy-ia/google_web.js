// Login com o Google na versão para navegador (limabat.github.io/investe-ai/app/).
// O Google só devolve o login para endereços cadastrados, então ele passa por aqui:
//   /oauth/web/inicio?volta=<página>  -> leva ao Google
//   /oauth/web/volta                  -> troca o código pela autorização e devolve à página (no #, que não sai do navegador)
//   /oauth/web/renovar {rt}           -> renova o acesso (o segredo do cliente Web fica só aqui)
// Segredos: GOOGLE_WEB_CLIENT_ID e GOOGLE_WEB_CLIENT_SECRET (cliente OAuth do tipo "Aplicativo da Web").
const ESCOPO = "openid email profile https://www.googleapis.com/auth/drive.appdata";
const VOLTAS = /^(https:\/\/limabat\.github\.io\/investe-ai\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)/;
const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64u = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

async function assina(env, texto) {
  const k = await crypto.subtle.importKey("raw", enc.encode("investe-ai-web|" + env.GOOGLE_WEB_CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(texto)));
}

function pagina(msg, volta) {
  const v = volta ? `<p><a href="${volta.replace(/"/g, "&quot;")}" style="color:#5eead4">Voltar ao Investe.AI</a></p>` : "";
  return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Investe.AI</title>
<body style="font-family:system-ui;background:#0a0f1e;color:#e8ecf7;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;max-width:440px;padding:24px">
<div style="font-size:40px;color:#f87171">Erro</div><p>${msg.replace(/</g, "&lt;")}</p>${v}</div>`, { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function googleWeb(req, env, url, { json, CORS }) {
  const p = url.pathname;
  const pronto = !!(env.GOOGLE_WEB_CLIENT_ID && env.GOOGLE_WEB_CLIENT_SECRET);
  const retorno = url.origin + "/oauth/web/volta";
  if (p === "/oauth/web/inicio") {
    const volta = url.searchParams.get("volta") || "";
    if (!VOLTAS.test(volta)) return pagina("Endereço de volta não permitido.");
    if (!pronto) return pagina("O login com o Google na versão para navegador ainda não foi configurado.", volta);
    const dados = b64u(enc.encode(JSON.stringify({ v: volta, t: Date.now() })));
    const state = dados + "." + await assina(env, dados);
    const q = new URLSearchParams({ client_id: env.GOOGLE_WEB_CLIENT_ID, redirect_uri: retorno, response_type: "code", scope: ESCOPO,
      state, access_type: "offline", prompt: "consent", include_granted_scopes: "true" });
    return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q, 302);
  }
  if (p === "/oauth/web/volta") {
    if (!pronto) return pagina("O login com o Google na versão para navegador ainda não foi configurado.");
    const [dados, sig] = String(url.searchParams.get("state") || "").split(".");
    let st = null;
    try { if (dados && sig === await assina(env, dados)) st = JSON.parse(deB64u(dados)); } catch { }
    if (!st || !VOLTAS.test(st.v) || Date.now() - st.t > 15 * 60e3) return pagina("O login demorou demais ou veio de outro lugar. Volte ao Investe.AI e tente de novo.");
    const volta = st.v.split("#")[0];
    if (url.searchParams.get("error")) return Response.redirect(volta + "#gerro=" + encodeURIComponent("Login cancelado ou recusado pelo Google."), 302);
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env.GOOGLE_WEB_CLIENT_ID, client_secret: env.GOOGLE_WEB_CLIENT_SECRET,
        redirect_uri: retorno, grant_type: "authorization_code" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) return Response.redirect(volta + "#gerro=" + encodeURIComponent("O Google recusou o login: " + (j.error_description || j.error || r.status)), 302);
    const pacote = { access_token: j.access_token, refresh_token: j.refresh_token || "", expires_in: j.expires_in || 3600, scope: j.scope || "" };
    return Response.redirect(volta + "#g=" + b64u(enc.encode(JSON.stringify(pacote))), 302);
  }
  if (p === "/oauth/web/renovar" && req.method === "POST") {
    if (env.APP_TOKEN && req.headers.get("x-app-token") !== env.APP_TOKEN) return json({ erro: "Acesso negado." }, 403);
    if (!pronto) return json({ erro: "não configurado" }, 503);
    let d; try { d = await req.json(); } catch { return json({ erro: "Pedido inválido." }, 400); }
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_WEB_CLIENT_ID, client_secret: env.GOOGLE_WEB_CLIENT_SECRET, refresh_token: String(d.rt || ""), grant_type: "refresh_token" }),
    });
    const j = await r.json().catch(() => ({}));
    return json(j.access_token ? { access_token: j.access_token, expires_in: j.expires_in || 3600 } : { erro: j.error || "falhou" }, j.access_token ? 200 : 400);
  }
  return json({ erro: "Não encontrado." }, 404);
}
