# radar-varredura

Leitor do Google Voos usado pelo RadarPassagens (https://radarpassagens.pages.dev). Roda no GitHub Actions: um Chrome sem interface abre o Google Voos com `gl=BR`, lê o calendário de preços (só ida, ~330 dias) e a aba "Menores preços" do par de datas, e envia o resultado ao Worker do site.

Não há chave de API paga. **O repositório é privado** (desde 2026-11-21) porque ele usa executores self-hosted no PC do Rafael (`D:\actions-runner`, etiquetas `pc-brasil` e `pc-salvas`): o IP brasileiro residencial do PC enxerga as ofertas de agência que o IP do GitHub não vê. Quando o PC está desligado, o Worker manda os jobs para o GitHub hospedado (`ubuntu-latest`, plano B). Nenhum segredo fica no código (`WORKER_URL` e `INGEST_SECRET` são secrets do repositório; o batimento do PC lê os mesmos valores das variáveis de ambiente do usuário).

**Plano B com Edge (desde 2026-11-27):** os fluxos `buscar`, `confirmar` e `verificar` instalam o Microsoft Edge no executor hospedado e usam `CHROME_BIN=microsoft-edge`. Teste do dia, mesmas rotas e datas: o Edge no GitHub (IP dos EUA) leu o mesmo preço do PC em 5 de 5 rotas lidas (GRU>JDO deu R$ 723 contra R$ 725); o que dava preço mais alto era o Chrome, não o IP. Ressalva: do IP dos EUA 2 de 7 rotas não leram na primeira rodada (GRU>BSB nunca leu em 3 tentativas), enquanto uma VM em São Paulo (datacenter Magalu) e o PC leram as 7. Falha aparece como cobertura baixa, nunca como preço inventado. `salvas.yml` continua só nos executores do PC. O rótulo "pode haver oferta menor" do site (leitura "nuvem") ficou desatualizado para este caso.

- `.github/workflows/buscar.yml`: uma busca sob demanda (ida e volta em paralelo, depois confirma os 3 melhores pares).
- `.github/workflows/confirmar.yml`: só confirma até 3 pares.
- `.github/workflows/salvas.yml`: varre as rotas de `rotas.json` (disparado uma vez ao dia pelo Worker).
- `scan/`: Chrome via CDP (`chrome.mjs`), calendário (`calendario.mjs`), preço confirmado (`confirmar.mjs`), envio ao Worker (`enviar.mjs`), escolha dos pares (`pares.mjs`), linha de comando (`cli.mjs`).

Teste local (Edge/Chrome instalado): `CHROME_BIN="caminho do msedge.exe" node scan/cli.mjs calendario teste GRU JDO ida saida.json` (sem `WORKER_URL`, só mostra o que enviaria). Testes: `node --test test/`.

Ler o Google Voos por navegador automatizado é de uso pessoal e volume baixo; se o Google mudar a página, as leituras falham de forma explícita (cobertura baixa), nunca com preço inventado.

## Leitor com abas e verificação de janela (Fase 3)
- `scan/navegador.mjs` + `scan/leitor.mjs`: um navegador com várias abas (`ABAS`, padrão 3, máx 6); o preço só vale quando a resposta `GetShoppingResults` do Google termina (plano B: 20 s + 12 s estável); página "sorry"/captcha para tudo (`ErroBloqueio`). `LEITOR=antigo` volta ao leitor de um navegador por par.
- `scan/verificar.mjs` + `.github/workflows/verificar.yml`: `cli verificar <job> <origem> <destino>` pega os pares do Worker (`GET /api/varredura/job/<id>`) e entrega os preços em lotes (`POST /api/varredura/lote`).
- `scan/medir.mjs` e `scan/ab.mjs`: medições locais (gastam consultas ao Google; poucas e espaçadas). Resultados em `apoio/plans/2026-11-21-f30-medicao.md` (projeto monitor-milhas).
- O perfil temporário do navegador é apagado ao fechar.
