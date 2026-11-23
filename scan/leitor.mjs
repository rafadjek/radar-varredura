import { dormir } from "./chrome.mjs";
import { rotaConfere, datasConferem } from "./pagina.mjs";
import { menorPrecoAba, urlBusca } from "./confirmar.mjs";
import { ErroBloqueio, paginaBloqueada, estadoDoFluxo } from "./navegador.mjs";

// Leitor novo do "menor preço" (Fase 3 / F3.2): várias abas num navegador só e fim de leitura pela rede.
// Convive com o leitor antigo (confirmar.mjs, um navegador por par) até o A/B passar; ver LEITOR em busca.mjs.

export const MAX_ABAS = 6; // medido na F3.0: 6 abas leram tudo sem captcha, mas cada par fica ~2,5x mais lento
export const ABAS_PADRAO = 3;

// Quando o preço lido já é o definitivo. O Google mostra primeiro o preço da companhia e, de 1 a 14 s depois, a
// oferta de agência (F3.0: em 18 de 20 pares o preço mudou depois do primeiro). Duas formas de ter certeza:
//  - "rede": a resposta GetShoppingResults terminou (nunca mudou o preço depois: 19 de 19) e o preço está parado
//    há `folgaMs` (a tela atualiza um instante depois do último quadro);
//  - "estavel": regra de reserva (mín. 30 s e 12 s sem mudar), para quando o fim da rede não aparece.
// Reserva "estavel": mínimo 30 s (era 20). Medido em 2026-11-22 com 4 aeroportos de origem: 3 de 12 pares ficaram em
// R$ 802 quando o certo era 775, porque a oferta de agência chegou aos 23 s, depois do mínimo de 20 s.
export function decidirFim({ t, preco, ultimaMudancaMs, fluxo, minimoMs = 30000, estavelMs = 12000, folgaMs = 1000 }) {
  if (preco === null || preco === undefined) return null;
  if (fluxo.iniciou && fluxo.ativas === 0 && fluxo.fimHaMs !== null && fluxo.fimHaMs >= folgaMs && t - ultimaMudancaMs >= folgaMs) return "rede";
  if (t >= minimoMs && t - ultimaMudancaMs >= estavelMs) return "estavel";
  return null;
}

// Lê o menor preço de um par numa aba já aberta. Devolve o preço ou null (2 tentativas); página barrada = ErroBloqueio.
export async function lerPrecoNaAba(aba, busca, { limiteMs = 60000, tentativas = 2, passoMs = 250, log = () => {}, agora = Date.now } = {}) {
  const rotulo = `${busca.origem}>${busca.destino} ${busca.ida}${busca.volta ? `→${busca.volta}` : ""}`;
  for (let tent = 1; tent <= tentativas; tent++) {
    if (aba.vivo && !aba.vivo()) throw new Error("o navegador caiu");
    await aba.navegar(urlBusca(busca));
    const inicio = agora();
    let ultimo = null;
    let mudou = inicio;
    let ultimaChecagem = 0;
    const trajetoria = [];
    while (agora() - inicio < limiteMs) {
      await dormir(passoMs);
      if (aba.vivo && !aba.vivo()) throw new Error("o navegador caiu"); // sem isso cada par esperaria o limite inteiro
      const t = agora() - inicio;
      if (t - ultimaChecagem >= 1000) {
        ultimaChecagem = t;
        const href = await aba.endereco();
        if (paginaBloqueada(href)) throw new ErroBloqueio(rotulo);
      }
      let v = null;
      try { v = await aba.avaliar(menorPrecoAba); } catch { /* página navegando */ }
      if (v !== ultimo) { ultimo = v; mudou = agora(); trajetoria.push(`${v}@${(t / 1000).toFixed(1)}s`); }
      const regra = decidirFim({ t, preco: ultimo, ultimaMudancaMs: mudou - inicio, fluxo: estadoDoFluxo(aba, agora()) });
      if (regra) {
        const certa = (await aba.avaliar(rotaConfere, busca.origem, busca.destino)) && (await aba.avaliar(datasConferem, busca.ida, busca.volta || ""));
        log(`${rotulo}: ${trajetoria.join(" -> ")} (fim: ${regra}, ${(t / 1000).toFixed(1)}s)`);
        if (certa) return ultimo;
        log(`${rotulo}: a página do Google não é da rota/datas pedidas, descartado`);
        break;
      }
    }
    log(`${rotulo}: tentativa ${tent} sem preço definitivo`);
  }
  return null;
}

// Lê vários pares ao mesmo tempo: `abas` abas num navegador só, cada uma pegando o próximo par da fila.
// `aoLer(par, preco)` roda assim que um par é lido (é onde o preço vai para o Worker). Se uma aba toma
// "sorry"/captcha, as outras param e o erro sobe (disjuntor). Devolve [{ par, preco }] só dos pares lidos e entregues.
export async function lerPrecos(navegador, { origem, destino, pares, abas = ABAS_PADRAO, log = () => {}, aoLer, ler = lerPrecoNaAba, escalonarMs = 400, parar }) {
  const fila = [...pares];
  const lidos = [];
  let bloqueio = null;
  const n = Math.max(1, Math.min(Number(abas) || ABAS_PADRAO, MAX_ABAS, pares.length));
  async function trabalhador(k) {
    await dormir(k * escalonarMs); // não abre todas as abas no mesmo instante
    let aba;
    try { aba = await navegador.novaAba(); } catch (e) { log(`aviso: não consegui abrir a aba ${k + 1}: ${e.message}`); return; } // as outras abas seguem
    try {
      while (!bloqueio) {
        if (parar && parar({ lidos, fila })) break; // ex.: os que sobraram não têm como ser o menor preço
        const par = fila.shift();
        if (!par) break;
        try {
          const preco = await ler(aba, { origem, destino, ida: par.ida, volta: par.volta || "" }, { log });
          if (preco === null) { log(`aviso: não consegui ler o menor preço de ${par.ida} ${par.volta || ""}`); continue; }
          if (aoLer) await aoLer(par, preco);
          lidos.push({ par, preco });
        } catch (e) {
          if (e instanceof ErroBloqueio) { bloqueio = e; break; }
          log(`aviso: ${par.ida} ${par.volta || ""}: ${e.message}`);
        }
      }
    } finally { await aba.fechar(); }
  }
  await Promise.all(Array.from({ length: n }, (_, k) => trabalhador(k)));
  if (bloqueio) throw bloqueio;
  return lidos;
}
