# Contratos do laboratório

Esta especificação descreve a implementação de Wallet Ledger Lab. Os exemplos usam identidades sintéticas. O domínio simula operações de apostas; nenhuma rota realiza pagamentos ou movimenta ativos reais.

## Valores e identificadores

Dinheiro é um objeto JSON:

```json
{ "amount": "25.00", "currency": "BRL" }
```

`amount` é uma string não negativa com exatamente duas casas, sem expoente, espaços ou sinal. Há um limite de 36 dígitos inteiros. Valores como `25`, `"25.0"`, `"25.001"` ou `"-1.00"` são inválidos. Zeros à esquerda aceitos são normalizados na resposta. Abertura de wallet e `LOSS` admitem `"0.00"`; as demais operações exigem valor positivo.

`currency` é uma string de três letras maiúsculas reconhecida pelo catálogo ICU do runtime fixado. Todas as moedas usam escala 2 neste estudo. Moedas divergentes não são convertidas automaticamente.

IDs internos de jogador e wallet usam UUID. IDs de provedor, operação externa, rodada, jogo e mensagem começam com caractere alfanumérico e admitem letras, números, ponto, hífen, sublinhado e dois-pontos, até 128 caracteres. A chave de idempotência admite de 1 a 256 caracteres ASCII visíveis. Corpos HTTP e mensagens de entrada têm limite de 64 KiB; campos desconhecidos são recusados.

## Wallet

```http
POST /wallets
Content-Type: application/json
```

```json
{
  "playerId": "11111111-1111-4111-8111-111111111111",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

A resposta `201` contém `id`, `playerId`, `balance` e `version`. O `id` gerado deve ser usado nas chamadas seguintes. Existe uma wallet por jogador e moeda; uma abertura duplicada retorna `409 WALLET_EXISTS`.

A versão inicial é 1. Saldo inicial positivo gera `OPENING` e crédito no ledger no mesmo commit. Abertura zero não gera lançamento. `OPENING` é uma operação interna e não pode ser enviada por HTTP ou SQS.

```http
GET /wallets/:walletId
GET /wallets/:walletId/ledger?limit=50&cursor=...
```

A consulta da wallet retorna sua visão atual. O ledger retorna `items` e `nextCursor`, que vale `null` ao fim. O cursor é opaco, versionado e vinculado à wallet; os registros são ordenados por `walletVersion`. `limit` vai de 1 a 100. Reutilizar o cursor em outra wallet é inválido.

## Submeter uma operação

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: demo-provider:operation-001
```

```json
{
  "providerId": "demo-provider",
  "externalTransactionId": "operation-001",
  "playerId": "11111111-1111-4111-8111-111111111111",
  "walletId": "22222222-2222-4222-8222-222222222222",
  "roundId": "round-demo",
  "gameId": "game-demo",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Substitua o `walletId` ilustrativo pelo ID retornado na criação. No contrato HTTP, a chave existe no header; um campo `idempotencyKey` no corpo é recusado.

O resultado contém:

```json
{
  "transactionId": "33333333-3333-4333-8333-333333333333",
  "walletId": "22222222-2222-4222-8222-222222222222",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Os IDs da resposta acima são ilustrativos. Uma rejeição financeira acrescenta `failureCode`. O saldo pertence à decisão daquela transação; um replay posterior devolve o mesmo saldo histórico.

| Kind | Efeito | Referência |
| --- | --- | --- |
| `BET` | Débito | Não aceita referência |
| `WIN` | Crédito | Opcional; quando presente, aponta para uma `BET` |
| `LOSS` | Nenhum movimento ou ledger | Opcional; quando presente, aponta para uma `BET` |
| `REFUND` | Crédito integral | Exige `BET` processada |
| `ROLLBACK` | Direção inversa da operação original | Exige `BET`, `WIN` ou `REFUND` processada |

`referenceExternalTransactionId` identifica a operação externa no mesmo provedor. Referências precisam ter jogador, wallet, moeda e rodada compatíveis. `REFUND` e `ROLLBACK` devem ter o mesmo valor da referência. Não há reversão parcial.

Uma referência pode ser revertida no máximo uma vez **por tipo de reversão**. Uma `REFUND` e uma `ROLLBACK` distintas da mesma `BET` podem ambas ser aceitas. Reverter um crédito que já foi consumido pode falhar por insuficiência específica de reversão.

## Idempotência e estados

A chave financeira é global. Repetir o mesmo comando normalizado com a mesma chave retorna o resultado original com `idempotentReplay: true`. Reutilizá-la com outro conteúdo retorna `409 IDEMPOTENCY_CONFLICT`. Outra chave para a mesma dupla de provedor e operação externa retorna `409 EXTERNAL_TRANSACTION_CONFLICT`.

O hash financeiro é SHA-256 sobre JSON canônico dos campos de negócio normalizados. Metadados de transporte e a chave não entram nesse hash. A ordem das chaves JSON não muda a identidade financeira.

| Estado | Significado |
| --- | --- |
| `PENDING` | Ainda não aplicado |
| `PENDING_REFERENCE` | Aceite persistido aguardando referência |
| `PROCESSED` | Operação aplicada, incluindo `LOSS` |
| `REJECTED` | Regra de negócio recusou a aplicação |
| `FAILED` | Falha permanente de infraestrutura registrada para auditoria |

Os três últimos são terminais. Rejeições e falhas não geram lançamento financeiro. Referências pendentes recebem retry com backoff, limite de tentativas e TTL configuráveis; não se tornam créditos antecipados.

## Consultas e reconciliação

```http
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
```

A consulta por ID interno inclui também provedor, ID externo e kind. A reconciliação compara o saldo persistido com a soma assinada do ledger, sob lock compatível com a leitura consistente. A resposta inclui `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`.

Uma divergência é devolvida, logada e contabilizada; a rota não reescreve o histórico nem corrige saldos silenciosamente. `difference` pode ser negativo e continua sendo uma string decimal.

## HTTP e falhas

| Situação | Status HTTP |
| --- | --- |
| Wallet criada | 201 |
| Consulta, processamento ou replay processado | 200 |
| Pendente | 202 |
| Contrato inválido | 400 |
| Recurso ausente | 404 |
| Wallet duplicada, chave ou operação externa em conflito | 409 |
| Rejeição financeira persistida | 422 |
| Corpo acima do limite | 413 |
| Infraestrutura temporariamente indisponível ou resultado `FAILED` | 503 |

Erros de contrato e transporte usam `{ "error": { "code": "...", "message": "..." }, "correlationId": "..." }`. Resultados financeiros usam o envelope com `status` e, quando aplicável, `failureCode`. `X-Correlation-Id` é devolvido nas respostas.

Exemplos de códigos estáveis:

| Código | Interpretação |
| --- | --- |
| `INSUFFICIENT_FUNDS` | Aposta sem saldo suficiente |
| `INSUFFICIENT_FUNDS_FOR_REVERSAL` | Reversão de crédito produziria saldo negativo |
| `CURRENCY_MISMATCH` / `PLAYER_MISMATCH` | Comando incompatível com a wallet |
| `REFERENCE_MISMATCH` | Referência de outro escopo |
| `REFERENCE_NOT_FOUND` | Referência não ficou disponível no orçamento permitido |
| `REFERENCE_NOT_PROCESSED` | Referência terminal não foi processada |
| `INVALID_REFERENCE_KIND` | Tipo da referência incompatível |
| `REFERENCE_AMOUNT_MISMATCH` | Reversão não integral |
| `REFERENCE_ALREADY_REVERSED` | Reversão do mesmo tipo já aplicada |
| `MONEY_OVERFLOW` | Resultado ultrapassaria a capacidade monetária |
| `MESSAGE_CONFLICT` | ID de inbox reutilizado com conteúdo divergente |
| `INFRASTRUCTURE_RETRY_EXHAUSTED` | Orçamento de processamento esgotado |

Uma falha HTTP transitória sem resultado financeiro permite repetir a mesma chave. Um resultado persistido `FAILED` é terminal: repeti-lo recupera a decisão auditada, não reabre o processamento.

## Entrada SQS

A fila `wager-transactions.fifo` aceita um envelope de aplicação:

```json
{
  "messageId": "message-demo-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "correlationId": "correlation-demo",
  "data": {
    "providerId": "demo-provider",
    "externalTransactionId": "operation-001",
    "idempotencyKey": "demo-provider:operation-001",
    "playerId": "11111111-1111-4111-8111-111111111111",
    "walletId": "22222222-2222-4222-8222-222222222222",
    "roundId": "round-demo",
    "gameId": "game-demo",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

`occurredAt` é um timestamp UTC válido terminado em `Z`; `correlationId` é opcional. A inbox identifica o par de consumidor e `messageId` do envelope. IDs diferentes para o mesmo comando continuam protegidos pela chave financeira.

O consumidor confirma a mensagem após commit. Falhas transitórias usam retry de visibilidade; contratos inválidos e falhas permanentes seguem para `wager-transactions-dlq.fifo`. O código de encaminhamento manual fica no atributo SQS `failureCode`. A redrive nativa pode atuar sem esse atributo quando o processo ou o banco permanecem indisponíveis.

## Eventos de saída

`wager-events.fifo` recebe envelopes versionados com `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`, `version`, `data` e, quando fornecido, `causationId`.

| Evento | Condição |
| --- | --- |
| `WagerTransactionProcessed` | Operação processada, inclusive `LOSS` e abertura positiva |
| `WagerTransactionRejected` | Rejeição financeira persistida |
| `WagerTransactionPendingReference` | Primeiro aceite aguardando referência |
| `WagerTransactionFailed` | Falha permanente registrada com banco disponível |
| `WalletBalanceChanged` | Movimento que efetivamente altera o saldo |

Dinheiro no evento continua sendo `MoneyProps`, com strings decimais. Eventos reenviados preservam `eventId` e conteúdo. Consumidores precisam deduplicar esse ID de forma persistente. O projeto não promete entrega exatamente uma vez ou ordem total entre publishers.

## Saúde e autenticação

`GET /health/live` indica processo vivo. `GET /health/ready` verifica banco e filas. `GET /metrics` expõe métricas Prometheus.

A identidade HTTP usa um adaptador permissivo para execução local. Health não exige autenticação. Não exponha esta configuração externamente; veja [SECURITY.md](../SECURITY.md).
