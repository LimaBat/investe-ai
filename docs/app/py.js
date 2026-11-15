// Investe.AI no navegador: o programa em Python roda aqui (Web Worker + Pyodide), fora da tela, para ela não travar.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
let py = null, sincT = null;
const progresso = (pct, msg) => postMessage({ tipo: "progresso", pct, msg });

async function texto(arq) {
  const r = await fetch(arq + "?v=" + (self.VERSAO_WEB || Date.now()), { cache: "no-cache" });
  if (!r.ok) throw new Error("Não consegui baixar " + arq + " (" + r.status + ")");
  return r.text();
}

async function iniciar(proxy, versao) {
  self.VERSAO_WEB = versao;
  progresso(6, "Baixando o Python");
  importScripts(PYODIDE + "pyodide.js");
  py = await loadPyodide({ indexURL: PYODIDE });
  progresso(30, "Baixando os componentes");
  await py.loadPackage(["micropip", "numpy", "pandas", "requests"]);
  progresso(55, "Instalando as bibliotecas de mercado");
  const micropip = py.pyimport("micropip");
  await micropip.install(["beautifulsoup4", "pytz", "python-dateutil", "platformdirs", "multitasking", "frozendict", "websockets", "protobuf", "tzdata"]);
  await micropip.install.callKwargs(["feedparser", "yfinance"], { deps: false });
  progresso(70, "Abrindo os seus dados");
  py.FS.mkdirTree("/dados");
  py.FS.mount(py.FS.filesystems.IDBFS, {}, "/dados");
  await new Promise(ok => py.FS.syncfs(true, () => ok()));
  py.FS.mkdirTree("/app");
  const [peewee, sgml, inicio, codigo] = await Promise.all(["peewee.py", "sgmllib.py", "web_inicio.py", "investe_ai.py"].map(texto));
  py.FS.writeFile("/app/peewee.py", peewee);
  py.FS.writeFile("/app/sgmllib.py", sgml);
  py.FS.writeFile("/app/web_inicio.py", inicio);
  py.runPython("import sys\nif '/app' not in sys.path: sys.path.insert(0, '/app')");
  progresso(82, "Iniciando o Investe.AI");
  const web = py.pyimport("web_inicio");
  const v = web.iniciar(proxy, "/dados", codigo);
  self.web = web;
  postMessage({ tipo: "pronto", versao: String(v) });
}

function guardar() {  // grava os dados do programa no navegador (IndexedDB) pouco depois de cada mudança
  clearTimeout(sincT);
  sincT = setTimeout(() => py.FS.syncfs(false, () => { }), 1500);
}

onmessage = async ev => {
  const m = ev.data || {};
  if (m.tipo === "iniciar") {
    try { await iniciar(m.proxy, m.versao); }
    catch (e) { postMessage({ tipo: "falha", msg: String(e && e.message || e).slice(0, 600) }); }
    return;
  }
  if (m.tipo === "pedido") {
    let res;
    try {
      const r = self.web.atender(m.metodo, m.caminho, m.corpo || "");
      const status = r.get(0), ctype = r.get(1), b = r.get(2), buf = b.getBuffer();
      const u8 = new Uint8Array(buf.data);  // cópia dos bytes da resposta
      buf.release(); b.destroy(); r.destroy();
      res = { tipo: "resposta", id: m.id, status, ctype, corpo: u8.buffer };
      postMessage(res, [u8.buffer]);
    } catch (e) {
      postMessage({ tipo: "resposta", id: m.id, status: 500, ctype: "application/json", corpo: new TextEncoder().encode(JSON.stringify({ erro: "Erro interno: " + String(e.message || e).slice(0, 200) })).buffer });
    }
    if (m.metodo === "POST") guardar();
  }
};
