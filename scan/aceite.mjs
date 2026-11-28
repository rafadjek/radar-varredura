// Aceite medido da busca rápida (SÓ LOCAL: gasta consultas do Google, não entra em workflow). Spec: apoio/specs/2026-11-28-radarpassagens-leitura-rapida-design.md
//   node scan/aceite.mjs passo1                      30 leituras HTTP espaçadas (meta: >= 95% de sucesso, < 1,5 s cada)
//   node scan/aceite.mjs busca <O> <D> <dias> [margem]   uma busca completa sem Worker (envio simulado): tempos, modo e melhor preço
//   node scan/aceite.mjs passo2 <O> <D> <dias> [margem]  5 buscas seguidas, 2 min entre elas (meta: erro 13 <= 10%)
// O Edge vem de CHROME_BIN (ex.: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe).
import { rapida } from "./rapida.mjs";
import { lerParHttp } from "./leitorHttp.mjs";

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const [comando, ...a] = process.argv.slice(2);
const dia = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function passo1() {
  const rotas = [["GRU", "FOR"], ["GRU", "JDO"], ["CGH", "POA"]];
  let ok = 0; const tipos = {}; const ms = [];
  for (let k = 0; k < 30; k++) {
    const [o, d] = rotas[k % 3];
    const t0 = Date.now();
    const r = await lerParHttp({ origem: o, destino: d, ida: dia(20 + k * 4), volta: dia(40 + k * 4) });
    ms.push(Date.now() - t0);
    if (typeof r.preco === "number") ok++; else tipos[r.erro] = (tipos[r.erro] || 0) + 1;
    await dormir(2000);
  }
  ms.sort((x, y) => x - y);
  const taxa = ok / 30;
  console.log(`PASSO 1: ${ok}/30 (${(taxa * 100).toFixed(0)}%), falhas ${JSON.stringify(tipos)}, mediana ${ms[15]} ms -> ${taxa >= 0.95 && ms[15] < 1500 ? "PASSOU" : "NÃO PASSOU"}`);
}

async function busca(o, d, dias, margem) {
  const t0 = Date.now();
  let primeiro = null; let itens = [];
  const enviar = async (caminho, corpo) => {
    const novos = corpo.itens || [corpo];
    if (primeiro === null) primeiro = Date.now() - t0;
    itens = itens.concat(novos.filter((i) => typeof i.preco === "number"));
  };
  const avisar = async (job, etapa) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] etapa: ${etapa}`);
  const r = await rapida({ job: "r-0a1b2c3d4e5f", origem: o, destino: d, dias: Number(dias), margem: Number(margem || 0), enviar, avisar, log: (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`) });
  const melhor = [...itens].sort((x, y) => x.preco - y.preco)[0];
  console.log(`BUSCA ${o}>${d} ${dias}d ±${margem || 0}: total ${((Date.now() - t0) / 1000).toFixed(1)} s, 1º preço em ${primeiro === null ? "-" : (primeiro / 1000).toFixed(1) + " s"}, modo ${r.modo}, ${r.lidos} pares lidos (${r.confirmados} confirmados no Edge), melhor R$ ${melhor ? melhor.preco + " em " + melhor.ida + "→" + melhor.volta + " (" + melhor.leitura + ")" : "-"}`);
  return r;
}

if (comando === "passo1") await passo1();
else if (comando === "busca") await busca(a[0], a[1], a[2], a[3]);
else if (comando === "passo2") {
  for (let k = 0; k < 5; k++) { await busca(a[0], a[1], a[2], a[3]); if (k < 4) await dormir(120000); }
} else console.log("uso: node scan/aceite.mjs passo1 | busca <O> <D> <dias> [margem] | passo2 <O> <D> <dias> [margem]");
