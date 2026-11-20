import { dormir } from "./chrome.mjs";

function menorPrecoAba() {
  const n = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const aba = [...document.querySelectorAll("[role=tab]")].find((e) => n(e.textContent).startsWith("menores pre"));
  const preco = aba && aba.querySelector('[aria-label$="Reais brasileiros"]');
  const m = preco && preco.getAttribute("aria-label").match(/^([0-9]+)/);
  return m ? Number(m[1]) : null;
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
    while (Date.now() - inicio < limiteMs) {
      await dormir(500);
      const v = await chrome.avaliar(menorPrecoAba);
      if (v !== ultimo) { ultimo = v; mudou = Date.now(); }
      if (ultimo !== null && Date.now() - mudou >= estavelMs) return ultimo;
    }
    log(`${busca.origem}>${busca.destino} ${busca.ida}: tentativa ${t} sem preço estável`);
  }
  return null;
}
