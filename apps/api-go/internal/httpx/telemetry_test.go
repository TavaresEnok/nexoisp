package httpx

import (
	"context"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"testing"
)

type capturedSpans struct{ spans []sdktrace.ReadOnlySpan }

func (s *capturedSpans) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (s *capturedSpans) OnEnd(span sdktrace.ReadOnlySpan)                { s.spans = append(s.spans, span) }
func (s *capturedSpans) Shutdown(context.Context) error                  { return nil }
func (s *capturedSpans) ForceFlush(context.Context) error                { return nil }

func TestFailedRequestRetainsChildSpansOutsideSample(t *testing.T) {
	for _, failed := range []bool{false, true} {
		sink := &capturedSpans{}
		processor := &requestSampler{next: sink, traces: map[trace.TraceID][]sdktrace.ReadOnlySpan{}}
		provider := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()), sdktrace.WithSpanProcessor(processor))
		parent := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{255, 255}, SpanID: trace.SpanID{1}, TraceFlags: trace.FlagsSampled, Remote: true})
		ctx, root := provider.Tracer("nexo.http").Start(trace.ContextWithRemoteSpanContext(context.Background(), parent), "GET")
		_, child := provider.Tracer("nexo.db").Start(ctx, "query")
		child.End()
		if len(sink.spans) != 0 {
			t.Fatal("exportação antes de conhecer o resultado HTTP")
		}
		if failed {
			root.SetStatus(codes.Error, "HTTP 5xx")
		}
		root.End()
		expected := 0
		if failed {
			expected = 2
		}
		if len(sink.spans) != expected {
			t.Fatalf("erro=%v: %d spans; esperados %d", failed, len(sink.spans), expected)
		}
		if len(processor.traces) != 0 {
			t.Fatal("buffer da requisição não liberado")
		}
		_ = provider.Shutdown(context.Background())
	}
}
