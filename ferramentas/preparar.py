"""Gera build/investe_ai.py e build/Investe.AI.bat a partir de investe_ai.py, aplicando a configuração de distribuição.

Variáveis de ambiente (todas opcionais):
  VERSAO          ex.: 3.2 ou v3.2 (padrão: a que está no código)
  IA_PROXY_URL    endereço do intermediário de IA (proxy-ia). Quando preenchido, as chaves embutidas são REMOVIDAS.
  IA_PROXY_TOKEN  senha simples que o intermediário confere (a mesma do segredo APP_TOKEN do Cloudflare)
  IA_CHAVE_GROQ / IA_CHAVE_GEMINI  só para uso pessoal sem intermediário: embute as chaves no arquivo
  ATUALIZA_REPO   "usuario/repositorio" do GitHub para a atualização automática
"""
import os, re, sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(RAIZ, "investe_ai.py"), encoding="utf-8").read()


def troca_const(s, nome, valor):
    # aceita comentário no fim da linha (ex.: IA_CHAVE_GROQ = ""  # explicação)
    novo, n = re.subn(rf'^{nome} = "[^"\n]*"', lambda m: f'{nome} = "{valor}"', s, count=1, flags=re.M)
    if n != 1: sys.exit(f"não achei a constante {nome} no código")
    return novo


versao = (os.environ.get("VERSAO") or "").strip().lstrip("vV")
if versao: src = troca_const(src, "VERSAO", versao)
repo = (os.environ.get("ATUALIZA_REPO") or "").strip()
if repo: src = troca_const(src, "ATUALIZA_REPO", repo)
proxy = (os.environ.get("IA_PROXY_URL") or "").strip().rstrip("/")
if proxy:
    src = troca_const(src, "IA_PROXY_URL", proxy)
    src = troca_const(src, "IA_PROXY_TOKEN", (os.environ.get("IA_PROXY_TOKEN") or "").strip())
    src = troca_const(src, "IA_CHAVE_PADRAO", "")
    src = troca_const(src, "IA_CHAVE_GROQ", "")
    print("IA pelo intermediário:", proxy, "(chaves removidas do arquivo)")
else:
    # sem intermediário: só embute chaves se você passar (uso pessoal; quem tiver o arquivo consegue extraí-las)
    if os.environ.get("IA_CHAVE_GROQ"): src = troca_const(src, "IA_CHAVE_GROQ", os.environ["IA_CHAVE_GROQ"].strip())
    if os.environ.get("IA_CHAVE_GEMINI"): src = troca_const(src, "IA_CHAVE_PADRAO", os.environ["IA_CHAVE_GEMINI"].strip())
    if not (os.environ.get("IA_CHAVE_GROQ") or os.environ.get("IA_CHAVE_GEMINI")):
        print("AVISO: sem IA_PROXY_URL e sem chaves: a IA só funciona se a pessoa colocar a própria chave em Conta.")

os.makedirs(os.path.join(RAIZ, "build"), exist_ok=True)
with open(os.path.join(RAIZ, "build", "investe_ai.py"), "w", encoding="utf-8", newline="\n") as f:
    f.write(src)
lanc = open(os.path.join(RAIZ, "ferramentas", "lancador.txt"), encoding="utf-8").read()
bat = (lanc.rstrip("\n") + "\n" + src).replace("\r\n", "\n").replace("\n", "\r\n")
with open(os.path.join(RAIZ, "build", "Investe.AI.bat"), "wb") as f:
    f.write(bat.encode("utf-8"))
m = re.search(r'^VERSAO = "(.*)"$', src, re.M)
print("ok: build/investe_ai.py e build/Investe.AI.bat, versão", m.group(1) if m else "?")
