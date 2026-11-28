import { readFileSync, writeFileSync } from "node:fs";
import { construirTfs } from "./tfs.mjs";
import * as v from "./validar.mjs";
import { dormir as dormirReal } from "./chrome.mjs";

// Motor rápido do RadarPassagens: lê o preço da COMPANHIA direto da página pública do Google Voos (GET comum, sem
// token, sem cookie forjado: só o aceite de consentimento que qualquer navegador manda). ~1 s por leitura, mas o
// Google responde "erro 13" quando desconfia; por isso há ritmo fixo conservador e um disjuntor que desliga este motor
// (o resto da busca vai para o Edge) quando o erro passa de 40%.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const MARCA_ERRO = "type.googleapis.com/travel.frontend.flights.ErrorResponse";

// Lê o bloco `AF_initDataCallback({key: 'ds:1', ... data:[...], sideChannel: {}})` e devolve o menor preço. Os preços
// aparecem em listas `[[null, preço], "token-longo"]`; o token (> 20 caracteres) separa preço de oferta de número solto.
export function extrairMenorPreco(html) {
  const texto = String(html || "");
  const i = texto.indexOf("key: 'ds:1'");
  if (i < 0) return { erro: "sem_ds1" };
  const fimScript = texto.indexOf("</script>", i);
  const bloco = texto.slice(i, fimScript < 0 ? undefined : fimScript);
  if (bloco.includes(MARCA_ERRO)) return { erro: "erro13" };
  const j = bloco.indexOf("data:");
  const fim = bloco.indexOf(", sideChannel", j);
  if (j < 0 || fim < 0) return { erro: "json" };
  let dados;
  try { dados = JSON.parse(bloco.slice(j + 5, fim).trim()); } catch { return { erro: "json" }; }
  let menor = null;
  (function percorrer(n) {
    if (!Array.isArray(n)) return;
    if (n.length === 2 && Array.isArray(n[0]) && n[0][0] === null && typeof n[0][1] === "number" && typeof n[1] === "string" && n[1].length > 20) {
      if (menor === null || n[0][1] < menor) menor = n[0][1];
    }
    n.forEach(percorrer);
  })(dados);
  return menor === null ? { erro: "sem_precos" } : { preco: menor };
}

export async function lerParHttp(par, { buscar = fetch, limiteMs = 20000 } = {}) {
  v.rota(par.origem, "origem"); v.rota(par.destino, "destino"); v.data(par.ida, "ida");
  if (par.volta) v.data(par.volta, "volta");
  const tfs = construirTfs({ origem: par.origem, destino: par.destino, ida: par.ida, volta: par.volta });
  const url = `https://www.google.com/travel/flights?tfs=${encodeURIComponent(tfs)}&hl=pt-BR&gl=BR&curr=BRL`;
  let resp, html;
  try {
    resp = await buscar(url, {
      headers: { "user-agent": UA, "accept-language": "pt-BR,pt;q=0.9", cookie: "CONSENT=YES+cb" },
      signal: AbortSignal.timeout(limiteMs),
    });
    if (/\/sorry\/|recaptcha/i.test(String(resp.url || "")) || resp.status === 429) return { erro: "captcha" };
    html = await resp.text();
  } catch { return { erro: "rede" }; }
  return extrairMenorPreco(html);
}

// Ritmo: no máximo `concorrencia` leituras em voo e `porSegundo` inícios por segundo (espaçamento fixo entre inícios,
// com um jitter aleatório ANTES de pegar a vez, para não formar rajadas nem padrão rígido).
export function criarRitmo({ porSegundo = 5, concorrencia = 6, jitterMs = [100, 250], dormir = dormirReal, agora = Date.now, aleatorio = Math.random } = {}) {
  const intervalo = 1000 / porSegundo;
  let proximoInicio = 0;
  let emVoo = 0;
  const fila = [];
  const liberar = () => { emVoo--; const prox = fila.shift(); if (prox) prox(); };
  const pegarVaga = () => (emVoo < concorrencia ? (emVoo++, Promise.resolve()) : new Promise((res) => fila.push(() => { emVoo++; res(); })));
  return {
    async executar(fn) {
      await pegarVaga();
      try {
        const [min, max] = jitterMs;
        await dormir(min + aleatorio() * (max - min));
        const inicio = Math.max(agora(), proximoInicio);
        proximoInicio = inicio + intervalo;
        const espera = inicio - agora();
        if (espera > 0) await dormir(espera);
        return await fn();
      } finally { liberar(); }
    },
  };
}

export const estadoEmMemoria = () => { let guardado = null; return { ler: () => guardado, gravar: (o) => { guardado = o; } }; };

// Guarda o cooldown em arquivo para sobreviver a reiniciar o agente. Se não der para gravar (ex.: sem a pasta), vale só em memória.
export function estadoEmArquivo(caminho = process.env.RADAR_HTTP_COOLDOWN || "D:\Temp\radar-http-cooldown.json") {
  let memoria = null;
  return {
    ler() { try { return JSON.parse(readFileSync(caminho, "utf8")); } catch { return memoria; } },
    gravar(o) { memoria = o; try { writeFileSync(caminho, JSON.stringify(o)); } catch { /* só em memória */ } },
  };
}

// Disjuntor: abre quando a fração de falhas na janela (cheia) chega ao limite; fica aberto até o cooldown acabar,
// sem sondar. `registrar(true)` = leitura boa, `false` = erro 13/captcha.
export function criarDisjuntor({ janela = 20, limite = 0.4, cooldownMs = 90 * 60 * 1000, agora = Date.now, estado = estadoEmArquivo() } = {}) {
  let resultados = [];
  let ate = 0;
  const atual = () => Math.max(ate, Number(estado.ler()?.ate) || 0);
  return {
    registrar(ok) {
      if (this.aberto()) return;
      resultados.push(Boolean(ok));
      if (resultados.length > janela) resultados.shift();
      if (resultados.length === janela && resultados.filter((r) => !r).length / janela >= limite) {
        ate = agora() + cooldownMs;
        estado.gravar({ ate });
        resultados = [];
      }
    },
    aberto() {
      const a = atual();
      if (a > 0 && agora() < a) return true;
      if (a > 0) { ate = 0; resultados = []; }
      return false;
    },
    abertoAte: () => atual(),
  };
}
