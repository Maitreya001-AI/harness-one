# @harness-one/opentelemetry

OpenTelemetry trace exporter for harness-one. Bridges harness-one spans into the OTel API — any configured OTel SDK collector (Jaeger, Tempo, Honeycomb, Datadog, ...) receives them.

## Install

```bash
pnpm add @harness-one/opentelemetry @opentelemetry/api
# You also need an OTel SDK, e.g.:
pnpm add @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http
```

## Peer Dependencies

- `@opentelemetry/api` >= 1.0.0
- `harness-one` (workspace)

An OTel SDK must be configured separately (e.g. `NodeTracerProvider` with your exporter of choice). This package does not start one for you.

## Quick Start

```ts
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createOTelExporter } from '@harness-one/opentelemetry';
import { createTraceManager } from 'harness-one/observe';

// 1. Configure the OTel SDK (this is OTel-boilerplate, not harness-one)
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter()));
provider.register();

// 2. Wire harness-one spans into OTel
const exporter = createOTelExporter({ serviceName: 'my-agent' });
const traces = createTraceManager({ exporters: [exporter] });

const traceId = traces.startTrace('agent-run');
const spanId = traces.startSpan(traceId, 'llm-call');
traces.setSpanAttributes(spanId, { model: 'gpt-4o', inputTokens: 120 });
traces.endSpan(spanId);
traces.endTrace(traceId);

await traces.flush();
```

Legacy CacheMonitor attribute names (`hitRate`, `missRate`, `avgLatency`) are auto-renamed to OTel semconv (`cache.hit_ratio`, `cache.miss_ratio`, `cache.latency_ms`) during export. See [`docs/architecture/06-observe.md`](../../docs/architecture/06-observe.md) for the attribute naming convention.

`createOTelExporter()` also exposes `getDroppedAttributeMetrics()` for monitoring non-primitive attributes that were dropped during export.

See the main [repository README](../../README.md).
