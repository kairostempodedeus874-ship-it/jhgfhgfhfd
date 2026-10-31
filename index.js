/*
 * Atalho universal - nao coloque codigo do bot aqui.
 * O codigo real esta em index.cjs (CommonJS), que funciona em qualquer configuracao.
 * Este arquivo existe apenas para que "node index.js" continue funcionando.
 */
import("./index.cjs").catch((error) => {
  console.error("");
  console.error("==========================================================");
  console.error(" NAO FOI POSSIVEL INICIAR O BOT");
  console.error("");
  console.error(" Detalhe: " + String((error && error.message) || error));
  console.error("");
  console.error(" Verifique se o arquivo index.cjs foi enviado junto com");
  console.error(" o package.json, o Dockerfile e o render.yaml (na raiz).");
  console.error("==========================================================");
  console.error("");
  process.exit(1);
});