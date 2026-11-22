import { abrirChrome } from "./chrome.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { lerPrecos, ABAS_PADRAO } from "./leitor.mjs";
import { lerCalendario } from "./calendario.mjs";
import { lerMenorPreco } from "./confirmar.mjs";
import { etapa, postar } from "./enviar.mjs";

export const EXTRA_DIAS = 4; // a "sugestão" olha até margem + 4 dias além do pedido

const agora = () => new Date().toISOString();
const avisar = (job, nome, detalhe) => etapa(job, nome, detalhe).catch(() => {});

async function lerPerna({ job, origem, destino, sentido, log, leitura, estado = { falhou: false } }) {
  const chrome = await abrirChrome();
  try {
    const [de, para] = sentido === "ida" ? [origem, destino] : [destino, origem];
    const r = await lerCalendario(chrome, de, para, { log, cancelado: () => estado.falhou });
    if (!r.cobertura) { estado.falhou = true; throw new Error(`sem preços de ${de} para ${para}`); } // sem uma perna não há ida e volta: a outra para de ler
    if (estado.falhou) { const e = new Error("leitura cancelada: a outra perna não tem voo"); e.cancelada = true; throw e; } // calendário pela metade não vai ao Worker
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
  const estado = { falhou: false };
  const [ida, volta] = await Promise.allSettled([
    lerPerna({ job, origem, destino, sentido: "ida", log, leitura, estado }),
    lerPerna({ job, origem, destino, sentido: "volta", log, leitura, estado }),
  ]);
  const caiu = [ida, volta].filter((x) => x.status === "rejected");
  if (caiu.length) {
    // a perna cancelada devolve o que já leu, e o erro útil é o da que não tem voo
    const x = caiu.find((c) => !c.reason.cancelada) || caiu[0];
    await avisar(job, "erro", x.reason.message.slice(0, 190));
    throw x.reason;
  }
  // Desde a F3.3 a busca só entrega o calendário. Os preços reais de agência vêm da verificação automática dos
  // melhores candidatos (GET /api/verificar?melhores=N, job verificar.yml): 6 abas, do mais barato ao mais caro,
  // parando cedo. Antes este job confirmava aqui, em levas sequenciais de 3.
  await avisar(job, "pronto");
}
