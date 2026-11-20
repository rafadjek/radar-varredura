const RE_IATA = /^[A-Z]{3}$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_JOB = /^((b|c)-[0-9a-f]{12}|salvas-\d{4}-\d{2}-\d{2}|teste[-a-z0-9]{0,24})$/;

function exigir(ok, msg) { if (!ok) throw new Error(`entrada inválida: ${msg}`); }

export const iata = (v, nome = "aeroporto") => { exigir(RE_IATA.test(String(v)), `${nome} deve ter 3 letras maiúsculas`); return v; };
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
// "ida|volta,ida|volta" (até 3; volta pode ser vazia)
export function pares(texto) {
  const lista = String(texto || "").split(",").filter(Boolean);
  exigir(lista.length >= 1 && lista.length <= 3, "pares: de 1 a 3");
  return lista.map((p) => {
    const [ida, volta = ""] = p.split("|");
    data(ida, "ida");
    if (volta && volta !== "-") data(volta, "volta");
    return { ida, volta: volta === "-" ? "" : volta };
  });
}
