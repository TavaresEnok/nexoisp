// Package cloudjournal defines the offline notice-journal vocabulary.
// Send, consent, webhook acceptance and the wire machine stay in later files.
package cloudjournal

import "context"

// Decision is the journal outcome for one notice line.
type Decision string

const (
	DecisionSend        Decision = "send"
	DecisionOptOut      Decision = "opt_out"
	DecisionSettled     Decision = "settled"
	DecisionLockTimeout Decision = "lock_timeout"
	DecisionIneligible  Decision = "ineligible"
)

// LogKind classifies a notice_log row before any lock or send.
type LogKind string

const (
	LogKindBilling     LogKind = "billing"
	LogKindMaintenance LogKind = "maintenance"
	LogKindOther       LogKind = "other"
)

// MaxLockRequeues is the ceiling stored in notice_log.cloud_lock_timeouts.
// Timeouts 1 and 2 requeue with no HTTP. The third timeout is terminal
// failed, still with no HTTP. This counter is not notice_log.attempts.
const MaxLockRequeues = 3

// Classify returns billing when invoiceID is non-empty, maintenance when
// only maintenanceNoticeID is non-empty, and other when both are empty.
func Classify(invoiceID, maintenanceNoticeID string) LogKind {
	if invoiceID != "" {
		return LogKindBilling
	}
	if maintenanceNoticeID != "" {
		return LogKindMaintenance
	}
	return LogKindOther
}

// Sender is the test double boundary. started means the fake entered the
// zone equivalent to an outbound Do. This package does not call Meta.
type Sender interface {
	Send(ctx context.Context, attemptKey string) (started bool, err error)
}

// Authenticator verifies a webhook body. Production stays unproved until an
// operator records a primary source. Proven false refuses with zero writes.
type Authenticator interface {
	Proven() bool
	Verify(headers map[string]string, body []byte) error
}

// StatusEffect is the observation result. MoneyWrites and Sends stay zero
// for every status observation this journal records.
type StatusEffect struct {
	Applied     bool
	Duplicate   bool
	MoneyWrites int
	Sends       int
}
