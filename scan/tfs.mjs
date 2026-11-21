// Monta o parâmetro `?tfs=` que o Google Voos usa para receber a busca (protobuf `Info`,
// esquema confirmado contra a biblioteca aberta fast-flights: https://github.com/AWeirdDev/flights).
// Aqui é só serialização de dados (data em, bytes fora). O runner usa o endereço estruturado em vez da consulta em
// texto (`q=`), que o Google às vezes não entende (ex.: "SAO to POA" devolvia a página geral). Aceita código de
// cidade (SAO, RIO...). Cópia de monitor-milhas/worker/src/tfs.js.

function varint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}

function concatBytes(partes) {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) { saida.set(p, pos); pos += p.length; }
  return saida;
}

const tag = (campo, wireType) => varint((campo << 3) | wireType);

function campoBytes(campo, bytes) {
  return concatBytes([tag(campo, 2), varint(bytes.length), bytes]);
}
const campoTexto = (campo, texto) => campoBytes(campo, new TextEncoder().encode(texto));
const campoVarint = (campo, n) => concatBytes([tag(campo, 0), varint(n)]);
// Repeated enum/varint em proto3 é "packed": um só campo length-delimited com os varints concatenados.
const campoVarintEmpacotado = (campo, valores) => campoBytes(campo, concatBytes(valores.map(varint)));

const aeroporto = (codigo) => campoTexto(2, codigo); // Airport { string airport = 2; }

function trechoVoo({ data, origem, destino }) {
  // FlightData { date=2; from_airport=13; to_airport=14; }
  return concatBytes([
    campoTexto(2, data),
    campoBytes(13, aeroporto(origem)),
    campoBytes(14, aeroporto(destino)),
  ]);
}

const ECONOMIA = 1;
const ADULTO = 1;
const IDA_E_VOLTA = 1;
const SO_IDA = 2;

// Info { repeated data=3; repeated passengers=8; seat=9; trip=19; }
export function construirTfs({ origem, destino, ida, volta }) {
  const trechos = volta
    ? [trechoVoo({ data: ida, origem, destino }), trechoVoo({ data: volta, origem: destino, destino: origem })]
    : [trechoVoo({ data: ida, origem, destino })];
  const partes = [
    ...trechos.map((t) => campoBytes(3, t)),
    campoVarintEmpacotado(8, [ADULTO]),
    campoVarint(9, ECONOMIA),
    campoVarint(19, volta ? IDA_E_VOLTA : SO_IDA),
  ];
  const bytes = concatBytes(partes);
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario);
}
