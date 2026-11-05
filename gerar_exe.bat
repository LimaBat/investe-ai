@echo off
rem Gera dist\Investe.AI.exe neste computador (precisa do Python 3.10 ou mais novo instalado).
rem Para a versão de distribuição, defina antes IA_PROXY_URL, IA_PROXY_TOKEN e ATUALIZA_REPO (veja LEIA-ME.md).
setlocal
cd /d "%~dp0"
set "PY=py -3"
%PY% --version >nul 2>&1 || set "PY=python"
%PY% -m pip install --upgrade pip pyinstaller pillow -r requirements.txt || goto :erro
%PY% ferramentas\preparar.py || goto :erro
%PY% -m PyInstaller --noconfirm --onefile --windowed --name Investe.AI --icon investe-ai.ico --collect-all yfinance --collect-all curl_cffi --collect-all webview --collect-data certifi build\investe_ai.py || goto :erro
echo.
echo  Pronto: dist\Investe.AI.exe
pause
exit /b 0
:erro
echo.
echo  Algo deu errado. Veja as mensagens acima.
pause
exit /b 1
