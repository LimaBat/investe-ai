// Servidor de teste da versão para navegador: serve a pasta docs/ (como o GitHub Pages) em :8080
// e roda o intermediário (proxy-ia/worker.js, o mesmo da Cloudflare) em :8788.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import worker from "../proxy-ia/worker.js";

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "docs");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".py": "text/x-python; charset=utf-8", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const arq = path.join(RAIZ, p);
  if (!arq.startsWith(RAIZ) || !fs.existsSync(arq)) { res.writeHead(404); return res.end("não encontrado"); }
  res.writeHead(200, { "content-type": TIPOS[path.extname(arq)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(arq).pipe(res);
}).listen(8080, "127.0.0.1", () => console.log("site em http://127.0.0.1:8080/"));

http.createServer(async (req, res) => {
  const partes = [];
  for await (const c of req) partes.push(c);
  const corpo = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(partes);
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (!["host", "connection", "content-length"].includes(k)) h.set(k, Array.isArray(v) ? v.join(", ") : v);
  try {
    const r = await worker.fetch(new Request("http://127.0.0.1:8788" + req.url, { method: req.method, headers: h, body: corpo }), {}, { waitUntil() { } });
    const cab = {}; r.headers.forEach((v, k) => { cab[k] = v; });
    delete cab["content-encoding"]; delete cab["content-length"];
    res.writeHead(r.status, cab);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(8788, "127.0.0.1", () => console.log("intermediário em http://127.0.0.1:8788/"));
