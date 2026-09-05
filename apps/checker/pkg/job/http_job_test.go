package job_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/openstatushq/openstatus/apps/checker/checker"
	"github.com/openstatushq/openstatus/apps/checker/pkg/job"
	v1 "github.com/openstatushq/openstatus/apps/checker/proto/private_location/v1"
	"github.com/openstatushq/openstatus/apps/checker/request"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHTTPJob_Success(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		assertions []*v1.StatusCodeAssertion
	}{
		{name: "default 2xx", status: http.StatusOK},
		{
			name:   "custom non-2xx",
			status: http.StatusNotFound,
			assertions: []*v1.StatusCodeAssertion{
				{Comparator: v1.NumberComparator_NUMBER_COMPARATOR_LESS_THAN, Target: 500},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tt.status)
			}))
			defer srv.Close()
			otlp := newOTLP(t)

			monitor := &v1.HTTPMonitor{
				Url: srv.URL, Method: http.MethodGet, Timeout: 1000, Retry: 2,
				StatusCodeAssertions: tt.assertions,
				OtelConfig:           &v1.OtelConfig{Endpoint: otlp.server.URL},
			}
			data, err := job.NewJobRunner().HTTPJob(t.Context(), monitor, "test-region")

			require.NoError(t, err)
			require.NotNil(t, data)
			assert.Equal(t, "success", data.RequestStatus)
			assert.Equal(t, uint8(0), data.Error)
			assert.Equal(t, tt.status, data.StatusCode)
			assert.Empty(t, data.Message)
			assert.Equal(t, int32(1), calls.Load(), "successful checks must not retry")
			otlp.requireMetric(t, "openstatus.status")
			assert.False(t, otlp.sawMetric("openstatus.error"))
		})
	}
}

func TestHTTPJob_TransportFailureCannotPassStatusAssertion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close()

	monitor := &v1.HTTPMonitor{
		Url: srv.URL, Method: http.MethodGet, Timeout: 1000, Retry: 2,
		StatusCodeAssertions: []*v1.StatusCodeAssertion{
			{Comparator: v1.NumberComparator_NUMBER_COMPARATOR_LESS_THAN, Target: 500},
		},
	}
	before := time.Now().UnixMilli()
	data, err := job.NewJobRunner().HTTPJob(t.Context(), monitor, "test-region")

	require.NoError(t, err)
	require.NotNil(t, data)
	assert.Equal(t, "error", data.RequestStatus)
	assert.Equal(t, uint8(1), data.Error)
	assert.Zero(t, data.StatusCode)
	assert.NotEmpty(t, data.Message)
	_, err = uuid.Parse(data.ID)
	assert.NoError(t, err)
	assert.Equal(t, srv.URL, data.URL)
	assert.GreaterOrEqual(t, data.Timestamp, before)
	assert.LessOrEqual(t, data.Timestamp, time.Now().UnixMilli())
	assert.Equal(t, data.Timestamp, data.CronTimestamp)
}

func TestProtoStringAssertionToComparator(t *testing.T) {
	tests := []struct {
		name      string
		input     v1.StringComparator
		want      request.StringComparator
		expectErr bool
	}{
		{
			name:      "Contains",
			input:     v1.StringComparator_STRING_COMPARATOR_CONTAINS,
			want:      request.StringContains,
			expectErr: false,
		},
		{
			name:      "NotContains",
			input:     v1.StringComparator_STRING_COMPARATOR_NOT_CONTAINS,
			want:      request.StringNotContains,
			expectErr: false,
		},
		{
			name:      "Equals",
			input:     v1.StringComparator_STRING_COMPARATOR_EQUAL,
			want:      request.StringEquals,
			expectErr: false,
		},
		{
			name:      "NotEquals",
			input:     v1.StringComparator_STRING_COMPARATOR_NOT_EQUAL,
			want:      request.StringNotEquals,
			expectErr: false,
		},
		{
			name:      "Empty",
			input:     v1.StringComparator_STRING_COMPARATOR_EMPTY,
			want:      request.StringEmpty,
			expectErr: false,
		},
		{
			name:      "NotEmpty",
			input:     v1.StringComparator_STRING_COMPARATOR_NOT_EMPTY,
			want:      request.StringNotEmpty,
			expectErr: false,
		},
		{
			name:      "Unknown",
			input:     v1.StringComparator(999),
			want:      "",
			expectErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := job.ProtoStringAssertionToComparator(tt.input)
			if tt.expectErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.want, got)
			}
		})
	}
}

func TestProtoNumberAssertionToComparator(t *testing.T) {
	tests := []struct {
		name      string
		input     v1.NumberComparator
		want      request.NumberComparator
		expectErr bool
	}{
		{"Equal", v1.NumberComparator_NUMBER_COMPARATOR_EQUAL, request.NumberEquals, false},
		{"NotEqual", v1.NumberComparator_NUMBER_COMPARATOR_NOT_EQUAL, request.NumberNotEquals, false},
		{"GreaterThan", v1.NumberComparator_NUMBER_COMPARATOR_GREATER_THAN, request.NumberGreaterThan, false},
		{"GreaterThanOrEqual", v1.NumberComparator_NUMBER_COMPARATOR_GREATER_THAN_OR_EQUAL, request.NumberGreaterThanEqual, false},
		{"LessThan", v1.NumberComparator_NUMBER_COMPARATOR_LESS_THAN, request.NumberLowerThan, false},
		{"LessThanOrEqual", v1.NumberComparator_NUMBER_COMPARATOR_LESS_THAN_OR_EQUAL, request.NumberLowerThanEqual, false},
		{"Unknown", v1.NumberComparator(999), "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := job.ProtoNumberAssertionToComparator(tt.input)
			if tt.expectErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.want, got)
			}
		})
	}
}

// TestHTTPJob_HeaderAssertions ensures that header assertions influence the
// request status for the private location scheduler, matching the behaviour of
// the public checker. Regression test for a bug where the result of
// HeaderEvaluate was discarded, so a failing header assertion was still
// reported as a success.
func TestHTTPJob_HeaderAssertions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Custom", "actual")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	newMonitor := func(target string) *v1.HTTPMonitor {
		return &v1.HTTPMonitor{
			Url:     srv.URL,
			Method:  "GET",
			Timeout: 10000,
			Retry:   1,
			HeaderAssertions: []*v1.HeaderAssertion{
				{
					Key:        "X-Custom",
					Comparator: v1.StringComparator_STRING_COMPARATOR_EQUAL,
					Target:     target,
				},
			},
		}
	}

	t.Run("failing header assertion marks request as error", func(t *testing.T) {
		monitor := newMonitor("expected")

		data, err := job.NewJobRunner().HTTPJob(context.Background(), monitor, "test-region")
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		assert.Equal(t, "error", data.RequestStatus)
		assert.Equal(t, uint8(1), data.Error)
	})

	t.Run("passing header assertion keeps request successful", func(t *testing.T) {
		monitor := newMonitor("actual")

		data, err := job.NewJobRunner().HTTPJob(context.Background(), monitor, "test-region")
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		assert.Equal(t, "success", data.RequestStatus)
		assert.Equal(t, uint8(0), data.Error)
	})
}

// A failed check has to carry a message: it ends up as the alert body, which
// was empty for every private location HTTP monitor.
func TestHTTPJob_FailureMessage(t *testing.T) {
	t.Run("reports the status code", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()

		monitor := &v1.HTTPMonitor{Url: srv.URL, Method: "GET", Timeout: 10000, Retry: 1}

		data, err := job.NewJobRunner().HTTPJob(context.Background(), monitor, "test-region")
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		assert.Equal(t, uint8(1), data.Error)
		assert.Contains(t, data.Message, "500")
	})

	t.Run("reports a failed assertion on a 2xx", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		monitor := &v1.HTTPMonitor{
			Url: srv.URL, Method: "GET", Timeout: 10000, Retry: 1,
			HeaderAssertions: []*v1.HeaderAssertion{
				{Key: "X-Missing", Comparator: v1.StringComparator_STRING_COMPARATOR_EQUAL, Target: "expected"},
			},
		}

		data, err := job.NewJobRunner().HTTPJob(context.Background(), monitor, "test-region")
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		assert.Equal(t, uint8(1), data.Error)
		assert.NotEmpty(t, data.Message)
	})

	t.Run("keeps a successful check message empty", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		monitor := &v1.HTTPMonitor{Url: srv.URL, Method: "GET", Timeout: 10000, Retry: 1}

		data, err := job.NewJobRunner().HTTPJob(context.Background(), monitor, "test-region")
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		assert.Equal(t, uint8(0), data.Error)
		assert.Empty(t, data.Message)
	})
}

func TestHTTPJob_BodyFailuresRemainIngestibleAfterRetries(t *testing.T) {
	tests := []struct {
		name       string
		assertions []*v1.StatusCodeAssertion
	}{
		{name: "truncated"},
		{
			name: "stalled",
			assertions: []*v1.StatusCodeAssertion{
				{Comparator: v1.NumberComparator_NUMBER_COMPARATOR_LESS_THAN, Target: 500},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Length", "100")
				w.Header().Set("X-Probe", "received")
				_, _ = io.WriteString(w, "short")
				w.(http.Flusher).Flush()
				if tt.name == "stalled" {
					<-r.Context().Done()
				}
			}))
			defer srv.Close()
			otlp := newOTLP(t)

			monitor := &v1.HTTPMonitor{
				Url: srv.URL, Method: http.MethodGet, Timeout: 250, Retry: 2,
				StatusCodeAssertions: tt.assertions,
				OtelConfig:           &v1.OtelConfig{Endpoint: otlp.server.URL},
			}
			before := time.Now().UnixMilli()
			data, err := job.NewJobRunner().HTTPJob(t.Context(), monitor, "test-region")

			require.NoError(t, err, "exhausted probe failures must reach ingestion")
			require.NotNil(t, data)
			assert.Equal(t, int32(2), calls.Load())
			assert.Equal(t, "error", data.RequestStatus)
			assert.Equal(t, uint8(1), data.Error)
			assert.Equal(t, http.StatusOK, data.StatusCode)
			assert.NotEmpty(t, data.Message)
			_, err = uuid.Parse(data.ID)
			assert.NoError(t, err)
			assert.Equal(t, srv.URL, data.URL)
			assert.GreaterOrEqual(t, data.Timestamp, before)
			assert.LessOrEqual(t, data.Timestamp, time.Now().UnixMilli())
			assert.Equal(t, data.Timestamp, data.CronTimestamp)

			var headers map[string]string
			require.NoError(t, json.Unmarshal([]byte(data.Headers), &headers))
			assert.Equal(t, "received", headers["X-Probe"])
			var timing checker.Timing
			require.NoError(t, json.Unmarshal([]byte(data.Timing), &timing))
			assert.GreaterOrEqual(t, timing.TransferStart, data.Timestamp)
			assert.GreaterOrEqual(t, timing.TransferDone, timing.TransferStart)
			otlp.requireMetric(t, "openstatus.error")
			assert.False(t, otlp.sawMetric("openstatus.status"))
		})
	}
}

func TestHTTPJob_RetriesBodyFailureUntilRecovery(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Content-Length", "100")
			_, _ = io.WriteString(w, "short")
			return
		}
		_, _ = io.WriteString(w, "complete")
	}))
	defer srv.Close()
	otlp := newOTLP(t)

	monitor := &v1.HTTPMonitor{
		Url: srv.URL, Method: http.MethodGet, Timeout: 1000, Retry: 3,
		OtelConfig: &v1.OtelConfig{Endpoint: otlp.server.URL},
	}
	data, err := job.NewJobRunner().HTTPJob(t.Context(), monitor, "test-region")

	require.NoError(t, err)
	require.NotNil(t, data)
	assert.Equal(t, int32(2), calls.Load())
	assert.Equal(t, "success", data.RequestStatus)
	assert.Equal(t, uint8(0), data.Error)
	assert.Empty(t, data.Message)
	otlp.requireMetric(t, "openstatus.status")
	assert.False(t, otlp.sawMetric("openstatus.error"), "metrics must describe the final attempt")
}

func TestHTTPJob_CancellationDoesNotBecomeOutage(t *testing.T) {
	tests := []struct {
		name  string
		retry int64
	}{
		{name: "final attempt", retry: 1},
		{name: "retries remaining", retry: 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(http.StatusOK)
				w.(http.Flusher).Flush()
				cancel()
				<-r.Context().Done()
			}))
			defer srv.Close()

			monitor := &v1.HTTPMonitor{
				Url: srv.URL, Method: http.MethodGet, Timeout: 1000, Retry: tt.retry,
			}
			data, err := job.NewJobRunner().HTTPJob(ctx, monitor, "test-region")

			require.ErrorIs(t, err, context.Canceled)
			assert.Nil(t, data)
			assert.Equal(t, int32(1), calls.Load())
		})
	}
}
