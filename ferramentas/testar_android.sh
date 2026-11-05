#!/bin/bash
# Testa o APK no emulador: abre o app, espera o servidor do celular responder e confere cotações reais.
APK=android/app/build/outputs/apk/debug/app-debug.apk
logs() { echo "----- logcat -----"; adb logcat -d | grep -iE "python|InvesteAI|chaquo|AndroidRuntime|FATAL" | tail -250; }
adb install -r "$APK" || { echo "falha ao instalar"; exit 1; }
adb shell am start -n ai.investe.app/.MainActivity
adb forward tcp:47615 tcp:47615
ok=0
for i in $(seq 1 100); do
  if curl -s -m 3 http://127.0.0.1:47615/api/ping | grep -q '"ok"'; then ok=1; echo "servidor respondeu após ~$((i*3))s"; break; fi
  sleep 3
done
if [ "$ok" != 1 ]; then echo "O servidor do app não respondeu"; logs; exit 1; fi
curl -s -m 10 -o /dev/null -w "página inicial: HTTP %{http_code}\n" http://127.0.0.1:47615/
curl -s -m 90 "http://127.0.0.1:47615/api/cotacoes?brl=1&tickers=PETR4,AAPL,BTC" > cotacoes.json
cat cotacoes.json; echo
curl -s -m 60 "http://127.0.0.1:47615/api/preco?t=PETR4"; echo
python3 - <<'PY' || { logs; exit 1; }
import json
j = json.load(open("cotacoes.json"))
ok = [i["ticker"] for i in j.get("itens", []) if not i.get("erro") and i.get("preco")]
print("cotações reais obtidas no celular:", ok)
raise SystemExit(0 if len(ok) >= 2 else 1)
PY
logs | tail -40
echo "TESTE DO ANDROID OK"
