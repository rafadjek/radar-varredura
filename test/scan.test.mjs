import test from "node:test";
import assert from "node:assert/strict";
import { adicionarDias, melhoresPares } from "../scan/pares.mjs";
import { postar } from "../scan/enviar.mjs";
import { urlBusca } from "../scan/confirmar.mjs";
import { urlSoIda, mesesVazios } from "../scan/calendario.mjs";

test("mesesVazios acha o mês sem preço no meio do período", () => {
  const dias = {};
  for (const [mes, n] of [["2027-03", 31], ["2027-05", 31]]) for (let d = 1; d <= n; d++) dias[`${mes}-${String(d).padStart(2, "0")}`] = 500;
  assert.deepEqual(mesesVazios(dias), ["2027-04"]);
  assert.deepEqual(mesesVazios({}), []);
});

test("adicionarDias atravessa mês e ano", () => {
  assert.equal(adicionarDias("2026-12-22", 21), "2027-01-12");
  assert.equal(adicionarDias("2027-02-19", 20), "2027-03-11");
});

test("melhoresPares escolhe a volta mais barata dentro da margem e ordena", () => {
  const ida = { "2027-02-19": 373, "2027-02-20": 400, "2027-03-01": 900 };
  const volta = { "2027-03-11": 386, "2027-03-10": 500, "2027-03-12": 700, "2027-03-21": 100 };
  const r = melhoresPares(ida, volta, 20, 1, 3);
  assert.deepEqual(r[0], { ida: "2027-02-19", volta: "2027-03-11", total: 759 });
  assert.equal(r.length, 3);
  assert.ok(r[0].total <= r[1].total && r[1].total <= r[2].total);
});

test("melhoresPares sem volta correspondente devolve vazio", () => {
  assert.deepEqual(melhoresPares({ "2027-02-19": 373 }, {}, 20, 2), []);
});

test("urls do Google forçam gl=BR e BRL", () => {
  assert.match(urlBusca({ origem: "GRU", destino: "JDO", ida: "2027-02-19", volta: "2027-03-11" }), /gl=BR&curr=BRL/);
  assert.match(decodeURIComponent(urlBusca({ origem: "GRU", destino: "JDO", ida: "2027-02-19" })), /one way/);
  assert.match(decodeURIComponent(urlSoIda("GRU", "JDO", "2027-01-01")), /GRU to JDO on 2027-01-01 one way/);
});

test("postar sem WORKER_URL não chama a rede", async () => {
  const r = await postar("/x", { a: 1 }, { env: {}, fetcher: () => { throw new Error("não devia chamar"); } });
  assert.equal(r.seco, true);
});

test("postar envia o segredo e repete em falha de rede", async () => {
  const chamadas = [];
  const fetcher = async (url, opcoes) => {
    chamadas.push({ url, h: opcoes.headers });
    if (chamadas.length < 3) throw new Error("rede");
    return { ok: true, status: 200 };
  };
  const r = await postar("/api/varredura/etapa", { job: "j" }, { env: { WORKER_URL: "https://w.example/", INGEST_SECRET: "s3" }, fetcher, esperar: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(chamadas.length, 3);
  assert.equal(chamadas[0].url, "https://w.example/api/varredura/etapa");
  assert.equal(chamadas[0].h["x-ingest-secret"], "s3");
});

test("postar não repete erro 401", async () => {
  let n = 0;
  await assert.rejects(postar("/x", {}, { env: { WORKER_URL: "https://w.example" }, fetcher: async () => { n++; return { ok: false, status: 401 }; }, esperar: async () => {} }), /401/);
  assert.equal(n, 1);
});
