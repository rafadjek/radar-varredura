import test from "node:test";
import assert from "node:assert/strict";
import { decidirFim, lerPrecoNaAba, lerPrecos, MAX_ABAS } from "../scan/leitor.mjs";
import { ErroBloqueio, paginaBloqueada, estadoDoFluxo } from "../scan/navegador.mjs";
import { menorPrecoAba } from "../scan/confirmar.mjs";
import { rotaConfere, datasConferem } from "../scan/pagina.mjs";

const busca = { origem: "GRU", destino: "JDO", ida: "2027-02-19", volta: "2027-02-25" };
const semFluxo = { iniciou: false, ativas: 0, fimHaMs: null };

test("decidirFim: sem preço nunca aceita", () => {
  assert.equal(decidirFim({ t: 60000, preco: null, ultimaMudancaMs: 0, fluxo: { iniciou: true, ativas: 0, fimHaMs: 30000 } }), null);
});

test("decidirFim: fim da resposta de preços + 1 s parado = definitivo ('rede')", () => {
  const f = (fimHaMs, t, ult) => decidirFim({ t, preco: 702, ultimaMudancaMs: ult, fluxo: { iniciou: true, ativas: 0, fimHaMs } });
  assert.equal(f(1000, 12000, 10000), "rede");
  assert.equal(f(500, 12000, 10000), null, "o fim da rede ainda é recente");
  assert.equal(f(5000, 12000, 11500), null, "o preço acabou de mudar (a tela atualiza depois do último quadro)");
  assert.equal(decidirFim({ t: 12000, preco: 702, ultimaMudancaMs: 5000, fluxo: { iniciou: true, ativas: 1, fimHaMs: null } }), null, "ainda chegando");
  assert.equal(decidirFim({ t: 12000, preco: 702, ultimaMudancaMs: 5000, fluxo: { iniciou: false, ativas: 0, fimHaMs: null } }), null, "a resposta nem começou");
});

test("decidirFim: plano B = regra antiga (mín. 20 s e 12 s sem mudar)", () => {
  const f = (t, ult) => decidirFim({ t, preco: 702, ultimaMudancaMs: ult, fluxo: semFluxo });
  assert.equal(f(19000, 1000), null);
  assert.equal(f(20000, 8001), null);
  assert.equal(f(20000, 8000), "estavel");
  assert.equal(f(40000, 30000), null, "mudou há 10 s");
});

test("paginaBloqueada reconhece captcha/sorry e não confunde a busca normal", () => {
  assert.equal(paginaBloqueada("https://www.google.com/sorry/index?continue=..."), true);
  assert.equal(paginaBloqueada("https://consent.google.com/m?continue=..."), true);
  assert.equal(paginaBloqueada("https://www.google.com/travel/flights?tfs=abc&hl=pt-BR"), false);
  assert.equal(paginaBloqueada(""), false);
});

test("estadoDoFluxo calcula há quanto tempo a resposta terminou", () => {
  const aba = { gsr: { iniciou: true, ativas: new Set(), fimEm: 1000 } };
  assert.deepEqual(estadoDoFluxo(aba, 4000), { iniciou: true, ativas: 0, fimHaMs: 3000 });
  assert.deepEqual(estadoDoFluxo({ gsr: { iniciou: true, ativas: new Set(["a"]), fimEm: null } }, 4000), { iniciou: true, ativas: 1, fimHaMs: null });
});

// Aba falsa com relógio virtual: cada leitura do preço avança 250 ms.
function abaFalsa({ preco, href = "https://www.google.com/travel/flights?tfs=x", fluxo, confere = true }) {
  const rel = { t: 1_000_000 };
  const aba = {
    navegacoes: 0, gsr: { iniciou: false, ativas: new Set(), fimEm: null },
    relogio: () => rel.t,
    async navegar() { aba.navegacoes++; rel.inicio = rel.t; aba.gsr = { iniciou: false, ativas: new Set(), fimEm: null }; },
    async endereco() { return typeof href === "function" ? href(rel.t - rel.inicio) : href; },
    async avaliar(fn) {
      if (fn === menorPrecoAba) {
        rel.t += 250;
        const dt = rel.t - rel.inicio;
        if (fluxo) { const f = fluxo(dt); aba.gsr.iniciou = f.iniciou; aba.gsr.ativas = new Set(f.ativas ? ["x"] : []); aba.gsr.fimEm = f.fimDt === undefined ? null : rel.inicio + f.fimDt; }
        return preco(dt);
      }
      if (fn === rotaConfere || fn === datasConferem) return confere;
      throw new Error("função inesperada");
    },
  };
  return aba;
}
const ler = (aba, extra = {}) => lerPrecoNaAba(aba, busca, { passoMs: 1, agora: aba.relogio, ...extra });

test("leitor: aceita pelo fim da rede, com o preço de agência (770 -> 702) e não o primeiro", async () => {
  const aba = abaFalsa({
    preco: (dt) => (dt < 2000 ? null : dt < 6000 ? 770 : 702),
    fluxo: (dt) => ({ iniciou: dt >= 1500, ativas: dt >= 1500 && dt < 9000, fimDt: dt >= 9000 ? 9000 : undefined }),
  });
  const logs = [];
  assert.equal(await ler(aba, { log: (s) => logs.push(s) }), 702);
  assert.equal(aba.navegacoes, 1);
  assert.match(logs.join("\n"), /770@\d.*702@\d.*fim: rede/);
});

test("leitor: sem sinal da rede, cai na regra antiga (20 s + 12 s estável)", async () => {
  const aba = abaFalsa({ preco: (dt) => (dt < 2000 ? null : 360) });
  const logs = [];
  assert.equal(await ler(aba, { log: (s) => logs.push(s) }), 360);
  assert.match(logs.join("\n"), /fim: estavel, 20\./);
});

test("leitor: página 'sorry' interrompe com ErroBloqueio (disjuntor)", async () => {
  const aba = abaFalsa({ preco: () => null, href: (dt) => (dt > 3000 ? "https://www.google.com/sorry/index?x" : "https://www.google.com/travel/flights") });
  await assert.rejects(() => ler(aba), (e) => e instanceof ErroBloqueio && /google_bloqueou/.test(e.message));
});

test("leitor: página de outra rota/datas é descartada e tenta de novo; no fim, null", async () => {
  const aba = abaFalsa({ preco: (dt) => (dt < 1000 ? null : 500), fluxo: (dt) => ({ iniciou: true, ativas: false, fimDt: 1000 }), confere: false });
  assert.equal(await ler(aba), null);
  assert.equal(aba.navegacoes, 2, "duas tentativas");
});

test("leitor: nunca aparece preço = null depois do limite", async () => {
  const aba = abaFalsa({ preco: () => null });
  assert.equal(await ler(aba, { limiteMs: 5000, tentativas: 1 }), null);
});

// ---------- pool de abas ----------

function navegadorFalso() {
  const nav = { abertas: 0, maxSimultaneas: 0, fechadas: 0, novaAba: async () => {
    nav.abertas++;
    return { fechar: async () => { nav.fechadas++; } };
  } };
  return nav;
}
const pares = (n) => Array.from({ length: n }, (_, i) => ({ ida: `2027-03-${String(i + 1).padStart(2, "0")}`, volta: `2027-03-${String(i + 8).padStart(2, "0")}` }));

test("pool: cada par é lido uma vez, no máximo N ao mesmo tempo, entrega na hora e fecha todas as abas", async () => {
  const nav = navegadorFalso();
  let ativos = 0, pico = 0;
  const lerFalso = async (aba, b) => { ativos++; pico = Math.max(pico, ativos); await new Promise((r) => setTimeout(r, 15)); ativos--; return 500 + Number(b.ida.slice(-2)); };
  const entregues = [];
  const lidos = await lerPrecos(nav, { origem: "GRU", destino: "JDO", pares: pares(7), abas: 3, escalonarMs: 0, ler: lerFalso, aoLer: async (par, preco) => { entregues.push([par.ida, preco]); } });
  assert.equal(lidos.length, 7);
  assert.equal(new Set(lidos.map((l) => l.par.ida)).size, 7);
  assert.equal(entregues.length, 7);
  assert.equal(pico, 3);
  assert.equal(nav.abertas, 3);
  assert.equal(nav.fechadas, 3);
});

test("pool: nunca abre mais abas que pares nem que o máximo (6)", async () => {
  const nav = navegadorFalso();
  await lerPrecos(nav, { origem: "GRU", destino: "JDO", pares: pares(2), abas: 6, escalonarMs: 0, ler: async () => 500 });
  assert.equal(nav.abertas, 2);
  const nav2 = navegadorFalso();
  await lerPrecos(nav2, { origem: "GRU", destino: "JDO", pares: pares(20), abas: 50, escalonarMs: 0, ler: async () => 500 });
  assert.equal(nav2.abertas, MAX_ABAS);
});

test("pool: par sem preço ou com erro é pulado e o resto segue; entrega que falha não conta como lido", async () => {
  const nav = navegadorFalso();
  const avisos = [];
  const lerFalso = async (aba, b) => { if (b.ida.endsWith("02")) return null; if (b.ida.endsWith("03")) throw new Error("página caiu"); return 600; };
  const lidos = await lerPrecos(nav, {
    origem: "GRU", destino: "JDO", pares: pares(5), abas: 2, escalonarMs: 0, ler: lerFalso, log: (s) => avisos.push(s),
    aoLer: async (par) => { if (par.ida.endsWith("04")) throw new Error("Worker respondeu 500"); },
  });
  assert.deepEqual(lidos.map((l) => l.par.ida.slice(-2)).sort(), ["01", "05"]);
  assert.equal(avisos.filter((s) => /aviso/.test(s)).length, 3);
  assert.equal(nav.fechadas, nav.abertas);
});

test("pool: bloqueio numa aba para as outras, sobe o erro e fecha tudo", async () => {
  const nav = navegadorFalso();
  let chamadas = 0;
  const lerFalso = async (aba, b) => { chamadas++; if (b.ida.endsWith("02")) throw new ErroBloqueio("teste"); await new Promise((r) => setTimeout(r, 30)); return 500; };
  await assert.rejects(() => lerPrecos(nav, { origem: "GRU", destino: "JDO", pares: pares(12), abas: 3, escalonarMs: 0, ler: lerFalso }), (e) => e instanceof ErroBloqueio);
  assert.ok(chamadas < 12, `parou de ler depois do bloqueio (${chamadas} de 12)`);
  assert.equal(nav.fechadas, nav.abertas);
});

// ---------- correções da revisão (2026-11-21) ----------

test("estadoDoFluxo: resposta que terminou por FALHA não vale como fim (cai no plano B)", () => {
  const aba = { gsr: { iniciou: true, ativas: new Set(), fimEm: 1000, falhou: true } };
  assert.deepEqual(estadoDoFluxo(aba, 9000), { iniciou: true, ativas: 0, fimHaMs: null });
  assert.equal(decidirFim({ t: 9000, preco: 702, ultimaMudancaMs: 2000, fluxo: estadoDoFluxo(aba, 9000) }), null, "só 9 s: ainda não vale a regra antiga");
  assert.equal(decidirFim({ t: 25000, preco: 702, ultimaMudancaMs: 2000, fluxo: estadoDoFluxo(aba, 25000) }), "estavel");
});

test("pool: aba que não abre não derruba as outras", async () => {
  let n = 0;
  const nav = { fechadas: 0, novaAba: async () => { if (++n === 2) throw new Error("não abri a aba"); return { fechar: async () => { nav.fechadas++; } }; } };
  const avisos = [];
  const lidos = await lerPrecos(nav, { origem: "GRU", destino: "JDO", pares: pares(6), abas: 3, escalonarMs: 0, ler: async () => 500, log: (s) => avisos.push(s) });
  assert.equal(lidos.length, 6, "as duas abas que abriram leram tudo");
  assert.equal(nav.fechadas, 2);
  assert.ok(avisos.some((s) => /não consegui abrir a aba/.test(s)));
});

test("leitor: navegador que cai no meio da leitura falha na hora (não espera o limite)", async () => {
  const aba = abaFalsa({ preco: () => null });
  let vivo = true;
  aba.vivo = () => vivo;
  const original = aba.avaliar;
  aba.avaliar = async (...a) => { if (!aba.pulo) { aba.pulo = 1; } else vivo = false; return original(...a); };
  const t0 = Date.now();
  await assert.rejects(() => ler(aba, { limiteMs: 600000 }), /navegador caiu/);
  assert.ok(Date.now() - t0 < 2000);
});
