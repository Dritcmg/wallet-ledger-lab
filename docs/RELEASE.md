# Artefatos, validação e recuperação

Este documento define um fluxo de release para o laboratório. Não descreve um staging já implantado, uma operação comercial ou uma promoção para produção realizada.

## Identidade do artefato

Cada entrega deve associar revisão do código, lockfile, configuração de build, imagem e resultados da verificação. A aplicação compilada usa Bun com dependências externas ao bundle e é executada como `dist/main.js` na imagem de runtime.

Tags locais ajudam a operar; não são identificadores imutáveis. Para registrar a imagem construída:

```sh
docker image inspect wallet-ledger-lab:local --format '{{.Id}}'
```

O ID local não deve ser apresentado como um digest de registry publicado. Se futuramente houver registry, registre o digest retornado e promova a referência `repositorio@sha256:...` do mesmo artefato entre ambientes. Não reconstrua silenciosamente uma imagem para cada etapa chamando-a de promoção.

## Gates locais

| Gate | Evidência esperada |
| --- | --- |
| Setup | Configuração privada gerada; exemplo público sem segredos |
| Build | Bundle, dependências resolvidas pelo lockfile e imagem identificada |
| Contratos | Checagem de tipos e testes unitários |
| Integração | PostgreSQL e SQS reais, com banco e broker próprios para teste |
| Concorrência e falhas | Processos separados, duplicatas, referências, leases e encerramento real |
| Integridade | Saldo reconstruído pelo ledger e guards SQL exercitados |
| Observabilidade | Métricas, coleta local e validação de telemetria registradas |
| Publicação | Allowlist, scanner de privacidade/segredos, manifesto e checksums |

O comando de entrada da verificação é:

```sh
docker compose --profile test run --build --rm tester
```

O script [verify.ts](../scripts/verify.ts) registra o que executou. Consulte [REPORT.md](../evidence/latest/REPORT.md) e os resultados estruturados; uma etapa falha ou ausente impede tratá-la como aprovada. O pacote público não deve incluir logs brutos ou configuração privada para demonstrar um resultado.

Não há meta de RPS, p95 ou p99 demonstrada por esse gate. Um futuro benchmark precisa registrar ambiente, carga, metodologia, duração, erros, latência e limites observados, sem converter resultados locais em promessa de capacidade de produção.

## Empacotamento público

Com Bun 1.4.4:

```sh
bun run portfolio:package
```

O empacotador seleciona arquivos autorizados e produz o ZIP, o manifesto e o SHA-256 em `artifacts/public/`. Revise a relação de arquivos e a correspondência com o relatório de verificação antes de compartilhar. Gerar o pacote não publica automaticamente um repositório, uma imagem ou um site.

Preserve `LICENSE` e `NOTICE.md`. A licença da implementação não se estende ao material público que inspirou o problema ou às dependências.

## Recuperação de uma atualização local

Antes de alterar o schema ou substituir uma versão com dados que devam ser preservados:

1. Registre a revisão e a identidade da imagem conhecida.
2. Preserve um dump e a configuração necessária em armazenamento privado, fora do pacote público.
3. Verifique compatibilidade do código anterior com o schema seguinte.
4. Exercite a restauração em um banco isolado antes de depender dela.

Se a atualização falhar, interrompa novas escritas e identifique se a causa está no binário, na configuração, no schema ou em um serviço local. Quando o schema continuar compatível, voltar ao binário anterior pode ser mais seguro que reverter dados. Não execute uma migration `down` sobre uma base de interesse apenas porque existe um método reverso.

Migrations iniciais podem remover tabelas; migrations de guards alteram proteções. Reverter o schema pode enfraquecer invariantes mesmo sem apagar linhas. Estados de fila, entregas já aceitas e efeitos de consumidores externos também não são revertidos por um rollback SQL.

As suítes exercitam migrations em schemas isolados e recuperação de processos. Isso não é um ensaio completo de backup, restauração ou desastre. Esse ensaio permanece uma etapa necessária para qualquer uso além da demonstração.

## Evolução para outro ambiente

Uma futura implantação externa exigiria, antes de promoção:

- identidade e autorização por provedor e recurso;
- credenciais, redes e dados separados por ambiente;
- TLS, privilégios mínimos e política de retenção;
- serviços persistentes e um plano de DLQ e deduplicação de consumidores;
- observabilidade, objetivos e janelas de avaliação definidos;
- staging representativo, rollout gradual e recuperação exercitada.

Esses itens são um plano de evolução. O repositório não afirma que já os provisionou nem que os gates locais os substituem.
