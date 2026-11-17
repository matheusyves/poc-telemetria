# POC: telemetria de esteira no GitHub Actions

Esta POC torna uma execução do GitHub Actions observável sem exigir que exista uma plataforma de observabilidade já contratada. Cada execução produz os quatro sinais abaixo como artefato do próprio workflow:

- **traços**: `traces.otlp.json`, no formato OTLP/HTTP JSON, com um traço por execução e um span por fase;
- **métricas**: `metrics.prom`, em formato Prometheus;
- **logs**: `events.jsonl`, eventos estruturados e correlacionados por `trace_id`;
- **evidência legível**: `evidence.md`, incluída também no Job Summary do GitHub.

O arquivo [telemetry-poc.yml](.github/workflows/telemetry-poc.yml) pode ser disparado manualmente em **Actions → Telemetry POC → Run workflow**. Ao terminar, baixe o artefato `telemetry-evidence-<run_id>`: ele contém todos os sinais e o relatório.

## Execução local (evidência reproduzível)

```bash
./scripts/run-poc.sh
```

O comando valida o gerador de telemetria, executa os testes e grava a evidência em `artifacts/telemetry-local-<UTC>/`. Para exercitar o caminho de falha, que ainda publica a evidência no Actions, use:

```bash
SIMULATE_FAILURE=true ./scripts/run-poc.sh
```

Nesse caso o comando termina com código diferente de zero de propósito, após materializar os arquivos de telemetria.

## Exportação OTLP opcional

Por padrão a POC não envia dados para fora do GitHub; o artefato é a evidência. Para integrar com Grafana Tempo, Jaeger, Datadog ou outro coletor OTLP/HTTP, configure no repositório os secrets:

| Secret | Uso |
| --- | --- |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Endpoint completo de traces, por exemplo `https://collector.exemplo/v1/traces` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Opcional. Cabeçalhos `chave=valor,chave2=valor2` (por exemplo token de API) |

Depois dispare o workflow com **Export OTLP = true**. A exportação é best-effort por padrão para não esconder a evidência caso o destino esteja indisponível. Para torná-la obrigatória, defina a variável de repositório `TELEMETRY_EXPORT_REQUIRED=true`.

## Stack local opcional

Para testar o contrato OTLP sem credenciais externas:

```bash
docker compose -f docker-compose.observability.yml up -d
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces ./scripts/run-poc.sh
```

O Collector escreve no seu log o que recebeu. Pare com `docker compose -f docker-compose.observability.yml down`.

## O que observar na evidência

- o mesmo `trace_id` aparece nos logs e em todos os spans;
- os nomes de fases são `validate`, `tests` e, quando solicitado, `synthetic_failure`;
- `ci_workflow_duration_seconds` cobre toda a esteira;
- os atributos preservam identificadores do GitHub (`repository`, `run_id`, `sha`, `ref`) sem expor secrets.

O workflow usa apenas Python da imagem do runner e ações oficiais do GitHub, portanto não requer instalação de bibliotecas para ser executado.
