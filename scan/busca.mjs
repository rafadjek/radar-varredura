import { abrirChrome } from "./chrome.mjs";
import { lerCalendario } from "./calendario.mjs";
import { lerMenorPreco } from "./confirmar.mjs";
import { etapa, postar } from "./enviar.mjs";
import { melhoresPares, melhorParForaDaJanela } from "./pares.mjs";

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
  } finally { chrome.fechar(); }
}

async function confirmarUm({ job, origem, destino, par, log, leitura }) {
  const chrome = await abrirChrome();
  try {
    const preco = await lerMenorPreco(chrome, { origem, destino, ida: par.ida, volta: par.volta }, { log });
    if (preco === null) throw new Error(`não consegui ler o menor preço de ${par.ida} ${par.volta || ""}`);
    log(`confirmado ${origem}>${destino} ${par.ida} ${par.volta || ""}: R$ ${preco}`);
    await postar("/api/varredura/resultado", { job, tipo: "confirmacao", origem, destino, ida: par.ida, volta: par.volta || "", preco, leitura, lidoEm: agora() });
    return preco;
  } finally { chrome.fechar(); }
}

// Confirma vários pares ao mesmo tempo (um navegador por par). Falha só se nenhum deu certo.
export async function confirmarEmParalelo({ job, origem, destino, pares, log, leitura }) {
  const r = await Promise.allSettled(pares.map((par) => confirmarUm({ job, origem, destino, par, log, leitura })));
  r.forEach((x) => { if (x.status === "rejected") log(`aviso: ${x.reason.message}`); });
  const ok = r.filter((x) => x.status === "fulfilled").length;
  if (!ok) throw new Error("nenhuma confirmação deu certo");
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
    const dentro = melhoresPares(ida.value, volta.value, dias, margem, 5);
    const fora = melhorParForaDaJanela(ida.value, volta.value, dias, margem, EXTRA_DIAS);
    // 1ª leva (o que a página mostra logo): 3 melhores da janela + o melhor fora dela. 2ª leva: 4º e 5º da janela, para a
    // sugestão achar o par realmente mais barato; a página não espera por ela.
    const primeira = dentro.slice(0, 3);
    if (fora) primeira.push({ ida: fora.ida, volta: fora.volta, total: fora.total });
    const segunda = dentro.slice(3);
    log(`pares a confirmar: ${JSON.stringify(primeira)} e depois ${JSON.stringify(segunda)}`);
    await avisar(job, "confirmando");
    for (const leva of [primeira, segunda]) {
      if (!leva.length) continue;
      try { await confirmarEmParalelo({ job, origem, destino, pares: leva, log, leitura }); }
      catch (e) { log(`aviso: ${e.message}`); } // o calendário já foi entregue; sem confirmação a página fica com o estimado
    }
  }
  await avisar(job, "pronto");
}
