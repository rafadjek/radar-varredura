// A/B da F3.2 (SÓ LOCAL): leitor antigo (um navegador por par, em levas de 3, como em produção) x leitor novo
// (um navegador, 3 abas), nos mesmos 20 pares. Compara preço, tempo e se sobra perfil-* em D:\Temp.
// Uso: node scan/ab.mjs   (≈ 8 min, 40 consultas ao Google)  -> D:\Temp\medicao-f30\ab.json
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { abrirChrome } from "./chrome.mjs";
import { lerMenorPreco } from "./confirmar.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { lerPrecoNaAba } from "./leitor.mjs";
import { PARES } from "./medir.mjs";

const perfis = () => readdirSync(tmpdir()).filter((n) => n.startsWith("perfil-")).length;
const rot = (p) => `${p.origem}>${p.destino} ${p.ida.slice(5)}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const antes = perfis();

// ANTIGO: levas de 3, um Chrome por par
async function antigo() {
  const t0 = Date.now(); const out = new Map();
  for (let i = 0; i < PARES.length; i += 3) {
    await Promise.all(PARES.slice(i, i + 3).map(async (p) => {
      const c = await abrirChrome(); const t = Date.now();
      try { out.set(rot(p), { preco: await lerMenorPreco(c, p, {}), s: (Date.now() - t) / 1000 }); }
      catch (e) { out.set(rot(p), { preco: null, erro: e.message }); } finally { await c.fechar(); }
    }));
    log("antigo", Math.min(i + 3, 20), "/ 20");
    await dormir(4000);
  }
  return { total: (Date.now() - t0) / 1000, out };
}
// NOVO: um navegador, 3 abas
async function novo() {
  const t0 = Date.now(); const out = new Map(); const tempos = new Map();
  const nav = await abrirNavegador();
  try {
    // origem/destino variam por par: uma fila só, com 3 abas compartilhando (mesmo pool do leitor novo)
    const fila = [...PARES]; let n = 0;
    const abas = await Promise.all([0, 1, 2].map(async (k) => { await dormir(k * 400); return nav.novaAba(); }));
    await Promise.all(abas.map(async (aba) => {
      for (let p; (p = fila.shift()); ) {
        const t = Date.now();
        try { out.set(rot(p), { preco: await lerPrecoNaAba(aba, p, {}), s: (Date.now() - t) / 1000 }); }
        catch (e) { out.set(rot(p), { preco: null, erro: e.message }); }
        log("novo", ++n, "/ 20");
      }
      await aba.fechar();
    }));
  } finally { await nav.fechar(); }
  return { total: (Date.now() - t0) / 1000, out };
}

const a = await antigo();
const durante = perfis();
await dormir(20000);
const b = await novo();
const depois = perfis();
const linhas = PARES.map((p) => { const x = a.out.get(rot(p)), y = b.out.get(rot(p)); return { par: rot(p), antigo: x?.preco ?? null, novo: y?.preco ?? null, sAntigo: x?.s, sNovo: y?.s }; });
const iguais = linhas.filter((l) => l.antigo !== null && l.antigo === l.novo).length;
const res = { totalAntigoS: a.total, totalNovoS: b.total, iguais, lidosAntigo: linhas.filter((l) => l.antigo !== null).length, lidosNovo: linhas.filter((l) => l.novo !== null).length, perfis: { antes, depoisAntigo: durante, depoisNovo: depois }, linhas };
mkdirSync("D:/Temp/medicao-f30", { recursive: true });
writeFileSync("D:/Temp/medicao-f30/ab.json", JSON.stringify(res, null, 1));
console.log(JSON.stringify({ ...res, linhas: undefined }, null, 1));
console.table(linhas.map((l) => ({ ...l, sAntigo: l.sAntigo?.toFixed(1), sNovo: l.sNovo?.toFixed(1) })));
