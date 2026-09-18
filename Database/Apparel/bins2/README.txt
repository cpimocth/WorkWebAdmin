CPI Price Web V6

Recommended upgrade (keeps data):
1. Run supabase_upgrade_v6.sql once in Supabase SQL Editor.
2. Replace the old index.html with this V6 index.html.
3. Refresh the browser and log in.

V6 changes:
- Removed # column.
- Every table column can be resized and hidden/shown.
- Added Recorder Status and Reviewer Status.
- Previous month's Reviewer Status automatically becomes next month's Recorder Status.
- Current price always carries to next month's Previous Price.
- N is mutually exclusive with G/L/U.
- Missing current prices are excluded from report counts/GeoMean.
- Shop and Province are separate columns.
- Added Edited By (logged-in user email) and Last Edited timestamp.

Use supabase_reset_v6.sql only if you intentionally want to delete all existing master/monthly data and start fresh.
