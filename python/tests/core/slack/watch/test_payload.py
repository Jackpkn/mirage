from mirage.core.slack.watch.payload import channel_id_of, day_of, message_ts

# 2025-08-15T23:30:00Z is 4:30pm PDT the same day, so client and mount
# agree; 2025-08-16T05:00:00Z is 10pm PDT on the 15th, where they do not.
TS = "1755300600.000100"
LATE = "1755320400.000100"


def test_day_of_buckets_in_utc():
    assert day_of(TS) == "2025-08-15"
    assert day_of(LATE) == "2025-08-16"


def test_day_of_rejects_a_non_numeric_ts():
    assert day_of("not-a-ts") is None


def test_day_of_rejects_an_empty_ts():
    # TS mirrors this explicitly, because Number("") is 0 there and
    # would bucket an empty ts into 1970 instead of skipping it.
    assert day_of("") is None
    assert day_of("  ") is None


def test_message_ts_prefers_the_deleted_message():
    assert message_ts({
        "subtype": "message_deleted",
        "ts": LATE,
        "deleted_ts": TS,
    }) == TS


def test_message_ts_falls_back_to_the_previous_message():
    assert message_ts({
        "subtype": "message_deleted",
        "ts": LATE,
        "previous_message": {
            "ts": TS
        },
    }) == TS


def test_message_ts_prefers_the_edited_message():
    assert message_ts({
        "subtype": "message_changed",
        "ts": LATE,
        "message": {
            "ts": TS
        },
    }) == TS


def test_message_ts_is_the_events_own_ts_by_default():
    assert message_ts({"ts": TS}) == TS


def test_channel_id_of_reads_a_bare_id():
    assert channel_id_of({"channel": "C0288"}) == "C0288"


def test_channel_id_of_reads_a_channel_object():
    assert channel_id_of({"channel": {"id": "C0288"}}) == "C0288"


def test_channel_id_of_reads_neither():
    assert channel_id_of({"user": {"id": "U1"}}) is None
