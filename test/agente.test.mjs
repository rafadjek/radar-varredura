import test from "node:test";
import assert from "node:assert/strict";
import { agente, executarJob } from "../scan/agente.mjs";
import { ErroBloqueio } from "../scan/navegador.mjs";

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Worker de mentira: fila de jobs e informações por job
function workerFalso(jobs) {
  const fila = [...jobs.map((j) => j.id)];
  const info = new Map(jobs.map((j) => [j.id, j]));
  const chamadas = [];
  return {
    chamadas,
    pegarJson: async (caminho) => {
      chamadas.push(caminho);
      if (caminho.startsWith("/api/varredura/proximo")) { await esperar(2); return { job: fila.shift() || null }; }
      const m = caminho.match(/^\/api\/varredura\/job\/(.+)$/);
      if (m && info.has(m[1])) return info.get(m[1]);
      throw new Error(`Worker respondeu 404 (${caminho})`);
    },
  };
}
const job = (id, tipo = "verificar", extra = {}) => ({ id, tipo, origem: "GRU", destino: "JDO", dias: 10, margem: 1, ...extra });

test("agente: pega os jobs do Worker e roda cada um com os dados do job (verificar e buscar)", async () => {
  const w = workerFalso([job("v-000000000001"), job("b-000000000002", "buscar")]);
  const rodados = [];
  let parou = false;
  const tipos = {
    verificar: async (info, ctx) => { rodados.push(["verificar", info.id, info.origem, info.destino, ctx.leitura]); },
    buscar: async (info) => { rodados.push(["buscar", info.id, info.dias, info.margem]); parou = true; },
  };
  await agente({ pegarJson: w.pegarJson, avisar: async () => {}, log: () => {}, tipos, espera: 0, descansar: () => esperar(1), parar: () => parou });
  assert.deepEqual(rodados.sort(), [["buscar", "b-000000000002", 10, 1], ["verificar", "v-000000000001", "GRU", "JDO", "pc"]]);
  assert.ok(w.chamadas.some((c) => c === "/api/varredura/proximo?espera=0"));
});

test("agente: no máximo 2 jobs ao mesmo tempo; o terceiro espera vaga", async () => {
  const w = workerFalso(Array.from({ length: 5 }, (_, i) => job(`v-00000000000${i}`)));
  let ativos = 0, pico = 0, feitos = 0;
  const tipos = { verificar: async () => { ativos++; pico = Math.max(pico, ativos); await esperar(30); ativos--; feitos++; } };
  await agente({ pegarJson: w.pegarJson, avisar: async () => {}, log: () => {}, tipos, espera: 0, descansar: () => esperar(2), parar: () => feitos >= 5 });
  assert.equal(feitos, 5);
  assert.equal(pico, 2);
});

test("agente: job que falha vira etapa 'erro' com o motivo e o agente segue pegando os próximos", async () => {
  const w = workerFalso([job("v-000000000001"), job("v-000000000002")]);
  const avisos = []; let n = 0;
  const tipos = { verificar: async (info) => { n++; if (info.id.endsWith("1")) throw new Error("sem preços do Google"); } };
  await agente({ pegarJson: w.pegarJson, avisar: async (...a) => { avisos.push(a); }, log: () => {}, tipos, espera: 0, descansar: () => esperar(1), parar: () => n >= 2 });
  assert.deepEqual(avisos, [["v-000000000001", "erro", "sem preços do Google"]]);
  assert.equal(n, 2);
});

test("agente: bloqueio do Google não vira outra etapa 'erro' (verificar já avisou google_bloqueou)", async () => {
  const avisos = [];
  await executarJob("v-000000000001", {
    pegarJson: async () => job("v-000000000001"), avisar: async (...a) => { avisos.push(a); }, log: () => {}, leitura: "pc",
    tipos: { verificar: async () => { throw new ErroBloqueio("x"); } },
  });
  assert.deepEqual(avisos, []);
});

test("agente: tipo de job desconhecido e job que sumiu viram erro sem derrubar o agente", async () => {
  const avisos = [];
  await executarJob("v-000000000001", { pegarJson: async () => job("v-000000000001", "outro"), avisar: async (...a) => { avisos.push(a); }, log: () => {}, leitura: "pc" });
  await executarJob("v-000000000002", { pegarJson: async () => { throw new Error("Worker respondeu 404"); }, avisar: async (...a) => { avisos.push(a); }, log: () => {}, leitura: "pc" });
  assert.equal(avisos.length, 2);
  assert.match(avisos[0][2], /desconhecido/);
  assert.match(avisos[1][2], /404/);
});

test("agente: Worker fora do ar = tenta de novo com pausa crescente (sem laço rápido) e volta sozinho", async () => {
  let tentativas = 0; const pausas = []; let feito = false;
  const pegarJson = async (c) => {
    if (c.startsWith("/api/varredura/proximo")) { tentativas++; if (tentativas <= 3) throw new Error("fetch failed"); return { job: tentativas === 4 ? "v-000000000001" : null }; }
    return job("v-000000000001");
  };
  const avisos = [];
  await agente({ pegarJson, avisar: async () => {}, log: (s) => avisos.push(s), espera: 0, tipos: { verificar: async () => { feito = true; } }, descansar: async (ms) => { pausas.push(ms); await esperar(1); }, parar: () => feito });
  assert.deepEqual(pausas.slice(0, 3), [4000, 8000, 16000]);
  assert.equal(avisos.filter((s) => /não consegui falar/.test(s)).length, 1, "só avisa na 1ª falha (não enche o log)");
  assert.ok(feito);
});
