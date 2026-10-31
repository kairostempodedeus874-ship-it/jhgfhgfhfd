# Node 22 (LTS) ja possui WebSocket nativo, entao o erro
# "Node.js 20 detected without native WebSocket support" nao acontece mais.
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV SESSION_DIR=/data/session

# Dependencias de sistema (certificados + git, necessarios para o Baileys)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Copia SOMENTE o package.json.
# Nenhum arquivo oculto (que comeca com ponto) e copiado aqui, porque
# esse tipo de arquivo muitas vezes NAO chega ao repositorio e o build
# quebra com: ".npmrc: not found".
COPY package.json ./

# Cria o .npmrc aqui dentro, no proprio build. Assim ele nunca falta.
RUN printf 'legacy-peer-deps=true\naudit=false\nfund=false\n' > .npmrc

# Instala as dependencias.
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps

# Valida as dependencias NO BUILD (mensagem clara em vez de log ilegivel no start).
# Inclui "ws", que e a rede de seguranca do WebSocket no Node.
RUN node -e "require('express'); require('qrcode'); require('pino'); require('ws'); require('@supabase/supabase-js'); require('@whiskeysockets/baileys'); console.log('[build] dependencias ok')"

# Copia o restante do codigo.
# Nao falha se algum arquivo do zip nao tiver sido enviado.
COPY . .

# Garante que o arquivo principal chegou no repositorio (erro claro no build)
RUN test -f index.cjs || (echo "[build] ERRO: index.cjs nao foi encontrado. Envie TODOS os arquivos do zip na raiz do repositorio." && exit 1)

# Confere o WebSocket ANTES de subir: se falhar, o erro aparece no build.
RUN node -e "const ws=require('ws'); if(!globalThis.WebSocket){globalThis.WebSocket=ws.WebSocket||ws} if(typeof globalThis.WebSocket!=='function'){console.error('[build] ERRO: WebSocket indisponivel');process.exit(1)} console.log('[build] websocket ok')"

RUN mkdir -p /data/session

EXPOSE 3000

CMD ["node", "index.cjs"]