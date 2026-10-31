# Bot WhatsApp + IA (Render)

Servico que mantem a conexao do WhatsApp via **Baileys**, publica o QR code no painel
e faz a ponte com a funcao `wa-webhook` do Backend, que responde com IA.

## Como funciona

```
WhatsApp  -->  este bot (Render)  -->  wa-webhook (Backend)  -->  IA
                    |                        |
                    |                        +-- grava conversa e mensagem
                    +---- le a fila de envio (wa_messages.status = 'queued')
```

1. O bot gera o QR e salva em `wa_bot_status.qr_code` (o painel mostra a imagem).
   O QR tambem aparece direto no endereco do servico no Render, com um diagnostico
   do que esta faltando (`https://SEU-SERVICO.onrender.com/`).
2. Cada mensagem recebida vai para `WEBHOOK_URL` com o header `x-bot-token`.
3. O Backend grava, chama a IA e coloca a resposta na fila (`status = queued`).
4. Este bot le a fila a cada 3 segundos, envia pelo WhatsApp e marca como `sent`.

## Deploy no Render (passo a passo)

1. Descompacte o `.zip`. Suba **os arquivos na raiz** de um repositorio novo no GitHub.
   `package.json`, `Dockerfile` e `render.yaml` precisam ficar na raiz (sem subpasta).
   (versao 1.5.2: inclui suporte a WebSocket para nao quebrar no Node 20)
2. No Render: **New +** -> **Blueprint** -> selecione o repositorio.
   O `render.yaml` ja cria o servico, o health check e o disco de 1 GB em `/data`.
3. Abra o servico -> aba **Environment**. **Nao e obrigatorio cadastrar nada** aqui:
   o `index.cjs` ja vem com o endereco do Backend e com a chave publica do projeto.
   Se quiser, pode cadastrar (opcional):
   - `SUPABASE_SERVICE_ROLE_KEY` -> chave de servico do Backend (prioridade sobre a publica)
   - `BOT_TOKEN` -> so se voce cadastrou esse segredo no Backend
4. **Manual Deploy** -> **Clear build cache & deploy** (essa opcao recria tudo do zero).
5. Acesse o painel do projeto -> **Conexao** e escaneie o QR.

As variaveis `SUPABASE_URL` e `WEBHOOK_URL` **ja vem preenchidas** no `render.yaml` e
tambem dentro do `index.cjs`. Se quiser trocar, basta definir no Render que o valor do
Render tem prioridade.

## O bot subiu mas nao gera QR

Abra o proprio endereco do servico no navegador: `https://SEU-SERVICO.onrender.com/`.
Ele mostra o QR (quando existir) e uma lista de diagnostico com check/cruz:

- SUPABASE_URL configurada
- Chave de acesso ao Backend (mostra qual esta em uso)
- Gravacao no Backend (`wa_bot_status`)
- WEBHOOK_URL configurada
- QR gerado nesta sessao

Se um item estiver com X vermelho, a mensagem logo abaixo explica o motivo exato.
O QR tambem pode ser aberto direto em imagem: `https://SEU-SERVICO.onrender.com/qr.png`.
Se o QR aparece nessa pagina mas nao no painel do site, o problema e permissao/gravacao
no Backend (linha "Gravacao no Backend" vermelha).

Para dados em JSON use `https://SEU-SERVICO.onrender.com/health`. A resposta mostra
`ready` e o status atual. Exemplo:

```json
{ "ok": true, "ready": true, "missing": [], "status": "qr" }
```

O servico **nao derruba mais o deploy** quando falta variavel: ele fica no ar mostrando
o aviso nos logs e no `/health` ate voce cadastrar. Depois de cadastrar, faca um novo
deploy.

## Arquivos do pacote

| Arquivo | Para que serve |
| --- | --- |
| `index.cjs` | Codigo principal do bot (CommonJS, funciona em qualquer configuracao) |
| `index.js` | Atalho de 3 linhas que inicia o `index.cjs` |
| `package.json` | Dependencias; o `npm start` roda `node index.cjs` |
| `Dockerfile` / `render.yaml` | Deploy no Render |

O `Dockerfile` **nao depende de nenhum arquivo oculto**. Ele copia apenas o
`package.json` e cria o `.npmrc` durante o build. Se algum arquivo do zip nao chegar
ao repositorio, o build continua funcionando.

Se o seu servico no Render for do tipo **Web Service** (nao Docker), confira em **Settings**:
`Build Command: npm install` e `Start Command: npm start`.

## Erro "Node.js 20 detected without native WebSocket support"

Se o log mostra `websocket-factory.js` e a mensagem sobre **WebSocket nativo**, nao e
problema do WhatsApp: e a versao do Node usada na imagem.

- **Pacote 1.5.2** -> a imagem base passou a ser `node:22`, que ja tem WebSocket nativo.
- Alem disso o `index.cjs` ativa a biblioteca `ws` antes de carregar o Backend, entao
o funcionamento e garantido mesmo se a imagem for Node 20.
- E possivel cadastrar no Render a variavel `NODE_VERSION=22` (aba Environment) como
reforco, mas com o Dockerfile novo isso nao e necessario.

Se o seu servico for **Web Service** (nao Docker), troque a versao do Node para 22
em Settings -> Environment (`NODE_VERSION = 22`).

## Outros erros comuns

| Sintoma no log | Causa | Solucao |
| --- | --- | --- |
| `does not provide an export named` | importacao ESM de uma lib CommonJS | corrigido no pacote 1.5.1 (`index.cjs` usa `require`) |
| `Node.js 20 detected without native WebSocket support` | a lib do Backend precisa de WebSocket, e o Node 20 nao tem isso nativo | resolvido no pacote 1.5.2: o Dockerfile usa Node 22 e o `index.cjs` ativa a lib `ws` antes de carregar o Backend |
| `Cannot find package '...'` | dependencias nao instalaram | Manual Deploy com **Clear build cache** |
| `Exited with status 1` | erro ao carregar o codigo (modulo ou dependencia) | veja a linha acima do erro; use o pacote 1.5.2 (`index.cjs`) |
| `failed to compute cache key: "./.npmrc": not found` | o `.npmrc` (arquivo oculto) nao chegou ao repositorio | resolvido no pacote 1.5.1: o Dockerfile cria o `.npmrc` sozinho |
| `COPY failed: no source files were specified` | arquivos enviados dentro de uma pasta no GitHub | suba tudo na RAIZ do repositorio |
| QR aparece e some toda hora | sem disco persistente | crie Disk de 1 GB em `/data` |
| `Sessao do WhatsApp encerrada (logout)` | celular removeu o aparelho | o bot apaga a sessao e gera QR novo sozinho |
| Bot conectado mas IA nao responde | falta `GEMINI_API_KEY` no Backend | cadastre o segredo no Backend |
| Mensagens nao saem | conversa sem telefone ou numero invalido | veja `wa_messages.error` e os logs |
| `401 unauthorized` no webhook | `BOT_TOKEN` no Render diferente do Backend | deixe `BOT_TOKEN` vazio nos dois lados |

## Teste rapido

1. `https://SEU-SERVICO.onrender.com/health` -> `{ "ok": true, "ready": true }`
2. Painel -> **Conexao** -> escaneie o QR.
3. Mande "oi" de outro numero e acompanhe em **Conversas**.
4. Se nada acontecer, olhe os logs do Render e a tabela `wa_logs`.

## Avisos importantes

- **Baileys nao e oficial.** O QR so existe em bibliotecas nao oficiais. O uso pode
  resultar em bloqueio do numero. Em escala, o caminho e a Cloud API oficial.
- Rode **uma unica instancia** por numero. Duas instancias derrubam a sessao.
- A chave embutida no pacote e a chave **publica** do projeto. Se voce tem a chave de
  servico, prefira cadastra-la no Render como `SUPABASE_SERVICE_ROLE_KEY`.
- O plano gratuito do Render hiberna e nao tem disco: para uso real, use plano com disco.