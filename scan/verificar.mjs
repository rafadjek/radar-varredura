import { abrirNavegador } from "./navegador.mjs";
import { lerPrecos, ABAS_PADRAO } from "./leitor.mjs";
import { etapa, pegar, postar } from "./enviar.mjs";
import * as v from "./validar.mjs";

// Verificação de janela (Fase 3 / F3.3): o Worker decidiu os pares (GET /api/varredura/job/<id>, do mais barato ao mais
// caro pela estimativa); o runner só lê o preço real de cada um e entrega em LOTES (até 12 por vez ou a cada ~8 s),
// para a página ver os primeiros preços logo e o KV/D1 receberem poucas gravações.

export const TAMANHO_LOTE = 12;
export const ESPERA_LOTE_MS = 8000;

// Junta itens e os entrega em lote quando chega a `tamanho` ou depois de `esperaMs` desde o primeiro pendente.
// Lote recusado (ex.: 1 item inválido derruba o lote inteiro) cai para envio um a um, para não perder os bons.
export function criarLotes({ enviarLote, enviarUm, tamanho = TAMANHO_LOTE, esperaMs = ESPERA_LOTE_MS, log = () => {} }) {
  let pendentes = [];
  let timer = null;
  let andando = Promise.resolve();
  async function despachar(itens) {
    try { await enviarLote(itens); }
    catch (e) {
      log(`aviso: lote de ${itens.length} recusado (${e.message}); enviando um a um`);
      for (const item of itens) { try { await enviarUm(item); } catch (e2) { log(`aviso: ${item.ida} ${item.volta || ""}: ${e2.message}`); } }
    }
  }
  function esvaziar() {
    clearTimeout(timer); timer = null;
    if (!pendentes.length) return andando;
    const itens = pendentes; pendentes = [];
    andando = andando.then(() => despachar(itens));
    return andando;
  }
  return {
    add(item) {
      pendentes.push(item);
      if (pendentes.length >= tamanho) return esvaziar();
      if (!timer) timer = setTimeout(() => { esvaziar(); }, esperaMs);
      return Promise.resolve();
    },
    esvaziar,
  };
}

// verificar <job> <origem> <destino>
export async function verificar({ job, origem, destino, log, leitura, abas = Number(process.env.ABAS) || ABAS_PADRAO, pegarJob = pegar, enviar = postar, avisar = etapa, abrir = abrirNavegador, ler }) {
  v.job(job); v.iata(origem, "origem"); v.iata(destino, "destino");
  const info = await pegarJob(`/api/varredura/job/${job}`);
  if (info.tipo !== "verificar" || info.origem !== origem || info.destino !== destino) throw new Error("job não é uma verificação desta rota");
  const pares = (info.pares || []).map((p) => { const [ida, volta = ""] = p.split("|"); v.data(ida, "ida"); if (volta) v.data(volta, "volta"); return { ida, volta }; });
  log(`verificar ${origem}>${destino}: ${pares.length} pares, ${abas} abas`);
  await avisar(job, "confirmando").catch(() => {});
  const montar = (par, preco) => ({ origem, destino, ida: par.ida, volta: par.volta || "", preco, lidoEm: new Date().toISOString(), leitura });
  const lotes = criarLotes({
    log,
    enviarLote: (itens) => enviar("/api/varredura/lote", { job, itens }),
    enviarUm: (item) => enviar("/api/varredura/resultado", { job, tipo: "confirmacao", ...item }),
  });
  const navegador = await abrir();
  let lidos = [];
  try {
    lidos = await lerPrecos(navegador, { origem, destino, pares, abas, log, ...(ler ? { ler, escalonarMs: 0 } : {}), aoLer: (par, preco) => lotes.add(montar(par, preco)) });
  } catch (e) {
    await lotes.esvaziar();
    await avisar(job, "erro", e.name === "ErroBloqueio" ? "google_bloqueou" : String(e.message).slice(0, 190)).catch(() => {});
    throw e;
  } finally { await navegador.fechar(); }
  await lotes.esvaziar();
  log(`verificar: ${lidos.length} de ${pares.length} pares lidos`);
  await avisar(job, "pronto").catch(() => {});
  return lidos;
}
