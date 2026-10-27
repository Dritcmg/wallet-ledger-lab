# Telemetria local do laboratório

O laboratório usa Prometheus 3.15.1 e Grafana 13.3.0 para observar o serviço compilado. O dashboard `wallet-ledger-lab` contém dez painéis provisionados por arquivo e consulta apenas métricas operacionais de baixa cardinalidade. A demonstração usa dados sintéticos; duração e percentis observados não são benchmark nem compromisso de capacidade.

## Executar

Na raiz do projeto, prepare o ambiente privado pelo setup do laboratório. Ele gera `.env` com senhas aleatórias; não copie esse arquivo para evidências ou distribuição.

```sh
bun scripts/setup-local.ts
docker compose --profile observability up --build --detach --wait app prometheus grafana
bun scripts/telemetry-demo.ts
bun scripts/validate-telemetry.ts
```

Os dois scripts de telemetria rodam no host, onde Bun carrega o `.env` privado. O validador lê `GRAFANA_ADMIN_USER` e `GRAFANA_ADMIN_PASSWORD` desse ambiente e envia autenticação somente à API local do Grafana, sem imprimir cabeçalho, senha ou resposta administrativa. O app recebe suas credenciais PostgreSQL; ele não recebe a senha administrativa do Grafana.

| Serviço | Endereço no host |
| --- | --- |
| API compilada | [localhost:3100](http://localhost:3100) |
| Prometheus | [localhost:9091](http://localhost:9091) |
| Dashboard Grafana | [dashboard local](http://localhost:3101/d/wallet-ledger-lab/) |
| PostgreSQL da demonstração | `127.0.0.1:55442`, banco/usuário `wager` |
| SQS da demonstração | `127.0.0.1:4576` |
| PostgreSQL de teste | `127.0.0.1:55443`, banco/usuário `wager_test` |
| SQS de teste | `127.0.0.1:4577` |

Todos os binds publicados usam `127.0.0.1`. Os scripts recusam outros hosts, portas de outros projetos, credenciais em URL, caminhos e query strings no endpoint base. Os nomes `app:3000`, `prometheus:9090` e `grafana:3000` são aceitos somente como destinos internos explícitos do Compose.

O profile `observability` adiciona Prometheus e Grafana. Prometheus consulta `app:3000/metrics` a cada cinco segundos; Grafana usa o datasource provisionado `wallet-ledger-prometheus`. Não é preciso importar manualmente um dashboard ou informar credenciais no JSON.

## O que cada painel mostra

| Painel | Interpretação |
| --- | --- |
| API scrape health | `up` indica se Prometheus conseguiu ler o target configurado. |
| Dependency collection health | Flags PostgreSQL/SQS indicam se os snapshots atuais foram atualizados. Valores anteriores podem permanecer quando a flag é zero. |
| Persisted transactions by status | Gauge dos cinco estados SQL, incluindo OPENING. Replay não cria uma nova transação persistida. |
| Pending outbox events | Quantidade SQL com `published_at IS NULL`. |
| Oldest pending event | Idade do evento pendente mais antigo; zero quando não há backlog. |
| Observed publish delay p95 | Estimativa pelos buckets acumulados do histograma de eventos publicados desde o início do processo. Use idade pendente para eventos ainda não publicados. |
| Observed HTTP duration p95 | Estimativa pelos buckets acumulados de rotas de negócio, excluindo health e métricas. A pequena amostra sintética não mede capacidade. |
| Observed command responses | Counter de resultados de `submit`, incluindo replay; é diferente do gauge de transações únicas persistidas. |
| Observed duplicates and retries | Counters observados desde o início do processo, incluindo tentativas de referências pendentes. |
| DLQ and reconciliation | Profundidade aproximada da DLQ e counter de divergências de reconciliação detectadas. |

Counters e histogramas reiniciam com o processo. Gauges SQL/SQS são atualizados no scrape. Instâncias que compartilham banco e filas repetem os gauges globais: não os some entre instâncias. A profundidade da DLQ é aproximada e soma mensagens visíveis e em processamento.

As queries reais estão em [queries.ts](../telemetry/queries.ts); o JSON do dashboard usa as mesmas expressões. A agregação cumulativa dos percentis e counters é deliberada para uma demonstração curta: não depende de haver tráfego contínuo em uma janela de produção. O dashboard não contém IDs de wallet, player, provedor ou mensagem, e não usa e-mails, organização ou dados reais de clientes.

## Tráfego sintético e evidência

`telemetry-demo.ts` cria duas wallets sintéticas, disputa um saldo com duas apostas concorrentes, verifica cinco replays, LOSS, WIN, ROLLBACK, REFUND antes da referência, retry agendado e reconciliação. Cada execução limita o tráfego a 120 requisições HTTP; não há loop de carga contínua. As operações financeiras ficam auditáveis no PostgreSQL local e não são apagadas pelo script.

A saída pública contém somente:

- `evidence/latest/telemetry.json`: contagens agregadas, limites da demonstração, duração diagnóstica e `benchmark: false`.
- `evidence/latest/metrics.prom`: nomes de métricas aprovados e labels de baixa cardinalidade. Labels inesperados, IDs, rotas concretas e valores inválidos são recusados; séries fora da allowlist são omitidas.
- `evidence/latest/telemetry-validation.json`: resultados agregados de validação, sem respostas completas de APIs ou credenciais.

O validador consulta o target real no Prometheus, executa as doze expressões PromQL, verifica health, datasource, query do datasource e dez painéis provisionados no Grafana. Também confirma configurações de analytics, updates, signup, acesso anônimo e instalação de plugins. Ausência de serviço/dados produz falha; o script não fabrica uma evidência de aprovação.

Capture esses três arquivos **antes** de executar o `verify.ts` final. O verificador calcula os hashes dos curados presentes; alterar a evidência depois exige regenerar a verificação antes do empacotamento. Raw de diagnóstico ficam privados em `artifacts/private`, conforme o tooling do projeto; os scripts de telemetria não gravam payloads ou identificadores nesses curados.

## Rede, configuração e retenção

As redes bridge `lab` e `test` separam os serviços da demonstração e dos testes. O tester também possui a rede `validation` para a auditoria do inventário público de dependências. As bridges não constituem bloqueio absoluto de egress; a configuração usa somente destinos locais de métricas e não define exportador ou `remote_write` externo.

Grafana desativa analytics, envio de estatísticas, checagem de updates/plugins, instalação automática de plugins, download de chaves e acesso anônimo. O dashboard usa recursos embarcados e datasource interno. LocalStack recebe `DISABLE_EVENTS=1`. Não há Docker socket ou montagem do `.env` nos containers.

Prometheus retém até 24 horas no volume `prometheus-data`; Grafana persiste configuração local e credencial administrativa no volume `grafana-data`. Reiniciar containers preserva esses volumes. Recriar `.env` com novas senhas não atualiza automaticamente credenciais já persistidas; mantenha a configuração privada correspondente ou use o reset local explícito e limitado do laboratório. O reset e a política de publicação são responsabilidades dos scripts operacionais do projeto.

O runtime executa `bun dist/main.js` como usuário `bun`. A imagem de verificação tem ferramentas, fontes e testes e executa como root apenas para escrever evidências nas montagens autorizadas. Gitleaks e sua licença existem somente na imagem de verificação.

## Verificação deste escopo

Em 27/10/2026, a bateria deste escopo observou:

| Verificação executada | Resultado |
| --- | --- |
| `docker compose --profile observability --profile test config --quiet` | Modelo válido; valores resolvidos de credenciais não foram impressos. |
| `bun test ./tests/unit/telemetry-portfolio.test.ts` | 4 testes aprovados, zero falhas, 16 asserções, 1 arquivo em 19 ms. |
| `bun run typecheck` | Aprovado após implementar os scripts e os contratos de telemetria. |
| `bun scripts/telemetry-demo.ts` | Coordenador observou 35 requisições limitadas, 152 amostras aprovadas e duas reconciliações consistentes; curados gerados. |
| `bun scripts/validate-telemetry.ts` | Aprovado contra serviços reais: um target saudável, doze queries PromQL e dez painéis provisionados; query do datasource e configurações privadas verificadas sem expor valores. |

Use o prefixo `./` ao executar um arquivo de teste específico. Um filtro sem esse prefixo também encontrou uma cópia privada em um stage de publicação; o alvo explícito acima executou somente o arquivo pretendido. O pipeline do projeto define seus diretórios de descoberta para evitar cópias de artefatos.

O quickstart foi ajustado a duas falhas observadas: somente `app` faz build da imagem runtime compartilhada pelos jobs; Prometheus usa o default de lifecycle desativado, sem flag booleana incompatível. No Docker Desktop usado, bridges com `internal:true` não publicaram as portas no host; as redes atuais são bridges separadas com binds loopback. Uma falha inicial de conexão/parse do validador não se reproduziu; o helper agora informa códigos específicos de requisição ou JSON inválido e somente status HTTP, sem detalhes sensíveis.

Esses resultados validam a demonstração local. O registro completo do serviço, verificação integrada, auditoria e pacote é mantido pelo verificador/coordenador do projeto; o resultado desta bateria não equivale a deploy remoto ou benchmark.

Referências oficiais consultadas: [configuração do Grafana](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/), [provisionamento de dashboards e datasources](https://grafana.com/docs/grafana/latest/administration/provisioning/), [scrape do Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/configuration/) e [promtool 3.15](https://prometheus.io/docs/prometheus/3.15/command-line/promtool/).
