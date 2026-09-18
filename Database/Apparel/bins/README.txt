CPI Price Web V5

Changes:
- G/L/U/N moved to the leftmost columns.
- Checked and Confirmed removed from the web UI and calculation flow.
- Current price is before Link and comparison price.
- Added Link: N / 1 / 2 / 3.
  N = comparison price follows previous-month price.
  1/2 = comparison price follows current price.
  3 = comparison price is manually editable.
- Added button to copy previous-month price to comparison price for currently filtered rows (sets Link=N).
- Previous month's current price automatically becomes next month's previous price.
- prepare_month also refreshes already-created month rows from the previous month.
- REL < 100 has red background; REL >= 100 has white background.
- GeoMean remains 5 decimal places.

Existing Supabase: run supabase_upgrade_v5.sql ONCE.
Fresh/testing database only: supabase_reset_v5.sql is destructive.
