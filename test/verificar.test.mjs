import test from "node:test";
import assert from "node:assert/strict";
import { criarLotes, verificar } from "../scan/verificar.mjs";
import { pegar } from "../scan/enviar.mjs";
import { ErroBloqueio } from "../scan/navegador.mjs";
import * as v from "../scan/validar.mjs";

const item = (n) => ({ origem: "GRU", destino: "JDO", ida: `2027-03-${String(n).padStart(2, "0")}`, volta: `2027-03-${String(n + 9).padStart(2, "0")}`, preco: 500 + n, lidoEm: "2026-11-21T12:00:00Z", leitura: "pc" });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test("validar: job de verificação (v-...) é aceito", () => {
  assert.equal(v.job("v-0123456789ab"), "v-0123456789ab");
  assert.throws(() => v.job("x-0123456789ab"), /job/);
});

test("lotes: entrega ao completar 12 itens e o resto ao esvaziar", async () => {
  const lotes = []; const outros = [];
  const l = criarLotes({ enviarLote: async (i) => { lotes.push(i.length); }, enviarUm: async (i) => { outros.push(i); }, esperaMs: 60000 });
  for (let n = 1; n <= 30; n++) await l.add(item(n));
  assert.deepEqual(lotes, [12, 12], "dois lotes cheios já saíram");
  await l.esvaziar();
  assert.deepEqual(lotes, [12, 12, 6]);
  assert.equal(outros.length, 0);
});

test("lotes: o que sobra sai sozinho depois da espera (a página vê os primeiros preços logo)", async () => {
  const lotes = [];
  const l = criarLotes({ enviarLote: async (i) => { lotes.push(i.length); }, enviarUm: async () => {}, esperaMs: 30 });
  await l.add(item(1)); await l.add(item(2));
  assert.deepEqual(lotes, []);
  await esperar(90);
  assert.deepEqual(lotes, [2]);
  await l.esvaziar();
  assert.deepEqual(lotes, [2], "nada pendente, nada reenviado");
});

test("lotes: lote recusado cai para envio um a um, e um item ruim não derruba os outros", async () => {
  const unitarios = []; const avisos = [];
  const l = criarLotes({
    enviarLote: async () => { throw new Error("Worker respondeu 400"); },
    enviarUm: async (i) => { if (i.preco === 502) throw new Error("preço inválido"); unitarios.push(i.preco); },
    esperaMs: 60000, log: (s) => avisos.push(s),
  });
  for (let n = 1; n <= 3; n++) await l.add(item(n));
  await l.esvaziar();
  assert.deepEqual(unitarios, [501, 503]);
  assert.equal(avisos.length, 2);
});

test("lotes: envios nunca se atropelam (um lote por vez, na ordem)", async () => {
  let ativos = 0, pico = 0; const ordem = [];
  const l = criarLotes({ enviarLote: async (i) => { ativos++; pico = Math.max(pico, ativos); await esperar(15); ordem.push(i[0].ida); ativos--; }, enviarUm: async () => {}, tamanho: 2, esperaMs: 60000 });
  for (let n = 1; n <= 8; n++) l.add(item(n));
  await l.esvaziar();
  assert.equal(pico, 1);
  assert.deepEqual(ordem, ["2027-03-01", "2027-03-03", "2027-03-05", "2027-03-07"]);
});

function ambienteVerificar({ pares, tipo = "verificar", ler }) {
  const posts = []; const etapas = [];
  return {
    posts, etapas,
    args: {
      job: "v-0123456789ab", origem: "GRU", destino: "JDO", log: () => {}, leitura: "pc", abas: 2,
      pegarJob: async (c) => { assert.equal(c, "/api/varredura/job/v-0123456789ab"); return { tipo, origem: "GRU", destino: "JDO", pares }; },
      enviar: async (caminho, corpo) => { posts.push({ caminho, corpo }); return { ok: true }; },
      avisar: async (job, nome, detalhe) => { etapas.push([nome, detalhe]); },
      abrir: async () => ({ novaAba: async () => ({ fechar: async () => {} }), fechar: async () => { posts.push({ fechou: true }); } }),
      ler,
    },
  };
}
const pares30 = Array.from({ length: 30 }, (_, i) => `2027-03-${String(i + 1).padStart(2, "0")}|2027-03-${String(i + 1).padStart(2, "0")}`.replace(/\|2027-03-(\d\d)$/, (m, d) => `|2027-04-${d}`));

test("verificar: lê todos os pares do job e entrega em lotes de 12; etapas confirmando → pronto; navegador fechado", async () => {
  const e = ambienteVerificar({ pares: pares30, ler: async (aba, b) => 400 + Number(b.ida.slice(-2)) });
  const lidos = await verificar(e.args);
  assert.equal(lidos.length, 30);
  const lotes = e.posts.filter((p) => p.caminho === "/api/varredura/lote");
  assert.deepEqual(lotes.map((l) => l.corpo.itens.length).sort((a, b) => b - a), [12, 12, 6]);
  assert.ok(lotes.every((l) => l.corpo.job === "v-0123456789ab"));
  assert.equal(new Set(lotes.flatMap((l) => l.corpo.itens.map((i) => i.ida))).size, 30);
  assert.deepEqual(lotes[0].corpo.itens[0], { origem: "GRU", destino: "JDO", ida: lotes[0].corpo.itens[0].ida, volta: lotes[0].corpo.itens[0].volta, preco: lotes[0].corpo.itens[0].preco, lidoEm: lotes[0].corpo.itens[0].lidoEm, leitura: "pc" });
  assert.deepEqual(e.etapas.map((x) => x[0]), ["confirmando", "pronto"]);
  assert.ok(e.posts.some((p) => p.fechou));
});

test("verificar: bloqueio do Google entrega o que já leu, avisa 'google_bloqueou' e sobe o erro (sem 'pronto')", async () => {
  let n = 0;
  const e = ambienteVerificar({ pares: pares30, ler: async () => { n++; if (n > 3) throw new ErroBloqueio("x"); return 500; } });
  await assert.rejects(() => verificar(e.args), (err) => err instanceof ErroBloqueio);
  const entregues = e.posts.filter((p) => p.caminho === "/api/varredura/lote").flatMap((l) => l.corpo.itens);
  assert.equal(entregues.length, 3);
  assert.deepEqual(e.etapas.at(-1), ["erro", "google_bloqueou"]);
  assert.equal(e.etapas.some((x) => x[0] === "pronto"), false);
  assert.ok(e.posts.some((p) => p.fechou));
});

test("verificar: recusa job de outro tipo ou de outra rota", async () => {
  const e = ambienteVerificar({ pares: pares30, tipo: "buscar", ler: async () => 500 });
  await assert.rejects(() => verificar(e.args), /não é uma verificação/);
  const e2 = ambienteVerificar({ pares: pares30, ler: async () => 500 });
  await assert.rejects(() => verificar({ ...e2.args, destino: "REC" }), /não é uma verificação desta rota/);
});

test("pegar: GET com segredo, repete em falha e não repete 4xx", async () => {
  const chamadas = [];
  const f = async (url, init) => { chamadas.push({ url, init }); return chamadas.length === 1 ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
  const r = await pegar("/api/varredura/job/v-1", { fetcher: f, env: { WORKER_URL: "https://w.test/", INGEST_SECRET: "s" }, esperar: async () => {} });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(chamadas[0].url, "https://w.test/api/varredura/job/v-1");
  assert.equal(chamadas[0].init.headers["x-ingest-secret"], "s");
  const f404 = async () => { f404.n = (f404.n || 0) + 1; return { ok: false, status: 404 }; };
  await assert.rejects(() => pegar("/x", { fetcher: f404, env: { WORKER_URL: "https://w.test" }, esperar: async () => {} }), /404/);
  assert.equal(f404.n, 1);
  await assert.rejects(() => pegar("/x", { env: {} }), /WORKER_URL/);
});
