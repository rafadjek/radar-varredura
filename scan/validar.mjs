const RE_IATA = /^[A-Z]{3}$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_JOB = /^((b|c|v|r)-[0-9a-f]{12}|salvas-\d{4}-\d{2}-\d{2}|teste[-a-z0-9]{0,24})$/;

function exigir(ok, msg) { if (!ok) throw new Error(`entrada inválida: ${msg}`); }

export const iata = (v, nome = "aeroporto") => { exigir(RE_IATA.test(String(v)), `${nome} deve ter 3 letras maiúsculas`); return v; };
// Rota com um ou vários aeroportos ("GRU" ou "CGH,GRU,VCP"): até 6, só 3 letras maiúsculas.
export const rota = (v, nome = "rota") => {
  const lista = String(v).split(",");
  exigir(lista.length >= 1 && lista.length <= 6 && lista.every((c) => RE_IATA.test(c)), `${nome} deve ter de 1 a 6 aeroportos de 3 letras maiúsculas`);
  return v;
};
export const data = (v, nome = "data") => {
  exigir(RE_DATA.test(String(v)) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)), `${nome} deve ser AAAA-MM-DD`);
  return v;
};
export const job = (v) => { exigir(RE_JOB.test(String(v)), "job fora do formato"); return v; };
export const inteiro = (v, min, max, nome) => {
  const n = Number(v);
  exigir(Number.isInteger(n) && n >= min && n <= max, `${nome} deve ser inteiro de ${min} a ${max}`);
  return n;
};
// "ida|volta,ida|volta" (até 4; volta pode ser vazia)
export function pares(texto) {
  const lista = String(texto || "").split(",").filter(Boolean);
  exigir(lista.length >= 1 && lista.length <= 4, "pares: de 1 a 4");
  return lista.map((p) => {
    const [ida, volta = ""] = p.split("|");
    data(ida, "ida");
    if (volta && volta !== "-") data(volta, "volta");
    return { ida, volta: volta === "-" ? "" : volta };
  });
}
