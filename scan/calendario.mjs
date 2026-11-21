import { dormir } from "./chrome.mjs";
import { rotaConfere } from "./pagina.mjs";

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
    const m = p && p.getAttribute("aria-label").match(/([0-9][0-9.]*) Reais/);
    return [e.getAttribute("data-iso"), m ? Number(m[1].split(".").join("")) : null];
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

// Meses sem (quase) preço entre `desde` (padrão: a primeira data lida) e o último mês lido, que pode ser parcial
// e por isso não conta. O Google às vezes não devolve uma janela; essas faltas pedem leitura de novo.
export function mesesVazios(dias, desde) {
  const datas = Object.keys(dias).sort();
  if (!datas.length) return [];
  const porMes = {};
  for (const d of datas) porMes[d.slice(0, 7)] = (porMes[d.slice(0, 7)] || 0) + 1;
  const inicio = desde && desde < datas[0] ? desde : datas[0];
  let [a, m] = inicio.slice(0, 7).split("-").map(Number);
  const [fa, fm] = datas.at(-1).slice(0, 7).split("-").map(Number);
  const vazios = [];
  while (a < fa || (a === fa && m < fm)) {
    const chave = `${a}-${String(m).padStart(2, "0")}`;
    let exigidos = 8;
    if (inicio.slice(0, 7) === chave) exigidos = Math.min(8, new Date(Date.UTC(a, m, 0)).getUTCDate() - Number(inicio.slice(8, 10)) + 1);
    if ((porMes[chave] || 0) < exigidos) vazios.push(chave);
    m++; if (m > 12) { m = 1; a++; }
  }
  return vazios;
}

function anterior() {
  const visivel = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const cel = [...document.querySelectorAll("[data-iso]")].find(visivel);
  let c = cel;
  for (let i = 0; i < 12 && c && c.getAttribute("role") !== "dialog"; i++) c = c.parentElement;
  const seta = [...(c || document).querySelectorAll("button,[role=button]")].filter(visivel)
    .filter((e) => /anterior|voltar|previous/i.test(e.getAttribute("aria-label") || "")).shift();
  if (!seta) return false;
  seta.click();
  return true;
}

// Espera a contagem de preços ficar igual por alguns instantes (primeira tela e passadas de reparo).
async function esperarEstavel(chrome, limiteMs = 8000, iguais = 4) {
  const inicio = Date.now();
  let anteriorN = -1;
  let seguidas = 0;
  while (Date.now() - inicio < limiteMs) {
    await dormir(350);
    const n = (await chrome.avaliar(lerCelulas)).filter(([, p]) => p !== null).length;
    seguidas = n === anteriorN ? seguidas + 1 : 0;
    anteriorN = n;
    if (n > 0 && seguidas >= iguais) return n;
  }
  return Math.max(anteriorN, 0);
}

// Calendário só ida de um sentido (origem -> destino), até ~11 meses. Soma o que cada tentativa trouxe.
// Devolve { dias, cobertura, completo }.
export async function lerCalendario(chrome, origem, destino, { log = () => {}, tentativas = 3, hoje = new Date() } = {}) {
  const base = new Date(hoje.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const desde = hoje.toISOString().slice(0, 10);
  const dias = {};
  const lerTudo = async () => { for (const [iso, p] of await chrome.avaliar(lerCelulas)) if (p !== null) dias[iso] = p; };
  let completo = false;
  for (let t = 1; t <= tentativas && !completo; t++) {
    if (t > 1) await dormir(20000); // o Google estranha recargas seguidas
    await chrome.navegar(urlSoIda(origem, destino, base));
    let ok = false;
    for (let i = 0; i < 45 && !ok; i++) { await dormir(1000); ok = await chrome.avaliar(temAba); }
    if (!ok || !(await chrome.avaliar(abrirSeletor))) { log(`${origem}>${destino}: tentativa ${t} sem resultados do Google`); continue; }
    if (!(await chrome.avaliar(rotaConfere, origem, destino))) { log(`${origem}>${destino}: a página do Google não é desta rota, tentativa ${t} descartada`); continue; }
    let n = await esperarEstavel(chrome, 15000, 6); // primeira tela: os preços dos 2 primeiros meses demoram
    for (let pag = 0; pag < 12; pag++) {
      await lerTudo();
      if (!(await chrome.avaliar(avancar))) break;
      // Clicar os meses em sequência curta não funciona: o Google só carrega as janelas que ficam na tela.
      n = await esperarMes(chrome, n);
    }
    await lerTudo();
    // Reparo no mesmo calendário (sem recarregar o Google): volta ao início e reavança, pedindo de novo as janelas que faltam.
    for (let reparo = 1; reparo <= 2 && mesesVazios(dias, desde).length; reparo++) {
      log(`${origem}>${destino}: reparo ${reparo}, meses vazios: ${mesesVazios(dias, desde).join(",")}`);
      for (let k = 0; k < 12 && (await chrome.avaliar(anterior)); k++) { await esperarEstavel(chrome, 5000, 3); await lerTudo(); }
      for (let k = 0; k < 12; k++) {
        await esperarEstavel(chrome, 5000, 3);
        await lerTudo();
        if (!(await chrome.avaliar(avancar))) break;
      }
      await lerTudo();
    }
    const cobertura = Object.keys(dias).length;
    const vazios = mesesVazios(dias, desde);
    completo = cobertura >= DIAS_ESPERADOS * COBERTURA_MINIMA && !vazios.length;
    log(`${origem}>${destino}: tentativa ${t}, ${cobertura} dias com preço${vazios.length ? `, meses vazios: ${vazios.join(",")}` : ""}`);
  }
  return { dias, cobertura: Object.keys(dias).length, completo };
}
