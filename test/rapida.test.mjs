import test from "node:test";
import assert from "node:assert/strict";
import { rapida } from "../scan/rapida.mjs";
import { criarDisjuntor, estadoEmMemoria } from "../scan/leitorHttp.mjs";
import { ErroBloqueio } from "../scan/navegador.mjs";

const JOB = "r-0123456789ab";
const HOJE = new Date(2027, 0, 9, 12, 0, 0); // amanhã = 2027-01-10
const BASE = Date.parse("2027-01-10T12:00:00Z");
const DIA = 86400000;
const indiceDaIda = (ida) => Math.round((Date.parse(`${ida}T12:00:00Z`) - BASE) / DIA);
const duracao = (ida, volta) => Math.round((Date.parse(`${volta}T12:00:00Z`) - Date.parse(`${ida}T12:00:00Z`)) / DIA);

// platô com um mergulho no índice 100; durações diferentes da nominal custam um pouco mais
const serie = (dias) => (ida, volta) => {
  const i = indiceDaIda(ida);
  const base = Math.abs(i - 100) <= 8 ? 400 + 25 * Math.abs(i - 100) : 800 + (i % 5);
  return base + 3 * Math.abs(duracao(ida, volta) - dias);
};

function ambiente({ dias = 20, preco = serie(dias), http, edge } = {}) {
  const amb = { chamadasHttp: 0, chamadasEdge: 0, enviados: [], etapas: [], fechou: false };
  amb.lerHttp = async (par) => {
    amb.chamadasHttp++;
    if (http) return http(par);
    return { preco: preco(par.ida, par.volta) };
  };
  amb.lerEdge = async (_nav, { pares, aoLer }) => {
    amb.chamadasEdge++;
    if (edge) return edge(pares);
    const feitos = [];
    for (const par of pares) { const p = preco(par.ida, par.volta) + 20; await aoLer(par, p); feitos.push({ par, preco: p }); }
    return feitos;
  };
  amb.enviar = async (caminho, corpo) => {
    if (caminho === "/api/varredura/lote") amb.enviados.push(...corpo.itens);
    else amb.enviados.push({ ...corpo });
  };
  amb.avisar = async (job, nome, detalhe) => { amb.etapas.push(detalhe ? `${nome}:${detalhe}` : nome); };
  amb.abrir = async () => ({ fechar: async () => { amb.fechou = true; } });
  amb.opcoes = (extra = {}) => ({
    job: JOB, origem: "GRU,CGH", destino: "POA", dias, margem: 0, log: () => {}, hoje: HOJE,
    lerHttp: amb.lerHttp, lerEdge: amb.lerEdge, enviar: amb.enviar, avisar: amb.avisar, abrir: amb.abrir,
    dormir: async () => {}, ritmo: { executar: (fn) => fn() },
    disjuntor: criarDisjuntor({ estado: estadoEmMemoria() }), ...extra,
  });
  return amb;
}

test("rapida (a): acha o menor preço da série com no máximo 45 leituras HTTP, em qualquer deslocamento", async () => {
  for (const desl of [0, 3, 7, 11, 14]) {
    const amb = ambiente();
    const r = await rapida(amb.opcoes({ deslocamento: desl }));
    assert.ok(amb.chamadasHttp <= 45, `chamadas ${amb.chamadasHttp}`);
    const cia = amb.enviados.filter((i) => i.leitura === "pc_cia").map((i) => i.preco);
    assert.equal(Math.min(...cia), 400, `deslocamento ${desl}`);
    assert.equal(r.modo, "http");
    assert.ok(r.lidos >= cia.length && r.confirmados >= 3);
    assert.deepEqual(amb.etapas, ["lendo", "confirmando", "pronto"]);
    assert.equal(amb.fechou, true);
  }
});

test("rapida (b): variação de dias só nos 2 melhores, dentro de dias ± margem e de 1 a 35", async () => {
  const amb = ambiente();
  await rapida(amb.opcoes({ margem: 3, deslocamento: 5 }));
  const extras = amb.enviados.filter((i) => duracao(i.ida, i.volta) !== 20);
  assert.ok(extras.length > 0);
  assert.ok(extras.every((i) => [17, 19, 21, 23].includes(duracao(i.ida, i.volta))));
  const idasComExtra = new Set(extras.filter((i) => i.leitura === "pc_cia").map((i) => i.ida));
  assert.ok(idasComExtra.size <= 2, `idas com variação: ${idasComExtra.size}`);
  assert.ok(amb.chamadasHttp <= 45);

  for (const [dias, margem] of [[1, 5], [35, 10], [2, 10], [20, 10]]) {
    const a = ambiente({ dias });
    await rapida(a.opcoes({ dias, margem, deslocamento: 2 }));
    for (const i of a.enviados) {
      const d = duracao(i.ida, i.volta);
      assert.ok(d >= 1 && d <= 35, `duração ${d}`);
      assert.ok(Math.abs(d - dias) <= margem, `duração ${d} fora de ${dias}±${margem}`);
    }
    assert.ok(a.chamadasHttp <= 45);
  }
});

test("rapida (c): HTTP sempre com erro 13 -> não explode, termina pelo Edge e a ordem das etapas é a combinada", async () => {
  const amb = ambiente({ http: async () => ({ erro: "erro13" }) });
  const r = await rapida(amb.opcoes({ margem: 2, deslocamento: 4 }));
  assert.equal(r.modo, "edge");
  assert.ok(amb.chamadasEdge >= 1);
  assert.ok(r.lidos > 0 && r.confirmados > 0);
  assert.deepEqual(amb.etapas, ["lendo", "confirmando", "pronto"]);
  assert.ok(amb.enviados.every((i) => i.leitura === "pc"));
  assert.ok(amb.chamadasHttp <= 45);
});

test("rapida (c2): erro 13 e Edge também sem nada -> termina sem lançar e sem itens", async () => {
  const amb = ambiente({ http: async () => ({ erro: "erro13" }), edge: async () => [] });
  const r = await rapida(amb.opcoes({ deslocamento: 0 }));
  assert.equal(r.lidos, 0);
  assert.deepEqual(amb.etapas, ["lendo", "confirmando", "pronto"]);
});

test("rapida (d): itens têm leitura certa, ida|volta válidos, rota normalizada e erro de leitura é repetido uma vez", async () => {
  let n = 0;
  const amb = ambiente({ http: async (par) => (n++ === 0 ? { erro: "erro13" } : { preco: serie(20)(par.ida, par.volta) }) });
  const r = await rapida(amb.opcoes({ margem: 1, deslocamento: 1 }));
  assert.equal(r.modo, "http");
  for (const i of amb.enviados) {
    assert.ok(["pc", "pc_cia"].includes(i.leitura));
    assert.ok(Math.abs(duracao(i.ida, i.volta) - 20) <= 1);
    assert.equal(i.origem, "GRU,CGH");
    assert.equal(i.destino, "POA");
    assert.ok(Number.isFinite(Date.parse(i.lidoEm)));
  }
  assert.ok(amb.enviados.some((i) => i.leitura === "pc_cia"));
  assert.ok(amb.enviados.some((i) => i.leitura === "pc"));
  const primeiraIda = amb.enviados.length && indiceDaIda(amb.enviados[0].ida);
  assert.ok(primeiraIda >= 0 && primeiraIda < 329);
});

test("rapida (e): ErroBloqueio do Edge vira etapa erro google_bloqueou e é relançado", async () => {
  const amb = ambiente({ edge: async () => { throw new ErroBloqueio("sorry"); } });
  await assert.rejects(rapida(amb.opcoes({ deslocamento: 0 })), (e) => e.name === "ErroBloqueio");
  assert.deepEqual(amb.etapas, ["lendo", "confirmando", "erro:google_bloqueou"]);
  assert.equal(amb.fechou, true);
});

test("rapida: entrada inválida é recusada antes de qualquer leitura", async () => {
  const amb = ambiente();
  await assert.rejects(rapida(amb.opcoes({ dias: 40 })), /entrada inválida/);
  await assert.rejects(rapida(amb.opcoes({ margem: 11 })), /entrada inválida/);
  await assert.rejects(rapida(amb.opcoes({ origem: "gru" })), /entrada inválida/);
  await assert.rejects(rapida(amb.opcoes({ job: "x-1" })), /entrada inválida/);
  assert.equal(amb.chamadasHttp, 0);
});

test("rapida: captcha no HTTP desliga o motor rápido no resto da busca", async () => {
  const amb = ambiente({ http: async () => ({ erro: "captcha" }) });
  const r = await rapida(amb.opcoes({ deslocamento: 0 }));
  assert.equal(r.modo, "edge");
  assert.ok(amb.chamadasHttp <= 6, `chamadas HTTP depois do captcha: ${amb.chamadasHttp}`);
});
