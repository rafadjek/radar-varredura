import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { abrirChrome, dormir } from "./chrome.mjs";
import { lerCalendario } from "./calendario.mjs";
import { lerMenorPreco } from "./confirmar.mjs";
import { etapa, postar } from "./enviar.mjs";
import { melhoresPares } from "./pares.mjs";
import * as v from "./validar.mjs";

const t0 = Date.now();
const log = (s) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${s}`);
const [comando, ...a] = process.argv.slice(2);
const agora = () => new Date().toISOString();

// calendario <job> <origem> <destino> <ida|volta> <arquivo.json>
//   "ida" lê origem->destino; "volta" lê destino->origem. O resultado vai ao Worker na ordem da busca.
async function calendario([job, origem, destino, sentido, arquivo]) {
  v.job(job); v.iata(origem, "origem"); v.iata(destino, "destino");
  if (sentido !== "ida" && sentido !== "volta") throw new Error("entrada inválida: sentido");
  await etapa(job, sentido).catch((e) => log(`aviso: etapa não enviada (${e.message})`));
  const chrome = await abrirChrome();
  try {
    const [de, para] = sentido === "ida" ? [origem, destino] : [destino, origem];
    const r = await lerCalendario(chrome, de, para, { log });
    if (!r.cobertura) { await etapa(job, "erro", `sem preços de ${de} para ${para}`).catch(() => {}); throw new Error("sem preços do Google"); }
    if (arquivo) writeFileSync(arquivo, JSON.stringify({ origem, destino, sentido, dias: r.dias }));
    await postar("/api/varredura/resultado", { job, tipo: "calendario", origem, destino, sentido, dias: r.dias, cobertura: r.cobertura, lidoEm: agora() });
    log(`${sentido} enviado: ${r.cobertura} dias${r.completo ? "" : " (cobertura incompleta)"}`);
  } finally { chrome.fechar(); }
}

// pares <dias> <margem> <ida.json> <volta.json>  -> escreve matriz e tem em $GITHUB_OUTPUT
function pares([dias, margem, arqIda, arqVolta]) {
  v.inteiro(dias, 0, 35, "dias"); v.inteiro(margem, 0, 10, "margem");
  if (Number(dias) === 0) { // busca sem duração (ex.: só ida): não há par para confirmar
    const vazio = "tem=false\nmatriz={\"include\":[]}\n";
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, vazio); else console.log(vazio);
    return;
  }
  const ida = JSON.parse(readFileSync(arqIda, "utf8")).dias;
  const volta = JSON.parse(readFileSync(arqVolta, "utf8")).dias;
  const melhores = melhoresPares(ida, volta, Number(dias), Number(margem), 3);
  log(`pares: ${JSON.stringify(melhores)}`);
  const saida = `tem=${melhores.length ? "true" : "false"}\nmatriz=${JSON.stringify({ include: melhores.map((p) => ({ ida: p.ida, volta: p.volta })) })}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, saida); else console.log(saida);
}

// confirmar <job> <origem> <destino> <ida> <volta|->
async function confirmar([job, origem, destino, ida, volta]) {
  v.job(job); v.iata(origem, "origem"); v.iata(destino, "destino"); v.data(ida, "ida");
  if (volta && volta !== "-") v.data(volta, "volta");
  await etapa(job, "confirmando").catch(() => {});
  const chrome = await abrirChrome();
  try {
    const v = volta && volta !== "-" ? volta : "";
    const preco = await lerMenorPreco(chrome, { origem, destino, ida, volta: v }, { log });
    if (preco === null) throw new Error("não consegui ler o menor preço");
    await postar("/api/varredura/resultado", { job, tipo: "confirmacao", origem, destino, ida, volta: v, preco, lidoEm: agora() });
    log(`confirmado ${origem}>${destino} ${ida} ${v}: R$ ${preco}`);
  } finally { chrome.fechar(); }
}

// salvas <origem>: varre os dois sentidos de cada destino de rotas.json; só envia leitura razoável
async function salvas([origem]) {
  v.iata(origem, "origem");
  const { destinos } = JSON.parse(readFileSync(new URL("../rotas.json", import.meta.url), "utf8"));
  const job = `salvas-${new Date().toISOString().slice(0, 10)}`;
  const chrome = await abrirChrome();
  let ok = 0;
  try {
    for (const destino of destinos) {
      if (destino === origem) continue;
      for (const sentido of ["ida", "volta"]) {
        try {
          const [de, para] = sentido === "ida" ? [origem, destino] : [destino, origem];
          const r = await lerCalendario(chrome, de, para, { log, tentativas: 2 });
          if (r.cobertura >= 150) {
            await postar("/api/varredura/resultado", { job, tipo: "calendario", origem, destino, sentido, dias: r.dias, cobertura: r.cobertura, lidoEm: agora() });
            ok++;
          } else log(`${de}>${para}: cobertura baixa (${r.cobertura}), mantém o dado anterior`);
        } catch (e) { log(`${origem}/${destino} ${sentido}: ${e.message}`); }
        await dormir(5000);
      }
    }
  } finally { chrome.fechar(); }
  log(`salvas ${origem}: ${ok} leituras enviadas`);
  if (!ok) process.exit(1);
}

// etapa <job> <nome> [detalhe]
async function etapaCmd([job, nome, detalhe]) {
  v.job(job);
  if (!["fila", "ida", "volta", "confirmando", "pronto", "erro"].includes(nome)) throw new Error("entrada inválida: etapa");
  await etapa(job, nome, detalhe);
}

// matriz-pares "ida|volta,ida|volta"  -> escreve matriz em $GITHUB_OUTPUT (até 3 pares, já validados)
function matrizPares([pares]) {
  const include = v.pares(pares).map((p) => ({ ida: p.ida, volta: p.volta || "-" }));
  const saida = `matriz=${JSON.stringify({ include })}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, saida); else console.log(saida);
}

const comandos = { calendario, pares, confirmar, salvas, etapa: etapaCmd, "matriz-pares": matrizPares };
if (!comandos[comando]) { console.error("uso: cli.mjs calendario|pares|confirmar|salvas ..."); process.exit(2); }
try { await comandos[comando](a); process.exit(0); }
catch (e) { console.error("ERRO:", e.message); process.exit(1); }
