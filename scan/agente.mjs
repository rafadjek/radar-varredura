import { dormir } from "./chrome.mjs";
import { etapa, pegar } from "./enviar.mjs";
import { verificar } from "./verificar.mjs";
import { buscar } from "./busca.mjs";

// Agente residente do PC (Fase 3, modelo "puxa"): fica pedindo trabalho ao Worker (GET /api/varredura/proximo, espera
// longa) e roda o job na hora, sem esperar o GitHub Actions entregá-lo (a fila do Actions chegou a atrasar 4 min sem
// motivo; o agente pega em ~1 s). Só chamadas de SAÍDA do PC: nada é aberto para a internet. O Actions continua de
// reserva: o Worker despacha para ele qualquer job que o agente não pegar em 25 s.
//
// Pega 2 tipos de job: "verificar" (preço real dos melhores candidatos) e "buscar" (calendário de uma rota nova).

export const MAX_SIMULTANEOS = 2;
export const ESPERA_S = 25;

const TIPOS = {
  verificar: (info, ctx) => verificar({ job: info.id, origem: info.origem, destino: info.destino, log: ctx.log, leitura: ctx.leitura }),
  buscar: (info, ctx) => buscar({ job: info.id, origem: info.origem, destino: info.destino, dias: info.dias || 0, margem: info.margem || 0, log: ctx.log, leitura: ctx.leitura }),
};

// Roda um job que o Worker entregou. Falha vira etapa "erro" (o Worker libera a rota e a página segue com a estimativa).
export async function executarJob(job, { pegarJson, avisar, log, leitura, tipos = TIPOS }) {
  try {
    const info = await pegarJson(`/api/varredura/job/${job}`);
    const rodar = tipos[info.tipo];
    if (!rodar) throw new Error(`tipo de job desconhecido: ${info.tipo}`);
    log(`${job}: ${info.tipo} ${info.origem}>${info.destino}`);
    await rodar(info, { log: (s) => log(`${job}: ${s}`), leitura });
    log(`${job}: concluído`);
  } catch (e) {
    log(`${job}: ERRO ${e.message}`);
    if (e.name !== "ErroBloqueio") await avisar(job, "erro", String(e.message).slice(0, 190)).catch(() => {});
    // ErroBloqueio: verificar() já avisou "google_bloqueou" (o Worker põe o PC de molho por 30 min)
  }
}

export async function agente({
  log = console.log, leitura = "pc", maxSimultaneos = MAX_SIMULTANEOS, espera = ESPERA_S,
  pegarJson = (c, o) => pegar(c, { limiteMs: 40000, ...o }), avisar = etapa, descansar = dormir, parar = () => false, tipos,
} = {}) {
  let ativos = 0;
  let falhas = 0;
  const emAndamento = new Set();
  log(`agente no ar: até ${maxSimultaneos} jobs ao mesmo tempo`);
  while (!parar()) {
    if (ativos >= maxSimultaneos) { await descansar(1000); continue; }
    let r;
    try {
      r = await pegarJson(`/api/varredura/proximo?espera=${espera}`);
      falhas = 0;
    } catch (e) {
      falhas++;
      const pausa = Math.min(60000, 2000 * 2 ** Math.min(falhas, 5));
      if (falhas === 1 || falhas % 10 === 0) log(`aviso: não consegui falar com o Worker (${e.message}); tentando de novo em ${pausa / 1000} s`);
      await descansar(pausa);
      continue;
    }
    if (!r || !r.job) continue;
    ativos++;
    const p = executarJob(r.job, { pegarJson, avisar, log, leitura, tipos }).finally(() => { ativos--; emAndamento.delete(p); });
    emAndamento.add(p);
  }
  await Promise.all(emAndamento);
}
