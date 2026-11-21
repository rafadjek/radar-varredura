import test from "node:test";
import assert from "node:assert/strict";
import { adicionarDias, melhoresPares, melhorParForaDaJanela, paresParaConfirmar } from "../scan/pares.mjs";
import { postar } from "../scan/enviar.mjs";
import { urlBusca } from "../scan/confirmar.mjs";
import { urlSoIda, mesesVazios } from "../scan/calendario.mjs";
import * as v from "../scan/validar.mjs";

test("validar recusa entradas fora do formato", () => {
  assert.equal(v.iata("GRU"), "GRU");
  assert.throws(() => v.iata("gru"), /3 letras/);
  assert.throws(() => v.iata("GRU; rm -rf /"), /3 letras/);
  assert.equal(v.data("2027-02-19"), "2027-02-19");
  assert.throws(() => v.data("2027-02-19$(id)"), /AAAA-MM-DD/);
  assert.throws(() => v.job("b-xyz"), /job/);
  assert.equal(v.job("b-0123456789ab"), "b-0123456789ab");
  assert.equal(v.job("salvas-2026-11-20"), "salvas-2026-11-20");
  assert.equal(v.inteiro("20", 1, 35, "dias"), 20);
  assert.throws(() => v.inteiro("99", 1, 35, "dias"), /dias/);
});

test("validar.pares aceita até 3 e volta vazia, recusa lixo", () => {
  assert.deepEqual(v.pares("2027-02-19|2027-03-11,2027-02-21|"), [{ ida: "2027-02-19", volta: "2027-03-11" }, { ida: "2027-02-21", volta: "" }]);
  assert.throws(() => v.pares("2027-02-19|x"), /volta/);
  assert.throws(() => v.pares("2027-02-19|2027-03-11,2027-02-20|2027-03-12,2027-02-21|2027-03-13,2027-02-22|2027-03-14,2027-02-23|2027-03-15"), /1 a 4/);
  assert.equal(v.pares("2027-02-19|2027-03-11,2027-02-20|2027-03-12,2027-02-21|2027-03-13,2027-02-22|2027-03-14").length, 4);
});

test("mesesVazios acha o mês sem preço no meio do período", () => {
  const dias = {};
  for (const [mes, n] of [["2027-03", 31], ["2027-05", 31]]) for (let d = 1; d <= n; d++) dias[`${mes}-${String(d).padStart(2, "0")}`] = 500;
  assert.deepEqual(mesesVazios(dias), ["2027-04"]);
  assert.deepEqual(mesesVazios({}), []);
  // meses do começo (antes da primeira data lida) também contam, o primeiro só pelos dias que restam
  assert.deepEqual(mesesVazios({ "2027-01-05": 1, "2027-02-05": 1, "2027-03-05": 1 }, "2026-11-20").slice(0, 2), ["2026-11", "2026-12"]);
  assert.deepEqual(mesesVazios({ "2026-12-31": 1, "2027-01-05": 1 }, "2026-11-29").includes("2026-11"), true);
  const novembroParcial = {};
  for (let d = 29; d <= 30; d++) novembroParcial[`2026-11-${d}`] = 1;
  for (let d = 1; d <= 31; d++) { novembroParcial[`2026-12-${String(d).padStart(2, "0")}`] = 1; novembroParcial[`2027-01-${String(d).padStart(2, "0")}`] = 1; }
  assert.deepEqual(mesesVazios(novembroParcial, "2026-11-29"), []);
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

test("urls do Google usam o endereço estruturado (tfs), com gl=BR e BRL", () => {
  const u1 = urlBusca({ origem: "SAO", destino: "POA", ida: "2027-03-01", volta: "2027-03-18" });
  assert.match(u1, /^https:\/\/www\.google\.com\/travel\/flights\?tfs=/);
  assert.match(u1, /&hl=pt-BR&gl=BR&curr=BRL$/);
  const bin = Buffer.from(decodeURIComponent(u1.match(/tfs=([^&]+)/)[1]), "base64").toString("latin1");
  assert.ok(bin.includes("SAO") && bin.includes("POA") && bin.includes("2027-03-01") && bin.includes("2027-03-18"));
  const so = Buffer.from(decodeURIComponent(urlSoIda("GRU", "JDO", "2027-01-01").match(/tfs=([^&]+)/)[1]), "base64").toString("latin1");
  assert.ok(so.includes("GRU") && so.includes("JDO") && !so.includes("2027-03"));
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

test("melhorParForaDaJanela: só considera durações fora de dias±margem e dentro de ±(margem+extra)", () => {
  // dias=10, margem=1: janela pedida 9..11; ampliada 5..15 (extra 4)
  const ida = { "2027-02-01": 100 };
  const volta = { "2027-02-11": 50, "2027-02-13": 400, "2027-02-08": 30, "2027-02-21": 10 };
  // 2027-02-11 = 10 dias (dentro, ignorado); 02-13 = 12 dias (fora, vale); 02-08 = 7 dias (fora, vale); 02-21 = 20 dias (além da ampliada)
  const r = melhorParForaDaJanela(ida, volta, 10, 1, 4);
  assert.deepEqual(r, { ida: "2027-02-01", volta: "2027-02-08", total: 130, dias: 7 });
});

test("melhorParForaDaJanela: empate de soma escolhe a duração mais perto do pedido, depois a ida mais cedo", () => {
  const ida = { "2027-03-01": 100, "2027-03-05": 100 };
  // dias=10 margem=0: fora = 6..14 menos 10. Todas somam 200.
  const volta = { "2027-03-12": 100, "2027-03-16": 100, "2027-03-20": 100 };
  // 03-01: 03-12 (11 dias, |1|), 03-16 (15, fora da ampliada); 03-05: 03-16 (11 dias, |1|), 03-12 (7 dias, |3|)
  const r = melhorParForaDaJanela(ida, volta, 10, 0, 4);
  assert.deepEqual(r, { ida: "2027-03-01", volta: "2027-03-12", total: 200, dias: 11 });
  assert.equal(melhorParForaDaJanela({ "2027-03-01": 100 }, { "2027-03-11": 100 }, 10, 0, 4), null);
});

test("pares nunca passam de 35 dias (limite do Worker)", () => {
  const ida = { "2027-03-01": 100 };
  const volta = { "2027-04-05": 100, "2027-04-10": 50 }; // 35 e 40 dias
  assert.deepEqual(melhoresPares(ida, volta, 34, 3, 3).map((p) => p.volta), ["2027-04-05"]);
  assert.deepEqual(melhorParForaDaJanela(ida, volta, 30, 2, 8), { ida: "2027-03-01", volta: "2027-04-05", total: 200, dias: 35 });
});

test("paresParaConfirmar: calendário diferenciado confirma só os 5 melhores", () => {
  const p = [100, 120, 140, 160, 180, 200, 220].map((total, i) => ({ ida: `2027-03-${String(10 + i).padStart(2, "0")}`, volta: "2027-04-01", total }));
  assert.equal(paresParaConfirmar(p).length, 5);
});

test("paresParaConfirmar: calendário chapado espalha até 9 datas diferentes", () => {
  const p = Array.from({ length: 30 }, (_, i) => ({ ida: adicionarDias("2027-03-01", i), volta: "2027-04-20", total: 8294 }));
  const r = paresParaConfirmar(p);
  assert.equal(r.length, 9);
  for (let i = 1; i < r.length; i++) assert.ok((new Date(r[i].ida) - new Date(r[i - 1].ida)) / 86400000 >= 3);
});
