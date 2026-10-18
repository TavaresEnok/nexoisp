package httpx

import (
	"context"
	"os"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func Telemetry(ctx context.Context) (func(context.Context) error, error) {
	options := []sdktrace.TracerProviderOption{sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(.05))), sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", "nexo-go"), attribute.String("cell", "c1")))}
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != "" {
		exporter, err := otlptracehttp.New(ctx)
		if err != nil {
			return nil, err
		}
		options = append(options, sdktrace.WithSampler(sdktrace.AlwaysSample()), sdktrace.WithSpanProcessor(&requestSampler{next: sdktrace.NewBatchSpanProcessor(exporter), traces: map[trace.TraceID][]sdktrace.ReadOnlySpan{}}))
	}
	provider := sdktrace.NewTracerProvider(options...)
	otel.SetTracerProvider(provider)
	return provider.Shutdown, nil
}

// Sample after the HTTP outcome is known so every 5xx retains its child spans.
// Non-HTTP work uses the same deterministic 5% choice. Per-request buffering is bounded.
type requestSampler struct {
	mu     sync.Mutex
	next   sdktrace.SpanProcessor
	traces map[trace.TraceID][]sdktrace.ReadOnlySpan
}

func chosen(id trace.TraceID) bool { return int(id[0])*256+int(id[1]) < 3277 }
func (s *requestSampler) OnStart(ctx context.Context, span sdktrace.ReadWriteSpan) {
	if span.InstrumentationScope().Name == "nexo.http" {
		s.mu.Lock()
		if len(s.traces) < 10000 {
			s.traces[span.SpanContext().TraceID()] = nil
		}
		s.mu.Unlock()
	}
	s.next.OnStart(ctx, span)
}
func (s *requestSampler) OnEnd(span sdktrace.ReadOnlySpan) {
	id := span.SpanContext().TraceID()
	s.mu.Lock()
	pending, exists := s.traces[id]
	if exists && span.InstrumentationScope().Name != "nexo.http" {
		if len(pending) < 1000 {
			s.traces[id] = append(pending, span)
		}
		s.mu.Unlock()
		return
	}
	if exists {
		delete(s.traces, id)
	}
	s.mu.Unlock()
	if chosen(id) || span.Status().Code == codes.Error {
		for _, child := range pending {
			s.next.OnEnd(child)
		}
		s.next.OnEnd(span)
	}
}
func (s *requestSampler) Shutdown(ctx context.Context) error   { return s.next.Shutdown(ctx) }
func (s *requestSampler) ForceFlush(ctx context.Context) error { return s.next.ForceFlush(ctx) }
