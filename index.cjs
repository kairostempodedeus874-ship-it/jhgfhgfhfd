/*
 * Bot WhatsApp + IA (Baileys) - versao 1.5.3
 *
 * IMPORTANTE: este arquivo e CommonJS (.cjs) de proposito.
 * Assim ele funciona mesmo que o package.json tenha "type": "module",
 * o que elimina de vez o erro "Exited with status 1" no Render
 * (require is not defined in ES module scope / import fora de modulo).
 */

/*
 * CORRECAO IMPORTANTE (v1.5.2)
 * As versoes novas do @supabase/supabase-js usam WebSocket nativo do Node.
 * No Node 20 isso nao existe e o processo morre com:
 *   "Error: Node.js 20 detected without native WebSocket support."
 * Aqui o WebSocket e preenchido ANTES de carregar a biblioteca do Backend.
 */
if (typeof globalThis.WebSocket === "undefined") {
  try {
    const wsModule = require("ws");
    globalThis.WebSocket = wsModule.WebSocket || wsModule;
    console.log("[bot] WebSocket nativo ausente: usando a biblioteca ws como suporte.");
  } catch (wsError) {
    console.error("[bot] aviso: nao foi possivel carregar a biblioteca ws.");
  }
}

function fatal(titulo, error, dica) {
  console.error("");
  console.error("==========================================================");
  console.error(" " + titulo);
  console.error("");
  console.error(" Detalhe tecnico: " + String((error && error.message) || error || "desconhecido"));
  if (dica) {
    console.error("");
    dica.forEach((linha) => console.error(" " + linha));
  }
  console.error("==========================================================");
  console.error("");
}

function load(name, loader) {
  try {
    return loader();
  } catch (error) {
    fatal("FALHA AO CARREGAR A DEPENDENCIA: " + name, error, [
      "Como resolver:",
      "  1. Abra a aba Logs do BUILD no Render e veja se o npm install terminou.",
      "  2. Se o build falhou, use Manual Deploy > Clear build cache & deploy.",
      "  3. Confirme que o package.json deste pacote foi enviado junto.",
    ]);
    process.exit(1);
  }
}

const fs = load("node:fs", () => require("node:fs"));
const express = load("express", () => require("express"));
const QRCode = load("qrcode", () => require("qrcode"));
const pinoModule = load("pino", () => require("pino"));
const supabaseModule = load("@supabase/supabase-js", () => require("@supabase/supabase-js"));
const baileysModule = load("@whiskeysockets/baileys", () => require("@whiskeysockets/baileys"));

const pino = pinoModule.default || pinoModule;
const { createClient } = supabaseModule;
const makeWASocket = baileysModule.default || baileysModule.makeWASocket;
const useMultiFileAuthState = baileysModule.useMultiFileAuthState;
const fetchLatestBaileysVersion = baileysModule.fetchLatestBaileysVersion;
const DisconnectReason = baileysModule.DisconnectReason;
const Browsers = baileysModule.Browsers;

if (typeof makeWASocket !== "function") {
  fatal("A LIB DO WHATSAPP NAO CARREGOU CORRETAMENTE", "makeWASocket ausente", [
    "Como resolver:",
    "  1. No Render: Manual Deploy > Clear build cache & deploy.",
    "  2. Confirme que o package.json foi enviado na raiz do repositorio.",
  ]);
  process.exit(1);
}

const BOT_VERSION = "1.5.3";
const PORT = Number(process.env.PORT || 3000);
const SESSION_DIR = process.env.SESSION_DIR || "./session";
const SEND_INTERVAL_MS = 3000;
const SWEEP_INTERVAL_MS = 8000;
const HEARTBEAT_MS = 30000;

/*
 * As duas linhas abaixo ja vem preenchidas com o endereco do seu projeto.
 * Se voce definir SUPABASE_URL ou WEBHOOK_URL no Render, o valor do Render ganha.
 */
const FALLBACK_SUPABASE_URL = "https://y5bsz07hp6db54mu7oic.helloreaddy.com/";
const FALLBACK_SUPABASE_KEY = "sb_publishable_GAlh5THMhRBxhOO1OpEMsWLEcQakIGOk";
const FALLBACK_WEBHOOK_URL = "https://y5bsz07hp6db54mu7oic.helloreaddy.com/functions/v1/wa-webhook";

const SUPABASE_URL = String(process.env.SUPABASE_URL || FALLBACK_SUPABASE_URL || "")
  .trim()
  .replace(/\/+$/, "");

/*
 * A chave abaixo e a chave PUBLICA do projeto (a mesma que o site ja usa no navegador).
 * Ela serve para este bot porque as tabelas do WhatsApp aceitam escrita com ela.
 * Se voce cadastrar SUPABASE_SERVICE_ROLE_KEY no Render, ela ganha prioridade.
 * Ou seja: NAO e obrigatorio configurar nada no Render.
 */
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || FALLBACK_SUPABASE_KEY || "",
).trim();
const KEY_SOURCE = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? "service_role (cadastrada no Render)"
  : process.env.SUPABASE_ANON_KEY
    ? "anon (cadastrada no Render)"
    : "chave publica embutida no pacote";

const WEBHOOK_URL = String(process.env.WEBHOOK_URL || FALLBACK_WEBHOOK_URL || "").trim();
const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();

const MISSING = [];
if (!SUPABASE_URL) MISSING.push("SUPABASE_URL");
if (!SUPABASE_KEY) MISSING.push("SUPABASE_SERVICE_ROLE_KEY");
const CONFIG_OK = MISSING.length === 0;

const supabase = CONFIG_OK
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;
const logger = pino({ level: "silent" });

let sock = null;
let starting = false;
let currentStatus = CONFIG_OK ? "connecting" : "error";
let connectedPhone = "";
let flushing = false;
let sweeping = false;
let reconnectTimer = null;
let currentQrText = "";
let currentQrDataUrl = "";
let dbState = CONFIG_OK ? "yes" : "no-credentials";
let lastError = "";

function configBanner() {
  console.error("");
  console.error("==========================================================");
  console.error(" O BOT AINDA NAO PODE CONECTAR");
  console.error("");
  console.error(" Faltam variaveis no Render -> aba Environment:");
  MISSING.forEach((name) => console.error("   - " + name));
  console.error("");
  console.error(" Como resolver:");
  console.error("   1. Servico no Render -> aba Environment");
  console.error("   2. Add Environment Variable com o nome acima");
  console.error("   3. Salve e clique em Manual Deploy > Deploy latest commit");
  console.error("");
  console.error(" O servico vai continuar no ar mostrando este aviso.");
  console.error("==========================================================");
  console.error("");
}

function infoBanner() {
  console.log("[bot] versao " + BOT_VERSION);
  console.log("[bot] node " + process.version);
  console.log("[bot] Backend: " + (SUPABASE_URL || "(vazio)"));
  console.log("[bot] chave de acesso: " + KEY_SOURCE);
  console.log("[bot] webhook: " + (WEBHOOK_URL || "(vazio)"));
  console.log("[bot] sessao em: " + SESSION_DIR);
}

async function publishStatus(patch) {
  if (!supabase) return;
  if (patch.status) currentStatus = patch.status;
  const now = new Date().toISOString();
  const payload = {
    id: 1,
    bot_version: BOT_VERSION,
    updated_at: now,
    last_seen: now,
    ...patch,
  };
  try {
    const { error } = await supabase.from("wa_bot_status").upsert(payload, { onConflict: "id" });
    if (error) {
      dbState = "error";
      lastError = "Falha ao gravar no Backend: " + error.message;
      console.error("[bot] falha ao publicar status:", error.message);
    } else {
      dbState = "ok";
    }
  } catch (error) {
    dbState = "error";
    lastError = "Erro ao falar com o Backend: " + String((error && error.message) || error);
    console.error("[bot] erro ao publicar status:", (error && error.message) || error);
  }
}

async function logEvent(event, level, detail) {
  if (!supabase) return;
  try {
    await supabase.from("wa_logs").insert({ event: event, level: level || "info", detail: detail || {} });
  } catch (error) {
    console.error("[bot] log:", event, (error && error.message) || error);
  }
}

function extractText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage && message.extendedTextMessage.text) return message.extendedTextMessage.text;
  if (message.imageMessage && message.imageMessage.caption) return message.imageMessage.caption;
  if (message.videoMessage && message.videoMessage.caption) return message.videoMessage.caption;
  if (message.documentWithCaptionMessage && message.documentWithCaptionMessage.message) {
    return extractText(message.documentWithCaptionMessage.message);
  }
  if (message.buttonsResponseMessage && message.buttonsResponseMessage.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }
  if (message.listResponseMessage && message.listResponseMessage.title) return message.listResponseMessage.title;
  if (message.templateButtonReplyMessage && message.templateButtonReplyMessage.selectedDisplayText) {
    return message.templateButtonReplyMessage.selectedDisplayText;
  }
  if (message.ephemeralMessage && message.ephemeralMessage.message) return extractText(message.ephemeralMessage.message);
  if (message.viewOnceMessage && message.viewOnceMessage.message) return extractText(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2 && message.viewOnceMessageV2.message) {
    return extractText(message.viewOnceMessageV2.message);
  }
  return "";
}

function resolvePhone(msg) {
  const direct = String((msg && msg.key && msg.key.remoteJid) || "");
  const alternate = String((msg && msg.key && msg.key.remoteJidAlt) || "");
  const candidate = direct.endsWith("@s.whatsapp.net") ? direct : alternate || direct;
  return candidate.split("@")[0].split(":")[0];
}

async function forwardToBackend(payload) {
  if (!WEBHOOK_URL) {
    console.warn("[bot] WEBHOOK_URL nao configurado; mensagem recebida foi ignorada.");
    return;
  }
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-token": BOT_TOKEN,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error("[bot] webhook respondeu", response.status, text.slice(0, 300));
      await logEvent("Webhook respondeu com erro", "error", {
        status: response.status,
        body: text.slice(0, 300),
      });
    }
  } catch (error) {
    console.error("[bot] falha ao chamar o webhook:", (error && error.message) || error);
    await logEvent("Falha ao chamar o webhook", "error", {
      message: (error && error.message) || String(error),
    });
  }
}

async function flushQueue() {
  if (flushing || !sock || !supabase) return;
  flushing = true;
  try {
    const { data, error } = await supabase
      .from("wa_messages")
      .select("id, body, attempts, conversation_id, wa_conversations(phone)")
      .eq("status", "queued")
      .eq("direction", "outbound")
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) {
      console.error("[bot] erro ao buscar fila:", error.message);
      return;
    }

    const rows = data || [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const phone = (row.wa_conversations && row.wa_conversations.phone) || "";
      if (!phone) {
        await supabase
          .from("wa_messages")
          .update({ status: "failed", error: "Conversa sem telefone" })
          .eq("id", row.id);
        continue;
      }

      const jid = String(phone).replace(/\D/g, "") + "@s.whatsapp.net";
      try {
        await sock.sendMessage(jid, { text: row.body });
        await supabase
          .from("wa_messages")
          .update({ status: "sent", error: "", attempts: (row.attempts || 0) + 1 })
          .eq("id", row.id);
      } catch (sendError) {
        const attempts = (row.attempts || 0) + 1;
        const failed = attempts >= 3;
        await supabase
          .from("wa_messages")
          .update({
            status: failed ? "failed" : "queued",
            attempts: attempts,
            error: String((sendError && sendError.message) || sendError).slice(0, 300),
          })
          .eq("id", row.id);
        if (failed) {
          await logEvent("Falha no envio da mensagem", "error", {
            message_id: row.id,
            phone: phone,
            message: String((sendError && sendError.message) || sendError),
          });
        }
        break;
      }
    }
  } catch (error) {
    console.error("[bot] erro na fila:", (error && error.message) || error);
  } finally {
    flushing = false;
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log("[bot] tentando reconectar agora. motivo:", reason || "conexao encerrada");
    startBot();
  }, 4000);
}

/*
 * REDE DE SEGURANCA
 * A cada poucos segundos avisa o Backend: "existe alguma mensagem sem resposta?"
 * O Backend responde na hora e faz o trabalho por tras, entao isso nunca da timeout.
 * Se uma resposta falhou por qualquer motivo, ela sai aqui na proxima varredura.
 */
async function sweepBackend() {
  if (sweeping || !WEBHOOK_URL || !sock) return;
  sweeping = true;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-token": BOT_TOKEN,
      },
      body: JSON.stringify({ action: "sweep" }),
    });
  } catch (error) {
    /* silencioso: e apenas uma rede de seguranca */
  } finally {
    sweeping = false;
  }
}

async function startBot() {
  if (starting || !supabase) return;
  starting = true;

  try {
    if (sock) {
      try {
        sock.end(undefined);
      } catch (ignored) {
        /* ignora */
      }
      sock = null;
    }

    const authState = await useMultiFileAuthState(SESSION_DIR);
    const state = authState.state;
    const saveCreds = authState.saveCreds;
    const versionInfo = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version: versionInfo.version,
      auth: state,
      logger: logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      markOnline: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const connection = update.connection;
      const lastDisconnect = update.lastDisconnect;
      const qr = update.qr;

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          currentQrText = qr;
          currentQrDataUrl = dataUrl;
          await publishStatus({
            status: "qr",
            qr_code: dataUrl,
            qr_updated_at: new Date().toISOString(),
            phone: connectedPhone,
          });
          console.log("[bot] novo QR gerado. Abra a aba Conexao do painel e escaneie.");
        } catch (error) {
          console.error("[bot] falha ao gerar QR:", (error && error.message) || error);
        }
      }

      if (connection === "open") {
        const raw = (sock && sock.user && sock.user.id) || "";
        connectedPhone = raw.split(":")[0].split("@")[0] || "";
        currentQrText = "";
        currentQrDataUrl = "";
        await publishStatus({ status: "connected", qr_code: "", phone: connectedPhone });
        await logEvent("Bot conectado ao WhatsApp", "info", { phone: connectedPhone });
        console.log("[bot] conectado como", connectedPhone);
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
            ? lastDisconnect.error.output.statusCode
            : undefined;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log("[bot] conexao fechada. codigo:", statusCode, "logout:", loggedOut);

        currentQrText = "";
        currentQrDataUrl = "";

        if (loggedOut) {
          connectedPhone = "";
          await publishStatus({ status: "connecting", qr_code: "", phone: "" });
          await logEvent("Sessao do WhatsApp encerrada (logout)", "warn", {});
          try {
            await fs.promises.rm(SESSION_DIR, { recursive: true, force: true });
            console.log("[bot] sessao antiga removida; um novo QR sera gerado.");
          } catch (error) {
            console.error("[bot] nao foi possivel limpar a sessao:", (error && error.message) || error);
          }
        } else {
          await publishStatus({ status: "connecting", qr_code: "", phone: connectedPhone });
        }

        scheduleReconnect(loggedOut ? "logout" : "queda de conexao");
      }
    });

    sock.ev.on("messages.upsert", async (event) => {
      if (event.type !== "notify") return;
      const messages = event.messages || [];

      for (let index = 0; index < messages.length; index += 1) {
        const msg = messages[index];
        if (!msg || !msg.message || (msg.key && msg.key.fromMe)) continue;
        const jid = String((msg.key && msg.key.remoteJid) || "");
        if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) continue;

        const text = extractText(msg.message).trim();
        if (!text) continue;

        const phone = resolvePhone(msg);
        // Somente numeros de pessoas: 10 a 15 digitos. Grupos e canais ficam de fora.
        if (!phone || phone.length < 10 || phone.length > 15) continue;

        await forwardToBackend({
          message_id: msg.key.id,
          phone: phone,
          push_name: msg.pushName || "",
          text: text,
          timestamp: Number(msg.messageTimestamp || Date.now() / 1000),
          is_group: false,
        });
      }
    });

    console.log("[bot] socket iniciado. aguardando QR ou conexao...");
  } catch (error) {
    console.error("[bot] falha ao iniciar:", (error && error.message) || error);
    await publishStatus({ status: "error", qr_code: "" });
    scheduleReconnect("erro ao iniciar");
  } finally {
    starting = false;
  }
}

const app = express();

/*
 * Libera o painel do site (outro dominio) a ler o status e o QR direto deste servico.
 * Sem isso o navegador bloqueia a leitura por CORS.
 */
app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type, apikey, x-client-info, x-bot-token");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Max-Age", "86400");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusPage() {
  const isConnected = currentStatus === "connected";
  const hasQr = Boolean(currentQrDataUrl) && !isConnected;
  const statusLabel = isConnected
    ? "WhatsApp conectado"
    : currentStatus === "error"
      ? "Configuracao incompleta"
      : currentStatus === "qr"
        ? "Aguardando leitura do QR"
        : "Conectando...";
  const badgeColor = isConnected ? "#1f7a4d" : currentStatus === "error" ? "#b23b3b" : "#a06a12";

  let stage = "";
  if (hasQr) {
    stage =
      '<img src="' + currentQrDataUrl + '" alt="QR code para conectar o WhatsApp" width="280" height="280" style="display:block;width:280px;height:280px;border-radius:12px;background:#ffffff" />';
  } else if (isConnected) {
    stage =
      '<div style="text-align:center"><div style="font-size:38px;line-height:1">&#9989;</div><p style="margin:10px 0 0;font-weight:600">Conectado como ' +
      escapeHtml(connectedPhone || "-") +
      "</p></div>";
  } else if (currentStatus === "error") {
    stage =
      '<div style="text-align:center;padding:10px"><div style="font-size:34px;line-height:1">&#9888;&#65039;</div><p style="margin:10px 0 0;font-weight:600">Faltam variaveis no Render</p><p style="margin:6px 0 0;font-size:13px;color:#5b534a">Aba Environment do servico: ' +
      escapeHtml(MISSING.join(", ")) +
      "</p></div>";
  } else {
    stage =
      '<div style="text-align:center"><p style="margin:0;font-weight:600">Gerando o QR code...</p><p style="margin:8px 0 0;font-size:13px;color:#5b534a">Esta pagina atualiza sozinha a cada 5 segundos.</p></div>';
  }

  const checkRow = (label, ok) =>
    '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px">' +
    '<span style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;border-radius:999px;background:' +
    (ok ? "#dff3e6;color:#1f7a4d" : "#f7e0e0;color:#b23b3b") +
    '">' +
    (ok ? "&#10003;" : "&#10007;") +
    "</span><span>" +
    escapeHtml(label) +
    "</span></div>";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="5" />
<title>Bot WhatsApp - Status</title>
</head>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f7f5f1;color:#221f1a">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e2da;border-radius:16px;padding:22px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <h1 style="margin:0;font-size:17px;font-weight:700">Bot de atendimento WhatsApp</h1>
        <p style="margin:4px 0 0;font-size:12px;color:#6b635a">Versao ${BOT_VERSION}</p>
      </div>
      <span style="display:inline-block;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;color:#ffffff;background:${badgeColor}">${escapeHtml(statusLabel)}</span>
    </div>
    <div style="margin-top:18px;display:flex;justify-content:center;align-items:center;min-height:300px;border:1px solid #ece7df;border-radius:12px;background:#faf8f5;padding:12px">
      ${stage}
    </div>
    <div style="margin-top:18px;border-top:1px solid #ece7df;padding-top:12px">
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8b8278;font-weight:700">Diagnostico</p>
      ${checkRow("SUPABASE_URL configurada", Boolean(SUPABASE_URL))}
      ${checkRow("Chave de acesso ao Backend (" + KEY_SOURCE + ")", Boolean(SUPABASE_KEY))}
      ${checkRow("Gravacao no Backend (wa_bot_status)", dbState === "ok")}
      ${checkRow("WEBHOOK_URL configurada", Boolean(WEBHOOK_URL))}
      ${checkRow("QR gerado nesta sessao", Boolean(currentQrText) || isConnected)}
    </div>
    ${
      lastError
        ? '<p style="margin:12px 0 0;padding:10px 12px;border-radius:10px;background:#fdf1f1;color:#8f2f2f;font-size:12px;line-height:1.5">' +
          escapeHtml(lastError) +
          "</p>"
        : ""
    }
    <p style="margin:14px 0 0;font-size:12px;line-height:1.6;color:#6b635a">
      O QR acima e o mesmo que aparece no painel do site, na aba <strong>Conexao</strong>.
      No celular: WhatsApp &rarr; Aparelhos conectados &rarr; Conectar um aparelho.
      Se o QR aparecer aqui mas nao no painel, o problema esta na gravacao do status (veja a linha vermelha do diagnostico).
    </p>
  </div>
</body>
</html>`;
}

app.get("/", (request, response) => {
  const wantsJson =
    String(request.query.json || "") === "1" || !String(request.headers.accept || "").includes("text/html");
  if (wantsJson) {
    response.json({
      service: "whatsapp-ia-bot",
      version: BOT_VERSION,
      status: currentStatus,
      phone: connectedPhone || null,
      ready: CONFIG_OK,
      missing: MISSING,
      db: dbState,
      last_error: lastError || null,
      qr_available: Boolean(currentQrDataUrl),
      qr: currentQrDataUrl || null,
    });
    return;
  }
  response.type("html").send(statusPage());
});

app.get("/qr.png", async (request, response) => {
  if (!currentQrText) {
    response.status(404).type("text").send("Nenhum QR ativo neste momento.");
    return;
  }
  try {
    const buffer = await QRCode.toBuffer(currentQrText, { margin: 1, width: 320 });
    response.type("png").send(buffer);
  } catch (error) {
    response.status(500).type("text").send(String((error && error.message) || error));
  }
});

app.get("/health", (request, response) => {
  response.json({
    ok: true,
    ready: CONFIG_OK,
    missing: MISSING,
    status: currentStatus,
    version: BOT_VERSION,
    phone: connectedPhone || null,
  });
});

app.listen(PORT, () => {
  console.log("[bot] servico ouvindo na porta " + PORT);
});

setInterval(() => flushQueue(), SEND_INTERVAL_MS);
setInterval(() => sweepBackend(), SWEEP_INTERVAL_MS);
setInterval(() => publishStatus({ phone: connectedPhone }), HEARTBEAT_MS);

infoBanner();

if (CONFIG_OK) {
  publishStatus({ status: "connecting", qr_code: "", phone: "" }).then(() => startBot());
} else {
  configBanner();
  setInterval(configBanner, 120000);
}

process.on("unhandledRejection", (reason) => {
  console.error("[bot] promise rejeitada:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[bot] excecao nao tratada:", (error && error.message) || error);
});
process.on("SIGTERM", async () => {
  console.log("[bot] encerrando...");
  try {
    await publishStatus({ status: "disconnected" });
  } catch (ignored) {
    /* ignora */
  }
  process.exit(0);
});