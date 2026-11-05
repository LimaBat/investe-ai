"""Ponte Android do Investe.AI (Chaquopy).

Inicia o programa (investe_ai.py) dentro do app e faz o yfinance usar a rede do próprio Android
(HttpURLConnection), já que o curl_cffi não existe para Android e o Yahoo costuma barrar o TLS do Python.
"""
import datetime
import os
import runpy
import sys
import types
from http.client import HTTPMessage

import requests
from requests.adapters import BaseAdapter
from requests.models import Response
from requests.structures import CaseInsensitiveDict
from requests.utils import get_encoding_from_headers

UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Mobile Safari/537.36")
_PULAR = {"accept-encoding", "content-length", "connection", "host"}  # o Android cuida destes (e do gzip)


class _Bruto:
    """Imita o 'raw' do urllib3 o suficiente para o requests guardar os cookies (Set-Cookie)."""

    def __init__(self, msg):
        self._original_response = types.SimpleNamespace(msg=msg)

    def close(self):
        pass

    def release_conn(self):
        pass


class AdaptadorAndroid(BaseAdapter):
    def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
        from java.net import URL
        from java.io import ByteArrayOutputStream
        from java import jarray, jbyte
        ct, rt = timeout if isinstance(timeout, tuple) else (timeout, timeout)
        ct, rt = ct or 30, rt or 60
        t0 = datetime.datetime.now()
        try:
            con = URL(request.url).openConnection()
            con.setInstanceFollowRedirects(False)  # o requests segue os redirecionamentos (e guarda os cookies)
            con.setRequestMethod(request.method)
            con.setConnectTimeout(int(ct * 1000))
            con.setReadTimeout(int(rt * 1000))
            for k, v in request.headers.items():
                if k.lower() not in _PULAR:
                    con.setRequestProperty(k, v)
            corpo = request.body
            if corpo:
                if hasattr(corpo, "read"): corpo = corpo.read()
                if isinstance(corpo, str): corpo = corpo.encode("utf-8")
                con.setDoOutput(True)
                saida = con.getOutputStream()
                saida.write(corpo)
                saida.close()
            cod = int(con.getResponseCode())
            fluxo = con.getErrorStream() if cod >= 400 else con.getInputStream()
            dados = b""
            if fluxo is not None:
                bos, buf = ByteArrayOutputStream(), jarray(jbyte)(65536)
                while True:
                    n = fluxo.read(buf)
                    if n < 0: break
                    bos.write(buf, 0, n)
                fluxo.close()
                dados = bytes(bos.toByteArray())
            msg, cab = HTTPMessage(), CaseInsensitiveDict()
            campos = con.getHeaderFields()
            for chave in campos.keySet().toArray():
                if chave is None: continue  # linha de status
                vals = campos.get(chave)
                lst = [str(vals.get(i)) for i in range(vals.size())]
                for v in lst: msg[str(chave)] = v
                if str(chave).lower() != "content-encoding":
                    cab[str(chave)] = ", ".join(lst)
            motivo = con.getResponseMessage()
        except Exception as e:  # exceções do Java viram as do requests
            if "Timeout" in type(e).__name__:
                raise requests.exceptions.ReadTimeout(str(e), request=request)
            raise requests.exceptions.ConnectionError(str(e), request=request)
        r = Response()
        r.status_code, r.headers, r._content, r._content_consumed = cod, cab, dados, True
        r.url, r.request, r.reason = request.url, request, (str(motivo) if motivo is not None else "")
        r.encoding = get_encoding_from_headers(cab)
        r.raw, r.connection = _Bruto(msg), self
        r.elapsed = datetime.datetime.now() - t0
        return r

    def close(self):
        pass


class SessaoAndroid(requests.Session):
    def __init__(self, *a, **k):
        super().__init__()
        ad = AdaptadorAndroid()
        self.mount("https://", ad)
        self.mount("http://", ad)
        self.headers.update({"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"})


def preparar_yfinance(pasta):
    # o yfinance trata erros com nomes do curl_cffi (ex.: DNSError); com o requests eles não existem
    for nome, base in (("DNSError", requests.exceptions.ConnectionError), ("CertificateVerifyError", requests.exceptions.SSLError),
                       ("IncompleteRead", requests.exceptions.ChunkedEncodingError)):
        if not hasattr(requests.exceptions, nome):
            setattr(requests.exceptions, nome, base)
    import yfinance
    import yfinance._http as h
    h._backend = types.SimpleNamespace(Session=SessaoAndroid, exceptions=requests.exceptions)
    h._fallback_warned = True
    try:
        yfinance.set_tz_cache_location(os.path.join(pasta, "yf_cache"))
    except Exception:
        pass


def iniciar(pasta):
    os.environ["INVESTEAI_DADOS"] = pasta
    os.environ["INVESTEAI_ANDROID"] = "1"
    os.environ["YF_DISABLE_CURL_CFFI"] = "1"
    preparar_yfinance(pasta)
    sys.argv = ["investe_ai.py", "--no-window"]
    runpy.run_module("investe_ai", run_name="__main__", alter_sys=True)  # fica no servidor até o app ser encerrado
