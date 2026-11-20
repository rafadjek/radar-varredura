import { dormir } from "./chrome.mjs";

// Funções que rodam DENTRO da página do Google Voos (por isso não usam nada deste arquivo).
function temAba() {
  const n = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return !![...document.querySelectorAll("[role=tab]")].find((e) => n(e.textContent).startsWith("menores pre"));
}
function abrirSeletor() {
  const el = [...document.querySelectorAll("input")].find((e) => /partida/i.test(e.getAttribute("aria-label") || "") && e.getBoundingClientRect().width > 0);
  if (!el) return false;
  el.click(); el.focus();
  return true;
}
// O Google guarda as 365 células no HTML e o preço exato no aria-label (o texto mostra o valor arredondado).
function lerCelulas() {
  return [...document.querySelectorAll("[data-iso]")].map((e) => {
    const p = e.querySelector('[aria-label*="Reais brasileiros"]');
    const m = p && p.getAttribute("aria-label").match(/([0-9]+) Reais/);
    return [e.getAttribute("data-iso"), m ? Number(m[1]) : null];
  });
}
function avancar() {
  const visivel = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const cel = [...document.querySelectorAll("[data-iso]")].find(visivel);
  let c = cel;
  for (let i = 0; i < 12 && c && c.getAttribute("role") !== "dialog"; i++) c = c.parentElement;
  const seta = [...(c || document).querySelectorAll("button,[role=button]")].filter(visivel)
    .filter((e) => /pr[oó]xim|avan[cç]|next|seguinte/i.test(e.getAttribute("aria-label") || "")).pop();
  if (!seta) return false;
  seta.click();
  return true;
}

export const DIAS_ESPERADOS = 330;
const COBERTURA_MINIMA = 0.9;

export function urlSoIda(origem, destino, data) {
  const q = `Flights from ${origem} to ${destino} on ${data} one way`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&curr=BRL`;
}

// O Google guarda os preços já carregados no HTML, então a contagem só cresce quando o mês novo chega.
// Espera a contagem passar de `minimo` e estabilizar; se nada novo vier (fim do período), desiste no limite.
async function esperarMes(chrome, minimo, limiteMs = 9000) {
  const inicio = Date.now();
  let anterior = -1;
  let n = minimo;
  while (Date.now() - inicio < limiteMs) {
    await dormir(350);
    n = (await chrome.avaliar(lerCelulas)).filter(([, p]) => p !== null).length;
    if (n > minimo && n === anterior) return n;
    anterior = n;
  }
  return n;
}

// Meses entre a primeira e a última data lidas com quase nenhum preço (o Google às vezes não devolve uma janela).
export function mesesVazios(dias) {
  const datas = Object.keys(dias).sort();
  if (!datas.length) return [];
  const porMes = {};
  for (const d of datas) porMes[d.slice(0, 7)] = (porMes[d.slice(0, 7)] || 0) + 1;
  const vazios = [];
  let [a, m] = datas[0].slice(0, 7).split("-").map(Number);
  const [fa, fm] = datas.at(-1).slice(0, 7).split("-").map(Number);
  while (a < fa || (a === fa && m <= fm)) {
    const chave = `${a}-${String(m).padStart(2, "0")}`;
    if ((porMes[chave] || 0) < 8) vazios.push(chave);
    m++; if (m > 12) { m = 1; a++; }
  }
  return vazios;
}

// Calendário só ida de um sentido (origem -> destino), até ~11 meses. Soma o que cada tentativa trouxe.
// Devolve { dias, cobertura, completo }.
export async function lerCalendario(chrome, origem, destino, { log = () => {}, tentativas = 3, hoje = new Date() } = {}) {
  const base = new Date(hoje.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const dias = {};
  let completo = false;
  for (let t = 1; t <= tentativas && !completo; t++) {
    await chrome.navegar(urlSoIda(origem, destino, base));
    let ok = false;
    for (let i = 0; i < 45 && !ok; i++) { await dormir(1000); ok = await chrome.avaliar(temAba); }
    if (!ok || !(await chrome.avaliar(abrirSeletor))) { log(`${origem}>${destino}: tentativa ${t} sem resultados do Google`); continue; }
    let n = await esperarMes(chrome, 0);
    for (let pag = 0; pag < 12; pag++) {
      for (const [iso, p] of await chrome.avaliar(lerCelulas)) if (p !== null) dias[iso] = p;
      if (!(await chrome.avaliar(avancar))) break;
      n = await esperarMes(chrome, n);
    }
    for (const [iso, p] of await chrome.avaliar(lerCelulas)) if (p !== null) dias[iso] = p;
    const cobertura = Object.keys(dias).length;
    const vazios = mesesVazios(dias);
    completo = cobertura >= DIAS_ESPERADOS * COBERTURA_MINIMA && !vazios.length;
    log(`${origem}>${destino}: tentativa ${t}, ${cobertura} dias com preço${vazios.length ? `, meses vazios: ${vazios.join(",")}` : ""}`);
  }
  return { dias, cobertura: Object.keys(dias).length, completo };
}
