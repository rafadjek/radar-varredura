import test from "node:test";
import assert from "node:assert/strict";
import { passoAmostra, amostraInicial, proximosRefino, duracoesParaLer, escolherFinalistas } from "../scan/orcamento.mjs";

test("passoAmostra: nunca múltiplo de 7 e respeita o orçamento", () => {
  for (const [n, o] of [[329, 45], [294, 42], [150, 30], [329, 30], [100, 45], [7, 45]]) {
    const p = passoAmostra(n, o);
    assert.notEqual(p % 7, 0, `n=${n} o=${o} passo=${p}`);
    assert.ok(Math.ceil(n / p) <= Math.floor(0.55 * o), `amostra cabe no orçamento (n=${n} o=${o})`);
  }
  assert.equal(passoAmostra(329, 45), 15); // ceil(329/24)=14 é múltiplo de 7 -> 15
});

test("amostraInicial: no máximo 55% do orçamento, todos dentro do intervalo, deslocamento gira a grade", () => {
  for (let desl = 0; desl < 20; desl++) {
    const a = amostraInicial(329, 45, desl);
    assert.ok(a.length <= 24 && a.length > 0);
    assert.ok(a.every((i) => i >= 0 && i < 329));
    assert.equal(new Set(a).size, a.length);
    const p = passoAmostra(329, 45);
    assert.equal(a[0], desl % p);
    assert.equal(a[1] - a[0], p);
  }
});

test("proximosRefino: vizinhos dos melhores, sem repetir lidos nem null, respeitando limite e borda", () => {
  const lidos = new Map([[0, 800], [15, 800], [90, 500], [105, 800], [120, 800], [75, null]]);
  const r0 = proximosRefino(lidos, 329, 15, 0, 100);
  assert.ok(r0.includes(84) && r0.includes(89) && r0.includes(96) && !r0.includes(97));
  assert.ok(r0.every((i) => !lidos.has(i) && i >= 0 && i < 329));
  assert.equal(new Set(r0).size, r0.length);
  assert.ok(r0.indexOf(91) < r0.indexOf(92), "mais perto primeiro");
  assert.ok(Math.abs(r0[0] - 90) === 1, "começa pelo melhor preço");
  assert.ok(r0.every((i) => Math.abs(i - 90) <= 6 || Math.abs(i - 0) <= 6 || Math.abs(i - 15) <= 6));
  assert.equal(proximosRefino(lidos, 329, 15, 0, 3).length, 3);
  const r1 = proximosRefino(new Map([[90, 500], [91, 520]]), 329, 15, 1, 10);
  assert.deepEqual(r1, [89, 92]);
  // tudo null: nada para refinar
  assert.deepEqual(proximosRefino(new Map([[0, null]]), 329, 15, 0, 10), []);
  // borda: índice 0 não gera -1
  assert.ok(proximosRefino(new Map([[0, 100]]), 329, 15, 0, 20).every((i) => i >= 1));
});

test("duracoesParaLer: casos do plano e limites 1..35", () => {
  assert.deepEqual(duracoesParaLer(20, 3), [17, 19, 21, 23]);
  assert.deepEqual(duracoesParaLer(20, 2), [18, 19, 21, 22]);
  assert.ok(duracoesParaLer(2, 5).every((d) => d >= 1 && d <= 35));
  assert.ok(duracoesParaLer(35, 5).every((d) => d <= 35 && d !== 35));
  assert.ok(duracoesParaLer(1, 10).every((d) => d >= 1 && d !== 1));
  assert.deepEqual(duracoesParaLer(20, 0), []);
});

test("escolherFinalistas: idas separadas por >= 3 dias, ignora já escolhidos", () => {
  const l = [
    { ida: "2027-03-10", volta: "2027-03-30", preco: 300 },
    { ida: "2027-03-11", volta: "2027-03-31", preco: 301 },
    { ida: "2027-03-12", volta: "2027-04-01", preco: 302 },
    { ida: "2027-03-20", volta: "2027-04-09", preco: 350 },
    { ida: "2027-04-05", volta: "2027-04-25", preco: 400 },
  ];
  const f = escolherFinalistas(l, 3);
  assert.deepEqual(f.map((x) => x.ida), ["2027-03-10", "2027-03-20", "2027-04-05"]);
  const g = escolherFinalistas(l, 3, ["2027-03-10|2027-03-30"]);
  assert.ok(!g.some((x) => x.ida === "2027-03-10"));
  assert.equal(g[0].ida, "2027-03-11");
  // sem alternativa: completa com os mais próximos
  assert.equal(escolherFinalistas(l.slice(0, 3), 3).length, 3);
  assert.deepEqual(escolherFinalistas([], 3), []);
});

test("simulação: platô com um mergulho -> acha o menor preço com orçamento 45 em qualquer deslocamento", () => {
  const N = 329, ORC = 45, centro = 100;
  const preco = (i) => Math.abs(i - centro) <= 8 ? 400 + 25 * Math.abs(i - centro) : 800 + (i % 5);
  for (let desl = 0; desl < 15; desl++) {
    const lidos = new Map();
    const passo = passoAmostra(N, ORC);
    for (const i of amostraInicial(N, ORC, desl)) lidos.set(i, preco(i));
    for (let rodada = 0; rodada < 3; rodada++) {
      const sobra = ORC - lidos.size;
      if (sobra <= 0) break;
      // como a orquestração faz: cada rodada gasta no máximo metade do que sobra (deixa folga para as seguintes)
      for (const i of proximosRefino(lidos, N, passo, rodada, Math.ceil(sobra / 2))) lidos.set(i, preco(i));
    }
    assert.ok(lidos.size <= ORC);
    assert.equal(Math.min(...[...lidos.values()]), 400, `deslocamento ${desl}`);
  }
});
