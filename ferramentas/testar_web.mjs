// Abre a versão para navegador num Chrome de verdade e confere: o Python inicia, a tela abre e chegam cotações reais.
import { chromium } from "playwright";
const URL_APP = "http://127.0.0.1:8080/app/?proxy=" + encodeURIComponent("http://127.0.0.1:8788");
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
const logs = [];
p.on("console", m => logs.push("[página] " + m.text()));
p.on("pageerror", e => logs.push("[erro na página] " + e.message));
p.on("worker", w => w.on("console", m => logs.push("[python] " + m.text())));
const t0 = Date.now();
let ok = false, motivo = "";
try {
  await p.goto(URL_APP);
  await p.waitForFunction(() => {
    const e = document.getElementById("erro"); if (e && e.style.display === "block") throw new Error("falha: " + e.textContent);
    const f = document.getElementById("app"); return !!(f && f.contentDocument && f.contentDocument.querySelector("nav button[data-v=invest]"));
  }, null, { timeout: 300000, polling: 1000 });
  console.log("tela do app aberta em", Math.round((Date.now() - t0) / 1000), "s");
  const cot = await p.evaluate(async () => (await window.__pyFetch("/api/cotacoes?brl=1&tickers=PETR4,AAPL,BTC")).json());
  console.log("cotações:", JSON.stringify(cot).slice(0, 600));
  const itens = (cot.itens || cot.cotacoes || Object.values(cot)).filter?.(x => x && (x.preco || x.price) > 0) || [];
  const macro = await p.evaluate(async () => (await window.__pyFetch("/api/macro")).json());
  console.log("macro:", JSON.stringify(macro).slice(0, 300));
  await p.frameLocator("#app").locator("nav button[data-v=invest]").click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: "web-teste.png" });
  ok = itens.length >= 2;
  if (!ok) motivo = "menos de 2 cotações reais";
} catch (e) { motivo = e.message; await p.screenshot({ path: "web-teste.png" }).catch(() => { }); }
console.log(logs.slice(-60).join("\n"));
await b.close();
if (!ok) { console.log("::error::Versão para navegador: " + motivo); process.exit(1); }
console.log("versão para navegador OK");
