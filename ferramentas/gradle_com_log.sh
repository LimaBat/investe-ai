#!/bin/bash
# Roda o gradle e, se falhar, mostra o fim do log como anotação de erro (visível na página da execução).
gradle "$@" > gradle.log 2>&1
cod=$?
tail -120 gradle.log
if [ $cod -ne 0 ]; then
  msg=$(grep -E "What went wrong|Error|error:|FAILURE|Caused by|> " gradle.log | grep -v "^> Task" | head -60 | cut -c1-300)
  msg="${msg//'%'/'%25'}"; msg="${msg//$'\n'/'%0A'}"; msg="${msg//$'\r'/'%0D'}"
  echo "::error title=Gradle falhou::${msg}"
fi
exit $cod
