import { dormir as dormirReal } from "./chrome.mjs";
import { abrirNavegador, ErroBloqueio } from "./navegador.mjs";
import { lerPrecos } from "./leitor.mjs";
import { etapa, postar } from "./enviar.mjs";
import { criarLotes, ABAS_VERIFICAR } from "./verificar.mjs";
import { lerParHttp, criarRitmo, criarDisjuntor } from "./leitorHttp.mjs";
import { amostraInicial, passoAmostra, proximosRefino, duracoesParaLer, escolherFinalistas } from "./orcamento.mjs";
import * as v from "./validar.mjs";

// Job "rapida": lê poucas datas escolhidas em vez de varrer 330 dias. Motor HTTP (preço da companhia, ~1 s) para a
// amostra, o refino e a variação de dias; Edge (3 abas, preço com agência) só para confirmar os finalistas.
// Cada preço lido vai ao Worker em lote assim que chega, para a página mostrar a lista progressivamente.
// Spec: apoio/specs/2026-11-28-radarpassagens-leitura-rapida-design.md

export const N_IDAS = 329;
export const ORCAMENTO = 45;
export const MAX_EDGE_RESERVA = 15; // leituras no Edge no lugar do HTTP quando o disjuntor abre (cada uma leva ~5-9 s)
const DIA_MS = 86400000;
const PAUSA_ERRO13_MS = 4000;
const SIMULTANEAS = 6;

const somarDias = (dataIso, n) => new Date(Date.parse(`${dataIso}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);

export async function rapida({
  job, origem, destino, dias, margem = 0, log = () => {}, leitura = "pc", orcamento = ORCAMENTO, hoje = new Date(),
  lerHttp = lerParHttp, disjuntor, abrir = abrirNavegador, lerEdge = lerPrecos, enviar = postar, avisar = etapa,
  dormir = dormirReal, ritmo, deslocamento, agora = () => new Date(),
}) {
  v.job(job); v.rota(origem, "origem"); v.rota(destino, "destino");
  dias = v.inteiro(dias, 1, 35, "dias");
  margem = v.inteiro(margem, 0, 10, "margem");
  disjuntor ||= criarDisjuntor();
  ritmo ||= criarRitmo({ dormir });

  // idas: de amanhã em diante (data local do PC), N_IDAS dias
  const amanha = new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()) + DIA_MS).toISOString().slice(0, 10);
  const idaDe = (i) => somarDias(amanha, i);
  const parDe = (i, d = dias) => ({ ida: idaDe(i), volta: somarDias(idaDe(i), d) });

  const lidos = new Map(); // "ida|volta" -> { ida, volta, preco, leitura }
  const porIndice = new Map(); // índice da ida (duração nominal) -> preço | null (null = tentou e falhou)
  const indiceDe = new Map(); // ida -> índice
  let gastos = 0;
  let modo = "http";
  let edgeUsado = 0;
  let navegador = null;

  const lotes = criarLotes({
    log, esperaMs: 3000,
    enviarLote: (itens) => enviar("/api/varredura/lote", { job, itens }),
    enviarUm: (item) => enviar("/api/varredura/resultado", { job, tipo: "confirmacao", ...item }),
  });
  const ehNominal = (par) => par.volta === somarDias(par.ida, dias) && indiceDe.has(par.ida);
  const guardar = (par, preco, leit) => {
    lidos.set(`${par.ida}|${par.volta}`, { ida: par.ida, volta: par.volta, preco, leitura: leit });
    if (ehNominal(par)) porIndice.set(indiceDe.get(par.ida), preco);
    return lotes.add({ origem, destino, ida: par.ida, volta: par.volta, preco, lidoEm: agora().toISOString(), leitura: leit });
  };

  // ---- motor HTTP: pool de SIMULTANEAS leitoras; devolve os pares que o HTTP não pôde ler (disjuntor aberto)
  let captcha = false;
  async function lerUmHttp(par) {
    const tentar = async () => {
      const r = await ritmo.executar(() => lerHttp({ origem, destino, ida: par.ida, volta: par.volta }));
      disjuntor.registrar(!r.erro);
      if (r.erro === "captcha") captcha = true;
      return r;
    };
    let r = await tentar();
    if (r.erro === "erro13" && !disjuntor.aberto() && !captcha) { await dormir(PAUSA_ERRO13_MS); r = await tentar(); }
    return r;
  }
  async function lerPorHttp(pares) {
    const fila = [...pares];
    const semLer = [];
    async function leitora() {
      while (fila.length) {
        const par = fila.shift();
        if (disjuntor.aberto() || captcha || gastos >= orcamento) { semLer.push(par); continue; }
        gastos++;
        let r;
        try { r = await lerUmHttp(par); } catch (e) { r = { erro: e.message }; }
        if (typeof r.preco === "number") await guardar(par, r.preco, "pc_cia");
        else {
          if (ehNominal(par) && !porIndice.has(indiceDe.get(par.ida))) porIndice.set(indiceDe.get(par.ida), null);
          log(`aviso: ${par.ida} ${par.volta}: ${r.erro || "sem preço"}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SIMULTANEAS, Math.max(1, fila.length)) }, leitora));
    return { semLer };
  }

  // ---- motor Edge (lento, preço com agência)
  async function lerPorEdge(pares, { limitado = false } = {}) {
    let lista = pares.filter((p) => lidos.get(`${p.ida}|${p.volta}`)?.leitura !== "pc");
    if (limitado) {
      const sobra = Math.max(0, MAX_EDGE_RESERVA - edgeUsado);
      if (lista.length > sobra) {
        const salto = lista.length / sobra;
        lista = sobra ? Array.from({ length: sobra }, (_, k) => lista[Math.floor(k * salto)]) : [];
      }
      edgeUsado += lista.length;
    }
    if (!lista.length) return;
    navegador ||= await abrir();
    log(`Edge: lendo ${lista.length} datas`);
    await lerEdge(navegador, { origem, destino, pares: lista, abas: ABAS_VERIFICAR, log, escalonarMs: 150, aoLer: (par, preco) => guardar(par, preco, leitura) });
    await lotes.esvaziar();
  }

  // ---- uma leva de leituras: HTTP enquanto der; o que o disjuntor barrar (ou tudo, se já estamos no Edge) vai ao Edge
  async function lerLeva(pares) {
    if (!pares.length) return;
    if (modo === "edge") return lerPorEdge(pares, { limitado: true });
    const { semLer } = await lerPorHttp(pares);
    await lotes.esvaziar();
    if (disjuntor.aberto() || captcha) {
      log("aviso: o Google recusou leituras diretas; o resto da busca vai pelo Edge (mais lento)");
      modo = "edge";
      const barrados = semLer.filter((p) => !lidos.has(`${p.ida}|${p.volta}`));
      if (barrados.length) await lerPorEdge(barrados, { limitado: true });
    }
  }

  const dosLidos = () => [...lidos.values()];
  const menoresNominais = (k) => [...porIndice.entries()].filter(([, p]) => typeof p === "number").sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, k).map(([i]) => i);
  const livre = () => (modo === "http" ? orcamento - gastos : MAX_EDGE_RESERVA - edgeUsado);

  try {
    await avisar(job, "lendo").catch(() => {});
    for (let i = 0; i < N_IDAS; i++) indiceDe.set(idaDe(i), i);
    const passo = passoAmostra(N_IDAS, orcamento);
    const desl = deslocamento ?? Math.floor(Math.random() * passo);

    // E1: amostra uniforme
    const amostra = amostraInicial(N_IDAS, orcamento, desl);
    log(`rapida ${origem}>${destino} ${dias} dias (±${margem}): amostra de ${amostra.length} datas, passo ${passo}`);
    await lerLeva(amostra.map((i) => parDe(i)));
    // nada lido (erro 13 em tudo, antes de o disjuntor abrir): as datas da amostra vão pelo Edge
    if (!dosLidos().length && modo === "http") {
      log("aviso: nenhuma leitura direta deu certo; passando para o Edge");
      modo = "edge";
      await lerPorEdge(amostra.map((i) => parDe(i)), { limitado: true });
    }

    // E2: refino em volta dos melhores (até 3 rodadas; cada uma gasta no máximo metade do que sobra, menos a reserva da variação)
    const durExtras = margem > 0 ? duracoesParaLer(dias, margem) : [];
    const reservaVariacao = margem > 0 ? Math.min(2 * durExtras.length, Math.floor(livre() * 0.4)) : 0;
    for (let rodada = 0; rodada < 3; rodada++) {
      const folga = livre() - reservaVariacao;
      if (folga <= 0) break;
      const proximos = proximosRefino(porIndice, N_IDAS, passo, rodada, Math.ceil(folga / 2));
      if (!proximos.length) break;
      await lerLeva(proximos.map((i) => parDe(i)));
    }

    // E3: variação de dias só nos 2 melhores
    if (margem > 0) {
      const melhores = menoresNominais(2);
      const alvo = [];
      for (const d of durExtras) for (const i of melhores) alvo.push(parDe(i, d));
      await lerLeva(alvo.slice(0, Math.max(0, livre())));
    }

    // E4: confirmação de agência no Edge, em duas levas de 3 (cada uma é enviada ao terminar)
    await avisar(job, "confirmando").catch(() => {});
    const jaPegos = new Set(dosLidos().filter((l) => l.leitura === "pc").map((l) => `${l.ida}|${l.volta}`));
    const leva1 = escolherFinalistas(dosLidos(), 3, [...jaPegos]);
    if (leva1.length) {
      await lerPorEdge(leva1);
      for (const l of leva1) jaPegos.add(`${l.ida}|${l.volta}`);
      const leva2 = escolherFinalistas(dosLidos(), 3, [...jaPegos]);
      if (leva2.length) await lerPorEdge(leva2);
    } else log("aviso: nada foi lido; sem finalistas para confirmar");
    await lotes.esvaziar();
    await avisar(job, "pronto").catch(() => {});
    return { lidos: lidos.size, confirmados: dosLidos().filter((l) => l.leitura === "pc").length, modo };
  } catch (e) {
    await lotes.esvaziar().catch(() => {});
    if (e instanceof ErroBloqueio || e?.name === "ErroBloqueio") await avisar(job, "erro", "google_bloqueou").catch(() => {});
    throw e;
  } finally {
    if (navegador) await navegador.fechar().catch(() => {});
  }
}
