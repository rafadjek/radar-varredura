import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extrairMenorPreco, lerParHttp, criarRitmo, criarDisjuntor, estadoEmMemoria } from "../scan/leitorHttp.mjs";

const fix = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const resposta = (texto, extra = {}) => ({ status: 200, url: "https://www.google.com/travel/flights?x=1", text: async () => texto, ...extra });

test("extrairMenorPreco: menor preço da fixture, ignorando tokens curtos e nulos", () => {
  assert.deepEqual(extrairMenorPreco(fix("ds1-ok.html")), { preco: 389 });
});

test("extrairMenorPreco: erros classificados", () => {
  assert.deepEqual(extrairMenorPreco(fix("ds1-erro13.html")), { erro: "erro13" });
  assert.deepEqual(extrairMenorPreco("<html>nada aqui</html>"), { erro: "sem_ds1" });
  assert.deepEqual(extrairMenorPreco("AF_initDataCallback({key: 'ds:1', hash: '1', data:[[[, quebrado, sideChannel: {}});"), { erro: "json" });
  assert.deepEqual(extrairMenorPreco("AF_initDataCallback({key: 'ds:1', hash: '1', data:[1,2,[3]], sideChannel: {}});"), { erro: "sem_precos" });
});

test("lerParHttp: monta a URL com tfs e parâmetros fixos e devolve o preço", async () => {
  let pedido;
  const buscar = async (url, init) => { pedido = { url, init }; return resposta(fix("ds1-ok.html")); };
  const r = await lerParHttp({ origem: "GRU,CGH", destino: "POA", ida: "2027-02-10", volta: "2027-03-02" }, { buscar });
  assert.deepEqual(r, { preco: 389 });
  assert.match(pedido.url, /^https:\/\/www\.google\.com\/travel\/flights\?tfs=.+&hl=pt-BR&gl=BR&curr=BRL$/);
  assert.equal(pedido.init.headers["accept-language"].startsWith("pt-BR"), true);
  assert.equal(pedido.init.headers.cookie, "CONSENT=YES+cb");
});

test("lerParHttp: erro 13, captcha, rede", async () => {
  assert.deepEqual(await lerParHttp({ origem: "GRU", destino: "POA", ida: "2027-02-10" }, { buscar: async () => resposta(fix("ds1-erro13.html")) }), { erro: "erro13" });
  assert.deepEqual(await lerParHttp({ origem: "GRU", destino: "POA", ida: "2027-02-10" }, { buscar: async () => resposta("", { url: "https://www.google.com/sorry/index?continue=x" }) }), { erro: "captcha" });
  assert.deepEqual(await lerParHttp({ origem: "GRU", destino: "POA", ida: "2027-02-10" }, { buscar: async () => resposta("", { url: "https://www.google.com/recaptcha/x" }) }), { erro: "captcha" });
  assert.deepEqual(await lerParHttp({ origem: "GRU", destino: "POA", ida: "2027-02-10" }, { buscar: async () => { throw new Error("ECONNRESET"); } }), { erro: "rede" });
});

test("lerParHttp: entrada inválida é recusada antes de qualquer pedido", async () => {
  let chamou = false;
  const buscar = async () => { chamou = true; return resposta(""); };
  await assert.rejects(lerParHttp({ origem: "gru", destino: "POA", ida: "2027-02-10" }, { buscar }), /entrada inválida/);
  await assert.rejects(lerParHttp({ origem: "GRU", destino: "POA", ida: "amanhã" }, { buscar }), /entrada inválida/);
  assert.equal(chamou, false);
});

// Relógio virtual: dormir registra um alarme; o "motor" avança o tempo até o alarme mais próximo.
function relogioFalso() {
  const r = { t: 0, alarmes: [] };
  r.agora = () => r.t;
  r.dormir = (ms) => new Promise((res) => { r.alarmes.push({ alvo: r.t + ms, res }); });
  r.rodar = async (promessa) => {
    let pronto = false;
    promessa.then(() => { pronto = true; }, () => { pronto = true; });
    while (!pronto) {
      await new Promise((res) => setImmediate(res));
      if (pronto) break;
      if (r.alarmes.length) {
        r.alarmes.sort((a, b) => a.alvo - b.alvo);
        const a = r.alarmes.shift();
        r.t = Math.max(r.t, a.alvo);
        a.res();
      }
    }
    return promessa;
  };
  return r;
}

test("criarRitmo: 12 chamadas a 5/s levam >= 2 s simulados, nunca mais de 6 em voo nem 5 por segundo", async () => {
  const rel = relogioFalso();
  const ritmo = criarRitmo({ porSegundo: 5, concorrencia: 6, dormir: rel.dormir, agora: rel.agora });
  let emVoo = 0, pico = 0;
  const inicios = [];
  const fn = async () => { emVoo++; pico = Math.max(pico, emVoo); inicios.push(rel.t); await rel.dormir(600); emVoo--; return 1; };
  const rs = await rel.rodar(Promise.all(Array.from({ length: 12 }, () => ritmo.executar(fn))));
  assert.equal(rs.length, 12);
  assert.ok(pico <= 6, `pico ${pico}`);
  assert.ok(rel.t >= 2000, `tempo ${rel.t}`);
  inicios.sort((a, b) => a - b);
  for (let i = 0; i + 5 < inicios.length; i++) assert.ok(inicios[i + 5] - inicios[i] >= 1000 - 1e-6, "no máximo 5 inícios por segundo");
});

test("criarRitmo: erro da função libera a vaga e é repassado", async () => {
  const rel = relogioFalso();
  const ritmo = criarRitmo({ concorrencia: 1, dormir: rel.dormir, agora: rel.agora });
  await assert.rejects(rel.rodar(ritmo.executar(async () => { throw new Error("falhou"); })), /falhou/);
  assert.equal(await rel.rodar(ritmo.executar(async () => "ok")), "ok");
});

test("criarDisjuntor: abre com 8 falhas em 20, fica fechado com 7, só abre com a janela cheia", () => {
  let agora = 1000;
  const mk = () => criarDisjuntor({ agora: () => agora, estado: estadoEmMemoria() });
  const d8 = mk();
  for (let i = 0; i < 8; i++) d8.registrar(false);
  assert.equal(d8.aberto(), false, "janela ainda não está cheia");
  for (let i = 0; i < 12; i++) d8.registrar(true);
  assert.equal(d8.aberto(), true);
  const d7 = mk();
  for (let i = 0; i < 7; i++) d7.registrar(false);
  for (let i = 0; i < 13; i++) d7.registrar(true);
  assert.equal(d7.aberto(), false);
});

test("criarDisjuntor: cooldown de 90 min e estado sobrevive a reiniciar", () => {
  let agora = 5000;
  const estado = estadoEmMemoria();
  const d = criarDisjuntor({ agora: () => agora, estado });
  for (let i = 0; i < 20; i++) d.registrar(false);
  assert.equal(d.aberto(), true);
  assert.equal(d.abertoAte(), 5000 + 90 * 60 * 1000);
  agora += 89 * 60 * 1000;
  assert.equal(d.aberto(), true);
  const reiniciado = criarDisjuntor({ agora: () => agora, estado });
  assert.equal(reiniciado.aberto(), true, "novo disjuntor com o mesmo estado continua aberto");
  agora += 2 * 60 * 1000;
  assert.equal(d.aberto(), false);
  assert.equal(reiniciado.aberto(), false);
  // depois do cooldown a janela recomeça do zero
  for (let i = 0; i < 7; i++) d.registrar(false);
  assert.equal(d.aberto(), false);
});
