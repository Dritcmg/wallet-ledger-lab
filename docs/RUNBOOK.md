# Operação local

Este runbook atende ao laboratório com dados sintéticos. As credenciais ficam em `.env`, os serviços de demonstração e teste são separados e nenhuma etapa pressupõe acesso a contas ou ambientes externos.

## Inicialização e inspeção

Na raiz do projeto:

```sh
docker run --rm -v "${PWD}:/workspace" -w /workspace oven/bun:1.4.4 bun scripts/setup-local.ts
docker compose up --build -d --wait app
docker compose --profile observability up -d prometheus grafana
docker compose ps
```

Use [/health/live](http://localhost:3100/health/live) para processo vivo e [/health/ready](http://localhost:3100/health/ready) para dependências alcançáveis. A raiz da API não é uma página de produto. Os contratos estão em [SPECIFICATION.md](SPECIFICATION.md).

```sh
docker compose logs --tail 100 app
docker compose logs --tail 100 migrate queues
```

Procure eventos operacionais, `correlationId`, `transactionId`, `walletId`, `messageId` e códigos. Não publique o log bruto: mesmo logs filtrados são registros de execução local e devem passar pela sanitização prevista em [SECURITY.md](../SECURITY.md).

## Saúde e diagnóstico

| Sinal | Verificação |
| --- | --- |
| Readiness indisponível | Estado de PostgreSQL, LocalStack e bootstrap das filas |
| `PENDING_REFERENCE` persistente | Existência, escopo e estado da referência; tentativas e TTL |
| Backlog de outbox aumentando | Banco, broker, leases, `next_attempt_at` e erros do publisher |
| DLQ com mensagens | Contrato, `failureCode`, contagem de entregas e idempotência SQL |
| Conflitos de lock | Concorrência sobre a mesma wallet e duração das transações |
| Divergência de reconciliação | Interromper novas escritas e preservar evidências |

As métricas estão em [/metrics](http://localhost:3100/metrics), [Prometheus](http://localhost:9091) e [Grafana](http://localhost:3101). As credenciais administrativas do Grafana são as geradas em `.env`. Consulte [TELEMETRY.md](TELEMETRY.md) para consultas e demonstração sintética.

`wager_transactions` é uma visão de estados persistidos; `wager_transaction_responses_total` conta respostas observadas por processo, inclusive replay. `wager_outbox_pending_messages` e `wager_outbox_oldest_age_seconds` acompanham eventos ainda pendentes. Não interprete contadores de resposta como quantidade de operações financeiras únicas.

## Consultar o banco sem alterar auditoria

Para abrir uma sessão com a configuração do próprio container:

```sh
docker compose exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Consultas úteis:

```sql
SELECT status, count(*) FROM wager_transactions GROUP BY status;

SELECT id, event_type, attempts, next_attempt_at, locked_until
FROM outbox_messages
WHERE published_at IS NULL
ORDER BY occurred_at, id
LIMIT 20;

SELECT id, wallet_id, provider_id, external_transaction_id,
       attempts, next_attempt_at
FROM wager_transactions
WHERE status = 'PENDING_REFERENCE'
ORDER BY next_attempt_at, id
LIMIT 20;
```

São consultas de leitura. Não remova lançamentos, não desative triggers e não ajuste saldo diretamente para silenciar uma divergência.

## Reconciliação

Envie `POST /wallets/:walletId/reconciliation` usando o ID da wallet sintética. A resposta deve comparar `storedBalance` e `calculatedBalance`, informar `difference`, `consistent` e a quantidade de lançamentos examinados.

Se `consistent` for falso:

1. Pare novas escritas dessa demonstração e preserve o estado.
2. Registre revisão, resultado da rota, IDs operacionais e janela de execução em armazenamento privado.
3. Compare lançamentos, versões e transações associadas usando leitura.
4. Reproduza o caso em ambiente de teste isolado antes de propor correção.

A rota sinaliza o problema; ela não reescreve o histórico.

## Referências, retries e DLQ

Uma operação aceita como `PENDING_REFERENCE` não movimenta o saldo. Os workers a revisitam até a referência ficar disponível ou o orçamento expirar. Não envie uma segunda operação com outra chave para forçar o resultado.

Na DLQ, primeiro identifique a mensagem de aplicação, o provedor, o ID externo e a chave financeira. Consulte o registro SQL correspondente. Uma mensagem pode já ter sido processada: a confirmação ao broker pode ter se perdido depois do commit.

O atributo `failureCode` explica encaminhamentos feitos pela aplicação. A redrive nativa pode não carregar esse atributo. Quando o banco ficou indisponível, a mensagem também pode não ter registro SQL. Isso exige análise; não significa automaticamente que houve débito ou que ele deva ser repetido.

O projeto não oferece um comando de reenvio indiscriminado de DLQ. Após corrigir a causa, um reenvio sintético controlado deve manter a identidade original do comando. Verifique resultado histórico, um único efeito financeiro e reconciliação. Apagar a mensagem antes de investigar descarta evidência útil.

Eventos de saída podem ser reenviados com o mesmo `eventId`. Não remova registros de outbox para contornar falhas. Consumidores posteriores precisam deduplicar o ID de forma persistente.

## Parada e reinício

```sh
docker compose stop
docker compose up -d --wait app
```

O processo recebe `SIGTERM`, drena trabalho ou devolve visibilidade e encerra dentro do orçamento. O Compose oferece uma tolerância maior que o prazo interno. As regressões de sinal são executadas em Linux; comportamento de sinais no host Windows não substitui esse gate.

`stop` preserva volumes. O estado do simulador SQS depende da configuração de persistência de LocalStack; recriar o broker não equivale a uma recuperação de serviço gerenciado. Um evento já marcado como publicado não é republicado apenas porque uma fila local foi recriada.

## Verificação e evidência

```sh
docker compose --profile test run --build --rm tester
```

Não execute duas suítes de integração simultaneamente sobre o mesmo conjunto de serviços de teste. Os casos usam identidades únicas, mas compartilham filas e processos de recuperação.

Os resultados publicáveis ficam em [evidence/latest/REPORT.md](../evidence/latest/REPORT.md). Logs brutos, configuração privada e dados auxiliares não devem ser exportados. Uma alteração de código ou configuração exige nova verificação; um relatório antigo não valida a revisão atual.

## Reset destrutivo

Parar serviços e reiniciar containers é diferente de remover seus volumes. Para um reset completo, use primeiro a prévia do script dedicado, com Bun no host e o contexto Docker local correto:

```sh
bun scripts/local-reset.ts --dry-run
```

Leia a lista de containers, redes e volumes planejados. Preserve dados necessários em armazenamento privado antes de considerar o modo de aplicação. Não use comandos globais de limpeza de Docker ou apague volumes por padrão. A [estratégia de recuperação](RELEASE.md) descreve os limites de reversão.
