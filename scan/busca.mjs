import { abrirChrome } from "./chrome.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { lerPrecos, ABAS_PADRAO } from "./leitor.mjs";
import { lerCalendario } from "./calendario.mjs";
import { lerMenorPreco } from "./confirmar.mjs";
import { etapa, postar } from "./enviar.mjs";
import { melhoresPares, paresParaConfirmar, paresDeSugestao, vizinhos } from "./pares.mjs";

export const EXTRA_DIAS = 4; // a "sugestão" olha até margem + 4 dias além do pedido

const agora = () => new Date().toISOString();
const avisar = (job, nome, detalhe) => etapa(job, nome, detalhe).catch(() => {});

async function lerPerna({ job, origem, destino, sentido, log, leitura }) {
  const chrome = await abrirChrome();
  try {
    const [de, para] = sentido === "ida" ? [origem, destino] : [destino, origem];
    const r = await lerCalendario(chrome, de, para, { log });
    if (!r.cobertura) throw new Error(`sem preços de ${de} para ${para}`);
    await postar("/api/varredura/resultado", { job, tipo: "calendario", origem, destino, sentido, dias: r.dias, cobertura: r.cobertura, leitura, lidoEm: agora() });
    log(`${sentido} enviado: ${r.cobertura} dias${r.completo ? "" : " (cobertura incompleta)"}`);
    return r.dias;
  } finally { await chrome.fechar(); }
}

async function confirmarUm({ job, origem, destino, par, log, leitura }) {
  const chrome = await abrirChrome();
  try {
    const preco = await lerMenorPreco(chrome, { origem, destino, ida: par.ida, volta: par.volta }, { log });
    if (preco === null) throw new Error(`não consegui ler o menor preço de ${par.ida} ${par.volta || ""}`);
    log(`confirmado ${origem}>${destino} ${par.ida} ${par.volta || ""}: R$ ${preco}`);
    await postar("/api/varredura/resultado", { job, tipo: "confirmacao", origem, destino, ida: par.ida, volta: par.volta || "", preco, leitura, lidoEm: agora() });
    return preco;
  } finally { await chrome.fechar(); }
}

// Confirma vários pares com o leitor novo: um navegador com N abas (ABAS, padrão 3). LEITOR=antigo volta ao
// leitor de um navegador por par (reserva até o A/B da F3.2 ser aceito). Cada preço vai ao Worker assim que é lido.
// Página barrada pelo Google (ErroBloqueio) sobe como erro: o chamador avisa o Worker, que passa a usar a nuvem.
export async function confirmarComAbas({ job, origem, destino, pares, log, leitura, abas = Number(process.env.ABAS) || ABAS_PADRAO }) {
  const navegador = await abrirNavegador();
  try {
    const lidos = await lerPrecos(navegador, {
      origem, destino, pares, abas, log,
      aoLer: async (par, preco) => {
        log(`confirmado ${origem}>${destino} ${par.ida} ${par.volta || ""}: R$ ${preco}`);
        await postar("/api/varredura/resultado", { job, tipo: "confirmacao", origem, destino, ida: par.ida, volta: par.volta || "", preco, leitura, lidoEm: agora() });
      },
    });
    if (!lidos.length) throw new Error("nenhuma confirmação deu certo");
    return lidos;
  } finally { await navegador.fechar(); }
}

export const confirmarEmParalelo = (args) => (process.env.LEITOR === "antigo" ? confirmarUmaPorVez(args) : confirmarComAbas(args));

// Leitor antigo: confirma vários pares ao mesmo tempo (um navegador por par). Falha só se nenhum deu certo.
export async function confirmarUmaPorVez({ job, origem, destino, pares, log, leitura }) {
  const r = await Promise.allSettled(pares.map((par) => confirmarUm({ job, origem, destino, par, log, leitura })));
  r.forEach((x) => { if (x.status === "rejected") log(`aviso: ${x.reason.message}`); });
  const ok = r.map((x, i) => (x.status === "fulfilled" ? { par: pares[i], preco: x.value } : null)).filter(Boolean);
  if (!ok.length) throw new Error("nenhuma confirmação deu certo");
  return ok;
}

// Busca inteira num job só: ida e volta em paralelo -> pares em memória -> confirmações em paralelo.
// Confirma os 3 melhores pares da janela pedida e o melhor par fora dela (a sugestão da página).
export async function buscar({ job, origem, destino, dias, margem, log, leitura }) {
  await avisar(job, "ida");
  const [ida, volta] = await Promise.allSettled([
    lerPerna({ job, origem, destino, sentido: "ida", log, leitura }),
    lerPerna({ job, origem, destino, sentido: "volta", log, leitura }),
  ]);
  for (const x of [ida, volta]) if (x.status === "rejected") { await avisar(job, "erro", x.reason.message.slice(0, 190)); throw x.reason; }
  if (dias > 0) {
    const [iv, vv] = [ida.value, volta.value];
    const dentro = paresParaConfirmar(melhoresPares(iv, vv, dias, margem, 80));
    const fora = paresDeSugestao(iv, vv, dias, margem, EXTRA_DIAS).map((p) => ({ ida: p.ida, volta: p.volta, total: p.total }));
    // 1ª leva (o que a página mostra logo): 3 melhores da janela + o melhor fora dela. Demais em levas de 3 (calendário
    // chapado: ver paresParaConfirmar); a página não espera por elas.
    const primeira = dentro.slice(0, 3);
    if (fora.length) primeira.push(fora[0]);
    const resto = [...dentro.slice(3), ...fora.slice(1)];
    const levas = [primeira];
    for (let i = 0; i < resto.length; i += 3) levas.push(resto.slice(i, i + 3));
    log(`pares a confirmar: ${JSON.stringify(levas)}`);
    await avisar(job, "confirmando");
    const lidos = [];
    for (const leva of levas) {
      if (!leva.length) continue;
      try { lidos.push(...await confirmarEmParalelo({ job, origem, destino, pares: leva, log, leitura })); }
      catch (e) { // o calendário já foi entregue; sem confirmação a página fica com o estimado
        log(`aviso: ${e.message}`);
        if (e.name === "ErroBloqueio") { await avisar(job, "erro", "google_bloqueou"); return; } // disjuntor: nada de insistir
      }
    }
    // Refino: o preço de agência muda pouco de um dia para o vizinho; olha ao redor do melhor par da janela pedida.
    const minP = Math.max(1, dias - margem);
    const naJanela = lidos.filter((x) => { const n = Math.round((new Date(x.par.volta) - new Date(x.par.ida)) / 86400000); return n >= minP && n <= dias + margem; });
    if (dentro.length > 5 && naJanela.length >= 2) { // só no calendário chapado
      const melhor = naJanela.reduce((m, x) => (x.preco < m.preco ? x : m));
      const perto = vizinhos(iv, vv, melhor.par, lidos.map((x) => x.par), dias, margem, 0, 3);
      if (perto.length) {
        log(`refino ao redor de ${melhor.par.ida}>${melhor.par.volta} (R$ ${melhor.preco}): ${JSON.stringify(perto)}`);
        try { await confirmarEmParalelo({ job, origem, destino, pares: perto, log, leitura }); }
        catch (e) { log(`aviso: ${e.message}`); if (e.name === "ErroBloqueio") { await avisar(job, "erro", "google_bloqueou"); return; } }
      }
    }
  }
  await avisar(job, "pronto");
}
