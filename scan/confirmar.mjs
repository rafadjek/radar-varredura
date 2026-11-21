import { dormir } from "./chrome.mjs";
import { rotaConfere, datasConferem } from "./pagina.mjs";
import { construirTfs } from "./tfs.mjs";

export function menorPrecoAba() {
  const n = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const aba = [...document.querySelectorAll("[role=tab]")].find((e) => n(e.textContent).startsWith("menores pre"));
  const preco = aba && aba.querySelector('[aria-label$="Reais brasileiros"]');
  const m = preco && preco.getAttribute("aria-label").match(/^([0-9][0-9.]*) Reais brasileiros$/);
  return m ? Number(m[1].split(".").join("")) : null;
}

export function urlBusca({ origem, destino, ida, volta }) {
  const tfs = construirTfs({ origem, destino, ida, volta: volta || "" });
  return `https://www.google.com/travel/flights?tfs=${encodeURIComponent(tfs)}&hl=pt-BR&gl=BR&curr=BRL`;
}

// Menor preço mostrado pelo Google (aba "Menores preços"). O Google atualiza o valor quando chegam as
// ofertas das agências, então só vale o valor que fica estável por ESTAVEL_MS.
// O Google mostra primeiro o preço da companhia (ex.: 755) e, de 1 a ~6 s depois (mais com vários navegadores abertos
// ao mesmo tempo), a oferta mais barata (716). Aceitar o valor cedo lê o preço da companhia. Por isso só se aceita
// depois de minimoMs desde a abertura E de estavelMs sem mudar.
export async function lerMenorPreco(chrome, busca, { estavelMs = 12000, minimoMs = 20000, limiteMs = 70000, tentativas = 2, log = () => {} } = {}) {
  for (let t = 1; t <= tentativas; t++) {
    await chrome.navegar(urlBusca(busca));
    const inicio = Date.now();
    let ultimo = null;
    let mudou = Date.now();
    const trajetoria = [];
    while (Date.now() - inicio < limiteMs) {
      await dormir(500);
      const v = await chrome.avaliar(menorPrecoAba);
      if (v !== ultimo) { ultimo = v; mudou = Date.now(); trajetoria.push(`${v}@${((Date.now() - inicio) / 1000).toFixed(1)}s`); }
      if (ultimo !== null && Date.now() - mudou >= estavelMs && Date.now() - inicio >= minimoMs) {
        const certa = (await chrome.avaliar(rotaConfere, busca.origem, busca.destino)) && (await chrome.avaliar(datasConferem, busca.ida, busca.volta || ""));
        log(`${busca.origem}>${busca.destino} ${busca.ida}: valor do Google ao longo do tempo: ${trajetoria.join(" -> ")}`);
        if (certa) return ultimo;
        log(`${busca.origem}>${busca.destino} ${busca.ida}: a página do Google não é da rota/datas pedidas, descartado`);
        break;
      }
    }
    log(`${busca.origem}>${busca.destino} ${busca.ida}: tentativa ${t} sem preço estável`);
  }
  return null;
}
