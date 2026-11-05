# Investe.AI: como publicar o programa para qualquer pessoa baixar

Este projeto gera automaticamente, na nuvem do GitHub e de graça:

- **Investe.AI.exe**: Windows. Um arquivo só, com o Python e tudo dentro. Não instala nada, abre com dois cliques e cria o atalho com o ícone.
- **Investe.AI-mac.zip**: o app para Mac.
- **Investe.AI.bat**: a versão leve de antes, que instala o Python sozinha.

A IA funciona por um **intermediário na nuvem (Cloudflare)**. As chaves do Groq e do Gemini ficam só lá, nunca dentro dos arquivos baixados. O programa também **se atualiza sozinho** quando você publica uma versão nova.

Faça os passos na ordem. Leva cerca de 30 minutos na primeira vez.

---

## 1. Criar o intermediário da IA (Cloudflare, grátis)

1. Crie uma conta grátis em https://dash.cloudflare.com/sign-up
2. Instale o **Node.js** (versão LTS) em https://nodejs.org
3. Abra o **Prompt de Comando** na pasta `proxy-ia` deste projeto e rode, um por vez:

   ```
   npx wrangler login
   npx wrangler secret put GROQ_KEY
   npx wrangler secret put GEMINI_KEY
   npx wrangler secret put APP_TOKEN
   npx wrangler deploy
   ```

   - Em `GROQ_KEY`, cole a sua chave do Groq (`gsk_...`).
   - Em `GEMINI_KEY`, cole a chave do Gemini. Ela é opcional: serve de reserva quando o Groq falhar e para a "Pesquisa no Google".
   - Em `APP_TOKEN`, invente uma senha qualquer (por exemplo, `investe-2026-xyz`) e **anote**.

4. O `deploy` mostra um endereço parecido com `https://investe-ai-ia.SEU-NOME.workers.dev`. **Anote.**
5. Teste abrindo `https://investe-ai-ia.SEU-NOME.workers.dev/saude` no navegador. Deve aparecer `{"ok":true,"groq":true,...}`.

O intermediário limita cada pessoa a 20 perguntas por minuto. Se o `deploy` reclamar do bloco `[[ratelimits]]` no `wrangler.toml`, apague esse bloco e rode o `deploy` de novo.

## 2. Colocar o projeto no GitHub

1. Crie uma conta em https://github.com e um repositório novo, por exemplo `investe-ai`. Pode ser público: não há chave nenhuma nos arquivos.
2. Envie **todos os arquivos desta pasta**, inclusive a pasta oculta `.github`:
   - **Pelo site:** "Add file" > "Upload files", arrastando as pastas.
   - **Pelo GitHub Desktop:** https://desktop.github.com
3. No repositório, vá em **Settings > Secrets and variables > Actions > New repository secret** e crie:
   - `IA_PROXY_URL`: o endereço do passo 1, por exemplo `https://investe-ai-ia.SEU-NOME.workers.dev`
   - `IA_PROXY_TOKEN`: a senha do `APP_TOKEN`

## 3. Publicar uma versão

1. No repositório: **Releases > Draft a new release**.
2. Em "Choose a tag", digite `v3.1` (depois `v3.2`, `v3.3`...) e confirme "Create new tag".
3. Escreva um título e uma descrição curta do que mudou. A primeira linha da descrição aparece no aviso de atualização dentro do programa.
4. Clique em **Publish release**.
5. Em uns 10 minutos, a aba **Actions** termina. A release passa a ter os 3 arquivos. Durante esse processo, o .exe é aberto e testado automaticamente.

**Link para as pessoas baixarem** (sempre a versão mais nova):

```
https://github.com/SEU-USUARIO/investe-ai/releases/latest/download/Investe.AI.exe
```

## 4. Atualizações

- Quem já tem o programa vê o aviso **"Nova versão disponível"** na próxima vez que abrir (a verificação é feita a cada 3 horas). No Windows, um clique baixa, troca o programa e reabre. No Mac, o aviso abre a página para baixar.
- Também dá para verificar a qualquer momento em **Conta > Versão > Verificar atualizações**.
- **O número da tag precisa ser sempre maior que o anterior.** O programa compara `v3.1` com `v3.2` e assim por diante.

## 5. Assinatura digital (remove o aviso do Windows)

Sem assinatura, na primeira vez o Windows mostra "O Windows protegeu o computador". A pessoa clica em **Mais informações > Executar assim mesmo**. O aviso tende a sumir conforme o programa ganha downloads.

Para tirar o aviso de vez, é preciso um **certificado de assinatura de código**, que é pago. Opções:

- comprar de uma autoridade certificadora;
- usar o **Azure Trusted Signing** da Microsoft;
- se o projeto for de código aberto, o **SignPath Foundation**, que é gratuito para projetos abertos.

Com um certificado `.pfx` em mãos, crie dois segredos no GitHub. A partir daí, a assinatura é feita automaticamente.

- `WINDOWS_CERT_PFX_BASE64`: o arquivo `.pfx` convertido para texto. No PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard`
- `WINDOWS_CERT_SENHA`: a senha do `.pfx`

No **Mac**, como o app não é assinado pela Apple, na primeira vez a pessoa clica com o botão direito no app > **Abrir** > **Abrir**.

## Gerar o .exe no seu próprio computador (opcional)

Com o Python instalado, dê dois cliques em `gerar_exe.bat`. O arquivo sai em `dist\Investe.AI.exe`.

Para ele usar o intermediário, antes de rodar defina no mesmo Prompt de Comando:

```
set IA_PROXY_URL=https://investe-ai-ia.SEU-NOME.workers.dev
set IA_PROXY_TOKEN=sua-senha
set ATUALIZA_REPO=SEU-USUARIO/investe-ai
gerar_exe.bat
```

## O que tem em cada arquivo

| Arquivo | Para que serve |
|---|---|
| `investe_ai.py` | O programa inteiro (servidor local, telas, carteira, simulador, IA) |
| `ferramentas/preparar.py` | Coloca a versão, o intermediário e o repositório no código antes de empacotar |
| `ferramentas/lancador.txt` | O começo do `.bat` (acha ou instala o Python) |
| `gerar_exe.bat` | Gera o `.exe` no seu computador |
| `.github/workflows/publicar.yml` | Gera, testa e publica o `.exe`, o app de Mac e o `.bat` a cada release |
| `proxy-ia/` | O intermediário da IA (Cloudflare Worker) |
| `investe-ai.ico` / `.png` | Ícone do programa |
