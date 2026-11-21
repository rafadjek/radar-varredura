import { dormir } from "./chrome.mjs";
import { rotaConfere, datasConferem } from "./pagina.mjs";

function menorPrecoAba() {
  const n = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const aba = [...document.querySelectorAll("[role=tab]")].find((e) => n(e.textContent).startsWith("menores pre"));
  const preco = aba && aba.querySelector('[aria-label$="Reais brasileiros"]');
  const m = preco && preco.getAttribute("aria-label").match(/^([0-9][0-9.]*) Reais brasileiros$/);
  return m ? Number(m[1].split(".").join("")) : null;
}

export function urlBusca({ origem, destino, ida, volta }) {
  const q = volta
    ? `Flights from ${origem} to ${destino} on ${ida} through ${volta}`
    : `Flights from ${origem} to ${destino} on ${ida} one way`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&curr=BRL`;
}

// Menor preço mostrado pelo Google (aba "Menores preços"). O Google atualiza o valor quando chegam as
// ofertas das agências, então só vale o valor que fica estável por ESTAVEL_MS.
export async function lerMenorPreco(chrome, busca, { estavelMs = 6000, limiteMs = 40000, tentativas = 2, log = () => {} } = {}) {
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
      if (ultimo !== null && Date.now() - mudou >= estavelMs) {
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
