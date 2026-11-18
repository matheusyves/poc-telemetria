# workflow-telemetry

Biblioteca reutilizável para observar workflows do GitHub Actions com OpenTelemetry. Ela não instrumenta aplicações: após o término de uma execução, consulta a API do GitHub, reconstrói a árvore `workflow → job → step` e exporta traces, métricas e logs via OTLP/HTTP.

## O que é exportado

Para cada `workflow_run`, a action cria um trace determinístico com:

```text
RUN Delivery pipeline
├─ TASK quality
│  ├─ STEP Checkout
│  └─ STEP Run quality gate
├─ TASK build-android
├─ TASK security
└─ TASK deploy-staging
```

Os spans usam as convenções CI/CD do OpenTelemetry (`cicd.pipeline.*`), são ligados à URL do run/job no GitHub e preservam resultados `success`, `failure`, `cancellation`, `timeout` e `error`. São enviados três sinais OTLP: traces, métricas de duração e logs de conclusão. O Collector também deriva contadores e histogramas diretamente dos spans para que o dashboard mantenha totais de runs, sem contar repetidamente os scrapes de um gauge.

## Consumo em outro repositório

Crie `.github/workflows/workflow-telemetry.yml` no repositório consumidor:

```yaml
name: Export workflow telemetry

on:
  workflow_run:
    workflows: [Build Android, Quality, Security, Deploy]
    types: [completed]

jobs:
  export:
    if: >-
      ${{ contains(fromJSON('["success","failure","cancelled","timed_out","startup_failure","action_required"]'), github.event.workflow_run.conclusion) }}
    uses: matheusyves/poc-telemetria/.github/workflows/collect-run.yml@main
    with:
      repository: ${{ github.repository }}
      run-id: ${{ github.event.workflow_run.id }}
      conclusion: ${{ github.event.workflow_run.conclusion }}
    secrets: inherit
```

Configure no repositório consumidor:

| Secret | Valor |
| --- | --- |
| `OTLP_ENDPOINT` | Endpoint base OTLP/HTTP. Ex.: `https://collector.example/otlp` |
| `OTLP_HEADERS` | Opcional. Cabeçalhos no formato `Authorization=Bearer token` |

`workflow_run` é acionado ao término independentemente do resultado; o `if` explicita quais resultados terminais interessam à plataforma. O coletor recebe o run mesmo quando foi cancelado, excedeu tempo ou sofreu erro de infraestrutura.

> A action usa `github.token` apenas com `actions: read` e não serializa comandos, variáveis de ambiente ou secrets nos sinais. Como um workflow com `workflow_run` pode ter acesso a secrets, use-o somente para workflows confiáveis e não execute código do run observado.

## Stack de observabilidade local

```bash
docker compose -f docker-compose.observability.yml up -d
node scripts/demo-local.js
```

Abra [Grafana](http://localhost:3000) com `admin` / `admin`. O dashboard **Workflow Telemetry** contém métricas no Prometheus e logs no Loki; traces estão disponíveis no datasource Tempo. O script publica três execuções demonstrativas:

1. sucesso completo;
2. falha de qualidade;
3. falha de deploy.

Pare a stack com:

```bash
docker compose -f docker-compose.observability.yml down
```

Para receber dados de runners hospedados no GitHub, exponha o Collector por um endpoint HTTPS acessível pelos runners ou use um backend OTLP gerenciado. `localhost` serve exclusivamente à demonstração local.

## Desenvolvimento e release

```bash
node --test test/collector.test.js
```

A action não tem dependências de runtime e usa Node 24. Antes de adotar em outros repositórios, publique uma tag imutável, por exemplo `v1`, e substitua `@main` por `@v1` nas referências de consumo.
