"""Investe.AI no navegador (Pyodide, dentro de um Web Worker).

Adapta o mesmo investe_ai.py do computador para o navegador:
- não há linhas de execução (threads): as tarefas paralelas rodam uma depois da outra;
- a internet sai pelo XMLHttpRequest do navegador e passa pelo intermediário (Cloudflare), porque o Yahoo,
  o Banco Central e as notícias não aceitam pedidos vindos de páginas web; os cookies vão e voltam pelo intermediário;
- não há servidor local: a página pede /api/... e este arquivo chama o mesmo Handler do programa, sem rede.
"""
import base64
import concurrent.futures as _cf
import datetime
import email.message
import io
import json
import os
import sys
import threading
import types
from http.client import HTTPMessage
from urllib.parse import quote

PROXY = ""  # definido por iniciar()

# ---------------------------------------------------------------- sem threads
class _ExecutorSequencial:
    def __init__(self, *a, **k): pass
    def submit(self, fn, *a, **k):
        f = _cf.Future()
        try: f.set_result(fn(*a, **k))
        except BaseException as e: f.set_exception(e)
        return f
    def map(self, fn, *iters, timeout=None, chunksize=1):
        return iter([fn(*x) for x in zip(*iters)])
    def shutdown(self, wait=True, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): self.shutdown(); return False


def _agenda(fn, ms=0):
    from js import setTimeout
    from pyodide.ffi import create_once_callable
    def roda():
        try: fn()
        except Exception as e: print("tarefa em segundo plano:", repr(e))
    setTimeout(create_once_callable(roda), int(ms))


def _thread_start(self):  # roda depois, quando o navegador estiver livre
    _agenda(self.run, 0)


class _Timer(threading.Thread):
    def __init__(self, interval, function, args=None, kwargs=None):
        super().__init__()
        self.interval, self.function, self.args, self.kwargs, self._cancelado = interval, function, args or [], kwargs or {}, False
    def cancel(self): self._cancelado = True
    def start(self): _agenda(lambda: None if self._cancelado else self.function(*self.args, **self.kwargs), self.interval * 1000)


_cf.ThreadPoolExecutor = _ExecutorSequencial
threading.Thread.start = _thread_start
threading.Timer = _Timer

# ---------------------------------------------------------------- internet pelo navegador
import requests
from requests.adapters import BaseAdapter
from requests.models import Response
from requests.structures import CaseInsensitiveDict
from requests.utils import get_encoding_from_headers

_PROIBIDOS = {"accept-encoding", "content-length", "connection", "host", "user-agent", "cookie", "origin", "referer", "te", "keep-alive"}


class _Bruto:
    def __init__(self, msg): self._original_response = types.SimpleNamespace(msg=msg)
    def close(self): pass
    def release_conn(self): pass


class AdaptadorWeb(BaseAdapter):
    def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
        from js import XMLHttpRequest, Uint8Array
        from pyodide.ffi import to_js
        url = request.url
        direto = bool(PROXY) and url.startswith(PROXY)  # o intermediário já aceita pedidos de páginas web
        alvo = url if direto else PROXY + "/web/p?u=" + quote(url, safe="")
        t0 = datetime.datetime.now()
        x = XMLHttpRequest.new()
        try:
            x.open(request.method.upper(), alvo, False)
            x.responseType = "arraybuffer"
            to = timeout[1] if isinstance(timeout, tuple) else timeout
            x.timeout = int((to or 60) * 1000)
            for k, v in request.headers.items():
                kl = k.lower()
                if kl == "cookie" and not direto: x.setRequestHeader("x-cookie", v)
                elif kl not in _PROIBIDOS: x.setRequestHeader(k, v)
            corpo = request.body
            if corpo:
                if hasattr(corpo, "read"): corpo = corpo.read()
                if isinstance(corpo, str): corpo = corpo.encode("utf-8")
                x.send(to_js(corpo))
            else:
                x.send()
        except Exception as e:
            if "timeout" in str(e).lower(): raise requests.exceptions.ReadTimeout(str(e), request=request)
            raise requests.exceptions.ConnectionError(str(e), request=request)
        if x.status == 0:
            raise requests.exceptions.ConnectionError("Sem conexão com " + url.split("/")[2], request=request)
        dados = bytes(Uint8Array.new(x.response).to_py()) if x.response else b""
        cab, msg = CaseInsensitiveDict(), HTTPMessage()
        for linha in (x.getAllResponseHeaders() or "").split("\r\n"):
            if ": " in linha:
                k, v = linha.split(": ", 1)
                if k.lower() not in ("content-encoding", "x-set-cookie", "x-location", "x-status") and not k.lower().startswith("access-control"):
                    cab[k] = v
        status = int(x.status)
        if not direto:
            st = x.getResponseHeader("x-status")
            if st: status = int(st)
            loc = x.getResponseHeader("x-location")
            if loc: cab["Location"] = loc
            sc = x.getResponseHeader("x-set-cookie")
            if sc:
                try:
                    for c in json.loads(base64.b64decode(sc).decode("utf-8")): msg["Set-Cookie"] = c
                except Exception:
                    pass
        r = Response()
        r.status_code, r.headers, r._content, r._content_consumed = status, cab, dados, True
        r.url, r.request, r.reason = url, request, ""
        r.encoding = get_encoding_from_headers(cab)
        r.raw, r.connection = _Bruto(msg), self
        r.elapsed = datetime.datetime.now() - t0
        return r

    def close(self): pass


_init_original = requests.Session.__init__


def _sessao_init(self, *a, **k):
    _init_original(self, *a, **k)
    ad = AdaptadorWeb()
    self.mount("https://", ad)
    self.mount("http://", ad)


requests.Session.__init__ = _sessao_init  # vale também para requests.get/post, que criam uma sessão por pedido


class SessaoWeb(requests.Session):
    def __init__(self, *a, **k):
        super().__init__()
        self.headers.update({"Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"})


def _preparar_yfinance(pasta):
    for nome, base in (("DNSError", requests.exceptions.ConnectionError), ("CertificateVerifyError", requests.exceptions.SSLError),
                       ("IncompleteRead", requests.exceptions.ChunkedEncodingError)):
        if not hasattr(requests.exceptions, nome): setattr(requests.exceptions, nome, base)
    import yfinance
    import yfinance._http as h
    h._backend = types.SimpleNamespace(Session=SessaoWeb, exceptions=requests.exceptions)
    h._fallback_warned = True
    try: yfinance.set_tz_cache_location(os.path.join(pasta, "yf_cache"))
    except Exception: pass
    _baixar = yfinance.download  # sem threads no navegador: baixa um ativo de cada vez
    yfinance.download = lambda *a, **k: _baixar(*a, **{**k, "threads": False})


# ---------------------------------------------------------------- o programa e a ponte página <-> Handler
APP = None


class _Srv:
    server_address = ("127.0.0.1", 47615)


def iniciar(proxy, pasta, codigo):
    global PROXY, APP
    PROXY = (proxy or "").rstrip("/")
    os.environ.update({"INVESTEAI_DADOS": pasta, "INVESTEAI_WEB": "1", "YF_DISABLE_CURL_CFFI": "1"})
    sys.argv = ["investe_ai.py", "--no-window"]
    _preparar_yfinance(pasta)
    mod = types.ModuleType("investe_ai")
    mod.__file__ = "/app/investe_ai.py"
    sys.modules["investe_ai"] = mod
    exec(compile(codigo, "investe_ai.py", "exec"), mod.__dict__)
    if PROXY and not getattr(mod, "IA_PROXY_URL", ""):
        mod.IA_PROXY_URL = PROXY
    APP = mod
    return getattr(mod, "VERSAO", "")


def atender(metodo, caminho, corpo):
    """Executa um pedido da página no Handler do programa e devolve (status, tipo, corpo em bytes)."""
    h = APP.Handler.__new__(APP.Handler)
    h.server, h.client_address, h.request_version = _Srv(), ("127.0.0.1", 0), "HTTP/1.1"
    h.command, h.path, h.requestline, h.close_connection = metodo, caminho, f"{metodo} {caminho} HTTP/1.1", True
    corpo = corpo.encode("utf-8") if isinstance(corpo, str) else bytes(corpo or b"")
    cab = email.message.Message()
    cab["Host"] = "127.0.0.1:47615"
    if corpo:
        cab["Content-Type"] = "application/json"
        cab["Content-Length"] = str(len(corpo))
    h.headers, h.rfile, h.wfile = cab, io.BytesIO(corpo), io.BytesIO()
    try:
        getattr(h, "do_" + metodo)()
    except Exception as e:
        APP.log("web " + caminho + ": " + repr(e))
        return 500, "application/json", json.dumps({"erro": "Erro interno. Tente de novo."}).encode()
    bruto = h.wfile.getvalue()
    topo, _, resto = bruto.partition(b"\r\n\r\n")
    linhas = topo.decode("latin-1").split("\r\n")
    try: status = int(linhas[0].split()[1])
    except Exception: status = 500
    tipo = next((l.split(": ", 1)[1] for l in linhas[1:] if l.lower().startswith("content-type: ")), "application/octet-stream")
    return status, tipo, resto
