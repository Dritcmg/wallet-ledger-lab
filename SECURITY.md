# Segurança e publicação

## Escopo do laboratório

Wallet Ledger Lab trabalha exclusivamente com dados sintéticos em ambiente local. A API usa um adaptador de identidade permissivo; não há autenticação ou autorização adequadas para exposição pública. PostgreSQL, SQS, API e ferramentas de observabilidade devem permanecer no loopback e nas redes locais do Compose.

As garantias financeiras descritas na [arquitetura](ARCHITECTURE.md) protegem o comportamento transacional deste estudo. Elas não substituem controles de acesso, proteção de dados, operação de uma plataforma financeira ou avaliação de conformidade.

## Configuração privada

`scripts/setup-local.ts` prepara `.env` com credenciais aleatórias para o ambiente local. O arquivo deve permanecer privado. Não reutilize esses valores em serviços externos nem os inclua em screenshots, exemplos ou relatórios públicos.

O pacote público inclui `.env.example`, que descreve a configuração sem credenciais utilizáveis. Senhas administrativas do Grafana, credenciais do banco, dumps e estado dos volumes não pertencem à demonstração publicável.

Os endpoints de saúde são públicos dentro do laboratório. `/metrics`, Grafana e Prometheus podem revelar informações operacionais e também não devem ser expostos externamente. A instrumentação usa labels limitadas, sem IDs individuais ou payloads financeiros como dimensões de métricas.

Logs usam uma allowlist de nomes de campo e preservam IDs operacionais, como correlação, wallet e provedor. Esse filtro não é um redator geral: um valor sensível inserido em um campo permitido pode aparecer no log. Use apenas dados sintéticos e não coloque credenciais ou informações pessoais nos identificadores. Logs brutos permanecem privados; somente evidências sanitizadas podem integrar o pacote público.

## O que pode ser publicado

O empacotador em [scripts/package-portfolio.ts](scripts/package-portfolio.ts) deve selecionar arquivos por allowlist, em vez de comprimir toda a pasta. O conjunto publicável contém fonte, testes, documentação original, configuração de exemplo e evidência sanitizada da verificação.

Ficam fora desse conjunto:

- `.env` e outros arquivos com credenciais;
- histórico e metadados de `.git`;
- `node_modules`, caches, executáveis locais e volumes de containers;
- dumps, recibos de mensagens, corpos completos de requisições e logs brutos;
- diretórios privados de `artifacts`, arquivos pessoais e registros de trabalho;
- o próprio ZIP de saída, evitando empacotamento recursivo.

Antes de compartilhar, confira o manifesto do ZIP, os checksums e o relatório do scanner. O caminho `artifacts/public/` identifica a saída planejada; não torna um arquivo seguro automaticamente.

## Verificações complementares

A verificação pública combina scanner de conteúdo e escopo, seleção por allowlist e detecção de segredos com gitleaks. Os comandos e resultados efetivamente executados devem constar no [relatório de evidências](evidence/latest/REPORT.md) e nos scripts de verificação; não trate uma etapa ausente, ignorada ou com erro como aprovada.

Gitleaks procura padrões de segredos; ele não substitui revisão de privacidade, proveniência ou conteúdo. O scanner do portfólio complementa essa verificação ao procurar caminhos locais, identificadores pessoais, material privado e arquivos fora do conjunto permitido. Allowlist também não é prova de que o conteúdo de um arquivo está adequado.

O ambiente de scanner e os testes devem usar dados sintéticos e serviços locais. Não conecte essas rotinas a contas, repositórios privados ou serviços empresariais para ampliar a demonstração.

## Relatar um problema

Se o repositório estiver publicado em uma hospedagem com relato privado de vulnerabilidades, use esse mecanismo. Não publique tokens, credenciais, dados pessoais ou uma exploração que exponha terceiros em uma issue aberta. Sem canal privado disponível, solicite primeiro um meio reservado, descrevendo apenas a categoria do problema e os componentes afetados.

Um relato útil inclui revisão do código, ambiente, comportamento esperado, reprodução mínima com dados sintéticos e impacto observado. Não há SLA ou compromisso de suporte operacional de produção para este laboratório.

Se um segredo for publicado, revogue-o na origem, preserve apenas a evidência necessária à análise e revise os artefatos e o histórico afetados. Apagar um arquivo da revisão atual não invalida cópias já distribuídas.
