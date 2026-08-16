from datetime import datetime, timezone

from mirage.utils.dates import parse_date_expr

NOW = datetime(2026, 8, 16, 13, 45, 30)


def test_relative_hours_ago():
    assert parse_date_expr("24 hours ago",
                           now=NOW) == datetime(2026, 8, 15, 13, 45, 30)


def test_relative_days_and_weeks():
    assert parse_date_expr("3 days",
                           now=NOW) == datetime(2026, 8, 19, 13, 45, 30)
    assert parse_date_expr("-2 weeks",
                           now=NOW) == datetime(2026, 8, 2, 13, 45, 30)


def test_relative_words():
    assert parse_date_expr("yesterday",
                           now=NOW) == datetime(2026, 8, 15, 13, 45, 30)
    assert parse_date_expr("tomorrow",
                           now=NOW) == datetime(2026, 8, 17, 13, 45, 30)
    assert parse_date_expr("now", now=NOW) == NOW
    assert parse_date_expr("last year",
                           now=NOW) == datetime(2025, 8, 16, 13, 45, 30)
    assert parse_date_expr("next month",
                           now=NOW) == datetime(2026, 9, 16, 13, 45, 30)


def test_month_overflow_normalizes_like_gnu():
    assert parse_date_expr("2026-01-31 1 month",
                           now=NOW) == datetime(2026, 3, 3)


def test_iso_base_with_relative_tail():
    assert parse_date_expr("2026-08-16 12:00:00 24 hours ago",
                           now=NOW) == datetime(2026, 8, 15, 12, 0, 0)


def test_epoch():
    parsed = parse_date_expr("@1755300000", utc=True)
    assert parsed == datetime(2025, 8, 15, 23, 20, tzinfo=timezone.utc)


def test_iso_datetime_with_offset_converts_under_utc():
    parsed = parse_date_expr("2026-08-16T10:00:00+02:00", utc=True)
    assert parsed is not None
    assert parsed.hour == 8
    assert parsed.tzinfo == timezone.utc


def test_invalid_returns_none():
    assert parse_date_expr("not a date", now=NOW) is None
    assert parse_date_expr("24 hours agoo", now=NOW) is None
    assert parse_date_expr("", now=NOW) is None
    assert parse_date_expr("@abc", now=NOW) is None


def test_number_attached_to_unit():
    assert parse_date_expr("2days",
                           now=NOW) == datetime(2026, 8, 18, 13, 45, 30)
