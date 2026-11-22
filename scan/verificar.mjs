import { abrirNavegador } from "./navegador.mjs";
import { lerPrecos, ABAS_PADRAO } from "./leitor.mjs";
import { etapa, pegar, postar } from "./enviar.mjs";
import * as v from "./validar.mjs";

// Verificação de janela (Fase 3 / F3.3): o Worker decidiu os pares (GET /api/varredura/job/<id>, do mais barato ao mais
// caro pela estimativa); o runner só lê o preço real de cada um e entrega em LOTES (até 12 por vez ou a cada ~8 s),
// para a página ver os primeiros preços logo e o KV/D1 receberem poucas gravações.

export const TAMANHO_LOTE = 12;
// 3 abas (medido em 2026-11-22, BSB>SSA, 24 pares): com 6 abas a oferta de agência chega depois dos 20 s e 14 pares
// ficaram em R$ 630 (o certo era 586); com 3 abas 23 pares leram 586, quase sempre pelo fim da rede, em 155 s (6 abas: 192 s).
export const ABAS_VERIFICAR = 3;
export const MIN_LIDOS = 12; // nunca para antes de ler pelo menos isso
export const DESCONTO_MAX = 0.30; // a maior diferença vista entre a estimativa do calendário e o preço real de agência (VCP>REC: 1404 → 982)

// Parada antecipada da verificação "melhores": os pares que sobraram só podem vencer o melhor preço lido se a oferta
// de agência for mais de DESCONTO_MAX abaixo da estimativa do calendário. Depois de MIN_LIDOS leituras, se nem o mais
// barato dos que sobraram chega lá, ler mais é gasto do IP e do tempo. Sem estimativas (modo janela), nunca para.
export function deveParar({ lidos, restantes, estimativas, minimo = MIN_LIDOS, desconto = DESCONTO_MAX }) {
  if (!estimativas || lidos.length < minimo || !restantes.length) return false;
  const melhor = Math.min(...lidos.map((l) => l.preco));
  const menorEstimativa = Math.min(...restantes.map((p) => estimativas.get(`${p.ida}|${p.volta || ""}`) ?? 0));
  return menorEstimativa * (1 - desconto) >= melhor;
}
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
export async function verificar({ job, origem, destino, log, leitura, abas = Number(process.env.ABAS) || ABAS_VERIFICAR, pegarJob = pegar, enviar = postar, avisar = etapa, abrir = abrirNavegador, ler }) {
  v.job(job); v.iata(origem, "origem"); v.iata(destino, "destino");
  const info = await pegarJob(`/api/varredura/job/${job}`);
  if (info.tipo !== "verificar" || info.origem !== origem || info.destino !== destino) throw new Error("job não é uma verificação desta rota");
  const pares = (info.pares || []).map((p) => { const [ida, volta = ""] = p.split("|"); v.data(ida, "ida"); if (volta) v.data(volta, "volta"); return { ida, volta }; });
  const estimativas = info.modo === "melhores" && Array.isArray(info.totais) && info.totais.length === pares.length
    ? new Map(pares.map((p, i) => [`${p.ida}|${p.volta}`, info.totais[i]])) : null;
  log(`verificar ${origem}>${destino}: ${pares.length} pares, ${abas} abas${estimativas ? ", parada antecipada ligada" : ""}`);
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
    lidos = await lerPrecos(navegador, { origem, destino, pares, abas, log, escalonarMs: 150, ...(ler ? { ler, escalonarMs: 0 } : {}), parar: ({ lidos: ja, fila }) => deveParar({ lidos: ja, restantes: fila, estimativas }), aoLer: (par, preco) => lotes.add(montar(par, preco)) });
  } catch (e) {
    await lotes.esvaziar();
    await avisar(job, "erro", e.name === "ErroBloqueio" ? "google_bloqueou" : String(e.message).slice(0, 190)).catch(() => {});
    throw e;
  } finally { await navegador.fechar(); }
  await lotes.esvaziar();
  log(`verificar: ${lidos.length} de ${pares.length} pares lidos${lidos.length < pares.length ? " (parou cedo ou houve falhas)" : ""}`);
  await avisar(job, "pronto").catch(() => {});
  return lidos;
}
