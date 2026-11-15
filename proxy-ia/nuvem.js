// Reajuste da carteira na nuvem (Cloudflare Workers, plano gratuito).
// Funciona com o app fechado e até sem ninguém logado: a pessoa autoriza uma vez pelo app, a autorização do
// Google fica guardada aqui (criptografada) e, na frequência escolhida, este código lê a carteira simulada
// na pasta oculta do app no Google Drive, confere o perfil, reajusta (se a pessoa escolheu) e avisa pelo Telegram.
// A lógica é a mesma do app (aba Reajuste automático); quando a pessoa abrir o app, a sincronização traz o resultado.

const DRIVE_ARQ = "investidor_dados.json";
const enc = new TextEncoder(), dec = new TextDecoder();
const DIA = 86400e3;
const FREQ = { diaria: 20 * 3600e3, semanal: 6.5 * DIA, mensal: 29 * DIA };

// ---------- classes de ativos (iguais às do app) ----------
const CRIPTO = new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "BNB", "USDT", "LTC", "DOT", "AVAX", "LINK", "MATIC", "TRX", "SHIB", "TON"]);
const MOEDA = { USD: "USD", DOLAR: "USD", EUR: "EUR", EURO: "EUR", GBP: "GBP", LIBRA: "GBP", JPY: "JPY", IENE: "JPY", CHF: "CHF", CAD: "CAD", AUD: "AUD", CNY: "CNY", ARS: "ARS" };
const ETF = new Set(["BOVA11", "IVVB11", "SMAL11", "DIVO11", "HASH11", "NASD11", "FIND11", "MATB11", "BOVV11", "XINA11", "SPXI11", "ACWI11", "IMAB11", "B5P211", "FIXA11", "BOVB11", "ECOO11", "ISUS11", "PIBB11", "SMAC11", "QBTC11", "ETHE11", "BITH11", "QETH11", "DEFI11", "WEB311", "TECK11", "USDB11", "IB5M11", "IRFM11", "LFTS11", "NDIV11"]);
const UNIT = new Set(["TAEE11", "ENGI11", "ALUP11", "SAPR11", "BPAC11", "SANB11", "KLBN11", "IGTI11", "BRBI11", "RNEW11", "CPLE11", "AESB11", "CTNM11", "SULA11", "TIET11", "BIDI11", "PPLA11"]);
const ETF_EXT = new Set(["IVVB11", "WRLD11", "NASD11", "SPXI11", "ACWI11", "EURP11", "XINA11", "ASIA11", "USTK11"]);
const ETF_CRI = new Set(["HASH11", "QBTC11", "BITH11", "QETH11", "ETHE11"]);
const CG = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", ADA: "cardano", DOGE: "dogecoin", BNB: "binancecoin", USDT: "tether", LTC: "litecoin", DOT: "polkadot", AVAX: "avalanche-2", LINK: "chainlink", MATIC: "polygon-ecosystem-token", TRX: "tron", SHIB: "shiba-inu", TON: "the-open-network" };

function classeAtivo(t) {
  t = String(t || "").toUpperCase().replace(/\.SA$/, "");
  if (CRIPTO.has(t) || /-(USD|BRL|USDT)$/.test(t)) return "Cripto";
  if (MOEDA[t] || /=X$/.test(t) || t === "GC=F" || t === "GOLD11") return "Moedas e ouro";
  if (ETF.has(t)) return "ETFs";
  if (UNIT.has(t)) return "Ações";
  if (/^[A-Z0-9]{4}3[2-9]$/.test(t)) return "BDRs e exterior";
  if (/^[A-Z0-9]{4}11$/.test(t)) return "FIIs";
  if (/^[A-Z0-9]{4}\d{1,2}$/.test(t)) return "Ações";
  return "BDRs e exterior";
}
function classeIdx(t) {
  t = String(t || "").toUpperCase();
  if (ETF_CRI.has(t)) return 6;
  const c = classeAtivo(t);
  return c === "Cripto" ? 6 : c === "Moedas e ouro" ? 5 : c === "FIIs" ? 2 : c === "BDRs e exterior" ? 4 : c === "ETFs" ? (ETF_EXT.has(t) ? 4 : 3) : 3;
}
const fracOk = (t, moeda) => classeAtivo(t) === "Cripto" || (moeda && moeda !== "BRL");
const CT_CLS = [
  { n: "Reserva e Tesouro Selic" }, { n: "Renda fixa (CDB, LCI/LCA, IPCA+)" },
  { n: "Fundos imobiliários", t: ["MXRF11", "HGLG11", "KNRI11"] }, { n: "Ações do Brasil", t: ["ITUB4", "WEGE3", "VALE3", "BOVA11"] },
  { n: "Exterior (ações e ETFs)", t: ["IVVB11", "AAPL", "MSFT"] }, { n: "Moedas e ouro", t: ["USD", "EUR", "GOLD11"] }, { n: "Criptomoedas", t: ["BTC", "ETH"] }];
const CT_RF = [{ nome: "Tesouro Selic (reserva)", idx: "selic", taxa: 100 }, { nome: "CDB pós-fixado 100% do CDI", idx: "cdi", taxa: 100 }];
const CT_ANC = { 0: [40, 55, 3, 0, 0, 2, 0], 25: [25, 45, 10, 10, 5, 5, 0], 50: [15, 30, 15, 20, 12, 6, 2], 75: [10, 15, 15, 30, 20, 5, 5], 100: [5, 5, 15, 35, 25, 5, 10] };
function ctAloc(p) {
  const k = [0, 25, 50, 75, 100], i = Math.min(3, Math.floor(p / 25)), a = CT_ANC[k[i]], b = CT_ANC[k[i + 1]], f = (p - k[i]) / 25;
  const v = a.map((x, j) => Math.round(x + (b[j] - x) * f));
  v[v.indexOf(Math.max(...v))] += 100 - v.reduce((s, x) => s + x, 0);
  return v;
}
const ctPerfil = p => p <= 20 ? "Conservador" : p <= 40 ? "Moderado-conservador" : p <= 60 ? "Moderado" : p <= 80 ? "Moderado-arrojado" : "Arrojado";

// ---------- utilidades ----------
const brl = v => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtd = q => Number(q).toLocaleString("pt-BR", { maximumFractionDigits: 6 });
const hojeISO = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);  // data de Brasília
const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const b64 = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function hashHex(txt, n = 64) { const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(txt))); return [...h].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, n); }
async function chave(env) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode((env.GOOGLE_CLIENT_SECRET || "") + "|investe-ai-nuvem|" + (env.APP_TOKEN || "")));
  return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function cifra(env, txt) { const iv = crypto.getRandomValues(new Uint8Array(12)); const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await chave(env), enc.encode(txt)); return b64(iv) + "." + b64(new Uint8Array(c)); }
async function decifra(env, s) { const [a, b] = String(s).split("."); return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(a) }, await chave(env), unb64(b))); }
async function jget(url, op = {}) { const r = await fetch(url, op); if (!r.ok) throw new Error(url.split("?")[0].split("/")[2] + " " + r.status); return r.json(); }

// ---------- Google: autorização e Google Drive (pasta oculta do app) ----------
async function gToken(env, rt) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const e = new Error(j.error === "invalid_grant" ? "A autorização do Google expirou ou foi removida. Entre com o Google no app e ative a nuvem de novo." : "O Google não respondeu (" + r.status + ").");
    e.expirou = j.error === "invalid_grant";
    throw e;
  }
  return j.access_token;
}
async function gConta(tok) {
  const j = await jget("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: "Bearer " + tok } });
  if (!j.sub) throw new Error("Conta Google não identificada.");
  return { sub: j.sub, nome: j.given_name || j.name || "" };
}
async function driveAchar(tok) {
  const q = encodeURIComponent(`name='${DRIVE_ARQ}'`);
  const j = await jget(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id)&q=${q}`, { headers: { authorization: "Bearer " + tok } });
  return (j.files || [])[0]?.id || null;
}
const driveLer = (tok, id) => jget(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { authorization: "Bearer " + tok } });
async function driveGravar(tok, id, obj) {
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
    method: "PATCH", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error("Google Drive " + r.status);
}

// ---------- preços em reais ----------
async function fx(cods) {
  const pares = [...new Set(cods)].filter(c => c && c !== "BRL").map(c => c + "-BRL");
  if (!pares.length) return {};
  const j = await jget("https://economia.awesomeapi.com.br/json/last/" + pares.join(","));
  const out = {};
  Object.values(j || {}).forEach(x => { if (x && x.code && +x.bid > 0) out[x.code] = +x.bid; });
  return out;
}
async function yahoo(sym) {
  const j = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, { headers: { "user-agent": "Mozilla/5.0" } });
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || !(m.regularMarketPrice > 0)) throw new Error("sem preço");
  return { p: m.regularMarketPrice, moeda: m.currency || "USD" };
}
async function brapi(env, t) {
  const j = await jget(`https://brapi.dev/api/quote/${encodeURIComponent(t)}` + (env.BRAPI_TOKEN ? "?token=" + encodeURIComponent(env.BRAPI_TOKEN) : ""));
  const r = (j.results || [])[0];
  if (!r || !(r.regularMarketPrice > 0)) throw new Error("sem preço");
  return r.regularMarketPrice;
}
// devolve { TICKER: { preco (em reais), moeda } }; o que não achar fica de fora (não é comprado nem vendido)
async function precos(env, tks) {
  const out = {}, cri = [], b3 = [], ext = [], moe = new Set();
  [...new Set(tks.map(t => String(t).toUpperCase()))].forEach(t => {
    if (CRIPTO.has(t)) cri.push(t); else if (MOEDA[t]) moe.add(MOEDA[t]);
    else if (/^[A-Z0-9]{4}\d{1,2}$/.test(t)) b3.push(t); else ext.push(t);
  });
  let cambio = {};
  try { cambio = await fx([...moe, ...(ext.length ? ["USD"] : [])]); } catch (e) { }
  tks.forEach(t => { const c = MOEDA[String(t).toUpperCase()]; if (c && cambio[c]) out[String(t).toUpperCase()] = { preco: cambio[c], moeda: "BRL" }; });
  if (cri.length) {
    try {
      const j = await jget(`https://api.coingecko.com/api/v3/simple/price?vs_currencies=brl&ids=${cri.map(t => CG[t]).join(",")}`);
      cri.forEach(t => { const v = j[CG[t]]?.brl; if (v > 0) out[t] = { preco: v, moeda: "USD" }; });
    } catch (e) { }
  }
  await Promise.all(b3.map(async t => {
    try { out[t] = { preco: await brapi(env, t), moeda: "BRL" }; return; } catch (e) { }
    try { const y = await yahoo(t + ".SA"); out[t] = { preco: y.p, moeda: "BRL" }; } catch (e) { }
  }));
  await Promise.all(ext.map(async t => {
    try { const y = await yahoo(t); const k = y.moeda === "BRL" ? 1 : (cambio[y.moeda] || (y.moeda === "USD" ? cambio.USD : 0)); if (k) out[t] = { preco: y.p * k, moeda: y.moeda }; } catch (e) { }
  }));
  return out;
}

// ---------- renda fixa: valor de hoje pelo CDI, Selic e IPCA do Banco Central ----------
const brData = d => d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
const isoBr = s => s.slice(6, 10) + "-" + s.slice(3, 5) + "-" + s.slice(0, 2);
async function sgs(serie, ini, fim) {
  const j = await jget(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados?formato=json&dataInicial=${brData(ini)}&dataFinal=${brData(fim)}`);
  return (Array.isArray(j) ? j : []).map(x => [isoBr(x.data), parseFloat(String(x.valor).replace(",", "."))]).filter(x => isFinite(x[1]));
}
async function rfValores(itens) {
  const ativos = itens.filter(x => !x.resg && x.v > 0 && x.d);
  if (!ativos.length) return {};
  const hj = hojeISO(), ini = ativos.map(x => x.d).sort()[0];
  let cdi = [], selic = {}, ipca = {};
  try { cdi = await sgs(12, ini, hj); } catch (e) { }
  try { if (ativos.some(x => x.idx === "selic")) selic = Object.fromEntries(await sgs(11, ini, hj)); } catch (e) { }
  try { if (ativos.some(x => x.idx === "ipca")) (await sgs(433, ini.slice(0, 8) + "01", hj)).forEach(([d, v]) => ipca[d.slice(0, 7)] = v); } catch (e) { }
  const cdiPad = cdi.length ? cdi[cdi.length - 1][1] : ((1 + 0.14) ** (1 / 252) - 1) * 100;
  const uteis = cdi.slice();  // completa os dias úteis que o Banco Central ainda não publicou
  let d = new Date((cdi.length ? cdi[cdi.length - 1][0] : ini) + "T12:00:00Z"); d = new Date(d.getTime() + DIA);
  while (d.toISOString().slice(0, 10) < hj) { if (d.getUTCDay() % 6) uteis.push([d.toISOString().slice(0, 10), cdiPad]); d = new Date(d.getTime() + DIA); }
  const nMes = {}; uteis.forEach(([x]) => nMes[x.slice(0, 7)] = (nMes[x.slice(0, 7)] || 0) + 1);
  const ipcaUlt = Object.values(ipca).slice(-1)[0] ?? 0.35;
  const out = {};
  ativos.forEach(x => {
    const fimV = x.venc && x.venc < hj ? x.venc : hj, preDia = (1 + (+x.taxa || 0) / 100) ** (1 / 252);
    let f = 1;
    uteis.forEach(([dd, cd]) => {
      if (dd < x.d || dd >= fimV) return;
      if (x.idx === "cdi") f *= 1 + (cd / 100) * ((+x.taxa || 0) / 100);
      else if (x.idx === "selic") f *= 1 + ((selic[dd] ?? cd + 0.0004) / 100) * ((+x.taxa || 100) / 100);
      else if (x.idx === "pre") f *= preDia;
      else { const k = dd.slice(0, 7); f *= preDia * (1 + (ipca[k] ?? ipcaUlt) / 100) ** (1 / Math.max(1, nMes[k] || 21)); }
    });
    const bruto = x.v * f, dias = Math.round((Date.parse(fimV) - Date.parse(x.d)) / DIA);
    const aliq = x.isento ? 0 : dias <= 180 ? 22.5 : dias <= 360 ? 20 : dias <= 720 ? 17.5 : 15;
    out[x.id] = { bruto, liq: bruto - Math.max(0, bruto - x.v) * aliq / 100 };
  });
  return out;
}

// ---------- o reajuste (mesma regra do app) ----------
function caixa(dados) {
  let s = 0;
  (dados.sim_movs || []).forEach(m => { if (m && isFinite(m.v)) s += m.tipo === "saq" ? -m.v : +m.v; });
  (dados.sim_lanc || []).forEach(l => { const v = l.q * l.p; s += l.tipo === "V" ? v - (l.tx || 0) : -(v + (l.tx || 0)); });
  (dados.sim_rf || []).forEach(x => { s -= x.v; if (x.resg) s += x.vresg || 0; });
  return s;
}
async function estado(env, dados, cfg) {
  const pos = {};
  (dados.sim_lanc || []).forEach(l => {
    const t = String(l.t || "").toUpperCase(); if (!t) return;
    const p = pos[t] || (pos[t] = { t, q: 0, custo: 0, moeda: l.moeda || "BRL" });
    if (l.tipo === "V") { const pm = p.q > 0 ? p.custo / p.q : 0; p.q -= l.q; p.custo -= pm * l.q; } else { p.q += l.q; p.custo += l.q * l.p + (l.tx || 0); }
  });
  const lin = Object.values(pos).filter(p => p.q > 1e-9);
  const pr = await precos(env, lin.map(p => p.t));
  const H = lin.map(p => { const x = pr[p.t]; const preco = x ? x.preco : p.custo / p.q; return { t: p.t, q: p.q, p: preco, v: p.q * preco, i: classeIdx(p.t), moeda: x ? x.moeda : p.moeda, ok: !!x, resp: p.custo > 0 ? (p.q * preco / p.custo - 1) * 100 : null }; });
  const rfv = await rfValores(dados.sim_rf || []);
  const R = (dados.sim_rf || []).filter(x => !x.resg && x.v > 0).map(x => ({ id: x.id, nome: x.nome, v: rfv[x.id]?.bruto ?? x.v, liq: rfv[x.id]?.liq, i: x.idx === "selic" ? 0 : 1, diaria: (x.idx === "selic" || x.idx === "cdi") && !x.venc }));
  const cx = caixa(dados), cur = CT_CLS.map(() => 0);
  H.forEach(h => cur[h.i] += h.v); R.forEach(r => cur[r.i] += r.v);
  const inv = cur.reduce((a, x) => a + x, 0), T = inv + (cfg.caixa ? Math.max(0, cx) : 0), p = dados.ct && dados.ct.p != null ? +dados.ct.p : 50, alvo = ctAloc(p);
  return { H, R, cx, cur, T, p, alvo, dev: cur.map((x, i) => T ? x / T * 100 - alvo[i] : 0), pr };
}
async function plano(env, E, cfg) {
  const { H, cur, T, alvo, cx } = E, vend = [], comp = [], apl = [], resg = [], av = [];
  const maxDev = Math.max(0, ...E.dev.map(Math.abs)), parado = cfg.caixa && cx >= Math.max(50, T * 0.03);
  const vazio = { vend, comp, apl, resg, av, maxDev, parado, gasto: 0, receita: 0 };
  if (T < 50) return { ...vazio, dispara: false, av: ["O patrimônio ainda é pequeno para reajustar."] };
  const dispara = maxDev >= cfg.tol || parado;
  if (!dispara) return { ...vazio, dispara };
  let livre = cfg.caixa ? Math.max(0, cx) : 0;
  const vendido = CT_CLS.map(() => 0), lim = Math.max(20, T * cfg.tol / 200);
  CT_CLS.forEach((k, i) => {
    if (k.t) return;
    let exc = cur[i] - T * alvo[i] / 100; if (exc < lim) return;
    E.R.filter(x => x.i === i && x.diaria && x.liq > 0 && x.v > 0).sort((a, b) => b.v - a.v).forEach(x => {
      if (exc < 1) return;
      const f = Math.min(1, exc / x.v), rec = Math.floor(x.liq * f * 100) / 100;
      resg.push({ id: x.id, nome: x.nome, f, recebe: rec, i }); livre += rec; vendido[i] += x.v * f; exc -= x.v * f;
    });
    if (exc >= lim) av.push(`${k.n}: o restante acima do alvo (${brl(exc)}) está em títulos com vencimento e não é resgatado automaticamente.`);
  });
  CT_CLS.forEach((k, i) => {
    if (!k.t) return;
    const exc = cur[i] - T * alvo[i] / 100; if (exc < lim) return;
    const hs = H.filter(h => h.i === i && h.ok && h.v > 0), tot = hs.reduce((a, h) => a + h.v, 0);
    hs.forEach(h => {
      let q = exc * h.v / tot / h.p; q = fracOk(h.t, h.moeda) ? Math.floor(q * 1e6) / 1e6 : Math.floor(q + 1e-9); q = Math.min(q, h.q);
      if (q > 0) { const v = q * h.p; vend.push({ t: h.t, q, p: h.p, tot: v, moeda: h.moeda, i }); livre += v; vendido[i] += v; }
    });
  });
  const falta = CT_CLS.map((k, i) => Math.max(0, T * alvo[i] / 100 - (cur[i] - vendido[i]))), soma = falta.reduce((a, x) => a + x, 0), f = soma > livre ? livre / Math.max(soma, 1e-9) : 1;
  const novos = [];
  for (let i = 0; i < CT_CLS.length; i++) if (CT_CLS[i].t && falta[i] * f >= 10 && !H.some(h => h.i === i && h.ok)) novos.push(...CT_CLS[i].t.slice(0, 3));
  const precosT = Object.assign({}, E.pr, novos.length ? await precos(env, novos) : {});
  for (let i = 0; i < CT_CLS.length; i++) {
    const amt = falta[i] * f, k = CT_CLS[i];
    if (amt < 10) continue;
    if (!k.t) { apl.push({ ...CT_RF[i === 0 ? 0 : 1], v: Math.floor(amt * 100) / 100, i }); continue; }
    let tks = H.filter(h => h.i === i && h.ok).map(h => h.t); if (!tks.length) tks = k.t.slice(0, 3);
    const lst = tks.filter(t => precosT[t] && precosT[t].preco > 0 && (fracOk(t, precosT[t].moeda) || precosT[t].preco <= amt));
    if (!lst.length) { av.push(`O valor para ${k.n.toLowerCase()} (${brl(amt)}) é menor que o preço de uma unidade (ou o preço não veio): ficou no saldo.`); continue; }
    const qs = {}; let sobra = amt;
    lst.forEach(t => { const p = precosT[t]; let q = amt / lst.length / p.preco; q = fracOk(t, p.moeda) ? Math.floor(q * 1e6) / 1e6 : Math.floor(q + 1e-9); qs[t] = q; sobra -= q * p.preco; });
    for (let n = 0; n < 300; n++) {
      const pode = lst.filter(t => !fracOk(t, precosT[t].moeda) && precosT[t].preco <= sobra + 1e-9); if (!pode.length) break;
      pode.sort((a, b) => qs[a] * precosT[a].preco - qs[b] * precosT[b].preco); qs[pode[0]]++; sobra -= precosT[pode[0]].preco;
    }
    lst.forEach(t => { const q = qs[t]; if (q > 0) comp.push({ t, q, p: precosT[t].preco, tot: q * precosT[t].preco, moeda: precosT[t].moeda, i }); });
  }
  return { vend, comp, apl, resg, av, dispara, maxDev, parado, gasto: comp.reduce((a, x) => a + x.tot, 0) + apl.reduce((a, x) => a + x.v, 0), receita: vend.reduce((a, x) => a + x.tot, 0) + resg.reduce((a, x) => a + x.recebe, 0) };
}
function executa(dados, P, cx) {
  if (P.gasto > cx + P.receita + 0.01) throw new Error("Saldo insuficiente para o reajuste.");
  const L = (dados.sim_lanc = dados.sim_lanc || []), Rf = (dados.sim_rf = dados.sim_rf || []), hj = hojeISO(), iso = new Date().toISOString(), ag = Date.now();
  P.resg.forEach(o => {
    const x = Rf.find(y => y.id === o.id); if (!x || x.resg) return;
    if (o.f >= 0.999) { Object.assign(x, { resg: hj, rts: ag, vresg: o.recebe, rj: 1 }); return; }
    const novoV = Math.round(x.v * (1 - o.f) * 100) / 100, parte = Math.round((x.v - novoV) * 100) / 100; x.v = novoV;
    Rf.push({ id: novoId(), nome: x.nome, idx: x.idx, taxa: x.taxa, d: x.d, ts: x.ts, v: parte, venc: x.venc || "", isento: !!x.isento, resg: hj, rts: ag, vresg: o.recebe, rj: 1 });
  });
  P.vend.forEach(o => L.push({ id: novoId(), t: o.t, d: hj, h: iso, tipo: "V", q: o.q, p: o.p, tx: 0, moeda: o.moeda, rj: 1 }));
  P.comp.forEach(o => L.push({ id: novoId(), t: o.t, d: hj, h: iso, tipo: "C", q: o.q, p: o.p, tx: 0, moeda: o.moeda, rj: 1 }));
  P.apl.forEach(a => Rf.push({ id: novoId(), nome: a.nome, idx: a.idx, taxa: a.taxa, d: hj, ts: ag, v: a.v, venc: "", isento: false, rj: 1 }));
}
function contexto(E, P, cfg) {
  const pct = v => v.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%";
  let t = `Carteira simulada (perfil ${E.p}/100, ${ctPerfil(E.p)}). Patrimônio considerado ${brl(E.T)}; saldo parado ${brl(E.cx)}.\nClasse: atual x alvo\n`;
  CT_CLS.forEach((k, i) => { t += `- ${k.n}: ${pct(E.T ? E.cur[i] / E.T * 100 : 0)} x ${E.alvo[i]}%\n`; });
  t += "Ativos: " + E.H.map(h => `${h.t} ${brl(h.v)}${h.resp != null ? " (" + (h.resp >= 0 ? "+" : "") + pct(h.resp) + " desde a compra)" : ""}`).join("; ") + "\n";
  const ords = [].concat(P.resg.map(o => `resgatar ${brl(o.recebe)} de ${o.nome}`), P.vend.map(o => `vender ${qtd(o.q)} ${o.t}`), P.comp.map(o => `comprar ${qtd(o.q)} ${o.t}`), P.apl.map(a => `aplicar ${brl(a.v)} em ${a.nome}`));
  if (P.dispara && !ords.length) t += "Não foi possível montar ordens agora" + (P.av.length ? ": " + P.av.join(" ") : ".") + "\n";
  else if (P.dispara) t += "Reajuste calculado: " + ords.join("; ") + "\n";
  else t += `A carteira está dentro da tolerância de ${cfg.tol} pontos percentuais.\n`;
  return t;
}

// ---------- Telegram ----------
async function telegram(env, chat, texto) {
  if (!env.TELEGRAM_TOKEN || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: texto.slice(0, 4000), disable_web_page_preview: true }),
  });
  return r.ok;
}

// ---------- uma conferência da carteira de uma pessoa ----------
async function conferir(env, sub, reg, ia, forcar) {
  const rt = await decifra(env, reg.rt);
  const tok = await gToken(env, rt);
  const fid = await driveAchar(tok);
  if (!fid) throw new Error("Ainda não há dados da carteira no Google Drive. Abra o app com a conta Google uma vez.");
  const arq = await driveLer(tok, fid), dados = (arq && arq.dados) || {};
  const cfg = Object.assign({ on: false, modo: "avisar", freq: "semanal", tol: 5, caixa: true, ia: true, notif: true }, dados.rj_cfg || {});
  if (!cfg.on && !forcar) return { pulou: "O reajuste automático está desativado no app." };
  const E = await estado(env, dados, cfg), P = await plano(env, E, cfg);
  let dicas = "";
  if (cfg.ia && ia && env.GROQ_KEY) {
    try {
      const q = "Você é o assistente de carteira do Investe.AI, um simulador educativo. Com os dados abaixo, dê de 3 a 4 dicas curtas e práticas sobre a carteira (uma frase cada, numeradas), incluindo se o reajuste calculado faz sentido. Não prometa retorno e não use emojis.\n\n" + contexto(E, P, cfg);
      dicas = (await ia(env, "Você é um assistente educativo de investimentos para brasileiros. Responda em português do Brasil.", [{ role: "user", content: q }])).texto.trim().slice(0, 1500);
    } catch (e) { }
  }
  const n = P.resg.length + P.vend.length + P.comp.length + P.apl.length;
  let exec = false, erro = "";
  if (P.dispara && cfg.modo === "auto" && n) { try { executa(dados, P, E.cx); exec = true; } catch (e) { erro = e.message; } }
  const resumo = exec ? `Carteira reajustada na nuvem: ${n} ordem(ns) executada(s) no simulador.`
    : P.dispara ? (P.parado && P.maxDev < cfg.tol ? `Você tem ${brl(E.cx)} parado no saldo.` : `Sua carteira saiu do perfil em até ${P.maxDev.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} pontos.`) + (n ? ` Sugestão: ${n} ordem(ns) de reajuste.` : "")
    : "Sua carteira está equilibrada com o seu perfil.";
  const H = Array.isArray(dados.rj_hist) ? dados.rj_hist : [];
  H.unshift({ id: novoId(), ts: Date.now(), nuvem: true, dispara: P.dispara, exec, erro, maxDev: P.maxDev, resumo, dicas,
    resg: P.resg.map(o => [o.nome, o.recebe]), vend: P.vend.map(o => [o.t, o.q, o.p]), comp: P.comp.map(o => [o.t, o.q, o.p]), apl: P.apl.map(a => [a.nome, a.v]),
    av: P.av, cur: E.cur.map(x => E.T ? x / E.T * 100 : 0), alvo: E.alvo });
  dados.rj_hist = H.slice(0, 30);
  dados.rj_ult = Date.now();
  await driveGravar(tok, fid, { atualizado: Date.now() / 1000, dados });
  if (cfg.notif && reg.chat) {
    const linhas = [exec ? "Carteira reajustada" : P.dispara ? "Hora de reajustar a carteira" : "Dica da IA para a sua carteira", resumo];
    const ords = [].concat(P.resg.map(o => `Resgatar ${brl(o.recebe)} de ${o.nome}`), P.vend.map(o => `Vender ${qtd(o.q)} ${o.t}`), P.comp.map(o => `Comprar ${qtd(o.q)} ${o.t}`), P.apl.map(a => `Aplicar ${brl(a.v)} em ${a.nome}`));
    if (ords.length) linhas.push((exec ? "Ordens executadas:\n" : "Ordens sugeridas:\n") + ords.map(x => "- " + x).join("\n"));
    if (dicas) linhas.push("Dicas da IA:\n" + dicas.replace(/\*\*/g, ""));
    if (!exec && P.dispara && n) linhas.push("Para aplicar, abra o Investe.AI > Minha carteira > Reajuste automático.");
    await telegram(env, reg.chat, linhas.join("\n\n")).catch(() => { });
  }
  return { resumo, exec, dispara: P.dispara, freq: cfg.freq };
}

// ---------- tarefa agendada: confere quem está na hora (uma pessoa por execução, a cada 15 minutos, por causa dos limites do plano gratuito) ----------
export async function nuvemAgendado(env, { groq }) {
  if (!env.NUVEM || !env.GOOGLE_CLIENT_SECRET) return;
  const agora = Date.now(), lst = await env.NUVEM.list({ prefix: "u:" });
  const devidos = [];
  for (const k of lst.keys) { const m = k.metadata || {}; if (!m.prox || m.prox <= agora) devidos.push(k.name); }
  for (const nome of devidos.slice(0, 1)) {
    const reg = await env.NUVEM.get(nome, "json"); if (!reg) continue;
    const sub = nome.slice(2);
    let prox = agora + FREQ.semanal, res = null;
    try {
      res = await conferir(env, sub, reg, groq, false);
      prox = agora + (FREQ[res.freq] || FREQ.semanal);
      reg.ult = agora; reg.res = res.resumo || res.pulou || ""; reg.erro = "";
      if (res.pulou) prox = agora + 6 * 3600e3;  // reajuste desligado no app: olha de novo em 6 horas
    } catch (e) {
      reg.erro = String(e.message || e).slice(0, 300); prox = agora + (e.expirou ? 7 * DIA : 3 * 3600e3);
      if (e.expirou && reg.chat) await telegram(env, reg.chat, "Investe.AI: " + reg.erro).catch(() => { });
    }
    reg.prox = prox;
    await env.NUVEM.put(nome, JSON.stringify(reg), { metadata: { prox } });
  }
}

// ---------- rotas chamadas pelo app (com a autorização do Google) e pelo Telegram ----------
export async function nuvemRotas(req, env, url, { json, groq }) {
  if (!env.NUVEM || !env.GOOGLE_CLIENT_SECRET) return json({ erro: "O reajuste na nuvem ainda não foi configurado no servidor." }, 503);
  const p = url.pathname;
  if (p.startsWith("/tg/")) return tgWebhook(req, env, url, json);
  if (req.method !== "POST") return json({ erro: "Não encontrado." }, 404);
  if (env.APP_TOKEN && req.headers.get("x-app-token") !== env.APP_TOKEN) return json({ erro: "Acesso negado." }, 403);
  if (p === "/nuvem/configurar-telegram") {  // chamado pela publicação (GitHub Actions) depois de cada deploy
    if (!env.TELEGRAM_TOKEN) return json({ ok: false, erro: "Sem TELEGRAM_TOKEN." });
    const seg = await hashHex(env.TELEGRAM_TOKEN, 32);
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${url.origin}/tg/${seg}`, allowed_updates: ["message"], drop_pending_updates: true }),
    });
    return json({ ok: r.ok, telegram: await r.json().catch(() => null) });
  }
  let d; try { d = await req.json(); } catch { return json({ erro: "Pedido inválido." }, 400); }
  const rt = String(d.rt || "");
  if (!rt) return json({ erro: "Entre com o Google no app para usar a nuvem." }, 400);
  let tok, conta;
  try { tok = await gToken(env, rt); conta = await gConta(tok); } catch (e) { return json({ erro: e.message }, 401); }
  const chaveU = "u:" + conta.sub;
  let reg = await env.NUVEM.get(chaveU, "json");
  const bot = env.TELEGRAM_BOT || "";
  const estadoOut = r => ({ ok: true, ativo: !!r, telegram: !!(r && r.chat), bot, link: r && bot && !r.chat ? `https://t.me/${bot}?start=${r.cod}` : "", ult: r?.ult || 0, prox: r?.prox || 0, res: r?.res || "", erro: r?.erro || "" });
  if (p === "/nuvem/estado") return json(estadoOut(reg));
  if (p === "/nuvem/ativar") {
    const cod = reg?.cod || (await hashHex(conta.sub + "|" + Date.now() + "|" + Math.random(), 16));
    const prox = reg?.prox && reg.prox > Date.now() ? reg.prox : Date.now() + 60e3;
    reg = Object.assign(reg || {}, { rt: await cifra(env, rt), nome: conta.nome, cod, desde: reg?.desde || Date.now(), prox });
    await env.NUVEM.put(chaveU, JSON.stringify(reg), { metadata: { prox } });
    await env.NUVEM.put("c:" + cod, conta.sub);
    return json(estadoOut(reg));
  }
  if (p === "/nuvem/desativar") {
    if (reg) { await env.NUVEM.delete(chaveU); if (reg.cod) await env.NUVEM.delete("c:" + reg.cod); if (reg.chat) await telegram(env, reg.chat, "Investe.AI: o reajuste na nuvem foi desativado. Você não vai mais receber avisos aqui.").catch(() => { }); }
    return json(estadoOut(null));
  }
  if (p === "/nuvem/conferir") {  // "Conferir agora na nuvem" (teste pelo app)
    if (!reg) return json({ erro: "Ative a nuvem primeiro." }, 400);
    try {
      const res = await conferir(env, conta.sub, reg, groq, true);
      reg.ult = Date.now(); reg.res = res.resumo || res.pulou || ""; reg.erro = "";
      reg.prox = Date.now() + (FREQ[res.freq] || FREQ.semanal);
      await env.NUVEM.put(chaveU, JSON.stringify(reg), { metadata: { prox: reg.prox } });
      return json({ ...estadoOut(reg), resumo: reg.res });
    } catch (e) { return json({ erro: e.message }, 502); }
  }
  return json({ erro: "Não encontrado." }, 404);
}

async function tgWebhook(req, env, url, json) {
  if (!env.TELEGRAM_TOKEN || url.pathname !== "/tg/" + (await hashHex(env.TELEGRAM_TOKEN, 32))) return json({ erro: "Não encontrado." }, 404);
  const u = await req.json().catch(() => ({})), msg = u.message || {}, chat = msg.chat?.id, txt = String(msg.text || "").trim();
  if (!chat) return json({ ok: true });
  const m = txt.match(/^\/start\s+([0-9a-f]{16})$/i);
  if (m) {
    const sub = await env.NUVEM.get("c:" + m[1].toLowerCase());
    const reg = sub && (await env.NUVEM.get("u:" + sub, "json"));
    if (!reg) { await telegram(env, chat, "Este link não vale mais. No app, abra Minha carteira > Reajuste automático e toque de novo em Receber avisos no Telegram."); return json({ ok: true }); }
    reg.chat = chat;
    await env.NUVEM.put("u:" + sub, JSON.stringify(reg), { metadata: { prox: reg.prox || Date.now() } });
    await telegram(env, chat, `Pronto${reg.nome ? ", " + reg.nome : ""}! A partir de agora você recebe aqui os avisos do reajuste da sua carteira do Investe.AI, mesmo com o app fechado.\n\nPara parar, envie /parar.`);
    return json({ ok: true });
  }
  if (/^\/parar/i.test(txt)) {
    let achou = false;
    for (const k of (await env.NUVEM.list({ prefix: "u:" })).keys) {
      const reg = await env.NUVEM.get(k.name, "json");
      if (reg && reg.chat === chat) { delete reg.chat; await env.NUVEM.put(k.name, JSON.stringify(reg), { metadata: { prox: reg.prox || Date.now() } }); achou = true; }
    }
    await telegram(env, chat, achou ? "Combinado, você não vai mais receber avisos aqui. O reajuste na nuvem continua funcionando; para desligar tudo, use o app." : "Não há avisos ligados para esta conversa.");
    return json({ ok: true });
  }
  await telegram(env, chat, "Olá! Eu envio os avisos do reajuste automático da carteira do Investe.AI. Para ligar, abra o app em Minha carteira > Reajuste automático e toque em Receber avisos no Telegram.");
  return json({ ok: true });
}
