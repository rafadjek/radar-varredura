// O Worker só aceita confirmação com a volta até 35 dias depois da ida.
export const MAX_DIAS = 35;

export function adicionarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Para cada data de ida, a volta mais barata entre dias-margem e dias+margem; devolve os `quantos` melhores pares.
export function melhoresPares(ida, volta, dias, margem = 0, quantos = 3) {
  const pares = [];
  for (const [d, pIda] of Object.entries(ida)) {
    let melhor = null;
    for (let n = Math.max(1, dias - margem); n <= Math.min(MAX_DIAS, dias + margem); n++) {
      const v = adicionarDias(d, n);
      if (volta[v] == null) continue;
      const total = pIda + volta[v];
      if (!melhor || total < melhor.total) melhor = { ida: d, volta: v, total };
    }
    if (melhor) pares.push(melhor);
  }
  pares.sort((a, b) => a.total - b.total || a.ida.localeCompare(b.ida));
  return pares.slice(0, quantos);
}

// Melhor par FORA da janela pedida (duração ± margem) mas dentro da ampliada (± margem + extra): é a "sugestão".
// Menor soma; empate: menor |n - dias|, depois ida mais cedo, depois menor n. Mesma regra da página (resumo.js).
export function melhorParForaDaJanela(ida, volta, dias, margem = 0, extra = 4) {
  const minP = Math.max(1, dias - margem);
  const maxP = dias + margem;
  const minA = Math.max(1, dias - margem - extra);
  const maxA = Math.min(MAX_DIAS, dias + margem + extra);
  let melhor = null;
  const melhorQue = (c, m) => {
    if (c.total !== m.total) return c.total < m.total;
    const dc = Math.abs(c.dias - dias);
    const dm = Math.abs(m.dias - dias);
    if (dc !== dm) return dc < dm;
    if (c.ida !== m.ida) return c.ida < m.ida;
    return c.dias < m.dias;
  };
  for (const [d, pIda] of Object.entries(ida)) {
    for (let n = minA; n <= maxA; n++) {
      if (n >= minP && n <= maxP) continue;
      const v = adicionarDias(d, n);
      if (volta[v] == null) continue;
      const c = { ida: d, volta: v, total: pIda + volta[v], dias: n };
      if (!melhor || melhorQue(c, melhor)) melhor = c;
    }
  }
  return melhor;
}
