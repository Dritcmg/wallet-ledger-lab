# Estudo de caso: saldo, auditoria e falhas entre commits

## O problema

Um saldo pode estar correto em uma execução isolada e falhar quando duas instâncias recebem o mesmo comando. Repetição de entrega, concorrência e encerramento de processo criam intervalos em que uma resposta desaparece, mas o efeito financeiro já foi confirmado.

Wallet Ledger Lab usa uma simulação de operações de apostas para estudar esses intervalos. O objetivo é tornar verificáveis três propriedades: dinheiro calculado exatamente, um histórico que explica o saldo e repetição segura de comandos. Não há integração comercial, clientes ou movimentação de dinheiro real.

## Decisões principais

| Decisão | Motivo | Custo assumido |
| --- | --- | --- |
| Strings decimais e `decimal.js` | Evitar conversão financeira por ponto flutuante | Contratos e persistência precisam preservar a representação |
| Lock por wallet no PostgreSQL | Serializar apenas operações que disputam o mesmo saldo | Uma wallet muito concorrida concentra espera |
| Constraints e triggers no commit | Detectar inconsistência mesmo se um adaptador errar | Mais lógica de schema e testes de migration |
| Resultado persistido por transação | Replays precisam devolver a decisão histórica | Armazenamento adicional de resultado |
| Inbox e outbox na mesma transação | Fechar a lacuna entre entrada, saldo, auditoria e intenção de publicar | Exige workers e operação de backlog |
| Lease com token de posse | Permitir publishers concorrentes e recuperação de quem morreu | Reenvio ainda é possível após envio sem confirmação |
| Ambiente local isolado para testes | Exercitar PostgreSQL e SQS sem dados externos | Execução exige containers Linux e recursos locais |

O modelo mantém um ledger de movimentos por wallet. Partidas dobradas e liquidação financeira externa ficam fora do escopo.

## Situações que orientaram a implementação

**Disputa por saldo.** Com saldo sintético de `100.00`, duas apostas de `80.00` concorrem. O resultado esperado é uma aplicação, uma rejeição, saldo `20.00` e um único débito. Os testes usam requisições paralelas em processos independentes, além de verificar que outras wallets continuam trabalhando enquanto uma delas está bloqueada.

**Resposta perdida.** Uma operação pode ser confirmada e o cliente não receber a resposta. A chave financeira persistida permite repetir a requisição sem reaplicar o movimento. Um crédito posterior não muda o saldo devolvido pelo replay da operação anterior.

**Evento ainda não enviado.** Uma API confirma o commit e morre antes de existir um publisher ativo. Os eventos permanecem na outbox e novos processos os publicam com os IDs originais. Um teste separado mata o consumidor após commit e antes do ack da entrada.

**Publisher interrompido.** Uma lease confirmada precisa expirar sem intervenção manual para que outro publisher assuma. Se um publisher antigo perde o token, não pode confirmar ou limpar o claim do novo dono, mesmo após um envio real ao broker.

**Referência fora de ordem.** Uma reversão não pode produzir crédito enquanto a operação original ainda é desconhecida. O sistema persiste a pendência, tenta novamente e registra uma rejeição estável quando o orçamento acaba.

**Shutdown com receive em andamento.** A investigação identificou que abortar um poll no cliente podia deixar receives ativos no simulador, consumindo o orçamento de entrega da mensagem seguinte. A correção foi reduzir o poll para um segundo e drenar a resposta antes de abortar como fallback. A regressão observa encerramento real, devolução de visibilidade e a próxima entrega, sem adicionar uma espera artificial entre os casos.

**Proteção abaixo do domínio.** Além de precisão monetária, o schema precisa rejeitar valores não finitos, versões inconsistentes e histórico com saldos descontínuos. Testes SQL exercitam essas proteções sem desativar os guards originais nem apagar o ledger.

**Mesmo artefato entre ambientes.** A comparação dos hashes revelou que o bundler incorporava uma condição de `NODE_ENV` no build do gancho de falha controlada, produzindo bytes diferentes na verificação e na demonstração. A leitura dessa configuração passou a ocorrer em runtime. A regressão compara os bundles gerados nos modos development, test e production, verifica que segredos do ambiente não foram incorporados e mantém o gancho desativado fora do runtime de teste.

## Como as afirmações são verificadas

Os resultados atuais são gerados em [evidence/latest/REPORT.md](../evidence/latest/REPORT.md). O [resumo JSON](../evidence/latest/summary.json), os relatórios JUnit e os manifests permitem relacionar resultado, revisão do código e artefatos. Não há uma contagem de testes mantida manualmente neste estudo.

Os testes de dinheiro incluem um oráculo independente: centavos representados por `BigInt`, com corpus determinístico. A integração usa PostgreSQL e LocalStack reais, processos separados e falhas controladas. Os casos consultam efeitos persistidos e verificam a igualdade entre saldo materializado e saldo reconstruído pelo ledger.

Essas verificações demonstram os cenários e limites registrados no relatório. Elas não constituem prova formal, benchmark de capacidade ou certificação de segurança.

## Metodologia

O desenvolvimento utilizou assistência de IA na implementação e na revisão, com decisões registradas e validação executável. A autoria é apresentada pelo alias **Dri_Dev**; não se reivindica desenvolvimento exclusivamente manual. A qualidade é sustentada por código revisável, reproduções de falhas, testes e evidência gerada, sem publicar conversas ou materiais privados de trabalho.

## Riscos e próximos passos

- A autenticação permissiva atende apenas ao laboratório local. Exposição externa exigiria identidade, autorização por recurso e uma revisão operacional própria.
- A validação do histórico cresce com o número de lançamentos da wallet. Uma evolução de capacidade precisaria medir esse custo e preservar as invariantes ao otimizar.
- A outbox entrega eventos ao menos uma vez. O consumidor final precisa implementar deduplicação persistente; FIFO não elimina essa obrigação.
- Uma indisponibilidade prolongada do banco pode levar a mensagem à DLQ sem registro SQL. Recuperação exige investigar a mensagem e consultar idempotência antes de reenviar.
- LocalStack e volumes locais não reproduzem todas as garantias e falhas de um serviço gerenciado. Reiniciar ou remover recursos locais pode alterar o estado do simulador.
- Não há carga de produção, SLO validado, staging implantado ou estudo de custos empresariais.

A [arquitetura](../ARCHITECTURE.md), o [runbook](RUNBOOK.md) e o [plano de release](RELEASE.md) detalham como explorar esses limites sem atribuir ao laboratório garantias que ele não demonstrou.
