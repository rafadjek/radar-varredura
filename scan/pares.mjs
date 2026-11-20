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
    for (let n = Math.max(1, dias - margem); n <= dias + margem; n++) {
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
